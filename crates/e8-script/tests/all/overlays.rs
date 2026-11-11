//! Overlays as values: an overlay's number is unique among every buffer's,
//! so it says which buffer the overlay is in, and Emacs's overlay functions
//! work on it from any buffer. Checked against what Emacs 30.2 gives;
//! Emacs counts positions from 1 and scripts from 0.

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
fn an_overlay_knows_its_buffer_and_works_from_another() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), globalThis.here = e8.bufferName(e8.currentBuffer()),
          globalThis.o = e8.makeOverlay(1, 3, { face: "bold" }),
          globalThis.p = e8.withCurrentBuffer(e8.getBufferCreate("other"), () => (e8.insert("xyz"), e8.makeOverlay(0, 1, { face: "italic" }))),
          JSON.stringify([o !== p, e8.overlayBuffer(o) === here, e8.overlayBuffer(p), e8.overlayGet(p, "face"),
            e8.overlayProperties(o), (e8.overlayPut(p, "x", 1), e8.withCurrentBuffer("other", () => e8.overlayGet(p, "x"))),
            (e8.moveOverlay(p, 1, 2), [e8.overlayStart(p), e8.overlayEnd(p)]),
            e8.overlayp(o), e8.overlayp(9999), e8.overlayp("x"), e8.overlayLists().includes(o), e8.overlayLists().includes(p),
            (e8.deleteOverlay(p), [e8.overlayBuffer(p) ?? null, e8.overlayStart(p) ?? null, e8.overlayp(p)]),
            (e8.deleteAllOverlays(), e8.overlayLists())]))"#,
    );
    assert_eq!(got, r#"[true,true,"other","italic",{"face":"bold"},1,[1,2],true,false,false,true,false,[null,null,false],[]]"#);
}

#[test]
fn remove_overlays_cuts_back_and_splits_as_emacs_does() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("0123456789"),
          globalThis.a = e8.makeOverlay(1, 8, { face: "bold" }), globalThis.b = e8.makeOverlay(2, 4, { face: "bold" }),
          globalThis.c = e8.makeOverlay(5, 7, { face: "italic" }),
          subr.removeOverlays(3, 6, "face", "bold"),
          JSON.stringify([e8.overlaysIn(0, 10).map((o) => [e8.overlayStart(o) + 1, e8.overlayEnd(o) + 1, e8.overlayGet(o, "face")])
              .sort((x, y) => x[0] - y[0] || x[1] - y[1]),
            [e8.overlayStart(b) + 1, e8.overlayEnd(b) + 1], [e8.overlayStart(a) + 1, e8.overlayEnd(a) + 1],
            (() => { const d = subr.copyOverlay(c); return [e8.overlayStart(d) + 1, e8.overlayEnd(d) + 1, e8.overlayProperties(d)]; })(),
            (() => { const [v, o] = subr.getCharPropertyAndOverlay(6, "face"); return [v, e8.overlayStart(o) + 1]; })(),
            subr.getCharPropertyAndOverlay(0, "face").map((x) => x ?? null),
            (subr.removeOverlays(), e8.overlaysIn(0, 10))]))"#,
    );
    // Emacs: ((2 4 bold) (3 4 bold) (6 8 italic) (7 9 bold)), b at 3 to 4, a itself the part after, 7 to 9, c's copy (6 8 (face italic)),
    // (bold . the overlay from 7), (nil), and none left
    assert_eq!(
        got,
        r#"[[[2,4,"bold"],[3,4,"bold"],[6,8,"italic"],[7,9,"bold"]],[3,4],[7,9],[6,8,{"face":"italic"}],["bold",7],[null,null],[]]"#
    );
}

#[test]
fn a_cloned_indirect_buffer_has_overlays_of_its_own() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("abcdef"), globalThis.o = e8.makeOverlay(1, 3, { face: "bold" }),
          globalThis.base = e8.bufferName(e8.currentBuffer()),
          e8.makeIndirectBuffer(base, "clone", true),
          e8.withCurrentBuffer("clone", () => {
            const [copy] = e8.overlayLists();
            return JSON.stringify([copy !== o, e8.overlayBuffer(copy), e8.overlayGet(copy, "face"), e8.overlayBuffer(o) === base]);
          }))"#,
    );
    assert_eq!(got, r#"[true,"clone","bold",true]"#);
}
