//! Moving by screen lines and asking how text is laid out, as Emacs's
//! indent.c (`vertical-motion`, `compute-motion`,
//! `line-number-display-width`), and the questions about a window's rows
//! window.c answers from its glyph matrix (`window-line-height`,
//! `window-lines-pixel-dimensions`) ([ADR 0071]).
//!
//! [ADR 0071]: ../../../docs/adr/0071-scrolling-as-emacs-has-it.md

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::rows::{Row, Wrap};
use crate::variables::Value;
use crate::window::WindowId;

/// Which line of a window `window-line-height` asks about.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WindowLine {
    /// The row point shows on.
    Point,
    /// A text row, counted from 0 at the top, or from the bottom if negative.
    Text(i64),
    HeaderLine,
    ModeLine,
}

/// A row of a window as [`Editor::matrix_rows`] gives it.
struct MatrixRow {
    top: f64,
    height: f64,
    /// How wide its glyphs are, and its first glyph.
    width: f64,
    first: f64,
}

/// Where `compute-motion` stopped, as its value: the position, its column
/// and row, the column before the last character, and whether the
/// position is on a continuation row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub pos: usize,
    pub hpos: i64,
    pub vpos: i64,
    pub prev_hpos: i64,
    pub continued: bool,
}

impl Editor {
    /// The screen rows of the row of text starting at `line`, styled, as a
    /// window wrapping as `wrap` says lays them out.
    fn line_rows(&self, b: &Buffer, line: usize, wrap: Option<Wrap>) -> Vec<Row> {
        self.rows_from(b, line, usize::MAX, 1, Some(true), wrap)
    }

    /// Moves point in the current buffer `lines` screen lines down, or up
    /// for a negative number, as `window` lays them out, to the start of
    /// the screen line, or with `cols` to that column of it, past what the
    /// window is scrolled horizontally, as Emacs's `vertical-motion`. Past
    /// the end of the buffer point goes to the end. Returns how many lines
    /// it moved.
    pub fn vertical_motion(&mut self, lines: i64, cols: Option<f64>, window: WindowId) -> i64 {
        let b = self.buffer();
        let wrap = self.wrap_in(window, b);
        let point = b.point();
        let mut line = self.row_line_in(b, b.line_of(point));
        let mut rows = self.line_rows(b, line, wrap);
        let mut index = crate::display::row_showing(&rows, point, self.tab_width_in(b)).unwrap_or(rows.len().saturating_sub(1));
        let mut moved = 0;
        while moved < lines {
            if index + 1 < rows.len() {
                index += 1;
            } else {
                let (next, n) = self.move_rows_in(b, line, 1);
                if n != 1 {
                    let end = b.point_max();
                    self.buffer_mut().set_point(end);
                    return moved;
                }
                line = next;
                rows = self.line_rows(b, line, wrap);
                index = 0;
            }
            moved += 1;
        }
        while moved > lines {
            if index > 0 {
                index -= 1;
            } else {
                let (prev, n) = self.move_rows_in(b, line, -1);
                if n != -1 {
                    break;
                }
                line = prev;
                rows = self.line_rows(b, line, wrap);
                index = rows.len().saturating_sub(1);
            }
            moved -= 1;
        }
        let Some(row) = rows.get(index) else { return moved };
        let target = match cols {
            // Counted from what shows at the left edge, rounded to the nearest
            // unit of the front end's, as Emacs rounds to a pixel.
            Some(cols) => {
                let width = self.metrics.char_width() as f64;
                let x = ((cols * width + 0.5).floor() / width) as f32 + self.row_hscroll(window, row, point) as f32;
                crate::commands::position_at_x_in(self, window, b, row, x)
            }
            None => row.start,
        };
        self.buffer_mut().set_point(target);
        moved
    }

    /// How wide the selected window's line numbers are, as Emacs's
    /// `line-number-display-width`: digits, the columns they take with
    /// the space either side, and that in the front end's units.
    pub fn line_number_display_width(&self) -> (usize, f64, f64) {
        let window = self.selected_window();
        let b = self.window_buffer();
        let columns = self.line_number_columns(window, b);
        (columns.saturating_sub(2), columns as f64, columns as f64 * self.metrics.char_width() as f64)
    }

    /// A window's rows as Emacs's glyph matrix holds them: the rows of
    /// text that start within its height, then empty rows of the default
    /// height down to its bottom. Each with its height, its top below the
    /// window's top (a header line's height down), and the default
    /// columns its glyphs take, in the front end's units; and the header
    /// line's height and the text's bottom.
    fn matrix_rows(&self, window: WindowId) -> Option<(Vec<MatrixRow>, f64, f64)> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        let (cw, unit) = (self.metrics.char_width() as f64, self.metrics.char_height() as f64);
        let header = if self.header_line(window).is_some() { unit } else { 0.0 };
        let bottom = header + self.window(window)?.height as f64 * unit;
        let tab_width = self.tab_width_in(b);
        let mut y = header;
        let mut rows = Vec::new();
        for row in self.rows_filling(window, true) {
            let height = self.row_height(b, &row) as f64 * unit;
            let glyphs = crate::display::row_glyphs(&row, tab_width);
            let columns = self.glyph_columns(&row, &glyphs, tab_width);
            let first = columns.first().copied().unwrap_or(0.0) as f64 * cw;
            let width = columns.iter().sum::<f32>() as f64 * cw;
            rows.push(MatrixRow { top: y, height, width, first });
            y += height;
        }
        while y < bottom {
            rows.push(MatrixRow { top: y, height: unit, width: 0.0, first: 0.0 });
            y += unit;
        }
        Some((rows, header, bottom))
    }

    /// A row of a window's text, its header line or its mode line, as
    /// Emacs's `window-line-height`: its height, its index among the text
    /// rows and its top, in the front end's units below the window's top,
    /// a header line's height included as Emacs counts it, and how much of
    /// it the window's bottom cuts off. Rows past the end of the text are
    /// the default height. `None` if there is no such line, or point is
    /// not in sight.
    pub fn window_line_height(&self, window: WindowId, line: WindowLine) -> Option<[f64; 4]> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let unit = self.metrics.char_height() as f64;
        let (rows, header, bottom) = self.matrix_rows(window)?;
        let at = |i: usize| {
            let r = &rows[i];
            let crop = (r.top + r.height - bottom).max(0.0);
            Some([r.height + r.top.min(0.0) - crop, i as f64, r.top, crop])
        };
        match line {
            WindowLine::HeaderLine => (header > 0.0).then_some([header, 0.0, 0.0, 0.0]),
            // The header line counted twice, as window.c adds it to a bottom that has it.
            WindowLine::ModeLine => self.window_shows_mode_line(window).then(|| [unit, 0.0, header + bottom, 0.0]),
            WindowLine::Point => {
                let text = self.rows_filling(window, true);
                at(crate::display::row_showing(&text, view.point, self.tab_width_in(view.buffer))?)
            }
            WindowLine::Text(n) => {
                // Past the rows the window shows whole, the last; as window.c counts.
                let mut i = 0;
                while (n < 0 || (i as i64) < n) && i < rows.len() && rows[i].top + rows[i].height < bottom {
                    i += 1;
                }
                if i >= rows.len() {
                    return None;
                }
                let n = n + 1;
                if n < 0 {
                    if -n > i as i64 {
                        return None;
                    }
                    i = (i as i64 + n) as usize;
                }
                at(i)
            }
        }
    }

    /// Where each of a window's rows ends, as Emacs's
    /// `window-lines-pixel-dimensions`: for each row from `first` to
    /// `last`, the right edge of its last character from the window's
    /// left, or with `inverse` the space from there to the window's right,
    /// and the row's bottom, in the front end's units, below the text's
    /// top with `body`, else the window's. With `left`, the left edge of
    /// its first character instead. Rows the bottom of the text, or with
    /// `body` nil of the window, cuts off are left out, and rows past the
    /// end of the text are empty.
    pub fn window_lines_pixel_dimensions(&self, window: WindowId, first: Option<usize>, last: Option<usize>, body: bool, inverse: bool, left: bool) -> Option<Vec<(f64, f64)>> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let (cw, unit) = (self.metrics.char_width() as f64, self.metrics.char_height() as f64);
        let width = self.window(window)?.width as f64 * cw;
        let numbers = self.line_number_columns(window, view.buffer) as f64 * cw;
        let (rows, header, bottom) = self.matrix_rows(window)?;
        let mode_line = if self.window_shows_mode_line(window) { unit } else { 0.0 };
        let (max_y, subtract) = if body { (bottom, header) } else { (bottom + mode_line, 0.0) };
        let mut out = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            if last.is_some_and(|last| i > last) || r.top + r.height >= max_y {
                break;
            }
            if first.is_some_and(|first| i < first) {
                continue;
            }
            let x = match (left, inverse) {
                (true, true) => r.first,
                (true, false) => width - r.first,
                (false, true) => width - numbers - r.width,
                (false, false) => numbers + r.width,
            };
            out.push((x, r.top + r.height - subtract));
        }
        Some(out)
    }

    /// Where text from `from`, shown at column `from_hpos` of row
    /// `from_vpos`, reaches `to` or the place `(to_hpos, to_vpos)`,
    /// whichever comes first, as Emacs's `compute-motion`, following
    /// indent.c's `compute_motion`: through the current buffer, invisible
    /// text skipped, lines continued after `width` columns (the window's
    /// body less a column for the `\\` on a terminal by default), or
    /// truncated where `truncate-lines` says, where
    /// `truncate-partial-width-windows` says of `width` against the
    /// frame's width, or when `hscroll` is not 0, `hscroll` columns scrolled off the left
    /// and tabs measured from `tab_offset`. The place defaults to the
    /// window's bottom right. An error if `from` or `to` is outside the
    /// accessible text.
    #[allow(clippy::too_many_arguments)]
    pub fn compute_motion(
        &self,
        from: usize,
        (from_hpos, from_vpos): (i64, i64),
        to: usize,
        to_place: Option<(i64, i64)>,
        width: Option<i64>,
        (hscroll, mut tab_offset): (i64, i64),
        window: WindowId,
    ) -> crate::error::Result<Motion> {
        let b = self.buffer();
        let (begv, zv) = (b.point_min(), b.point_max());
        for p in [from, to] {
            if p < begv || p > zv {
                return Err(crate::error::Error::signal(
                    "args-out-of-range",
                    "Args out of range",
                    vec![Value::Number(p as f64), Value::Number(begv as f64), Value::Number(zv as f64)],
                ));
            }
        }
        let tab_width = self.tab_width_in(b).max(1) as i64;
        let terminal = !self.metrics.fringes();
        let continuation = i64::from(terminal);
        let body = self.window_body_columns(window) as i64;
        let width = width.filter(|w| *w >= 0).unwrap_or(body - continuation);
        let (to_hpos, to_vpos) = to_place.unwrap_or((body - continuation, self.window(window).map_or(24, |w| w.height) as i64));
        // As indent.c decides: by WIDTH against the frame's, not the window.
        let total = width + continuation;
        let frame_columns = self.window_frame(window).map_or(80, |f| self.frame_width(f)) as i64;
        let partial = match self.variable_in(b, "truncate-partial-width-windows") {
            Some(Value::Number(limit)) => total < frame_columns && (total as f64) < limit,
            Some(v) => v.is_true() && total < frame_columns,
            None => total < frame_columns && total < 50,
        };
        let truncate = hscroll > 0 || partial || self.variable_in(b, "truncate-lines").is_some_and(|v| v.is_true());
        let past = |hpos: i64, vpos: i64| vpos > to_vpos || (vpos == to_vpos && hpos >= to_hpos);
        let (mut pos, mut hpos, mut vpos) = (from, from_hpos, from_vpos);
        let (mut prev_pos, mut prev_hpos, mut prev_vpos) = (from, 0, 0);
        // The column a continued row broke at, and where a wide
        // character just read ended.
        let (mut contin_hpos, mut wide_end) = (0, 0);
        'scan: loop {
            // Invisible text takes no room.
            if past(hpos, vpos) {
                if contin_hpos != 0 && prev_hpos == 0 && hpos > to_hpos && (contin_hpos == width || wide_end > width) {
                    (pos, hpos, vpos) = (prev_pos, prev_hpos, prev_vpos);
                }
                break;
            }
            if pos >= to {
                break;
            }
            while pos < to && self.invisible_in(b, pos).is_some() {
                pos += 1;
            }
            if pos >= to {
                break;
            }
            loop {
                // The right margin: truncated, the rest of the line is out
                // of sight; continued, on to the next row, a wide
                // character that did not fit with it.
                if hpos > width {
                    if truncate {
                        if pos <= to {
                            pos = (pos..to).find(|&p| b.char_at(p) == Some('\n')).unwrap_or(to);
                            (hpos, prev_hpos, prev_vpos) = (width, width, vpos);
                        }
                    } else {
                        if wide_end > width {
                            hpos -= prev_hpos;
                            tab_offset += prev_hpos;
                        } else {
                            tab_offset += width;
                            hpos -= width;
                        }
                        vpos += 1;
                        (contin_hpos, prev_hpos, prev_vpos) = (prev_hpos, 0, vpos);
                    }
                }
                if pos > to {
                    (pos, hpos, vpos) = (prev_pos, prev_hpos, prev_vpos);
                    // A multi-column character broken at the margin: back to the row before.
                    if contin_hpos != 0 && prev_hpos == 0 && contin_hpos < width && wide_end == 0 {
                        (hpos, vpos) = (contin_hpos, vpos - 1);
                    }
                    break 'scan;
                }
                if past(hpos, vpos) {
                    if contin_hpos != 0 && prev_hpos == 0 && hpos > to_hpos && (contin_hpos == width || wide_end > width) {
                        (pos, hpos, vpos) = (prev_pos, prev_hpos, prev_vpos);
                    }
                    break 'scan;
                }
                if pos >= zv {
                    break 'scan;
                }
                (prev_hpos, prev_vpos, prev_pos) = (hpos, vpos, pos);
                wide_end = 0;
                let c = b.char_at(pos).unwrap_or('\n');
                pos += 1;
                match c {
                    '\t' => hpos += tab_width - (hpos + tab_offset + hscroll - i64::from(hscroll > 0)).rem_euclid(tab_width),
                    '\n' => {
                        vpos += 1;
                        hpos = -hscroll + if hscroll > 0 { continuation } else { 0 };
                        tab_offset = 0;
                        contin_hpos = 0;
                    }
                    c if crate::coding::char_raw_byte(c).is_some() || ('\u{80}'..='\u{9F}').contains(&c) => hpos += 4,
                    c if c.is_control() => hpos += 2,
                    c => {
                        let w = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i64;
                        if w > 1 {
                            wide_end = hpos + w;
                        }
                        hpos += w;
                    }
                }
                // Back to look for invisible text at the next character.
                if pos < to && self.invisible_in(b, pos).is_some() {
                    continue 'scan;
                }
            }
        }
        let continued = contin_hpos != 0 && prev_hpos == 0;
        let prev_hpos = if continued { contin_hpos } else { prev_hpos };
        Ok(Motion { pos, hpos, vpos, prev_hpos, continued })
    }
}
