//! Headless tests: load TypeScript into an editor, then drive it with keys.

use std::fs;
use std::time::{Duration, Instant};

use e8_core::{Arg, Editor};
use e8_script::{Scripting, type_definitions};

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting
        .eval_typescript(ed, "test.ts", source.to_string())
        .unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn defines_a_command_and_binds_a_key() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const greet = e8.defineCommand({
          name: "insert-greeting",
          doc: "Insert a friendly greeting.",
          run: () => {
            const who: string = "world";
            e8.insert(`hello, ${who}`);
          },
        });
        e8.bindKey("C-c g", greet);
        "#,
    );
    ed.press("C-c g").unwrap();
    assert_eq!(text(&ed), "hello, world");
    // Like any command, it is one undo step and has documentation.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "");
    ed.press("C-h k C-c g").unwrap();
    // Help shows in another window, as in Emacs.
    let help = ed.buffers().iter().find(|b| b.name == "*Help*").expect("a *Help* buffer");
    let help = help.slice(0..help.len());
    assert!(help.contains("C-c g runs the command insert-greeting."), "{help}");
    assert!(help.contains("Insert a friendly greeting."));
    assert_eq!(ed.window_list().len(), 2);
}

#[test]
fn parameters_are_read_from_the_minibuffer() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({
          name: "surround",
          params: [
            { name: "before", prompt: "Before: " },
            { name: "after", prompt: "After: " },
          ],
          run: (before, after) => {
            e8.gotoChar(0);
            e8.insert(before);
            e8.call("end-of-buffer");
            e8.insert(after);
          },
        });
        "#,
    );
    ed.type_text("text");
    ed.press("M-x").unwrap();
    ed.type_text("surround\n");
    assert_eq!(ed.prompt(), Some("Before: "));
    ed.type_text("<\n");
    assert_eq!(ed.prompt(), Some("After: "));
    ed.type_text(">\n");
    assert_eq!(text(&ed), "<text>");

    // The same command called from code takes its arguments directly.
    ed.call("surround", vec![Arg::Str("[".into()), Arg::Str("]".into())]).unwrap();
    assert_eq!(text(&ed), "[<text>]");
}

#[test]
fn script_commands_can_call_each_other() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({ name: "inner", run: () => e8.insert("inner ") });
        e8.defineCommand({
          name: "outer",
          run: () => {
            e8.call("inner" as any);
            e8.call("execute-extended-command", "inner");
            e8.insert("outer");
          },
        });
        "#,
    );
    ed.call("outer", vec![]).unwrap();
    assert_eq!(text(&ed), "inner inner outer");
}

#[test]
fn errors_become_messages() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({ name: "fail", run: () => { throw new Error("Nothing to do here"); } });
        e8.defineCommand({ name: "past-end", run: () => e8.call("forward-char") });
        e8.defineCommand({
          name: "buggy",
          run: () => {
            const value: any = undefined;
            value.missing();
          },
        });
        "#,
    );
    ed.press("M-x").unwrap();
    ed.type_text("fail\n");
    assert_eq!(ed.echo(), Some("Nothing to do here"));

    // An editor error raised inside a script surfaces with its own message.
    let err = ed.call("past-end", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "End of buffer");

    // Bugs in the script say what and where, at the line in the TypeScript source.
    let err = ed.call("buggy", vec![]).unwrap_err().to_string();
    assert!(err.starts_with("TypeError: "), "{err}");
    assert!(err.contains("(test.ts:8:"), "{err}");
}

#[test]
fn load_errors_report_typescript_locations() {
    let (mut ed, scripting) = setup();
    let err = scripting
        .eval_typescript(&mut ed, "init.ts", "let a: number = 1;\nlet b = ;\n".into())
        .unwrap_err();
    assert!(err.to_string().starts_with("init.ts:2:"), "{err}");

    let source = "interface Point {\n  x: number;\n}\nconst p: Point = { x: 1 };\nnotDefined(p);\n";
    let err = scripting
        .eval_typescript(&mut ed, "init.ts", source.into())
        .unwrap_err();
    assert!(err.to_string().starts_with("init.ts:5:"), "{err}");
    assert!(err.to_string().contains("ReferenceError"), "{err}");

    let err = scripting
        .eval_typescript(&mut ed, "init.ts", "e8.bindKey(\"C-c M-\", \"undo\");".into())
        .unwrap_err();
    assert!(err.to_string().contains("Invalid key sequence"), "{err}");
}

#[test]
fn runaway_scripts_are_stopped() {
    let (mut ed, scripting) = setup();
    eval(&mut ed, &scripting, r#"e8.defineCommand({ name: "spin", run: () => { for (;;) {} } });"#);
    scripting.set_time_limit(Duration::from_millis(100));
    let start = Instant::now();
    let err = ed.call("spin", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Script stopped after running for 100ms");
    assert!(start.elapsed() < Duration::from_secs(2));
    // The editor still works afterwards.
    eval(&mut ed, &scripting, r#"e8.insert("still alive");"#);
    assert_eq!(text(&ed), "still alive");
}

#[test]
fn load_file_records_the_source_and_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let init = dir.path().join("init.ts");
    fs::write(&init, r#"e8.defineCommand({ name: "hi", run: () => e8.insert("v1") });"#).unwrap();
    let (mut ed, scripting) = setup();
    scripting.load_file(&mut ed, &init).unwrap();
    ed.call("hi", vec![]).unwrap();
    let describe = ed.command("hi").unwrap();
    assert_eq!(describe.source.as_deref(), Some(init.display().to_string().as_str()));

    // Editing the file and running load-file replaces the command in the running editor.
    fs::write(&init, r#"e8.defineCommand({ name: "hi", run: () => e8.insert(" v2") });"#).unwrap();
    ed.call("load-file", vec![Arg::Str(init.display().to_string())]).unwrap();
    ed.call("hi", vec![]).unwrap();
    assert_eq!(text(&ed), "v1 v2");
}

#[test]
fn eval_expression_shows_values() {
    let (mut ed, _scripting) = setup();
    ed.type_text("abc");
    ed.press("M-:").unwrap();
    ed.type_text("e8.bufferText().toUpperCase()\n");
    assert_eq!(ed.echo(), Some("\"ABC\""));
    ed.press("M-:").unwrap();
    ed.type_text("[1, 2].map((n: number) => n * 2)\n");
    assert_eq!(ed.echo(), Some("[2,4]"));
    ed.press("M-:").unwrap();
    ed.type_text("console.log(\"hi\")\n");
    assert_eq!(ed.echo(), Some("undefined"));
}

#[test]
fn type_definitions_include_script_commands() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"e8.defineCommand({ name: "insert-date", doc: "Insert today's date.", params: [{ name: "date-format" }], run: () => {} });"#,
    );
    let dts = type_definitions(&ed);
    assert!(dts.contains("\"insert-date\": [dateFormat: string];"), "{dts}");
    assert!(dts.contains("\"load-file\": [file: string];"));
    assert!(dts.contains("Insert today's date."));
}

#[test]
fn reloading_a_file_with_top_level_constants() {
    let dir = tempfile::tempdir().unwrap();
    let init = dir.path().join("init.ts");
    fs::write(&init, "const greet = e8.defineCommand({ name: \"greet\", run: () => e8.insert(\"hi\") });\ne8.bindKey(\"C-c g\", greet);\n").unwrap();
    let (mut ed, scripting) = setup();
    scripting.load_file(&mut ed, &init).unwrap();
    scripting.load_file(&mut ed, &init).unwrap();
    ed.press("C-c g").unwrap();
    assert_eq!(text(&ed), "hi");
}

#[test]
fn prefix_arguments_come_from_simple_ts() {
    let (mut ed, _scripting) = setup();
    ed.type_text("abcdefgh");
    ed.press("C-a C-u 3").unwrap();
    assert_eq!(ed.echo(), Some("C-u 3-"));
    ed.press("C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 3);
    let command = ed.command("universal-argument").unwrap();
    assert_eq!(command.source.as_deref(), Some("packages/simple.ts"));

    // M-x hands its prefix argument to the command it runs; the oracle
    // cannot check this, because batch Emacs reads the minibuffer from stdin.
    ed.press("C-u 2 M-x").unwrap();
    ed.type_text("forward-char\n");
    assert_eq!(ed.window_buffer().point(), 5);
}

/// packages/e8.d.ts declares the API for E8's own packages, so tsc can
/// check them. It is generated; run `UPDATE_TYPES=1 cargo test -p e8-script`
/// after changing commands or the API, and commit the result.
#[test]
fn packages_type_definitions_are_current() {
    let (ed, _scripting) = setup();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/e8.d.ts");
    let generated = type_definitions(&ed);
    if std::env::var_os("UPDATE_TYPES").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    let committed = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == generated,
        "packages/e8.d.ts is out of date; run UPDATE_TYPES=1 cargo test -p e8-script"
    );
}

/// C-u F3 appends to the last macro after running it once more, as
/// kmacro-execute-before-append has it by default; batch Emacs runs the
/// macro at another time, so the oracle cannot record this one.
#[test]
fn c_u_f3_runs_the_last_macro_and_appends_to_it() {
    let (mut ed, _scripting) = setup();
    ed.press("<f3> a <f4> C-u <f3>").unwrap();
    assert_eq!(text(&ed), "aa");
    assert_eq!(ed.echo(), Some("Appending to kbd macro..."));
    ed.press("b <f4> <f4>").unwrap();
    assert_eq!(text(&ed), "aabab");
}

#[test]
fn macros_repeat_and_yank_pop_from_packages() {
    // C-x e e runs the macro again; batch Emacs cannot record this, so the
    // oracle does not cover it.
    let (mut ed, _scripting) = setup();
    ed.press("C-x ( a C-x ) C-x e e e").unwrap();
    assert_eq!(text(&ed), "aaaa");
    assert!(!ed.defining_kbd_macro());

    // The mode line's "Def" comes from this state.
    ed.press("<f3>").unwrap();
    assert!(ed.defining_kbd_macro());
    assert_eq!(ed.echo(), Some("Defining kbd macro..."));
    ed.press("<f4>").unwrap();
    assert_eq!(ed.echo(), Some("Keyboard macro defined"));

    // C-x z z repeats the last command twice more.
    let (mut ed, _scripting) = setup();
    ed.press("x C-x z z").unwrap();
    assert_eq!(text(&ed), "xxx");
}

#[test]
fn after_change_functions_see_each_change() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const seen: string[] = [];
        e8.addHook("after-change-functions", (beg: number, end: number, old: number) => {
          seen.push(`${beg}-${end}-${old}`);
        }, { local: true });
        e8.defineCommand({
          name: "edit-twice",
          run: () => {
            e8.insert("abc");
            e8.deleteRegion(0, 1);
            e8.setVariable("fill-column", seen.join(" "));
          },
        });
        "#,
    );
    ed.call("edit-twice", vec![]).unwrap();
    assert_eq!(text(&ed), "bc");
    // An insertion has an old length of 0; a deletion starts and ends where the text went.
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("0-3-0 0-0-1"));
}

#[test]
fn an_error_in_after_change_functions_removes_the_buffers_functions() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.addHook("after-change-functions", () => { throw new Error("no"); }, { local: true });
        e8.defineCommand({ name: "edit", run: () => e8.insert("x") });
        "#,
    );
    assert_eq!(ed.call("edit", vec![]).unwrap_err().to_string(), "no");
    // As in Emacs, the hook's buffer-local value is gone after the error.
    ed.call("edit", vec![]).unwrap();
    assert_eq!(text(&ed), "xx");
}

#[test]
fn insert_before_markers_moves_overlays_and_the_mark() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("ab");
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({
          name: "check-overlays",
          run: () => {
            const plain = e8.makeOverlay(1, 2);
            const advancing = e8.makeOverlay(1, 2, {}, { frontAdvance: true });
            const ending = e8.makeOverlay(0, 1);
            e8.setMark(1);
            e8.gotoChar(1);
            e8.insert("x");
            const afterInsert = [e8.overlayStart(plain), e8.overlayStart(advancing), e8.overlayEnd(ending), e8.mark()];
            e8.gotoChar(1);
            e8.insertBeforeMarkers("y");
            const afterBefore = [e8.overlayStart(plain), e8.overlayEnd(ending), e8.mark()];
            e8.setVariable("fill-column", `${afterInsert.join(",")} ${afterBefore.join(",")}`);
          },
        });
        "#,
    );
    ed.call("check-overlays", vec![]).unwrap();
    assert_eq!(text(&ed), "ayxb");
    // Inserting at 1: a plain overlay takes the text in, a front-advance one
    // does not, an overlay ending there does not grow, and the mark stays.
    // Inserting before markers moves them all past the text.
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("1,2,1,1 2,2,2"));
}

#[test]
fn buffers_can_be_marked_unmodified() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"e8.defineCommand({ name: "edit-then-unmark", run: () => { e8.insert("x"); e8.setBufferModified(false); } });"#,
    );
    ed.call("edit-then-unmark", vec![]).unwrap();
    assert!(!ed.window_buffer().is_modified());
}

#[test]
fn edits_can_leave_the_region_active() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({ name: "edit", run: () => e8.insert("x") });
        e8.defineCommand({ name: "edit-keeping-region", run: () => e8.keepMarkActive(() => e8.insert("x")) });
        "#,
    );
    ed.press("C-SPC").unwrap();
    ed.call("edit-keeping-region", vec![]).unwrap();
    assert!(ed.window_buffer().is_mark_active());
    ed.call("edit", vec![]).unwrap();
    assert!(!ed.window_buffer().is_mark_active());
}

#[test]
fn columns_count_as_emacs_counts_them() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("\tab\n日本語x");
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({
          name: "columns",
          run: () => {
            e8.gotoChar(2);
            const afterTab = e8.currentColumn();
            e8.gotoChar(4);
            // Into the wide characters: column 3 is inside the second, so point goes past it.
            const reached = e8.moveToColumn(3);
            e8.setVariable("fill-column", `${afterTab} ${reached} ${e8.point()}`);
          },
        });
        "#,
    );
    ed.call("columns", vec![]).unwrap();
    assert_eq!(ed.variable("fill-column").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("9 4 6"));
}

#[test]
fn a_command_can_share_its_undo_step_with_the_one_before() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.defineCommand({ name: "add-dot", run: () => { e8.undoAutoAmalgamate(); e8.insert("."); } });
        e8.bindKey("C-c d", "add-dot");
        "#,
    );
    ed.press("x C-c d C-c d C-c d").unwrap();
    assert_eq!(text(&ed), "x...");
    // The three runs undo together, but not with the typing before them.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "x");
}

#[test]
fn typing_with_a_count_is_an_undo_step_of_its_own() {
    let (mut ed, _scripting) = setup();
    ed.press("M-2 SPC 1 C-/").unwrap();
    assert_eq!(text(&ed), "  ");
}

#[test]
fn markers_move_with_the_text_and_come_back_with_undo() {
    let (mut ed, scripting) = setup();
    ed.type_text("one two three");
    ed.buffer_mut().undo_boundary();
    eval(
        &mut ed,
        &scripting,
        r#"
        const stays = e8.makeMarker(4);
        const advances = e8.makeMarker(4, { advances: true });
        e8.gotoChar(4);
        e8.insert("big ");
        e8.message(`${e8.markerPosition(stays)} ${e8.markerPosition(advances)} ${e8.markerBuffer(stays)}`);
        globalThis.inside = e8.makeMarker(9);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("4 8 *scratch*"));
    ed.buffer_mut().undo_boundary();
    // Deleting the text a marker is in takes it to the start; undo puts it back.
    eval(&mut ed, &scripting, "e8.deleteRegion(6, 12);");
    eval(&mut ed, &scripting, "e8.message(String(e8.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("6"));
    ed.press("C-/").unwrap();
    eval(&mut ed, &scripting, "e8.message(String(e8.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("9"));
    // A marker pointing nowhere has no position.
    eval(&mut ed, &scripting, "e8.setMarker(globalThis.inside, null); e8.message(String(e8.markerPosition(globalThis.inside)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("undefined"));
}

#[test]
fn subst_char_in_region_leaves_point_and_markers() {
    let (mut ed, scripting) = setup();
    ed.type_text("a\tb\tc");
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.gotoChar(2);
        const m = e8.makeMarker(4);
        e8.substCharInRegion(0, e8.bufferSize(), "\t", " ");
        e8.message(`${e8.point()} ${e8.markerPosition(m)}`);
        "#,
    );
    assert_eq!(text(&ed), "a b c");
    assert_eq!(ed.messages().last().map(String::as_str), Some("2 4"));
}

#[test]
fn undo_puts_an_advancing_marker_back_and_markers_outlive_their_buffers() {
    let (mut ed, scripting) = setup();
    ed.type_text("abcdef");
    ed.buffer_mut().undo_boundary();
    eval(&mut ed, &scripting, "globalThis.m = e8.makeMarker(3, { advances: true }); e8.deleteRegion(1, 5);");
    ed.press("C-/").unwrap();
    eval(&mut ed, &scripting, "e8.message(String(e8.markerPosition(globalThis.m)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("3"));
    // Sent nowhere, and back.
    eval(&mut ed, &scripting, "e8.setMarker(globalThis.m, null); e8.setMarker(globalThis.m, 2, '*scratch*'); e8.message(String(e8.markerPosition(globalThis.m)));");
    assert_eq!(ed.messages().last().map(String::as_str), Some("2"));
}

#[test]
fn a_cancelled_change_group_leaves_no_trace_across_undo_boundaries() {
    let (mut ed, scripting) = setup();
    ed.type_text("abc");
    ed.buffer_mut().undo_boundary();
    ed.buffer_mut().set_modified(false);
    eval(&mut ed, &scripting, "globalThis.g = e8.prepareChangeGroup(); e8.insert('XYZ');");
    ed.buffer_mut().undo_boundary();
    eval(&mut ed, &scripting, "e8.cancelChangeGroup(globalThis.g);");
    assert_eq!(text(&ed), "abc");
    assert!(!ed.buffer().is_modified(), "unmodified again");
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "", "undo goes to before the typing, without panicking");
}

/// A panic in a native, or in the core under it, is an error the script
/// sees, on either engine, rather than an abort (V8's callbacks cannot
/// unwind) or a panic escaping the script.
#[test]
fn a_panic_in_a_native_is_an_error_the_script_sees() {
    let (mut ed, scripting) = setup();
    ed.define_command(e8_core::Command::new("break", "Panics partway.", |_, _| panic!("partway")));
    let got = scripting
        .eval_expression(&mut ed, r#"(() => { try { e8.call("break"); return "ran on"; } catch (e) { return e.message; } })()"#)
        .unwrap();
    assert_eq!(got, r#""Internal error: partway""#);
    // The editor goes on, its command loop as it was: two calls from
    // outside are still an undo step each, as they would not be if it
    // still thought the broken command was running.
    assert_eq!(scripting.eval_expression(&mut ed, "1 + 1").unwrap(), "2");
    ed.define_command(e8_core::Command::new("put-a", "Inserts a.", |ed, _| ed.insert("a")));
    ed.define_command(e8_core::Command::new("put-b", "Inserts b.", |ed, _| ed.insert("b")));
    ed.call("put-a", vec![]).unwrap();
    ed.call("put-b", vec![]).unwrap();
    ed.press("C-/").unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "a");
}

#[test]
fn errors_carry_their_conditions_both_ways() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        const seen: string[] = [];
        // From the editor: a search that fails, a file that is not there.
        seen.push(e8.conditionCase(() => { e8.call("search-forward", "nowhere"); return "found"; }, { "search-failed": (e) => `${e.symbol} ${e.data[0]}` }));
        seen.push(e8.conditionCase(() => e8.readTextFile("/no/such/file"), { "file-error": (e) => e.symbol }));
        // From scripts, with conditions of their own.
        e8.defineError("my-error", "user-error");
        seen.push(e8.conditionCase(() => e8.signal("my-error", "mine", [1]), { "user-error": (e) => `${e.symbol} ${e.data[0]} ${e.message}` }));
        seen.push(String(e8.ignoreErrors(() => e8.userError("no"))));
        e8.message(seen.join("|"));
        e8.defineCommand({ name: "fail-with-condition", run: () => e8.signal("my-error", "it failed") });
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("search-failed nowhere|file-missing|my-error 1 mine|undefined"));
    // A script's condition reaches the core.
    let e = ed.call("fail-with-condition", vec![]).unwrap_err();
    assert_eq!((e.symbol(), e.message()), ("my-error", "it failed"));
    assert!(e.is("user-error"));
}

#[test]
fn let_bind_restores_where_it_bound() {
    let (mut ed, scripting) = setup();
    eval(
        &mut ed,
        &scripting,
        r#"
        e8.getBufferCreate("other");
        e8.makeLocalVariable("fill-column");
        e8.setVariable("fill-column", 40);
        const inside = e8.letBind({ "fill-column": 10, "case-fold-search": false }, () => {
          // Bound in this buffer; the other buffer sees the default.
          const other = e8.withCurrentBuffer("other", () => e8.variable("fill-column"));
          e8.call("switch-to-buffer", "other");
          return `${e8.withCurrentBuffer("*scratch*", () => e8.variable("fill-column"))} ${other} ${e8.variable("case-fold-search")}`;
        });
        let thrown = "";
        try {
          e8.letBind({ "case-fold-search": false }, () => { throw new Error("out"); });
        } catch (e) {
          thrown = `${(e as Error).message} ${e8.variable("case-fold-search")}`;
        }
        e8.message(`${inside} | ${e8.withCurrentBuffer("*scratch*", () => e8.variable("fill-column"))} ${e8.variable("case-fold-search")} | ${thrown}`);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("10 70 false | 40 true | out true"));
}

#[test]
fn emacs_regexps_match_as_in_emacs() {
    let (mut ed, scripting) = setup();
    ed.type_text("foo(bar) [x]\nnext line");
    eval(
        &mut ed,
        &scripting,
        r#"
        const r: string[] = [];
        const t = (re: string, s: string) => r.push(String(e8.emacsRegexp(re).test(s)));
        t("\\.te?xt\\'", "a.txt");      // \' is the end of the string
        t("\\.te?xt\\'", "a.txt~");
        t("\\`\\.\\.?\\'\\|\\`\\.?#", "..");
        t("(a|b)", "(a|b)");            // plain parens and bars are literal
        t("\\(a\\|b\\)c", "bc");
        t("[[:digit:]]+x", "12x");
        t("[\\]", "\\");                 // backslash is literal in brackets
        t("\\<bar\\>", "foo bar baz");
        e8.gotoChar(0);
        r.push(String(e8.lookingAt("foo(\\(\\w+\\)")), e8.matchString(1) ?? "");
        r.push(String(e8.lookingAt("bar")));
        e8.reSearchForward("\\[\\(.\\)\\]");
        r.push(String(e8.point()), e8.matchString(1) ?? "");
        r.push(e8.conditionCase(() => String(e8.reSearchForward("nowhere")), { "search-failed": (e) => e.symbol }));
        e8.message(r.join(" "));
        "#,
    );
    assert_eq!(
        ed.messages().last().map(String::as_str),
        Some("true false true true true true true true true bar false 12 x search-failed")
    );
}

/// The script API's names, as CLAUDE.md's naming rule gives them: Emacs's
/// name in camelCase, -p as P, and each function the prelude defines is
/// declared for scripts, and each declared one defined.
#[test]
fn the_api_defined_is_the_api_declared() {
    let (mut ed, scripting) = setup();
    let defined = scripting.eval_expression(&mut ed, "Object.keys(e8).sort()").unwrap();
    let defined: Vec<String> = serde_json::from_str(&defined).unwrap();
    let dts = type_definitions(&ed);
    let declared: std::collections::BTreeSet<String> = dts
        .lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("    function ").or_else(|| l.strip_prefix("    class "))?;
            Some(rest.split(|c: char| !c.is_alphanumeric() && c != '_').next()?.to_string())
        })
        .collect();
    let undeclared: Vec<&String> = defined.iter().filter(|n| !declared.contains(*n)).collect();
    assert!(undeclared.is_empty(), "defined but not declared in types.rs: {undeclared:?}");
    let missing: Vec<&String> = declared.iter().filter(|n| !defined.contains(n)).collect();
    assert!(missing.is_empty(), "declared in types.rs but not defined in prelude.js: {missing:?}");
    for name in &defined {
        assert!(!name.contains(['-', '_']), "{name} is not camelCase");
    }
}

/// The engines agree where they used to differ: an integer out of range is
/// refused, a prefix list must hold a number, an object thrown with a
/// message keeps its condition, and a frozen function can still be a hook.
#[test]
fn the_engines_agree_on_the_corners() {
    let (mut ed, scripting) = setup();
    let caught = |ed: &mut Editor, js: &str| {
        scripting.eval_expression(ed, &format!("(() => {{ try {{ {js}; return 'ran'; }} catch (e) {{ return String(e.message ?? e); }} }})()")).unwrap()
    };
    assert!(caught(&mut ed, "e8.gotoChar(-1)").contains("Underflow"), "a position below 0");
    assert!(caught(&mut ed, r#"e8.callWithPrefix(["x"], "forward-char")"#).contains("prefix argument"));
    let escaped = scripting.eval_expression(&mut ed, r#"(() => { throw { message: "custom", symbol: "user-error", data: [] }; })()"#).unwrap_err();
    assert_eq!((escaped.symbol(), escaped.message()), ("user-error", "custom"));
    let got = scripting
        .eval_expression(&mut ed, r#"(() => { const f = Object.freeze(() => {}); e8.addHook("after-change-functions", f); e8.removeHook("after-change-functions", f); return "ok"; })()"#)
        .unwrap();
    assert_eq!(got, r#""ok""#);
}

/// An editor function a script holds keeps working when the engine forgets
/// the others it gave out, once they are collected.
#[test]
fn editor_functions_a_script_holds_survive_collection() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_expression(&mut ed, r#"(globalThis.kept = e8.symbolFunction("forward-char"), [...Array(50)].forEach(() => e8.symbolFunction("forward-char")), e8.garbageCollect(), 0)"#)
        .unwrap();
    let got = scripting.eval_expression(&mut ed, r#"(e8.insert("ab"), e8.gotoChar(0), globalThis.kept(), e8.point())"#).unwrap();
    assert_eq!(got, "1");
}

/// Engines started after the first in a process run the shipped packages as
/// the first did: on QuickJS they read the bytecode the second compiled
/// rather than compiling, so a function's source, an error's place in a
/// package and a library package required must come out the same.
#[test]
fn later_engines_in_a_process_run_the_packages_alike() {
    let probe = r#"(() => {
        const source = String(e8.symbolFunction("org-toggle-tag")).slice(0, 80);
        let place = "";
        try {
            e8.symbolFunction("org-toggle-tag")(Symbol("no-such-tag"), Symbol("bogus"));
        } catch (e) {
            place = String(e && e.stack || e).split("\n").find((l) => l.includes("packages/")) ?? "";
        }
        e8.require("org-tempo");
        return [source, place, e8.boundp("org-tempo-keywords-alist")];
    })()"#;
    let runs: Vec<String> = (0..3)
        .map(|_| {
            let (mut ed, scripting) = setup();
            scripting.eval_expression(&mut ed, probe).unwrap()
        })
        .collect();
    assert!(runs[0].contains("(tag") && runs[0].contains("packages/org.ts:") && runs[0].ends_with("true]"), "{}", runs[0]);
    assert_eq!(runs[1], runs[0]);
    assert_eq!(runs[2], runs[0]);
}
