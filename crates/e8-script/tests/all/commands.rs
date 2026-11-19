//! Commands with typed parameters, as Emacs's interactive codes give them:
//! the prefix argument as a count ("p") or as it is ("P"), point, the mark
//! and the region ("d", "m", "r"), and numbers read in the minibuffer ("n").
//! Interactively the editor supplies the first kinds without asking; code
//! passes them as numbers, and may leave a count or prefix out.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        e8.defineCommand({
          name: "test-count",
          params: [{ name: "n", kind: "count" }],
          run: (n: number) => { seen.push(n); },
        });
        e8.defineCommand({
          name: "test-raw",
          params: [{ name: "arg", kind: "prefix" }],
          run: (arg: e8.PrefixArg) => { seen.push(arg); },
        });
        e8.defineCommand({
          name: "test-region",
          params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }, { name: "at", kind: "point" }],
          run: (start: number, end: number, at: number) => { seen.push([start, end, at]); },
        });
        e8.defineCommand({
          name: "test-number",
          params: [{ name: "n", kind: "number", prompt: "How many: " }],
          run: (n: number) => { seen.push(n * 2); },
        });
        "#
        .to_string(),
    )
    .unwrap();
    (ed, s)
}

fn mx(ed: &mut Editor, name: &str) {
    ed.press("M-x").unwrap();
    ed.type_text(name);
    ed.press("RET").unwrap();
}

fn seen(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(ed, "seen.splice(0)").unwrap()
}

#[test]
fn a_count_is_the_prefix_argument_as_a_number() {
    let (mut ed, s) = setup();
    mx(&mut ed, "test-count");
    ed.press("C-u").unwrap();
    mx(&mut ed, "test-count");
    ed.press("M-5").unwrap();
    mx(&mut ed, "test-count");
    ed.press("M--").unwrap();
    mx(&mut ed, "test-count");
    assert_eq!(seen(&mut ed, &s), "[1,4,5,-1]");
    // From code it is a number, or left out for 1, or the prefix given.
    s.eval_expression(&mut ed, r#"(e8.call("test-count", 7), e8.call("test-count"), e8.callWithPrefix([16], "test-count"))"#).unwrap();
    assert_eq!(seen(&mut ed, &s), "[7,1,16]");
}

#[test]
fn a_raw_prefix_argument_comes_in_emacs_forms() {
    let (mut ed, s) = setup();
    mx(&mut ed, "test-raw");
    ed.press("C-u").unwrap();
    mx(&mut ed, "test-raw");
    ed.press("M--").unwrap();
    mx(&mut ed, "test-raw");
    ed.press("M-3").unwrap();
    mx(&mut ed, "test-raw");
    assert_eq!(seen(&mut ed, &s), r#"[null,[4],"-",3]"#);
}

#[test]
fn the_region_and_point_come_without_asking() {
    let (mut ed, s) = setup();
    mx(&mut ed, "test-region");
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("The mark is not set now, so there is no region".into()));
    ed.type_text("hello world");
    ed.press("C-a C-SPC M-f").unwrap();
    mx(&mut ed, "test-region");
    ed.press("C-x C-x").unwrap();
    mx(&mut ed, "test-region");
    assert_eq!(seen(&mut ed, &s), "[[0,5,5],[0,5,0]]");
}

#[test]
fn a_number_is_asked_for_until_it_is_one() {
    let (mut ed, s) = setup();
    mx(&mut ed, "test-number");
    assert_eq!(ed.prompt(), Some("How many: "));
    ed.type_text("lots");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), Some("How many: "));
    assert_eq!(ed.messages().last().map(String::as_str), Some("Please enter a number."));
    ed.type_text("21");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), None);
    s.eval_expression(&mut ed, r#"e8.call("test-number", "4")"#).unwrap();
    assert_eq!(seen(&mut ed, &s), "[42,8]");
}

#[test]
fn repeating_takes_the_count_afresh() {
    let (mut ed, s) = setup();
    mx(&mut ed, "test-count");
    ed.press("C-x z").unwrap();
    ed.press("C-u 3 C-x z").unwrap();
    s.eval_expression(&mut ed, r#"e8.call("test-count", undefined)"#).unwrap();
    assert_eq!(seen(&mut ed, &s), "[1,1,3,1]");
}

#[test]
fn yank_pop_follows_a_yank_from_the_clipboard() {
    struct Outside;
    impl e8_core::select::Clipboard for Outside {
        fn get_text(&mut self) -> Option<String> {
            Some("pasted".into())
        }
        fn set_text(&mut self, _: &str) {}
    }
    let mut ed = e8_core::Editor::new();
    let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
    ed.kill_new("older");
    ed.set_clipboard(Box::new(Outside));
    // As ⌘V runs it on the Mac.
    ed.command_execute("yank");
    ed.press("M-y").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "older");
}

/// yank-from-kill-ring offers what another program copied, with the kills,
/// as read-from-kill-ring's (current-kill 0) takes it in first; with
/// neither, it says the kill ring is empty.
#[test]
fn choosing_a_kill_offers_the_clipboard() {
    struct Outside(Option<String>);
    impl e8_core::select::Clipboard for Outside {
        fn get_text(&mut self) -> Option<String> {
            self.0.clone()
        }
        fn set_text(&mut self, _: &str) {}
    }
    let d = crate::driven::Driven::new("");
    d.with(|ed| ed.set_clipboard(Box::new(Outside(Some("pasted".into())))));
    d.mx("yank-from-kill-ring");
    assert_eq!(d.prompt().as_deref(), Some("Yank from kill-ring: "));
    assert_eq!(d.with(|ed| ed.kill_ring()), vec!["pasted".to_string()], "the clipboard's text is the newest kill to choose");
    d.type_text("pasted\n");
    assert_eq!(d.text(), "pasted");

    let d = crate::driven::Driven::new("");
    d.with(|ed| ed.set_clipboard(Box::new(Outside(None))));
    d.mx("yank-from-kill-ring");
    assert_eq!(d.prompt(), None);
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Kill ring is empty"));
}

#[test]
fn case_functions_give_emacs_results() {
    // What Emacs 30.2 gives for the same strings.
    let mut ed = e8_core::Editor::new();
    let s = e8_script::Scripting::new(&mut ed).unwrap();
    let mut eval = |code: &str| s.eval_expression(&mut ed, code).unwrap();
    assert_eq!(eval(r#"e8.upcase("ßa ﬁne ŉ")"#), r#""SSA FINE ʼN""#);
    assert_eq!(eval(r#"e8.downcase("ΑΣ ΑΣΑ σ İ")"#), r#""ας ασα σ i̇""#);
    assert_eq!(eval(r#"e8.capitalize("hello WORLD it's foo_bar 1st x2y ǆemal")"#), r#""Hello World It'S Foo_Bar 1st X2y ǅemal""#);
    assert_eq!(eval(r#"e8.upcaseInitials("hello WORLD it's")"#), r#""Hello WORLD It'S""#);
}

#[test]
fn casing_keeps_text_properties() {
    let mut ed = e8_core::Editor::new();
    let s = e8_script::Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("aßb");
    // Enabled, as novice.el disables it for new users.
    ed.put("upcase-region", "disabled", e8_core::Value::Null);
    s.eval_expression(&mut ed, r#"(e8.putTextProperty(1, 2, "face", "bold"), 0)"#).unwrap();
    ed.press("C-x h C-x C-u").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "ASSB");
    let faces = s.eval_expression(&mut ed, r#"JSON.stringify([0, 1, 2, 3].map((p) => e8.getTextProperty(p, "face") ?? null))"#).unwrap();
    assert_eq!(faces, r#""[null,\"bold\",\"bold\",null]""#);
}

/// M-0 M-z searches nowhere, as search-forward with a count of 0 does, so
/// it kills nothing, putting an empty kill on the ring, as Emacs 30 does.
#[test]
fn zap_with_a_count_of_zero_kills_nothing() {
    let (mut ed, _s) = setup();
    ed.type_text("abxcdx");
    ed.press("M-< M-0 M-z x").unwrap();
    let b = ed.window_buffer();
    assert_eq!((b.slice(0..b.len()), b.point()), ("abxcdx".to_string(), 0));
}

/// comment-region's prefix argument as comment-region-default-1 reads it,
/// what Emacs 30 gives in emacs-lisp-mode: none doubles a one-character
/// starter as comment-add says, N puts N, C-u uncomments, and a negative
/// number takes levels off; uncommenting what has no comment does nothing.
#[test]
fn comment_region_takes_its_prefix_argument_as_emacs_does() {
    let (mut ed, s) = setup();
    for (text, prefix, command, expected) in [
        ("(foo)\n", "", "comment-region", ";; (foo)\n"),
        ("(foo)\n", "M-1", "comment-region", "; (foo)\n"),
        ("(foo)\n", "M-3", "comment-region", ";;; (foo)\n"),
        (";; (foo)\n", "C-u", "comment-region", "(foo)\n"),
        (";;; (foo)\n", "M-- M-1", "comment-region", ";; (foo)\n"),
        ("(foo)\n", "", "uncomment-region", "(foo)\n"),
    ] {
        s.eval_expression(&mut ed, &format!("(e8.call('emacs-lisp-mode'), e8.deleteRegion(e8.pointMin(), e8.pointMax()), e8.insert({text:?}), 1)")).unwrap();
        ed.press(&format!("C-x h {prefix} M-x").replace("  ", " ")).unwrap();
        ed.type_text(&format!("{command}\n"));
        let b = ed.window_buffer();
        assert_eq!(b.slice(0..b.len()), expected, "{prefix} {command} on {text:?}: {:?}", ed.echo());
    }
}

/// Plain C-u M-g g goes to the line in the buffer shown before, in another window, as Emacs's goto-line.
#[test]
fn goto_line_with_plain_c_u_goes_to_the_other_buffer() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("other\n");
    d.type_text("one\ntwo\nthree\n");
    d.press("C-x b");
    d.type_text("here\n");
    d.type_text("a\nb\n");
    d.press("C-u M-g g");
    assert!(d.prompt().unwrap_or_default().starts_with("Goto line in other (default "), "{:?}", d.prompt());
    d.type_text("3\n");
    assert_eq!(d.buffer_name(), "other");
    assert_eq!(d.with(|ed| {
        let b = ed.buffer();
        b.slice(b.point()..b.len())
    }), "three\n");
    assert_eq!(d.with(|ed| ed.windows().len()), 2, "shown in another window");
}

/// C-x ESC ESC edits and runs again a command that read its arguments in
/// the minibuffer, as Emacs's repeat-complex-command; commands that read
/// nothing are not kept.
#[test]
fn repeat_complex_command_runs_a_command_again() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("t\n");
    d.type_text("one two one");
    d.press("M-<");
    d.mx("replace-string");
    d.type_text("one\nthree\n");
    assert_eq!(d.text(), "three two three");
    let kept = d.with(|ed| format!("{:?}", ed.variable("command-history")));
    assert!(!kept.contains("execute-extended-command"), "{kept}");
    // A command M-x runs is kept though it reads nothing, as command-execute records it.
    d.mx("forward-char");
    let newest = d.with(|ed| match ed.variable("command-history") {
        Some(e8_core::Value::List(items)) => format!("{:?}", items[0]),
        other => format!("{other:?}"),
    });
    assert_eq!(newest, r#"List([Symbol("forward-char"), Number(1.0)])"#);
    d.press("C-b");
    d.press("C-f");
    d.press("M-<");
    d.type_text("one ");
    d.press("M-<");
    // The second newest, past the forward-char M-x ran.
    d.press("M-2 C-x ESC ESC");
    assert_eq!(d.prompt().as_deref(), Some("Redo: "));
    assert_eq!(d.with(|ed| ed.minibuffer_input()), r#"(replace-string "one" "three" nil)"#);
    d.press("RET");
    assert_eq!(d.text(), "three three two three");
    // With nothing kept, it says so.
    d.with(|ed| ed.set_variable("command-history", e8_core::Value::List(Vec::new())));
    d.press("C-x M-:");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("There are no previous complex commands"));
}

/// C-x C-n sets a goal column C-n and C-p keep to, and C-u C-x C-n unsets
/// it, as Emacs's set-goal-column.
#[test]
fn set_goal_column_keeps_line_moves_to_a_column() {
    // Enabled, as novice.el disables it for new users.
    let d = crate::driven::Driven::new(r#"e8.put("set-goal-column", "disabled", null);"#);
    d.press("C-x b");
    d.type_text("g\n");
    d.type_text("abcdef\nab\nabcdef\n");
    d.press("M-<");
    d.press("C-f C-f C-f C-f");
    d.press("C-x C-n");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Goal column 4 (use C-x C-n with an arg to unset it)"));
    d.press("C-a C-n");
    assert_eq!(d.point(), 9, "the end of the short line");
    d.press("C-a C-n");
    assert_eq!(d.point(), 14, "column 4 again, though it started at 0");
    d.press("C-u C-x C-n");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("No goal column"));
    d.press("C-a C-p");
    assert_eq!(d.point(), 7, "the column it starts from");
}

/// rename-uniquely gives the buffer a name with <N>, as Emacs's.
#[test]
fn rename_uniquely_adds_a_number() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("*shell*\n");
    d.mx("rename-uniquely");
    assert_eq!(d.buffer_name(), "*shell*<2>");
    d.press("C-x b");
    d.type_text("*shell*\n");
    d.mx("rename-uniquely");
    assert_eq!(d.buffer_name(), "*shell*<3>", "its own <N> is taken off first");
}

/// Binary overwrite mode replaces characters one for one, newlines too,
/// and C-q in textual overwrite mode takes a digit as itself, as Emacs's.
#[test]
fn binary_overwrite_and_quoted_digits_in_overwrite_mode() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("o\n");
    d.type_text("ab\ncd");
    d.press("M-<");
    d.press("C-f");
    d.mx("binary-overwrite-mode");
    d.type_text("xyz");
    assert_eq!(d.text(), "axyzd");
    d.mx("overwrite-mode");
    assert!(!d.with(|ed| ed.variable("binary-overwrite-mode").is_some_and(|v| v.is_true())), "one overwrite mode at a time");
    d.press("M-<");
    d.press("C-q 1");
    assert_eq!(d.text(), "1axyzd", "the digit itself, inserted as quoted-insert does");
    d.mx("binary-overwrite-mode");
    d.press("C-q 1 6 2 RET");
    assert_eq!(d.text(), "1rxyzd", "an octal code, replacing the a");
}

/// M-z reads its character in the minibuffer, as Emacs 30's
/// read-char-from-minibuffer: the first character ends it, M-p brings the
/// last one back, and RET with nothing typed is a wrong answer.
#[test]
fn zap_to_char_reads_from_the_minibuffer_with_a_history() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("z\n");
    d.type_text("one two one two");
    d.press("M-< M-z");
    assert_eq!(d.prompt().as_deref(), Some("Zap to char: "));
    d.type_text("e");
    assert_eq!(d.text(), " two one two");
    assert_eq!(d.message().as_deref(), Some("Zap to char: e"));
    d.press("M-z RET");
    assert_eq!(d.prompt().as_deref(), Some("Zap to char: "), "RET alone is a wrong answer");
    d.press("M-p");
    assert_eq!(d.text(), " two");
}
