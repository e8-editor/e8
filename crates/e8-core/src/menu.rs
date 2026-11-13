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

/// How walking a menu ended.
enum Outcome {
    Chosen(Value),
    /// Left without choosing.
    Left,
    /// Moved to another of the menu bar's menus, that many along.
    Switch(isize),
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
    /// Whether it is a line across the menu rather than a label, as an
    /// item whose name starts with `--` is in Emacs.
    pub(crate) separator: bool,
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
            separator: label.starts_with("--"),
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
        if self.separator {
            return "-".repeat(width);
        }
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
        if self.separator {
            return 0;
        }
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
    /// The first line each open panel shows, outermost first, for a panel
    /// taller than the frame, as term.c keeps `first_item` for each.
    pub(crate) firsts: Vec<usize>,
    /// Where the first panel's top left cell goes, in frame cells.
    pub(crate) at: (usize, usize),
    /// The frame it was laid out for.
    pub(crate) frame: crate::window::FrameId,
    /// Whether the echo area is showing an item's help, so it can be
    /// taken away again.
    pub(crate) helped: bool,
    /// Which item of the menu bar it was opened from, if it was, so that
    /// moving left and right at its top level goes to the next menu.
    pub(crate) bar: Option<usize>,
}

/// Where a panel goes and which of its lines it shows.
struct Place {
    x: usize,
    y: usize,
    width: usize,
    /// The first line shown, for a panel taller than the frame.
    first: usize,
    /// How many lines it shows.
    count: usize,
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

    /// Where each panel goes: its top left cell, how wide it is, and which
    /// of its lines it shows. Each opens to the right of the item that
    /// opened it, a line lower, as Emacs's deck of cards does. A panel
    /// taller than the frame shows the lines around the cursor, as
    /// term.c's menus scroll to it.
    fn places(&self, frame: (usize, usize)) -> Vec<Place> {
        let mut out: Vec<Place> = Vec::new();
        let (mut x, mut y) = self.at;
        let deepest = self.levels().len() - 1;
        for (level, nodes) in self.levels().iter().enumerate() {
            let width = nodes.iter().map(|n| n.width()).max().unwrap_or(1) + 2;
            if level > 0 {
                let from = self.path[level - 1];
                let above = &out[level - 1];
                x = above.x + above.width;
                y = above.y + from.saturating_sub(above.first);
            }
            // Kept on the frame, moved left and up rather than cut off.
            let x0 = x.min(frame.0.saturating_sub(width));
            let y0 = y.min(frame.1.saturating_sub(nodes.len().min(frame.1)));
            let count = nodes.len().min(frame.1.saturating_sub(y0)).max(1);
            // How far it is scrolled, kept as it is moved, and never past
            // the end.
            let _ = deepest;
            let first = self.firsts.get(level).copied().unwrap_or(0).min(nodes.len().saturating_sub(count));
            out.push(Place { x: x0, y: y0, width, first, count });
            x = x0;
            y = y0;
        }
        out
    }

    /// How many lines the panel of a level shows.
    fn shown(&self, frame: (usize, usize), level: usize) -> usize {
        self.places(frame).get(level).map_or(1, |p| p.count)
    }

    /// The item at a cell of the frame, as the panels lie: which level and
    /// which of its lines, or none for a cell outside every panel.
    fn at_cell(&self, frame: (usize, usize), x: usize, y: usize) -> Option<(usize, usize)> {
        for (level, place) in self.places(frame).into_iter().enumerate().rev() {
            if x >= place.x && x < place.x + place.width && y >= place.y && y < place.y + place.count {
                return Some((level, place.first + y - place.y));
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
            .map(|(level, place)| {
                let rows = levels[level]
                    .iter()
                    .enumerate()
                    .skip(place.first)
                    .take(place.count)
                    .map(|(i, node)| {
                        let here = level == deepest && i == menu.cursor || level < deepest && menu.path[level] == i;
                        MenuRow {
                            text: format!(" {} ", node.text(place.width - 2)),
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
                MenuPanel { x: place.x, y: place.y, width: place.width, rows }
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
        let open = OpenMenu { nodes, path: Vec::new(), cursor, firsts: vec![0], at, frame, helped: false, bar: None };
        // A menu opened while another is (from a timer, say) gives the
        // outer one back when it closes, as each of Emacs's keeps its own
        // state on the stack.
        let outer = self.menu.replace(open);
        let answer = self.walk_menu();
        self.menu = outer;
        match answer {
            Ok(Outcome::Chosen(value)) => Ok(value),
            Ok(_) if by_mouse => Ok(Value::Null),
            // A menu a key opened quits when it is left, as menu.c's does.
            Ok(_) => Err(Error::signal("quit", "Quit", Vec::new())),
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
    fn walk_menu(&mut self) -> Result<Outcome> {
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

    fn menu_keys(&mut self, map: KeymapId) -> Result<Outcome> {
        let frame = self.menu.as_ref().map(|m| m.frame);
        loop {
            // One event at a time, as read_menu_command reads one: ESC is
            // itself here rather than a prefix, and C-g leaves the menu
            // as `keyboard-quit` does in Emacs's navigation map.
            let typed = match self.read_key_event(ReadKind::Key, "", None) {
                Ok(Some(typed)) => typed,
                Ok(None) => return Ok(Outcome::Left),
                Err(e) if e.is("quit") => return Ok(Outcome::Left),
                Err(e) => return Err(e),
            };
            // Input that switched frames under the menu's feet leaves it,
            // as read_menu_input does: its place and faces are no longer
            // the ones it was laid out for.
            if frame != Some(self.selected_frame()) {
                return Ok(Outcome::Left);
            }
            let keys = Key::parse_seq(&typed);
            let what = match keys.as_ref().map(|keys| self.keymaps().lookup(map, keys)) {
                Some(crate::keymap::Lookup::Command(name)) => name,
                // A key the navigation map does not bind is ignored and
                // the menu stays up, as read_menu_input ignores one.
                _ => continue,
            };
            match what.as_str() {
                "menu-exit" => return Ok(Outcome::Left),
                "menu-next-item" => self.menu_move(1),
                "menu-prev-item" => self.menu_move(-1),
                "menu-next-menu" => {
                    if let Some(step) = self.menu_bar_step(1) {
                        return Ok(step);
                    }
                    self.menu_open_submenu();
                }
                "menu-prev-menu" => {
                    if let Some(step) = self.menu_bar_step(-1) {
                        return Ok(step);
                    }
                    self.menu_close_submenu();
                }
                "menu-select" => {
                    if let Some(answer) = self.menu_choose() {
                        return Ok(Outcome::Chosen(answer));
                    }
                }
                "menu-mouse-movement" => self.menu_follow_pointer(),
                "menu-mouse-select" => {
                    // A click away from the menu leaves it, as clicking
                    // outside a pop-up menu does.
                    if !self.menu_point_at_pointer() {
                        return Ok(Outcome::Left);
                    }
                    if let Some(answer) = self.menu_choose() {
                        return Ok(Outcome::Chosen(answer));
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
        self.menu_scroll_to_cursor();
    }

    /// Scrolls the panel the cursor is in so that it shows, as term.c
    /// scrolls by `first_item` when the cursor reaches an edge.
    fn menu_scroll_to_cursor(&mut self) {
        let cells = self.frame_cells();
        let Some(menu) = self.menu.as_ref() else { return };
        let level = menu.path.len();
        let (cursor, count) = (menu.cursor, menu.shown(cells, level));
        let first = menu.firsts.get(level).copied().unwrap_or(0);
        let moved = if cursor < first {
            cursor
        } else if cursor >= first + count {
            cursor + 1 - count
        } else {
            first
        };
        if let Some(menu) = self.menu.as_mut()
            && let Some(slot) = menu.firsts.get_mut(level)
        {
            *slot = moved;
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
        menu.firsts.push(0);
        true
    }

    /// Closes the innermost submenu, leaving the cursor on the item that
    /// opened it.
    fn menu_close_submenu(&mut self) {
        let Some(menu) = self.menu.as_mut() else { return };
        if let Some(at) = menu.path.pop() {
            menu.cursor = at;
            menu.firsts.truncate(menu.path.len() + 1);
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
        menu.firsts.truncate(level + 1);
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
            let separator = item.label.starts_with("--");
            out.push(Node {
                label: item.label.clone(),
                keys,
                value: None,
                enabled: enabled && !matches!(binding, Binding::Nil) && !separator,
                title: separator,
                separator,
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
        let Ok(filtered) = self.funcall(filter, &[given]) else { return Ok(binding.clone()) };
        Ok(match filtered {
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
            // A property that fails counts as nil, as
            // menu_item_eval_property catches an error and gives nil.
            Value::Function(_) => Ok(self.funcall(value, &[]).map(|v| v.is_true()).unwrap_or(false)),
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

/// One menu of a frame's menu bar, as a front end draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct MenuBarItem {
    pub label: String,
    /// Where its label starts, in frame columns.
    pub column: usize,
    /// How many columns it takes, the space around the label included.
    pub width: usize,
    pub enabled: bool,
    /// How it is drawn, from the menu faces; set when the frame is
    /// described, as a front end draws from that.
    pub style: crate::faces::Style,
}

/// How many columns of space go each side of a menu bar's label.
const BAR_PAD: usize = 1;

impl Editor {
    /// How many lines a frame's menu bar takes, from its `menu-bar-lines`:
    /// none or one. Unlike Emacs, E8 shows no menu bar until
    /// `menu-bar-mode` asks for one, which docs/differences.md records.
    pub fn menu_bar_lines(&self, frame: crate::window::FrameId) -> usize {
        match self.frame_parameter(frame, "menu-bar-lines") {
            Some(Value::Number(n)) if n >= 1.0 => 1,
            _ => 0,
        }
    }

    /// A frame's menu bar as the last redisplay laid it out, if it shows one.
    pub fn menu_bar(&self, frame: crate::window::FrameId) -> Option<&[MenuBarItem]> {
        self.menu_bars.get(&frame).map(Vec::as_slice)
    }

    /// Lays every frame's menu bar out again, as redisplay updates
    /// Emacs's: `menu-bar-update-hook` once, as xdisp.c's
    /// `update_menu_bar` runs it once for a redisplay, then each frame's
    /// bar from the `<menu-bar>` bindings of the keymaps its own window's
    /// buffer uses.
    pub(crate) fn update_menu_bars(&mut self) {
        let frames: Vec<crate::window::FrameId> = self.frame_list().into_iter().filter(|f| self.menu_bar_lines(*f) > 0).collect();
        self.menu_bars.retain(|frame, _| frames.contains(frame));
        if frames.is_empty() {
            return;
        }
        // Called again while it runs, as a hook that redisplays would,
        // it does nothing, as update_menu_bar does while
        // inhibit-menubar-update is set.
        if self.updating_menu_bar {
            return;
        }
        self.updating_menu_bar = true;
        let _ = self.run_hooks("menu-bar-update-hook");
        for frame in frames {
            let items = self.frame_menu_bar(frame);
            self.menu_bars.insert(frame, items);
        }
        self.updating_menu_bar = false;
    }

    /// One frame's menu bar, laid out with its own window's buffer
    /// current, as `update_menu_bar` makes it current for each frame.
    fn frame_menu_bar(&mut self, frame: crate::window::FrameId) -> Vec<MenuBarItem> {
        let name = self.frame_selected_window(frame).and_then(|w| self.window_buffer_name(w)).map(str::to_string);
        let index = name.and_then(|name| self.find_buffer(&name));
        let nodes = match index {
            Some(index) => self.with_current_buffer(index, Editor::menu_bar_nodes),
            None => self.menu_bar_nodes(),
        };
        // A menu bar that cannot be built shows nothing, as Emacs
        // inhibits errors while it builds one.
        nodes.as_deref().map(bar_items).unwrap_or_default()
    }

    /// The menus of the menu bar, each with its items below it: the
    /// `<menu-bar>` bindings of every keymap in use, the global map's
    /// first and the most local map's last, each menu listed where it was
    /// first seen but defined by the most local map that has it, as
    /// keyboard.c's `menu_bar_items` gathers them; those
    /// `menu-bar-final-items` names go to the end.
    pub(crate) fn menu_bar_nodes(&mut self) -> Result<Vec<Node>> {
        let bar = Key::parse("<menu-bar>").expect("<menu-bar> parses");
        let mut maps = self.current_active_maps();
        maps.reverse();
        let mut out: Vec<Node> = Vec::new();
        for map in maps {
            let Some(Binding::Keymap(menu)) = self.keymaps().binding_of(map, &[bar]) else { continue };
            for mut node in self.keymap_nodes(menu, &[bar], 0)? {
                match out.iter().position(|n| n.keys == node.keys) {
                    // Both maps' items show, the more local map's first,
                    // as keyboard.c's menu_bar_item keeps the keymaps of
                    // both under the key it already has.
                    Some(i) => {
                        if let (Some(theirs), Some(ours)) = (out[i].children.as_ref(), node.children.as_mut()) {
                            for old in theirs {
                                if !ours.iter().any(|n| n.keys == old.keys) {
                                    ours.push(old.clone());
                                }
                            }
                        }
                        out[i] = node;
                    }
                    None => out.push(node),
                }
            }
        }
        let final_items = self.variable("menu-bar-final-items").map(last_names).unwrap_or_default();
        for name in final_items {
            let key = Key::parse(&format!("<{name}>"));
            if let Some(i) = key.and_then(|key| out.iter().position(|n| n.keys.last() == Some(&key))) {
                let node = out.remove(i);
                out.push(node);
            }
        }
        Ok(out)
    }

    /// Opens the menu bar's menu `index`, walks it with the keys, and runs
    /// what was chosen, as clicking a menu bar does. Moving left and right
    /// at its top level goes to the next menu, as Emacs's menus do.
    pub fn menu_bar_open(&mut self, index: usize) -> Result<()> {
        let frame = self.selected_frame();
        if self.menu_bar_lines(frame) == 0 {
            return Err(Error::new("No menu bar"));
        }
        let nodes = self.menu_bar_nodes()?;
        let items = bar_items(&nodes);
        if items.is_empty() {
            return Err(Error::new("Empty menu"));
        }
        // What is drawn is what the menu was opened from.
        self.menu_bars.insert(frame, items.clone());
        let mut at = index.min(items.len() - 1);
        loop {
            let Some(children) = nodes.get(at).and_then(|n| n.children.clone()) else { return Ok(()) };
            if children.is_empty() {
                return Ok(());
            }
            let cursor = children.iter().position(|n| !n.title).unwrap_or(0);
            // Below the bar, at the menu's own column.
            let open = OpenMenu { nodes: children, path: Vec::new(), cursor, firsts: vec![0], at: (items[at].column, 0), frame, helped: false, bar: Some(at) };
            let outer = self.menu.replace(open);
            let answer = self.walk_menu();
            self.menu = outer;
            match answer? {
                Outcome::Chosen(value) => return self.run_menu_choice(&value),
                Outcome::Left => return Ok(()),
                Outcome::Switch(by) => at = (at as isize + by).rem_euclid(items.len() as isize) as usize,
            }
        }
    }

    /// Opens the menu of the menu bar at a column of a frame, as clicking
    /// the menu bar does.
    pub fn menu_bar_mouse(&mut self, frame: crate::window::FrameId, column: usize) -> Result<()> {
        self.select_frame(frame)?;
        let at = self
            .menu_bar(frame)
            .and_then(|items| items.iter().position(|i| column >= i.column && column < i.column + i.width));
        match at {
            Some(at) => self.menu_bar_open(at),
            None => Ok(()),
        }
    }

    /// Runs the command the keys a menu gave back are bound to, as the
    /// command loop runs the one the menu's event names.
    fn run_menu_choice(&mut self, keys: &Value) -> Result<()> {
        let Some(keys) = keys.as_str().and_then(Key::parse_seq) else { return Ok(()) };
        match self.lookup(&keys) {
            crate::keymap::Lookup::Command(name) => self.call_interactively(&name),
            _ => Ok(()),
        }
    }

    /// Moving left or right at a menu bar menu's top level goes to the
    /// next or previous menu; inside a submenu it does not.
    fn menu_bar_step(&mut self, by: isize) -> Option<Outcome> {
        let menu = self.menu.as_ref()?;
        (menu.path.is_empty() && menu.bar.is_some()).then_some(Outcome::Switch(by))
    }
}

/// Where each menu of the bar goes, laid out left to right.
fn bar_items(nodes: &[Node]) -> Vec<MenuBarItem> {
    let mut column = 0;
    nodes
        .iter()
        .filter(|node| !node.title)
        .map(|node| {
            let width = node.label.chars().count() + 2 * BAR_PAD;
            let item = MenuBarItem { label: node.label.clone(), column, width, enabled: node.enabled, style: Default::default() };
            column += width;
            item
        })
        .collect()
}

/// The names `menu-bar-final-items` holds, which go to the end of the bar.
fn last_names(value: Value) -> Vec<String> {
    match value {
        Value::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Value::Str(name) | Value::Symbol(name) => vec![name],
        _ => Vec::new(),
    }
}
