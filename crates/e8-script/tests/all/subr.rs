//! subr.ts's functions under Emacs's names, checked against what Emacs 30.2
//! gives for the same text. Emacs counts positions from 1 and scripts from
//! 0, so the code below adds 1 to positions before comparing.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "load.ts", r#"import("subr").then((m) => { globalThis.subr = m; });"#.into()).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn positions_are_tested_as_emacs_tests_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("one\ntwo\nthree"), JSON.stringify([1, 3, 4, 5, 14].map((p) => {
          e8.gotoChar(p - 1);
          return [subr.eobp(), subr.bobp(), subr.bolp(), subr.eolp()];
        })))"#,
    );
    // Emacs: (nil t t nil) (nil nil nil nil) (nil nil nil t) (nil nil t nil) (t nil nil t)
    assert_eq!(
        got,
        "[[false,true,true,false],[false,false,false,false],[false,false,false,true],[false,false,true,false],[true,false,false,true]]"
    );
}

#[test]
fn erasing_widens_and_buffer_string_is_the_accessible_text() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("one\ntwo\nthree"), e8.narrowToRegion(4, 7), e8.gotoChar(4), JSON.stringify([
          subr.bobp(), String(subr.bufferString()),
          e8.markerPosition(subr.pointMinMarker()) + 1, e8.markerPosition(subr.pointMaxMarker()) + 1,
          (subr.eraseBuffer(), e8.bufferSize()), String(subr.bufferString()),
        ]))"#,
    );
    // Emacs: t "two" 5 8, then 0 ""
    assert_eq!(got, r#"[true,"two",5,8,0,""]"#);
}

#[test]
fn text_properties_report_whether_they_changed_anything() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), JSON.stringify([
          subr.addTextProperties(1, 3, { face: "bold" }),
          subr.addTextProperties(1, 3, { face: "bold" }),
          subr.removeTextProperties(0, 6, ["mouse-face"]),
          subr.removeTextProperties(0, 6, { face: null }),
          subr.setTextProperties(0, 6),
          subr.setTextProperties(0, 2, { x: 1, y: 2 }),
          e8.textPropertiesAt(0),
          subr.removeListOfTextProperties(0, 6, ["x"]),
          e8.textPropertiesAt(1),
        ]))"#,
    );
    // Emacs: t nil nil t t t (x 1 y 2), then t and (y 2)
    assert_eq!(got, r#"[true,false,false,true,true,true,{"x":1,"y":2},true,{"y":2}]"#);
}

#[test]
fn char_properties_come_from_the_overlay_that_wins() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), e8.putTextProperty(0, 6, "p", "text"),
          globalThis.a = e8.makeOverlay(1, 4), globalThis.b = e8.makeOverlay(2, 3), globalThis.c = e8.makeOverlay(1, 5),
          e8.overlayPut(a, "p", "a"), e8.overlayPut(b, "p", "b"), e8.overlayPut(c, "p", "c"), e8.overlayPut(c, "priority", 5),
          JSON.stringify([[0, 2, 1, 4].map((p) => subr.getCharProperty(p, "p")),
            (e8.overlayPut(c, "priority", null), [2, 1].map((p) => subr.getCharProperty(p, "p")))]))"#,
    );
    // Emacs: (text c c c) (b a)
    assert_eq!(got, r#"[["text","c","c","c"],["b","a"]]"#);
}

#[test]
fn markers_regions_and_inserted_characters_as_in_emacs() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), JSON.stringify([
          e8.markerPosition(subr.copyMarker(100)) + 1,
          (e8.gotoChar(2), subr.insertChar("x", 3), e8.bufferText(0, e8.bufferSize())),
          e8.conditionCase(() => subr.regionBeginning(), { error: (e) => e.message }),
          (e8.setMark(1), [subr.regionBeginning() + 1, subr.regionEnd() + 1]),
          (subr.insertChar(0x263a, 0), subr.insertChar(0x263a), e8.charBefore()),
          subr.copyMarker(subr.pointMarker(), true) !== undefined,
        ]))"#,
    );
    // Emacs: 7, "abxxxcdef", the error, (2 6)
    assert_eq!(got, r#"[7,"abxxxcdef","The mark is not set now, so there is no region",[2,6],"☺",true]"#);
}

#[test]
fn read_only_buffers_signal_unless_inhibited() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("$ ls"), e8.setReadOnly(true),
          e8.letBind({ "inhibit-read-only": true }, () => e8.putTextProperty(0, 1, "inhibit-read-only", true)),
          JSON.stringify([
            e8.conditionCase(() => (subr.barfIfBufferReadOnly(0), "fine"), { "buffer-read-only": () => "signalled" }),
            e8.conditionCase(() => (subr.barfIfBufferReadOnly(1), "fine"), { "buffer-read-only": () => "signalled" }),
            e8.letBind({ "inhibit-read-only": true }, () => (subr.barfIfBufferReadOnly(1), "fine")),
            (e8.setReadOnly(false), e8.letBind({ "inhibit-read-only": true }, () => e8.putTextProperty(2, 3, "read-only", true)),
              subr.barfIfBufferReadOnly(2), "fine"),
          ]))"#,
    );
    // Emacs: nil, then buffer-read-only, and nil for read-only text in a writable buffer
    assert_eq!(got, r#"["fine","signalled","fine","fine"]"#);
}

#[test]
fn line_starts_and_ends_ignore_fields() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert(e8.concat(e8.propertize("$ ", { field: Symbol.for("output"), "rear-nonsticky": true }), "ls")),
          e8.gotoChar(2), JSON.stringify([subr.bolp(), (e8.gotoChar(0), subr.bolp())]))"#,
    );
    // Emacs: bolp is nil after the prompt, though line-beginning-position, which follows fields, is 3 there
    assert_eq!(got, "[false,true]");
}

#[test]
fn a_copied_marker_is_in_the_buffer_of_the_marker_it_copies() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), globalThis.m = e8.makeMarker(4),
          e8.withCurrentBuffer(e8.getBufferCreate("other"), () => {
            const copy = subr.copyMarker(m);
            return JSON.stringify([e8.markerBuffer(copy) === e8.markerBuffer(m), e8.markerPosition(copy)]);
          }))"#,
    );
    assert_eq!(got, "[true,4]");
}

#[test]
fn windows_frames_and_processes_by_emacs_s_names() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          subr.windowLiveP(e8.selectedWindow()), subr.windowLiveP(9999), subr.windowLiveP("x"),
          subr.windowLiveP(e8.minibufferWindow()),
          subr.frameLiveP(e8.selectedFrame()), subr.frameLiveP(9999),
          subr.getBufferWindow() === e8.selectedWindow(), subr.getBufferWindow("no such buffer"),
          subr.activeMinibufferWindow(), subr.windowMinibufferP(), subr.windowMinibufferP(e8.minibufferWindow()),
          subr.getProcess("none"), subr.processp("none"), subr.processName("p"),
          subr.directoryNameP("/tmp/"), subr.directoryNameP("/tmp"),
          [[3, "c"], [1, "a"], [2, "b"]].sort((x, y) => (subr.carLessThanCar(x, y) ? -1 : 1)).map((x) => x[1]).join(""),
        ])"#,
    );
    assert_eq!(got, r#"[true,false,false,true,true,false,true,null,null,false,true,null,false,"p",true,false,"abc"]"#);
}
