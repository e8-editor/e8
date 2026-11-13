//! The mode line, as Emacs's xdisp.c formats it: `mode-line-format` is a
//! construct of strings with %-specs, symbols whose values are shown,
//! `(:eval FUNCTION)`, `(:propertize ELT PROPS...)`, conditionals on a
//! symbol and lists with a field width. [`Editor::redisplay`] formats each
//! window's, and front ends draw the segments, each in its faces.

use std::collections::HashMap;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::Result;
use crate::faces::face_names;
use crate::variables::{Value, Variable};
use crate::window::WindowId;

/// A stretch of the mode line in its faces, innermost last.
#[derive(Clone, Debug, PartialEq)]
pub struct ModeLineSegment {
    pub text: String,
    pub faces: Vec<String>,
}

/// How deep constructs nest before formatting stops, as a loop would otherwise not end.
const DEPTH: usize = 50;

/// What formatting one window's mode line works on.
struct Formatting {
    /// Where point is in the window, which can differ from the buffer's point.
    point: usize,
    top_line: usize,
    height: usize,
    width: usize,
    out: Vec<ModeLineSegment>,
    /// Segments before this one are not added to, as a field width's text
    /// must start a segment of its own to be cut.
    fence: usize,
}

impl Formatting {
    fn columns(&self) -> usize {
        self.out.iter().map(|s| crate::display::display_width(&s.text, 8)).sum()
    }

    fn push(&mut self, text: &str, faces: &[String]) {
        if text.is_empty() {
            return;
        }
        let fenced = self.out.len() <= self.fence;
        match self.out.last_mut() {
            Some(last) if last.faces == faces && !fenced => last.text.push_str(text),
            _ => self.out.push(ModeLineSegment { text: text.to_string(), faces: faces.to_vec() }),
        }
    }
}

impl Editor {
    /// The mode line of a window as the last redisplay formatted it.
    pub fn mode_line(&self, window: WindowId) -> &[ModeLineSegment] {
        self.mode_lines.get(&window).map_or(&[], Vec::as_slice)
    }

    /// The header line of a window as the last redisplay formatted it, if
    /// its format gives one. A window shows it only when
    /// [`Editor::window_wants_header_line`] says so.
    pub fn header_line(&self, window: WindowId) -> Option<&[ModeLineSegment]> {
        self.header_lines.get(&window).map(Vec::as_slice)
    }

    /// The header line format a window has, as Emacs's
    /// window_wants_header_line reads it: its `header-line-format`
    /// parameter, unless that is `none`, which hides it, else its buffer's
    /// `header-line-format`. `None` when that is nil.
    fn header_line_format_of(&self, id: WindowId) -> Option<Value> {
        let w = self.window(id)?;
        let format = match w.parameters.get("header-line-format") {
            Some(Value::Symbol(name) | Value::Str(name)) if name == "none" => return None,
            Some(value) if value.is_true() => value.clone(),
            _ => {
                let index = self.buffer_with_id(w.buffer)?;
                self.variable_in(&self.buffers[index], "header-line-format")?
            }
        };
        match format {
            Value::Null | Value::Bool(false) => None,
            Value::List(ref items) if items.is_empty() => None,
            format => Some(format),
        }
    }

    /// Whether a window `total_lines` high, its mode line counted, shows a
    /// header line: it has a format, and is tall enough for a line of text
    /// as well, as Emacs's window_wants_header_line asks. Front ends lay the
    /// window out with this.
    pub fn window_wants_header_line(&self, id: WindowId, total_lines: usize) -> bool {
        total_lines > 2 && self.header_line_format_of(id).is_some()
    }

    /// Formats every window's mode line from its buffer's
    /// `mode-line-format`, and its header line from `header-line-format`.
    pub(crate) fn update_mode_lines(&mut self) {
        let windows: Vec<(WindowId, u64, usize, usize)> = self
            .frame_list()
            .into_iter()
            .flat_map(|f| self.frame_windows(f).into_iter().map(|v| (v.id, v.buffer.id(), v.point, v.top_line)).collect::<Vec<_>>())
            .collect();
        let mut lines = HashMap::new();
        let mut headers = HashMap::new();
        for (id, buffer, point, top_line) in windows {
            let Some(index) = self.buffer_with_id(buffer) else { continue };
            let format = self.variable_in(&self.buffers[index], "mode-line-format").unwrap_or(Value::Null);
            let mut f = self.formatting(id, point, top_line);
            self.with_current_buffer(index, |ed| ed.mode_line_element(&mut f, &format, &[], 0, false));
            lines.insert(id, f.out);
            if let Some(format) = self.header_line_format_of(id) {
                let mut f = self.formatting(id, point, top_line);
                self.with_current_buffer(index, |ed| ed.mode_line_element(&mut f, &format, &[], 0, false));
                headers.insert(id, f.out);
            }
        }
        self.mode_lines = lines;
        self.header_lines = headers;
        // Each frame's tab bar, formatted for its selected window.
        let mut bars = HashMap::new();
        for frame in self.frame_list() {
            if self.tab_bar_lines(frame) == 0 {
                continue;
            }
            let (Some(format), Some(id)) = (self.frame_parameter(frame, "tab-bar-line"), self.frame_selected_window(frame)) else { continue };
            let Some(view) = self.frame_windows(frame).into_iter().find(|v| v.id == id).map(|v| (v.buffer.id(), v.point, v.top_line)) else { continue };
            let Some(index) = self.buffer_with_id(view.0) else { continue };
            let mut f = self.formatting(id, view.1, view.2);
            f.width = self.frame_width(frame);
            self.with_current_buffer(index, |ed| ed.mode_line_element(&mut f, &format, &[], 0, false));
            bars.insert(frame, f.out);
        }
        self.tab_bars = bars;
        // Each frame's menu bar, from the keymaps in use, as update_menu_bar
        // lays Emacs's out at redisplay.
        self.update_menu_bars();
        // Each frame's title, as Emacs formats frame-title-format for its selected window.
        let mut titles = HashMap::new();
        for frame in self.frame_list() {
            let Some(id) = self.frame_selected_window(frame) else { continue };
            let Some(view) = self.frame_windows(frame).into_iter().find(|v| v.id == id).map(|v| (v.buffer.id(), v.point, v.top_line)) else { continue };
            let Some(index) = self.buffer_with_id(view.0) else { continue };
            let format = self.variable_in(&self.buffers[index], "frame-title-format").unwrap_or(Value::Null);
            let mut f = self.formatting(id, view.1, view.2);
            self.with_current_buffer(index, |ed| ed.mode_line_element(&mut f, &format, &[], 0, false));
            titles.insert(frame, f.out.iter().map(|s| s.text.as_str()).collect::<String>());
        }
        self.frame_titles = titles;
    }

    /// What formatting a window's mode line starts from. %- fills the
    /// mode line, which takes the divider's column too.
    fn formatting(&self, id: WindowId, point: usize, top_line: usize) -> Formatting {
        let (height, width) = self.window(id).map_or((0, 0), |w| (w.height, w.width));
        let width = self.window_total_sizes().iter().find(|t| t.0 == id).map_or(width, |t| t.1);
        Formatting { point, top_line, height, width, out: Vec::new(), fence: 0 }
    }

    /// Formats a mode line construct for the selected window and its
    /// buffer, as Emacs's `format-mode-line`.
    pub fn format_mode_line(&mut self, format: &Value) -> Result<Vec<ModeLineSegment>> {
        let id = self.selected_window;
        let index = self.selected_buffer_index();
        let b = &self.buffers[index];
        // The selected window's point and top line are its buffer's.
        let (point, top_line) = (b.point(), b.top_line);
        let mut f = self.formatting(id, point, top_line);
        self.with_current_buffer(index, |ed| ed.mode_line_element(&mut f, format, &[], 0, false));
        Ok(f.out)
    }

    /// Calls what an :eval or a function in the format gives, as Emacs does
    /// in redisplay: an error leaves it out, logged.
    fn mode_line_call(&mut self, f: impl FnOnce(&mut Editor) -> Result<Value>) -> Value {
        f(self).unwrap_or_else(|e| {
            self.log_message(&format!("Error during redisplay: {e}"), true);
            Value::Null
        })
    }

    /// Formats one construct, as Emacs's display_mode_element: `literal`
    /// for a string that is a symbol's value, whose %-specs are not read.
    fn mode_line_element(&mut self, f: &mut Formatting, elt: &Value, faces: &[String], depth: usize, literal: bool) {
        if depth > DEPTH {
            return;
        }
        match elt {
            Value::Str(s) if literal => f.push(s, faces),
            Value::Str(s) => self.mode_line_string(f, s, faces),
            Value::Text(t) => {
                for (range, text) in text_runs(t) {
                    let props = t.properties_at(range.start);
                    let mut with = faces.to_vec();
                    with.extend(props.and_then(|p| p.get("face")).map(face_names).unwrap_or_default());
                    // A `(space :align-to COLUMN)` display spec pads to the column, as tabulated lists' header lines line their titles up.
                    if let Some(column) = props.and_then(|p| p.get("display")).and_then(|d| self.align_to(d)) {
                        let pad = column.saturating_sub(f.columns());
                        f.push(&" ".repeat(pad), &with);
                        continue;
                    }
                    if literal {
                        f.push(&text, &with);
                    } else {
                        self.mode_line_string(f, &text, &with);
                    }
                }
            }
            Value::Symbol(name) if name == "t" => {}
            Value::Symbol(name) => {
                let value = self.variable(name).unwrap_or(Value::Null);
                let literal = matches!(value, Value::Str(_) | Value::Text(_));
                self.mode_line_element(f, &value, faces, depth + 1, literal);
            }
            Value::Function(function) => {
                let value = self.mode_line_call(|ed| function.call(ed, &[]));
                self.mode_line_element(f, &value, faces, depth + 1, false);
            }
            Value::List(items) => match items.first() {
                None => {}
                Some(Value::Symbol(k)) if k == ":eval" => {
                    let value = match items.get(1) {
                        Some(form) => self.mode_line_call(|ed| ed.funcall(form, &[])),
                        None => Value::Null,
                    };
                    self.mode_line_element(f, &value, faces, depth + 1, false);
                }
                Some(Value::Symbol(k)) if k == ":propertize" => {
                    let mut with = faces.to_vec();
                    for pair in items.get(2..).unwrap_or_default().chunks(2) {
                        if let [name, value] = pair
                            && name.as_str() == Some("face")
                        {
                            with.extend(face_names(value));
                        }
                    }
                    if let Some(inner) = items.get(1) {
                        self.mode_line_element(f, inner, &with, depth + 1, false);
                    }
                }
                // A conditional: THEN if the symbol's value is true, else
                // ELSE; t is always true and nil never.
                Some(first @ (Value::Symbol(_) | Value::Bool(_) | Value::Null)) => {
                    let on = match first {
                        Value::Symbol(name) if name == "t" => true,
                        Value::Symbol(name) => self.variable(name).is_some_and(|v| v.is_true()),
                        other => other.is_true(),
                    };
                    let branch = if on { items.get(1) } else { items.get(2) };
                    if let Some(branch) = branch {
                        self.mode_line_element(f, branch, faces, depth + 1, false);
                    }
                }
                // A field width: pad on the right to at least N columns, or
                // with -N cut to at most N.
                Some(Value::Number(n)) => {
                    let start = f.out.len();
                    let before = f.columns();
                    let fence = std::mem::replace(&mut f.fence, start);
                    for item in &items[1..] {
                        self.mode_line_element(f, item, faces, depth + 1, false);
                    }
                    f.fence = fence;
                    let width = f.columns() - before;
                    let n = *n as i64;
                    if n > 0 && width < n as usize {
                        let pad = " ".repeat(n as usize - width);
                        match f.out.get_mut(start..).and_then(|s| s.last_mut()) {
                            Some(last) => last.text.push_str(&pad),
                            None => f.push(&pad, faces),
                        }
                    } else if n < 0 {
                        truncate_segments(&mut f.out, start, (-n) as usize);
                    }
                }
                Some(_) => {
                    for item in items {
                        self.mode_line_element(f, item, faces, depth + 1, false);
                    }
                }
            },
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::Buffer(_) | Value::Keymap(_) | Value::CharTable(_) | Value::Treesit(_) | Value::Marker(_) | Value::Window(_) | Value::Frame(_) | Value::Terminal(_) | Value::Process(_) | Value::Font(_) | Value::Object(_) => {}
        }
    }

    /// The column a `(space :align-to POS)` display spec in a mode line or
    /// header line reaches, POS a number, a variable such as
    /// `header-line-indent-width`, or a sum `(+ ...)` of them, as Emacs's
    /// calc_pixel_width_or_height counts in columns.
    fn align_to(&self, spec: &Value) -> Option<usize> {
        let Value::List(items) = spec else { return None };
        if items.first().and_then(Value::as_str) != Some("space") {
            return None;
        }
        let at = items.iter().position(|v| v.as_str() == Some(":align-to"))?;
        self.align_position(items.get(at + 1)?).map(|n| n.max(0.0) as usize)
    }

    fn align_position(&self, pos: &Value) -> Option<f64> {
        match pos {
            Value::Number(n) => Some(*n),
            Value::Symbol(name) | Value::Str(name) => self.variable(name).and_then(|v| v.as_number()),
            Value::List(items) if items.first().and_then(Value::as_str) == Some("+") => {
                items[1..].iter().map(|v| self.align_position(v)).sum()
            }
            _ => None,
        }
    }

    /// A string with its %-specs worked out, as decode_mode_spec does.
    fn mode_line_string(&self, f: &mut Formatting, s: &str, faces: &[String]) {
        let mut chars = s.chars().peekable();
        let mut plain = String::new();
        while let Some(c) = chars.next() {
            if c != '%' {
                plain.push(c);
                continue;
            }
            let mut width = String::new();
            while let Some(d) = chars.peek().filter(|d| d.is_ascii_digit()) {
                width.push(*d);
                chars.next();
            }
            let Some(spec) = chars.next() else { break };
            f.push(&std::mem::take(&mut plain), faces);
            let width: usize = width.parse().unwrap_or(0);
            let text = match spec {
                '-' => {
                    let left = f.width.saturating_sub(f.columns());
                    "-".repeat(left)
                }
                _ => self.mode_line_spec(f, spec),
            };
            let numeric = matches!(spec, 'l' | 'c' | 'C' | 'i');
            let shown = crate::display::display_width(&text, 8);
            let text = if shown >= width {
                text
            } else if numeric {
                format!("{}{text}", " ".repeat(width - shown))
            } else {
                format!("{text}{}", " ".repeat(width - shown))
            };
            f.push(&text, faces);
        }
        f.push(&plain, faces);
    }

    /// What a %-spec shows for the current buffer in the window being formatted.
    fn mode_line_spec(&self, f: &Formatting, spec: char) -> String {
        let b: &Buffer = self.buffer();
        match spec {
            'b' => b.name.clone(),
            'f' => b.path.as_ref().map_or_else(|| b.name.clone(), |p| p.display().to_string()),
            '*' => if b.read_only { "%" } else if b.is_modified() { "*" } else { "-" }.into(),
            '+' => if b.is_modified() { "*" } else if b.read_only { "%" } else { "-" }.into(),
            '&' => if b.is_modified() { "*" } else { "-" }.into(),
            // Lines count from the start of the accessible portion.
            'l' => (b.line_of(f.point.min(b.len())) - b.line_of(b.point_min()) + 1).to_string(),
            'c' => b.column(f.point.min(b.len())).to_string(),
            'C' => (b.column(f.point.min(b.len())) + 1).to_string(),
            'n' => if b.is_narrowed() { " Narrow" } else { "" }.into(),
            'm' => self.variable("mode-name").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            'Z' => b.coding_mnemonic(),
            'z' => {
                let mut m = b.coding_mnemonic();
                m.pop();
                m
            }
            'i' => b.len().to_string(),
            'I' => human_size(b.len()),
            'p' => self.window_position(f, b),
            '@' => "-".into(),
            '%' => "%".into(),
            // A bracket for each recursive edit, as Emacs's command_loop_level.
            '[' => match self.recursive_edit_depth() {
                n if n > 5 => "[[[... ".into(),
                n => "[".repeat(n),
            },
            ']' => match self.recursive_edit_depth() {
                n if n > 5 => " ...]]]".into(),
                n => "]".repeat(n),
            },
            // The memory-full flag, which E8 has not.
            'e' => String::new(),
            _ => String::new(),
        }
    }

    /// How far through the buffer the window is, as Emacs's %p: All, Top,
    /// Bot, or the percentage above the window's top.
    fn window_position(&self, f: &Formatting, b: &Buffer) -> String {
        let (min, max) = (b.point_min(), b.point_max());
        let first = b.line_of(min);
        let top = f.top_line.max(first);
        let start = b.line_start(top).max(min);
        let last = top + f.height.max(1);
        let end_visible = last > b.line_of(max);
        match (start <= min, end_visible) {
            (true, true) => "All".into(),
            (true, false) => "Top".into(),
            (false, true) => "Bot".into(),
            (false, false) => format!("{:2}%", ((start - min) * 100) / (max - min).max(1)),
        }
    }
}


/// A propertized string's stretches of the same properties, by character.
fn text_runs(t: &crate::properties::Text) -> Vec<(std::ops::Range<usize>, String)> {
    let chars: Vec<char> = t.string.chars().collect();
    let mut cuts: Vec<usize> = vec![0, chars.len()];
    for (range, _) in &t.props {
        cuts.push(range.start.min(chars.len()));
        cuts.push(range.end.min(chars.len()));
    }
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2).filter(|w| w[0] < w[1]).map(|w| (w[0]..w[1], chars[w[0]..w[1]].iter().collect())).collect()
}

/// Cuts the segments from `start` on to `columns` wide.
fn truncate_segments(out: &mut Vec<ModeLineSegment>, start: usize, columns: usize) {
    let mut left = columns;
    let mut keep = start;
    for segment in out.iter_mut().skip(start) {
        let mut text = String::new();
        for c in segment.text.chars() {
            let w = crate::display::display_width(&c.to_string(), 8);
            if w > left {
                left = 0;
                break;
            }
            left -= w;
            text.push(c);
        }
        segment.text = text;
        keep += 1;
        if left == 0 {
            break;
        }
    }
    out.truncate(keep);
    out.retain(|s| !s.text.is_empty());
}

fn human_size(n: usize) -> String {
    match n {
        0..1000 => n.to_string(),
        1000..1_000_000 => format!("{:.1}k", n as f64 / 1000.0),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

fn sym(name: &str) -> Value {
    Value::Symbol(name.to_string())
}

fn s(text: &str) -> Value {
    Value::Str(text.to_string())
}

fn propertize(elt: Value, face: &str) -> Value {
    Value::List(vec![sym(":propertize"), elt, s("face"), s(face)])
}

/// The mode line constructs Emacs's default format is made of, as
/// bindings.el defines them, and the format itself: the one the terminal
/// shows, `U:--  name   L1    C0    (Text) ----`.
pub(crate) fn install(ed: &mut Editor) {
    let vars = [
        ("mode-line-mule-info", "The coding of the buffer's file in the mode line: U for UTF-8 and so on, then its line ends.", Value::List(vec![s("%Z")])),
        ("mode-line-modified", "Whether the buffer is read-only and whether it is modified, in the mode line: %%, ** or --.", Value::List(vec![s("%*%+")])),
        (
            "mode-line-buffer-identification",
            "The buffer's name in the mode line, at least 18 columns wide.",
            Value::List(vec![propertize(s("%18b"), "mode-line-buffer-id")]),
        ),
        (
            "mode-line-position",
            "Where point is, in the mode line: its line and column.",
            Value::List(vec![Value::List(vec![Value::Number(6.0), s("L%l")]), s(" "), Value::List(vec![Value::Number(5.0), s("C%c")])]),
        ),
        (
            "mode-line-modes",
            "The major mode and the minor modes that are on, in the mode line, in parentheses, inside a bracket for each recursive edit.",
            Value::List(vec![
                s("%[("),
                sym("mode-name"),
                sym("mode-line-process"),
                sym("minor-mode-alist"),
                s("%n"),
                Value::List(vec![sym("defining-kbd-macro"), s(" Def")]),
                s(")%] "),
            ]),
        ),
        (
            "mode-line-misc-info",
            "What the mode line shows after the modes: global-mode-string, where packages such as Org's clock put what they show in every mode line.",
            Value::List(vec![Value::List(vec![sym("global-mode-string"), Value::List(vec![s(""), sym("global-mode-string")])])]),
        ),
    ];
    for (name, doc, value) in vars {
        ed.define_variable(Variable::new(name, doc, value));
    }
    ed.define_variable(Variable::new(
        "frame-title-format",
        "What a frame's window title shows, a mode line construct formatted for its selected window, as Emacs's: \"%b\" for the buffer's name.",
        s("%b \u{2014} E8"),
    ));
    ed.define_variable(Variable::new(
        "global-mode-string",
        "What every mode line shows after the modes, a mode line construct, as Org's running clock adds to it.",
        Value::Null,
    ));
    ed.define_variable(
        Variable::new(
            "mode-line-format",
            "What each window's mode line shows, as a mode line construct: a string, whose %-specs show the buffer's state (%b its name, %* and %+ whether it is read-only or modified, %l and %c point's line and column, %n Narrow when narrowed, %Z the coding, %p how far through the buffer the window is, %- dashes to the end); a symbol, whose value is shown, a string as it is; a list of constructs; [\":eval\", function], whose result is shown; [\":propertize\", construct, \"face\", face]; [symbol, then, else], which shows then when the symbol's value is true; or [width, ...constructs], padded to at least width columns, or cut to -width.",
            // It starts with a string, as Emacs's does with "%e", since a
            // list that starts with a symbol is a conditional.
            Value::List(vec![s("%e"), sym("mode-line-mule-info"), sym("mode-line-modified"), s("-  "), sym("mode-line-buffer-identification"), s(" "), sym("mode-line-position"), s(" "), sym("mode-line-modes"), sym("mode-line-misc-info"), s("%-")]),
        )
        .local(),
    );
    ed.define_variable(
        Variable::new(
            "header-line-format",
            "What a window's header line shows, a mode line construct as `mode-line-format` is; nil, the default, for no header line. A window's `header-line-format` parameter takes its place, and `none` there hides it.",
            Value::Null,
        )
        .local(),
    );
    ed.define_variable(Variable::new(
        "header-line-indent-width",
        "How many columns the line numbers take left of the text, which a header line's `:align-to` positions can add to line titles up with the text, as header-line-indent-mode keeps it.",
        Value::Number(0.0),
    ).local());
    ed.define_variable(
        Variable::new(
            "mode-line-process",
            "What the mode line shows of the buffer's process after the mode's name, a mode line construct, as shell and compilation buffers show \":run\"; nil for nothing.",
            Value::Null,
        )
        .local(),
    );
    ed.define_variable(Variable::new("minor-mode-alist", "The minor modes' lighters in the mode line, as [mode, lighter] pairs: each lighter shows while its mode's variable is true.", Value::List(Vec::new())));
    ed.define_variable(Variable::new("defining-kbd-macro", "Whether a keyboard macro is being defined, which the mode line shows as Def.", false));
}

impl Editor {
    /// Keeps `minor-mode-alist` to the registered minor modes' lighters.
    /// Entries code added for a mode registered with no lighter of its own,
    /// as text-scale-mode's `(" " text-scale-mode-lighter)`, stay.
    pub(crate) fn update_minor_mode_alist(&mut self) {
        let named: Vec<&str> = self.minor_modes.iter().filter(|m| !m.lighter.is_empty()).map(|m| m.name.as_str()).collect();
        let kept: Vec<Value> = match self.default_value("minor-mode-alist") {
            Some(Value::List(entries)) => entries
                .into_iter()
                .filter(|e| match e {
                    Value::List(items) => items.first().and_then(|m| m.as_str()).is_some_and(|m| !named.contains(&m)),
                    _ => false,
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut pairs: Vec<Value> = self
            .minor_modes
            .iter()
            .rev()
            .filter(|m| !m.lighter.is_empty())
            .map(|m| Value::List(vec![sym(&m.name), s(&m.lighter)]))
            .collect();
        pairs.extend(kept);
        self.set_default("minor-mode-alist", Value::List(pairs));
    }
}
