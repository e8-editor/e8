//! Face and font internals, as xfaces.c, font.c and fontset.c give them
//! to faces.el (ADR 0085). Faces are named by symbols or strings, and an
//! attribute's name by `:weight` or `weight`; a face's vector is an array,
//! `["face", family, foundry, ...]`, its values as Lisp's: names as
//! symbols, flags as true or null, `unspecified` where nothing is set.

use crate::*;
use crate::natives::{Opt, natives};

/// A face's name, from a symbol or a string, as Emacs's CHECK_SYMBOL.
fn face_name(value: &EditorValue) -> Result<String> {
    match value {
        EditorValue::Symbol(s) | EditorValue::Str(s) => Ok(s.clone()),
        other => Err(e8_core::xfaces::wrong_type("symbolp", other)),
    }
}

fn font_of(value: EditorValue, predicate: &str) -> Result<e8_core::Font> {
    match value {
        EditorValue::Font(font) => Ok(*font),
        other => Err(e8_core::xfaces::wrong_type(predicate, &other)),
    }
}

fn character(value: &EditorValue) -> Result<char> {
    match value {
        EditorValue::Str(s) if s.chars().count() == 1 => Ok(s.chars().next().unwrap_or_default()),
        EditorValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 => char::from_u32(*n as u32).ok_or_else(|| e8_core::xfaces::wrong_type("characterp", value)),
        other => Err(e8_core::xfaces::wrong_type("characterp", other)),
    }
}

natives! {
    /// Make a face with every attribute unspecified, or empty an existing one, as internal-make-lisp-face; gives its vector.
    #[ts = "(face: string | symbol, frame?: Frame | boolean | number | null): Value[]"]
    pub fn internalMakeLispFace(ed, face: EditorValue, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        Ok(ed.internal_make_lisp_face(&face_name(&face)?))
    }

    /// A face's vector if face is a face, as internal-lisp-face-p, else undefined.
    #[ts = "(face: string | symbol, frame?: Frame | boolean | number | null): Value[] | undefined"]
    pub fn internalLispFaceP(ed, face: EditorValue, frame: Opt<EditorValue>) -> Option<EditorValue> {
        if ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))? == e8_core::xfaces::FaceFrame::Global {
            return Err(e8_core::xfaces::wrong_type("frame-live-p", &EditorValue::Bool(true)));
        }
        Ok(ed.internal_lisp_face_p(&face_name(&face)?))
    }

    /// Make `to` a face with `from`'s attributes, as internal-copy-lisp-face; gives `to`. `frame` t copies the global definitions, else it must be a frame, as in Emacs.
    #[ts = "(from: string | symbol, to: string | symbol, frame: Frame | boolean | null, newFrame?: Frame | null): string | symbol"]
    pub fn internalCopyLispFace(ed, from: EditorValue, to: EditorValue, frame: EditorValue, new_frame: Opt<EditorValue>) -> EditorValue {
        if ed.face_frame(&frame)? != e8_core::xfaces::FaceFrame::Global {
            if !matches!(frame, EditorValue::Frame(_)) {
                return Err(e8_core::xfaces::wrong_type("frame-live-p", &frame));
            }
            if let Some(f) = new_frame.0.filter(|f| !matches!(f, EditorValue::Null))
                && ed.face_frame(&f)? != e8_core::xfaces::FaceFrame::Frame
            {
                return Err(e8_core::xfaces::wrong_type("frame-live-p", &f));
            }
        }
        ed.internal_copy_lisp_face(&face_name(&from)?, &face_name(&to)?)?;
        Ok(to)
    }

    /// Set one of a face's attributes with xfaces.c's checks, as internal-set-lisp-face-attribute; makes the face if there is none and gives its name.
    #[ts = "(face: string | symbol, attribute: string | symbol, value: Value, frame?: Frame | boolean | number | null): string | symbol"]
    pub fn internalSetLispFaceAttribute(ed, face: EditorValue, attribute: EditorValue, value: EditorValue, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        ed.internal_set_lisp_face_attribute(&face_name(&face)?, &attribute, &value)?;
        Ok(face)
    }

    /// One of a face's own attributes, as internal-get-lisp-face-attribute.
    #[ts = "(face: string | symbol, attribute: string | symbol, frame?: Frame | boolean | null): Value"]
    pub fn internalGetLispFaceAttribute(ed, face: EditorValue, attribute: EditorValue, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        ed.internal_get_lisp_face_attribute(&face_name(&face)?, &attribute)
    }

    /// Whether two faces' attributes are all equal, as internal-lisp-face-equal-p.
    #[ts = "(face1: string | symbol, face2: string | symbol, frame?: Frame | boolean | null): boolean"]
    pub fn internalLispFaceEqualP(ed, face1: EditorValue, face2: EditorValue, frame: Opt<EditorValue>) -> bool {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        ed.internal_lisp_face_equal_p(&face_name(&face1)?, &face_name(&face2)?)
    }

    /// Whether a face sets no attribute, as internal-lisp-face-empty-p.
    #[ts = "(face: string | symbol, frame?: Frame | boolean | null): boolean"]
    pub fn internalLispFaceEmptyP(ed, face: EditorValue, frame: Opt<EditorValue>) -> bool {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        ed.internal_lisp_face_empty_p(&face_name(&face)?)
    }

    /// Merge a face's global definition into its definition on a frame, as internal-merge-in-global-face: one and the same in E8, so this only checks the face exists.
    #[ts = "(face: string | symbol, frame: Frame): undefined"]
    pub fn internalMergeInGlobalFace(ed, face: EditorValue, frame: EditorValue) -> Option<bool> {
        if ed.face_frame(&frame)? != e8_core::xfaces::FaceFrame::Frame {
            return Err(e8_core::xfaces::wrong_type("frame-live-p", &frame));
        }
        ed.internal_merge_in_global_face(&face_name(&face)?)?;
        Ok(None)
    }

    /// Set an attribute from an X resource's string, as internal-set-lisp-face-attribute-from-resource.
    #[ts = "(face: string | symbol, attribute: string | symbol, value: string, frame?: Frame | null): string | symbol"]
    pub fn internalSetLispFaceAttributeFromResource(ed, face: EditorValue, attribute: EditorValue, value: String, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        ed.internal_set_lisp_face_attribute_from_resource(&face_name(&face)?, &attribute, &value)?;
        Ok(face)
    }

    /// An X resource's value for a frame, as internal-face-x-get-resource: E8 reads no X resources, so always undefined.
    #[ts = "(resource: string, klass: string, frame?: Frame | null): string | undefined"]
    pub fn internalFaceXGetResource(ed, _resource: String, _class: String, frame: Opt<EditorValue>) -> Option<String> {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        Ok(None)
    }

    /// The vector of attributes a face reference gives, as face-attributes-as-vector: a face's name, a plist, or a list of them.
    #[ts = "(plist: Value): Value[]"]
    pub fn faceAttributesAsVector(ed, plist: EditorValue) -> EditorValue {
        Ok(ed.face_attributes_as_vector(&plist))
    }

    /// Each face and its vector, as frame--face-hash-table holds them.
    #[ts = "(frame?: Frame | null): Map<string, Value[]>"]
    fn frameFaceHashTable(ed, frame: Opt<EditorValue>) -> EditorValue {
        if ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))? == e8_core::xfaces::FaceFrame::Global {
            return Err(e8_core::xfaces::wrong_type("frame-live-p", &EditorValue::Bool(true)));
        }
        Ok(EditorValue::List(ed.face_vectors().into_iter().map(|(name, v)| EditorValue::List(vec![EditorValue::Str(name), v])).collect()))
    }

    /// Set the order fonts are matched in, as internal-set-font-selection-order: `:width`, `:height`, `:weight` and `:slant` in some order.
    #[ts = "(order: Value[]): undefined"]
    pub fn internalSetFontSelectionOrder(ed, order: EditorValue) -> Option<bool> {
        ed.internal_set_font_selection_order(&order)?;
        Ok(None)
    }

    /// Set the families to try in place of others, as internal-set-alternative-font-family-alist; gives the alist kept, its names symbols.
    #[ts = "(alist: string[][]): Value[][]"]
    pub fn internalSetAlternativeFontFamilyAlist(ed, alist: EditorValue) -> EditorValue {
        ed.internal_set_alternative_fonts(&alist, false)
    }

    /// Set the registries to try in place of others, as internal-set-alternative-font-registry-alist; gives the alist kept, downcased.
    #[ts = "(alist: string[][]): string[][]"]
    pub fn internalSetAlternativeFontRegistryAlist(ed, alist: EditorValue) -> EditorValue {
        ed.internal_set_alternative_fonts(&alist, true)
    }

    /// Whether object is a bitmap spec, as bitmap-spec-p: a file name, or [width, height, data] with data long enough.
    #[ts = "(object: Value): boolean"]
    pub fn bitmapSpecP(_ed, object: EditorValue) -> bool {
        Ok(e8_core::xfaces::bitmap_spec_p(&object))
    }

    /// Forget resolved faces, as clear-face-cache.
    #[ts = "(thoroughly?: boolean): undefined"]
    pub fn clearFaceCache(ed, _thoroughly: Opt<EditorValue>) -> Option<bool> {
        ed.clear_face_cache();
        Ok(None)
    }

    /// Whether a terminal shows bold faces in its default colours swapped, as tty-suppress-bold-inverse-default-colors; gives suppress.
    #[ts = "(suppress: Value): Value"]
    pub fn ttySuppressBoldInverseDefaultColors(ed, suppress: EditorValue) -> EditorValue {
        ed.tty_suppress_bold_inverse_default_colors(suppress.is_true());
        Ok(suppress)
    }

    /// The colours a file names, a line each as `R G B NAME`, as x-load-color-file: [name, rgb] pairs, the last line first; undefined if there is no such file.
    #[ts = "(filename: string): [string, number][] | undefined"]
    pub fn xLoadColorFile(ed, filename: String) -> Option<EditorValue> {
        let path = ed.expand_file_name(&filename);
        Ok(match e8_core::xfaces::x_load_color_file(&path.to_string_lossy()) {
            EditorValue::List(items) if !items.is_empty() => Some(EditorValue::List(items)),
            _ => None,
        })
    }

    /// The fonts of a family, with `*` and `?`, or all, as x-family-fonts: [family, width, pointSize, weight, slant, fixedP, full, registry] each.
    #[ts = "(family?: string | null, frame?: Frame | null): Value[][]"]
    pub fn xFamilyFonts(ed, family: Opt<String>, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        Ok(EditorValue::List(ed.x_family_fonts(family.0.as_deref())))
    }

    /// The font a character is shown in and its glyph code, as internal-char-font: the character at a position, or `ch` there, or `ch` in the default face with no position; undefined on a terminal or where no font has it.
    #[ts = "(position: number | null, ch?: number | string | null): [Font, number] | undefined"]
    pub fn internalCharFont(ed, position: Opt<EditorValue>, ch: Opt<EditorValue>) -> Option<EditorValue> {
        let position = match position.0 {
            None | Some(EditorValue::Null) => None,
            Some(EditorValue::Number(n)) if n >= 0.0 && n.fract() == 0.0 => Some(n as usize),
            Some(other) => return Err(e8_core::xfaces::wrong_type("integer-or-marker-p", &other)),
        };
        let ch = match ch.0.filter(|c| !matches!(c, EditorValue::Null)) {
            Some(c) => Some(character(&c)? as u32),
            None => None,
        };
        Ok(ed.internal_char_font(position, ch)?.map(|(font, code)| EditorValue::List(vec![EditorValue::Font(Box::new(font)), EditorValue::Number(f64::from(code))])))
    }

    /// The face attributes a font gives, as font-face-attributes: a plist of `:family`, `:height`, `:weight`, `:slant` and `:width`, each where the font has it.
    #[ts = "(font: Font | string, frame?: Frame | null): Value[]"]
    pub fn fontFaceAttributes(ed, font: EditorValue, frame: Opt<EditorValue>) -> EditorValue {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        let font = match font {
            EditorValue::Font(f) => *f,
            EditorValue::Str(ref name) => e8_core::font::font_spec_from_name(name).ok_or_else(|| Error::signal("error", format!("Invalid font name: \"{name}\""), vec![EditorValue::Str("Invalid font name".into()), font.clone()]))?,
            other => return Err(Error::signal("error", format!("Invalid font object: {other}"), vec![EditorValue::Str("Invalid font object".into()), other])),
        };
        Ok(EditorValue::List(font.face_attributes()))
    }

    /// Open a font entity, as open-font: at an integer size in pixels, a float in points, or the entity's own; undefined on a terminal.
    #[ts = "(fontEntity: Font, size?: number | null, frame?: Frame | null): Font | undefined"]
    pub fn openFont(ed, entity: EditorValue, size: Opt<f64>, frame: Opt<EditorValue>) -> Option<EditorValue> {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        let entity = font_of(entity, "font-entity")?;
        if entity.kind != e8_core::FontKind::Entity {
            return Err(e8_core::xfaces::wrong_type("font-entity", &EditorValue::Font(Box::new(entity))));
        }
        Ok(ed.open_font_entity(&entity, size.0).map(|f| EditorValue::Font(Box::new(f))))
    }

    /// Close an open font, as close-font; E8's front ends keep their fonts open.
    #[ts = "(fontObject: Font, frame?: Frame | null): undefined"]
    pub fn closeFont(ed, font: EditorValue, frame: Opt<EditorValue>) -> Option<bool> {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        let font = font_of(font, "font-object")?;
        if font.kind != e8_core::FontKind::Object {
            return Err(e8_core::xfaces::wrong_type("font-object", &EditorValue::Font(Box::new(font))));
        }
        Ok(None)
    }

    /// An open font's glyphs for the characters from `from` to `to` in the current buffer, or in a string or array of characters, as font-get-glyphs: each [from, to, c, code, width, lbearing, rbearing, ascent, descent, null], or null where the font has none.
    #[ts = "(fontObject: Font, from: number, to: number, object?: string | number[] | null): (Value[] | null)[] | undefined"]
    pub fn fontGetGlyphs(ed, font: EditorValue, from: usize, to: usize, object: Opt<EditorValue>) -> Option<EditorValue> {
        let font = font_of(font, "font-object")?;
        let (from, to) = (from.min(to), from.max(to));
        let chars: Vec<char> = match object.0 {
            None | Some(EditorValue::Null) => {
                let b = ed.buffer();
                if from < b.point_min() || to > b.point_max() {
                    return Err(Error::signal("args-out-of-range", format!("Args out of range: {}, {}", from + 1, to + 1), vec![]));
                }
                ed.region_text(from, to)?.chars().collect()
            }
            Some(EditorValue::Str(s)) => {
                let chars: Vec<char> = s.chars().collect();
                if to > chars.len() {
                    return Err(Error::signal("args-out-of-range", format!("Args out of range: \"{s}\", {from}, {to}"), vec![]));
                }
                chars[from..to].to_vec()
            }
            Some(EditorValue::List(items)) => {
                if to > items.len() {
                    return Err(Error::signal("args-out-of-range", format!("Args out of range: {from}, {to}"), vec![]));
                }
                items[from..to].iter().map(character).collect::<Result<_>>()?
            }
            Some(other) => return Err(e8_core::xfaces::wrong_type("arrayp", &other)),
        };
        if chars.is_empty() {
            return Ok(None);
        }
        Ok(Some(EditorValue::List(ed.font_get_glyphs(&font, &chars))))
    }

    /// Whether a font spec matches a font, as font-match-p.
    #[ts = "(spec: Font, font: Font): boolean"]
    pub fn fontMatchP(_ed, spec: EditorValue, font: EditorValue) -> bool {
        let spec = font_of(spec, "font-spec")?;
        if spec.kind != e8_core::FontKind::Spec {
            return Err(e8_core::xfaces::wrong_type("font-spec", &EditorValue::Font(Box::new(spec))));
        }
        let font = font_of(font, "font")?;
        Ok(spec.match_p(&font))
    }

    /// The variation glyphs a font has for a character, as font-variation-glyphs: [selector, glyph] pairs; E8's front ends report none.
    #[ts = "(fontObject: Font, character: number | string): [number, number][]"]
    pub fn fontVariationGlyphs(_ed, font: EditorValue, c: EditorValue) -> Vec<EditorValue> {
        let font = font_of(font, "font-object")?;
        if font.kind != e8_core::FontKind::Object {
            return Err(e8_core::xfaces::wrong_type("font-object", &EditorValue::Font(Box::new(font))));
        }
        character(&c)?;
        Ok(Vec::new())
    }

    /// Shape a glyph-string, as font-shape-gstring: E8's front ends shape text as they draw it, so this gives undefined, as Emacs does for a font that cannot shape.
    #[ts = "(gstring: Value[], direction?: string | symbol | null): Value[] | undefined"]
    pub fn fontShapeGstring(_ed, gstring: EditorValue, _direction: Opt<EditorValue>) -> Option<EditorValue> {
        match &gstring {
            EditorValue::List(items) if matches!(items.first(), Some(EditorValue::List(_))) => Ok(None),
            other => Err(Error::signal("error", format!("Invalid glyph-string: : {other}"), vec![EditorValue::Str("Invalid glyph-string: ".into()), other.clone()])),
        }
    }

    /// A frame's font cache, as frame-font-cache, for debugging: E8 keeps none, so undefined.
    #[ts = "(frame?: Frame | null): undefined"]
    pub fn frameFontCache(ed, frame: Opt<EditorValue>) -> Option<bool> {
        ed.face_frame(&frame.0.unwrap_or(EditorValue::Null))?;
        Ok(None)
    }

    /// Clear every frame's font cache, as clear-font-cache.
    #[ts = "(): undefined"]
    pub fn clearFontCache(ed) -> Option<bool> {
        ed.clear_face_cache();
        Ok(None)
    }

    /// The fontsets' names, the newest first, as fontset-list.
    pub fn fontsetList(ed) -> Vec<String> {
        Ok(ed.fontset_list())
    }

    /// The name of the fontset a pattern matches, as query-fontset: with `*` and `?`, a short name such as "fontset-default", or with `regexp` an Emacs regexp.
    #[ts = "(pattern: string, regexp?: boolean): string | undefined"]
    pub fn queryFontset(ed, pattern: String, regexp: Opt<EditorValue>) -> Option<String> {
        Ok(ed.query_fontset(&pattern, regexp.0.is_some_and(|r| r.is_true())))
    }

    /// Make a fontset give a font for characters, as set-fontset-font: a character from U+0080, a range [from, to], a script or charset symbol, or null for the rest; `add` "prepend" or "append" keeps the fonts it gave. The font is a font spec, [family, registry], a name, or null for none. A fontset of true or null is the default one.
    #[ts = "(fontset: string | boolean | null, characters: Value, fontSpec: Value, frame?: Frame | null, add?: string | symbol | null): undefined"]
    pub fn setFontsetFont(ed, fontset: EditorValue, characters: EditorValue, font: EditorValue, _frame: Opt<EditorValue>, add: Opt<EditorValue>) -> Option<bool> {
        ed.set_fontset_font(&fontset, &characters, &font, &add.0.unwrap_or(EditorValue::Null))?;
        Ok(None)
    }

    /// The font a fontset gives a character, as fontset-font, as [family, registry]; with `all`, every one.
    #[ts = "(name: string | boolean | null, ch: number, all?: boolean): Value"]
    pub fn fontsetFont(ed, name: EditorValue, c: EditorValue, all: Opt<EditorValue>) -> EditorValue {
        ed.fontset_font(&name, &c, all.0.is_some_and(|a| a.is_true()))
    }

    /// What a fontset holds, as fontset-info: a char-table whose values are lists of [font] for each font a range is given, E8 opening none itself, its extra slot the default fontset's for another. Only on a window system.
    #[ts = "(fontset: string | boolean | null, frame?: FrameLike | null): CharTable"]
    pub fn fontsetInfo(ed, fontset: EditorValue, _frame: Opt<EditorValue>) -> EditorValue {
        ed.fontset_info(&fontset)
    }

    /// Make a fontset from an XLFD name and [target, font] pairs, as new-fontset; gives its name.
    #[ts = "(name: string, fontlist: Value[]): string"]
    pub fn newFontset(ed, name: String, fontlist: EditorValue) -> String {
        ed.new_fontset(&name, &fontlist)
    }
}
