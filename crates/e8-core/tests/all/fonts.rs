//! The font primitives with a front end's fonts, as a graphical frame
//! answers them: face-font, font-at, list-fonts, find-font, x-list-fonts,
//! query-font, font-info and char-displayable-p.

use std::sync::Arc;

use e8_core::layout::{FontMetrics, FontSpec, TextMetrics};
use e8_core::{Editor, Font, FontKind, Value, font_spec};

/// Cells with fonts: a monospace "Mono" and a proportional "Sans", 12 high,
/// with no glyph for U+E000.
struct WithFonts;

impl TextMetrics for WithFonts {
    fn advance(&self, _font: &FontSpec, _c: char) -> f32 {
        1.0
    }
    fn line_height(&self, _font: &FontSpec) -> f32 {
        1.0
    }
    fn char_width(&self) -> f32 {
        1.0
    }
    fn char_height(&self) -> f32 {
        1.0
    }
    fn uniform(&self) -> bool {
        true
    }
    fn font_metrics(&self, font: &FontSpec) -> Option<FontMetrics> {
        let size = 12.0 * font.scale;
        Some(FontMetrics {
            family: if font.proportional() { "Sans" } else { "Mono" }.into(),
            size,
            ascent: 10.0,
            descent: 2.0,
            space_width: 7.0,
            average_width: 7.0,
            max_width: 7.0,
            monospace: !font.proportional(),
            bold: font.bold,
            italic: font.italic,
        })
    }
    fn font_families(&self) -> Vec<String> {
        vec!["Sans".into(), "Mono".into()]
    }
    fn has_glyph(&self, _font: &FontSpec, c: char) -> bool {
        c != '\u{e000}'
    }
}

fn editor() -> Editor {
    let mut ed = Editor::new();
    ed.set_text_metrics(Arc::new(WithFonts));
    ed
}

fn sym(s: &str) -> Value {
    Value::Symbol(s.into())
}

#[test]
fn faces_are_drawn_in_open_fonts() {
    let mut ed = editor();
    assert_eq!(ed.face_font("default").as_deref(), Some("-*-Mono-regular-normal-normal-*-12-*-*-*-m-0-iso10646-1"));
    assert_eq!(ed.face_font("bold").as_deref(), Some("-*-Mono-bold-normal-normal-*-12-*-*-*-m-0-iso10646-1"));
    assert_eq!(ed.face_font("variable-pitch").as_deref().map(|n| n.contains("-Sans-") && n.contains("-p-")), Some(true));
    ed.type_text("abc");
    ed.buffer_mut().put_text_property(1..2, "face", Value::Str("italic".into()));
    let font = ed.font_at(1).expect("a font");
    assert_eq!((font.kind, font.get(":slant"), font.get(":family")), (FontKind::Object, sym("italic"), sym("Mono")));
    assert_eq!(ed.font_at(0).unwrap().get(":slant"), sym("normal"));
}

#[test]
fn fonts_are_listed_and_found() {
    let ed = editor();
    assert_eq!(ed.font_family_list(), vec!["Mono".to_string(), "Sans".to_string()]);
    let spec = font_spec(&[sym(":family"), Value::Str("mono".into()), sym(":weight"), sym("bold")]).unwrap();
    let fonts = ed.list_fonts(&spec, None);
    assert_eq!(fonts.len(), 2, "bold and bold italic");
    assert!(fonts.iter().all(|f| f.kind == FontKind::Entity && f.get(":weight") == sym("bold")));
    assert_eq!(ed.find_font(&font_spec(&[sym(":family"), Value::Str("Nope".into())]).unwrap()), None);
    assert_eq!(ed.x_list_fonts("-*-sans-bold-italic-*", None), vec!["-*-Sans-bold-italic-normal-*-*-*-*-*-p-*-iso10646-1".to_string()]);
    assert_eq!(ed.x_list_fonts("*", Some(3)).len(), 3);
}

#[test]
fn open_fonts_tell_their_metrics() {
    let ed = editor();
    let mut spec = Font::new(FontKind::Spec);
    spec.put(":family", Value::Str("Mono".into())).unwrap();
    let q = ed.query_font(&spec).unwrap();
    assert_eq!(q[0], Value::Str("-*-Mono-regular-normal-normal-*-12-*-*-*-m-0-iso10646-1".into()));
    assert_eq!(&q[2..8], &[12.0, 7.0, 10.0, 2.0, 7.0, 7.0].map(Value::Number));
    let info = ed.font_info("Mono-12").unwrap();
    assert_eq!((info.len(), info[3].clone()), (14, Value::Number(12.0)), "height is ascent and descent");
    assert_eq!(ed.font_info("Nope-12"), None);
    assert!(ed.char_displayable_p('a') && !ed.char_displayable_p('\u{e000}'));
    assert!(!ed.font_has_char_p(&spec, '\u{e000}'));
}

#[test]
fn characters_are_found_in_fonts_as_internal_char_font_finds_them() {
    let mut ed = editor();
    // With no position, the default face's font, and the character's own code.
    let (font, code) = ed.internal_char_font(None, Some('a' as u32)).unwrap().expect("a font");
    assert_eq!((font.kind, font.get(":family"), code), (FontKind::Object, sym("Mono"), 97));
    assert_eq!(ed.internal_char_font(None, Some(0xe000)).unwrap(), None, "no font has it");
    // At a position, in the faces there.
    ed.type_text("abc");
    ed.buffer_mut().put_text_property(1..2, "face", Value::Str("bold".into()));
    let (font, code) = ed.internal_char_font(Some(1), None).unwrap().unwrap();
    assert_eq!((font.get(":weight"), code), (sym("bold"), 'b' as u32));
    let err = ed.internal_char_font(Some(3), None).unwrap_err();
    assert_eq!(err.symbol(), "args-out-of-range");
    // A buffer in no window has no fonts, as in Emacs.
    ed.get_buffer_create("hidden");
    ed.set_current_buffer("hidden").unwrap();
    ed.insert("x").unwrap();
    assert_eq!(ed.internal_char_font(Some(0), None).unwrap(), None);
}

#[test]
fn glyphs_families_and_opened_fonts() {
    let ed = editor();
    let mut entity = Font::new(FontKind::Entity);
    entity.put(":family", Value::Str("Sans".into())).unwrap();
    let font = ed.open_font_entity(&entity, Some(24.0)).expect("opened");
    assert_eq!((font.kind, font.get(":family"), font.get(":size")), (FontKind::Object, sym("Sans"), Value::Number(24.0)));
    // Size 0 is 120 pixels, as font.c has it.
    assert_eq!(ed.open_font_entity(&entity, Some(0.0)).unwrap().get(":size"), Value::Number(120.0));
    // Its face attributes, as font-face-attributes: 24 pixels, a point a pixel as on Emacs's Mac frames.
    assert_eq!(font.face_attributes()[..4], [sym(":family"), Value::Str("Sans".into()), sym(":height"), Value::Number(240.0)]);
    let glyphs = ed.font_get_glyphs(&font, &['a', '\u{e000}']);
    let n = Value::Number;
    assert_eq!(glyphs[0], Value::List(vec![n(0.0), n(0.0), n(97.0), n(97.0), n(1.0), n(0.0), n(1.0), n(10.0), n(2.0), Value::Null]));
    assert_eq!(glyphs[1], Value::Null);
    // x-family-fonts, sorted by width, height, weight and slant, then family.
    let fonts = ed.x_family_fonts(Some("m*"));
    assert_eq!(fonts.len(), 4);
    let Value::List(first) = &fonts[0] else { panic!() };
    assert_eq!(first[..6], [Value::Str("Mono".into()), sym("normal"), n(0.0), sym("regular"), sym("normal"), Value::Bool(true)]);
    let Value::List(last) = &fonts[3] else { panic!() };
    assert_eq!((last[3].clone(), last[4].clone()), (sym("bold"), sym("italic")));
}
