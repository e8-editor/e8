//! The macOS display's functions (ADR 0097). Emacs has them only on its
//! NS port; without a window system they signal as Emacs's do in batch.

use std::sync::{Arc, Mutex};

use e8_core::layout::{FontSpec, TextMetrics};
use e8_core::{AppRequest, Editor, FrameRequest};
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

/// A clipboard in memory, shared with the test.
struct Board(Arc<Mutex<Option<String>>>);

impl e8_core::select::Clipboard for Board {
    fn get_text(&mut self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn set_text(&mut self, text: &str) {
        *self.0.lock().unwrap() = Some(text.to_string());
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
fn without_a_window_system_they_signal() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut r = |code: &str| run(&mut ed, &s, code);
    for call in ["e8.nsHideEmacs(true)", "e8.nsHideOthers()", "e8.nsEmacsInfoPanel()", "e8.nsGetResource(null, \"x\")", "e8.xServerVendor()"] {
        assert_eq!(r(&format!("return {call};")), "ERR error Window system frame should be used", "{call}");
    }
    // What needs no display answers anyway.
    assert_eq!(r("return [e8.nsListServices() ?? null, e8.nsResetMenu() ?? null, e8.nsListColors().includes(\"red\"), e8.nsFontName(\"-*-Menlo-normal-normal-normal-*-12-*-*-*-m-0-iso10646-1\"), e8.nsFontName(\"Menlo\")];"), r#"[null,null,true,"Menlo","Menlo"]"#);
}

#[test]
fn with_a_window_system_the_front_end_is_asked() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_text_metrics(Arc::new(Window));
    ed.take_frame_requests();
    run(&mut ed, &s, r#"e8.nsHideEmacs(true); e8.nsHideEmacs(null); e8.nsHideEmacs("activate"); e8.nsHideOthers(); e8.nsEmacsInfoPanel(); e8.nsPopupColorPanel(); e8.nsShowCharacterPalette();"#);
    let asked: Vec<AppRequest> = ed.take_frame_requests().into_iter().filter_map(|r| if let FrameRequest::App(a) = r { Some(a) } else { None }).collect();
    assert_eq!(
        asked,
        [AppRequest::Hide, AppRequest::Unhide, AppRequest::Activate, AppRequest::HideOthers, AppRequest::AboutPanel, AppRequest::ColorPanel, AppRequest::CharacterPalette]
    );
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"e8.nsSetResource(null, "Width", "80"); return [e8.nsGetResource(null, "Width"), e8.nsGetResource("other", "Width") ?? null];"#), r#"["80",null]"#);
    assert_eq!(r(r#"e8.nsSetResource(null, "Width", null); return e8.nsGetResource(null, "Width") ?? null;"#), "null");
    assert_eq!(r("return [e8.xServerVendor(), e8.xServerMaxRequestSize() ?? null];"), format!("[{:?},null]", if cfg!(target_os = "macos") { "Apple" } else { "The X.Org Foundation" }));
}

#[test]
fn selections_are_the_clipboard_and_the_editor_s_own() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let board = Arc::new(Mutex::new(Some("from elsewhere".to_string())));
    ed.set_clipboard(Box::new(Board(board.clone())));
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return [e8.nsGetSelection("CLIPBOARD"), e8.nsSelectionExistsP("CLIPBOARD"), e8.nsSelectionOwnerP("CLIPBOARD")];"#), r#"["from elsewhere",true,false]"#);
    assert_eq!(r(r#"e8.nsOwnSelectionInternal("CLIPBOARD", "mine"); return [e8.nsGetSelection("CLIPBOARD"), e8.nsSelectionOwnerP("CLIPBOARD")];"#), r#"["mine",true]"#);
    *board.lock().unwrap() = Some("theirs".to_string());
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return e8.nsSelectionOwnerP("CLIPBOARD");"#), "false");
    assert_eq!(r(r#"return [e8.nsSelectionExistsP(), e8.nsGetSelection(null) ?? null];"#), "[false,null]");
    assert_eq!(r(r#"e8.nsOwnSelectionInternal("PRIMARY", "picked"); return [e8.nsGetSelection("PRIMARY"), e8.nsSelectionOwnerP(), e8.nsSelectionExistsP("PRIMARY")];"#), r#"["picked",true,true]"#);
    assert_eq!(r(r#"e8.nsDisownSelectionInternal("PRIMARY"); return [e8.nsGetSelection("PRIMARY") ?? null, e8.nsSelectionOwnerP("PRIMARY")];"#), "[null,false]");
}
