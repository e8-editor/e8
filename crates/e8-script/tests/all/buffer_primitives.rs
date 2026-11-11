//! The buffer and text primitives of editfns.c, buffer.c and marker.c
//! that came last, under Emacs's names, checked against what Emacs 30.2
//! gives. Emacs counts positions from 1 and scripts from 0.

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
fn markers_have_an_insertion_type_that_can_change() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abc"), globalThis.m = e8.makeMarker(1), globalThis.n = e8.makeMarker(1, { advances: true }),
          e8.gotoChar(1), e8.insert("X"),
          JSON.stringify([e8.markerPosition(m) + 1, e8.markerPosition(n) + 1, e8.markerInsertionType(m), e8.markerInsertionType(n),
            (e8.setMarkerInsertionType(m, true), e8.gotoChar(1), e8.insert("Y"), e8.markerPosition(m) + 1),
            (e8.deleteMarker(m), e8.markerInsertionType(m) ?? null),
            (() => { const d = e8.makeMarker(0); e8.setMarker(d, null); e8.setMarkerInsertionType(d, true); e8.setMarker(d, 1);
                     e8.gotoChar(1); e8.insert("Z"); return [e8.markerInsertionType(d), e8.markerPosition(d) + 1]; })()]))"#,
    );
    // Emacs: (2 3 nil t 3), and a marker pointing nowhere keeps the type it is given
    assert_eq!(got, "[2,3,false,true,3,null,[true,3]]");
}

#[test]
fn buffer_local_variables_and_the_chars_modified_tick() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.makeLocalVariable("fill-column"), e8.setVariable("fill-column", 33), e8.insert("x"),
          globalThis.tick = e8.bufferCharsModifiedTick(),
          JSON.stringify([e8.bufferLocalVariables().find(([name]) => name === "fill-column"),
            (e8.putTextProperty(0, 1, "face", "bold"), e8.bufferCharsModifiedTick() === tick),
            (e8.insert("y"), e8.bufferCharsModifiedTick() > tick),
            e8.bufferCharsModifiedTick(e8.bufferName(e8.currentBuffer())) === e8.bufferCharsModifiedTick()]))"#,
    );
    // Emacs: (fill-column . 33) t t
    assert_eq!(got, r#"[["fill-column",33],true,true,true]"#);
}

#[test]
fn bytes_are_counted_as_emacs_counts_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("a"), subr.insertByte(200), e8.insert("é"),
          JSON.stringify([subr.getByte(0), subr.getByte(1), e8.conditionCase(() => subr.getByte(2), { error: (e) => e.message }),
            e8.positionBytes(3) + 1, e8.byteToPosition(3) + 1, e8.byteToPosition(4) + 1, e8.positionBytes(99) ?? null,
            (e8.gotoChar(3), subr.insertByte(65, 2), e8.bufferSubstringNoProperties(3, 5)), subr.getByte(0, "A"),
            subr.getByte(1, "\u{10FF80}\u{10FF81}"), subr.getByte(1, "😀a")]))"#,
    );
    // Emacs: 97 200, the error, then 6 3 3
    assert_eq!(got, r#"[97,200,"Not an ASCII nor an 8-bit character: 233",6,3,3,null,"AA",65,129,97]"#);
}

#[test]
fn transposing_regions_moves_point_with_its_text_unless_told_not_to() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abc-de-fgh"), e8.gotoChar(1), subr.transposeRegions(0, 3, 7, 10),
          globalThis.first = [e8.bufferSubstringNoProperties(0, 10), e8.point() + 1],
          e8.deleteRegion(0, 10), e8.insert("AAA-mid-BB"), globalThis.edge = e8.makeMarker(3), subr.transposeRegions(0, 3, 8, 10),
          first.push(e8.markerPosition(edge)),
          e8.deleteRegion(0, 10), e8.insert("abc"), e8.gotoChar(1), subr.transposeRegions(0, 1, 2, 3, true),
          JSON.stringify([first, [e8.bufferSubstringNoProperties(0, 3), e8.point() + 1],
            e8.conditionCase(() => subr.transposeRegions(0, 2, 1, 3), { error: (e) => e.message })]))"#,
    );
    // Emacs: ("fgh-de-abc" 9), a marker at the first region's end stays with the text after it (0-based 2), ("cba" 2),
    // and an error for regions that overlap
    assert_eq!(got, r#"[["fgh-de-abc",9,2],["cba",2],"Transposed regions overlap"]"#);
}

#[test]
fn replacing_a_buffer_s_contents_changes_only_what_differs() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.withCurrentBuffer(e8.getBufferCreate("src"), () => e8.insert("aXc 😀 end")),
          e8.insert("abc 😀 end"), globalThis.m = e8.makeMarker(8), e8.gotoChar(2),
          JSON.stringify([subr.replaceBufferContents("src"), e8.bufferSubstringNoProperties(0, e8.pointMax()), e8.point() + 1,
            e8.markerPosition(m) + 1]))"#,
    );
    // Emacs: t "aXc" 2 for point after the b that changed; text after the change keeps its markers
    assert_eq!(got, r#"[true,"aXc 😀 end",2,9]"#);
}

#[test]
fn current_message_and_the_default_major_mode() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.message("hello"), e8.call("emacs-lisp-mode"),
          JSON.stringify([subr.currentMessage === undefined ? e8.currentMessage() : null,
            (subr.setBufferMajorMode(e8.currentBuffer()), e8.variable("major-mode")),
            (subr.combineAfterChangeCalls(() => 7)), subr.getTruenameBuffer("/no/such/file") ?? null]))"#,
    );
    assert_eq!(got, r#"["hello","fundamental-mode",7,null]"#);
}
