//! The command loop's own primitives: reading keys partway through a
//! command, the keys that ran it, the keys typed lately, and recursive edits.

use crate::driven::Driven;

/// What an expression gives, a string unquoted as the test reads it.
fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}
use e8_core::Editor;
use e8_script::Scripting;

/// The commands below that read, on the editor's own thread, as a key read
/// partway through a command waits for it (ADR 0053).
fn driven() -> Driven {
    Driven::new(COMMANDS)
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // Commands that read as Emacs's tests below do, each inserting what it read.
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            COMMANDS.into(),
        )
        .unwrap();
    (ed, scripting)
}

// Commands that read as Emacs's tests below do, each inserting what it read.
const COMMANDS: &str = r#"
            e8.bindKey("C-c k", e8.defineCommand({ name: "test-read-key", run: async () => e8.insert(`${await e8.readKey("Key: ")}|`) }));
            e8.bindKey("C-c c", e8.defineCommand({ name: "test-read-char", run: async () => e8.insert(`${await e8.readChar("Char: ")}|`) }));
            e8.bindKey("C-c s", e8.defineCommand({
              name: "test-read-key-sequence",
              run: async () => e8.insert(`${await e8.readKeySequence("Keys: ")}|${e8.thisCommandKeys()}|`),
            }));
            e8.bindKey("C-c t", e8.defineCommand({ name: "test-command-keys", run: () => e8.insert(`${e8.thisCommandKeys()}|`) }));
            e8.bindKey("C-c r", e8.defineCommand({
              name: "test-recursive-edit",
              run: async () => {
                try {
                  await e8.recursiveEdit();
                  e8.insert("<back>");
                } catch (e) {
                  e8.insert("<quit>");
                  throw e;
                }
              },
            }));
            "#;

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn keys_read_partway_through_a_command_as_emacs_reads_them() {
    // What Emacs 30.2 inserts for the same keys, run as a keyboard macro.
    let d = driven();
    d.press("C-c k");
    assert_eq!(d.message().as_deref(), Some("Key: "));
    d.press("<f1> C-c k M-x C-c k ESC x");
    assert_eq!(d.text(), "<f1>|M-x|ESC|x", "ESC alone, then x typed");
    let d = driven();
    d.press("C-c s C-x C-f C-c s C-g C-u 4 C-c t C-c t");
    assert_eq!(d.text(), "C-x C-f|C-x C-f|C-g|C-g|C-c t|C-c t|", "the prefix argument's keys are not the command's");
}

#[test]
fn quitting_or_a_wrong_key_ends_the_reading() {
    let d = driven();
    d.press("C-c k C-g");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    d.press("C-c c <f1>");
    assert_eq!(d.message().as_deref(), Some("Non-character input-event"));
    d.press("C-c c a");
    assert_eq!(d.text(), "a|", "only the character read, inserted once");
}

#[test]
fn recent_keys_and_view_lossage() {
    let (mut ed, s) = setup();
    ed.press("a C-f C-x").unwrap();
    let keys = s.eval_expression(&mut ed, "JSON.stringify(e8.recentKeys(true))").unwrap();
    assert_eq!(keys, r#""[\"a\",{\"command\":\"self-insert-command\"},\"C-f\",{\"command\":\"forward-char\"},\"C-x\"]""#);
    assert_eq!(s.eval_expression(&mut ed, "e8.recentKeys().length").unwrap(), "3");
    // As view-lossage lays it out: a command a line, its name at column 24.
    let (mut ed, s) = setup();
    ed.press("a C-f C-x C-f C-h l").unwrap();
    let _ = &s;
    let help = ed.find_buffer("*Help*").map(|i| ed.buffers()[i].slice(0..ed.buffers()[i].len())).unwrap();
    assert!(help.starts_with(" a\t\t\t;; self-insert-command\n C-f\t\t\t;; forward-char\n C-x C-f\t\t;; find-file\n"), "{help:?}");
    assert_eq!(s.eval_expression(&mut ed, "e8.lossageSize()").unwrap(), "300");
}

#[test]
fn recursive_edits_wait_for_c_m_c_or_quit_with_c_bracket() {
    let d = driven();
    d.press("C-c r");
    assert_eq!(d.eval_expression("e8.recursionDepth()"), "1");
    let line = d.with(|ed| {
        ed.redisplay();
        ed.mode_line(ed.selected_window()).iter().map(|seg| seg.text.clone()).collect::<String>()
    });
    assert!(line.contains("[(Fundamental)]"), "{line}");
    // Commands go on meanwhile.
    d.type_text("typed ");
    d.press("C-M-c");
    assert_eq!(d.text(), "typed <back>");
    assert_eq!(d.eval_expression("e8.recursionDepth()"), "0");
    d.press("C-c r C-]");
    assert_eq!(d.text(), "typed <back><quit>");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    d.press("C-]");
    assert_eq!(d.message().as_deref(), Some("No recursive edit is in progress"));
    // top-level leaves every level, minibuffers too.
    d.press("C-c r C-c r M-x");
    d.with(|ed| ed.call("top-level", vec![]).map_err(|e| e.to_string())).unwrap();
    d.0.settle();
    assert_eq!(d.eval_expression("e8.recursionDepth()"), "0");
    assert_eq!(d.prompt(), None);
}

#[test]
fn read_event_gives_up_after_its_seconds_and_sit_for_stops_for_a_key() {
    use std::time::Duration;
    let d = driven();
    d.eval(
        r#"
        e8.bindKey("C-c e", e8.defineCommand({
          name: "test-read-event-timeout",
          run: async () => e8.insert(`${await e8.readEvent("Event: ", { seconds: 2 }) ?? "nil"}|`),
        }));
        e8.bindKey("C-c w", e8.defineCommand({
          name: "test-sit-for",
          run: async () => e8.insert(`${await e8.sitFor(2)}|`),
        }));
        e8.bindKey("C-c z", e8.defineCommand({
          name: "test-sleep-for",
          run: async () => {
            await e8.sleepFor(1);
            e8.insert("slept|");
          },
        }));
        "#,
    );
    let advance = |secs: u64| {
        d.with(move |ed| ed.advance_clock(Duration::from_secs(secs)));
        d.0.settle();
    };
    // A key in time is the answer; none, and it is nil after the seconds.
    d.press("C-c e");
    assert_eq!(d.message().as_deref(), Some("Event: "));
    advance(1);
    d.press("a");
    d.press("C-c e");
    assert!(d.with(|ed| ed.next_timer_in().is_some_and(|t| t <= Duration::from_secs(2))), "the front end wakes for the timeout");
    advance(2);
    assert_eq!(d.text(), "a|nil|");
    assert_eq!(d.message(), None);
    // sit-for: true when the time passes; false at a key, which then runs.
    d.press("C-c w");
    advance(2);
    d.press("C-c w x");
    assert_eq!(d.text(), "a|nil|true|false|x");
    // sleep-for goes on after its time, in the buffer it started in.
    d.press("C-c z");
    assert_eq!(d.text(), "a|nil|true|false|x");
    advance(1);
    assert_eq!(d.text(), "a|nil|true|false|xslept|");
}

#[test]
fn c_x_8_types_characters_through_key_translation_map() {
    let (mut ed, s) = setup();
    ed.press("C-x 8").unwrap();
    assert_eq!(ed.echo(), Some("C-x 8-"));
    ed.press("' e").unwrap();
    ed.press("C-x 8 \" u C-x 8 * SPC C-x 8 E").unwrap();
    assert_eq!(text(&ed), "éü\u{a0}€");
    // C-x is still a prefix of its own.
    ed.press("C-x h C-w").unwrap();
    assert_eq!(text(&ed), "");
    // In the minibuffer too, as Emacs translates every key sequence read.
    ed.press("M-x").unwrap();
    ed.press("C-x 8 ' a").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "e8.minibufferContents()").unwrap(), r#""á""#);
}

#[test]
fn keys_bound_to_keys_are_typed_and_input_decode_map_translates_first() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"
        e8.bindKey("C-c m", ["a", "C-a", "b"]);
        e8.defineKey("input-decode-map", "<f5>", ["C-c", "m"]);
        e8.defineKey("key-translation-map", "C-c q", e8.defun("test-translate", () => "Q"));
        "#
        .into(),
    )
    .unwrap();
    ed.press("C-c m").unwrap();
    assert_eq!(text(&ed), "ba");
    ed.press("C-e <f5>").unwrap();
    assert_eq!(text(&ed), "bbaa");
    ed.press("C-e C-c q").unwrap();
    assert_eq!(text(&ed), "bbaaQ");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(e8.lookupKey('global-map', 'C-c m'))").unwrap(), r#""[\"a\",\"C-a\",\"b\"]""#);
}

#[test]
fn c_q_reads_a_character_or_its_octal_code() {
    let (mut ed, _s) = setup();
    // 101 is A, ended by RET; 142 is b, ended by x, which is typed itself.
    ed.press("C-q 1 0 1 RET C-q 1 4 2 x C-q C-a").unwrap();
    assert_eq!(text(&ed), "Abx\u{1}");
    // C-S-DEL kills the whole line, as C-S-<backspace> does in Emacs.
    ed.press("C-S-DEL").unwrap();
    assert_eq!(text(&ed), "");
}

#[test]
fn the_idle_time_is_nil_while_a_key_is_handled_and_seconds_once_it_is_not() {
    let (mut ed, s) = setup();
    // A command sees nil while it runs, as Emacs's does.
    s.eval_expression(
        &mut ed,
        r#"e8.bindKey("C-c i", e8.defineCommand({ name: "test-idle", run: () => e8.insert(`${e8.currentIdleTime() ?? "nil"}`) }))"#,
    )
    .unwrap();
    ed.press("C-c i").unwrap();
    assert_eq!(text(&ed), "nil");
    // Between keys it is a number of seconds, as run-with-idle-timer counts them.
    let idle = s.eval_expression(&mut ed, "typeof e8.currentIdleTime()").unwrap();
    assert_eq!(idle, r#""number""#);
    assert_eq!(s.eval_expression(&mut ed, "e8.currentIdleTime() >= 0").unwrap(), "true");
}

#[test]
fn this_commands_keys_are_cleared_and_set_as_emacs_sets_them() {
    let (mut ed, s) = setup();
    ed.press("C-c").unwrap();
    ed.press("k").unwrap();
    let eval = |ed: &mut Editor, code: &str| value(ed, &s, code);
    assert_eq!(eval(&mut ed, "e8.recentKeys().length > 0"), "true");
    // Keeping the record leaves the keys typed lately; not keeping it forgets them.
    eval(&mut ed, "e8.clearThisCommandKeys(true)");
    assert_eq!(eval(&mut ed, "JSON.stringify([e8.thisCommandKeys(), e8.recentKeys().length > 0])"), r#"["",true]"#);
    eval(&mut ed, "e8.clearThisCommandKeys()");
    assert_eq!(eval(&mut ed, "JSON.stringify([e8.thisCommandKeys(), e8.recentKeys().length])"), r#"["",0]"#);
    eval(&mut ed, r#"e8.setThisCommandKeys("C-x C-f")"#);
    assert_eq!(eval(&mut ed, "JSON.stringify([e8.thisCommandKeys(), e8.thisCommandKeysVector()])"), r#"["C-x C-f",["C-x","C-f"]]"#);
}

#[test]
fn the_input_mode_is_what_e8_does_and_keeps_what_it_is_given() {
    let (mut ed, s) = setup();
    let eval = |ed: &mut Editor, code: &str| value(ed, &s, code);
    // Emacs on a terminal: (t nil t 7).
    assert_eq!(eval(&mut ed, "JSON.stringify(e8.currentInputMode())"), "[true,false,true,7]");
    eval(&mut ed, "e8.setQuitChar(3)");
    eval(&mut ed, "e8.setOutputFlowControl(true)");
    eval(&mut ed, "e8.setInputMetaMode(null)");
    assert_eq!(eval(&mut ed, "JSON.stringify(e8.currentInputMode())"), "[true,true,null,3]");
    eval(&mut ed, "e8.setInputMode(false, false, 'encoded', 7)");
    assert_eq!(eval(&mut ed, "JSON.stringify(e8.currentInputMode())"), r#"[false,false,"encoded",7]"#);
}

#[test]
fn a_character_takes_a_modifier_into_itself_as_emacs_resolves_it() {
    let (mut ed, s) = setup();
    let got = value(
        &mut ed,
        &s,
        r#"JSON.stringify([
             0x20 | (1 << 26), 0x20 | (1 << 25), 0x20 | (1 << 26) | (1 << 27),
             0x09 | (1 << 25), 0x31 | (1 << 25), 0x00 | (1 << 25),
             0x20 | (1 << 23) | (1 << 25), 0x20 | (1 << 26) | (1 << 25),
             0x61 | (1 << 26), 0x3f | (1 << 26), 0x5b | (1 << 26),
             0x61, 0x41 | (1 << 25), 0x61 | (1 << 25), 0x61 | (1 << 27),
             0x61 | (1 << 26) | (1 << 25), 0xe9 | (1 << 26), 0xe9 | (1 << 25),
             0x40 | (1 << 26), 0x30 | (1 << 26),
           ].map(e8.charResolveModifiers))"#,
    );
    // Every one checked against GNU Emacs 30.2's char-resolve-modifiers:
    // C-SPC is 0, S-SPC is a space, Shift goes from a control character,
    // C-a is 1, C-? is 127, C-[ is 27, a letter upcases, and a character
    // that is no ASCII one keeps its modifiers.
    assert_eq!(
        got,
        "[0,32,134217728,9,33554481,0,8388640,0,1,127,27,97,65,65,134217825,1,67109097,33554665,0,67108912]"
    );
}

#[test]
fn every_key_typed_goes_to_the_dribble_file() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("keys.txt");
    value(&mut ed, &s, &format!("e8.openDribbleFile({:?})", path.display().to_string()));
    ed.press("C-c").unwrap();
    ed.press("k").unwrap();
    ed.press("a").unwrap();
    // A plain character as itself, anything else in angle brackets, where
    // Emacs writes a character's byte and a symbol's name.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "<C-c>ka");
    // Closing it leaves what was written and takes no more.
    value(&mut ed, &s, "e8.openDribbleFile()");
    ed.press("b").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "<C-c>ka");
}

#[test]
fn an_error_the_command_loop_did_not_handle_is_reported_as_emacs_reports_it() {
    let (mut ed, s) = setup();
    s.eval_expression(&mut ed, r#"e8.commandErrorDefaultFunction("boom", "In foo: ")"#).unwrap();
    assert_eq!(ed.echo(), Some("In foo: boom"));
    // A focus-in event wants a frame; anything else is an error.
    assert!(s.eval_expression(&mut ed, r#"e8.internalHandleFocusIn(["focus-in"])"#).is_err());
    s.eval_expression(&mut ed, r#"e8.internalHandleFocusIn(["focus-in", e8.selectedFrame()])"#).unwrap();
}
