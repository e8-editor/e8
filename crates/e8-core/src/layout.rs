//! Where text goes in a window, as Emacs's redisplay works it out: each
//! glyph's advance and each row's height, measured with metrics the front
//! end supplies, as Emacs asks its font backend ([ADR 0029]).
//!
//! The core measures in columns of the default font's characters and
//! lines of its height, as Emacs's canonical character units, which the
//! metrics turn into the front end's own: points in the GUI, cells in a
//! terminal. Text in the default font's size and a fixed-pitch family lies
//! on the grid, a column a character, and is measured by counting, as
//! before; only rows with other sizes or a proportional font are measured
//! glyph by glyph.
//!
//! [ADR 0029]: ../../../docs/adr/0029-redisplay-beyond-rows.md

use std::sync::Arc;

use unicode_width::UnicodeWidthChar;

use crate::buffer::Buffer;
use crate::display::Glyph;
use crate::editor::Editor;
use crate::faces::Style;
use crate::rows::{Row, Segment};
use crate::window::WindowId;

/// A font as metrics see it: its family, its size as a factor of the
/// default font's, and whether it is bold or italic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontSpec {
    pub family: Option<String>,
    pub scale: f32,
    pub bold: bool,
    pub italic: bool,
}

impl FontSpec {
    /// The font a style draws in.
    pub fn of(style: &Style) -> FontSpec {
        FontSpec { family: style.family.clone(), scale: style.scale, bold: style.bold, italic: style.italic }
    }

    /// The default face's font.
    pub fn default_font() -> FontSpec {
        FontSpec { scale: 1.0, ..FontSpec::default() }
    }

    /// Whether it is a proportional font rather than a monospace one.
    pub fn proportional(&self) -> bool {
        self.family.as_deref().is_some_and(|f| !crate::faces::is_fixed_family(f))
    }
}

/// What of a window is not text, in a front end's units: its mode line's and
/// header line's heights, the space above its text, its fringes together,
/// and the divider on the right of a window with another beside it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowChrome {
    pub mode_line: f32,
    pub header_line: f32,
    pub text_top: f32,
    pub fringes: f32,
    pub divider: f32,
}

/// How big characters and lines are in a front end's fonts, in its own
/// units, as Emacs's font backend tells redisplay.
pub trait TextMetrics: Send + Sync {
    /// How far a character moves the next one along, in a font.
    fn advance(&self, font: &FontSpec, c: char) -> f32;
    /// How tall a line of a font is.
    fn line_height(&self, font: &FontSpec) -> f32;
    /// The default font's character width, Emacs's `frame-char-width`.
    fn char_width(&self) -> f32;
    /// The default font's line height, Emacs's `frame-char-height`.
    fn char_height(&self) -> f32;
    /// Whether every font is the default's size and fixed width, as a
    /// terminal's cells are, so every row lies on the grid.
    fn uniform(&self) -> bool {
        false
    }
    /// How much of a window is not text, in these units: what its mode line
    /// and header line take, how far its text starts below its top, its
    /// fringes and its divider across, as the front end draws them. The
    /// core sizes windows with it, as Emacs's window.c does with the mode
    /// line's height and the fringes' widths. A terminal's default: a line
    /// each for the mode line and header line, a column for the divider.
    fn window_chrome(&self) -> WindowChrome {
        WindowChrome { mode_line: self.char_height(), header_line: self.char_height(), text_top: 0.0, fringes: 0.0, divider: self.char_width() }
    }
    /// Whether windows have fringes beside their text, as a graphical
    /// frame's do, where the arrows for continued and truncated lines go.
    /// Without them, as on a terminal, a continued line ends with a `\` in
    /// the last column, which the text then cannot use.
    fn fringes(&self) -> bool {
        false
    }
    /// The font a front end draws `font` in, as Emacs's font backend opens
    /// one for a face, or none where faces have no fonts, as on a terminal.
    fn font_metrics(&self, font: &FontSpec) -> Option<FontMetrics> {
        let _ = font;
        None
    }
    /// The font families the front end can draw in, as `font-family-list`.
    fn font_families(&self) -> Vec<String> {
        Vec::new()
    }
    /// Whether the font a front end draws `font` in, its fallbacks
    /// included, has a glyph for a character.
    fn has_glyph(&self, font: &FontSpec, c: char) -> bool {
        let _ = (font, c);
        true
    }
    /// How far a font's glyphs rise above its baseline, which a row with
    /// an image needs to sit the image on it as Emacs does.
    fn ascent(&self, font: &FontSpec) -> f32 {
        (self.line_height(font) * 0.8).round()
    }
    /// The default font's size, for image sizes given in `em`.
    fn font_size(&self) -> f32 {
        self.char_height()
    }
    /// Whether frames show images, as Emacs's graphical frames do. Without,
    /// as on a terminal, the text an image's display property is on shows.
    fn images(&self) -> bool {
        false
    }
}

/// An open font, as a front end draws in it: its family's name, and its
/// size and metrics in the front end's units, which are pixels to Emacs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontMetrics {
    pub family: String,
    pub size: f32,
    pub ascent: f32,
    pub descent: f32,
    pub space_width: f32,
    pub average_width: f32,
    pub max_width: f32,
    pub monospace: bool,
    pub bold: bool,
    pub italic: bool,
}

/// A terminal's metrics, which headless editors use too: a character is a
/// cell wide, or two for wide ones, and a line a cell high, whatever the
/// face, as on Emacs's terminal frames.
pub struct CellMetrics;

impl TextMetrics for CellMetrics {
    fn advance(&self, _font: &FontSpec, c: char) -> f32 {
        c.width().unwrap_or(0) as f32
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
}

/// A place in a window, as Emacs's posn functions give it: the window, the
/// buffer position, and where it is from the top left of the window's text
/// area, in the metrics' units and in rows and columns of the default font.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Posn {
    pub window: WindowId,
    pub point: usize,
    pub x: f32,
    pub y: f32,
    pub col: f32,
    pub row: usize,
}

impl Editor {
    /// Gives the editor a front end's metrics. Without, it measures in cells.
    pub fn set_text_metrics(&mut self, metrics: Arc<dyn TextMetrics>) {
        self.metrics = metrics;
    }

    pub fn text_metrics(&self) -> &dyn TextMetrics {
        self.metrics.as_ref()
    }

    /// Whether a style's text lies on the grid: the default size and a
    /// fixed-width font.
    fn on_grid(&self, style: &Style) -> bool {
        self.metrics.uniform() || (style.scale == 1.0 && !style.proportional())
    }

    /// Whether a row lies on the grid, every glyph a column per cell.
    pub fn row_on_grid(&self, row: &Row) -> bool {
        self.metrics.uniform() || row.segments.iter().all(|s| s.image.is_none() && self.on_grid(&s.style))
    }

    /// How many default columns a character of a segment takes, starting
    /// `col` columns into its row: a tab to the next tab stop, which are
    /// every `tab-width` default columns as in Emacs, `^X` for a control
    /// character, and `\NNN` for a raw byte or C1 control.
    pub(crate) fn char_columns(&self, segment: &Segment, c: char, col: f32, tab_width: usize) -> f32 {
        if let Some(image) = &segment.image {
            return image.advance() / self.metrics.char_width();
        }
        if c == '\t' {
            let tab = tab_width.max(1) as f32;
            return (col / tab).floor() * tab + tab - col;
        }
        let escaped = crate::coding::char_raw_byte(c).is_some() || ('\u{80}'..='\u{9F}').contains(&c);
        // The bidi controls show as a space.
        let c = if crate::bidi_display::is_bidi_control(c) { ' ' } else { c };
        if self.on_grid(&segment.style) {
            return if escaped { 4.0 } else if c.is_control() { 2.0 } else { c.width().unwrap_or(0) as f32 };
        }
        let font = FontSpec::of(&segment.style);
        let width = self.metrics.char_width();
        if escaped {
            return (self.metrics.advance(&font, '\\') + 3.0 * self.metrics.advance(&font, '0')) / width;
        }
        if c.is_control() {
            return (self.metrics.advance(&font, '^') + self.metrics.advance(&font, 'X')) / width;
        }
        self.metrics.advance(&font, c) / width
    }

    /// Each glyph's width in default columns: its cells on the grid, else
    /// as the metrics measure it.
    pub fn glyph_columns(&self, row: &Row, glyphs: &[Glyph], tab_width: usize) -> Vec<f32> {
        if self.row_on_grid(row) {
            return glyphs.iter().map(|g| g.width as f32).collect();
        }
        let mut col = 0.0;
        glyphs
            .iter()
            .map(|g| {
                let w = self.char_columns(&row.segments[g.segment], g.c, col, tab_width);
                col += w;
                w
            })
            .collect()
    }

    /// How tall a row is in default lines: its tallest font's line, or the
    /// buffer's default face's when it shows nothing, as Emacs's rows are.
    pub fn row_height(&self, b: &Buffer, row: &Row) -> f32 {
        if self.metrics.uniform() {
            return 1.0;
        }
        if let Some(height) = self.image_row_height(b, row) {
            return height;
        }
        let height = self.metrics.char_height();
        let tallest = row
            .segments
            .iter()
            .filter(|s| !s.text.is_empty())
            .map(|s| if self.on_grid(&s.style) { height } else { self.metrics.line_height(&FontSpec::of(&s.style)) })
            .fold(None, |max: Option<f32>, h| Some(max.map_or(h, |m| m.max(h))));
        let tallest = tallest.unwrap_or_else(|| {
            let default = self.style_for_in(b, &[], true);
            if self.on_grid(&default) { height } else { self.metrics.line_height(&FontSpec::of(&default)) }
        });
        tallest / height
    }

    /// The rows a window shows, as many as start within its height, the
    /// last perhaps only partly in sight.
    pub fn rows_filling(&self, window: WindowId, dark: bool) -> Vec<Row> {
        self.rows_within(window, dark, 0)
    }

    /// The rows a front end draws in a window: those it shows, and one more
    /// for the part of a row that shows below its whole lines, or when it is
    /// scrolled smoothly between them.
    pub fn rows_to_draw(&self, window: WindowId, dark: bool) -> Vec<Row> {
        let mut rows = self.rows_within(window, dark, 1);
        if !self.metrics.fringes()
            && let Some(view) = self.windows().into_iter().find(|v| v.id == window)
        {
            self.put_overlay_arrows(view.buffer, &mut rows, dark, self.tab_width_in(view.buffer));
        }
        rows
    }

    /// The rows that start within a window's height and `extra` lines more.
    fn rows_within(&self, window: WindowId, dark: bool, extra: usize) -> Vec<Row> {
        let Some(view) = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window) else { return Vec::new() };
        let lines = self.window(window).map_or(24, |w| w.height).max(1) + extra;
        let b = view.buffer;
        let wrap = self.wrap_in(window, b);
        if self.metrics.uniform() {
            return self.rows_in(b, view.top_line, lines, dark, wrap);
        }
        // Rows smaller than the default's fit more than the window's lines.
        let mut rows = self.rows_in(b, view.top_line, lines * 2, dark, wrap);
        let mut y = 0.0;
        let keep = rows
            .iter()
            .position(|r| {
                let past = y >= lines as f32;
                y += self.row_height(b, r);
                past
            })
            .unwrap_or(rows.len());
        rows.truncate(keep);
        rows
    }

    /// Where a buffer position shows in a window, as Emacs's
    /// `posn-at-point`, or `None` if it is not in sight. Rows partly in
    /// sight at the bottom count.
    pub fn posn_at_point(&self, pos: usize, window: WindowId) -> Option<Posn> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        let rows = self.rows_filling(window, true);
        let tab_width = self.tab_width_in(b);
        // Bidirectional text broken into rows spreads a line over them.
        let showing = crate::display::row_showing(&rows, pos, tab_width);
        let mut y = 0.0;
        for (k, row) in rows.iter().enumerate() {
            if showing == Some(k) {
                let glyphs = crate::display::row_glyphs(row, tab_width);
                let index = crate::display::cursor_glyph(row, &glyphs, pos);
                // A right-to-left row is laid out from the right edge.
                let col: f32 = self.glyph_columns(row, &glyphs, tab_width)[..index].iter().sum::<f32>() + self.row_offset_in(window, row);
                let (cw, ch) = (self.metrics.char_width(), self.metrics.char_height());
                return Some(Posn { window, point: pos, x: col * cw, y: y * ch, col, row: k });
            }
            y += self.row_height(b, row);
        }
        None
    }

    /// The buffer position at a place in a window's text area, as Emacs's
    /// `posn-at-x-y`: the character drawn there, the end of a row past its
    /// last glyph, or the end of the text below the last row.
    pub fn posn_at_x_y(&self, x: f32, y: f32, window: WindowId) -> Option<Posn> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        let rows = self.rows_filling(window, true);
        let tab_width = self.tab_width_in(b);
        let (cw, ch) = (self.metrics.char_width(), self.metrics.char_height());
        let (want_col, want_line) = (x / cw, y / ch);
        let mut top = 0.0;
        for (k, row) in rows.iter().enumerate() {
            let height = self.row_height(b, row);
            if want_line < top + height || k + 1 == rows.len() {
                let glyphs = crate::display::row_glyphs(row, tab_width);
                let widths = self.glyph_columns(row, &glyphs, tab_width);
                // A right-to-left row is laid out from the right edge.
                let offset = self.row_offset_in(window, row);
                let want_col = want_col - offset;
                let mut col = 0.0;
                let mut point = row.end;
                for (i, glyph) in glyphs.iter().enumerate() {
                    if want_col < col + widths[i] {
                        // An ellipsis stands for hidden text; it goes after the text.
                        point = glyph.pos.unwrap_or_else(|| glyphs[i + 1..].iter().find_map(|g| g.pos).unwrap_or(row.end));
                        break;
                    }
                    col += widths[i];
                }
                let col = if point == row.end { col } else { widths[..glyphs.iter().position(|g| g.pos == Some(point)).unwrap_or(0)].iter().sum() };
                let col = col + offset;
                return Some(Posn { window, point, x: col * cw, y: top * ch, col, row: k });
            }
            top += height;
        }
        Some(Posn { window, point: b.point_max(), x: 0.0, y: top * ch, col: 0.0, row: rows.len() })
    }

    /// Where a window's text ends, as Emacs's `window-end`: the position
    /// after the last character it shows, its last row counted even if only
    /// partly in sight.
    pub fn window_end(&self, window: WindowId) -> Option<usize> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        let rows = self.rows_filling(window, true);
        let last = rows.last()?;
        Some(if last.continued || last.end >= b.point_max() { last.end } else { last.end + 1 })
    }

    /// The width and height of the text from `from` to `to` as a window
    /// shows it, in the metrics' units, as Emacs's `window-text-pixel-size`:
    /// its widest row and its rows' heights, wrapped as the window wraps.
    pub fn window_text_pixel_size(&self, window: WindowId, from: usize, to: usize) -> Option<(f32, f32)> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        Some(self.text_pixel_size(b, self.wrap_in(window, b), from, to))
    }

    /// The width and height of a buffer's accessible text, in the metrics'
    /// units, as Emacs's `buffer-text-pixel-size`, its lines unwrapped:
    /// what `string-pixel-width` measures a string with.
    pub fn buffer_text_pixel_size(&self, buffer: u64) -> Option<(f32, f32)> {
        let b = &self.buffers[self.buffer_with_id(buffer)?];
        Some(self.text_pixel_size(b, None, b.point_min(), b.point_max()))
    }

    fn text_pixel_size(&self, b: &Buffer, wrap: Option<crate::rows::Wrap>, from: usize, to: usize) -> (f32, f32) {
        let tab_width = self.tab_width_in(b);
        let (from, to) = (from.min(to).max(b.point_min()), to.max(from).min(b.point_max()));
        let first = b.line_of(from);
        let lines = b.line_of(to) - first + 1;
        let rows = self.rows_from(b, first, usize::MAX, lines, Some(true), wrap);
        let (mut width, mut height) = (0.0f32, 0.0f32);
        for row in rows.iter().take_while(|r| r.start <= to) {
            if row.end < from {
                continue;
            }
            let glyphs = crate::display::row_glyphs(row, tab_width);
            let widths = self.glyph_columns(row, &glyphs, tab_width);
            let shown: f32 = glyphs.iter().zip(&widths).filter(|(g, _)| g.pos.is_none_or(|p| p >= from && p < to)).map(|(_, w)| w).sum();
            width = width.max(shown);
            height += self.row_height(b, row);
        }
        (width * self.metrics.char_width(), height * self.metrics.char_height())
    }

    /// Whether the row point shows in, in the selected window, goes on in
    /// the next, as Emacs's `display--line-is-continued-p`.
    pub fn line_is_continued(&self) -> bool {
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let (rows, k, _) = self.screen_position(b, b.point(), wrap);
        rows.get(k).is_some_and(|r| r.continued)
    }

    /// How tall the row point's line shows in is in the selected window, in
    /// the metrics' units, as Emacs's `line-pixel-height`.
    pub fn line_pixel_height(&self) -> f32 {
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let (rows, k, _) = self.screen_position(b, b.point(), wrap);
        rows.get(k).map_or(1.0, |r| self.row_height(b, r)) * self.metrics.char_height()
    }
}

impl Editor {
    /// Whether a buffer position shows in a window, as Emacs's
    /// `pos-visible-in-window-p`; with `partially`, a row only partly in
    /// sight at the bottom counts.
    pub fn pos_visible_in_window_p(&self, pos: usize, window: WindowId, partially: bool) -> bool {
        let Some(posn) = self.posn_at_point(pos, window) else { return false };
        if partially {
            return true;
        }
        let Some(view) = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window) else { return false };
        let lines = self.window(window).map_or(24, |w| w.height) as f32;
        let row = &self.rows_filling(window, true)[posn.row];
        posn.y / self.metrics.char_height() + self.row_height(view.buffer, row) <= lines
    }

    /// The width of the current buffer's default font, as Emacs's
    /// `default-font-width`, its remapping counted.
    pub fn default_font_width(&self) -> f32 {
        let style = self.style_for_in(self.buffer(), &[], true);
        if self.on_grid(&style) { self.metrics.char_width() } else { self.metrics.advance(&FontSpec::of(&style), 'M') }
    }

    /// The height of the current buffer's default font, as Emacs's `default-font-height`.
    pub fn default_font_height(&self) -> f32 {
        let style = self.style_for_in(self.buffer(), &[], true);
        if self.on_grid(&style) { self.metrics.char_height() } else { self.metrics.line_height(&FontSpec::of(&style)) }
    }
}
