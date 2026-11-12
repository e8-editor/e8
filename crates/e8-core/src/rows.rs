//! What a window shows: rows of styled text, with invisible text left out.
//!
//! Text is invisible when its `invisible` property, from an overlay or the
//! text itself, matches the buffer's `buffer-invisibility-spec`, as in Emacs.
//! A row ends at a visible newline, so lines whose newline before them is
//! invisible are part of the row above: that is how a folded heading shows
//! as one row ending in "...". Line moves and scrolling count rows.
//!
//! Rows show more than the buffer's text, as Emacs's redisplay does: an
//! overlay's `before-string` and `after-string` at its ends, and text with
//! a string `display` property shows the string instead, or space for a
//! `(space :width N)` or `(space :align-to COLUMN)` spec.

use std::collections::HashMap;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::faces::{Style, face_names};
use crate::variables::Value;

/// A stretch of a row with one style.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    /// The buffer position of the first character. For an ellipsis, the
    /// position of the hidden text it stands for.
    pub start: usize,
    /// The characters, never a newline.
    pub text: String,
    pub style: Style,
    /// Whether this is the "..." shown for hidden text rather than buffer text.
    pub ellipsis: bool,
    /// Whether this is a string shown in place of text or beside it, from
    /// a `display` property or an overlay's `before-string` or
    /// `after-string`, rather than buffer text. A display string's `start`
    /// is the text it stands for; an overlay string's is where it shows.
    pub string: bool,
    /// For a display string, the end of the text it stands for.
    pub covers: Option<usize>,
    /// Whether it starts a screen row of its own: it follows a newline in a
    /// string, which ends the row before it.
    pub breaks: bool,
    /// Whether the cursor goes on its first character when point is where
    /// it shows, as a string's `cursor` property says in Emacs.
    pub cursor: bool,
    /// The margin a `(margin left-margin)` display spec puts it in, for the
    /// row to show beside its text rather than in it.
    pub margin: Option<Margin>,
    /// The fringe bitmap a `(left-fringe BITMAP FACE)` display spec puts
    /// beside the row, in place of the text it is on.
    pub fringe: Option<FringeSpec>,
    /// The image an `(image ...)` display spec shows in place of the text
    /// it is on or of a string's character; the segment's text is then
    /// [`crate::image::IMAGE_CHAR`], which front ends draw as the image.
    pub image: Option<std::sync::Arc<crate::image::ImageGlyph>>,
}

/// A bitmap a display spec puts in a fringe: which fringe, the bitmap's
/// name, as `define-fringe-bitmap` or Emacs's standard ones name them, and
/// the face it is drawn in, `fringe` by default.
#[derive(Clone, Debug, PartialEq)]
pub struct FringeSpec {
    pub side: Margin,
    pub bitmap: String,
    pub face: Option<String>,
}

/// A display spec that puts a bitmap in a fringe, `(left-fringe BITMAP FACE)`.
fn fringe_spec(value: &Value) -> Option<FringeSpec> {
    let Value::List(items) = value else { return None };
    let side = match items.first()?.as_str()? {
        "left-fringe" => Margin::Left,
        "right-fringe" => Margin::Right,
        _ => return None,
    };
    let bitmap = items.get(1)?.as_str()?.to_string();
    let face = items.get(2).and_then(Value::as_str).map(str::to_string);
    Some(FringeSpec { side, bitmap, face })
}

/// A window's margin, beside its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Margin {
    Left,
    Right,
}

/// A display spec that puts a string in a margin, `((margin left-margin)
/// STRING)`: which margin, and the string.
fn margin_spec(value: &Value) -> Option<(Margin, &Value)> {
    let Value::List(items) = value else { return None };
    let [Value::List(location), string] = items.as_slice() else { return None };
    if crate::image::is_image(string) {
        return None;
    }
    if location.first()?.as_str()? != "margin" {
        return None;
    }
    let side = match location.get(1)?.as_str()? {
        "left-margin" => Margin::Left,
        "right-margin" => Margin::Right,
        _ => return None,
    };
    Some((side, string))
}

impl Segment {
    /// A segment of buffer text.
    pub fn text(start: usize, text: String, style: Style) -> Segment {
        Segment { start, text, style, ellipsis: false, string: false, covers: None, breaks: false, cursor: false, margin: None, fringe: None, image: None }
    }

    /// Whether it is drawn whole, never split by wrapping: an ellipsis or a string.
    fn atomic(&self) -> bool {
        self.ellipsis || self.string
    }

    /// Whether wrapping keeps it whole on one row: an ellipsis, or a
    /// display string standing for text. An overlay string wraps a
    /// character at a time, as Emacs's display continues it.
    fn unbroken(&self) -> bool {
        self.ellipsis || (self.string && self.covers.is_some())
    }
}

/// How lines are numbered, as `display-line-numbers` says.
#[derive(Clone, Copy, Debug, PartialEq)]
enum LineNumberKind {
    Absolute,
    Relative,
    Visual,
}

/// The line numbers beside a window's rows, as [`Editor::line_numbers`]
/// gives them for a front end to draw left of the text.
#[derive(Clone, Debug, PartialEq)]
pub struct LineNumbers {
    /// How many columns they take, the spaces either side included.
    pub width: usize,
    /// Each row's number, as wide as `width`, and whether the row is on
    /// point's line, for the face `line-number-current-line`.
    pub labels: Vec<(String, bool)>,
}

/// One row of a window.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The buffer line the row starts on.
    pub line: usize,
    pub start: usize,
    /// Where the row ends: its visible newline, or the end of the buffer.
    /// For a continued row, where the next row starts.
    pub end: usize,
    pub segments: Vec<Segment>,
    /// Whether the line goes on in the next row because it was too long for
    /// the window, which Emacs marks with a `\` in the last column.
    pub continued: bool,
    /// Whether it ends where an overlay string has a newline, which is
    /// drawn with no such mark; `continued` then says whether text follows.
    pub broken: bool,
    /// Whether it shows only an overlay string's lines after its first,
    /// no text, so point is never on it and vertical motion passes it.
    pub in_string: bool,
    /// The style of the newline that ends it, when its faces `:extend`
    /// their background to the window's edge, as Emacs draws past a
    /// line's end.
    pub extend: Option<Style>,
    /// What shows in the window's left and right margins beside it, from
    /// `(margin left-margin)` display specs on its text and its strings.
    pub margins: [Vec<Segment>; 2],
    /// The bitmaps display specs put in its left and right fringes.
    pub fringes: [Option<FringeSpec>; 2],
    /// Whether it is in a right-to-left paragraph, its segments reordered
    /// for display and laid out from the window's right edge, as Emacs's
    /// bidi display shows them ([ADR 0047]).
    ///
    /// [ADR 0047]: ../../../docs/adr/0047-bidirectional-text.md
    pub right_to_left: bool,
}

impl Row {
    /// Whether point at `pos` is shown in this row. At the end of a
    /// continued row, point shows at the start of the next.
    pub fn shows_point(&self, pos: usize) -> bool {
        self.start <= pos && (pos < self.end || (pos == self.end && !self.continued))
    }
}

/// How a window wraps long lines: at how many columns, and whether at word
/// boundaries (Emacs's `word-wrap`, which `visual-line-mode` turns on).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Wrap {
    pub(crate) width: usize,
    pub(crate) words: bool,
}

/// What "..." looks like.
const ELLIPSIS: &str = "...";

/// Whether an `invisible` value hides text under a `buffer-invisibility-spec`,
/// and if so whether it shows an ellipsis. As in Emacs: a spec of `true`
/// hides any true value; a list hides values it names, as "name" or
/// `["name", true]` for an ellipsis.
fn invisibility(value: &Value, spec: &Value) -> Option<bool> {
    if !value.is_true() {
        return None;
    }
    let entries = match spec {
        Value::Bool(true) => return Some(false),
        Value::List(entries) => entries,
        _ => return None,
    };
    // Names as strings or symbols, as scripts give either.
    let names: Vec<&str> = match value {
        Value::List(items) => items.iter().filter_map(|v| v.as_str()).collect(),
        other => other.as_str().into_iter().collect(),
    };
    for entry in entries {
        match entry {
            Value::Bool(true) if *value == Value::Bool(true) => return Some(false),
            Value::Str(name) | Value::Symbol(name) if names.contains(&name.as_str()) => return Some(false),
            Value::List(pair) => {
                if let Some(name) = pair.first().and_then(Value::as_str)
                    && names.contains(&name)
                {
                    return Some(pair.get(1).is_some_and(|v| v.is_true()));
                }
            }
            _ => {}
        }
    }
    None
}

impl Editor {
    /// Whether an `invisible` property's value hides text under the current
    /// buffer's `buffer-invisibility-spec`, and if so whether with an
    /// ellipsis, as Emacs's `invisible-p` asks of a property value.
    pub fn invisible_value(&self, value: &Value) -> Option<bool> {
        invisibility(value, &self.invisibility_spec(self.buffer()))
    }

    fn invisibility_spec(&self, b: &Buffer) -> Value {
        self.variable_in(b, "buffer-invisibility-spec").unwrap_or(Value::Bool(true))
    }

    /// Whether the character at `pos` in a buffer is invisible, and if so
    /// whether hidden text there shows an ellipsis.
    pub fn invisible_in(&self, b: &Buffer, pos: usize) -> Option<bool> {
        if pos >= b.len() {
            return None;
        }
        let value = b.char_property(pos, "invisible")?;
        invisibility(value, &self.invisibility_spec(b))
    }

    /// The first visible position at or after `pos`, and whether the hidden
    /// text skipped shows an ellipsis.
    pub fn skip_invisible_in(&self, b: &Buffer, mut pos: usize) -> (usize, bool) {
        let mut ellipsis = false;
        while let Some(e) = self.invisible_in(b, pos) {
            ellipsis |= e;
            pos = b.next_char_property_change(pos);
        }
        (pos, ellipsis)
    }

    /// The end of the line `pos` is on as it shows, as Emacs's
    /// `end-of-visible-line`: past any hidden text that its newline starts,
    /// to the next newline that shows.
    pub fn end_of_visible_line(&self, pos: usize) -> usize {
        let b = self.buffer();
        let mut end = b.line_end(b.line_of(pos));
        while end < b.len() && self.invisible_in(b, end).is_some() {
            end = self.skip_invisible_in(b, end).0;
            end = b.line_end(b.line_of(end));
        }
        end
    }

    /// Whether a buffer line starts a row: the first line does, and so does
    /// any line whose newline before it is visible.
    pub fn line_starts_row_in(&self, b: &Buffer, line: usize) -> bool {
        line == 0 || self.invisible_in(b, b.line_start(line) - 1).is_none()
    }

    /// The line starting the row that contains `line`.
    pub fn row_line_in(&self, b: &Buffer, mut line: usize) -> usize {
        while !self.line_starts_row_in(b, line) {
            line -= 1;
        }
        line
    }

    /// The line `n` rows after the row starting at `line`, backwards if
    /// negative, stopping at the first or last row. Returns the line and how
    /// many rows it moved.
    pub fn move_rows_in(&self, b: &Buffer, mut line: usize, n: i64) -> (usize, i64) {
        let mut moved = 0;
        // Only the accessible lines, when the buffer is narrowed.
        let (first, last) = (b.line_of(b.point_min()), b.line_of(b.point_max()));
        while moved < n.abs() {
            let next = if n > 0 {
                (line + 1..=last.min(b.line_count() - 1)).find(|&l| self.line_starts_row_in(b, l))
            } else {
                (first..line).rev().find(|&l| self.line_starts_row_in(b, l))
            };
            match next {
                Some(l) => line = l,
                None => break,
            }
            moved += 1;
        }
        (line, moved * n.signum())
    }

    /// How many rows lie from the row starting at `from` up to the one starting at `to`.
    pub fn rows_between_in(&self, b: &Buffer, from: usize, to: usize) -> usize {
        (from + 1..=to).filter(|&l| self.line_starts_row_in(b, l)).count()
    }

    /// How point's window wraps lines: the selected window's way, unless the
    /// minibuffer is active or `line-move-visual` is off, when lines move by
    /// text lines.
    pub(crate) fn visual_wrap(&self) -> Option<Wrap> {
        if self.in_minibuffer() || !self.variable("line-move-visual").is_some_and(|v| v.is_true()) {
            return None;
        }
        self.wrap_in(self.selected_window, self.buffer())
    }

    /// Which screen row of its row of text a position shows in, and its
    /// column there, with those screen rows.
    pub(crate) fn screen_position(&self, b: &Buffer, pos: usize, wrap: Option<Wrap>) -> (Vec<Row>, usize, usize) {
        let rows = self.screen_rows_of(b, self.row_line_in(b, b.line_of(pos)), wrap);
        let k = rows.iter().position(|r| r.shows_point(pos)).unwrap_or(rows.len().saturating_sub(1));
        // A reordered line's continued rows can overlap: the one with point's glyph.
        let k = if rows[k].continued && !rows[k].in_string { crate::display::row_showing(&rows, pos, self.tab_width_in(b)).unwrap_or(k) } else { k };
        let glyphs = crate::display::row_glyphs(&rows[k], self.tab_width_in(b));
        let col: usize = glyphs[..crate::display::cursor_glyph(&rows[k], &glyphs, pos)].iter().map(|g| g.width).sum();
        // A right-to-left row is laid out from the window's right edge.
        let col = if rows[k].right_to_left { (col as f32 + self.row_offset_in(self.selected_window, &rows[k])).max(0.0) as usize } else { col };
        (rows, k, col)
    }

    /// The screen line a position of the current buffer shows on in the
    /// selected window: where it starts and ends, and whether the line of
    /// text goes on past it.
    pub fn screen_line(&self, pos: usize) -> (usize, usize, bool) {
        let b = self.buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let (rows, k, _) = self.screen_position(b, pos.min(b.len()), wrap);
        (rows[k].start, rows[k].end, rows[k].continued)
    }

    /// How many screen rows the row of text starting at a line takes.
    pub(crate) fn screen_height_in(&self, b: &Buffer, row_line: usize, wrap: Option<Wrap>) -> usize {
        // A truncated line takes one row, unless an overlay string on it
        // adds more: only the overlays at the row's text are looked at.
        let strings_with_newlines = || {
            let start = b.line_start(row_line);
            let (next, step) = self.move_rows_in(b, row_line, 1);
            let end = if step == 0 { b.len() } else { b.line_start(next) };
            b.overlays_in(start.saturating_sub(1), (end + 1).min(b.len()))
                .iter()
                .any(|o| ["before-string", "after-string"].iter().any(|n| o.props.get(*n).and_then(Value::as_str).is_some_and(|s| s.contains('\n'))))
        };
        if wrap.is_none() && !strings_with_newlines() { 1 } else { self.screen_rows_of(b, row_line, wrap).len().max(1) }
    }

    /// The row of text `screen` screen rows on from the one starting at
    /// `line`, without passing the target, and how many screen rows that is.
    /// Moves at least one row when it can.
    pub(crate) fn move_screen_rows_in(&self, b: &Buffer, line: usize, screen: i64, wrap: Option<Wrap>) -> (usize, i64) {
        if wrap.is_none() {
            return self.move_rows_in(b, line, screen);
        }
        let (mut line, mut moved) = (line, 0i64);
        loop {
            let (next, step) = self.move_rows_in(b, line, screen.signum());
            if step == 0 {
                break;
            }
            let rows = self.screen_height_in(b, if screen > 0 { line } else { next }, wrap) as i64;
            if moved != 0 && moved + rows > screen.abs() {
                break;
            }
            moved += rows;
            line = next;
            if moved >= screen.abs() {
                break;
            }
        }
        (line, moved * screen.signum())
    }

    /// Moves point out of invisible text, as Emacs's command loop does after
    /// each command (`adjust_point_for_property`). Point is inside hidden
    /// text when hidden characters lie on both sides of it. It goes to the
    /// end of the hidden stretch in the direction it moved, or to the near
    /// end if it came from outside the stretch. Where no ellipsis shows and
    /// the command did not change the buffer, the hidden text is passed over
    /// as if it were not there: a move from one edge of it to the other goes
    /// a character further, so C-f over a hidden link's brackets moves past
    /// the first character shown.
    pub(crate) fn adjust_point_for_invisible(&mut self, last_pt: usize, modified: bool) {
        let b = self.buffer();
        let (pt, len) = (b.point(), b.len());
        // As in Emacs's command loop, a command that leaves point where it
        // was leaves it alone, even if its text is now hidden.
        if pt == last_pt {
            return;
        }
        let (mut beg, mut end, mut ellipsis) = (pt, pt, false);
        while end < len
            && let Some(e) = self.invisible_in(b, end)
        {
            ellipsis |= e;
            end = b.next_char_property_change(end);
        }
        while beg > 0
            && let Some(e) = self.invisible_in(b, beg - 1)
        {
            ellipsis |= e;
            beg = self.previous_char_property_change_in(b, beg);
        }
        if !(beg < pt && end > pt) {
            return;
        }
        // Coming from outside the stretch, either end is a move the right
        // way, so the near one is taken; from inside, the far one.
        let outside = last_pt < beg || last_pt > end;
        let mut target = match (outside, pt < last_pt) {
            (true, true) => end,
            (true, false) => beg,
            (false, true) => beg,
            (false, false) => end,
        };
        if !modified && !ellipsis {
            if last_pt == beg && target == end && end < len {
                target = end + 1;
            } else if last_pt == end && target == beg && beg > 0 {
                target = beg - 1;
            } else if target == if target < last_pt { beg } else { end } {
                // As far as it can go without moving back the other way.
            } else {
                // Point sits where typed text would be hidden: go to the
                // other end, if typing there would show.
                let other = if target == beg { end } else { beg };
                if self.pos_invisible_in(b, target) && !self.pos_invisible_in(b, other) {
                    target = other;
                }
            }
        }
        self.buffer_mut().set_point(target);
    }

    /// Where the `invisible` property last changes before `pos`, counting
    /// overlays, as Emacs's `previous-single-char-property-change`.
    fn previous_char_property_change_in(&self, b: &Buffer, pos: usize) -> usize {
        let value = |p: usize| b.char_property(p, "invisible").cloned();
        let here = value(pos - 1);
        let mut p = pos - 1;
        while p > 0 && value(p - 1) == here {
            p -= 1;
        }
        p
    }

    /// Whether text inserted at `pos` would be invisible, as Emacs's
    /// `get-pos-property` sees it: text properties are inherited from the
    /// character before, overlays apply inside them.
    fn pos_invisible_in(&self, b: &Buffer, pos: usize) -> bool {
        let spec = self.invisibility_spec(b);
        let from_overlay = b.overlays_at(pos).into_iter().any(|o| {
            o.start < pos && o.props.get("invisible").is_some_and(|v| invisibility(v, &spec).is_some())
        });
        let from_text = pos > 0 && b.text_property(pos - 1, "invisible").is_some_and(|v| invisibility(v, &spec).is_some());
        from_overlay || from_text
    }

    /// The rows the window shows, from its top line, styled for a dark or
    /// light background. Text properties and overlays give the faces; the
    /// `default` face is left to the front end.
    pub fn window_rows(&self, count: usize, dark: bool) -> Vec<Row> {
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        self.rows_in(b, b.top_line, count, dark, wrap)
    }

    /// Whether a window showing a buffer truncates lines as `truncate-lines`
    /// says, or as `truncate-partial-width-windows` says when the window
    /// shares the frame's width with others: a number when the window is
    /// narrower than it, nil never, and any other value always.
    pub(crate) fn truncates_lines(&self, window: crate::window::WindowId, b: &Buffer) -> bool {
        if self.variable_in(b, "truncate-lines").is_some_and(|v| v.is_true()) {
            return true;
        }
        let width = self.window(window).map_or(80, |w| w.width);
        let partial_truncates = match self.variable_in(b, "truncate-partial-width-windows") {
            Some(Value::Number(limit)) => (width as f64) < limit,
            Some(v) => v.is_true(),
            None => width < 50,
        };
        partial_truncates && self.window_tree.is_partial_width(window)
    }

    /// How a window showing a buffer wraps lines, or `None` if it truncates
    /// them: when `truncate-lines` is on, or when the window shares the
    /// frame's width with others and `truncate-partial-width-windows` says
    /// so, as in Emacs: a number when the window is narrower than it, nil
    /// never, and any other value always. Lines wrap one column short of the
    /// window's width, leaving the last column for the continuation mark.
    pub(crate) fn wrap_in(&self, window: crate::window::WindowId, b: &Buffer) -> Option<Wrap> {
        // A window scrolled horizontally truncates, as Emacs's does.
        if self.truncates_lines(window, b) || self.hscrolled(window) {
            return None;
        }
        let width = self.window(window).map_or(80, |w| w.width);
        let words = self.variable_in(b, "word-wrap").is_some_and(|v| v.is_true());
        let numbers = self.line_number_columns(window, b);
        // Without fringes the last column holds the continuation mark.
        let mark = usize::from(!self.metrics.fringes());
        Some(Wrap { width: width.saturating_sub(mark + numbers).max(1), words })
    }

    /// How a buffer numbers its lines, as `display-line-numbers` says, or
    /// `None` if it does not.
    fn line_number_kind(&self, b: &Buffer) -> Option<LineNumberKind> {
        match self.variable_in(b, "display-line-numbers")? {
            Value::Null | Value::Bool(false) => None,
            Value::Str(s) if s == "relative" => Some(LineNumberKind::Relative),
            Value::Str(s) if s == "visual" => Some(LineNumberKind::Visual),
            _ => Some(LineNumberKind::Absolute),
        }
    }

    /// A window's top line and point.
    fn window_top_and_point(&self, window: crate::window::WindowId, b: &Buffer) -> (usize, usize) {
        if window == self.selected_window {
            (b.top_line, b.point())
        } else {
            (b.window_start(window).map_or(0, |p| b.line_of(p)), b.window_point(window).unwrap_or(b.point()))
        }
    }

    /// How many columns a window's line numbers take, the space either side
    /// included, or 0 if its buffer shows none: as many digits as the
    /// largest number the window can show, as Emacs's redisplay works it
    /// out, or `display-line-numbers-width` if that is more.
    pub(crate) fn line_number_columns(&self, window: crate::window::WindowId, b: &Buffer) -> usize {
        let Some(kind) = self.line_number_kind(b) else { return 0 };
        let height = self.window(window).map_or(24, |w| w.height).max(1);
        let (top, point) = self.window_top_and_point(window, b);
        let base = b.line_of(b.point_min());
        let max = match kind {
            LineNumberKind::Visual => b.line_of(point).saturating_sub(base) + height,
            _ => top.saturating_sub(base) + height,
        }
        .max(1);
        let least = self.variable_in(b, "display-line-numbers-width").and_then(|v| v.as_number()).unwrap_or(0.0) as usize;
        max.to_string().len().max(least) + 2
    }

    /// The line numbers beside a window's rows, as Emacs's
    /// `display-line-numbers` shows them: each line's number on its first
    /// row, counted from the start of the accessible text, or from point's
    /// line when relative, where point's line shows its own number unless
    /// `display-line-numbers-current-absolute` is off. `None` if the buffer
    /// shows none.
    pub fn line_numbers(&self, window: crate::window::WindowId, rows: &[Row]) -> Option<LineNumbers> {
        let b = self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).find(|v| v.id == window).map(|v| v.buffer)?;
        let kind = self.line_number_kind(b)?;
        let width = self.line_number_columns(window, b);
        let (_, point) = self.window_top_and_point(window, b);
        let base = b.line_of(b.point_min());
        let point_line = b.line_of(point);
        let absolute_current = self.variable_in(b, "display-line-numbers-current-absolute").is_none_or(|v| v.is_true());
        let point_row = rows.iter().position(|r| r.shows_point(point));
        let labels = rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                let current = row.line == point_line;
                // Rows after one an overlay string's newline ended continue its line.
                let first = row.start == b.line_start(row.line).max(b.point_min()) && !(i > 0 && rows[i - 1].broken);
                let number = match kind {
                    LineNumberKind::Absolute => row.line - base + 1,
                    LineNumberKind::Relative if current && absolute_current => row.line - base + 1,
                    LineNumberKind::Relative => row.line.abs_diff(point_line),
                    LineNumberKind::Visual if current && absolute_current => row.line - base + 1,
                    LineNumberKind::Visual => point_row.map_or(0, |p| p.abs_diff(i)),
                };
                // Continued rows of a line, and rows past the text, have none.
                let shown = (first || kind == LineNumberKind::Visual) && row.start <= b.point_max();
                let text = if shown { format!("{number:>w$} ", w = width - 1) } else { " ".repeat(width) };
                (text, current)
            })
            .collect();
        Some(LineNumbers { width, labels })
    }

    /// The rows of a buffer from a top line, as a window showing it would show them.
    pub(crate) fn rows_in(&self, b: &Buffer, top_line: usize, count: usize, dark: bool, wrap: Option<Wrap>) -> Vec<Row> {
        self.rows_from(b, top_line, count, usize::MAX, Some(dark), wrap)
    }

    /// The screen rows of the row starting at a line, unstyled, for moving
    /// by screen lines.
    pub(crate) fn screen_rows_of(&self, b: &Buffer, row_line: usize, wrap: Option<Wrap>) -> Vec<Row> {
        self.rows_from(b, row_line, usize::MAX, 1, None, wrap)
    }

    /// Up to `count` screen rows from up to `lines` rows of text from a top
    /// line, styled for a dark or light background, or unstyled with `None`.
    pub(crate) fn rows_from(
        &self,
        b: &Buffer,
        top_line: usize,
        count: usize,
        lines: usize,
        dark: Option<bool>,
        wrap: Option<Wrap>,
    ) -> Vec<Row> {
        // Measured off the grid, rows wrap by their fonts, so even rows for
        // moving by need their styles.
        let dark = dark.or((!self.metrics.uniform()).then_some(true));
        // Only the accessible portion shows, as in a narrowed Emacs buffer.
        let len = b.point_max();
        let mut logical = 0;
        // How many lines to work syntax faces out for at a time.
        let hint = count.min(lines).min(1000);
        let mut styles: HashMap<Vec<String>, Style> = HashMap::new();
        let mut rows = Vec::new();
        let mut pos = b.line_start(self.row_line_in(b, top_line.min(b.line_count() - 1))).max(b.point_min());
        // Where overlay strings were last shown, so each shows once.
        let mut strings_at = None;
        // Syntax faces, worked out for a window's worth of lines at a time.
        let mut syntax = SyntaxFaces::default();
        // How lines with bidirectional text are reordered, if any can be.
        let mut bidi = self.bidi_lines(b);
        while rows.len() < count && logical < lines {
            logical += 1;
            let (start, line) = (pos, b.line_of(pos));
            let mut segments: Vec<Segment> = self.prefix_segments(b, start, "line-prefix", dark, &mut styles);
            let prefix_len = segments.len();
            let mut extend = None;
            let end = loop {
                if pos >= len {
                    // Strings at the end of the buffer show too, as icomplete's list does.
                    if strings_at != Some(pos) {
                        strings_at = Some(pos);
                        self.push_overlay_strings(b, pos, &mut segments, dark, &mut styles);
                    }
                    break len;
                }
                let (visible, ellipsis) = self.skip_invisible_in(b, pos);
                if visible > pos {
                    if ellipsis && !segments.last().is_some_and(|s| s.ellipsis) {
                        segments.extend(self.ellipsis_segments(b, pos, dark, &mut styles));
                    }
                    pos = visible;
                    continue;
                }
                if strings_at != Some(pos) {
                    strings_at = Some(pos);
                    self.push_overlay_strings(b, pos, &mut segments, dark, &mut styles);
                }
                let line_end = b.line_end(b.line_of(pos)).min(len);
                if pos == line_end {
                    // A visible newline ends the row, its faces' background
                    // and lines going on to the edge if they extend.
                    if let Some(dark) = dark
                        && pos < len
                    {
                        // After an ellipsis, in the faces it is drawn over, as
                        // Emacs goes on in the face kept for it: a folded
                        // block's #+begin line, not its hidden #+end line.
                        let faces = match segments.last() {
                            Some(last) if last.ellipsis => self.ellipsis_faces(b, last.start),
                            _ => self.faces_at(b, pos),
                        };
                        if !faces.is_empty() {
                            let style = styles.entry(faces).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone();
                            if style.extend && (style.background.is_some() || style.underline || style.overline) {
                                extend = Some(style);
                            }
                        }
                    }
                    break pos;
                }
                if let Some((end, segment)) = self.display_at(b, pos, line_end, &segments, dark, &mut styles) {
                    segments.extend(segment);
                    pos = end;
                    continue;
                }
                let mut chunk_end = b.next_char_property_change(pos).min(line_end);
                let style = match dark {
                    Some(dark) => {
                        let syntax_face = syntax.at(b, pos, hint);
                        chunk_end = syntax.next_change(b, pos, chunk_end, hint);
                        let mut faces = self.faces_at(b, pos);
                        faces.extend(syntax_face.map(String::from));
                        styles.entry(faces).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone()
                    }
                    None => Style::default(),
                };
                segments.push(Segment::text(pos, b.slice(pos..chunk_end), style));
                pos = chunk_end;
            };
            // What goes in the margins shows beside the line's first row.
            let (beside, segments): (Vec<Segment>, Vec<Segment>) = segments.into_iter().partition(|s| s.margin.is_some() || s.fringe.is_some());
            let mut margins = [Vec::new(), Vec::new()];
            let mut fringes = [None, None];
            for seg in beside {
                match (seg.margin, &seg.fringe) {
                    (_, Some(f)) => fringes[usize::from(f.side == Margin::Right)] = Some(f.clone()),
                    (Some(side), None) => margins[usize::from(side == Margin::Right)].push(seg),
                    (None, None) => {}
                }
            }
            let mut row = Row { line, start, end, segments, continued: false, broken: false, in_string: false, extend, margins, fringes, right_to_left: false };
            // Reordered for display where the line has bidirectional text.
            let reordered = bidi.as_mut().and_then(|lines| lines.reorder(self, b, &mut row, prefix_len));
            // The line prefix is no place to break a line, as in Emacs.
            let prefix_chars: usize = row.segments[..prefix_len.min(row.segments.len())].iter().map(|s| s.text.chars().count()).sum();
            for (n, row) in split_at_string_newlines(row).into_iter().enumerate() {
                if rows.len() >= count {
                    break;
                }
                match wrap {
                    Some(wrap) => {
                        let tab_width = self.tab_width_in(b);
                        // Continued rows start with the wrap prefix, which takes room from them.
                        let prefix = self.prefix_segments(b, start, "wrap-prefix", dark, &mut styles);
                        let indent: usize = prefix.iter().map(|s| crate::display::display_width(&s.text, tab_width)).sum();
                        let wrapped = wrap_row(self, row, wrap, tab_width, indent, if n == 0 { prefix_chars } else { 0 });
                        let room = count - rows.len();
                        rows.extend(wrapped.into_iter().take(room).enumerate().map(|(i, mut r)| {
                            r.line = b.line_of(r.start);
                            if i > 0 && !prefix.is_empty() {
                                let shown = prefix.iter().map(|s| Segment { start: r.start, ..s.clone() });
                                r.segments.splice(0..0, shown);
                            }
                            if let Some(dir) = reordered {
                                self.finish_bidi_row(&mut r, dir, i == 0, start, end, tab_width);
                            }
                            r
                        }));
                    }
                    None => {
                        let mut row = row;
                        if let Some(dir) = reordered {
                            self.finish_bidi_row(&mut row, dir, true, start, end, self.tab_width_in(b));
                        }
                        rows.push(row)
                    }
                }
            }
            if end >= len {
                break;
            }
            pos = end + 1;
        }
        rows
    }

    /// The faces an ellipsis for text hidden from `pos` is drawn over: the
    /// faces there, when the character before has the same, as Emacs's
    /// setup_for_ellipsis keeps that face, and else none, the default face:
    /// a folded block's ellipsis on its #+begin line's background.
    fn ellipsis_faces(&self, b: &Buffer, pos: usize) -> Vec<String> {
        if pos == 0 || pos >= b.len() {
            return Vec::new();
        }
        let at = self.faces_at(b, pos);
        if at == self.faces_at(b, pos - 1) { at } else { Vec::new() }
    }

    /// What hidden text with an ellipsis shows as: the string in the
    /// selective-display slot of the buffer's display table, or else the
    /// standard one's, in its own faces, as Emacs draws the glyphs there;
    /// else "...".
    fn ellipsis_segments(&self, b: &Buffer, pos: usize, dark: Option<bool>, styles: &mut HashMap<Vec<String>, Style>) -> Vec<Segment> {
        let slot = ["buffer-display-table", "standard-display-table"].iter().find_map(|name| match self.variable_in(b, name) {
            Some(Value::CharTable(id)) => self.char_table_extra_slot(id, 4).ok().filter(|v| v.as_str().is_some_and(|s| !s.is_empty())),
            _ => None,
        });
        let base = self.ellipsis_faces(b, pos);
        match slot {
            Some(value) => {
                let mut out = self.string_segments(b, pos, &value, None, &base, dark, styles);
                for s in &mut out {
                    s.ellipsis = true;
                    s.string = false;
                }
                out
            }
            None => {
                let style = dark.filter(|_| !base.is_empty()).map_or_else(Style::default, |dark| styles.entry(base).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone());
                vec![Segment { ellipsis: true, ..Segment::text(pos, ELLIPSIS.to_string(), style) }]
            }
        }
    }

    /// What a line or its continued rows start with, as Emacs's
    /// `line-prefix` and `wrap-prefix` give it: the property of the text at
    /// the line's start, or else the buffer's variable, if it is a string.
    fn prefix_segments(&self, b: &Buffer, pos: usize, name: &str, dark: Option<bool>, styles: &mut HashMap<Vec<String>, Style>) -> Vec<Segment> {
        let at = if pos < b.len() { b.char_property(pos, name).cloned() } else { None };
        match at.or_else(|| self.variable_in(b, name)) {
            Some(value @ (Value::Str(_) | Value::Text(_))) => self.string_segments(b, pos, &value, None, &[], dark, styles),
            _ => Vec::new(),
        }
    }

    /// The overlay strings that show at a position, as Emacs orders them:
    /// the `after-string`s of overlays ending there, then the
    /// `before-string`s of those starting there. An overlay hidden by its
    /// own `invisible` property shows none. A propertized string shows in
    /// its own faces; a newline ends one.
    fn push_overlay_strings(&self, b: &Buffer, pos: usize, segments: &mut Vec<Segment>, dark: Option<bool>, styles: &mut HashMap<Vec<String>, Style>) {
        let spec = self.variable_in(b, "buffer-invisibility-spec").unwrap_or(Value::Bool(true));
        let mut overlays: Vec<&crate::properties::Overlay> = b
            .overlays_at_edge(pos)
            .into_iter()
            .filter(|o| !o.props.get("invisible").is_some_and(|v| invisibility(v, &spec).is_some()))
            .collect();
        overlays.sort_by(|a, b| a.priority().total_cmp(&b.priority()).then(a.id.cmp(&b.id)));
        // An empty overlay's before-string comes before its own after-string.
        let ending = overlays.iter().filter(|o| o.end == pos && o.start != pos).map(|o| (*o, "after-string"));
        let starting = overlays
            .iter()
            .filter(|o| o.start == pos)
            .flat_map(|o| std::iter::once((*o, "before-string")).chain((o.end == pos).then_some((*o, "after-string"))));
        for (o, name) in ending.chain(starting) {
            if let Some(value) = o.props.get(name) {
                segments.extend(self.string_segments(b, pos, value, None, &[], dark, styles));
            }
        }
    }

    /// The segments a string shows as, at `pos`: a propertized string's
    /// stretches in their faces, over `base`, the faces of the text a
    /// display string stands for, up to the first newline.
    #[allow(clippy::too_many_arguments)]
    fn string_segments(
        &self,
        b: &Buffer,
        pos: usize,
        value: &Value,
        covers: Option<usize>,
        base: &[String],
        dark: Option<bool>,
        styles: &mut HashMap<Vec<String>, Style>,
    ) -> Vec<Segment> {
        let Some(string) = value.as_str() else { return Vec::new() };
        // A display string shows up to its first newline; an overlay's
        // goes on in rows of its own, as in Emacs.
        let string = if covers.is_some() { string.split('\n').next().unwrap_or_default() } else { string };
        let mut out: Vec<Segment> = Vec::new();
        let mut last: Option<Vec<String>> = None;
        let mut breaks = false;
        // A run of characters whose display puts a string in a margin shows
        // that string there, once, and nothing in their place.
        let mut margin_run: Option<&Value> = None;
        for (i, c) in string.chars().enumerate() {
            let display = match value {
                Value::Text(t) => t.properties_at(i).and_then(|p| p.get("display")),
                _ => None,
            };
            if let Some(d) = display.filter(|d| crate::image::image_display(d).is_some() && self.images_shown()) {
                if margin_run != Some(d) {
                    let props = match value {
                        Value::Text(t) => t.properties_at(i),
                        _ => None,
                    };
                    let style = || {
                        let mut faces: Vec<String> = props.and_then(|p| p.get("face")).map(face_names).unwrap_or_default();
                        faces.extend(base.iter().cloned());
                        dark.map_or_else(Style::default, |dark| styles.entry(faces).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone())
                    };
                    out.extend(self.image_string_segment(pos, d, covers, style));
                    margin_run = Some(d);
                    last = None;
                }
                continue;
            }
            if let Some(fringe) = display.and_then(fringe_spec) {
                if margin_run != display {
                    out.push(Segment { string: true, covers, fringe: Some(fringe), ..Segment::text(pos, String::new(), Style::default()) });
                    margin_run = display;
                    last = None;
                }
                continue;
            }
            if let Some(spec) = display.filter(|d| margin_spec(d).is_some()) {
                if margin_run != Some(spec) {
                    let (side, shown) = margin_spec(spec).expect("checked");
                    let mut segs = self.string_segments(b, pos, shown, covers, base, dark, styles);
                    segs.iter_mut().for_each(|s| s.margin = Some(side));
                    out.extend(segs);
                    margin_run = Some(spec);
                    last = None;
                }
                continue;
            }
            margin_run = None;
            if c == '\n' {
                // A newline right after another leaves an empty row.
                if breaks {
                    out.push(Segment { string: true, covers, breaks, ..Segment::text(pos, String::new(), Style::default()) });
                }
                breaks = true;
                continue;
            }
            let props = match value {
                Value::Text(t) => t.properties_at(i),
                _ => None,
            };
            let mut faces: Vec<String> = props.and_then(|p| p.get("face")).map(face_names).unwrap_or_default();
            faces.extend(base.iter().cloned());
            let cursor = props.and_then(|p| p.get("cursor")).is_some_and(Value::is_true);
            match out.last_mut() {
                Some(seg) if last.as_ref() == Some(&faces) && !breaks && !cursor => seg.text.push(c),
                _ => {
                    let style = match dark {
                        Some(dark) => styles.entry(faces.clone()).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone(),
                        None => Style::default(),
                    };
                    out.push(Segment { string: true, covers, breaks, cursor, ..Segment::text(pos, c.to_string(), style) });
                    last = Some(faces);
                    breaks = false;
                }
            }
        }
        // A newline at the very end starts a row with nothing in it yet.
        if breaks {
            out.push(Segment { string: true, covers, breaks, ..Segment::text(pos, String::new(), Style::default()) });
        }
        out
    }

    /// What a `display` property at `pos` shows instead of the text it is
    /// on, up to where the property changes or the line ends, and where
    /// that is: a string, in the face of the text it stands for, or space
    /// for a `(space :width N)` or `(space :align-to COLUMN)` spec. `None`
    /// if the property is not one of these.
    fn display_at(
        &self,
        b: &Buffer,
        pos: usize,
        line_end: usize,
        segments: &[Segment],
        dark: Option<bool>,
        styles: &mut HashMap<Vec<String>, Style>,
    ) -> Option<(usize, Vec<Segment>)> {
        let value = b.char_property(pos, "display")?.clone();
        if crate::image::image_display(&value).is_some() {
            return self.image_display_at(b, pos, line_end, &value, self.display_style(b, pos, dark, styles)).flatten();
        }
        if let Some(fringe) = fringe_spec(&value) {
            // The text is replaced by nothing; the bitmap shows in the fringe.
            let mut end = pos;
            while end < line_end && b.char_property(end, "display") == Some(&value) {
                end = b.next_char_property_change(end).min(line_end).max(end + 1);
            }
            return Some((end, vec![Segment { string: true, covers: Some(end), fringe: Some(fringe), ..Segment::text(pos, String::new(), Style::default()) }]));
        }
        if let Some((side, string)) = margin_spec(&value) {
            // The text is replaced by nothing; the string shows in the margin.
            let mut end = pos;
            while end < line_end && b.char_property(end, "display") == Some(&value) {
                end = b.next_char_property_change(end).min(line_end).max(end + 1);
            }
            let mut shown = self.string_segments(b, pos, string, Some(end), &[], dark, styles);
            shown.iter_mut().for_each(|s| s.margin = Some(side));
            if shown.is_empty() {
                // Still covering the text, so it is hidden.
                shown.push(Segment { string: true, covers: Some(end), margin: Some(side), ..Segment::text(pos, String::new(), Style::default()) });
            }
            return Some((end, shown));
        }
        let text = match &value {
            Value::Str(_) | Value::Text(_) => String::new(),
            Value::List(items) if items.first().and_then(Value::as_str) == Some("space") => {
                let get = |key: &str| items.iter().position(|v| v.as_str() == Some(key)).and_then(|i| items.get(i + 1)?.as_number());
                let width = match (get(":width"), get(":align-to")) {
                    (Some(w), _) => w.max(0.0) as usize,
                    (None, Some(column)) => {
                        let tab_width = self.tab_width_in(b);
                        let col: usize = segments.iter().map(|s| crate::display::display_width(&s.text, tab_width)).sum();
                        (column.max(0.0) as usize).saturating_sub(col)
                    }
                    (None, None) => 1,
                };
                " ".repeat(width)
            }
            _ => return None,
        };
        // The text the property covers, as far as it is the same value.
        let mut end = pos;
        while end < line_end && b.char_property(end, "display") == Some(&value) {
            end = b.next_char_property_change(end).min(line_end).max(end + 1);
        }
        let base = self.faces_at(b, pos);
        let shown = match &value {
            Value::Str(_) | Value::Text(_) => value.clone(),
            _ => Value::Str(text),
        };
        Some((end, self.string_segments(b, pos, &shown, Some(end), &base, dark, styles)))
    }

    /// The style of the text at a position, for an image shown in its
    /// place, unstyled when rows are worked out without styles.
    fn display_style(&self, b: &Buffer, pos: usize, dark: Option<bool>, styles: &mut HashMap<Vec<String>, Style>) -> Style {
        match dark {
            Some(dark) => styles.entry(self.faces_at(b, pos)).or_insert_with_key(|f| self.style_for_in(b, f, dark)).clone(),
            None => Style::default(),
        }
    }

    /// The faces at a position, apart from syntax: overlays' first, highest priority first,
    /// then the text's own. Text with no `face` takes its `font-lock-face`,
    /// as Emacs's font-lock-mode, always on here, makes it an alias.
    pub(crate) fn faces_at(&self, b: &Buffer, pos: usize) -> Vec<String> {
        let mut faces: Vec<String> = b
            .overlays_at(pos)
            .into_iter()
            .filter_map(|o| o.props.get("face"))
            .flat_map(face_names)
            .collect();
        if let Some(face) = b.text_property(pos, "face").or_else(|| b.text_property(pos, "font-lock-face")) {
            faces.extend(face_names(face));
        }
        faces
    }
}

/// Splits a row of text into screen rows no wider than the wrap width, at
/// the last space before the edge with word wrap, otherwise at the edge.
/// Tabs are measured from the start of each screen row. An ellipsis is
/// never split.
/// A row split where an overlay string has a newline: the row before
/// ends where the string shows, continued if buffer text follows after it.
fn split_at_string_newlines(row: Row) -> Vec<Row> {
    if !row.segments.iter().any(|s| s.breaks) {
        return vec![row];
    }
    let mut rows = Vec::new();
    let mut current = Row { segments: Vec::new(), ..row.clone() };
    for seg in row.segments {
        if seg.breaks && rows.len() < 1000 {
            let at = seg.start;
            let next = Row {
                line: current.line,
                start: at,
                end: current.end,
                segments: Vec::new(),
                continued: false,
                broken: false,
                in_string: false,
                extend: current.extend.take(),
                margins: Default::default(),
                fringes: Default::default(),
                right_to_left: current.right_to_left,
            };
            let mut done = std::mem::replace(&mut current, next);
            done.end = at;
            done.broken = true;
            rows.push(done);
        }
        if !seg.text.is_empty() {
            current.segments.push(Segment { breaks: false, ..seg });
        }
    }
    rows.push(current);
    // Point where a string broke shows in the row after it if text follows.
    let n = rows.len();
    for row in &mut rows[1..] {
        row.in_string = !row.segments.iter().any(|s| !s.string);
    }
    for i in 0..n - 1 {
        let follows = rows[i + 1..].iter().any(|r| r.segments.iter().any(|s| !s.string && !s.ellipsis)) || rows[n - 1].end > rows[i].end;
        rows[i].continued = follows;
    }
    rows
}

/// Breaks a row into screen rows `wrap.width` default columns wide. A row
/// on the grid is measured in cells; another, glyph by glyph as the
/// metrics measure its fonts, so text of other sizes and proportional
/// text wrap where they would pass the window's edge. The first
/// `prefix` characters, the line prefix, are no place to break between
/// words, so a word too long for the row breaks where the row is full.
fn wrap_row(ed: &Editor, row: Row, wrap: Wrap, tab_width: usize, indent: usize, prefix: usize) -> Vec<Row> {
    // Every character of the row, as (segment, index in the segment).
    let items: Vec<(usize, usize)> = row
        .segments
        .iter()
        .enumerate()
        .flat_map(|(s, seg)| (0..seg.text.chars().count()).map(move |i| (s, i)))
        .collect();
    let chars: Vec<Vec<char>> = row.segments.iter().map(|s| s.text.chars().collect()).collect();
    let char_of = |k: usize| chars[items[k].0][items[k].1];
    let in_ellipsis = |k: usize| row.segments[items[k].0].unbroken();
    let on_grid = ed.row_on_grid(&row);
    let mut scratch = String::new();
    let mut width_of = |k: usize, col: f32| {
        if on_grid {
            scratch.clear();
            crate::display::render_char(char_of(k), col as usize, tab_width, &mut scratch) as f32
        } else {
            ed.char_columns(&row.segments[items[k].0], char_of(k), col, tab_width)
        }
    };
    let width = wrap.width as f32;
    let mut breaks = Vec::new();
    let (mut row_start, mut col, mut last_space) = (0, 0.0f32, None);
    let mut k = 0;
    while k < items.len() {
        let w = width_of(k, col);
        if col + w > width && k > row_start {
            let mut at = match last_space {
                Some(space) if wrap.words && space > row_start.max(prefix) => space,
                _ => k,
            };
            // Back to the start of an ellipsis, or past it if it starts the row.
            while at > row_start && in_ellipsis(at) && items[at - 1].0 == items[at].0 {
                at -= 1;
            }
            if at == row_start {
                at = k;
                while at < items.len() && in_ellipsis(at) && at > 0 && items[at - 1].0 == items[at].0 {
                    at += 1;
                }
            }
            if at >= items.len() {
                break;
            }
            breaks.push(at);
            row_start = at;
            last_space = None;
            // A continued row starts after the wrap prefix, and its tabs are
            // measured from the row's start, as they are drawn.
            col = indent.min(wrap.width.saturating_sub(1)) as f32;
            k = at;
            continue;
        }
        col += w;
        if wrap.words && matches!(char_of(k), ' ' | '\t') {
            last_space = Some(k + 1);
        }
        k += 1;
    }
    if breaks.is_empty() {
        return vec![row];
    }
    let position_of = |k: usize| {
        let (s, i) = items[k];
        let seg = &row.segments[s];
        if seg.atomic() { seg.start } else { seg.start + i }
    };
    let mut bounds = vec![0];
    bounds.extend(&breaks);
    bounds.push(items.len());
    let mut out = Vec::new();
    for (n, pair) in bounds.windows(2).enumerate() {
        let (from, to) = (pair[0], pair[1]);
        let mut segments: Vec<Segment> = Vec::new();
        for k in from..to {
            let (s, i) = items[k];
            let seg = &row.segments[s];
            match segments.last_mut() {
                Some(last) if k > from && items[k - 1].0 == s => last.text.push(chars[s][i]),
                _ => segments.push(Segment {
                    start: if seg.atomic() { seg.start } else { seg.start + i },
                    text: chars[s][i].to_string(),
                    ..seg.clone()
                }),
            }
        }
        let last = n + 2 == bounds.len();
        let start = if n == 0 { row.start } else { position_of(from) };
        let end = if last { row.end } else { position_of(to) };
        let extend = if last { row.extend.clone() } else { None };
        let (margins, fringes) = if n == 0 { (row.margins.clone(), row.fringes.clone()) } else { Default::default() };
        out.push(Row { line: row.line, start, end, segments, continued: !last || row.continued, broken: last && row.broken, in_string: row.in_string, extend, margins, fringes, right_to_left: row.right_to_left });
    }
    out
}

/// The faces tree-sitter gives a stretch of the buffer.
#[derive(Default)]
struct SyntaxFaces {
    start: usize,
    faces: Vec<Option<&'static str>>,
}

impl SyntaxFaces {
    fn at(&mut self, b: &Buffer, pos: usize, lines: usize) -> Option<&'static str> {
        let syntax = b.primary_syntax()?;
        if pos < self.start || pos >= self.start + self.faces.len() {
            let line = b.line_of(pos);
            let end = b.line_start((line + lines.max(1)).min(b.line_count() - 1)).max(b.line_end(line));
            self.start = pos;
            self.faces = syntax.faces(b.text(), pos, end.max(pos + 1).min(b.len()));
        }
        self.faces.get(pos - self.start).copied().flatten()
    }

    /// Where the syntax face next changes after `pos`, up to `limit`.
    fn next_change(&mut self, b: &Buffer, pos: usize, limit: usize, lines: usize) -> usize {
        if b.primary_syntax().is_none() {
            return limit;
        }
        let face = self.at(b, pos, lines);
        let mut next = pos + 1;
        while next < limit && self.at(b, next, lines) == face {
            next += 1;
        }
        next.min(limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(text: &str) -> Editor {
        let mut ed = Editor::new();
        ed.window_buffer_mut().set_text(text);
        ed
    }

    fn row_texts(ed: &Editor) -> Vec<String> {
        ed.window_rows(20, true)
            .iter()
            .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
            .collect()
    }

    #[test]
    fn rows_are_lines_with_their_faces() {
        let mut ed = editor("plain bold\nnext");
        ed.window_buffer_mut().put_text_property(6..10, "face", Value::Str("bold".into()));
        let rows = ed.window_rows(10, true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].segments.len(), 2);
        assert!(!rows[0].segments[0].style.bold);
        assert!(rows[0].segments[1].style.bold);
        assert_eq!((rows[0].end, rows[1].start), (10, 11));
    }

    #[test]
    fn hidden_text_joins_rows_and_can_show_an_ellipsis() {
        let mut ed = editor("* one\nbody\nmore\n* two");
        let b = ed.window_buffer_mut();
        let id = b.make_overlay(5..15);
        b.overlay_put(id, "invisible", Value::Str("outline".into())).unwrap();
        // Without the spec naming it, the overlay hides nothing.
        ed.set_variable("buffer-invisibility-spec", Value::List(vec![]));
        assert_eq!(row_texts(&ed), ["* one", "body", "more", "* two"]);
        ed.set_variable(
            "buffer-invisibility-spec",
            Value::List(vec![Value::List(vec!["outline".into(), Value::Bool(true)])]),
        );
        assert_eq!(row_texts(&ed), ["* one...", "* two"]);
        let b = ed.window_buffer();
        assert!(ed.line_starts_row_in(b, 3));
        assert!(!ed.line_starts_row_in(b, 1));
        assert_eq!(ed.move_rows_in(b, 0, 1), (3, 1));
        assert_eq!(ed.row_line_in(b, 2), 0);
    }

    #[test]
    fn invisible_true_hides_with_the_default_spec() {
        let mut ed = editor("abcdef");
        ed.window_buffer_mut().put_text_property(1..3, "invisible", Value::Bool(true));
        assert_eq!(row_texts(&ed), ["adef"]);
    }
}
