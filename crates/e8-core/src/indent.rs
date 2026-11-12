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
                crate::commands::position_at_x(self, b, row, x)
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

    /// A row of a window's text, its header line or its mode line, as
    /// Emacs's `window-line-height`: its height, its index among the text
    /// rows and its top, in the front end's units below the first text
    /// row, and how much of it the window's bottom cuts off. `None` if
    /// there is no such line, or point is not in sight.
    pub fn window_line_height(&self, window: WindowId, line: WindowLine) -> Option<[f64; 4]> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let unit = self.metrics.char_height() as f64;
        let header = self.header_line(window).is_some();
        let text_bottom = self.window(window)?.height as f64 * unit;
        let rows = self.rows_filling(window, true);
        let heights: Vec<f64> = rows.iter().map(|r| self.row_height(view.buffer, r) as f64 * unit).collect();
        let tops: Vec<f64> = heights.iter().scan(0.0, |y, h| Some(std::mem::replace(y, *y + h))).collect();
        let at = |i: usize| {
            let crop = (tops[i] + heights[i] - text_bottom).max(0.0);
            Some([heights[i] - crop, i as f64, tops[i], crop])
        };
        match line {
            WindowLine::HeaderLine => header.then_some([unit, 0.0, 0.0, 0.0]),
            WindowLine::ModeLine => self.window_shows_mode_line(window).then(|| [unit, 0.0, text_bottom + if header { unit } else { 0.0 }, 0.0]),
            WindowLine::Point => at(crate::display::row_showing(&rows, view.point, self.tab_width_in(view.buffer))?),
            WindowLine::Text(n) => {
                // Past the rows the window shows whole, the last; as window.c counts.
                let mut i = 0;
                while (n < 0 || (i as i64) < n) && i < rows.len() && tops[i] + heights[i] < text_bottom {
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
    /// and the row's bottom, in the front end's units. With `left`, the
    /// left edge of its first character instead. Rows the window's bottom
    /// cuts off are left out.
    pub fn window_lines_pixel_dimensions(&self, window: WindowId, first: Option<usize>, last: Option<usize>, inverse: bool, left: bool) -> Option<Vec<(f64, f64)>> {
        let view = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window)?;
        let b = view.buffer;
        let (cw, ch) = (self.metrics.char_width() as f64, self.metrics.char_height() as f64);
        let w = self.window(window)?;
        let (width, text_bottom) = (w.width as f64 * cw, w.height as f64 * ch);
        let numbers = self.line_number_columns(window, b) as f64 * cw;
        let tab_width = self.tab_width_in(b);
        let rows = self.rows_filling(window, true);
        let mut y = 0.0;
        let mut out = Vec::new();
        for (i, row) in rows.iter().enumerate() {
            let height = self.row_height(b, row) as f64 * ch;
            if last.is_some_and(|last| i > last) || y + height >= text_bottom {
                break;
            }
            y += height;
            if first.is_some_and(|first| i < first) {
                continue;
            }
            let glyphs = crate::display::row_glyphs(row, tab_width);
            let columns = self.glyph_columns(row, &glyphs, tab_width);
            let x = if left {
                let first = columns.first().copied().unwrap_or(0.0) as f64 * cw;
                if inverse { first } else { width - first }
            } else {
                let right = numbers + columns.iter().sum::<f32>() as f64 * cw;
                if inverse { width - right } else { right }
            };
            out.push((x, y));
        }
        Some(out)
    }

    /// Where text from `from`, shown at column `from_hpos` of row
    /// `from_vpos`, reaches `to` or the place `(to_hpos, to_vpos)`,
    /// whichever comes first, as Emacs's `compute-motion`: in the current
    /// buffer, lines continued after `width` columns, or truncated where
    /// `truncate-lines` says or the window is scrolled, `hscroll` columns
    /// off the left, tabs measured from `tab_offset`.
    #[allow(clippy::too_many_arguments)]
    pub fn compute_motion(
        &self,
        from: usize,
        (from_hpos, from_vpos): (i64, i64),
        to: usize,
        (to_hpos, to_vpos): (i64, i64),
        width: Option<i64>,
        (hscroll, tab_offset): (i64, i64),
        window: WindowId,
    ) -> Motion {
        let b = self.buffer();
        let tab_width = self.tab_width_in(b).max(1) as i64;
        let truncate = self.wrap_in(window, b).is_none() || hscroll > 0;
        let width = width.unwrap_or_else(|| self.text_area_columns(window) as i64 - i64::from(!self.metrics.fringes())).max(1);
        let to = to.min(b.point_max());
        let (mut pos, mut hpos, mut vpos) = (from.max(b.point_min()), from_hpos, from_vpos);
        let (mut prev_pos, mut prev_hpos, mut prev_vpos) = (pos, hpos, vpos);
        // The column a continued row broke at, as indent.c's contin_hpos.
        let mut contin_hpos = 0;
        // As indent.c's loop: each character moves the place on, and going
        // past `to` goes back to the place before it.
        loop {
            if pos > to {
                (pos, hpos, vpos) = (prev_pos, prev_hpos, prev_vpos);
                break;
            }
            if vpos > to_vpos || (vpos == to_vpos && hpos >= to_hpos) || pos >= b.point_max() {
                break;
            }
            (prev_pos, prev_hpos, prev_vpos) = (pos, hpos, vpos);
            let c = b.char_at(pos).unwrap_or('\n');
            pos += 1;
            if c == '\n' {
                (hpos, vpos) = (-hscroll, vpos + 1);
                continue;
            }
            hpos += match c {
                '\t' => tab_width - (hpos + hscroll + tab_offset).rem_euclid(tab_width),
                c if crate::coding::char_raw_byte(c).is_some() || ('\u{80}'..='\u{9F}').contains(&c) => 4,
                c if c.is_control() => 2,
                c => unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i64,
            };
            if hpos > width {
                if truncate {
                    // The rest of the line is out of sight.
                    pos = b.line_end(b.line_of(pos - 1)).min(to).max(pos);
                    (hpos, prev_hpos, prev_vpos) = (width, width, vpos);
                } else {
                    hpos -= width;
                    vpos += 1;
                    (contin_hpos, prev_hpos, prev_vpos) = (prev_hpos, 0, vpos);
                }
            }
        }
        let continued = contin_hpos != 0 && prev_hpos == 0;
        let prev_hpos = if continued { contin_hpos } else { prev_hpos };
        Motion { pos, hpos, vpos, prev_hpos, continued }
    }
}
