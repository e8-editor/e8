//! Comint and M-x shell: a shell on a terminal in a buffer, its output
//! marked as the output field, input sent with RET and kept for M-p, the
//! subjob signals, and the directory followed.

use std::time::{Duration, Instant};

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

const SETUP: &str = r#"e8.setDefault("explicit-shell-file-name", "/bin/sh"); e8.setDefault("explicit-sh-args", ["-i"]);
               e8.setDefault("shell-history-file-name", true);"#;

/// As `setup`, on the editor's own thread, for prompts that wait partway
/// through (ADR 0053), as a password prompt a process's output opens.
fn driven() -> Driven {
    Driven::new(SETUP)
}

fn driven_shell(d: &Driven) {
    unsafe { std::env::set_var("PS1", "$ ") };
    unsafe { std::env::set_var("ENV", "/dev/null") };
    d.start(|ed| ed.call("shell", vec![Arg::Prefix(None)]).unwrap());
    assert_eq!(d.buffer_name(), "*shell*");
    d.until(|t| t.ends_with("$ "));
}

fn driven_line(d: &Driven, line: &str) {
    d.type_text(line);
    d.press("RET");
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // A plain shell with a known prompt, whatever the user's own is.
    scripting
        .eval_typescript(
            &mut ed,
            "setup.ts",
            // No history file: the user's own would change what M-p finds.
            SETUP.into(),
        )
        .unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// Takes output in until the buffer's text satisfies `done`.
fn until(ed: &mut Editor, done: impl Fn(&str) -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        ed.accept_process_output(Duration::from_millis(20));
        if done(&text(ed)) {
            return;
        }
    }
    panic!("never: {:?}", text(ed));
}

fn type_line(ed: &mut Editor, line: &str) {
    ed.type_text(line);
    ed.press("RET").unwrap();
}

fn start_shell(ed: &mut Editor) {
    // PS1 from the environment, so the prompt is the same everywhere.
    unsafe { std::env::set_var("PS1", "$ ") };
    unsafe { std::env::set_var("ENV", "/dev/null") };
    ed.call("shell", vec![Arg::Prefix(None)]).unwrap();
    assert_eq!(ed.window_buffer().name, "*shell*");
    until(ed, |t| t.ends_with("$ "));
}

#[test]
fn a_shell_runs_commands_and_marks_its_output() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    assert_eq!(s.eval_expression(&mut ed, "e8.variable('major-mode')").unwrap(), r#""shell-mode""#);
    type_line(&mut ed, "echo hello");
    until(&mut ed, |t| t.ends_with("hello\n$ "));
    let t = text(&ed);
    assert!(t.ends_with("$ echo hello\nhello\n$ "), "the shell does not echo on its terminal: {t:?}");
    // Output is the output field; what was typed is not.
    let pos = t.rfind("hello\n").unwrap();
    let got = s
        .eval_expression(
            &mut ed,
            &format!("JSON.stringify([e8.charProperty({pos}, 'field')?.description, e8.charProperty({}, 'field')?.description ?? null])", pos - 7),
        )
        .unwrap();
    assert_eq!(got, r#""[\"output\",null]""#);
    // C-a stops after the prompt, as the field there says.
    ed.type_text("echo again");
    ed.press("C-a").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(b.point()..b.len()), "echo again");
}

#[test]
fn input_history_and_old_input() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, "echo one");
    until(&mut ed, |t| t.ends_with("one\n$ "));
    type_line(&mut ed, "echo two");
    until(&mut ed, |t| t.ends_with("two\n$ "));
    ed.press("M-p").unwrap();
    assert!(text(&ed).ends_with("$ echo two"));
    ed.press("M-p").unwrap();
    assert!(text(&ed).ends_with("$ echo one"));
    ed.press("M-n").unwrap();
    assert!(text(&ed).ends_with("$ echo two"));
    ed.press("C-c C-u").unwrap();
    assert!(text(&ed).ends_with("$ "));
    // RET on an old command sends it again.
    let at = text(&ed).find("echo one").unwrap();
    ed.window_buffer_mut().set_point(at + 2);
    ed.press("RET").unwrap();
    until(&mut ed, |t| t.ends_with("$ echo one\none\n$ "));
}

#[test]
fn interrupting_the_job_and_end_of_file() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, "sleep 30 && echo slept");
    ed.accept_process_output(Duration::from_millis(300));
    ed.press("C-c C-c").unwrap();
    until(&mut ed, |t| t.ends_with("$ "));
    assert!(!text(&ed).contains("\nslept\n"), "{:?}", text(&ed));
    // C-c C-d ends the shell's input, so it exits.
    ed.press("C-c C-d").unwrap();
    until(&mut ed, |t| t.contains("\nProcess shell exited abnormally with code 130\n"));
}

#[test]
fn the_directory_follows_cd() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap();
    start_shell(&mut ed);
    type_line(&mut ed, &format!("cd {}", real.display()));
    until(&mut ed, |t| t.matches("$ ").count() >= 2);
    let got = s.eval_expression(&mut ed, "e8.variable('default-directory')").unwrap();
    assert_eq!(got, format!("{:?}", format!("{}/", real.display())));
    type_line(&mut ed, "pwd");
    until(&mut ed, |t| t.ends_with(&format!("{}\n$ ", real.display())));
}

#[test]
fn carriage_returns_and_backspaces_as_a_terminal_shows_them() {
    let (mut ed, _s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, r"printf 'abc\rX\nab\bZ\n'");
    until(&mut ed, |t| t.ends_with("aZ\n$ "));
    assert!(text(&ed).contains("\nX\naZ\n$ "), "{:?}", text(&ed));
}

#[test]
fn ansi_colours_become_faces() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    type_line(&mut ed, r"printf '\033[1;31mred\033[0m plain \033[38;5;46mx\033[K\n'");
    until(&mut ed, |t| t.ends_with("red plain x\n$ "));
    let t = text(&ed);
    let red = t.rfind("red plain").unwrap();
    let x = t.rfind("x\n$ ").unwrap();
    let got = s
        .eval_expression(&mut ed, &format!("JSON.stringify([e8.getTextProperty({red}, 'face'), e8.getTextProperty({}, 'face') ?? null, e8.getTextProperty({x}, 'face')])", red + 4))
        .unwrap();
    assert_eq!(got, r#""[[\"ansi-color-bold\",\"ansi-color-red\"],null,\"ansi-color-rgb-00ff00\"]""#);
    // A sequence cut between two pieces of output is finished with the second.
    type_line(&mut ed, r"printf '\033[3'; sleep 0.3; printf '2mgreen\033[0m\n'");
    until(&mut ed, |t| t.ends_with("green\n$ "));
    let t = text(&ed);
    let g = t.rfind("green\n").unwrap();
    assert_eq!(s.eval_expression(&mut ed, &format!("e8.getTextProperty({g}, 'face')")).unwrap(), r#""ansi-color-green""#);
}

/// What the echo area shows, as its rows' text.
fn echo_area(ed: &Editor) -> String {
    ed.minibuffer_rows(false).iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

#[test]
fn read_passwd_hides_what_is_typed_and_keeps_no_history() {
    let d = driven();
    d.start_eval(r#"import("subr").then(({ readPasswd }) => readPasswd("Password: ").then((p) => e8.setDefault("got", p)));"#);
    d.type_text("hunter2");
    let echo = || d.with(|ed| echo_area(ed));
    assert_eq!(echo(), "Password: *******");
    // TAB shows it as typed and hides it again; C-u clears it.
    d.press("TAB");
    assert_eq!(echo(), "Password: hunter2");
    d.press("TAB");
    d.press("C-u");
    assert_eq!(echo(), "Password: ");
    d.type_text("s3cret");
    d.press("RET");
    assert_eq!(d.eval_expression("e8.variable('got')"), r#""s3cret""#);
    // Nothing typed at the prompt is in recent-keys, and no history kept it.
    let keys = d.eval_expression("JSON.stringify(e8.recentKeys())");
    assert!(!keys.contains("\\\"s\\\"") && !keys.contains("3"), "{keys}");
    let history = d.eval_expression("JSON.stringify([e8.variable('minibuffer-history'), e8.variable('t') ?? null])");
    assert!(!history.contains("s3cret"), "{history}");
    assert_eq!(d.with(|ed| ed.minibuffer().len()), 0);
}

#[test]
fn read_passwd_with_confirm_asks_until_both_agree() {
    let d = driven();
    d.start_eval(r#"import("subr").then(({ readPasswd }) => readPasswd("New: ", true).then((p) => e8.setDefault("got", p)));"#);
    let echo = || d.with(|ed| echo_area(ed));
    for typed in ["one", "two", "same"] {
        d.type_text(typed);
        d.press("RET");
        if typed == "two" {
            // The message shows for a second, then it starts over.
            assert_eq!(d.message().as_deref(), Some("Password not repeated accurately; please start over"));
            d.with(|ed| ed.advance_clock(Duration::from_secs(1)));
            d.0.settle();
        }
        if typed != "same" {
            let shown = echo();
            assert!(shown.starts_with(if typed == "one" { "Confirm password: " } else { "New: " }), "{shown}");
        }
    }
    assert_eq!(echo(), "Confirm password: ");
    d.type_text("same");
    d.press("RET");
    assert_eq!(d.eval_expression("e8.variable('got')"), r#""same""#);
}

#[test]
fn the_password_prompt_regexp_matches_as_emacs_does() {
    let (mut ed, s) = setup();
    // Emacs 30.2's string-match answers, case folded, in a fundamental-mode buffer.
    let cases = [
        ("Password: ", true),
        ("Enter passphrase for key '/home/x/.ssh/id_rsa': ", true),
        ("[sudo] password for mark: ", true),
        ("mark@host's password: ", true),
        ("Password for https://github.com: ", true),
        ("Hello: ", false),
        ("Username: ", false),
        ("PIN: ", true),
        ("Enter PIN for x: ", true),
        ("Verify password: ", true),
        ("Old password:", true),
        ("Response: ", true),
        ("Passphrase (again): ", true),
        ("Enter encryption key: (repeat) ", true),
        ("(user@host) Password: ", true),
        ("pass: ", false),
        ("Contraseña: ", true),
        ("Lösenord: ", true),
        ("Your password is: abc", false),
        ("Password:\nsomething", false),
        ("output\nPassword: ", true),
        ("Password: \n", true),
        ("PASSWORD: ", true),
        ("Bad passphrase, try again: ", true),
    ];
    for (prompt, matches) in cases {
        let got = s
            .eval_expression(
                &mut ed,
                &format!("e8.stringMatch(e8.variable('comint-password-prompt-regexp'), {prompt:?}, {{ caseFold: true }}) !== undefined"),
            )
            .unwrap();
        assert_eq!(got, matches.to_string(), "{prompt:?}");
    }
}

#[test]
fn a_password_prompt_reads_the_password_without_showing_it() {
    let d = driven();
    driven_shell(&d);
    driven_line(&d, r#"stty -echo; printf 'Password: '; read p; stty echo; echo; echo "got ${#p} chars""#);
    let echo = || d.with(|ed| echo_area(ed));
    let start = Instant::now();
    while !echo().starts_with("Password:") && start.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    d.0.settle();
    assert_eq!(echo(), "Password: ");
    d.type_text("hunter2");
    assert_eq!(echo(), "Password: *******");
    d.press("RET");
    d.until(|t| t.ends_with("got 7 chars\n$ "));
    assert!(!d.text().contains("hunter2"), "{:?}", d.text());
}

fn input(ed: &Editor) -> (String, usize) {
    let t = text(ed);
    let start = t.rfind("$ ").unwrap() + 2;
    let b = ed.window_buffer();
    (t[start..].to_string(), b.point() - t[..start].chars().count())
}

#[test]
fn the_history_comes_from_the_shells_history_file_and_goes_back_to_it() {
    let (mut ed, s) = setup();
    let dir = std::env::temp_dir().join(format!("e8-comint-history-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("history");
    std::fs::write(&file, "ls\n# a comment\necho a\necho b\nunterminated").unwrap();
    s.eval_typescript(&mut ed, "t.ts", format!("e8.setDefault('shell-history-file-name', {:?});", file.display().to_string())).unwrap();
    start_shell(&mut ed);
    // Newest first, the comment left out, and the line with no newline after it too, as Emacs reads it.
    for expected in ["echo b", "echo a", "ls"] {
        ed.press("M-p").unwrap();
        assert_eq!(input(&ed).0, expected);
    }
    ed.press("M-n").unwrap();
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed).0, "echo b");
    // Past the newest, what was typed comes back.
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed).0, "");
    type_line(&mut ed, "echo c");
    until(&mut ed, |t| t.ends_with("c\n$ "));
    s.eval_expression(&mut ed, "e8.funcall('comint-write-input-ring')").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "ls\necho a\necho b\necho c\n");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn c_c_m_r_finds_inputs_starting_with_what_is_typed() {
    let d = driven();
    driven_shell(&d);
    for line in ["echo one", "true", "echo two", "exit_not"] {
        driven_line(&d, line);
        d.until(|t| t.ends_with("$ "));
    }
    let input = || d.with(|ed| input(ed));
    d.type_text("ec");
    d.press("C-c M-r");
    assert_eq!(input(), ("echo two".to_string(), 2), "point stays after what was typed");
    d.press("C-c M-r");
    assert_eq!(input().0, "echo one");
    d.press("C-c M-s");
    assert_eq!(input().0, "echo two");
    // Going on past the newest puts back what was typed.
    d.press("C-c M-s");
    assert_eq!(input().0, "ec");
    // A regexp, asked for.
    d.press("C-c C-u");
    d.start(|ed| ed.call("comint-previous-matching-input", vec![]).unwrap());
    d.type_text("^tr");
    d.press("RET");
    assert_eq!(input().0, "true");
}

#[test]
fn m_r_searches_the_history_with_isearch() {
    let (mut ed, s) = setup();
    start_shell(&mut ed);
    for line in ["echo one", "true", "echo two", "exit_not"] {
        type_line(&mut ed, line);
        until(&mut ed, |t| t.ends_with("$ "));
    }
    ed.type_text("typed");
    ed.press("M-r").unwrap();
    ed.type_text("echo");
    // Each input back in turn, put after the prompt, point at the match, as comint-history-isearch-search.
    assert_eq!(input(&ed), ("echo two".to_string(), 0));
    assert_eq!(ed.echo(), Some("History item: 2"));
    // The search's prompt shows over the program's.
    let shown = s
        .eval_expression(
            &mut ed,
            "(() => { const at = e8.posBol(); return String(e8.overlaysAt(at).map((o) => e8.overlayGet(o, 'display')).find((d) => d !== undefined)); })()",
        )
        .unwrap();
    assert_eq!(shown, "\"Regexp history I-search backward: \"");
    ed.press("C-r").unwrap();
    assert_eq!(input(&ed).0, "echo one");
    // DEL goes back to the state before, and the input with it.
    ed.press("DEL").unwrap();
    assert_eq!(input(&ed).0, "echo two");
    ed.press("C-r").unwrap();
    ed.press("RET").unwrap();
    assert_eq!(input(&ed), ("echo one".to_string(), 0));
    // The search is put back as it was: C-r searches the buffer again, and no mark was left.
    assert_eq!(s.eval_expression(&mut ed, "e8.variable('isearch-search-fun-function')").unwrap(), "\"isearch-search-fun-default\"");
    assert_eq!(s.eval_expression(&mut ed, "e8.variable('comint-history-isearch')").unwrap(), "false");
    // C-g puts back what was typed.
    ed.press("RET").unwrap();
    until(&mut ed, |t| t.ends_with("one\n$ "));
    ed.type_text("mine");
    ed.press("M-r").unwrap();
    ed.type_text("tru");
    assert_eq!(input(&ed).0, "true");
    ed.press("C-g").unwrap();
    assert_eq!(input(&ed).0, "mine");
}
