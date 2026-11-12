//! Windows: splitting, selecting and deleting them, each with its own point.

use e8_core::Editor;
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

/// Each window's buffer name and point, in cyclic order, with the selected one marked.
fn windows(ed: &Editor) -> Vec<(String, usize, bool)> {
    ed.windows().iter().map(|w| (w.buffer.name.clone(), w.point, w.selected)).collect()
}

#[test]
fn split_windows_keep_their_own_points() {
    let (mut ed, _scripting) = setup("one\ntwo\nthree\n");
    ed.press("C-x 2").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true), ("*scratch*".into(), 0, false)]);
    ed.press("C-n C-n").unwrap();
    assert_eq!(point(&ed), 8);
    ed.press("C-x o").unwrap();
    assert_eq!(point(&ed), 0, "the other window's point did not move");
    assert_eq!(windows(&ed), [("*scratch*".into(), 8, false), ("*scratch*".into(), 0, true)]);
    ed.press("C-x o").unwrap();
    assert_eq!(point(&ed), 8);
}

#[test]
fn edits_move_other_windows_points() {
    let (mut ed, _scripting) = setup("abc");
    ed.press("M-> C-x 2 M-<").unwrap();
    ed.type_text("xy");
    assert_eq!(windows(&ed)[1].1, 5, "the other window's point stays after the text it was after");
    ed.press("M-< C-d C-d").unwrap();
    assert_eq!(windows(&ed)[1].1, 3);
}

#[test]
fn windows_show_different_buffers() {
    let (mut ed, _scripting) = setup("scratch text");
    ed.press("C-x 3 C-x b").unwrap();
    ed.type_text("notes\n");
    ed.type_text("note text");
    assert_eq!(windows(&ed), [("notes".into(), 9, true), ("*scratch*".into(), 0, false)]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "*scratch*");
    ed.press("C-e").unwrap();
    assert_eq!(point(&ed), 12);
    // Rows of a window that is not selected come from its own buffer.
    let rows = ed.rows_of_window(ed.window_list()[0], 1, true);
    assert_eq!(rows[0].segments[0].text, "note text");
}

#[test]
fn other_window_counts_and_goes_back() {
    let (mut ed, _scripting) = setup("");
    ed.press("C-x 2 C-x 3").unwrap();
    let list = ed.window_list();
    assert_eq!(list.len(), 3);
    assert_eq!(ed.selected_window(), list[0]);
    ed.press("C-u 2 C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[2]);
    ed.press("C-- C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[1]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[2]);
    ed.press("C-x o").unwrap();
    assert_eq!(ed.selected_window(), list[0], "cycles round");
}

#[test]
fn deleting_windows() {
    let (mut ed, _scripting) = setup("text");
    let err = ed.call("delete-window", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Attempt to delete minibuffer or sole ordinary window");
    ed.press("C-x 2 C-x 3").unwrap();
    let list = ed.window_list();
    // Deleting the selected window selects the one used most recently.
    ed.press("C-x o C-x o C-x 0").unwrap();
    assert_eq!(ed.window_list(), [list[0], list[1]]);
    assert_eq!(ed.selected_window(), list[1]);
    ed.press("C-x 3 C-x 1").unwrap();
    assert_eq!(ed.window_list(), [list[1]]);
    // One window again: the next split halves it.
    ed.press("C-x 2").unwrap();
    assert_eq!(ed.window_list().len(), 2);
}

#[test]
fn small_windows_do_not_split() {
    let (mut ed, _scripting) = setup("");
    // As Emacs 30: six lines with the mode line cannot be split, seven
    // can, the new window taking three, less than window-min-height, as
    // window--sanitize-window-sizes finds none to give it.
    ed.set_viewport_height(5);
    let err = ed.call("split-window-below", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Window #<window 1 on *scratch*> too small for splitting");
    ed.set_viewport_height(6);
    ed.call("split-window-below", vec![]).unwrap();
    assert_eq!(ed.viewport_height(), 3, "the four lines the old window keeps, less the mode line");
}

#[test]
fn killing_a_buffer_replaces_it_in_other_windows() {
    let (mut ed, _scripting) = setup("scratch");
    ed.press("C-x 2 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x o C-x b").unwrap();
    ed.type_text("other\n");
    assert_eq!(windows(&ed).iter().map(|w| w.0.as_str()).collect::<Vec<_>>(), ["other", "other"]);
    ed.press("C-x k").unwrap();
    ed.type_text("\n");
    let names: Vec<_> = windows(&ed).into_iter().map(|w| w.0).collect();
    assert_eq!(names, ["*scratch*", "*scratch*"]);
}

#[test]
fn scripts_split_and_select_windows() {
    let (mut ed, scripting) = setup("");
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const first = e8.selectedWindow();
            const second = e8.splitWindow(undefined, "right");
            e8.selectWindow(second);
            e8.message(`${e8.windowList().map((w) => w.id).join(",")} ${e8.selectedWindow() === second} ${e8.windowBuffer(first)}`);
            "#
            .to_string(),
        )
        .unwrap();
    // The internal window the split makes is numbered before the new window, as in Emacs.
    assert_eq!(ed.echo(), Some("1,3 true *scratch*"));
}

/// Each window's total height, mode line included, in cyclic order.
fn heights(ed: &Editor) -> Vec<usize> {
    let sizes = ed.window_total_sizes();
    ed.window_list().iter().map(|id| sizes.iter().find(|s| s.0 == *id).map_or(0, |s| s.2)).collect()
}

#[test]
fn windows_resize_and_shrink_to_fit_their_buffer() {
    let (mut ed, _scripting) = setup("one\ntwo\n");
    ed.set_frame_size(80, 23);
    ed.press("C-x 2 C-u 3 C-x ^").unwrap();
    assert_eq!(heights(&ed), [15, 8]);
    // Three lines of text, counting the empty last one, and the mode line.
    ed.press("C-x -").unwrap();
    assert_eq!(heights(&ed), [4, 19]);
    ed.press("C-x +").unwrap();
    assert_eq!(heights(&ed), [12, 11]);
    // The text lines each window has to show follow its size.
    assert_eq!(ed.window_size(ed.selected_window()), Some((80, 11)));
}

#[test]
fn help_pops_up_a_window_that_q_takes_away() {
    let (mut ed, _scripting) = setup("one\n");
    ed.set_frame_size(80, 23);
    ed.press("C-h b").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true), ("*Help*".into(), 0, false)]);
    ed.press("C-x o q").unwrap();
    assert_eq!(windows(&ed), [("*scratch*".into(), 0, true)]);
}

/// The frames, as their selected window's buffer and point, newest first,
/// with the selected frame's position in that list.
fn frames(ed: &Editor) -> (Vec<(String, usize)>, usize) {
    let list = ed.frame_list();
    let shown = list
        .iter()
        .map(|&f| {
            let views = ed.frame_windows(f);
            let view = views.iter().find(|v| v.selected).unwrap_or(&views[0]);
            (view.buffer.name.clone(), view.point)
        })
        .collect();
    (shown, list.iter().position(|&f| f == ed.selected_frame()).unwrap())
}

// As GUI Emacs does, checked by hand, since batch Emacs cannot make frames.
#[test]
fn frames_each_have_their_own_windows() {
    let (mut ed, _scripting) = setup("hello");
    ed.window_buffer_mut().name = "one".into();
    ed.window_buffer_mut().set_point(3);
    ed.press("C-x 5 2").unwrap();
    assert_eq!(frames(&ed), (vec![("one".into(), 3), ("one".into(), 3)], 0), "the new frame comes first and is selected");
    ed.press("C-f C-f").unwrap();
    ed.press("C-x 5 o").unwrap();
    assert_eq!(frames(&ed), (vec![("one".into(), 5), ("one".into(), 3)], 1), "each frame keeps its own point");
    assert_eq!(point(&ed), 3);
    ed.press("C-x 5 b").unwrap();
    ed.type_text("two\n");
    assert_eq!(frames(&ed).1, 0);
    assert_eq!(frames(&ed).0.len(), 3);
    assert_eq!(ed.window_buffer().name, "two");
    // Windows split in one frame stay in it.
    ed.press("C-x 2").unwrap();
    assert_eq!(ed.window_list().len(), 2);
    ed.press("C-x 5 o").unwrap();
    assert_eq!(ed.window_list().len(), 1);
    ed.press("C-x 5 1").unwrap();
    assert_eq!(ed.frame_list().len(), 1);
    ed.press("C-x 5 0").unwrap();
    assert_eq!(ed.echo(), Some("Attempt to delete the sole visible or iconified frame"));
}

#[test]
fn deleting_the_selected_frame_selects_the_next() {
    let (mut ed, _scripting) = setup("abc");
    ed.press("C-x 5 2 C-x 2 C-x 5 0").unwrap();
    assert_eq!(ed.frame_list().len(), 1);
    assert_eq!(ed.window_list().len(), 1, "the deleted frame's windows went with it");
    // Killing a buffer shown in another frame shows another buffer there.
    ed.press("C-x 5 2 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x 5 o C-x k").unwrap();
    ed.type_text("other\n");
    let other = ed.frame_list()[0];
    assert_eq!(ed.frame_windows(other)[0].buffer.name, "*scratch*");
}

#[test]
fn code_in_another_buffer_can_change_what_windows_show() {
    let mut ed = e8_core::Editor::new();
    let scripting = e8_script::Scripting::new(&mut ed).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            e8.getBufferCreate("other");
            e8.getBufferCreate("shown");
            // As with-current-buffer around switch-to-buffer: the window
            // keeps what was switched to, and the current buffer comes back.
            e8.withCurrentBuffer("other", () => e8.call("switch-to-buffer", "shown"));
            e8.message(`${e8.windowBuffer()} ${e8.bufferName()}`);
            "#
            .into(),
        )
        .unwrap();
    assert_eq!(ed.messages().last().map(String::as_str), Some("shown *scratch*"));
    // The next key acts on the buffer the window shows.
    ed.type_text("x");
    let b = ed.window_buffer();
    assert_eq!((b.name.as_str(), b.slice(0..b.len()).as_str()), ("shown", "x"));
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn a_window_configuration_puts_the_windows_back() {
    let (mut ed, s) = setup("one\ntwo\nthree\nfour\n");
    ed.set_frame_size(80, 24);
    ed.press("C-x 2 C-x o C-n C-n C-x o").unwrap();
    eval(&mut ed, &s, r#"(globalThis.saved = e8.currentWindowConfiguration(), 0)"#);
    // Delete the windows, show another buffer, and type at the top.
    ed.press("C-x 1 C-x b").unwrap();
    ed.type_text("other\n");
    ed.press("C-x b RET M-<").unwrap();
    ed.type_text("zero\n");
    eval(&mut ed, &s, "(e8.setWindowConfiguration(saved), 0)");
    let got = windows(&ed);
    // The other window's point followed the text typed above it, as a
    // marker does; point in the buffer that was current is left where it
    // is, as Emacs leaves it.
    assert_eq!(got, [("*scratch*".into(), 5, true), ("*scratch*".into(), 13, false)]);
    assert_eq!(eval(&mut ed, &s, "e8.windowConfigurationP(saved)"), "true");
    // save-window-excursion puts them back however the code ends.
    s.eval_expression(&mut ed, r#"e8.saveWindowExcursion(() => { e8.call("delete-other-windows"); throw new Error("out"); })"#).unwrap_err();
    assert_eq!(windows(&ed).len(), 2);
}

#[test]
fn a_window_excursion_in_the_minibuffer_leaves_it_current() {
    let (mut ed, s) = setup("text");
    ed.press("M-x").unwrap();
    assert_eq!(eval(&mut ed, &s, "(e8.saveWindowExcursion(() => 0), e8.bufferName())"), "\" *Minibuf-1*\"");
    ed.type_text("x");
    assert_eq!(ed.minibuffer_input(), "x");
}

#[test]
fn a_configuration_of_a_deleted_frame_is_not_put_back() {
    let (mut ed, s) = setup("text");
    assert_eq!(
        eval(&mut ed, &s, "(e8.makeFrame(), globalThis.saved = e8.currentWindowConfiguration(), e8.deleteFrame(), String(e8.setWindowConfiguration(saved)))"),
        "\"undefined\""
    );
    assert_eq!(ed.frame_list().len(), 1);
}

#[test]
fn the_selected_windows_start_moves_with_text_above_it() {
    let text: String = (0..100).map(|i| format!("line {i}\n")).collect();
    let (mut ed, s) = setup(&text);
    ed.set_frame_size(80, 24);
    let start = |ed: &mut Editor| eval(ed, &s, "e8.windowStart()");
    // Line 62 first, with point in it.
    eval(&mut ed, &s, "(e8.gotoChar(500), e8.setWindowStart(undefined, 490), 0)");
    let before = start(&mut ed);
    eval(&mut ed, &s, r#"(e8.saveExcursion(() => { e8.gotoChar(0); e8.insert("a\nb\nc\n"); }), 0)"#);
    assert_eq!(start(&mut ed).parse::<usize>().unwrap(), before.parse::<usize>().unwrap() + 6);
    assert_eq!(ed.window_buffer().top_line, 65, "still showing the same line first");
}

#[test]
fn quitting_a_window_uses_its_quit_restore_parameter() {
    let (mut ed, s) = setup("text");
    ed.set_frame_size(80, 24);
    ed.press("C-h f").unwrap();
    ed.type_text("forward-char");
    ed.press("RET").unwrap();
    // The window selected then is the window itself, as Emacs's quit-restore holds it.
    assert_eq!(
        eval(&mut ed, &s, r#"(() => { const help = e8.windowList().find((w) => e8.windowBuffer(w) === "*Help*"); const [a, b, selected, buffer] = e8.windowParameter(help, "quit-restore"); return JSON.stringify([a, b, selected.id, buffer]); })()"#),
        r#""[\"window\",\"window\",1,\"*Help*\"]""#
    );
    ed.press("C-x o q").unwrap();
    assert_eq!(windows(&ed).len(), 1, "the window made for help went");
}

#[test]
fn a_dedicated_window_keeps_its_buffer() {
    let (mut ed, s) = setup("text");
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, "(e8.setWindowDedicatedP(undefined, true), 0)");
    // Typed, C-x b refuses, as switch-to-buffer-in-dedicated-window is nil
    // in Emacs, and so do C-x <left> and set-window-buffer.
    ed.press("C-x b").unwrap();
    ed.type_text("notes");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("Cannot switch buffers in a dedicated window"));
    ed.press("C-x <left>").unwrap();
    assert_eq!(ed.echo(), Some("Window is strongly dedicated to its buffer"));
    let err = s.eval_expression(&mut ed, r#"(e8.getBufferCreate("notes"), e8.setWindowBuffer(undefined, "notes"))"#).unwrap_err();
    assert!(err.to_string().contains("Window is dedicated to ‘*scratch*’"), "{err}");
    assert_eq!(windows(&ed).len(), 1);
    // From code, the buffer goes to another window.
    ed.call("switch-to-buffer", vec![e8_core::Arg::Str("notes".into())]).unwrap();
    let got = windows(&ed);
    assert_eq!(got.len(), 2);
    assert!(got.iter().any(|(b, _, _)| b == "*scratch*") && got.iter().any(|(b, _, selected)| b == "notes" && *selected));
    // Killing the buffer of a dedicated window deletes the window, selected or not.
    ed.kill_buffer("*scratch*").unwrap();
    assert_eq!(windows(&ed), [("notes".into(), 0, true)]);
    ed.press("C-x 2").unwrap();
    eval(&mut ed, &s, "(e8.setWindowDedicatedP(undefined, true), 0)");
    ed.kill_buffer("notes").unwrap();
    assert_eq!(windows(&ed).len(), 1);
    // The only window cannot go: it shows another buffer, and is dedicated no more.
    ed.switch_to_buffer("last");
    eval(&mut ed, &s, "(e8.setWindowDedicatedP(undefined, true), 0)");
    ed.kill_buffer("last").unwrap();
    assert_eq!(windows(&ed).len(), 1);
    assert_eq!(eval(&mut ed, &s, "String(e8.windowDedicatedP())"), "\"undefined\"");
    // A window softly dedicated stops being so when it shows another buffer.
    eval(&mut ed, &s, r#"(e8.setWindowDedicatedP(undefined, "soft"), e8.getBufferCreate("soft"), e8.setWindowBuffer(undefined, "soft"), 0)"#);
    assert_eq!(eval(&mut ed, &s, "String(e8.windowDedicatedP())"), "\"undefined\"");
}

#[test]
fn previous_buffer_and_next_buffer_go_back_and_forth() {
    let (mut ed, _s) = setup("");
    for name in ["a", "b", "c"] {
        ed.press("C-x b").unwrap();
        ed.type_text(name);
        ed.press("RET").unwrap();
    }
    let shown = |ed: &Editor| ed.window_buffer().name.clone();
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "b");
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "a");
    ed.press("C-x <left>").unwrap();
    assert_eq!(shown(&ed), "*scratch*");
    ed.press("C-x <right>").unwrap();
    assert_eq!(shown(&ed), "a");
    ed.press("C-x <right>").unwrap();
    assert_eq!(shown(&ed), "b");
}

#[test]
fn a_buffer_shows_again_from_where_it_was_last_shown() {
    // As Emacs 30.2 does it, in emacs -Q --batch: a window shown the
    // buffer starts where the last window to show it did, with the point
    // that window left.
    let text: String = (0..100).map(|i| format!("line {i}\n")).collect();
    let (mut ed, s) = setup(&text);
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, "(e8.setWindowStart(undefined, 430), e8.gotoChar(470), 0)");
    ed.switch_to_buffer("other");
    ed.press("C-x 2").unwrap();
    let shown = r#"(globalThis.w = e8.windowList()[1], e8.setWindowBuffer(w, "*scratch*"), [e8.windowStart(w), e8.windowPoint(w)])"#;
    assert_eq!(eval(&mut ed, &s, shown), "[430,470]");
    let again = r#"(e8.withCurrentBuffer("*scratch*", () => e8.gotoChar(0)), e8.setWindowBuffer(w, "other"), e8.setWindowBuffer(w, "*scratch*"), [e8.windowStart(w), e8.windowPoint(w)])"#;
    assert_eq!(eval(&mut ed, &s, again), "[430,470]");
}

#[test]
fn c_l_puts_the_line_in_the_middle_then_at_the_top_then_the_bottom() {
    let text: String = (0..100).map(|i| format!("line {i}\n")).collect();
    let (mut ed, _s) = setup(&text);
    ed.set_viewport_height(10);
    for _ in 0..50 {
        ed.press("C-n").unwrap();
    }
    let top = |ed: &Editor| ed.window_buffer().top_line;
    ed.press("C-l").unwrap();
    assert_eq!(top(&ed), 45, "middle");
    ed.press("C-l").unwrap();
    assert_eq!(top(&ed), 50, "top");
    ed.press("C-l").unwrap();
    assert_eq!(top(&ed), 41, "bottom");
    ed.press("C-l").unwrap();
    assert_eq!(top(&ed), 45, "middle again");
}

#[test]
fn m_r_moves_to_the_middle_then_the_top_then_the_bottom_line() {
    let text: String = (0..100).map(|i| format!("line {i}\n")).collect();
    let (mut ed, _s) = setup(&text);
    ed.set_viewport_height(10);
    ed.window_buffer_mut().top_line = 40;
    let line = |ed: &Editor| ed.window_buffer().line_of(ed.window_buffer().point());
    ed.press("M-r").unwrap();
    assert_eq!(line(&ed), 45, "middle");
    ed.press("M-r").unwrap();
    assert_eq!(line(&ed), 40, "top");
    ed.press("M-r").unwrap();
    assert_eq!(line(&ed), 49, "bottom");
    ed.press("M-2 M-r").unwrap();
    assert_eq!(line(&ed), 42, "line 2 of the window");
}

#[test]
fn split_height_threshold_nil_splits_side_by_side() {
    // A frame tall enough to split below and wide enough to split beside.
    let (mut ed, s) = setup("x");
    ed.set_frame_size(200, 90);
    ed.get_buffer_create("*other*");
    ed.call("display-buffer", vec![e8_core::Arg::Str("*other*".into())]).unwrap();
    let below = s.eval_expression(&mut ed, r#"String(e8.windowSize(e8.windowList()[1]).fullWidth)"#).unwrap();
    assert_eq!(below.trim_matches('"'), "true", "split below by default");
    let (mut ed, s) = setup("x");
    ed.set_frame_size(200, 90);
    s.eval_expression(&mut ed, r#"(e8.setVariable("split-height-threshold", null), 1)"#).unwrap();
    ed.get_buffer_create("*other*");
    ed.call("display-buffer", vec![e8_core::Arg::Str("*other*".into())]).unwrap();
    let beside = s.eval_expression(&mut ed, r#"String(e8.windowSize(e8.windowList()[1]).fullWidth)"#).unwrap();
    assert_eq!(beside.trim_matches('"'), "false", "split beside when nil");
}
