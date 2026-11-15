//! The mark as a marker, as editfns.c's `mark-marker` (ADR 0096). Each
//! expectation is what Emacs 30.2 gives for the same calls, positions
//! counted from 0 where Emacs counts from 1.

use e8_core::Editor;
use e8_script::Scripting;

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn the_mark_marker_is_the_mark() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // (nil nil 2 t 3 nil 4 (nil nil)), less one.
    assert_eq!(r(r#"e8.insert("abc"); const m = e8.markMarker(); return [m.position ?? null, e8.markerBuffer(m) ?? null];"#), "[null,null]");
    assert_eq!(r("e8.setMark(1); return [e8.markMarker().position, e8.markMarker() === e8.markMarker()];"), "[1,true]");
    assert_eq!(r("e8.setMarker(e8.markMarker(), 2); return [e8.mark(true), e8.markerInsertionType(e8.markMarker())];"), "[2,false]");
    assert_eq!(r(r#"e8.gotoChar(0); e8.insert("x"); return e8.markMarker().position;"#), "3");
    assert_eq!(r("e8.setMarker(e8.markMarker(), null); return [e8.mark(true) ?? null, e8.markMarker().position ?? null];"), "[null,null]");
    // Collecting garbage leaves the mark's marker, and the mark, alone.
    assert_eq!(r("e8.setMark(1); e8.garbageCollect(); return e8.markMarker().position;"), "1");
    // Each buffer has its own.
    assert_eq!(r(r#"const here = e8.markMarker(); e8.setBuffer(e8.getBufferCreate("other")); return here === e8.markMarker();"#), "false");
}
