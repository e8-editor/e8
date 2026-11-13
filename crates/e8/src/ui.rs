//! Draws the editor: its windows, each with a mode line, and the echo area.

use std::ops::Range;

use e8_core::display::{Glyph, cursor_glyph, position_at_column, row_glyphs};
use e8_core::frame_description::{Echo, FrameDescription, WindowDescription};
use e8_core::{Color as FaceColor, Editor, LineNumbers, Row, Style as FaceStyle, WindowId, WindowTree, WindowView, palette};
use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

/// Where a window's parts go on the screen.
struct WindowArea {
    id: WindowId,
    text: Rect,
    mode_line: Rect,
    /// The line above the text, when the window's buffer has a `header-line-format`.
    header_line: Option<Rect>,
    /// The margins left and right of the text, as `window-margins` gives them.
    margins: [Rect; 2],
    /// The column between this window and the one to its right.
    divider: Option<Rect>,
}

/// Divides the screen above the echo area among the windows, as the editor
/// says they divide it.
fn window_areas(ed: &Editor, width: u16, height: u16) -> Vec<WindowArea> {
    let tab_lines = (ed.menu_bar_lines(ed.selected_frame()) + ed.tab_bar_lines(ed.selected_frame())) as u16;
    areas_of(ed.window_tree(), tab_lines, ed.mini_window_lines(), &|id, h| ed.window_wants_header_line(id, h), &|id| ed.window_margins(id), &|id| ed.window_shows_mode_line(id), width, height)
}

/// As [`window_areas`], as a frame description says.
fn described_areas(fd: &FrameDescription, width: u16, height: u16) -> Vec<WindowArea> {
    let window = |id: WindowId| fd.windows.iter().find(|w| w.id == id);
    let header = |id, h: usize| h > 2 && window(id).is_some_and(|w| w.header_line.is_some());
    let margins = |id| window(id).map_or((0, 0), |w| w.margins);
    let mode_line = |id| window(id).is_none_or(|w| w.shows_mode_line);
    let bars = u16::from(fd.menu_bar.is_some()) + u16::from(fd.tab_bar.is_some());
    areas_of(&fd.tree, bars, fd.echo_lines, &header, &margins, &mode_line, width, height)
}

fn areas_of(
    tree: &WindowTree,
    tab_lines: u16,
    echo_lines: usize,
    wants_header: &dyn Fn(WindowId, usize) -> bool,
    margins_of: &dyn Fn(WindowId) -> (usize, usize),
    shows_mode_line: &dyn Fn(WindowId) -> bool,
    width: u16,
    height: u16,
) -> Vec<WindowArea> {
    // The menu bar and the tab bar take the top lines, the echo area the bottom ones.
    let height = height.saturating_sub(echo_lines as u16 + tab_lines).max(2);
    tree
        .rects(0.0, tab_lines as f32, width as f32, height as f32, (1.0, 1.0))
        .into_iter()
        .map(|r| {
            let (x, y, w, h) = (r.x as u16, r.y as u16, (r.width as u16).max(1), (r.height as u16).max(2));
            let body_width = if r.divider { w.saturating_sub(1).max(1) } else { w };
            let header = u16::from(wants_header(r.id, h as usize));
            // The margins take columns from the text, leaving it one at least.
            let (left, right) = margins_of(r.id);
            let left = (left as u16).min(body_width.saturating_sub(1));
            let right = (right as u16).min(body_width.saturating_sub(1 + left));
            // A window without a mode line, as Emacs's with mode-line-format nil, has that row for text.
            let mode = u16::from(shows_mode_line(r.id));
            let (top, height) = (y + header, (h - mode - header).max(1));
            WindowArea {
                id: r.id,
                text: Rect::new(x + left, top, body_width - left - right, height),
                mode_line: Rect::new(x, y + h - mode, w, mode),
                header_line: (header == 1).then(|| Rect::new(x, y, body_width, 1)),
                margins: [Rect::new(x, top, left, height), Rect::new(x + body_width - right, top, right, height)],
                divider: r.divider.then(|| Rect::new(x + w - 1, y, 1, h - mode)),
            }
        })
        .collect()
}

/// Tells the editor how big each window is on a screen of this size, so
/// scrolling knows. Call before drawing.
pub fn layout_windows(ed: &mut Editor, width: u16, height: u16) {
    // A terminal's whole frame is its screen, in characters, as Emacs's
    // native size is on a terminal, and it sits at the screen's corner.
    let frame = ed.selected_frame();
    ed.set_frame_geometry(
        frame,
        e8_core::FrameGeometry { native: (width as f32, height as f32), position: (0.0, 0.0), scale: 1.0 },
    );
    // A terminal cannot move or resize itself, so what code asked for is
    // taken and dropped, as Emacs's `set-frame-position` does nothing on
    // a text terminal.
    ed.take_frame_requests();
    ed.set_minibuffer_width(width as usize);
    let echo = ed.mini_window_height(height as usize) as u16;
    let tab_lines = (ed.menu_bar_lines(ed.selected_frame()) + ed.tab_bar_lines(ed.selected_frame())) as u16;
    ed.set_frame_size(width as usize, height.saturating_sub(echo + tab_lines).max(2) as usize);
    for area in window_areas(ed, width, height) {
        ed.set_window_size(area.id, area.text.width as usize, area.text.height as usize);
    }
}

/// Draws a frame as the core described it, asking the editor nothing.
pub fn draw(frame: &mut Frame, fd: &FrameDescription) {
    let screen = frame.area();
    // A theme's background for the default face fills the screen, as on
    // Emacs's terminal frames, not only behind text.
    if fd.default_style.background.is_some() {
        let base = terminal_style(&fd.default_style, fd.dark);
        frame.buffer_mut().set_style(screen, base);
    }
    let echo = (fd.echo_lines as u16).min(screen.height);
    let echo_area = Rect::new(screen.x, screen.bottom().saturating_sub(echo), screen.width, echo);
    let areas = described_areas(fd, screen.width, screen.height);
    let mut top = screen.y;
    if let Some(menu_bar) = &fd.menu_bar {
        draw_menu_bar(frame, fd, menu_bar, Rect::new(screen.x, top, screen.width, 1.min(screen.height)));
        top += 1;
    }
    if let Some(tab_bar) = &fd.tab_bar {
        draw_tab_bar(frame, tab_bar, Rect::new(screen.x, top, screen.width, 1.min(screen.height.saturating_sub(top - screen.y))));
    }
    let mut window_cursor = Position::new(0, 0);
    let mut cursor_shown = false;
    for w in &fd.windows {
        let Some(area) = areas.iter().find(|a| a.id == w.id) else { continue };
        let cursor = draw_window(frame, fd, w, area.text, area.margins);
        if w.selected {
            window_cursor = cursor;
            cursor_shown = w.cursor_shown;
        }
        draw_mode_line(frame, w, area.mode_line);
        if let Some(header) = area.header_line {
            draw_header_line(frame, w, header);
        }
        if let Some(divider) = area.divider {
            let bar: Vec<Line> = (0..divider.height).map(|_| Line::from("|")).collect();
            frame.render_widget(Paragraph::new(bar), divider);
        }
    }
    let echo_cursor = draw_echo_area(frame, fd, echo_area).filter(|_| fd.minibuffer_selected);
    // A menu is drawn over everything else, and keeps the cursor on the
    // item it is on, as term.c's menus do.
    // Cells count from the top left of the frame's windows, below the bars.
    let windows_top = (screen.y + u16::from(fd.menu_bar.is_some()) + u16::from(fd.tab_bar.is_some())).min(screen.bottom());
    let below = Rect { y: windows_top, height: screen.bottom() - windows_top, ..screen };
    if let Some(cursor) = draw_menus(frame, fd, below) {
        frame.set_cursor_position(cursor);
        return;
    }
    // A window whose cursor internal-show-cursor hid shows none.
    if echo_cursor.is_some() || cursor_shown {
        frame.set_cursor_position(echo_cursor.unwrap_or(window_cursor));
    }
}

/// Draws a frame's menu bar: its menus along the top line, in the menu
/// faces, as term.c draws Emacs's on a terminal.
fn draw_menu_bar(frame: &mut Frame, fd: &FrameDescription, items: &[e8_core::MenuBarItem], rect: Rect) {
    if let Some(first) = items.first() {
        frame.buffer_mut().set_style(rect, terminal_style(&first.style, fd.dark));
    }
    for item in items {
        let x = rect.x + item.column as u16;
        if x >= rect.right() {
            break;
        }
        let style = terminal_style(&item.style, fd.dark);
        let text = format!(" {} ", item.label);
        let width = (item.width as u16).min(rect.right() - x);
        frame.render_widget(Paragraph::new(Line::styled(text, style)).style(style), Rect::new(x, rect.y, width, 1));
    }
}

/// Draws the tooltip and the panels of the menu that is open over the
/// windows, and gives where the cursor goes: the left of the line the
/// menu is on.
fn draw_menus(frame: &mut Frame, fd: &FrameDescription, screen: Rect) -> Option<Position> {
    let mut cursor = None;
    for panel in fd.tip.iter().chain(&fd.menus) {
        for (i, row) in panel.rows.iter().enumerate() {
            let (x, y) = (screen.x + panel.x as u16, screen.y + panel.y as u16);
            let y = y + i as u16;
            if y >= screen.bottom() {
                break;
            }
            let width = (panel.width as u16).min(screen.right().saturating_sub(x));
            let style = terminal_style(&row.style, fd.dark);
            frame.render_widget(Paragraph::new(Line::styled(row.text.clone(), style)).style(style), Rect::new(x, y, width, 1));
            if row.selected {
                cursor = Some(Position::new(x, y));
            }
        }
    }
    cursor
}

/// A window's rows as a mouse event finds them, with their glyphs, and how
/// far each is scrolled horizontally.
struct WindowRows {
    rows: Vec<Row>,
    glyph_rows: Vec<Vec<Glyph>>,
    hscrolls: Vec<usize>,
    /// The line numbers left of the text, if the buffer shows them.
    numbers: Option<LineNumbers>,
}

/// The columns a window's line numbers take at the left of its text.
fn gutter(numbers: &Option<LineNumbers>, area: Rect) -> u16 {
    numbers.as_ref().map_or(0, |n| (n.width as u16).min(area.width.saturating_sub(1)))
}

/// The part of a window's text area right of its line numbers.
fn text_area(area: Rect, gutter: u16) -> Rect {
    Rect::new(area.x + gutter, area.y, area.width - gutter, area.height)
}

fn window_rows(ed: &Editor, view: &WindowView, area: Rect) -> WindowRows {
    let rows = ed.rows_of_window(view.id, area.height as usize, ed.dark_background());
    let numbers = ed.line_numbers(view.id, &rows);
    let tab_width = ed.tab_width_in(view.buffer);
    let glyph_rows: Vec<Vec<Glyph>> = rows.iter().map(|r| row_glyphs(r, tab_width)).collect();
    let hscrolls = rows.iter().map(|r| ed.row_hscroll(view.id, r, view.point)).collect();
    WindowRows { rows, glyph_rows, hscrolls, numbers }
}

/// Where a right-to-left row starts in a text area `width` columns wide:
/// laid out from the right edge, as Emacs's bidi display lays it out, and
/// negative when a truncated row is wider than the window.
fn rtl_offset(row: &Row, glyphs: &[Glyph], width: usize) -> i64 {
    if !row.right_to_left {
        return 0;
    }
    width as i64 - glyphs.iter().map(|g| g.width as i64).sum::<i64>()
}

/// What the terminal draws from: the selected frame, described after
/// redisplay, its styles for the background the editor judges it has.
pub fn describe(ed: &Editor) -> FrameDescription {
    ed.describe_frame(ed.selected_frame(), 1.0)
}

/// What is under a cell of the screen, for a mouse event: a window, and the
/// buffer position there if the cell is over its text. Below the last line
/// of text is the end of the buffer, as in Emacs.
pub fn mouse_target(ed: &Editor, width: u16, height: u16, x: u16, y: u16) -> Option<(WindowId, Option<usize>)> {
    let areas = window_areas(ed, width, height);
    let area = areas.iter().find(|a| {
        let top = a.header_line.map_or(a.text.y, |h| h.y);
        let r = Rect::new(a.mode_line.x, top, a.mode_line.width, a.mode_line.y + 1 - top);
        r.contains(Position::new(x, y))
    })?;
    if !area.text.contains(Position::new(x, y)) {
        return Some((area.id, None));
    }
    let view = ed.windows().into_iter().find(|v| v.id == area.id)?;
    let drawn = window_rows(ed, &view, area.text);
    let text = text_area(area.text, gutter(&drawn.numbers, area.text));
    let row = (y - area.text.y) as usize;
    let position = match (drawn.rows.get(row), drawn.glyph_rows.get(row)) {
        (Some(row), Some(glyphs)) if row.right_to_left => {
            // Left of a right-to-left row's text is the end of its line.
            let col = x as i64 - text.x as i64 - rtl_offset(row, glyphs, text.width as usize);
            if col < 0 { glyphs.first().and_then(|g| g.pos).unwrap_or(row.end) } else { position_at_column(row, glyphs, col as usize) }
        }
        (Some(r), Some(glyphs)) => position_at_column(r, glyphs, x.saturating_sub(text.x) as usize + drawn.hscrolls[row]),
        _ => view.buffer.len(),
    };
    Some((area.id, Some(position)))
}

/// Draws a window's rows, and what shows in its margins beside them, and
/// returns where its point is on screen.
fn draw_window(frame: &mut Frame, fd: &FrameDescription, w: &WindowDescription, area: Rect, margins: [Rect; 2]) -> Position {
    let dark = fd.dark;
    let rows = &w.rows;
    for (side, margin) in margins.iter().enumerate().filter(|(_, m)| m.width > 0) {
        let lines: Vec<Line> = rows
            .iter()
            .map(|r| {
                let segments = &r.row.margins[side];
                Line::from(segments.iter().map(|seg| Span::styled(seg.text.clone(), terminal_style(&seg.style, dark))).collect::<Vec<_>>())
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), *margin);
    }
    // Line numbers, in their faces, left of the text.
    let numbers = &w.line_numbers;
    let gutter = gutter(numbers, area);
    if let Some(numbers) = numbers {
        let face = |current: bool| terminal_style(&w.line_number_styles[usize::from(current)], dark);
        let lines: Vec<Line> = numbers.labels.iter().map(|(label, current)| Line::from(Span::styled(label.clone(), face(*current)))).collect();
        frame.render_widget(Paragraph::new(lines), Rect::new(area.x, area.y, gutter, area.height));
    }
    let area = text_area(area, gutter);
    let width = area.width as usize;
    let point_row = w.point_row.unwrap_or(0);
    let point_col: usize = rows
        .get(point_row)
        .map(|r| r.glyphs[..cursor_glyph(&r.row, &r.glyphs, w.point)].iter().map(|g| g.width).sum())
        .unwrap_or(0);
    // A right-to-left row is laid out from the right edge.
    let point_col = match rows.get(point_row).filter(|r| r.row.right_to_left) {
        Some(r) => (point_col as i64 + rtl_offset(&r.row, &r.glyphs, width)).max(0) as usize,
        None => point_col,
    };
    // As far left as the editor scrolled point's row.
    let point_col = point_col.saturating_sub(rows.get(point_row).map_or(0, |r| r.hscroll as usize));
    // Only the selected window shows the region, as in Emacs.
    let region = w.region.clone();
    // Lines broken between words show no continuation mark, as on Emacs's terminals.
    let marks = !w.word_wrap;
    let lines: Vec<Line> = rows.iter().map(|r| row_line(&r.row, &r.glyphs, r.hscroll as usize, width, region.as_ref(), dark, marks)).collect();
    frame.render_widget(Paragraph::new(lines), area);
    Position::new(area.x + point_col.min(width.saturating_sub(1)) as u16, area.y + point_row as u16)
}

/// A row as a terminal line, `hscroll` columns scrolled off its left edge:
/// faces as true colour, the region in reverse video. A selected newline
/// fills the rest of the row, as Emacs's region face extends to the
/// window's edge. A line cut off at either edge shows `$` there, as on
/// Emacs's terminals: at the left in place of the first column's text,
/// at the right in the last column.
fn row_line(
    row: &Row,
    glyphs: &[Glyph],
    hscroll: usize,
    width: usize,
    region: Option<&Range<usize>>,
    dark: bool,
    marks: bool,
) -> Line<'static> {
    if row.right_to_left {
        return rtl_row_line(row, glyphs, width, region, dark, marks);
    }
    let selected = |pos: usize| region.is_some_and(|r| r.contains(&pos));
    let mut spans: Vec<Span<'static>> = Vec::new();
    let push = |spans: &mut Vec<Span<'static>>, s: &str, style: Style| match spans.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(s),
        _ => spans.push(Span::styled(s.to_string(), style)),
    };
    let cut_left = hscroll > 0 && !glyphs.is_empty();
    let cut_right = !row.continued && width > 0 && glyphs.iter().map(|g| g.width).sum::<usize>() >= hscroll + width;
    // The columns text shows in, between the marks.
    let (left, right) = (hscroll + usize::from(cut_left), (hscroll + width).saturating_sub(usize::from(cut_right)));
    // A window a column wide has room for one mark and no text.
    if left >= right {
        return Line::from(if cut_left || cut_right { "$" } else { "" });
    }
    if cut_left {
        push(&mut spans, "$", Style::new());
    }
    let mut col = 0;
    for glyph in glyphs {
        if col >= right {
            break;
        }
        let mut style = terminal_style(&row.segments[glyph.segment].style, dark);
        if glyph.pos.is_some_and(selected) {
            style = style.add_modifier(Modifier::REVERSED);
        }
        let end = col + glyph.width;
        if col >= left && end <= right {
            push(&mut spans, &glyph.text, style);
        } else if end > left {
            // A tab or wide character across an edge takes up its columns inside it.
            push(&mut spans, &" ".repeat(end.min(right) - col.max(left)), style);
        }
        col = end;
    }
    if cut_right {
        push(&mut spans, "$", Style::new());
    } else if selected(row.end) && !row.continued && col < right {
        let fill = right - col.max(left);
        push(&mut spans, &" ".repeat(fill), Style::new().add_modifier(Modifier::REVERSED));
    } else if let Some(extend) = row.extend.as_ref().filter(|_| !row.continued && col < right) {
        // A face that extends fills the rest of the row with its background.
        let fill = right - col.max(left);
        let bg = terminal_style(extend, dark).bg.unwrap_or(Color::Reset);
        let style = if extend.underline { Style::new().bg(bg).add_modifier(Modifier::UNDERLINED) } else { Style::new().bg(bg) };
        push(&mut spans, &" ".repeat(fill), style);
    }
    // A continued line ends with a backslash in the last column, as in
    // Emacs, unless it was broken after a space between words.
    let mid_word = col + 1 >= hscroll + width && glyphs.last().is_some_and(|g| !matches!(g.c, ' ' | '\t'));
    if row.continued && !row.broken && (marks || mid_word) {
        let fill = (hscroll + width).saturating_sub(col + 1);
        push(&mut spans, &" ".repeat(fill), Style::new());
        push(&mut spans, "\\", Style::new());
    }
    Line::from(spans)
}

/// A right-to-left row as a terminal line, as Emacs on a terminal shows it:
/// from the right edge, a selected newline or a face that extends filling
/// the columns left of it, a continued line's mark, `/`, in the leftmost
/// column, and a `$` there for a truncated line that goes on past the left
/// edge.
fn rtl_row_line(row: &Row, glyphs: &[Glyph], width: usize, region: Option<&Range<usize>>, dark: bool, marks: bool) -> Line<'static> {
    let selected = |pos: usize| region.is_some_and(|r| r.contains(&pos));
    let mut spans: Vec<Span<'static>> = Vec::new();
    let push = |spans: &mut Vec<Span<'static>>, s: &str, style: Style| match spans.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(s),
        _ => spans.push(Span::styled(s.to_string(), style)),
    };
    let offset = rtl_offset(row, glyphs, width);
    let truncated = offset < 0;
    let full = offset <= 1 && glyphs.first().is_some_and(|g| !matches!(g.c, ' ' | '\t'));
    let mark = if truncated { Some("$") } else { (row.continued && !row.broken && (marks || full)).then_some("/") };
    let mut col: i64 = 0;
    if let Some(mark) = mark {
        push(&mut spans, mark, Style::new());
        col = 1;
    }
    if offset > col {
        let fill = " ".repeat((offset - col) as usize);
        let style = if selected(row.end) && !row.continued {
            Style::new().add_modifier(Modifier::REVERSED)
        } else if let Some(extend) = row.extend.as_ref().filter(|_| !row.continued) {
            Style::new().bg(terminal_style(extend, dark).bg.unwrap_or(Color::Reset))
        } else {
            Style::new()
        };
        push(&mut spans, &fill, style);
        col = offset;
    }
    let mut x = offset;
    for glyph in glyphs {
        let w = glyph.width as i64;
        if x >= col && x + w <= width as i64 {
            let mut style = terminal_style(&row.segments[glyph.segment].style, dark);
            if glyph.pos.is_some_and(selected) {
                style = style.add_modifier(Modifier::REVERSED);
            }
            push(&mut spans, &glyph.text, style);
        }
        x += w;
    }
    Line::from(spans)
}

/// A face's style for the terminal. Translucent colours are blended over the
/// palette's background, as the graphical front end draws them.
fn terminal_style(style: &FaceStyle, dark: bool) -> Style {
    let bg = palette("bg", dark).expect("the palette has bg");
    let rgb = |c: FaceColor| {
        let mix = |fg: u8, bg: u8| ((fg as u16 * c.a as u16 + bg as u16 * (255 - c.a as u16)) / 255) as u8;
        Color::Rgb(mix(c.r, bg.r), mix(c.g, bg.g), mix(c.b, bg.b))
    };
    let mut out = Style::new();
    if let Some(c) = style.foreground {
        out = out.fg(rgb(c));
    }
    if let Some(c) = style.background {
        out = out.bg(rgb(c));
    }
    if let Some(c) = style.underline_color.filter(|_| style.underline) {
        out = out.underline_color(rgb(c));
    }
    for (on, modifier) in [
        (style.bold, Modifier::BOLD),
        (style.italic, Modifier::ITALIC),
        (style.underline, Modifier::UNDERLINED),
        (style.strike, Modifier::CROSSED_OUT),
    ] {
        if on {
            out = out.add_modifier(modifier);
        }
    }
    out
}

fn draw_mode_line(frame: &mut Frame, w: &WindowDescription, area: Rect) {
    // What mode-line-format shows, which the core formatted at redisplay.
    let text: String = w.mode_line.iter().map(|(s, _)| s.text.as_str()).collect();
    // The selected window's mode line stands out; the others are dimmed,
    // as Emacs's mode-line-inactive face is.
    let mut style = Style::new().add_modifier(Modifier::REVERSED);
    if !w.selected {
        style = style.add_modifier(Modifier::DIM);
    }
    frame.render_widget(Paragraph::new(text).style(style), area);
}

/// Draws a frame's tab bar, as the core formatted its `tab-bar-line`: in
/// reverse video, as Emacs's tab-bar face is on a terminal, the current tab
/// (tab-bar-tab) standing out in bold and plain video.
fn draw_tab_bar(frame: &mut Frame, tab_bar: &[(e8_core::ModeLineSegment, e8_core::Style)], area: Rect) {
    let base = Style::new().add_modifier(Modifier::REVERSED);
    let spans: Vec<Span> = tab_bar
        .iter()
        .map(|(segment, _)| {
            let faces: Vec<&str> = segment.faces.iter().map(String::as_str).collect();
            let style = if faces.contains(&"tab-bar-tab") {
                Style::new().add_modifier(Modifier::BOLD)
            } else if faces.contains(&"shadow") {
                base.add_modifier(Modifier::DIM)
            } else {
                base
            };
            Span::styled(segment.text.clone(), style)
        })
        .collect();
    frame.render_widget(Paragraph::new(Line::from(spans)).style(base), area);
}

/// Draws a window's header line, as the core formatted `header-line-format`:
/// in reverse video, as Emacs's header-line face is on a terminal, its bold
/// faces bold.
fn draw_header_line(frame: &mut Frame, w: &WindowDescription, area: Rect) {
    let base = Style::new().add_modifier(Modifier::REVERSED);
    let spans: Vec<Span> = w
        .header_line
        .iter()
        .flatten()
        .map(|(segment, style)| {
            let style = if style.bold { base.add_modifier(Modifier::BOLD) } else { base };
            Span::styled(segment.text.clone(), style)
        })
        .collect();
    frame.render_widget(Paragraph::new(Line::from(spans)).style(base), area);
}

/// Draws the minibuffer or the current message. Returns the cursor position
/// when the minibuffer is active, since the cursor belongs there. What the
/// minibuffer's overlay adds, such as icomplete's list, follows the input,
/// and each newline in it starts another line of the echo area.
fn draw_echo_area(frame: &mut Frame, fd: &FrameDescription, area: Rect) -> Option<Position> {
    let (rows, point, point_row) = match &fd.echo {
        Echo::Message(lines) => {
            let lines: Vec<Line> = lines.iter().map(|l| Line::from(l.clone())).collect();
            frame.render_widget(Paragraph::new(lines), area);
            return None;
        }
        Echo::Prompt { rows, point, point_row } => (rows, *point, *point_row),
    };
    // The minibuffer's rows, as a window's: the prompt and input in their
    // faces, and what overlays add, such as icomplete's list.
    let width = area.width as usize;
    let mut cursor = None;
    let mut lines = Vec::new();
    for (k, r) in rows.iter().take(area.height as usize).enumerate() {
        let (row, glyphs) = (&r.row, &r.glyphs);
        if point_row == Some(k) {
            let x: usize = glyphs[..cursor_glyph(row, glyphs, point)].iter().map(|g| g.width).sum();
            let x = (x as i64 + rtl_offset(row, glyphs, width)).max(0) as usize;
            cursor = Some(Position::new(area.x + x.min(width.saturating_sub(1)) as u16, area.y + k as u16));
        }
        lines.push(row_line(row, glyphs, 0, width, None, fd.dark, true));
    }
    frame.render_widget(Paragraph::new(lines), area);
    cursor.or(Some(Position::new(area.x, area.y)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn render(ed: &mut Editor, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        layout_windows(ed, width, height);
        ed.redisplay();
        let fd = describe(ed);
        terminal.draw(|frame| draw(frame, &fd)).unwrap();
        let buf = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                let row: String = (0..width).map(|x| buf[(x, y)].symbol()).collect();
                row.trim_end().to_string()
            })
            .collect()
    }

    #[test]
    fn shows_text_mode_line_and_minibuffer() {
        let mut ed = Editor::new();
        ed.type_text("hello\n\tworld");
        let rows = render(&mut ed, 50, 5);
        assert_eq!(rows[0], "hello");
        assert_eq!(rows[1], "        world");
        assert!(rows[3].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert!(rows[3].contains("L2"), "{}", rows[3]);

        ed.press("M-x").unwrap();
        ed.type_text("find-f");
        let rows = render(&mut ed, 50, 5);
        assert_eq!(rows[4], "M-x find-f");
    }

    #[test]
    fn icomplete_lists_completions_after_the_input() {
        let mut ed = Editor::new();
        let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
        ed.press("M-x").unwrap();
        ed.type_text("forward-w");
        let rows = render(&mut ed, 60, 6);
        assert_eq!(rows[5], "M-x forward-w(ord) [Matched]");
    }

    #[test]
    fn a_vertical_list_grows_the_echo_area() {
        let mut ed = Editor::new();
        let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
        ed.call("fido-vertical-mode", vec![]).unwrap();
        ed.type_text("(a) b");
        ed.buffer_mut().set_point(0);
        ed.press("M-x").unwrap();
        ed.type_text("forw");
        let rows = render(&mut ed, 60, 20);
        // A fifth of 20 lines is 5: the input and four completions, best
        // flex match first, each command with its key.
        assert!(rows[14].starts_with("U:"), "the mode line is just above: {}", rows[14]);
        let total = rows[15].split(' ').next().unwrap().split('/').nth(1).unwrap().to_string();
        assert_eq!(rows[15], format!("1/{total} M-x forw"));
        // Each command with its key, after the longest of those listed.
        let shown: Vec<(&str, &str)> = rows[16..].iter().map(|r| (r.split(' ').next().unwrap(), r.rsplit(' ').next().unwrap())).collect();
        assert_eq!(shown, [("forward-char", "(C-f)"), ("forward-list", "(C-M-n)"), ("forward-page", "])"), ("forward-sexp", "(C-M-f)")]);
        assert_eq!(rows[16].find("(C-f)"), rows[19].find("(C-M-f)"), "keys line up");
        ed.press("C-n C-n C-n").unwrap();
        let rows = render(&mut ed, 60, 20);
        assert_eq!(rows[15], format!("4/{total} M-x forw"));
        ed.press("RET").unwrap();
        assert_eq!(ed.buffer().point(), 3, "RET ran the selected command, forward-sexp");
    }

    #[test]
    fn line_numbers_go_left_of_the_text() {
        let mut ed = Editor::new();
        let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
        ed.type_text("one\ntwo");
        ed.call("display-line-numbers-mode", vec![]).unwrap();
        let rows = render(&mut ed, 20, 5);
        assert_eq!(rows[0], " 1 one");
        assert_eq!(rows[1], " 2 two");
        // The cursor is after the text, past the numbers.
        ed.press("M-<").unwrap();
        let rows = render(&mut ed, 20, 5);
        assert_eq!(rows[0], " 1 one");
    }

    #[test]
    fn right_to_left_text_is_drawn_from_the_right_edge() {
        let mut ed = Editor::new();
        ed.type_text("שלום (abc)\nאחד שתיים שלוש ארבע חמש שש");
        ed.press("M-<").unwrap();
        let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
        layout_windows(&mut ed, 20, 6);
        let fd = describe(&ed);
        terminal.draw(|frame| draw(frame, &fd)).unwrap();
        let buf = terminal.backend().buffer();
        let line = |y: u16| (0..20).map(|x| buf[(x, y)].symbol()).collect::<String>();
        // Reordered as Emacs shows it on a terminal, mirrored brackets and
        // all; a continued line marked with / at the left.
        assert_eq!(line(0), "          (abc) םולש");
        assert_eq!(line(1), "/עברא שולש םייתש דחא");
        assert_eq!(line(2).trim_end(), "             שש שמח");
        // The cursor on ש, the first character, at the right edge.
        assert_eq!(terminal.get_cursor_position().unwrap(), Position::new(19, 0));
        // A click left of the text is the end of its line.
        assert_eq!(mouse_target(&ed, 20, 6, 2, 0).map(|t| t.1), Some(Some(10)));
    }

    #[test]
    fn the_region_is_reverse_video() {
        let mut ed = Editor::new();
        ed.type_text("abc\ndef");
        ed.press("M-< <right> S-<down>").unwrap();
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        let fd = describe(&ed);
        terminal.draw(|frame| draw(frame, &fd)).unwrap();
        let buf = terminal.backend().buffer();
        let reversed = |x: u16, y: u16| buf[(x, y)].modifier.contains(Modifier::REVERSED);
        // "bc" and the newline on the first line, which fills the row to its
        // edge, then "d" before point.
        assert_eq!((0..20).map(|x| reversed(x, 0)).collect::<Vec<_>>(), [vec![false], vec![true; 19]].concat());
        assert_eq!((0..3).map(|x| reversed(x, 1)).collect::<Vec<_>>(), [true, false, false]);
    }

    #[test]
    fn faces_and_hidden_text() {
        let mut ed = Editor::new();
        ed.type_text("plain bold\nhidden\nlast");
        let b = ed.window_buffer_mut();
        b.put_text_property(6..10, "face", e8_core::Value::Str("bold".into()));
        // The first newline and "hidden" with its newline.
        b.put_text_property(10..18, "invisible", e8_core::Value::Bool(true));
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        let fd = describe(&ed);
        terminal.draw(|frame| draw(frame, &fd)).unwrap();
        let buf = terminal.backend().buffer();
        let row: String = (0..20).map(|x| buf[(x, 0)].symbol()).collect();
        // The hidden newline joins the first and third lines into one row.
        assert_eq!(row.trim_end(), "plain boldlast");
        assert!(buf[(6, 0)].modifier.contains(Modifier::BOLD));
        assert!(!buf[(0, 0)].modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn a_header_line_takes_the_top_line_of_its_window() {
        let mut ed = Editor::new();
        ed.type_text("one\ntwo");
        ed.set_variable("header-line-format", e8_core::Value::Str(" Name %b".into()));
        let rows = render(&mut ed, 30, 6);
        assert_eq!(rows[0], " Name *scratch*");
        assert_eq!(rows[1], "one");
        assert_eq!(rows[2], "two");
        assert!(rows[4].starts_with("U:**-  *scratch*"), "{}", rows[4]);
        assert_eq!(ed.viewport_height(), 3, "the header line and mode line take two of the five lines");
        // A click on the header line is over no text.
        assert_eq!(mouse_target(&ed, 30, 6, 2, 0).map(|t| t.1), Some(None));
        assert_eq!(mouse_target(&ed, 30, 6, 1, 1).map(|t| t.1), Some(Some(1)));
    }

    #[test]
    fn a_tab_bar_takes_the_top_line_of_the_frame() {
        let mut ed = Editor::new();
        ed.type_text("one\ntwo");
        let frame = ed.selected_frame();
        ed.set_frame_parameter(frame, "tab-bar-lines", e8_core::Value::Number(1.0)).unwrap();
        ed.set_frame_parameter(frame, "tab-bar-line", e8_core::Value::Str("|*scratch* x| + ".into())).unwrap();
        let rows = render(&mut ed, 30, 6);
        assert_eq!(rows[0], "|*scratch* x| +");
        assert_eq!(rows[1], "one");
        assert!(rows[4].starts_with("U:**-  *scratch*"), "{}", rows[4]);
        assert_eq!(ed.viewport_height(), 3, "the tab bar and mode line take two of the five lines");
        // The tab bar is no window's.
        assert_eq!(mouse_target(&ed, 30, 6, 2, 0), None);
        assert_eq!(mouse_target(&ed, 30, 6, 1, 1).map(|t| t.1), Some(Some(1)));
    }

    #[test]
    fn a_themes_default_background_fills_the_screen() {
        let mut ed = Editor::new();
        ed.type_text("one");
        ed.set_face_attribute("default", ":background", &e8_core::Value::Str("#2E3440".into()), e8_core::Background::Both);
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        layout_windows(&mut ed, 20, 5);
        ed.redisplay();
        let fd = describe(&ed);
        terminal.draw(|frame| draw(frame, &fd)).unwrap();
        // An empty cell past the text, below it too.
        assert_eq!(terminal.backend().buffer()[(15, 1)].bg, Color::Rgb(0x2E, 0x34, 0x40));
    }

    #[test]
    fn margins_show_beside_the_text() {
        let mut ed = Editor::new();
        ed.type_text("one\ntwo");
        ed.set_variable("left-margin-width", e8_core::Value::Number(2.0));
        let spec = e8_core::Value::List(vec![
            e8_core::Value::List(vec![e8_core::Value::Symbol("margin".into()), e8_core::Value::Symbol("left-margin".into())]),
            e8_core::Value::Str(">".into()),
        ]);
        let start = ed.buffer().line_start(1);
        ed.buffer_mut().put_text_property(start..start + 1, "display", spec);
        let rows = render(&mut ed, 20, 5);
        assert_eq!(rows[0], "  one");
        assert_eq!(rows[1], "> wo", "the text the spec is on shows nothing in the text");
        // Clicks in the margin are over no text.
        assert_eq!(mouse_target(&ed, 20, 5, 0, 0).map(|t| t.1), Some(None));
    }

    #[test]
    fn split_windows_each_have_a_mode_line() {
        let mut ed = Editor::new();
        // The window commands are in window.ts.
        let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
        ed.type_text("one\ntwo");
        ed.press("C-x 2").unwrap();
        ed.press("C-x 3").unwrap();
        let rows = render(&mut ed, 41, 9);
        // Two windows side by side on top, divided by a bar, and one below.
        assert_eq!(rows[0], "one                 |one");
        assert_eq!(rows[1], "two                 |two");
        assert!(rows[3].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert!(rows[3][21..].starts_with("U:**-  *scratch*"), "{}", rows[3]);
        assert_eq!(rows[4], "one");
        assert!(rows[7].starts_with("U:**-  *scratch*"), "{}", rows[7]);
        assert_eq!(ed.viewport_height(), 3);
    }

    #[test]
    fn mouse_positions_find_windows_and_text() {
        let mut ed = Editor::new();
        let _scripting = e8_script::Scripting::new(&mut ed).unwrap();
        ed.type_text("one\n\ttwo\nthree");
        ed.press("C-x 3").unwrap();
        render(&mut ed, 41, 9);
        let [left, right] = ed.window_list()[..] else { panic!() };
        assert_eq!(mouse_target(&ed, 41, 9, 1, 0), Some((left, Some(1))));
        // Inside the tab on the second line, then past the end of a line.
        assert_eq!(mouse_target(&ed, 41, 9, 25, 1), Some((right, Some(4))));
        assert_eq!(mouse_target(&ed, 41, 9, 35, 0), Some((right, Some(3))));
        // Below the text is the end of the buffer (RET indented "three" like
        // the line before, so it is one longer); the mode line has no position.
        assert_eq!(mouse_target(&ed, 41, 9, 2, 5), Some((left, Some(15))));
        assert_eq!(mouse_target(&ed, 41, 9, 2, 7), Some((left, None)));
        assert_eq!(mouse_target(&ed, 41, 9, 2, 8), None, "the echo area");
    }

    #[test]
    fn long_lines_continue_with_a_backslash() {
        let mut ed = Editor::new();
        ed.type_text(&"abcdefghij".repeat(3));
        ed.type_text("\nend");
        let rows = render(&mut ed, 12, 6);
        assert_eq!(rows[..4], ["abcdefghija\\", "bcdefghijab\\", "cdefghij", "end"]);
        // C-p from the last line goes up one screen line, keeping the column.
        ed.press("C-p").unwrap();
        assert_eq!(ed.window_buffer().point(), 25);
    }

    #[test]
    fn control_characters_and_horizontal_scroll() {
        let mut ed = Editor::new();
        ed.window_buffer_mut().set_text("a\u{1}b\n\tx");
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], "a^Ab");
        assert_eq!(rows[1], "        x");

        // With truncate-lines, point at the end of a 30 column line in a 20
        // column window scrolls it to leave 4 columns right of point, as in
        // Emacs, with `$` at the left for the text scrolled off.
        let mut ed = Editor::new();
        ed.set_variable("truncate-lines", e8_core::Value::Bool(true));
        ed.type_text(&"x".repeat(30));
        let rows = render(&mut ed, 20, 4);
        assert_eq!(rows[0], format!("${}", "x".repeat(15)));
    }

    #[test]
    fn truncated_lines_show_a_dollar_at_either_edge() {
        let mut ed = Editor::new();
        ed.set_variable("truncate-lines", e8_core::Value::Bool(true));
        ed.type_text("0123456789abcdefghij\n0123456789abcdefghi\n\nshort\n0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ");
        ed.press("C-a").unwrap();
        let rows = render(&mut ed, 20, 7);
        // A line as wide as the window loses its last column to the `$`.
        assert_eq!(rows[..5], ["0123456789abcdefghi$", "0123456789abcdefghi", "", "short", "0123456789abcdefghi$"]);
        let point = ed.window_buffer().point() + 34;
        ed.window_buffer_mut().set_point(point);
        let rows = render(&mut ed, 20, 7);
        // Scrolled 24: every line with text scrolled off shows `$` first.
        assert_eq!(rows[..5], ["$", "$", "", "$", "$pqrstuvwxyzABCDEFG$"]);
        assert_eq!(ed.window_hscroll(ed.selected_window()), 24);
    }

    #[test]
    fn a_column_wide_window_shows_only_the_mark() {
        let mut ed = Editor::new();
        ed.type_text("\tabcdefgh");
        let (row, glyphs) = {
            let rows = ed.rows_of_window(ed.selected_window(), 1, true);
            let glyphs = row_glyphs(&rows[0], 8);
            (rows[0].clone(), glyphs)
        };
        let text: String = row_line(&row, &glyphs, 3, 1, None, true, true).spans.iter().map(|s| s.content.to_string()).collect();
        assert_eq!(text, "$");
    }

    #[test]
    fn clicks_land_on_scrolled_text() {
        let mut ed = Editor::new();
        ed.set_variable("truncate-lines", e8_core::Value::Bool(true));
        ed.type_text("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ");
        render(&mut ed, 20, 4);
        // Scrolled 30, the third column shows column 32.
        let target = mouse_target(&ed, 20, 4, 2, 0).unwrap();
        assert_eq!(target.1, Some(32));
    }
}
