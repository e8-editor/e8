//! What a frame shows, as plain data a front end draws from: step 2 of
//! docs/multithreading.md. After redisplay the core describes each frame:
//! for each window, its rows with their styles, glyphs and geometry, the
//! cursor, the region, line numbers, fringes, margins and images, its
//! mode line and header line; and the echo area or the minibuffer's rows.
//! A front end draws only from this, never asking the editor, so the
//! editor can run on a thread of its own while the window draws the last
//! description it has (step 3).
//!
//! Units are the front end's, as the layout's are: the metrics it gave the
//! editor measure every width and height here.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

use crate::display::{Glyph, row_glyphs};
use crate::editor::Editor;
use crate::faces::Style;
use crate::fringe::{FringeBitmap, WindowFringes};
use crate::image::Rgba;
use crate::modeline::ModeLineSegment;
use crate::rows::{FringeSpec, LineNumbers, Margin, Row};
use crate::window::{FrameId, WindowId};

/// Whether a frame is shown, as its `visibility` parameter says: t, nil
/// or `icon`, as Emacs's `frame-visible-p` gives it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Visibility {
    #[default]
    Visible,
    Hidden,
    Iconified,
}

/// One frame as a front end draws it.
#[derive(Clone, Debug)]
pub struct FrameDescription {
    pub frame: FrameId,
    /// Its title, as `frame-title-format` gives it.
    pub title: String,
    /// Whether its styles are for a dark background.
    pub dark: bool,
    /// How its windows divide it.
    pub tree: crate::window::WindowTree,
    /// How many lines the echo area takes, more for a minibuffer showing
    /// completions.
    pub echo_lines: usize,
    /// Whether it is the selected frame, whose echo area shows prompts.
    pub selected: bool,
    /// Whether it is shown, hidden or iconified, from its `visibility` parameter.
    pub visibility: Visibility,
    /// How many times it has been raised: a front end brings it in front
    /// when this grows.
    pub raised: u64,
    /// Whether the minibuffer's window is selected, so it has the cursor.
    pub minibuffer_selected: bool,
    pub windows: Vec<WindowDescription>,
    pub echo: Echo,
    /// The tab bar along its top, if it shows one, as the mode line is drawn.
    pub tab_bar: Option<Vec<(ModeLineSegment, Style)>>,
    /// The faces of the parts a front end draws in its own look, where a
    /// theme has given them colours of their own.
    pub chrome: Chrome,
    /// The `default` face, which text without faces of its own shows in.
    pub default_style: Style,
    /// Fringe bitmaps `define-fringe-bitmap` defined, by name, for drawing
    /// those the windows show; the standard ones front ends draw themselves.
    pub fringe_bitmaps: HashMap<String, FringeBitmap>,
    /// Each image's pixels, by its id, for the images the windows show.
    pub images: HashMap<u64, Option<Arc<Rgba>>>,
}

/// The styles of the faces a front end draws its own parts in, such as
/// `mode-line`, each only if the face has a background of its own, as a
/// theme gives one; without, the front end draws the part in its own look.
#[derive(Clone, Debug, Default)]
pub struct Chrome {
    pub mode_line: Option<Style>,
    pub mode_line_inactive: Option<Style>,
    pub header_line: Option<Style>,
    pub tab_bar: Option<Style>,
    pub tab_bar_tab: Option<Style>,
    pub tab_bar_tab_inactive: Option<Style>,
    /// The `cursor` face, whose background is the cursor's colour.
    pub cursor: Option<Style>,
}

/// What the echo area shows.
#[derive(Clone, Debug)]
pub enum Echo {
    /// A message's lines, as the echo area shows them, or none.
    Message(Vec<String>),
    /// The minibuffer while a prompt is open: its rows, as a window's, and
    /// where point is in it.
    Prompt { rows: Vec<RowDescription>, point: usize, point_row: Option<usize> },
}

/// One window as a front end draws it.
#[derive(Clone, Debug)]
pub struct WindowDescription {
    pub id: WindowId,
    /// The buffer it shows, the first line it shows, and how many lines
    /// the buffer has, for scrolling.
    pub buffer: String,
    pub top_line: usize,
    pub line_count: usize,
    /// Whether it is the frame's selected window.
    pub selected: bool,
    pub point: usize,
    /// The region, shown only in the selected window, as Emacs shows it.
    pub region: Option<Range<usize>>,
    pub tab_width: usize,
    /// The rows that fill it, one more partly shown when scrolled between lines.
    pub rows: Vec<RowDescription>,
    /// The row point shows on, if any.
    pub point_row: Option<usize>,
    /// How many columns it is scrolled to the left, as `window-hscroll`.
    pub hscroll: usize,
    /// How far its rows are drawn above its top, in the front end's units,
    /// as `window-vscroll`: the part of its first row scrolled out of sight.
    pub vscroll: f32,
    pub line_numbers: Option<LineNumbers>,
    /// `line-number` and `line-number-current-line`.
    pub line_number_styles: [Style; 2],
    pub region_style: Style,
    /// What its fringes show, for rows not truncated at either side.
    pub fringes: WindowFringes,
    /// The bitmaps a row truncated on the left or right shows instead,
    /// unless a display spec put one there, as fringe.c gives them priority.
    pub truncation: [Option<FringeSpec>; 2],
    /// Each fringe bitmap's style, from its face, by bitmap and face.
    pub fringe_styles: HashMap<(String, Option<String>), Style>,
    /// Whether its cursor is drawn, as `internal-show-cursor` says.
    pub cursor_shown: bool,
    /// Its left and right margins' widths in columns.
    pub margins: (usize, usize),
    /// Whether its buffer breaks long lines between words, as
    /// `word-wrap` says, which shows no continuation mark on a terminal.
    pub word_wrap: bool,
    /// The mode line, formatted at redisplay, each piece with its style.
    pub mode_line: Vec<(ModeLineSegment, Style)>,
    /// Whether it has a mode line, its buffer's `mode-line-format` being
    /// non-nil; a window without one has no room left for it.
    pub shows_mode_line: bool,
    pub header_line: Option<Vec<(ModeLineSegment, Style)>>,
}

/// One row as a front end draws it: the row the core built, its glyphs,
/// and where they go.
#[derive(Clone, Debug)]
pub struct RowDescription {
    pub row: Row,
    pub glyphs: Vec<Glyph>,
    /// Its height, as a multiple of a default line's.
    pub height: f32,
    /// Each glyph's width in default columns.
    pub columns: Vec<f32>,
    /// Whether it lies on the grid of default columns, all in the default
    /// font's size and fixed width, so a front end can lay it out as text.
    pub on_grid: bool,
    /// How many default columns its glyphs take.
    pub width: f32,
    /// How far right of the text area's left edge it starts, in default
    /// columns: a right-to-left row is laid out from the right edge.
    pub offset: f32,
    /// How many default columns of it are scrolled off the left edge, as
    /// its window is scrolled horizontally ([`WindowDescription::hscroll`],
    /// or on every row but point's its least, when `auto-hscroll-mode` is
    /// `current-line`). Text starts that far left of `offset`.
    pub hscroll: f32,
    /// For a row with images, its ascent, on which text and images sit.
    pub ascent: Option<f32>,
    /// Where each of its segments' boxes starts below the row's top, for a
    /// row with images, and those of its margins'.
    pub segment_tops: Vec<f32>,
    pub margin_tops: [Vec<f32>; 2],
}

impl Editor {
    fn describe_row(&self, b: &crate::buffer::Buffer, window: Option<WindowId>, row: Row, tab_width: usize) -> RowDescription {
        let glyphs = row_glyphs(&row, tab_width);
        let on_grid = self.row_on_grid(&row);
        let columns = self.glyph_columns(&row, &glyphs, tab_width);
        let width = columns.iter().sum();
        let offset = window.map_or(0.0, |w| self.row_offset_in(w, &row));
        let ascent = self.row_ascent(b, &row);
        let (segment_tops, margin_tops) = if ascent.is_some() {
            let tops = |segments: &[crate::rows::Segment]| segments.iter().map(|s| self.image_top(b, &row, s)).collect::<Vec<f32>>();
            (tops(&row.segments), [tops(&row.margins[0]), tops(&row.margins[1])])
        } else {
            (Vec::new(), [Vec::new(), Vec::new()])
        };
        RowDescription {
            height: self.row_height(b, &row),
            columns,
            on_grid,
            width,
            offset,
            hscroll: 0.0,
            ascent,
            segment_tops,
            margin_tops,
            glyphs,
            row,
        }
    }

    /// Describes a frame as a front end draws it, after `redisplay`:
    /// styles for a dark or light background, and images' pixels at
    /// `scale` device pixels to a unit.
    pub fn describe_frame(&self, frame: FrameId, scale: f32) -> FrameDescription {
        let dark = self.dark_background();
        let style = |faces: &[&str]| self.style_for(&faces.iter().map(|f| f.to_string()).collect::<Vec<_>>(), dark);
        let mut bitmaps = HashMap::new();
        let mut images = HashMap::new();
        let mut windows = Vec::new();
        for view in self.frame_windows(frame) {
            let b = view.buffer;
            let tab_width = self.tab_width_in(b);
            let rows: Vec<RowDescription> = self
                .rows_to_draw(view.id, dark)
                .into_iter()
                .map(|row| {
                    let hscroll = self.row_hscroll(view.id, &row, view.point) as f32;
                    RowDescription { hscroll, ..self.describe_row(b, Some(view.id), row, tab_width) }
                })
                .collect();
            let plain: Vec<Row> = rows.iter().map(|r| r.row.clone()).collect();
            let fringes = self.window_fringes(view.id, &plain, &[]);
            let truncation = [
                self.logical_fringe_bitmap(b, "truncation", false, false).map(|bitmap| FringeSpec { side: Margin::Left, bitmap, face: None }),
                self.logical_fringe_bitmap(b, "truncation", true, false).map(|bitmap| FringeSpec { side: Margin::Right, bitmap, face: None }),
            ];
            let mut fringe_styles = HashMap::new();
            let shown = fringes.rows.iter().flat_map(|r| [&r.left, &r.right, &r.arrow]).chain(fringes.empty.iter()).chain(truncation.iter()).flatten();
            for spec in shown {
                let face = spec.face.clone().unwrap_or_else(|| self.fringe_bitmap_face(&spec.bitmap));
                fringe_styles.entry((spec.bitmap.clone(), spec.face.clone())).or_insert_with(|| self.style_for(&[face], dark));
                if let Some(bitmap) = self.fringe_bitmap(&spec.bitmap) {
                    bitmaps.entry(spec.bitmap.clone()).or_insert_with(|| bitmap.clone());
                }
            }
            for row in &rows {
                for seg in row.row.segments.iter().chain(row.row.margins.iter().flatten()) {
                    if let Some(image) = &seg.image {
                        images.entry(image.id).or_insert_with(|| self.image_rgba(image.id, scale));
                    }
                }
            }
            let line_numbers = self.line_numbers(view.id, &plain);
            let styled = |segments: &[ModeLineSegment]| segments.iter().map(|s| (s.clone(), self.style_for(&s.faces, dark))).collect::<Vec<_>>();
            let point_row = crate::display::row_showing(&plain, view.point, tab_width);
            windows.push(WindowDescription {
                id: view.id,
                buffer: b.name.clone(),
                top_line: view.top_line,
                line_count: b.line_count(),
                selected: view.selected,
                point: view.point,
                point_row,
                hscroll: self.window_hscroll(view.id),
                vscroll: self.window_vscroll(view.id),
                region: if view.selected { b.active_region() } else { None },
                tab_width,
                rows,
                line_numbers,
                line_number_styles: [style(&["line-number"]), style(&["line-number-current-line"])],
                region_style: style(&["region"]),
                fringes,
                truncation,
                fringe_styles,
                cursor_shown: self.window_cursor_shown(view.id),
                margins: self.window_margins(view.id),
                word_wrap: self.variable_in(b, "word-wrap").is_some_and(|v| v.is_true()),
                mode_line: styled(self.mode_line(view.id)),
                shows_mode_line: self.window_shows_mode_line(view.id),
                header_line: self.header_line(view.id).map(styled),
            });
        }
        let selected = frame == self.selected_frame();
        let echo = if selected && self.prompt().is_some() {
            let mb = self.minibuffer();
            let plain = self.minibuffer_rows(dark);
            let point_row = crate::display::row_showing(&plain, mb.point(), 8);
            let rows = plain.into_iter().map(|row| self.describe_row(mb, None, row, 8)).collect();
            Echo::Prompt { rows, point: mb.point(), point_row }
        } else {
            Echo::Message(if selected { self.echo_lines() } else { Vec::new() })
        };
        // As frame-title-format makes it, else the selected window's buffer's name.
        let title = self
            .frame_titles
            .get(&frame)
            .cloned()
            .unwrap_or_else(|| windows.iter().find(|w| w.selected).or(windows.first()).map(|w| w.buffer.clone()).unwrap_or_default());
        FrameDescription {
            frame,
            title,
            dark,
            tree: self.frame_tree(frame).cloned().unwrap_or(crate::window::WindowTree::Leaf(0)),
            echo_lines: if selected { self.mini_window_lines() } else { 1 },
            selected,
            visibility: match self.frame_visibility(frame) {
                crate::variables::Value::Null | crate::variables::Value::Bool(false) => Visibility::Hidden,
                v if v.as_str() == Some("icon") => Visibility::Iconified,
                _ => Visibility::Visible,
            },
            raised: self.frame_raises(frame),
            minibuffer_selected: self.minibuffer_window_selected(),
            windows,
            echo,
            chrome: {
                let themed = |name: &str| self.face_attrs(name, dark).background.is_some().then(|| style(&[name]));
                Chrome {
                    mode_line: themed("mode-line"),
                    mode_line_inactive: themed("mode-line-inactive"),
                    header_line: themed("header-line"),
                    tab_bar: themed("tab-bar"),
                    tab_bar_tab: themed("tab-bar-tab"),
                    tab_bar_tab_inactive: themed("tab-bar-tab-inactive"),
                    cursor: themed("cursor"),
                }
            },
            tab_bar: (self.tab_bar_lines(frame) > 0)
                .then(|| self.tab_bar(frame).unwrap_or(&[]).iter().map(|s| (s.clone(), self.style_for(&s.faces, dark))).collect()),
            default_style: style(&["default"]),
            fringe_bitmaps: bitmaps,
            images,
        }
    }
}
