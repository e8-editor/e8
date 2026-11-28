//! Shell source blocks, ob-shell.ts: what the Emacs oracle cannot drive,
//! sessions, failing programs, the agent's permission and the Library of
//! Babel, each expected result what Emacs 30's Org gives on the same text.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_variable("org-confirm-babel-evaluate", Value::Bool(false));
    // The shells sessions start check no mail, whose "You have new mail"
    // notice would join their output on a machine that has some.
    scripting
        .eval_expression(&mut ed, r#"e8.setVariable("process-environment", ["MAILCHECK=-1", ...(e8.variable("process-environment") as string[])])"#)
        .unwrap();
    ed.window_buffer_mut().set_point(0);
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn buffer_text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

/// Runs C-c C-c on each block from the first, as a person would one after the other.
fn run_each(ed: &mut Editor) {
    let mut from = 0;
    while let Some(at) = text(ed)[from..].find("#+begin_src").map(|i| i + from) {
        let chars = text(ed)[..at].chars().count();
        ed.window_buffer_mut().set_point(chars);
        ed.press("C-c C-c").unwrap();
        from = at + 1;
    }
}

#[test]
fn blocks_in_a_session_share_its_shell() {
    let (mut ed, _s) = org(
        "#+begin_src sh :session s1 :results output\nx=5\necho $x\n#+end_src\n\n\
         #+begin_src sh :session s1 :results output\necho \"x is $x\"\nprintf 'a\\nb\\n'\n#+end_src\n\n\
         #+begin_src sh :session s1\necho one; echo two\n#+end_src\n\n\
         #+begin_src sh :session s1 :var y=7 :results output\necho \"y is $y\"\n#+end_src\n\n\
         #+begin_src sh :session s1 :results value\nfalse\n#+end_src\n",
    );
    run_each(&mut ed);
    assert_eq!(
        text(&ed),
        "#+begin_src sh :session s1 :results output\nx=5\necho $x\n#+end_src\n\n#+RESULTS:\n: 5\n\n\
         #+begin_src sh :session s1 :results output\necho \"x is $x\"\nprintf 'a\\nb\\n'\n#+end_src\n\n#+RESULTS:\n: x is 5\n: a\n: b\n\n\
         #+begin_src sh :session s1\necho one; echo two\n#+end_src\n\n#+RESULTS:\n| one |\n| two |\n\n\
         #+begin_src sh :session s1 :var y=7 :results output\necho \"y is $y\"\n#+end_src\n\n#+RESULTS:\n: y is 7\n\n\
         #+begin_src sh :session s1 :results value\nfalse\n#+end_src\n\n#+RESULTS:\n: 1\n",
    );
    // The session's buffer is a shell's, still running.
    let live = ed.find_buffer("s1").is_some();
    assert!(live, "the session's buffer is there");
}

#[test]
fn a_failing_block_shows_its_error_output_and_keeps_what_it_printed() {
    let (mut ed, _s) = org("#+begin_src sh :results output\necho out; echo err >&2; exit 2\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "#+begin_src sh :results output\necho out; echo err >&2; exit 2\n#+end_src\n\n#+RESULTS:\n: out\n");
    assert_eq!(buffer_text(&ed, "*Org-Babel Error Output*"), "err\n[ Babel evaluation exited with code 2 ]");
    assert!(ed.messages().iter().any(|m| m == "Babel evaluation exited with code 2"));
    // The next block run empties it first.
    ed.window_buffer_mut().set_text("#+begin_src sh :results output\nprintf 'a\\n'\n#+end_src\n");
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(buffer_text(&ed, "*Org-Babel Error Output*"), "");
}

#[test]
fn an_agent_needs_approval_to_run_a_shell_block() {
    let (mut ed, _s) = org("#+begin_src sh :results output\necho hi\n#+end_src\n");
    ed.set_agent_acting(true);
    let _ = ed.press("C-c C-c");
    assert!(ed.permission_requested());
    assert_eq!(text(&ed), "#+begin_src sh :results output\necho hi\n#+end_src\n");
}

#[test]
fn an_agent_needs_approval_to_type_code_into_a_running_session() {
    let (mut ed, _s) = org(
        "#+begin_src sh :session zzp :results output\necho first\n#+end_src\n\n#+begin_src sh :session zzp :results output\necho second\n#+end_src\n",
    );
    ed.press("C-c C-c").unwrap();
    assert!(text(&ed).contains("#+RESULTS:\n: first\n"));
    let shell = buffer_text(&ed, "zzp");
    // The shell runs already; the second block would only type into it.
    ed.set_agent_acting(true);
    let at = text(&ed).rfind("#+begin_src").unwrap();
    let chars = text(&ed)[..at].chars().count();
    ed.window_buffer_mut().set_point(chars);
    let _ = ed.press("C-c C-c");
    assert!(ed.permission_requested());
    assert!(!text(&ed).contains("second\n#+end_src\n\n#+RESULTS:"));
    assert_eq!(buffer_text(&ed, "zzp"), shell, "nothing was typed into the shell");
}

#[test]
fn session_code_stays_out_of_the_shell_s_history() {
    let (mut ed, _s) = org("#+begin_src sh :session zzh :results output\necho remembered\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert!(text(&ed).contains(": remembered\n"));
    let before = buffer_text(&ed, "zzh");
    ed.call("switch-to-buffer", vec![Arg::Str("zzh".into())]).unwrap();
    ed.press("M->").unwrap();
    let _ = ed.press("M-p");
    assert_eq!(buffer_text(&ed, "zzh"), before, "M-p finds no input of Babel's");
}

#[test]
fn a_session_waits_for_code_that_runs_longer_than_a_script_may() {
    // Org waits as long as the code runs; a script's own time limit is a minute.
    let (mut ed, _s) = org("#+begin_src sh :session zzs :results output\nsleep 70; echo woke\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "#+begin_src sh :session zzs :results output\nsleep 70; echo woke\n#+end_src\n\n#+RESULTS:\n: woke\n");
}

#[test]
fn lisp_in_header_arguments_is_refused_before_anything_runs() {
    // Org evaluates these as Lisp; E8 has none (ADR 0116), so the block does not run.
    let dir = tempfile::tempdir().unwrap();
    let made = dir.path().join("made");
    let text0 = format!(
        "#+begin_src sh :dir (concat \"{}\" \"/made\") :mkdirp yes :results output\npwd\n#+end_src\n",
        dir.path().display()
    );
    let (mut ed, _s) = org(&text0);
    let _ = ed.press("C-c C-c");
    assert!(ed.echo().is_some_and(|e| e.ends_with("is Lisp, which E8 does not evaluate")), "{:?}", ed.echo());
    assert_eq!(text(&ed), text0);
    assert!(!made.exists());
    let text1 = "#+begin_src sh :results (concat \"val\" \"ue\")\necho hi\n#+end_src\n";
    ed.window_buffer_mut().set_text(text1);
    ed.window_buffer_mut().set_point(0);
    let _ = ed.press("C-c C-c");
    assert_eq!(ed.echo(), Some("(concat \"val\" \"ue\") is Lisp, which E8 does not evaluate"));
    assert_eq!(text(&ed), text1);
}

#[test]
fn a_reference_that_comes_back_to_itself_is_an_error() {
    let text0 = "#+name: a\n#+begin_src sh :var x=b\necho $x\n#+end_src\n\n#+name: b\n#+begin_src sh :var y=a\necho $y\n#+end_src\n";
    let (mut ed, _s) = org(text0);
    let _ = ed.press("C-c C-c");
    assert!(ed.echo().is_some_and(|e| e.contains("max-lisp-eval-depth")), "{:?}", ed.echo());
    assert_eq!(text(&ed), text0);
}

#[test]
fn ingested_blocks_run_from_calls_in_any_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let lib = dir.path().join("lib.org");
    std::fs::write(&lib, "#+name: libsq\n#+begin_src sh :var x=2\necho $((x * x))\n#+end_src\n").unwrap();
    let (mut ed, _s) = org("#+CALL: libsq(x=5)\n\nInline call_libsq(x=6).\n");
    ed.call("org-babel-lob-ingest", vec![Arg::Str(lib.display().to_string())]).unwrap();
    assert_eq!(ed.echo(), Some("1 source block added to Library of Babel"));
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-v e").unwrap();
    let at = text(&ed).find("call_").unwrap();
    let chars = text(&ed)[..at].chars().count();
    ed.window_buffer_mut().set_point(chars);
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "#+CALL: libsq(x=5)\n\n#+RESULTS:\n: 25\n\nInline call_libsq(x=6) {{{results(=36=)}}}.\n");
}
