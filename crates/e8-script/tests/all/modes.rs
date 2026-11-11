//! Variables, hooks and modes, as scripts use them, with the packages that
//! ship with E8 loaded.

use std::fs;

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn variables_have_global_and_buffer_local_values() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineVariable({ name: "my-width", doc: "How wide.", value: 70 });
        e8.defineVariable({ name: "my-style", doc: "Per buffer.", value: "plain", local: true });
        "#,
    );
    assert_eq!(ed.variable("my-width"), Some(Value::Number(70.0)));

    // A buffer can have its own value; others keep seeing the global one.
    ed.switch_to_buffer("other");
    eval(&mut ed, &scripting, r#"e8.makeLocalVariable("my-width"); e8.setVariable("my-width", 20);"#);
    assert_eq!(ed.variable("my-width"), Some(Value::Number(20.0)));
    ed.switch_to_buffer("*scratch*");
    assert_eq!(ed.variable("my-width"), Some(Value::Number(70.0)));

    // An automatically local variable only changes in the buffer that sets it.
    eval(&mut ed, &scripting, r#"e8.setVariable("my-style", "fancy");"#);
    assert_eq!(ed.variable("my-style"), Some(Value::Str("fancy".into())));
    ed.switch_to_buffer("other");
    assert_eq!(ed.variable("my-style"), Some(Value::Str("plain".into())));

    // defineVariable keeps a value that is already set, as defvar does.
    eval(&mut ed, &scripting, r#"e8.setDefault("my-width", 99); e8.defineVariable({ name: "my-width", value: 1 });"#);
    assert_eq!(ed.default_value("my-width"), Some(Value::Number(99.0)));
}

#[test]
fn describe_variable_shows_the_value_and_where_it_came_from() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(
            &mut ed,
            "init.ts",
            r#"e8.defineVariable({ name: "my-width", doc: "How wide lines are.", value: 70 });
               e8.makeLocalVariable("my-width"); e8.setVariable("my-width", 20);"#
                .into(),
        )
        .unwrap();
    ed.press("C-h v").unwrap();
    ed.type_text("my-wi\t\n");
    // In the window display-buffer pops up for it, as in Emacs.
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "*Help*");
    let help = text(&ed);
    assert!(help.starts_with("my-width is a variable"), "{help}");
    assert!(help.contains("Its value is 20"), "{help}");
    assert!(help.contains("Local in buffer *scratch*; global value is 70"), "{help}");
    assert!(help.contains("How wide lines are."), "{help}");
    // *Help* is in Help mode, where q goes back.
    assert_eq!(ed.mode_name(), "Help");
    ed.press("q").unwrap();
    assert_eq!(ed.window_buffer().name, "*scratch*");
}

#[test]
fn hooks_run_from_the_command_loop_and_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineVariable({ name: "commands-run", value: 0 });
        function count() {
          e8.setVariable("commands-run", (e8.variable("commands-run") as number) + 1);
        }
        e8.addHook("post-command-hook", count);
        e8.addHook("post-command-hook", count); // not added twice
        e8.addHook("after-save-hook", () => e8.message("saved!"));
        // Each script has its own scope, so removing the hook needs the same function from here.
        e8.defineCommand({ name: "stop-counting", run: () => e8.removeHook("post-command-hook", count) });
        "#,
    );
    ed.type_text("abc");
    assert_eq!(ed.variable("commands-run"), Some(Value::Number(3.0)));
    ed.call("stop-counting", vec![]).unwrap();
    ed.type_text("d");
    assert_eq!(ed.variable("commands-run"), Some(Value::Number(3.0)));

    let path = dir.path().join("f.txt");
    ed.call("write-file", vec![e8_core::Arg::Str(path.display().to_string())]).unwrap();
    assert_eq!(ed.echo(), Some("saved!"));
    assert!(ed.variable("post-command-hook").is_some());
}

#[test]
fn major_modes_build_on_their_parent() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineVariable({ name: "order", value: [] });
        const note = (what: string) =>
          e8.setVariable("order", [...(e8.variable("order") as e8.Value[]), what]);
        const shout = e8.defineCommand({ name: "shout", run: () => e8.insert("!") });
        const whisper = e8.defineCommand({ name: "whisper", run: () => e8.insert(".") });
        e8.defineMajorMode({
          name: "prose-mode", modeName: "Prose", parent: "text-mode",
          bindings: { "C-c s": shout },
          setup: () => { note("prose setup"); e8.setVariable("tab-width", 4); },
        });
        e8.addHook("text-mode-hook", () => note("text hook"));
        e8.addHook("prose-mode-hook", () => note("prose hook"));
        e8.bindKey("C-c w", whisper, "text-mode-map");
        "#,
    );
    ed.call("prose-mode", vec![]).unwrap();
    assert_eq!(ed.mode_name(), "Prose");
    assert_eq!(ed.variable("major-mode"), Some(Value::Str("prose-mode".into())));
    // Setup runs before the hooks, and the parent's hook runs first.
    assert_eq!(
        ed.variable("order"),
        Some(Value::List(vec!["prose setup".into(), "text hook".into(), "prose hook".into()]))
    );
    // The mode's own keys and its parent's both work.
    ed.press("C-c s C-c w").unwrap();
    assert_eq!(text(&ed), "!.");
    assert_eq!(ed.tab_width(), 4);

    // A new major mode clears the buffer's own values and keys: C-c is
    // undefined now, so the s after it is typed.
    ed.call("fundamental-mode", vec![]).unwrap();
    assert_eq!(ed.tab_width(), 8);
    ed.press("C-c s").unwrap();
    assert_eq!(text(&ed), "!.s");
}

#[test]
fn minor_mode_keys_come_before_the_major_mode_and_global_keys() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const a = e8.defineCommand({ name: "insert-a", run: () => e8.insert("a") });
        const b = e8.defineCommand({ name: "insert-b", run: () => e8.insert("b") });
        const c = e8.defineCommand({ name: "insert-c", run: () => e8.insert("c") });
        e8.bindKey("C-c x", a);
        e8.bindKey("C-c x", b, "text-mode-map");
        e8.defineMinorMode({ name: "loud-mode", lighter: " Loud", bindings: { "C-c x": c } });
        "#,
    );
    ed.press("C-c x").unwrap();
    ed.call("text-mode", vec![]).unwrap();
    ed.press("C-c x").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("loud-mode\n");
    assert_eq!(ed.echo(), Some("Loud mode enabled in current buffer"));
    assert_eq!(ed.mode_lighters(), [" Loud"]);
    ed.press("C-c x").unwrap();
    assert_eq!(text(&ed), "abc");

    // Typed again, it turns off; a buffer-local mode stays in its buffer.
    ed.press("M-x").unwrap();
    ed.type_text("loud-mode\n");
    assert!(ed.mode_lighters().is_empty());
}

#[test]
fn visiting_a_file_chooses_its_mode() {
    let dir = tempfile::tempdir().unwrap();
    let (mut ed, _scripting) = setup();
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, "Some notes\n").unwrap();
    ed.visit_file(&notes).unwrap();
    assert_eq!(ed.mode_name(), "Text");

    // The first line can ask for a mode, as in Emacs.
    let other = dir.path().join("readme");
    fs::write(&other, "-*- mode: text -*-\nHello\n").unwrap();
    ed.visit_file(&other).unwrap();
    assert_eq!(ed.mode_name(), "Text");

    let plain = dir.path().join("data.bin");
    fs::write(&plain, "x").unwrap();
    ed.visit_file(&plain).unwrap();
    assert_eq!(ed.mode_name(), "Fundamental");
}

#[test]
fn describe_mode_lists_the_major_and_minor_modes() {
    let (mut ed, _scripting) = setup();
    ed.call("text-mode", vec![]).unwrap();
    ed.press("<insert>").unwrap();
    ed.press("C-h m C-x o").unwrap();
    let help = text(&ed);
    assert!(help.starts_with("The major mode is Text mode (text-mode), defined in packages/text-mode.ts:"), "{help}");
    assert!(help.contains("Minor modes that are on: Icomplete mode, Help-Guide mode, Show-Paren mode, Overwrite mode."), "{help}");
    assert!(help.contains("Replace text rather than insert it"), "{help}");
}

#[test]
fn tab_width_is_per_buffer() {
    let (mut ed, scripting) = setup();
    eval(&mut ed, &scripting, r#"e8.setVariable("tab-width", 4);"#);
    assert_eq!(ed.tab_width(), 4);
    ed.switch_to_buffer("other");
    assert_eq!(ed.tab_width(), 8);
}
