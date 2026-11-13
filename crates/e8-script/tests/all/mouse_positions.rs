//! The mouse as values, as Emacs's frame.c, window.c and keyboard.c give
//! it (ADR 0074): where the pointer is and moving it, which window and
//! which part of it a place is, `<mouse-movement>` while `track-mouse` is
//! on, and the raw keys of a key sequence. What Emacs gives was recorded
//! from Emacs 30 in a terminal 80 columns by 25 lines, without a menu bar.

use e8_core::clicks::Clicks;
use e8_core::mouse::{Pointer, Warp};
use e8_core::{Editor, MouseEvent};
use e8_script::Scripting;

use crate::driven::Driven;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

/// A graphical front end's fonts: characters 10 points wide, lines 20 high.
struct Window;

impl e8_core::layout::TextMetrics for Window {
    fn advance(&self, _font: &e8_core::layout::FontSpec, _c: char) -> f32 {
        10.0
    }

    fn line_height(&self, _font: &e8_core::layout::FontSpec) -> f32 {
        20.0
    }

    fn char_width(&self) -> f32 {
        10.0
    }

    fn char_height(&self) -> f32 {
        20.0
    }

    fn images(&self) -> bool {
        true
    }

    fn window_chrome(&self) -> e8_core::layout::WindowChrome {
        e8_core::layout::WindowChrome { mode_line: 20.0, header_line: 20.0, text_top: 0.0, fringes: 16.0, divider: 0.0 }
    }
}

/// The windows Emacs's case makes: the frame split right of 30 columns,
/// and the left one below 6 lines, named for their places.
const SPLIT: &str = r#"(globalThis.L = e8.selectedWindow(), globalThis.R = e8.splitWindow(L, "right", 30),
  globalThis.B = e8.splitWindow(L, "below", 6), globalThis.M = e8.minibufferWindow(),
  globalThis.name = (w) => w === undefined ? null : [L, R, B, M].findIndex((x) => x.id === w.id) >= 0 ? "LRBM"[[L, R, B, M].findIndex((x) => x.id === w.id)] : "?",
  true)"#;

#[test]
fn window_at_and_coordinates_in_window_as_emacs_finds_them() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, SPLIT);
    assert_eq!(
        eval(&mut ed, &s, "([L, R, B, M].map((w) => e8.windowEdges(w)))"),
        "[[0,0,30,6],[30,0,80,24],[0,6,30,24],[0,24,80,25]]"
    );
    let got = eval(
        &mut ed,
        &s,
        r#"([[0, 0], [5, 2], [28, 2], [29, 2], [30, 2], [31, 2], [29, 5], [28, 5], [5, 5], [5, 6], [29, 6], [40, 23],
          [40, 22], [79, 0], [0, 24], [10, 24], [5, 12], [2.5, 1.5], [-1, 0], [80, 0], [30, 24]]
          .map(([x, y]) => [name(e8.windowAt(x, y)), ...[L, R, B, M].map((w) => e8.coordinatesInWindowP([x, y], w) ?? null)]))"#,
    );
    let expected = r#"[["L",[0,0],null,null,null],["L",[5,2],null,null,null],["L",[28,2],null,null,null],
        ["L","vertical-line",null,null,null],["R",null,[0,2],null,null],["R",null,[1,2],null,null],
        ["L","mode-line",null,null,null],["L","mode-line",null,null,null],["L","mode-line",null,null,null],
        ["B",null,null,[5,0],null],["B",null,null,"vertical-line",null],["R",null,"mode-line",null,null],
        ["R",null,[10,22],null,null],["R",null,[49,0],null,null],["M",null,null,null,[0,0]],["M",null,null,null,[10,0]],
        ["B",null,null,[5,6],null],["L",[2,1],null,null,null],[null,null,null,null,null],[null,null,null,null,null],
        ["M",null,null,null,[30,0]]]"#;
    assert_eq!(got, expected.split_whitespace().collect::<String>());
    // Margins and a header line, in the right window.
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.withCurrentBuffer(e8.getBufferCreate("hl"), () => { e8.makeLocalVariable("header-line-format"); e8.setVariable("header-line-format", "H"); }),
          e8.setWindowBuffer(R, "hl"), e8.setWindowMargins(R, 2, 3), e8.redisplay(),
          [[30, 0], [31, 1], [32, 1], [33, 1], [75, 1], [76, 1], [77, 1], [79, 1], [40, 0], [40, 1], [40, 23]]
            .map((c) => e8.coordinatesInWindowP(c, R) ?? null))"#,
    );
    assert_eq!(got, r#"["header-line","left-margin",[0,1],[1,1],[43,1],[44,1],"right-margin","right-margin","header-line",[8,1],"mode-line"]"#);
    // A window that is not live, and coordinates that are not a pair, as Emacs: errors.
    assert_eq!(
        eval(&mut ed, &s, r#"([() => e8.coordinatesInWindowP([1], L), () => (e8.deleteWindow(B), e8.coordinatesInWindowP([1, 1], B))].map((f) => e8.conditionCase(f, { error: (e) => e.symbol })))"#),
        r#"["wrong-type-argument","wrong-type-argument"]"#
    );
}

#[test]
fn a_window_has_its_parts_in_points_and_fringes() {
    let (mut ed, s) = setup();
    ed.set_text_metrics(std::sync::Arc::new(Window));
    // 80 columns of 10 points and 24 lines of 20.
    ed.set_frame_pixel_size(800, 480);
    eval(&mut ed, &s, SPLIT);
    let chrome = ed.text_metrics().window_chrome();
    let fringe = chrome.fringes / 20.0;
    // Columns from the frame's left: inside the left fringe, the text, and
    // the right window's text, as fractions of a column.
    let got = eval(&mut ed, &s, &format!("([[0.05, 2], [{x}, 2], [35, 2]].map((c) => [name(e8.windowAt(...c)), e8.coordinatesInWindowP(c, e8.windowAt(...c)) ?? null]))", x = fringe + 1.0));
    let text_x = |x: f32, left: f32| ((x - left) * 10.0 - chrome.fringes / 2.0) / 10.0;
    let expected = format!(r#"[["L","left-fringe"],["L",[{},2]],["R",[{},2]]]"#, text_x(fringe + 1.0, 0.0), text_x(35.0, 30.0));
    assert_eq!(got, expected);
    // The border between windows is the last column's worth before the edge, as on a window system.
    assert_eq!(eval(&mut ed, &s, "e8.coordinatesInWindowP([29.5, 2], L)"), r#""vertical-line""#);
}

#[test]
fn the_pointer_is_where_the_front_end_last_saw_it() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, SPLIT);
    // Nothing seen: the selected frame and no place, as Emacs on a mouseless terminal.
    let probe = r#"([e8.mousePosition(), e8.mousePixelPosition()].map(([f, x, y]) => [f.id === e8.selectedFrame().id, x ?? null, y ?? null]))"#;
    assert_eq!(eval(&mut ed, &s, probe), "[[true,null,null],[true,null,null]]");
    let frame = ed.selected_frame();
    ed.set_pointer(Some(Pointer { frame, x: 42.0, y: 3.0, screen: None }));
    assert_eq!(eval(&mut ed, &s, probe), "[[true,42,3],[true,42,3]]");
    // window-at of mouse-position is the window under the pointer.
    assert_eq!(eval(&mut ed, &s, "(([f, x, y]) => name(e8.windowAt(x, y, f)))(e8.mousePosition())"), r#""R""#);
    // In points, columns and lines are whole ones of the frame's font, rounded down.
    ed.set_text_metrics(std::sync::Arc::new(Window));
    ed.set_pointer(Some(Pointer { frame, x: 125.5, y: 47.0, screen: Some((300.0, 400.0)) }));
    assert_eq!(eval(&mut ed, &s, probe), "[[true,12,2],[true,125,47]]");
    assert_eq!(eval(&mut ed, &s, "(e8.mouseAbsolutePixelPosition())"), "[300,400]");
    // mouse-position-function has the last word, as in Emacs.
    eval(&mut ed, &s, r#"e8.setVariable("mouse-position-function", e8.defun("test-mouse-position", ([f, x, y]) => [f, x + 1, y + 1]))"#);
    assert_eq!(eval(&mut ed, &s, probe), "[[true,13,3],[true,126,48]]");
    eval(&mut ed, &s, r#"e8.setVariable("mouse-position-function", null)"#);
    // A pointer over a frame since deleted is over none.
    let other: u64 = eval(&mut ed, &s, "e8.makeFrame().id").parse().unwrap();
    ed.set_pointer(Some(Pointer { frame: other, x: 1.0, y: 1.0, screen: None }));
    eval(&mut ed, &s, &format!("e8.deleteFrame({other})"));
    assert_eq!(eval(&mut ed, &s, probe), "[[true,null,null],[true,null,null]]");
    assert_eq!(eval(&mut ed, &s, "e8.framePointerVisibleP()"), "true");
}

#[test]
fn moving_the_pointer_asks_a_window_and_selects_a_terminal_frame() {
    let (mut ed, s) = setup();
    // A terminal cannot move it: the frame is selected instead, as Emacs without GPM.
    let f1 = ed.selected_frame();
    let f2: u64 = eval(&mut ed, &s, "e8.makeFrame().id").parse().unwrap();
    eval(&mut ed, &s, &format!("e8.selectFrame({f1}), e8.setMousePosition({f2}, 3, 4), e8.setMouseAbsolutePixelPosition(5, 6)"));
    assert_eq!(ed.selected_frame(), f2);
    assert!(ed.take_warps().is_empty());
    // A window moves it to the middle of the cell, kept on the frame, as
    // frame_char_to_pixel_position; or to the place given.
    eval(&mut ed, &s, &format!("e8.selectFrame({f1})"));
    ed.set_text_metrics(std::sync::Arc::new(Window));
    ed.set_frame_pixel_size(800, 480);
    ed.set_pointer(Some(Pointer { frame: f1, x: 0.0, y: 0.0, screen: Some((100.0, 50.0)) }));
    eval(&mut ed, &s, &format!("e8.setMousePosition({f1}, 3, 4)"));
    assert_eq!(eval(&mut ed, &s, "([e8.mousePosition().slice(1), e8.mousePixelPosition().slice(1), e8.mouseAbsolutePixelPosition()])"), "[[3,4],[35,90],[135,140]]");
    assert_eq!(ed.selected_frame(), f1);
    eval(&mut ed, &s, &format!("e8.setMousePosition({f1}, 1000, -5), e8.setMousePixelPosition({f1}, 7, 8), e8.setMouseAbsolutePixelPosition(5, 6)"));
    assert_eq!(
        ed.take_warps(),
        [
            Warp::Frame { frame: f1, x: 35.0, y: 90.0, chars: false },
            Warp::Frame { frame: f1, x: 800.0, y: 0.0, chars: false },
            Warp::Frame { frame: f1, x: 7.0, y: 8.0, chars: false },
            Warp::Screen { x: 5.0, y: 6.0 },
        ]
    );
    assert!(ed.take_warps().is_empty());
    // A frame that is not live, as Emacs: an error.
    assert_eq!(
        eval(&mut ed, &s, &format!("e8.deleteFrame({f2}), e8.conditionCase(() => e8.setMousePosition({f2}, 1, 1), {{ error: (e) => e.symbol }})")),
        r#""wrong-type-argument""#
    );
}

#[test]
fn movement_comes_as_events_only_while_track_mouse_is_on() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("hello world");
    eval(
        &mut ed,
        &s,
        r#"(globalThis.moves = [], e8.bindKey("<mouse-movement>", e8.defineCommand({ name: "test-move", run: () => moves.push(e8.lastMouseEvent().position) })), true)"#,
    );
    let at = |ed: &Editor, position| MouseEvent { window: ed.selected_window(), position: Some(position), start: None };
    let event = at(&ed, 3);
    ed.mouse_moved(event);
    assert_eq!(eval(&mut ed, &s, "(moves)"), "[]");
    // trackMouse binds track-mouse for its function only.
    assert_eq!(eval(&mut ed, &s, r#"([e8.trackMouse(() => e8.variable("track-mouse")), e8.variable("track-mouse") ?? null])"#), "[true,null]");
    eval(&mut ed, &s, r#"e8.setVariable("track-mouse", true)"#);
    let event = at(&ed, 4);
    ed.mouse_moved(event);
    assert_eq!(eval(&mut ed, &s, "(moves)"), "[4]");
    // While tracking, a drag's moves are movement, and its <drag-mouse-1> comes at the release, as in Emacs.
    eval(&mut ed, &s, r#"(globalThis.drags = [], e8.bindKey("<drag-mouse-1>", e8.defineCommand({ name: "test-drag", run: () => drags.push(e8.lastMouseEvent()) })), true)"#);
    let window = ed.selected_window();
    let mut clicks: Clicks<i32> = Clicks::default();
    clicks.press(&mut ed, 0.0, 0, |a, b| a == b, (window, Some(1)), false);
    clicks.moved(&mut ed, Some((window, Some(5))), false);
    clicks.moved(&mut ed, Some((window, Some(7))), false);
    assert_eq!(eval(&mut ed, &s, "([moves, drags.length])"), "[[4,5,7],0]");
    clicks.release(&mut ed, Some((window, Some(8))), false);
    assert_eq!(eval(&mut ed, &s, "([moves, drags.map((d) => [d.start.position, d.position])])"), "[[4,5,7],[[1,8]]]");
    // Without track-mouse, drags come as they go and movement not at all.
    eval(&mut ed, &s, r#"e8.setVariable("track-mouse", null)"#);
    clicks.press(&mut ed, 5.0, 0, |a, b| a == b, (window, Some(1)), false);
    clicks.moved(&mut ed, Some((window, Some(5))), false);
    clicks.release(&mut ed, Some((window, Some(5))), false);
    clicks.moved(&mut ed, Some((window, Some(6))), false);
    assert_eq!(eval(&mut ed, &s, "([moves, drags.length])"), "[[4,5,7],2]");
}

#[test]
fn movement_does_nothing_unless_bound_and_is_undefined_after_a_prefix() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("hello world");
    eval(&mut ed, &s, r#"e8.setVariable("track-mouse", true)"#);
    // Bound to ignore-preserving-kill-region, as in Emacs: a kill still appends after it.
    ed.press("M-< C-SPC C-f C-w").unwrap();
    let event = MouseEvent { window: ed.selected_window(), position: Some(2), start: None };
    ed.mouse_moved(event);
    assert_eq!(eval(&mut ed, &s, "[e8.lastCommand(), e8.lookupKey(\"global-map\", \"<mouse-movement>\")].join(\" \")"), r#""kill-region ignore-preserving-kill-region""#);
    ed.press("M-d C-y").unwrap();
    assert_eq!(ed.window_buffer().text().to_string(), "hello world");
    assert_eq!(eval(&mut ed, &s, "e8.currentKill(0)"), r#""hello""#);
    ed.press("C-x").unwrap();
    ed.mouse_moved(event);
    assert_eq!(ed.echo(), Some("C-x <mouse-movement> is undefined"));
    // Movement is kept out of the lossage, as Emacs keeps it.
    assert!(!eval(&mut ed, &s, "e8.recentKeys().join(\" \")").contains("movement"));
}

#[test]
fn track_mouse_gives_read_event_the_moves() {
    let d = Driven::new(
        r#"e8.bindKey("C-c m", e8.defineCommand({
          name: "test-track",
          run: () => e8.insert(e8.trackMouse(() => [e8.readEvent(), e8.lastMouseEvent().position, e8.readEvent()].join("|"))),
        }));"#,
    );
    d.press("C-c m");
    // Waiting for the event, the editor has told the front end it wants the moves.
    assert!(d.0.published().track_mouse);
    d.0.run(|ed| {
        let event = MouseEvent { window: ed.selected_window(), position: Some(0), start: None };
        ed.mouse_moved(event);
    });
    d.press("a");
    assert_eq!(d.text(), "<mouse-movement>|0|a");
    assert!(!d.0.published().track_mouse);
}

#[test]
fn raw_keys_are_the_keys_before_translation() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.seen = [], e8.bindKey("<f8>", e8.defineCommand({ name: "test-raw", run: () => seen.push([e8.thisSingleCommandKeys(), e8.thisSingleCommandRawKeys(), e8.thisCommandKeysVector()]) })),
          e8.defineKey("key-translation-map", "<f9>", ["<f8>"]),
          e8.bindKey("C-c v", e8.defineCommand({ name: "test-read-vector", run: async () => seen.push([await e8.readKeySequenceVector("Keys: "), e8.thisSingleCommandRawKeys()]) })), true)"#,
    );
    ed.press("<f9>").unwrap();
    ed.press("S-<f8>").unwrap();
    ed.press("<f8>").unwrap();
    ed.press("C-c v C-x C-f").unwrap();
    // As Emacs 30 gives them: [f8] [f9] [f8], [f8] [S-f8] [f8], [f8] [f8] [f8].
    assert_eq!(
        eval(&mut ed, &s, "(seen)"),
        r#"[["<f8>",["<f9>"],["<f8>"]],["<f8>",["S-<f8>"],["<f8>"]],["<f8>",["<f8>"],["<f8>"]],[["C-x","C-f"],["C-x","C-f"]]]"#
    );
}
