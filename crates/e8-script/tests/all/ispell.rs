//! Spell checking with Hunspell's dictionaries, here a stand-in for Hunspell
//! (tests/data/fake_hunspell.py) with an English and a Swedish word list:
//! two languages at once, as "en_US,sv_SE", a buffer's own dictionary,
//! choosing one with ispell-change-dictionary, the personal dictionary, and
//! the corrections that change more than the word. The oracle compares
//! the rest with Emacs, with Ispell.

use e8_core::Editor;
use e8_script::Scripting;

struct Speller {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
}

const ENGLISH: &str = "a\nand\nhello\nhere\nis\nknow\nmistake\nspelling\nthe\nthey\nword\n";
const SWEDISH: &str = "färdig\ngöteborg\nhej\njag\noch\när\n";

/// An editor checking spelling with the stand-in Hunspell, its buffer holding `text`.
fn speller(text: &str) -> Option<Speller> {
    if std::process::Command::new("python3").arg("-V").output().is_err() {
        return None;
    }
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let program = dir.path().join("hunspell");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_hunspell.py"), &program).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    for (name, words, wordchars) in [("en_US", ENGLISH, "0123456789"), ("sv_SE", SWEDISH, "-")] {
        std::fs::write(dir.path().join(format!("{name}.aff")), format!("SET UTF-8\nWORDCHARS {wordchars}\n")).unwrap();
        std::fs::write(dir.path().join(format!("{name}.dic")), words).unwrap();
    }
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut t = Speller { ed, s, dir };
    t.eval(&format!("e8.setVariable('ispell-program-name', {:?})", program.display().to_string()));
    t.ed.window_buffer_mut().set_text(text);
    Some(t)
}

/// Text as keys to type, a key a character.
fn typed(text: &str) -> String {
    text.chars().map(|c| if c == ' ' { "SPC".to_string() } else { c.to_string() }).collect::<Vec<_>>().join(" ")
}

/// M-x running a command, as keys.
fn mx(command: &str) -> String {
    format!("M-x {} RET", typed(command))
}

impl Speller {
    fn eval(&mut self, expression: &str) -> String {
        self.s.eval_expression(&mut self.ed, expression).unwrap()
    }

    fn text(&self) -> String {
        let b = self.ed.window_buffer();
        b.slice(0..b.len())
    }

    /// The arguments the checker was run with, a run a line.
    fn args(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("args.log")).unwrap_or_default()
    }
}

#[test]
fn english_and_swedish_are_checked_at_once() {
    let Some(mut t) = speller("Hej, hello and färdig speling.\n") else { return };
    t.eval("e8.setVariable('ispell-dictionary', 'en_US,sv_SE')");
    t.ed.press(&format!("{} 0", mx("ispell-buffer"))).unwrap();
    assert_eq!(t.text(), "Hej, hello and färdig spelling.\n", "only the misspelling is asked about");
    let args = t.args();
    assert!(args.lines().any(|l| l.starts_with("-a ") && l.contains("-d en_US,sv_SE") && l.contains("-i UTF-8")), "{args}");
    assert!(t.ed.echo().unwrap().ends_with("using hunspell with en_US,sv_SE dictionary...done"), "{:?}", t.ed.echo());
}

#[test]
fn a_swedish_word_is_one_word_and_right_in_swedish() {
    let Some(mut t) = speller("Jag är färdig\n") else { return };
    t.eval("e8.setVariable('ispell-dictionary', 'sv_SE')");
    t.ed.press("C-e M-$").unwrap();
    assert_eq!(t.ed.echo(), Some("FÄRDIG is correct"));
}

#[test]
fn flyspell_marks_only_what_neither_language_knows() {
    let Some(mut t) = speller("Hej och hello, färdig speling wrod.\n") else { return };
    t.eval("e8.setVariable('ispell-dictionary', 'en_US,sv_SE')");
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    let marked = t.eval(
        r#"(e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "flyspell-overlay") === true)
            .sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b))
            .map((o) => e8.bufferSubstringNoProperties(e8.overlayStart(o), e8.overlayEnd(o))))"#,
    );
    assert_eq!(marked, r#"["speling","wrod"]"#);
}

#[test]
fn the_dictionaries_hunspell_has_can_be_chosen() {
    let Some(mut t) = speller("hello\n") else { return };
    let list = t.eval("e8.funcall('ispell-valid-dictionary-list')");
    for name in ["\"default\"", "\"en_US\"", "\"sv_SE\"", "\"american\"", "\"svenska\""] {
        assert!(list.contains(name), "{name} in {list}");
    }
    t.ed.press(&format!("{} {} RET", mx("ispell-change-dictionary"), typed("sv_SE"))).unwrap();
    assert_eq!(t.ed.echo(), Some("Local Ispell dictionary set to sv_SE"));
    assert_eq!(t.eval("String(e8.variable('ispell-local-dictionary'))"), "\"sv_SE\"");
    assert_eq!(t.eval("String(e8.defaultValue('ispell-local-dictionary'))"), "\"null\"", "other buffers keep theirs");
    // Swedish now, so hello is wrong.
    t.ed.press("M-< M-$ SPC").unwrap();
    assert!(t.args().lines().any(|l| l.contains("-d sv_SE")), "{}", t.args());
}

#[test]
fn a_combination_made_with_ispell_hunspell_add_multi_dic_can_be_chosen() {
    let Some(mut t) = speller("hej hello\n") else { return };
    t.ed.press(&format!("{} {} RET", mx("ispell-hunspell-add-multi-dic"), typed("en_US,sv_SE"))).unwrap();
    t.ed.press(&format!("C-u {} {} RET", mx("ispell-change-dictionary"), typed("en_US,sv_SE"))).unwrap();
    assert_eq!(t.ed.echo(), Some("Global Ispell dictionary set to en_US,sv_SE"));
    t.ed.press("M-$").unwrap();
    assert_eq!(t.ed.echo(), Some("HEJ is correct"));
}

#[test]
fn a_file_names_its_own_dictionary() {
    let Some(mut t) = speller("hello färdig\n\nLocal IspellDict: sv_SE\n") else { return };
    t.ed.press(&format!("{} SPC", mx("ispell-buffer"))).unwrap();
    assert!(t.ed.echo().unwrap().ends_with("using hunspell with sv_SE dictionary...done"), "{:?}", t.ed.echo());
    assert!(t.args().lines().any(|l| l.starts_with("-a ") && l.contains("-d sv_SE")), "{}", t.args());
}

#[test]
fn a_word_saved_to_the_personal_dictionary_is_saved_only_when_asked() {
    let Some(mut t) = speller("A helo there\n") else { return };
    let words = t.dir.path().join("words");
    std::fs::write(&words, "").unwrap();
    t.eval(&format!("e8.setVariable('ispell-personal-dictionary', {:?})", words.display().to_string()));
    t.ed.press("M-f M-f M-$ i n").unwrap();
    assert_eq!(std::fs::read_to_string(&words).unwrap(), "", "not saved when told not to");
    t.ed.press("M-$").unwrap();
    assert_eq!(t.ed.echo(), Some("HELO is correct"), "but known for the session");
    t.ed.press(&format!("{} y", mx("ispell-pdict-save"))).unwrap();
    assert_eq!(std::fs::read_to_string(&words).unwrap(), "helo\n");
}

#[test]
fn r_query_replaces_the_correction_through_the_buffer() {
    let Some(mut t) = speller("A speling, the speling.\n") else { return };
    t.ed.press(&format!("M-f M-f M-$ R C-a C-k {} RET y", typed("spelling"))).unwrap();
    assert_eq!(t.text(), "A spelling, the spelling.\n");
}

#[test]
fn choosing_a_correction_takes_the_choices_window_away() {
    let Some(mut t) = speller("A speling mistake.\n") else { return };
    t.ed.press("M-f M-f M-$ 1").unwrap();
    assert_eq!(t.text(), "A spieling mistake.\n");
    assert!(!t.ed.buffers().iter().any(|b| b.name == "*Choices*"), "killed, as ispell-word does");
    assert_eq!(t.ed.window_list().len(), 1);
}

#[test]
fn a_word_is_completed_from_the_word_list() {
    let Some(mut t) = speller("Some spel\n") else { return };
    let list = t.dir.path().join("wordlist");
    std::fs::write(&list, "spell\nspelling\nspelt\nzebra\n").unwrap();
    t.eval(&format!("e8.setVariable('ispell-alternate-dictionary', {:?})", list.display().to_string()));
    t.eval("e8.setVariable('ispell-look-command', null)");
    t.ed.press(&format!("C-e {} 1", mx("ispell-complete-word"))).unwrap();
    assert_eq!(t.text(), "Some spelling\n");
}

#[test]
fn the_word_list_completes_at_point() {
    let Some(mut t) = speller("Some spel\n") else { return };
    let list = t.dir.path().join("wordlist");
    std::fs::write(&list, "spell\nspelling\nzebra\n").unwrap();
    t.eval(&format!("e8.setVariable('ispell-alternate-dictionary', {:?})", list.display().to_string()));
    t.eval("e8.setVariable('ispell-look-command', null)");
    t.ed.press("C-e").unwrap();
    assert_eq!(t.eval("e8.funcall('ispell-completion-at-point')"), "[5,9,[\"spell\",\"spelling\"]]");
}

#[test]
fn answers_stay_with_their_words_when_one_has_none() {
    let Some(mut t) = speller("x\n") else { return };
    // The checker finds no word in "123", so its answer is only the empty line.
    t.s.eval_typescript(
        &mut t.ed,
        "answers.ts",
        r#"import("ispell").then(({ checkWords }) =>
          e8.setVariable("ispell-test-answers", checkWords(["hello", "123", "speling"]).map((p) => (Array.isArray(p) ? p[0] : String(p)))));"#
            .to_string(),
    )
    .unwrap();
    assert_eq!(t.eval("e8.variable('ispell-test-answers')"), r#"["true","true","speling"]"#);
}

#[test]
fn c_g_suspends_as_x_does() {
    let Some(mut t) = speller("A speling mistake and a wrod.\n") else { return };
    t.ed.press(&format!("{} C-g", mx("ispell-buffer"))).unwrap();
    assert_eq!(t.ed.echo(), Some("Spell-checking suspended; use C-u M-$ to resume"));
    t.ed.press("C-u M-$ 0 0").unwrap();
    assert_eq!(t.text(), "A spelling mistake and a word.\n", "C-u M-$ goes on from the word it stopped at");
}

#[test]
fn one_checker_is_kept_running_for_every_check() {
    let Some(mut t) = speller("Hej hello world and more words here.\n") else { return };
    t.eval("e8.setVariable('ispell-dictionary', 'en_US,sv_SE')");
    t.ed.press("M-f M-$ M-f M-$ M-f M-$").unwrap();
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    let runs = t.args().lines().filter(|l| l.starts_with("-a ")).count();
    assert_eq!(runs, 1, "started once, as ispell.el keeps ispell-process: {}", t.args());
    t.ed.press("M-x").unwrap();
    t.ed.type_text("ispell-kill-ispell");
    t.ed.press("RET").unwrap();
    assert_eq!(t.ed.echo(), Some("Ispell process killed"));
    t.ed.press("M-$").unwrap();
    assert_eq!(t.args().lines().filter(|l| l.starts_with("-a ")).count(), 2, "and started again when needed");
}

#[test]
fn a_checker_that_ends_is_started_again_by_the_next_check() {
    let Some(mut t) = speller("Hej hello\n") else { return };
    t.eval("e8.setVariable('ispell-dictionary', 'en_US,sv_SE')");
    t.ed.press("M-$").unwrap();
    // The checker ends behind E8's back, as one that crashed would.
    t.eval("e8.deleteProcess('ispell')");
    t.ed.press("M-f M-f M-$").unwrap();
    assert_eq!(t.ed.echo(), Some("HELLO is correct"));
    assert_eq!(t.args().lines().filter(|l| l.starts_with("-a ")).count(), 2, "{}", t.args());
}

impl Speller {
    /// The lines the checker was asked to check, a line each.
    fn checked(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("checked.log")).unwrap_or_default()
    }

    fn forget_checked(&self) {
        let _ = std::fs::remove_file(self.dir.path().join("checked.log"));
    }

    /// Takes in the checker's answers until none comes for a while, as
    /// the command loop does while it waits for keys.
    fn settle(&mut self) {
        while self.eval("e8.acceptProcessOutput(undefined, 0.3)") == "true" {}
    }

    /// The words flyspell marks, in order.
    fn marked(&mut self) -> String {
        self.eval(
            r#"e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "flyspell-overlay") === true)
                .sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b))
                .map((o) => e8.bufferSubstringNoProperties(e8.overlayStart(o), e8.overlayEnd(o))).join(" ")"#,
        )
        .trim_matches('"')
        .to_string()
    }
}

#[test]
fn what_the_checker_said_is_not_asked_again_until_what_it_accepts_changes() {
    let Some(mut t) = speller("A speling and a wrod.\n") else { return };
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    assert_eq!(t.marked(), "speling wrod");
    assert!(t.checked().lines().any(|l| l == "speling"), "{}", t.checked());
    t.forget_checked();
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    assert_eq!(t.checked(), "", "every word's answer is remembered");
    assert_eq!(t.marked(), "speling wrod");
    t.eval("e8.funcall('ispell-send-string', '@and\\n')");
    t.forget_checked();
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    assert!(t.checked().lines().count() > 0, "a word accepted forgets the answers");
    // Accepting it again, as flyspell tells the checker a buffer's words again, changes nothing.
    t.eval("e8.funcall('ispell-send-string', '@and\\n')");
    t.forget_checked();
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    assert_eq!(t.checked(), "");
    t.eval("e8.funcall('ispell-send-string', '@speling\\n')");
    t.forget_checked();
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    assert!(t.checked().lines().any(|l| l == "speling"), "{}", t.checked());
    assert_eq!(t.marked(), "wrod", "and the word accepted is right now");
}

/// Words the stand-in does not know, `n` of them, each different: letters only, as it finds words.
fn unknown_words(n: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            let (mut i, mut w) = (i, String::from("q"));
            for _ in 0..3 {
                w.push((b'a' + (i % 26) as u8) as char);
                i /= 26;
            }
            w
        })
        .collect()
}

#[test]
fn a_large_region_is_checked_by_several_checkers_that_know_what_the_session_accepts() {
    let words = unknown_words(300);
    let text = format!("hello {}\n", words.join(" "));
    let Some(mut t) = speller(&text) else { return };
    // Accepted before the helpers start: the second batch of words goes to a helper, if there is one.
    t.ed.press("M-$").unwrap();
    let accepted = &words[40];
    t.eval(&format!("e8.funcall('ispell-send-string', '@{accepted}\\n')"));
    t.ed.call("flyspell-buffer", vec![]).unwrap();
    let rest: Vec<&str> = words.iter().filter(|w| *w != accepted).map(String::as_str).collect();
    assert_eq!(t.marked(), rest.join(" "), "every unknown word but the one accepted");
    let processors: usize = t.eval("String(e8.numProcessors())").trim_matches('"').parse().unwrap();
    let runs = t.args().lines().filter(|l| l.starts_with("-a ")).count();
    assert_eq!(runs, 1 + 3.min(processors - 1), "the checker and its helpers: {}", t.args());
    let checked: Vec<String> = t.checked().lines().map(str::to_string).collect();
    for w in &words {
        assert_eq!(checked.iter().filter(|c| *c == w).count(), 1, "{w} checked once, by one checker");
    }
    // Killing the session ends its helpers too.
    t.ed.press("M-x").unwrap();
    t.ed.type_text("ispell-kill-ispell");
    t.ed.press("RET").unwrap();
    assert_eq!(t.eval("String(e8.processList().length)"), "\"0\"");
}

#[test]
fn a_word_typed_is_marked_when_the_answer_comes() {
    let Some(mut t) = speller("") else { return };
    t.ed.press(&mx("flyspell-mode")).unwrap();
    t.ed.press(&typed("a helo ")).unwrap();
    assert_eq!(t.marked(), "", "the command did not wait for the answer");
    t.settle();
    assert_eq!(t.marked(), "helo");
    // A word changed before its answer comes is not marked by that answer.
    t.ed.press(&format!("{} DEL DEL DEL DEL DEL {}", typed("wrod "), typed("word "))).unwrap();
    t.settle();
    assert_eq!(t.marked(), "helo", "{}", t.text());
    assert_eq!(t.text(), "a helo word ");
}

#[test]
fn a_command_that_reads_the_marks_finds_those_still_to_come() {
    let Some(mut t) = speller("A wrod.\n") else { return };
    t.ed.press(&mx("flyspell-mode")).unwrap();
    // C-e leaves wrod, and C-; looks for the mark before point straight
    // after, before the command loop has taken in the answer.
    t.ed.press("C-e C-;").unwrap();
    assert_eq!(t.text(), "A word.\n");
}
