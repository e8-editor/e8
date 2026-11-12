//! The GUI's fonts as the core measures text with them ([ADR 0029]): egui's
//! glyph advances, in points, for the monospace and proportional families
//! at each face's size.
//!
//! [ADR 0029]: ../../../docs/adr/0029-redisplay-beyond-rows.md

use std::collections::HashMap;
use std::sync::Mutex;

use std::sync::OnceLock;

use e8_core::layout::{FontMetrics, FontSpec, TextMetrics};
use egui::{FontFamily, FontId};

use crate::theme::{TEXT_SIZE, bold_mono};

/// The font egui draws a face's text in: the family a face names, once the
/// window has loaded it from the system's fonts; else the bold monospace
/// family for bold fixed-width text, which is the regular one where there
/// is no bold font, and Inter for proportional text, each at the face's size.
pub fn font_id(font: &FontSpec) -> FontId {
    if let Some(name) = font.family.as_deref().filter(|n| !generic_family(n))
        && let Some(family) = named_family(name)
    {
        return FontId::new(TEXT_SIZE * font.scale, family);
    }
    let family = if font.proportional() {
        FontFamily::Proportional
    } else if font.bold {
        bold_mono()
    } else {
        FontFamily::Monospace
    };
    FontId::new(TEXT_SIZE * font.scale, family)
}

/// Family names that stand for egui's own families rather than a font,
/// as Emacs's `fixed-pitch` and `variable-pitch` faces name them.
fn generic_family(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "monospace" | "fixed" | "fixed-pitch" | "sans serif" | "sans" | "serif" | "variable-pitch" | "proportional")
}

/// Where each family a face named stands: loaded into egui, not installed,
/// or wanted, for the window to load between frames.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Family {
    Loaded,
    Missing,
    Wanted,
}

pub(crate) static FAMILIES: Mutex<std::collections::BTreeMap<String, Family>> = Mutex::new(std::collections::BTreeMap::new());

/// Whether the window loaded a font family a face named: `Some(true)` once
/// loaded, `Some(false)` if it is not installed, `None` before it tried.
pub fn family_loaded(name: &str) -> Option<bool> {
    match FAMILIES.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
        Some(Family::Loaded) => Some(true),
        Some(Family::Missing) => Some(false),
        _ => None,
    }
}

/// egui's family for a font family by name, if the window has loaded it;
/// otherwise asks for it, and the caller uses another meanwhile.
fn named_family(name: &str) -> Option<FontFamily> {
    let mut families = FAMILIES.lock().unwrap_or_else(|e| e.into_inner());
    match families.get(name) {
        Some(Family::Loaded) => Some(FontFamily::Name(name.into())),
        Some(_) => None,
        None => {
            families.insert(name.to_string(), Family::Wanted);
            None
        }
    }
}

/// A key for a font in the measures kept: its family's name as a number.
fn family_key(font: &FontSpec) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    font.family.hash(&mut h);
    h.finish()
}

/// A font's size, family, whether proportional and bold, and a character.
type AdvanceKey = (u32, u64, bool, bool, char);

pub struct EguiMetrics {
    ctx: egui::Context,
    char_width: f32,
    line_height: f32,
    /// Advances already measured, by font (its size, family, whether
    /// proportional and bold) and character.
    advances: Mutex<HashMap<AdvanceKey, f32>>,
    /// The system's font families and egui's own, found once when asked.
    families: OnceLock<Vec<String>>,
    /// Ascents already measured, by font.
    ascents: Mutex<HashMap<(u32, bool, bool, char), f32>>,
}

impl EguiMetrics {
    /// Metrics for the default font's character width and line height.
    pub fn new(ctx: egui::Context, char_width: f32, line_height: f32) -> EguiMetrics {
        EguiMetrics {
            ctx,
            char_width,
            line_height,
            advances: Mutex::new(HashMap::new()),
            ascents: Mutex::new(HashMap::new()),
            families: OnceLock::new(),
        }
    }
}

impl TextMetrics for EguiMetrics {
    fn fringes(&self) -> bool {
        true
    }

    /// The GUI's mode line and header line are bars a line tall with room
    /// above and below; text starts below a margin, and the fringes are
    /// the room each side.
    fn window_chrome(&self) -> e8_core::layout::WindowChrome {
        use crate::app::{BAR_PAD, PAD_X, PAD_Y};
        let bar = self.line_height + 2.0 * BAR_PAD;
        e8_core::layout::WindowChrome { mode_line: bar, header_line: bar, text_top: PAD_Y, fringes: 2.0 * PAD_X, divider: 0.0 }
    }

    fn advance(&self, font: &FontSpec, c: char) -> f32 {
        let key = (font.scale.to_bits(), family_key(font), font.proportional(), font.bold, c);
        if let Some(&w) = self.advances.lock().expect("not poisoned").get(&key) {
            return w;
        }
        let id = font_id(font);
        let w = self.ctx.fonts_mut(|f| f.glyph_width(&id, c));
        self.advances.lock().expect("not poisoned").insert(key, w);
        w
    }

    fn line_height(&self, font: &FontSpec) -> f32 {
        self.line_height * font.scale
    }

    fn char_width(&self) -> f32 {
        self.char_width
    }

    fn char_height(&self) -> f32 {
        self.line_height
    }

    /// The font egui draws a face in: the first of its family's fonts,
    /// at the face's size, its ascent where egui puts the baseline.
    fn font_metrics(&self, font: &FontSpec) -> Option<FontMetrics> {
        let id = font_id(font);
        let family = self.ctx.fonts(|f| f.definitions().families.get(&id.family).and_then(|names| names.first().cloned()))?;
        let height = self.line_height(font);
        let ascent = self.ascent(font);
        let (space, average, widest) = self.ctx.fonts_mut(|f| {
            let space = f.glyph_width(&id, ' ');
            let widths: Vec<f32> = ('!'..='~').map(|c| f.glyph_width(&id, c)).collect();
            let average = widths.iter().sum::<f32>() / widths.len() as f32;
            (space, average, widths.into_iter().fold(0.0, f32::max))
        });
        Some(FontMetrics {
            family,
            size: id.size,
            ascent,
            descent: height - ascent,
            space_width: space,
            average_width: average,
            max_width: widest,
            monospace: !font.proportional(),
            bold: font.bold,
            italic: font.italic,
        })
    }

    fn font_families(&self) -> Vec<String> {
        self.families
            .get_or_init(|| {
                let mut collection = fontique::Collection::new(fontique::CollectionOptions { shared: false, system_fonts: true });
                let mut names: Vec<String> = collection.family_names().map(str::to_string).collect();
                self.ctx.fonts(|f| names.extend(f.definitions().font_data.keys().cloned()));
                names
            })
            .clone()
    }

    fn has_glyph(&self, font: &FontSpec, c: char) -> bool {
        self.ctx.fonts_mut(|f| f.has_glyph(&font_id(font), c))
    }

    fn ascent(&self, font: &FontSpec) -> f32 {
        let key = (font.scale.to_bits(), font.proportional(), font.bold, '\0');
        if let Some(&a) = self.ascents.lock().expect("not poisoned").get(&key) {
            return a;
        }
        let id = font_id(font);
        let galley = self.ctx.fonts_mut(|f| f.layout_no_wrap("M".into(), id, egui::Color32::WHITE));
        let height = self.line_height(font);
        // Where egui puts the baseline in a line of the font's height.
        let a = galley.rows.first().and_then(|r| r.row.glyphs.first()).map_or(height * 0.8, |g| g.pos.y + (height - galley.size().y) / 2.0);
        self.ascents.lock().expect("not poisoned").insert(key, a);
        a
    }

    fn font_size(&self) -> f32 {
        TEXT_SIZE
    }

    fn images(&self) -> bool {
        true
    }
}
