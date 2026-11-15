//! fontset-info (ADR 0105): what a fontset holds, as a char-table, on a
//! window system; an error elsewhere, as Emacs's in batch.

use std::sync::Arc;

use e8_core::Editor;
use e8_core::layout::{FontSpec, TextMetrics};
use e8_script::Scripting;

/// A window system's metrics: cells of 7 by 14, with images.
struct Window;

impl TextMetrics for Window {
    fn advance(&self, font: &FontSpec, _c: char) -> f32 {
        7.0 * font.scale
    }
    fn line_height(&self, font: &FontSpec) -> f32 {
        14.0 * font.scale
    }
    fn char_width(&self) -> f32 {
        7.0
    }
    fn char_height(&self) -> f32 {
        14.0
    }
    fn ascent(&self, font: &FontSpec) -> f32 {
        11.0 * font.scale
    }
    fn font_size(&self) -> f32 {
        12.0
    }
    fn images(&self) -> bool {
        true
    }
}

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
fn fontset_info_needs_a_window_system() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(run(&mut ed, &s, "return e8.fontsetInfo(true);"), "ERR error Window system is not in use or not initialized");
}

#[test]
fn fontset_info_lists_each_range_s_fonts() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_text_metrics(Arc::new(Window));
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.setFontsetFont(true, [0x3040, 0x309f], "Hiragino Sans"); e8.setFontsetFont(true, null, "Menlo");"#);
    // Each range's fonts, each in a list of its own with no font opened, and the default's.
    assert_eq!(
        r(r#"const t = e8.fontsetInfo(true); return [e8.charTableRange(t, 0x3042), e8.charTableRange(t, null), e8.fontsetFont(true, 0x3042)];"#),
        r#"[[[["Hiragino Sans",null]]],[[["Menlo",null]]],["Hiragino Sans",null]]"#
    );
    // Another fontset has the default fontset's table in its extra slot.
    r(r#"e8.newFontset("-*-*-*-*-*-*-*-*-*-*-*-*-fontset-test", [[[0x3b1, 0x3c9], "Monaco"]]);"#);
    assert_eq!(
        r(r#"const t = e8.fontsetInfo("-*-*-*-*-*-*-*-*-*-*-*-*-fontset-test"); return [e8.charTableRange(t, 0x3b2), e8.charTableRange(e8.charTableExtraSlot(t, 0) as e8.CharTable, 0x3042)];"#),
        r#"[[[["Monaco",null]]],[[["Hiragino Sans",null]]]]"#
    );
}
