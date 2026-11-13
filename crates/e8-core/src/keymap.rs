//! Keymaps as values, as Emacs has them: a keymap binds keys to commands
//! or to other keymaps, which several keymaps can share as their prefix
//! map, as `C-x 4` is `ctl-x-4-map` wherever it is bound, and inherits the
//! bindings of a parent. Keymaps live in the editor's [`Keymaps`] and are
//! passed around by [`KeymapId`]; a named keymap is a variable whose value
//! is one, as `global-map` and `org-mode-map` are.

use std::collections::BTreeMap;

use crate::key::Key;

/// A keymap, as a value can hold one.
pub type KeymapId = usize;

/// What a key is bound to in a keymap.
#[derive(Clone, Debug, PartialEq)]
pub enum Binding {
    Command(String),
    /// A key sequence, as an Emacs string or vector binding: a keyboard
    /// macro in an ordinary keymap, and what the keys become in a
    /// translation map such as `key-translation-map`.
    Keys(Vec<Key>),
    /// A prefix key: the keys after it are looked up in that keymap.
    Keymap(KeymapId),
    /// A menu item: a label, what choosing it runs, and the rest of what
    /// Emacs's `(menu-item ...)` says about it.
    Menu(Box<MenuItem>),
    /// Nothing, hiding the parents' binding, as `(define-key map key nil)`.
    Nil,
}

impl Binding {
    /// What a binding runs, a menu item's item looked through, as Emacs
    /// looks through a `menu-item` to the real definition.
    pub fn definition(&self) -> &Binding {
        match self {
            Binding::Menu(item) => item.binding.definition(),
            other => other,
        }
    }
}

/// What kind of button a menu item shows, as a `menu-item`'s `:button` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonKind {
    /// One of a set, shown `(*)` when on, as `:radio` is.
    Radio,
    /// On or off by itself, shown `[X]` when on, as `:toggle` is.
    Toggle,
}

/// A menu item, as Emacs's `(KEY menu-item LABEL DEFINITION . PROPERTIES)`.
/// Where Emacs holds a Lisp form to evaluate, E8 holds a value, which may
/// be a function to call, as a variable's value may be one.
#[derive(Clone, Debug, PartialEq)]
pub struct MenuItem {
    pub label: String,
    /// What choosing it runs: a command, a submenu keymap, or `Nil` for a
    /// line that cannot be chosen.
    pub binding: Box<Binding>,
    /// When it was bound. Items show in that order, as a menu is written.
    pub order: u64,
    /// Whether it can be chosen, as `:enable`.
    pub enable: Option<crate::variables::Value>,
    /// Whether it is in the menu at all, as `:visible`.
    pub visible: Option<crate::variables::Value>,
    /// What it does, for the echo area, as `:help`.
    pub help: Option<String>,
    /// The keys shown beside it, as `:keys`; without one, the keys that
    /// run its command are looked up, as Emacs looks them up.
    pub keys: Option<String>,
    /// Whether it is a radio or toggle button, and what says it is on.
    pub button: Option<(ButtonKind, crate::variables::Value)>,
    /// Given the submenu it is bound to, gives the one to show, as `:filter`.
    pub filter: Option<crate::variables::Value>,
}

impl MenuItem {
    /// An item with a label and what it runs, and nothing else said.
    pub fn new(label: &str, binding: Binding) -> MenuItem {
        MenuItem {
            label: label.to_string(),
            binding: Box::new(binding),
            order: 0,
            enable: None,
            visible: None,
            help: None,
            keys: None,
            button: None,
            filter: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Map {
    bindings: BTreeMap<Key, Binding>,
    /// What any single key with no binding of its own runs, as an Emacs
    /// keymap's `[t]` binding does.
    default: Option<String>,
    /// Commands that run in place of others when keys in any keymap name
    /// them, as an Emacs keymap's `[remap COMMAND]` bindings.
    remaps: BTreeMap<String, String>,
    parent: Option<KeymapId>,
}

/// The result of looking up a key sequence.
#[derive(Debug, PartialEq, Eq)]
pub enum Lookup {
    Command(String),
    /// Bound to a key sequence: a keyboard macro, or a translation.
    Keys(Vec<Key>),
    /// The sequence so far is a prefix; more keys are needed.
    Prefix,
    Unbound,
}

/// How far parents and prefix maps are followed, so a loop ends.
const DEPTH: usize = 32;

/// Every keymap there is. Keymaps are few and never freed.
#[derive(Debug, Default)]
pub struct Keymaps {
    maps: Vec<Map>,
    /// How many menu items have been bound, which orders them.
    next_order: u64,
}

impl Keymaps {
    /// A new empty keymap, as Emacs's `make-sparse-keymap`.
    pub fn make(&mut self, parent: Option<KeymapId>) -> KeymapId {
        self.maps.push(Map { parent, ..Map::default() });
        self.maps.len() - 1
    }

    pub fn parent(&self, map: KeymapId) -> Option<KeymapId> {
        self.maps[map].parent
    }

    /// A copy of a keymap, as Emacs's `copy-keymap`: its bindings, default,
    /// remappings and parent, with the prefix maps it binds copied in turn,
    /// but for those `shared` says to keep, as Emacs keeps a prefix command's.
    pub fn copy(&mut self, map: KeymapId, shared: &dyn Fn(KeymapId) -> bool) -> KeymapId {
        let mut copied = Vec::new();
        self.copy_into(map, shared, &mut copied)
    }

    fn copy_into(&mut self, map: KeymapId, shared: &dyn Fn(KeymapId) -> bool, copied: &mut Vec<(KeymapId, KeymapId)>) -> KeymapId {
        if let Some(&(_, new)) = copied.iter().find(|(old, _)| *old == map) {
            return new;
        }
        let original = self.maps[map].clone();
        self.maps.push(Map { bindings: BTreeMap::new(), ..original.clone() });
        let new = self.maps.len() - 1;
        copied.push((map, new));
        for (key, binding) in original.bindings {
            let binding = match binding {
                Binding::Keymap(sub) if !shared(sub) => Binding::Keymap(self.copy_into(sub, shared, copied)),
                Binding::Menu(item) => {
                    let mut item = item;
                    if let Binding::Keymap(sub) = *item.binding
                        && !shared(sub)
                    {
                        item.binding = Box::new(Binding::Keymap(self.copy_into(sub, shared, copied)));
                    }
                    Binding::Menu(item)
                }
                other => other,
            };
            self.maps[new].bindings.insert(key, binding);
        }
        new
    }

    /// The keymaps reachable from a keymap through its prefix keys, with the
    /// keys that reach each, the keymap itself first under no keys, in the
    /// order a breadth-first walk finds them, as Emacs's `accessible-keymaps`;
    /// with a prefix, only those under it. Under a prefix key both a keymap
    /// and its parent bind to keymaps, the keys of both are followed, as
    /// lookups merge them; each is listed by the first keymap the keys reach.
    pub fn accessible(&self, map: KeymapId, prefix: &[Key]) -> Vec<(Vec<Key>, KeymapId)> {
        let Some(first) = self.prefix_maps(map, prefix) else { return Vec::new() };
        let mut out = vec![(prefix.to_vec(), first.clone())];
        let mut i = 0;
        while i < out.len() && out.len() < 4096 {
            let (keys, maps) = out[i].clone();
            let mut next: BTreeMap<Key, Vec<KeymapId>> = BTreeMap::new();
            for m in maps {
                for x in self.chain(m) {
                    for (key, binding) in &x.bindings {
                        if let Binding::Keymap(sub) = binding {
                            next.entry(*key).or_default().push(*sub);
                        }
                    }
                }
            }
            for (key, subs) in next {
                if !out.iter().any(|(_, seen)| seen[0] == subs[0]) {
                    let mut k = keys.clone();
                    k.push(key);
                    out.push((k, subs));
                }
            }
            i += 1;
        }
        out.into_iter().map(|(k, maps)| (k, maps[0])).collect()
    }

    /// The keymaps a prefix key sequence leads to, merged as a lookup
    /// merges them, the first map's first; `None` unless it is a prefix.
    fn prefix_maps(&self, map: KeymapId, keys: &[Key]) -> Option<Vec<KeymapId>> {
        let mut maps = vec![map];
        for key in keys {
            let found = self.bindings_of_key(&maps, key);
            let mut next = Vec::new();
            for b in &found {
                let Binding::Keymap(m) = b else { break };
                if !next.contains(m) && next.len() < DEPTH {
                    next.push(*m);
                }
            }
            if next.is_empty() {
                return None;
            }
            maps = next;
        }
        Some(maps)
    }

    /// Makes `map` inherit `parent`'s bindings, as `set-keymap-parent`.
    pub fn set_parent(&mut self, map: KeymapId, parent: Option<KeymapId>) {
        self.maps[map].parent = parent;
    }

    /// The map and its parents, nearest first.
    fn chain(&self, map: KeymapId) -> impl Iterator<Item = &Map> {
        std::iter::successors(Some(map), |&m| self.maps[m].parent).take(DEPTH).map(|m| &self.maps[m])
    }

    /// What one key is bound to in each of some maps, in order, through
    /// each map's parents: the prefix maps found until a command or nil;
    /// or the command or nil it is bound to, which hides the bindings after
    /// it, as a child's prefix map inherits its parent's in Emacs; or, with
    /// no binding at all, the map's default.
    fn bindings_of_key(&self, maps: &[KeymapId], key: &Key) -> Vec<Binding> {
        let mut out = Vec::new();
        for &m in maps {
            let mut bound = false;
            for x in self.chain(m) {
                // A menu item is looked through to what it runs, as
                // keymap.c's get_keyelt looks through one.
                match x.bindings.get(key).map(Binding::definition) {
                    Some(Binding::Keymap(k)) => out.push(Binding::Keymap(*k)),
                    Some(b @ (Binding::Command(_) | Binding::Keys(_))) => {
                        if !bound {
                            out.push(b.clone());
                        }
                        bound = true;
                        break;
                    }
                    Some(Binding::Nil) => {
                        if !bound {
                            out.push(Binding::Nil);
                        }
                        bound = true;
                        break;
                    }
                    // A menu item is looked through, so one is never left here.
                    Some(Binding::Menu(_)) | None => continue,
                }
                bound = true;
            }
            if !bound && let Some(default) = self.chain(m).find_map(|x| x.default.clone()) {
                out.push(Binding::Command(default));
            }
        }
        out
    }

    /// Binds a key sequence in a keymap, as Emacs's `define-key`, replacing
    /// any binding that was in the way. A prefix key with no keymap of its
    /// own in `map` gets one.
    pub fn bind(&mut self, map: KeymapId, keys: &[Key], binding: Binding) {
        let (last, prefix) = keys.split_last().expect("empty key sequence");
        let mut map = map;
        for key in prefix {
            map = match self.maps[map].bindings.get(key).map(Binding::definition) {
                Some(Binding::Keymap(m)) => *m,
                _ => {
                    let new = self.make(None);
                    self.maps[map].bindings.insert(*key, Binding::Keymap(new));
                    new
                }
            };
        }
        self.maps[map].bindings.insert(*last, binding);
    }

    /// Binds a menu item, as Emacs binds `(menu-item LABEL ...)`. Items
    /// show in the order they were bound; one that replaces another keeps
    /// its place, as `define-key` replaces a binding where it stands.
    pub fn bind_menu(&mut self, map: KeymapId, keys: &[Key], mut item: MenuItem) {
        item.order = match self.binding_at(map, keys) {
            Some(Binding::Menu(old)) => old.order,
            _ => {
                self.next_order += 1;
                self.next_order
            }
        };
        self.bind(map, keys, Binding::Menu(Box::new(item)));
    }

    /// What a keymap itself binds, its parents' bindings left out.
    pub fn own_bindings(&self, map: KeymapId) -> Vec<(Key, Binding)> {
        self.maps[map].bindings.iter().map(|(key, binding)| (*key, binding.clone())).collect()
    }

    /// What a keymap itself binds a key sequence to, menu items not
    /// looked through and its parents not asked.
    pub fn binding_at(&self, map: KeymapId, keys: &[Key]) -> Option<&Binding> {
        let (last, prefix) = keys.split_last()?;
        let mut map = map;
        for key in prefix {
            match self.maps[map].bindings.get(key).map(Binding::definition) {
                Some(Binding::Keymap(m)) => map = *m,
                _ => return None,
            }
        }
        self.maps[map].bindings.get(last)
    }

    /// Takes a key sequence's binding out of a keymap, so its parents' shows.
    pub fn unbind(&mut self, map: KeymapId, keys: &[Key]) {
        let (last, prefix) = keys.split_last().expect("empty key sequence");
        let mut map = map;
        for key in prefix {
            map = match self.maps[map].bindings.get(key).map(Binding::definition) {
                Some(Binding::Keymap(m)) => *m,
                _ => return,
            };
        }
        self.maps[map].bindings.remove(last);
    }

    /// Binds a sequence written in Emacs notation, such as `C-x C-f`, to a
    /// command. Panics on a malformed sequence, since bindings are written
    /// by programmers.
    pub fn bind_str(&mut self, map: KeymapId, seq: &str, command: &str) {
        let keys = Key::parse_seq(seq).unwrap_or_else(|| panic!("bad key sequence {seq:?}"));
        self.bind(map, &keys, Binding::Command(command.to_string()));
    }

    /// What a key sequence is bound to, as Emacs's `lookup-key`: a
    /// command, a prefix map, or nothing. Where a keymap and its parent
    /// both bind a prefix key to keymaps, the keys after it are looked up
    /// in the keymap's first and then the parent's, as Emacs composes them.
    pub fn binding_of(&self, map: KeymapId, keys: &[Key]) -> Option<Binding> {
        let mut maps = vec![map];
        for (i, key) in keys.iter().enumerate() {
            let last = i + 1 == keys.len();
            let found = self.bindings_of_key(&maps, key);
            match found.first() {
                Some(Binding::Keymap(m)) if last => return Some(Binding::Keymap(*m)),
                // The prefix maps up to the first binding that is not one are
                // merged, the first map's first.
                Some(Binding::Keymap(_)) => {
                    maps.clear();
                    for b in &found {
                        let Binding::Keymap(m) = b else { break };
                        if !maps.contains(m) && maps.len() < DEPTH {
                            maps.push(*m);
                        }
                    }
                }
                Some(Binding::Command(c)) if last => return Some(Binding::Command(c.clone())),
                Some(Binding::Keys(k)) if last => return Some(Binding::Keys(k.clone())),
                _ => return None,
            }
        }
        None
    }

    /// The keys a keymap and its parents bind directly, each to what it
    /// runs: the keymap's own binding of a key winning over its parents'.
    pub fn direct_bindings(&self, map: KeymapId) -> Vec<(Key, Binding)> {
        let mut out: BTreeMap<Key, Binding> = BTreeMap::new();
        for m in self.chain(map) {
            for (key, binding) in &m.bindings {
                out.entry(*key).or_insert_with(|| binding.clone());
            }
        }
        out.into_iter().collect()
    }

    pub fn lookup(&self, map: KeymapId, keys: &[Key]) -> Lookup {
        match self.binding_of(map, keys).as_ref().map(Binding::definition) {
            Some(Binding::Command(c)) => Lookup::Command(c.clone()),
            Some(Binding::Keys(k)) => Lookup::Keys(k.clone()),
            Some(Binding::Keymap(_)) => Lookup::Prefix,
            Some(Binding::Menu(_) | Binding::Nil) | None => Lookup::Unbound,
        }
    }

    /// Makes `to` run wherever keys run `from` while this keymap is active,
    /// or stops that with `None`.
    pub fn remap(&mut self, map: KeymapId, from: &str, to: Option<&str>) {
        let remaps = &mut self.maps[map].remaps;
        match to {
            Some(to) => remaps.insert(from.to_string(), to.to_string()),
            None => remaps.remove(from),
        };
    }

    /// The command that runs in place of `command`, if this keymap or its parents remap it.
    pub fn remapped(&self, map: KeymapId, command: &str) -> Option<&str> {
        self.chain(map).find_map(|m| m.remaps.get(command)).map(String::as_str)
    }

    /// Sets or removes the command for keys with no binding of their own.
    pub fn set_default(&mut self, map: KeymapId, command: Option<&str>) {
        self.maps[map].default = command.map(str::to_string);
    }

    /// Every binding of a keymap as (key sequence, command name), in key
    /// order, through its prefix maps; not its parents'.
    pub fn bindings(&self, map: KeymapId) -> Vec<(Vec<Key>, String)> {
        let mut out = Vec::new();
        self.collect(map, &mut Vec::new(), &mut vec![map], &mut out);
        out
    }

    /// `path` is the maps the prefix went through, so a map that is its
    /// own prefix map, or one above it, is not listed again under itself.
    fn collect(&self, map: KeymapId, prefix: &mut Vec<Key>, path: &mut Vec<KeymapId>, out: &mut Vec<(Vec<Key>, String)>) {
        for (key, binding) in &self.maps[map].bindings {
            prefix.push(*key);
            match binding {
                Binding::Command(c) => out.push((prefix.clone(), c.clone())),
                // As describe-bindings lists a string or vector binding.
                Binding::Keys(_) => out.push((prefix.clone(), "Keyboard Macro".to_string())),
                Binding::Keymap(m) if !path.contains(m) && path.len() < DEPTH => {
                    path.push(*m);
                    self.collect(*m, prefix, path, out);
                    path.pop();
                }
                Binding::Keymap(_) | Binding::Menu(_) | Binding::Nil => {}
            }
            prefix.pop();
        }
    }

    /// The key sequences bound to a command in a keymap and its parents,
    /// those that the keymap's own bindings shadow left out.
    pub fn keys_for(&self, map: KeymapId, command: &str) -> Vec<Vec<Key>> {
        let mut keys = Vec::new();
        for m in std::iter::successors(Some(map), |&m| self.maps[m].parent).take(DEPTH) {
            for (k, c) in self.bindings(m) {
                if c == command && !keys.contains(&k) && self.lookup(map, &k) == Lookup::Command(c) {
                    keys.push(k);
                }
            }
        }
        keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(s: &str) -> Vec<Key> {
        Key::parse_seq(s).unwrap()
    }

    #[test]
    fn looks_up_prefix_sequences() {
        let mut maps = Keymaps::default();
        let map = maps.make(None);
        maps.bind_str(map, "C-x C-f", "find-file");
        maps.bind_str(map, "C-f", "forward-char");
        assert_eq!(maps.lookup(map, &keys("C-x")), Lookup::Prefix);
        assert_eq!(maps.lookup(map, &keys("C-x C-f")), Lookup::Command("find-file".into()));
        assert_eq!(maps.lookup(map, &keys("C-x C-z")), Lookup::Unbound);
        assert_eq!(maps.lookup(map, &keys("C-f C-f")), Lookup::Unbound);
        assert_eq!(maps.keys_for(map, "find-file"), vec![keys("C-x C-f")]);
    }

    #[test]
    fn a_prefix_map_is_shared_and_a_child_inherits_its_parent_after_a_prefix() {
        let mut maps = Keymaps::default();
        let (global, ctl_x_4, mode) = (maps.make(None), maps.make(None), maps.make(None));
        maps.bind(global, &keys("C-x 4"), Binding::Keymap(ctl_x_4));
        maps.bind(mode, &keys("C-c 4"), Binding::Keymap(ctl_x_4));
        maps.bind_str(ctl_x_4, "f", "find-file-other-window");
        assert_eq!(maps.lookup(global, &keys("C-x 4 f")), Lookup::Command("find-file-other-window".into()));
        assert_eq!(maps.lookup(mode, &keys("C-c 4 f")), Lookup::Command("find-file-other-window".into()));
        // A child's C-x map, made by binding under it, is merged with the
        // parent's, even what the parent binds later.
        let child = maps.make(Some(global));
        maps.bind_str(child, "C-x C-q", "child-command");
        maps.bind_str(global, "C-x C-s", "save-buffer");
        assert_eq!(maps.lookup(child, &keys("C-x C-s")), Lookup::Command("save-buffer".into()));
        assert_eq!(maps.lookup(child, &keys("C-x 4 f")), Lookup::Command("find-file-other-window".into()));
        assert_eq!(maps.lookup(global, &keys("C-x C-q")), Lookup::Unbound);
        // A map that is its own prefix map is listed once.
        maps.bind(ctl_x_4, &keys("4"), Binding::Keymap(ctl_x_4));
        maps.bind(ctl_x_4, &keys("5"), Binding::Keymap(ctl_x_4));
        assert_eq!(maps.bindings(ctl_x_4).len(), 1);
        // Nil hides the parent's binding; a child's prefix map's default
        // comes before the parent's binding after the prefix.
        maps.bind(child, &keys("C-x C-s"), Binding::Nil);
        assert_eq!(maps.lookup(child, &keys("C-x C-s")), Lookup::Unbound);
        let child_cx = match maps.binding_of(child, &keys("C-x")) {
            Some(Binding::Keymap(m)) => m,
            other => panic!("{other:?}"),
        };
        maps.set_default(child_cx, Some("child-default"));
        assert_eq!(maps.lookup(child, &keys("C-x 4")), Lookup::Command("child-default".into()));
    }
}
