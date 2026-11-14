//! Compositions, as Emacs's composite.c and composite.el give them
//! (ADR 0092), and prettify-symbols-mode, which draws with them. Each
//! expectation is what Emacs 30.2 gives for the same calls, positions
//! counted from 0 where Emacs counts from 1.

use e8_core::Editor;
use e8_script::Scripting;

/// An editor whose scripts reach composite.ts's exports as `composite`.
fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("reach.ts");
    std::fs::write(&module, r#"import * as composite from "composite"; (globalThis as any).composite = composite;"#).unwrap();
    s.load_module(&mut ed, &module).unwrap();
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "const composite = (globalThis as any).composite; globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null); }} catch (e: any) {{ return `ERR ${{e.symbol}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

fn drawn(ed: &mut Editor) -> String {
    ed.redisplay();
    ed.window_rows(1, true)[0].segments.iter().map(|s| s.text.as_str()).collect()
}

#[test]
fn compositions_are_put_and_found_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.insert("abc->def lambda x"); e8.setBufferModified(false);"#);
    r("composite.composeRegion(3, 5, 0x2192);");
    // ((2 . 8594)), and the buffer as unmodified as it was.
    assert_eq!(r(r#"return [e8.charProperty(3, "composition"), e8.bufferModified()];"#), "[[[2,8594]],false]");
    assert_eq!(r("return composite.findComposition(3);"), "[3,5,true]");
    assert_eq!(r("return composite.findComposition(4, null, null, true);"), "[3,5,[8594],true,null,1]");
    assert_eq!(r("return composite.findComposition(0);"), "null");
    // Found ahead of pos within limit, not past it.
    assert_eq!(r("return [composite.findComposition(0, 8), composite.findComposition(0, 2)];"), "[[3,5,true],null]");
    // And behind it, looking back.
    assert_eq!(r("return composite.findComposition(8, 1);"), "[3,5,true]");
    r(r#"composite.composeRegion(9, 15, "λ");"#);
    assert_eq!(r(r#"return e8.charProperty(9, "composition");"#), r#"[[6,"λ"]]"#);
    assert_eq!(r("return composite.findComposition(11, null, null, true);"), "[9,15,[955],true,null,1]");
    // Rules are encoded, (tc . bc) as 19, and the composition is not relative.
    r(r#"composite.composeRegion(0, 2, [97, [e8.intern("tc"), e8.intern("bc")], 98]);"#);
    assert_eq!(r(r#"return e8.charProperty(0, "composition");"#), "[[2,[97,19,98]]]");
    assert_eq!(r("return composite.findComposition(0, null, null, true);"), "[0,2,[97,19,98],false,null,1]");
    r("composite.decomposeRegion(0, 2);");
    assert_eq!(r(r#"return e8.charProperty(0, "composition") ?? null;"#), "null");
    // A modification function is kept beside the components.
    r(r#"composite.composeRegion(0, 2, 88, "foo");"#);
    assert_eq!(r(r#"return e8.charProperty(0, "composition");"#), r#"[[2,88],"foo"]"#);
    assert_eq!(r("return composite.findComposition(0, null, null, true);"), r#"[0,2,[88],true,"foo",1]"#);
}

#[test]
fn strings_are_composed_and_rules_sorted() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // #("xyz" 0 2 (composition ((2 . 81)))).
    assert_eq!(r(r#"const c = composite.composeString("xyz", 0, 2, 81); return [c.string, c.properties];"#), r#"["xyz",[[0,2,{"composition":[[2,81]]}]]]"#);
    assert_eq!(r(r#"return composite.findComposition(0, null, composite.composeString("xyz", 0, 2, 81), true);"#), "[0,2,[81],true,null,1]");
    assert_eq!(r(r#"return composite.findComposition(0, null, "xyz", true);"#), "null");
    // #("ab" 0 2 (composition ((2)))).
    assert_eq!(r("return composite.composeChars(97, 98).properties;"), r#"[[0,2,{"composition":[[2]]}]]"#);
    assert_eq!(r(r#"return composite.decomposeString(composite.composeString("xyz", 0, 2, 81)).properties;"#), "[]");
    assert_eq!(
        r(r#"return e8.compositionSortRules([["a", 0, "f"], ["b", 2, "g"], ["c", 1, "h"]]);"#),
        r#"[["b",2,"g"],["c",1,"h"],["a",0,"f"]]"#
    );
    assert_eq!(r("return e8.clearCompositionCache();"), "null");
    assert_eq!(r(r#"return e8.compositionGetGstring(0, 2, null, "ab")[0];"#), "[null,97,98]");
    assert_eq!(r(r#"try { e8.findCompositionInternal(9, null, "ab"); return "no"; } catch (e: any) { return e.symbol; }"#), r#""args-out-of-range""#);
}

#[test]
fn a_composition_is_drawn_as_its_components() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"e8.insert("a->b"); composite.composeRegion(1, 3, 0x2192);"#);
    assert_eq!(drawn(&mut ed), "a→b");
    run(&mut ed, &s, "composite.decomposeRegion(1, 3);");
    assert_eq!(drawn(&mut ed), "a->b");
}

#[test]
fn prettify_symbols_mode_shows_lambda_as_a_lambda() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"e8.call("prog-mode"); e8.insert("(lambda (x) \"lambda\" lambdas)"); e8.setBufferModified(false); e8.call("prettify-symbols-mode");"#);
    // Only the symbol standing alone, not in a string or a longer symbol.
    assert_eq!(drawn(&mut ed), "(λ (x) \"lambda\" lambdas)");
    assert_eq!(run(&mut ed, &s, "return [e8.bufferModified(), composite.findComposition(1)];"), "[false,[1,7,true]]");
    // Text typed later is composed as it is shown, and an edited symbol is shown as itself again.
    run(&mut ed, &s, r#"e8.gotoChar(e8.pointMax()); e8.insert(" lambda"); e8.gotoChar(7); e8.insert("x");"#);
    assert_eq!(drawn(&mut ed), "(lambdax (x) \"lambda\" lambdas) λ");
    run(&mut ed, &s, r#"e8.callWithPrefix(-1, "prettify-symbols-mode");"#);
    assert_eq!(drawn(&mut ed), "(lambdax (x) \"lambda\" lambdas) lambda");
}
