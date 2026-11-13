//! Menus, as Emacs has them: a menu is a keymap whose bindings are
//! `menu-item`s ([`crate::keymap::MenuItem`]), or the list of panes and
//! items `x-popup-menu` also takes. The editor lays the menu out itself
//! and puts it in the frame description as panels of cells, which both
//! front ends draw over the windows, as term.c draws Emacs's on a
//! terminal; the keys that walk it are read one by one and looked up in
//! `menu-navigation-map`, as term.c's `read_menu_input` looks them up in
//! `tty-menu-navigation-map` (ADR 0076).

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::{Key, format_keys};
use crate::keymap::{Binding, ButtonKind, KeymapId};
use crate::keyboard::ReadKind;
use crate::variables::Value;

/// The keymap whose bindings say what a key does while a menu is open.
pub const NAVIGATION_MAP: &str = "menu-navigation-map";

/// How deep a menu may go, so a keymap bound inside itself ends.
const DEPTH: usize = 16;

/// Where a menu is put.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MenuPosition {
    /// Where the pointer is, as Emacs's POSITION of `t`.
    Mouse,
    /// Where point shows in the selected window.
    Point,
    /// Columns and lines from the top left of a window, or of the frame
    /// with none.
    At { x: f64, y: f64, window: Option<crate::window::WindowId> },
}

/// One line of a menu as it is shown.
#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub(crate) label: String,
    /// The keys that reach it from the menu's root, for the answer a
    /// keymap menu gives.
    pub(crate) keys: Vec<Key>,
    /// What a pane's item is worth, for the answer a list menu gives.
    pub(crate) value: Option<Value>,
    /// Whether it can be chosen: a pane's title and a plain string cannot,
    /// nor can an item whose `:enable` said no.
    pub(crate) enabled: bool,
    /// Whether it is a title rather than an item.
    pub(crate) title: bool,
    pub(crate) help: Option<String>,
    /// The keys shown to its right, which run the same command.
    pub(crate) key_text: String,
    pub(crate) button: Option<(ButtonKind, bool)>,
    /// Its submenu's lines, if it opens one.
    pub(crate) children: Option<Vec<Node>>,
}

impl Node {
    fn line(label: &str, title: bool) -> Node {
        Node {
            label: label.to_string(),
            keys: Vec::new(),
            value: None,
            enabled: false,
            title,
            help: None,
            key_text: String::new(),
            button: None,
            children: None,
        }
    }

    /// What it is drawn as, without the padding a panel adds: the button
    /// it shows, its label, the keys that run it, and `>` for a submenu.
    fn text(&self, width: usize) -> String {
        let mark = match self.button {
            Some((ButtonKind::Toggle, on)) => if on { "[X] " } else { "[ ] " },
            Some((ButtonKind::Radio, on)) => if on { "(*) " } else { "( ) " },
            None => "",
        };
        let right = if self.children.is_some() {
            ">".to_string()
        } else {
            self.key_text.clone()
        };
        let left = format!("{mark}{}", self.label);
        let pad = width.saturating_sub(left.chars().count() + right.chars().count());
        format!("{left}{}{right}", " ".repeat(pad))
    }

    /// How wide its text is, before padding.
    fn width(&self) -> usize {
        let mark = if self.button.is_some() { 4 } else { 0 };
        let right = if self.children.is_some() { 1 } else { self.key_text.chars().count() };
        mark + self.label.chars().count() + if right > 0 { right + 2 } else { 0 }
    }
}

/// A menu while it is open and `x-popup-menu` waits for an answer.
pub(crate) struct OpenMenu {
    pub(crate) nodes: Vec<Node>,
    /// Which item each open submenu was opened from, outermost first.
    pub(crate) path: Vec<usize>,
    /// Which line of the innermost panel the cursor is on.
    pub(crate) cursor: usize,
    /// Where the first panel's top left cell goes, in frame cells.
    pub(crate) at: (usize, usize),
    /// The frame it was laid out for.
    pub(crate) frame: crate::window::FrameId,
    /// Whether the echo area is showing an item's help, so it can be
    /// taken away again.
    pub(crate) helped: bool,
}

/// One panel of an open menu, as a front end draws it: its top left cell
/// in frame columns and lines, and the lines it holds.
#[derive(Clone, Debug)]
pub struct MenuPanel {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub rows: Vec<MenuRow>,
}

/// One line of a panel, already padded to the panel's width.
#[derive(Clone, Debug)]
pub struct MenuRow {
    pub text: String,
    pub style: crate::faces::Style,
    /// Whether the cursor is on it.
    pub selected: bool,
}

impl OpenMenu {
    /// The lines of each open level, outermost first.
    fn levels(&self) -> Vec<&[Node]> {
        let mut out: Vec<&[Node]> = vec![&self.nodes];
        let mut nodes = &self.nodes;
        for &i in &self.path {
            let Some(children) = nodes.get(i).and_then(|n| n.children.as_ref()) else { break };
            out.push(children);
            nodes = children;
        }
        out
    }

    /// The lines of the panel the cursor is in.
    fn current(&self) -> &[Node] {
        self.levels().last().copied().unwrap_or(&[])
    }

    /// Where each panel's top left cell goes and how wide it is: each
    /// opens to the right of the item that opened it, a line lower, as
    /// Emacs's deck of cards does.
    fn places(&self, frame: (usize, usize)) -> Vec<(usize, usize, usize)> {
        let mut out = Vec::new();
        let (mut x, mut y) = self.at;
        for (level, nodes) in self.levels().iter().enumerate() {
            let width = nodes.iter().map(|n| n.width()).max().unwrap_or(1) + 2;
            if level > 0 {
                let from = self.path[level - 1];
                let (px, py, pw) = out[level - 1];
                x = px + pw;
                y = py + from;
            }
            // Kept on the frame, moved left and up rather than cut off.
            let x0 = x.min(frame.0.saturating_sub(width));
            let y0 = y.min(frame.1.saturating_sub(nodes.len()));
            out.push((x0, y0, width));
            x = x0;
            y = y0;
        }
        out
    }

    /// The item at a cell of the frame, as the panels lie: which level and
    /// which of its lines, or none for a cell outside every panel.
    fn at_cell(&self, frame: (usize, usize), x: usize, y: usize) -> Option<(usize, usize)> {
        for (level, (px, py, width)) in self.places(frame).into_iter().enumerate().rev() {
            let nodes = self.levels()[level];
            if x >= px && x < px + width && y >= py && y < py + nodes.len() {
                return Some((level, y - py));
            }
        }
        None
    }
}

impl Editor {
    /// The panels of the menu that is open, for the frame description.
    pub(crate) fn menu_panels(&self, dark: bool) -> Vec<MenuPanel> {
        let Some(menu) = self.menu.as_ref() else { return Vec::new() };
        let style = |face: &str| self.style_for(&[face.to_string()], dark);
        let (enabled, disabled, selected) =
            (style("tty-menu-enabled-face"), style("tty-menu-disabled-face"), style("tty-menu-selected-face"));
        let levels = menu.levels();
        let deepest = levels.len() - 1;
        menu.places(self.frame_cells())
            .into_iter()
            .enumerate()
            .map(|(level, (x, y, width))| {
                let rows = levels[level]
                    .iter()
                    .enumerate()
                    .map(|(i, node)| {
                        let here = level == deepest && i == menu.cursor || level < deepest && menu.path[level] == i;
                        MenuRow {
                            text: format!(" {} ", node.text(width - 2)),
                            style: if here {
                                selected.clone()
                            } else if node.enabled {
                                enabled.clone()
                            } else {
                                disabled.clone()
                            },
                            selected: here,
                        }
                    })
                    .collect();
                MenuPanel { x, y, width, rows }
            })
            .collect()
    }

    /// Whether a menu is open, as `menu-or-popup-active-p`.
    pub fn menu_active(&self) -> bool {
        self.menu.is_some()
    }

    /// Pops a menu up and gives back what was chosen, as Emacs's
    /// `x-popup-menu`: the keys that reach the item for a menu made of
    /// keymaps, the item's value for one made of lists, and nothing if it
    /// was left without choosing. With no position nothing is shown, as
    /// Emacs's `x-popup-menu` with nil only precomputes.
    pub fn x_popup_menu(&mut self, menu: &Value, position: Option<MenuPosition>) -> Result<Value> {
        let nodes = self.menu_nodes(menu)?;
        let Some(position) = position else { return Ok(Value::Null) };
        if nodes.iter().all(|n| n.title) {
            return Err(Error::new("Empty menu"));
        }
        let by_mouse = position == MenuPosition::Mouse;
        let at = self.menu_place(position);
        let cursor = nodes.iter().position(|n| !n.title).unwrap_or(0);
        let frame = self.selected_frame();
        let open = OpenMenu { nodes, path: Vec::new(), cursor, at, frame, helped: false };
        // A menu opened while another is (from a timer, say) gives the
        // outer one back when it closes, as each of Emacs's keeps its own
        // state on the stack.
        let outer = self.menu.replace(open);
        let answer = self.walk_menu();
        self.menu = outer;
        match answer {
            Ok(Some(value)) => Ok(value),
            Ok(None) if by_mouse => Ok(Value::Null),
            // A menu a key opened quits when it is left, as menu.c's does.
            Ok(None) => Err(Error::signal("quit", "Quit", Vec::new())),
            Err(e) => Err(e),
        }
    }

    /// Where a menu's first panel goes, in frame cells.
    fn menu_place(&self, position: MenuPosition) -> (usize, usize) {
        let (columns, lines) = self.frame_cells();
        let middle = (columns / 2, lines / 2);
        match position {
            MenuPosition::Mouse => match self.mouse_position() {
                (_, Some((x, y))) => (x.max(0) as usize, y.max(0) as usize),
                _ => middle,
            },
            MenuPosition::Point => match self.point_cell() {
                Some(cell) => cell,
                None => middle,
            },
            MenuPosition::At { x, y, window } => {
                let (left, top) = window
                    .and_then(|w| self.window_edges(w, false))
                    .map_or((0, 0), |(left, top, _, _)| (left, top));
                (left + x.max(0.0) as usize, top + y.max(0.0) as usize)
            }
        }
    }

    /// The frame cell point shows in, if it is in sight.
    fn point_cell(&self) -> Option<(usize, usize)> {
        let window = self.selected_window();
        let posn = self.posn_at_point(self.buffer().point(), window)?;
        let (left, top, _, _) = self.window_edges(window, true)?;
        Some((left + posn.col.max(0.0) as usize, top + posn.row))
    }

    /// Reads keys until the menu is chosen from or left.
    fn walk_menu(&mut self) -> Result<Option<Value>> {
        let map = self.menu_navigation_map();
        let tracking = self.variable("track-mouse");
        self.set_variable("track-mouse", Value::Bool(true));
        let answer = self.menu_keys(map);
        // The last help-echo goes, so that it does not stay after the
        // menu, as tty_menu_activate takes it away on its way out.
        if self.menu.as_ref().is_some_and(|m| m.helped) {
            self.message = None;
        }
        match tracking {
            Some(value) => self.set_variable("track-mouse", value),
            None => self.set_variable("track-mouse", Value::Null),
        }
        answer
    }

    fn menu_keys(&mut self, map: KeymapId) -> Result<Option<Value>> {
        let frame = self.menu.as_ref().map(|m| m.frame);
        loop {
            // One event at a time, as read_menu_command reads one: ESC is
            // itself here rather than a prefix, and C-g leaves the menu
            // as `keyboard-quit` does in Emacs's navigation map.
            let typed = match self.read_key_event(ReadKind::Key, "", None) {
                Ok(Some(typed)) => typed,
                Ok(None) => return Ok(None),
                Err(e) if e.is("quit") => return Ok(None),
                Err(e) => return Err(e),
            };
            // Input that switched frames under the menu's feet leaves it,
            // as read_menu_input does: its place and faces are no longer
            // the ones it was laid out for.
            if frame != Some(self.selected_frame()) {
                return Ok(None);
            }
            let keys = Key::parse_seq(&typed);
            let what = match keys.as_ref().map(|keys| self.keymaps().lookup(map, keys)) {
                Some(crate::keymap::Lookup::Command(name)) => name,
                // A key the navigation map does not bind is ignored and
                // the menu stays up, as read_menu_input ignores one.
                _ => continue,
            };
            match what.as_str() {
                "menu-exit" => return Ok(None),
                "menu-next-item" => self.menu_move(1),
                "menu-prev-item" => self.menu_move(-1),
                "menu-next-menu" => {
                    self.menu_open_submenu();
                }
                "menu-prev-menu" => self.menu_close_submenu(),
                "menu-select" => {
                    if let Some(answer) = self.menu_choose() {
                        return Ok(Some(answer));
                    }
                }
                "menu-mouse-movement" => self.menu_follow_pointer(),
                "menu-mouse-select" => {
                    // A click away from the menu leaves it, as clicking
                    // outside a pop-up menu does.
                    if !self.menu_point_at_pointer() {
                        return Ok(None);
                    }
                    if let Some(answer) = self.menu_choose() {
                        return Ok(Some(answer));
                    }
                }
                _ => {}
            }
            self.menu_show_help();
        }
    }

    /// Shows the item's `:help` in the echo area, as term.c's menus do,
    /// and takes the last one away where the item has none, so it does not
    /// outlive the item it belongs to.
    fn menu_show_help(&mut self) {
        let help = self.menu.as_ref().and_then(|m| m.current().get(m.cursor).and_then(|n| n.help.clone()));
        let helped = self.menu.as_ref().is_some_and(|m| m.helped);
        match help {
            Some(help) => {
                self.message = Some(help);
                if let Some(menu) = self.menu.as_mut() {
                    menu.helped = true;
                }
            }
            None if helped => {
                self.message = None;
                if let Some(menu) = self.menu.as_mut() {
                    menu.helped = false;
                }
            }
            None => {}
        }
    }

    /// Moves the cursor by `by` lines, over the titles and past the ends,
    /// as Emacs's menus stop at them.
    fn menu_move(&mut self, by: isize) {
        let Some(menu) = self.menu.as_ref() else { return };
        let nodes = menu.current();
        let count = nodes.len();
        if count == 0 {
            return;
        }
        let mut at = menu.cursor;
        for _ in 0..count {
            // Past either end it starts again at the other, as term.c's
            // MI_SCROLL_FORWARD and MI_SCROLL_BACK wrap a menu that fits
            // on the screen.
            at = (at as isize + by).rem_euclid(count as isize) as usize;
            if !nodes[at].title {
                break;
            }
        }
        if nodes[at].title {
            return;
        }
        if let Some(menu) = self.menu.as_mut() {
            menu.cursor = at;
        }
    }

    /// Opens the submenu the cursor is on, if it has one.
    fn menu_open_submenu(&mut self) -> bool {
        let Some(menu) = self.menu.as_mut() else { return false };
        let at = menu.cursor;
        let Some(children) = menu.current().get(at).and_then(|n| n.children.clone()) else { return false };
        if menu.path.len() + 1 >= DEPTH {
            return false;
        }
        let first = children.iter().position(|n| !n.title).unwrap_or(0);
        menu.path.push(at);
        menu.cursor = first;
        true
    }

    /// Closes the innermost submenu, leaving the cursor on the item that
    /// opened it.
    fn menu_close_submenu(&mut self) {
        let Some(menu) = self.menu.as_mut() else { return };
        if let Some(at) = menu.path.pop() {
            menu.cursor = at;
        }
    }

    /// Chooses the item the cursor is on: its answer, or none when it
    /// opens a submenu, which is opened instead, or cannot be chosen.
    fn menu_choose(&mut self) -> Option<Value> {
        let menu = self.menu.as_ref()?;
        let node = menu.current().get(menu.cursor)?;
        if node.children.is_some() {
            self.menu_open_submenu();
            return None;
        }
        if !node.enabled {
            return None;
        }
        match &node.value {
            Some(value) => Some(value.clone()),
            None => Some(Value::Str(format_keys(&node.keys))),
        }
    }

    /// Puts the cursor where the pointer is, and opens the submenu it
    /// lands on, as tty_menu_activate opens one the mouse moves onto.
    fn menu_follow_pointer(&mut self) {
        if self.menu_point_at_pointer() {
            self.menu_open_submenu();
        }
    }

    /// Puts the cursor on the item under the pointer. False if the
    /// pointer is not on the menu at all.
    fn menu_point_at_pointer(&mut self) -> bool {
        let cells = self.frame_cells();
        let (_, at) = self.mouse_position();
        let Some((x, y)) = at else { return false };
        let Some(menu) = self.menu.as_mut() else { return false };
        let Some((level, line)) = menu.at_cell(cells, x.max(0) as usize, y.max(0) as usize) else { return false };
        menu.path.truncate(level);
        if menu.current().get(line).is_some_and(|n| !n.title) {
            menu.cursor = line;
        }
        true
    }

    /// The keymap whose bindings say what a key does while a menu is open,
    /// as Emacs's `tty-menu-navigation-map`.
    pub(crate) fn menu_navigation_map(&mut self) -> KeymapId {
        self.define_keymap(NAVIGATION_MAP, None)
    }
}

/// What each key does while a menu is open, as menu-bar.el binds
/// `tty-menu-navigation-map`. The commands are names the menu reads, not
/// commands to run, as term.c reads its `tty-menu-*` symbols.
pub(crate) const NAVIGATION: &[(&str, &str)] = &[
    ("C-g", "menu-exit"),
    ("ESC", "menu-exit"),
    ("<down>", "menu-next-item"),
    ("C-n", "menu-next-item"),
    ("<up>", "menu-prev-item"),
    ("C-p", "menu-prev-item"),
    ("<right>", "menu-next-menu"),
    ("C-f", "menu-next-menu"),
    ("<left>", "menu-prev-menu"),
    ("C-b", "menu-prev-menu"),
    ("RET", "menu-select"),
    ("C-j", "menu-select"),
    ("<mouse-movement>", "menu-mouse-movement"),
    ("<mouse-1>", "menu-mouse-select"),
    ("<mouse-2>", "menu-mouse-select"),
    ("<mouse-3>", "menu-mouse-select"),
    ("<down-mouse-1>", "menu-ignore"),
    ("<down-mouse-2>", "menu-ignore"),
    ("<down-mouse-3>", "menu-ignore"),
    ("<wheel-down>", "menu-next-item"),
    ("<wheel-up>", "menu-prev-item"),
    ("<drag-mouse-1>", "menu-mouse-select"),
    ("<drag-mouse-2>", "menu-mouse-select"),
    ("<drag-mouse-3>", "menu-mouse-select"),
];

impl Editor {
    /// The lines of a menu, from a keymap, a list of keymaps, or the list
    /// of panes and items `x-popup-menu` takes.
    pub(crate) fn menu_nodes(&mut self, menu: &Value) -> Result<Vec<Node>> {
        match menu {
            Value::Keymap(map) => self.keymap_nodes(*map, &[], 0),
            Value::List(items) if items.iter().all(|i| matches!(i, Value::Keymap(_))) && !items.is_empty() => {
                let mut out = Vec::new();
                for item in items {
                    let Value::Keymap(map) = item else { continue };
                    out.extend(self.keymap_nodes(*map, &[], 0)?);
                }
                Ok(out)
            }
            Value::List(items) => Ok(pane_nodes(items)),
            _ => Err(Error::new("Not a menu")),
        }
    }

    /// The lines a menu keymap gives, in the order its items were bound.
    fn keymap_nodes(&mut self, map: KeymapId, prefix: &[Key], depth: usize) -> Result<Vec<Node>> {
        if depth >= DEPTH {
            return Ok(Vec::new());
        }
        let mut items: Vec<(Key, Box<crate::keymap::MenuItem>)> = self
            .keymaps()
            .direct_bindings(map)
            .into_iter()
            .filter_map(|(key, binding)| match binding {
                Binding::Menu(item) => Some((key, item)),
                _ => None,
            })
            .collect();
        items.sort_by_key(|(_, item)| item.order);
        let mut out = Vec::new();
        for (key, item) in items {
            if let Some(visible) = &item.visible
                && !self.menu_truth(visible)?
            {
                continue;
            }
            let mut keys = prefix.to_vec();
            keys.push(key);
            // A `:filter` is given what the item runs and gives back what
            // it really runs, before anything else is asked about it, as
            // parse_menu_item applies one: it may turn nothing into a
            // submenu built as the menu opens.
            let binding = self.menu_filter(&item.filter, &item.binding)?;
            let enabled = match &item.enable {
                Some(value) => self.menu_truth(value)?,
                None => true,
            };
            let button = match &item.button {
                Some((kind, value)) => Some((*kind, self.menu_truth(value)?)),
                None => None,
            };
            let children = match binding {
                Binding::Keymap(sub) => Some(self.keymap_nodes(sub, &keys, depth + 1)?),
                _ => None,
            };
            let key_text = match (&item.keys, &binding) {
                (Some(keys), _) => keys.clone(),
                (None, Binding::Command(command)) => key_equivalent(&self.where_is_all(command)),
                _ => String::new(),
            };
            out.push(Node {
                label: item.label.clone(),
                keys,
                value: None,
                enabled: enabled && !matches!(binding, Binding::Nil),
                title: false,
                help: item.help.clone(),
                key_text,
                button,
                children,
            });
        }
        Ok(out)
    }

    /// What an item runs once its `:filter`, if it has one, has had the
    /// definition and given back the one to use.
    fn menu_filter(&mut self, filter: &Option<Value>, binding: &Binding) -> Result<Binding> {
        let Some(filter) = filter else { return Ok(binding.clone()) };
        let given = match binding {
            Binding::Keymap(map) => Value::Keymap(*map),
            Binding::Command(command) => Value::Str(command.clone()),
            _ => Value::Null,
        };
        Ok(match self.funcall(filter, &[given])? {
            Value::Keymap(map) => Binding::Keymap(map),
            Value::Str(command) => Binding::Command(command),
            Value::Null => Binding::Nil,
            _ => binding.clone(),
        })
    }

    /// Whether a menu item's property says yes: a function is called, as
    /// Emacs evaluates the form a property holds.
    fn menu_truth(&mut self, value: &Value) -> Result<bool> {
        match value {
            Value::Function(_) => Ok(self.funcall(value, &[])?.is_true()),
            other => Ok(other.is_true()),
        }
    }
}

/// The keys shown beside a menu item: the first of the keys that run its
/// command, those of plain characters preferred, as `where-is-internal`
/// with FIRSTONLY prefers an ASCII sequence.
fn key_equivalent(keys: &[Vec<Key>]) -> String {
    let plain = |seq: &&Vec<Key>| seq.iter().all(|k| matches!(k.code, crate::key::KeyCode::Char(c) if c.is_ascii()));
    keys.iter().find(plain).or_else(|| keys.first()).map(|keys| format_keys(keys)).unwrap_or_default()
}

/// The lines of Emacs's list menu, `(TITLE (PANE-TITLE ITEM...)...)`:
/// each pane's title is a line that cannot be chosen, and each item is
/// `(LABEL . VALUE)` or a string that cannot be chosen either.
fn pane_nodes(items: &[Value]) -> Vec<Node> {
    let mut out = Vec::new();
    let mut rest = items;
    if let Some(title) = rest.first().and_then(Value::as_str) {
        out.push(Node::line(title, true));
        rest = &rest[1..];
    }
    for pane in rest {
        let Value::List(pane) = pane else { continue };
        let mut lines = pane.as_slice();
        if let Some(title) = lines.first().and_then(Value::as_str) {
            if !title.is_empty() {
                out.push(Node::line(title, true));
            }
            lines = &lines[1..];
        }
        for item in lines {
            match item {
                Value::List(pair) if pair.len() == 2 => {
                    let label = pair[0].as_str().map_or_else(|| pair[0].to_string(), str::to_string);
                    out.push(Node {
                        enabled: true,
                        value: Some(pair[1].clone()),
                        ..Node::line(&label, false)
                    });
                }
                other => {
                    let label = other.as_str().map_or_else(|| other.to_string(), str::to_string);
                    out.push(Node::line(&label, true));
                }
            }
        }
    }
    out
}
