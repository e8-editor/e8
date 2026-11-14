//! Buffer text's and windows' odds (ADR 0086): buffer-last-name,
//! buffer-swap-text, marker-last-position, the gap, labeled restrictions,
//! internal--set-buffer-modified-tick, translate-region-internal and
//! window display tables. Each expectation is Emacs 30.2's for the same
//! calls, its positions from 1 made E8's from 0.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript and gives what it returns as JSON, or `ERR message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "test.ts", format!("globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.message}}`; }} }})();"))
        .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn buffers_remember_their_last_names() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: a buffer never renamed gives its own name, a renamed one its
    // old one, and a killed one the name it had.
    assert_eq!(r(r#"const b = e8.getBufferCreate("one"); return e8.bufferLastName(b);"#), r#""one""#);
    assert_eq!(r(r#"const b = e8.getBufferCreate("two"); e8.withCurrentBuffer(b, () => e8.call("rename-buffer", "three")); return e8.bufferLastName(b);"#), r#""two""#);
    assert_eq!(r(r#"const b = e8.getBufferCreate("four"); e8.call("kill-buffer", b.name); return e8.bufferLastName(b);"#), r#""four""#);
}

#[test]
fn buffers_swap_their_text_as_emacs_swaps_it() {
    let (mut ed, s) = setup();
    let got = run(
        &mut ed,
        &s,
        r#"const a = e8.getBufferCreate("sa"), b = e8.getBufferCreate("sb");
        let m: any;
        e8.withCurrentBuffer(a, () => { e8.insert("hello world"); e8.gotoChar(2); m = e8.makeMarker(4); e8.putTextProperty(0, 2, "face", "bold"); e8.narrowToRegion(1, 5); });
        e8.withCurrentBuffer(b, () => { e8.insert("xy"); e8.setBufferModified(false); });
        e8.withCurrentBuffer(a, () => e8.bufferSwapText(b));
        const state = () => [e8.bufferText(e8.pointMin(), e8.pointMax()), e8.point(), e8.bufferModified(), e8.pointMin(), e8.pointMax()];
        return [e8.withCurrentBuffer(a, state), e8.withCurrentBuffer(b, () => [...state(), e8.saveRestriction(() => { e8.widen(); return e8.getTextProperty(0, "face"); })]), e8.markerBuffer(m), e8.markerPosition(m)];"#,
    );
    // As Emacs: (("xy" 3 t 1 3) ("ello" 3 t 2 6 bold) "sb" 5).
    assert_eq!(got, r#"[["xy",2,true,0,2],["ello",2,true,1,5,"bold"],"sb",4]"#);
    assert_eq!(run(&mut ed, &s, r#"const b = e8.getBufferCreate("sd"); e8.call("kill-buffer", b.name); return e8.bufferSwapText(b);"#), "ERR Cannot swap a dead buffer's text");
    assert_eq!(
        run(&mut ed, &s, r#"const a = e8.getBufferCreate("se"), b = e8.getBufferCreate("sf"); return e8.withCurrentBuffer(a, () => { e8.makeIndirectBuffer(a, "sg"); return e8.bufferSwapText(b); });"#),
        "ERR One of the buffers to swap has indirect buffers"
    );
}

#[test]
fn markers_gap_ticks_and_translation() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: (nil 4), once the buffer is killed or the marker set nowhere.
    assert_eq!(r(r#"const b = e8.getBufferCreate("m"); const m = e8.withCurrentBuffer(b, () => { e8.insert("abcdef"); return e8.makeMarker(3); }); e8.call("kill-buffer", b.name); return [e8.markerPosition(m) ?? null, e8.markerLastPosition(m)];"#), "[null,3]");
    assert_eq!(r(r#"e8.insert("abcdef"); const m = e8.makeMarker(3); e8.setMarker(m, null); return [e8.markerPosition(m) ?? null, e8.markerLastPosition(m)];"#), "[null,3]");
    // As Emacs: (wrong-type-argument markerp 3) for what is no marker.
    assert!(r("return e8.markerLastPosition(999999 as any);").starts_with("ERR Wrong type argument: markerp"));
    // E8 has no gap: its end, and none.
    assert_eq!(r(r#"e8.deleteRegion(e8.pointMin(), e8.pointMax()); e8.insert("abcdef"); return [e8.gapPosition(), e8.gapSize()];"#), "[6,0]");
    // As Emacs: (100 101).
    assert_eq!(r(r#"e8.internalSetBufferModifiedTick(100); const t = e8.bufferModifiedTick(); e8.insert("c"); return [t, e8.bufferModifiedTick()];"#), "[100,101]");
    assert_eq!(r("return e8.internalSetBufferModifiedTick(1.5);"), "ERR Wrong type argument: fixnump, 1.5");
    // As Emacs: (6 "PQRTUV"), and (2 "zbczbc") by a char-table.
    let table = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZxyzdefghij";
    assert_eq!(r(&format!(r#"e8.deleteRegion(e8.pointMin(), e8.pointMax()); e8.insert("abcABC"); const n = e8.translateRegionInternal(0, 6, "{table}"); return [n, e8.bufferText()];"#)), r#"[6,"PQRTUV"]"#);
    assert_eq!(
        r(r#"e8.deleteRegion(e8.pointMin(), e8.pointMax()); e8.insert("abcabc"); const t = e8.makeCharTable("translation-table"); e8.aset(t, "a".codePointAt(0)!, "z".codePointAt(0)!); e8.aset(t, "c".codePointAt(0)!, "c".codePointAt(0)!); return [e8.translateRegionInternal(0, 6, t), e8.bufferText()];"#),
        r#"[2,"zbczbc"]"#
    );
    assert_eq!(r("return e8.translateRegionInternal(0, 0, 3 as any);"), "ERR Not a translation table");
}

#[test]
fn labeled_restrictions_as_with_restriction_makes_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    let bounds = "const b = () => [e8.pointMin(), e8.pointMax()];";
    // As Emacs: (3 8 (3 8) (3 8) (4 5) (3 8) (1 11) (4 5)).
    assert_eq!(
        r(&format!(r#"{bounds} e8.insert("0123456789"); return e8.saveRestriction(() => {{
            e8.internalLabeledNarrowToRegion(2, 7, Symbol.for("foo"));
            const out: any[] = [...b()];
            e8.widen(); out.push(b());
            e8.narrowToRegion(0, 10); out.push(b());
            e8.narrowToRegion(3, 4); out.push(b());
            out.push(e8.saveRestriction(() => {{ e8.internalLabeledWiden(Symbol.for("bar")); return b(); }}));
            out.push(e8.saveRestriction(() => {{ e8.internalLabeledWiden(Symbol.for("foo")); return b(); }}));
            out.push(b());
            return out;
        }});"#)),
        "[2,7,[2,7],[2,7],[3,4],[2,7],[0,10],[3,4]]"
    );
    // Leaving with-restriction ends its label: as Emacs, (1 11 11).
    assert_eq!(r(&format!(r#"{bounds} return [...b(), (e8.widen(), e8.pointMax())];"#)), "[0,10,10]");
    // A narrowing there was stays outermost: as Emacs, (2 9 11).
    assert_eq!(
        r(&format!(r#"{bounds} e8.narrowToRegion(1, 8); e8.internalLabeledNarrowToRegion(2, 7, Symbol.for("x")); e8.internalLabeledWiden(Symbol.for("x")); const out = b(); e8.widen(); return [...out, e8.pointMax()];"#)),
        "[1,8,10]"
    );
}

#[test]
fn windows_have_display_tables() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: nil, then the table set, nil again, and any value kept.
    assert_eq!(r("return e8.windowDisplayTable() ?? null;"), "null");
    assert_eq!(r(r#"const t = e8.makeCharTable("display-table"); e8.setWindowDisplayTable(null, t); return e8.windowDisplayTable() === t;"#), "true");
    assert_eq!(r("return e8.setWindowDisplayTable(null, null) ?? null;"), "null");
    assert_eq!(r("return e8.setWindowDisplayTable(null, 3);"), "3");
    assert_eq!(r("e8.setWindowDisplayTable(null, null); return e8.resizeMiniWindowInternal(e8.selectedWindow());"), "ERR Not a valid minibuffer window");
    assert_eq!(r("return e8.resizeMiniWindowInternal(e8.minibufferWindow());"), "ERR Cannot resize mini window");
}
