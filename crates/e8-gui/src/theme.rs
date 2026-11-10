//! Colours and type, after ArtCraft's design language: hard edges, hairline
//! rules, a warm off-white or near-black page, one blue accent, Geist Mono
//! for text and Inter for interface labels.
//!
//! The colours come from the core's palette, which follows the ArtCraft
//! Launcher's theme (github.com/storytold/craft-launcher, MIT OR Apache-2.0)
//! and which faces use too. Drawing code reads [`Tokens`] or faces and never
//! hard-codes a colour.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use e8_core::{Color, palette};
use egui::{Color32, FontData, FontDefinitions, FontFamily};
use fontique::{Collection, CollectionOptions, FontStyle, FontWeight, FontWidth, SourceCache};

/// Colour tokens for one appearance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub dark: bool,
    /// The page: buffer and echo area background.
    pub bg: Color32,
    /// Wells, such as the mode line.
    pub sunken: Color32,
    /// Buffer text.
    pub ink: Color32,
    /// Emphasis, such as the buffer name.
    pub ink_strong: Color32,
    /// Secondary text, such as messages.
    pub muted: Color32,
    /// Tertiary text, such as completions.
    pub faint: Color32,
    /// Hairline rules.
    pub line: Color32,
    /// The brand blue, for surfaces.
    pub accent: Color32,
    /// The brand blue, for text.
    pub accent_ink: Color32,
    /// The active region: the brand blue, translucent so text stays readable.
    pub selection: Color32,
    pub bad: Color32,
    /// The cursor, ink unless a theme's `cursor` face says otherwise.
    pub cursor: Color32,
}

/// A core colour as egui's.
pub fn color32(c: Color) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r, c.g, c.b, c.a)
}

impl Tokens {
    /// The tokens for a dark or light background, from the core's palette,
    /// which both front ends share.
    pub fn new(dark: bool) -> Tokens {
        let named = |name: &str| color32(palette(name, dark).unwrap_or(Color { r: 255, g: 0, b: 255, a: 255 }));
        Tokens {
            dark,
            bg: named("bg"),
            sunken: named("sunken"),
            ink: named("ink"),
            ink_strong: named("ink-strong"),
            muted: named("muted"),
            faint: named("faint"),
            line: named("line"),
            accent: named("accent"),
            accent_ink: named("accent-ink"),
            selection: named("selection"),
            bad: named("bad"),
            cursor: named("ink"),
        }
    }

    /// The tokens a frame's faces make, where a theme has given them
    /// colours: the `default` face's for the page and its text, with the
    /// quieter inks mixed between them, and the `cursor` face's for the
    /// cursor. Without a theme, these tokens as they are.
    pub fn themed(self, fd: &e8_core::frame_description::FrameDescription) -> Tokens {
        let mut t = self;
        if let (Some(bg), Some(fg)) = (fd.default_style.background, fd.default_style.foreground) {
            let (bg, fg) = (color32(bg), color32(fg));
            let mix = |k: f32| Color32::from_rgb(
                (fg.r() as f32 * (1.0 - k) + bg.r() as f32 * k) as u8,
                (fg.g() as f32 * (1.0 - k) + bg.g() as f32 * k) as u8,
                (fg.b() as f32 * (1.0 - k) + bg.b() as f32 * k) as u8,
            );
            t.bg = bg;
            t.ink = fg;
            t.ink_strong = fg;
            t.muted = mix(0.3);
            t.faint = mix(0.55);
            t.line = mix(0.85);
            t.sunken = fd.chrome.mode_line.as_ref().and_then(|s| s.background).map_or(mix(0.9), color32);
            t.cursor = fg;
        }
        if let Some(c) = fd.chrome.cursor.as_ref().and_then(|s| s.background) {
            t.cursor = color32(c);
        }
        t
    }

    /// The tokens for the context's theme, which follows the system by default.
    pub fn get(ctx: &egui::Context) -> Tokens {
        Tokens::new(ctx.theme() == egui::Theme::Dark)
    }
}

/// Point size of buffer text.
pub const TEXT_SIZE: f32 = 14.0;
/// Line height as a multiple of the font's row height.
pub const LINE_SPACING: f32 = 1.3;

/// Whether bold text has no bold face of its own, so it is drawn twice,
/// a fraction of a pixel apart, to thicken it.
static FAUX_BOLD: AtomicBool = AtomicBool::new(true);

pub fn faux_bold() -> bool {
    FAUX_BOLD.load(Ordering::Relaxed)
}

/// The font family for bold buffer text.
pub fn bold_mono() -> FontFamily {
    FontFamily::Name("mono-bold".into())
}

/// Fonts to fall back on, by kind: Japanese and Chinese, Korean, emoji,
/// Hebrew and Arabic. Each list names macOS's font first, then Linux's and
/// Windows's, with how far to move its glyphs down, as a fraction of the
/// font size, so they sit on the main font's line: CJK fonts' taller ascent
/// lifts them otherwise. Hebrew and Arabic letters are spaced to the grid's
/// columns, as wide characters are, since these fonts are proportional.
const FALLBACKS: [(&[&str], f32); 5] = [
    (&["Hiragino Sans", "PingFang SC", "Noto Sans CJK JP", "Microsoft YaHei"], 0.15),
    (&["Apple SD Gothic Neo", "Noto Sans CJK KR", "Malgun Gothic"], 0.15),
    (&["Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji"], 0.0),
    (&["Arial Hebrew", "Noto Sans Hebrew", "DejaVu Sans Mono", "Arial"], 0.0),
    (&["Geeza Pro", "Noto Sans Arabic", "DejaVu Sans", "Arial"], 0.0),
];

/// Puts Geist Mono first for monospace text and Inter first for interface
/// text, if they are installed and `system_fonts` is on, and adds a bold
/// monospace family, Geist Mono Bold if installed. egui's built-in fonts stay
/// as fallbacks, so the editor looks plainer but works without them; without
/// a bold face, bold text uses the regular one. Fonts for CJK text and emoji
/// come last, from [`FALLBACKS`]. Returns the faces found.
pub fn install_fonts(ctx: &egui::Context, system_fonts: bool) -> Vec<&'static str> {
    let mut fonts = FontDefinitions::default();
    let mut found = Vec::new();
    if system_fonts {
        let mut collection = Collection::new(CollectionOptions { shared: false, system_fonts: true });
        let mut cache = SourceCache::default();
        for (name, family, weight) in [
            ("Geist Mono", FontFamily::Monospace, FontWeight::NORMAL),
            ("Inter", FontFamily::Proportional, FontWeight::NORMAL),
            ("Geist Mono Bold", bold_mono(), FontWeight::BOLD),
        ] {
            let family_name = name.trim_end_matches(" Bold");
            let Some(data) = load_family(&mut collection, &mut cache, family_name, weight) else { continue };
            fonts.font_data.insert(name.to_string(), Arc::new(data));
            fonts.families.entry(family).or_default().insert(0, name.to_string());
            found.push(name);
        }
        // For what the main fonts lack, such as CJK text and emoji, the first
        // installed of each kind, after all the others.
        for (kind, y_offset_factor) in FALLBACKS {
            let Some((name, mut data)) = kind.iter().find_map(|name| {
                load_family(&mut collection, &mut cache, name, FontWeight::NORMAL).map(|data| (*name, data))
            }) else {
                continue;
            };
            data.tweak.y_offset_factor = y_offset_factor;
            fonts.font_data.insert(name.to_string(), Arc::new(data));
            for family in [FontFamily::Monospace, FontFamily::Proportional] {
                fonts.families.entry(family).or_default().push(name.to_string());
            }
            found.push(name);
        }
    }
    FAUX_BOLD.store(!found.contains(&"Geist Mono Bold"), Ordering::Relaxed);
    // Whatever bold face there is comes first, then the regular monospace fonts.
    let mono = fonts.families.get(&FontFamily::Monospace).cloned().unwrap_or_default();
    fonts.families.entry(bold_mono()).or_default().extend(mono);
    record_underlines(&fonts);
    ctx.set_fonts(fonts);
    found
}

/// Loads the font families faces have named since the last frame, from the
/// system's fonts, each as an egui family of its own that falls back on the
/// monospace fonts for what it lacks. Returns whether any was loaded, so
/// the editor measures text in it from the next frame, when egui has it.
pub fn load_wanted_families(ctx: &egui::Context) -> bool {
    let wanted: Vec<String> = {
        let families = crate::metrics::FAMILIES.lock().unwrap_or_else(|e| e.into_inner());
        families.iter().filter(|(_, s)| **s == crate::metrics::Family::Wanted).map(|(n, _)| n.clone()).collect()
    };
    if wanted.is_empty() {
        return false;
    }
    let mut fonts = ctx.fonts(|f| f.definitions().clone());
    let fallback = fonts.families.get(&FontFamily::Monospace).cloned().unwrap_or_default();
    let mut loaded = false;
    SYSTEM_FONTS.with_borrow_mut(|system| {
        let (collection, cache) = system.get_or_insert_with(|| (Collection::new(CollectionOptions { shared: false, system_fonts: true }), SourceCache::default()));
        let mut families = crate::metrics::FAMILIES.lock().unwrap_or_else(|e| e.into_inner());
        for name in wanted {
            match load_family(collection, cache, &name, FontWeight::NORMAL) {
                Some(data) => {
                    let key = format!("family:{name}");
                    fonts.font_data.insert(key.clone(), Arc::new(data));
                    let mut chain = vec![key];
                    chain.extend(fallback.iter().cloned());
                    fonts.families.insert(FontFamily::Name(name.as_str().into()), chain);
                    families.insert(name, crate::metrics::Family::Loaded);
                    loaded = true;
                }
                None => {
                    families.insert(name, crate::metrics::Family::Missing);
                }
            }
        }
    });
    if loaded {
        record_underlines(&fonts);
        ctx.set_fonts(fonts);
    }
    loaded
}

/// Where each family's own font draws its underline: the top of the line
/// below the baseline and its thickness, as fractions of the font size,
/// from the font's `post` table, as Emacs takes them from the font.
static UNDERLINES: Mutex<BTreeMap<FontFamily, (f32, f32)>> = Mutex::new(BTreeMap::new());

fn record_underlines(fonts: &FontDefinitions) {
    let mut underlines = UNDERLINES.lock().unwrap_or_else(|e| e.into_inner());
    for (family, names) in &fonts.families {
        let Some(data) = names.first().and_then(|name| fonts.font_data.get(name)) else { continue };
        let Ok(font) = skrifa::FontRef::from_index((*data.font).as_ref(), data.index) else { continue };
        let metrics = skrifa::metrics::Metrics::new(&font, skrifa::instance::Size::unscaled(), skrifa::instance::LocationRef::default());
        if let Some(underline) = metrics.underline.filter(|_| metrics.units_per_em > 0) {
            let em = f32::from(metrics.units_per_em);
            underlines.insert(family.clone(), (-underline.offset / em, underline.thickness / em));
        }
    }
}

/// Where text in `family` at `size` points is underlined: how far below
/// the baseline the line's top is, and how thick it is, in points. A font
/// that says nothing is underlined a tenth of its size below the baseline.
pub fn underline_metrics(family: &FontFamily, size: f32) -> (f32, f32) {
    let underlines = UNDERLINES.lock().unwrap_or_else(|e| e.into_inner());
    let (position, thickness) = underlines.get(family).copied().unwrap_or((0.1, 0.05));
    (position * size, thickness * size)
}

thread_local! {
    /// The system's fonts, found once, for loading families faces name.
    static SYSTEM_FONTS: std::cell::RefCell<Option<(Collection, SourceCache)>> = const { std::cell::RefCell::new(None) };
}

/// A face of an installed font family, of the given weight if it has one.
fn load_family(collection: &mut Collection, cache: &mut SourceCache, name: &str, weight: FontWeight) -> Option<FontData> {
    let family = collection.family_by_name(name)?;
    let index = family
        .match_index(FontWidth::NORMAL, FontStyle::Normal, weight, false)
        .unwrap_or(family.default_font_index());
    let font = family.fonts().get(index)?;
    let (blob, _id) = font.load(Some(cache))?.into_raw_parts();
    Some(FontData::from_blob(blob, font.index()))
}
