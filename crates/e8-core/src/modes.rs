//! Named keymaps and modes. A buffer has one major mode, recorded in the
//! buffer-local variables `major-mode` and `mode-name` with its keymap as the
//! buffer's local map, and any number of minor modes, each turned on by a
//! variable of its own name. The commands that turn modes on are written in
//! TypeScript; this is the part Emacs does in C.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::Key;
use crate::keymap::{Binding, KeymapId, Keymaps, Lookup};
use crate::variables::{Value, Variable};

/// A minor mode, for key lookup and the mode line.
#[derive(Clone, Debug)]
pub struct MinorMode {
    /// Also the name of the variable that says whether it is on.
    pub name: String,
    /// What the mode line shows while it is on, such as " Ovwrt". Empty for nothing.
    pub lighter: String,
    pub keymap: Option<String>,
    /// Whether it applies to every buffer rather than one at a time.
    pub global: bool,
}

/// The keymaps the editor itself has, which scripts can name.
pub(crate) const GLOBAL_MAP: &str = "global-map";
pub(crate) const MINIBUFFER_MAP: &str = "minibuffer-local-map";

impl Editor {
    /// The editor's keymaps, to bind keys in by [`KeymapId`].
    pub fn keymaps(&self) -> &Keymaps {
        &self.keymaps
    }

    pub fn keymaps_mut(&mut self) -> &mut Keymaps {
        &mut self.keymaps
    }

    /// The global keymap, which applies everywhere, after all others.
    pub fn global_map(&self) -> KeymapId {
        self.global_map
    }

    /// Makes a keymap the global one, as Emacs's `use-global-map`.
    pub fn use_global_map(&mut self, keymap: &Value) -> Result<()> {
        self.global_map = self.keymap_of(keymap)?;
        Ok(())
    }

    /// The current buffer's local map, the major mode's, as Emacs's
    /// `current-local-map`: the one `use-local-map` gave it, behind any a
    /// minor mode's composing put in front.
    pub fn current_local_map(&self) -> Option<KeymapId> {
        self.buffer().local_map.last().copied()
    }

    /// A copy of a keymap, as Emacs's `copy-keymap`: the prefix maps it
    /// binds are copied too, but for those a variable names, as Emacs keeps
    /// a prefix command's, so `C-x 4` stays `ctl-x-4-map`.
    pub fn copy_keymap(&mut self, keymap: &Value) -> Result<KeymapId> {
        let map = self.keymap_of(keymap)?;
        let named: Vec<KeymapId> = self.keymap_names().iter().filter_map(|n| self.keymap_named(n)).collect();
        Ok(self.keymaps.copy(map, &|m| named.contains(&m)))
    }

    /// The keymaps of the minor modes on in the current buffer, in the order
    /// keys are looked up in them, as Emacs's `current-minor-mode-maps`.
    pub fn current_minor_mode_maps(&self) -> Vec<KeymapId> {
        self.minor_mode_maps().into_iter().map(|(_, m)| m).collect()
    }

    fn minor_mode_maps(&self) -> Vec<(String, KeymapId)> {
        let b = self.buffer();
        self.minor_modes
            .iter()
            .filter(|m| self.minor_mode_on(b, &m.name))
            .filter_map(|m| m.keymap.as_deref().and_then(|k| self.keymap_named(k)).map(|k| (m.name.clone(), k)))
            .collect()
    }

    /// The minor modes on whose keymaps bind a key sequence, each with what
    /// it is bound to there, in the order keys are looked up, as Emacs's
    /// `minor-mode-key-binding`.
    pub fn minor_mode_key_binding(&self, keys: &[Key]) -> Vec<(String, Binding)> {
        self.minor_mode_maps()
            .into_iter()
            .filter_map(|(mode, map)| match self.keymaps.binding_of(map, keys) {
                Some(Binding::Nil) | None => None,
                Some(b) => Some((mode, b)),
            })
            .collect()
    }

    /// The keymap a name holds: the global value of the variable of that
    /// name, as `org-mode-map` holds Org's.
    pub fn keymap_named(&self, name: &str) -> Option<KeymapId> {
        match self.default_value(name)? {
            Value::Keymap(id) => Some(id),
            _ => None,
        }
    }

    /// A keymap from a value: a keymap, or the name of a variable holding one.
    pub fn keymap_of(&self, value: &Value) -> Result<KeymapId> {
        match value {
            Value::Keymap(id) => Ok(*id),
            other => {
                let name = other.as_str().unwrap_or_default();
                self.keymap_named(name).ok_or_else(|| Error::new(format!("No such keymap: {other}")))
            }
        }
    }

    /// Defines a named keymap, a variable holding a new keymap, or changes
    /// the parent of the keymap the name holds, as Emacs's `defvar-keymap`.
    pub fn define_keymap(&mut self, name: &str, parent: Option<&str>) -> KeymapId {
        let parent = parent.and_then(|p| self.keymap_named(p));
        if let Some(id) = self.keymap_named(name) {
            self.keymaps.set_parent(id, parent);
            return id;
        }
        let id = self.keymaps.make(parent);
        self.define_variable(Variable::new(name, &format!("Keymap {name}."), Value::Keymap(id)));
        id
    }

    /// The names of variables that hold keymaps.
    pub fn keymap_names(&self) -> Vec<String> {
        self.variables().filter(|v| matches!(v.default, Value::Keymap(_))).map(|v| v.name.clone()).collect()
    }

    /// Binds a key sequence in a keymap, by its name or as a value, to a
    /// command, to a list of keys, or as a prefix key to a keymap, or to nil, which hides a
    /// parent's binding. `None` takes the binding out, as keymap-unset's REMOVE.
    pub fn define_key(&mut self, keymap: &Value, keys: &[Key], binding: Option<&Value>) -> Result<()> {
        let map = self.keymap_of(keymap)?;
        match binding {
            None => self.keymaps.unbind(map, keys),
            Some(Value::Null) => self.keymaps.bind(map, keys, Binding::Nil),
            Some(Value::Keymap(prefix)) => self.keymaps.bind(map, keys, Binding::Keymap(*prefix)),
            // A list of keys, as a vector binding in Emacs: a keyboard
            // macro, or in a translation map what the keys become.
            Some(Value::List(items)) => {
                let mut to = Vec::new();
                for item in items {
                    let text = item.as_str().ok_or_else(|| Error::new(format!("Not a key: {item}")))?;
                    // One character is that character, a space or a no-break space included.
                    let mut chars = text.chars();
                    match (chars.next(), chars.next()) {
                        (Some(c), None) => to.push(Key::new(crate::key::KeyCode::Char(c))),
                        _ => to.extend(Key::parse_seq(text).ok_or_else(|| Error::new(format!("Invalid key sequence: {text}")))?),
                    }
                }
                self.keymaps.bind(map, keys, Binding::Keys(to));
            }
            Some(command) => {
                let name = command.as_str().ok_or_else(|| Error::new(format!("Not a command or keymap: {command}")))?;
                self.keymaps.bind(map, keys, Binding::Command(name.to_string()));
            }
        }
        Ok(())
    }

    /// Binds a key sequence in a named keymap.
    pub fn bind_key_in(&mut self, keymap: &str, keys: &[Key], command: &str) -> Result<()> {
        self.define_key(&Value::Str(keymap.into()), keys, Some(&Value::Str(command.into())))
    }

    /// Makes a named keymap remap a command: wherever keys would run `from`
    /// while the keymap is active, `to` runs instead, as Emacs's
    /// `(define-key map [remap FROM] TO)`.
    pub fn remap_command(&mut self, keymap: &str, from: &str, to: Option<&str>) -> Result<()> {
        let map = self.keymap_of(&Value::Str(keymap.into()))?;
        self.keymaps.remap(map, from, to);
        Ok(())
    }

    /// The keymaps active now, in the order keys are looked up: a transient
    /// map, an overriding map, the minibuffer's while a prompt is open, the
    /// buffer's modes', and the global map, as Emacs's `current-active-maps`.
    pub fn current_active_maps(&self) -> Vec<KeymapId> {
        // In the minibuffer, its local map is minibuffer-local-map.
        let mut maps: Vec<KeymapId> = self.transient_map.into_iter().chain(self.overriding_map).collect();
        maps.extend(self.mode_keymaps());
        maps.push(self.global_map);
        maps
    }

    /// The keys that can follow `prefix` in the active keymaps, each with
    /// the command it runs or `None` for another prefix, the first map's
    /// binding of a key winning, in key order: what which-key lists.
    pub fn prefix_bindings(&self, prefix: &[Key]) -> Vec<(Key, Option<String>)> {
        let mut out: std::collections::BTreeMap<Key, Option<String>> = std::collections::BTreeMap::new();
        for map in self.current_active_maps() {
            let Some(crate::keymap::Binding::Keymap(sub)) = self.keymaps.binding_of(map, prefix) else { continue };
            for (key, binding) in self.keymaps.direct_bindings(sub) {
                let shown = match binding {
                    crate::keymap::Binding::Command(c) => Some(Some(c)),
                    crate::keymap::Binding::Keys(_) => Some(Some("Keyboard Macro".to_string())),
                    crate::keymap::Binding::Keymap(_) => Some(None),
                    crate::keymap::Binding::Nil => None,
                };
                // nil in an earlier map hides the key from later ones too.
                out.entry(key).or_insert_with(|| shown.clone().unwrap_or(Some(String::new())));
            }
        }
        out.into_iter().filter(|(_, c)| c.as_deref() != Some("")).collect()
    }

    /// The command that runs when keys run `command`: the first remapping of
    /// it in the active keymaps, in the order keys are looked up, or `None`.
    pub fn command_remapping(&self, command: &str) -> Option<String> {
        self.current_active_maps().into_iter().find_map(|m| self.keymaps.remapped(m, command).map(str::to_string))
    }

    /// Sets the command a named keymap runs for keys it does not bind.
    pub fn set_keymap_default(&mut self, keymap: &str, command: Option<&str>) -> Result<()> {
        let map = self.keymap_of(&Value::Str(keymap.into()))?;
        self.keymaps.set_default(map, command);
        Ok(())
    }

    /// Makes a keymap take precedence over every other but a transient
    /// map, or stops that with `None`, as Emacs's
    /// `overriding-terminal-local-map`. Incremental search uses it.
    pub fn set_overriding_map(&mut self, keymap: Option<&Value>) -> Result<()> {
        self.overriding_map = keymap.map(|k| self.keymap_of(k)).transpose()?;
        Ok(())
    }

    /// The overriding keymap, while there is one.
    pub fn overriding_map(&self) -> Option<KeymapId> {
        self.overriding_map
    }

    /// Looks keys up in a keymap and its parents.
    pub(crate) fn lookup_in(&self, map: KeymapId, keys: &[Key]) -> Lookup {
        self.keymaps.lookup(map, keys)
    }

    /// Makes a keymap the current buffer's local map, the major mode's
    /// keymap, as Emacs's `use-local-map` does.
    pub fn use_local_map(&mut self, keymap: Option<&Value>) -> Result<()> {
        let map = keymap.map(|k| self.keymap_of(k)).transpose()?;
        self.buffer_mut().local_map = map.into_iter().collect();
        Ok(())
    }

    /// Puts a keymap in front of the current buffer's local map, as
    /// Emacs's `(use-local-map (make-composed-keymap MAP (current-local-map)))`.
    pub fn compose_local_map(&mut self, keymap: &Value) -> Result<()> {
        let map = self.keymap_of(keymap)?;
        let maps = &mut self.buffer_mut().local_map;
        maps.retain(|m| *m != map);
        maps.insert(0, map);
        Ok(())
    }

    /// Registers a minor mode, replacing one with the same name. Modes
    /// registered later take precedence in key lookup, as in Emacs.
    pub fn register_minor_mode(&mut self, mode: MinorMode) {
        self.minor_modes.retain(|m| m.name != mode.name);
        self.minor_modes.insert(0, mode);
        self.update_minor_mode_alist();
    }

    pub fn minor_modes(&self) -> &[MinorMode] {
        &self.minor_modes
    }

    fn minor_mode_on(&self, b: &Buffer, name: &str) -> bool {
        self.variable_in(b, name).is_some_and(|v| v.is_true())
    }

    /// The minor modes that are on in the current buffer.
    pub fn enabled_minor_modes(&self) -> Vec<String> {
        let b = self.buffer();
        self.minor_modes
            .iter()
            .filter(|m| self.minor_mode_on(b, &m.name))
            .map(|m| m.name.clone())
            .collect()
    }

    /// The keymaps that apply to the current buffer, in the order keys are
    /// looked up: minor modes that are on, then the major mode's local map.
    /// The transient, minibuffer and global maps come before and after these.
    pub(crate) fn mode_keymaps(&self) -> Vec<KeymapId> {
        self.mode_keymaps_in(self.buffer(), true)
    }

    /// The keymaps of a buffer's modes, and with `at_point` those that text
    /// at its point carries.
    pub(crate) fn mode_keymaps_in(&self, b: &Buffer, at_point: bool) -> Vec<KeymapId> {
        // A keymap property at point comes first, and a local-map property
        // stands in for the buffer's own, as Emacs's current-active-maps has them.
        let property = |name| if at_point { self.keymap_property_at_point(b, name) } else { None };
        let mut maps: Vec<KeymapId> = property("keymap").into_iter().collect();
        maps.extend(
            self.minor_modes
                .iter()
                .filter(|m| self.minor_mode_on(b, &m.name))
                .filter_map(|m| m.keymap.as_deref().and_then(|k| self.keymap_named(k))),
        );
        match property("local-map") {
            Some(map) => maps.push(map),
            None => maps.extend(b.local_map.iter().copied()),
        }
        maps
    }

    /// The keymap a `keymap` or `local-map` property holds at point, as
    /// Emacs's get_local_map finds it: on the character after point, at the
    /// end of the buffer the last one, else the one before if the property
    /// sticks to its end. The property is a keymap, or a keymap's name.
    fn keymap_property_at_point(&self, b: &Buffer, name: &str) -> Option<KeymapId> {
        if b.is_empty() {
            return None;
        }
        let point = b.point();
        let keymap = |v: &Value| self.keymap_of(v).ok();
        // At the end of the buffer only the character before counts, by its stickiness.
        if point < b.len()
            && let Some(map) = b.char_property(point, name).and_then(keymap)
        {
            return Some(map);
        }
        let before = point.checked_sub(1)?;
        let props = b.text_properties_at(before)?;
        let nonsticky = match props.get("rear-nonsticky") {
            Some(Value::Bool(true)) => true,
            Some(Value::List(names)) => names.iter().any(|n| n.as_str() == Some(name)),
            _ => false,
        };
        if nonsticky { None } else { props.get(name).and_then(keymap) }
    }

    /// The keys bound to a command in the keymaps that apply to the current
    /// buffer: the global map, then the major mode's and minor modes' maps.
    pub fn keys_for(&self, command: &str) -> Vec<Vec<Key>> {
        let mut keys = self.keymaps.keys_for(self.global_map, command);
        for map in self.mode_keymaps() {
            keys.extend(self.keymaps.keys_for(map, command));
        }
        keys
    }

    pub fn tab_width(&self) -> usize {
        self.tab_width_in(self.window_buffer())
    }

    pub fn tab_width_in(&self, b: &Buffer) -> usize {
        self.number_in(b, "tab-width", 8.0).max(1.0) as usize
    }

    /// The window buffer's major mode as the mode line shows it, such as "Text".
    pub fn mode_name(&self) -> String {
        self.mode_name_in(self.window_buffer())
    }

    pub fn mode_name_in(&self, b: &Buffer) -> String {
        self.variable_in(b, "mode-name")
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "Fundamental".to_string())
    }

    /// What the window buffer's minor modes add to the mode line, each with
    /// its leading space as Emacs writes lighters: " Ovwrt".
    pub fn mode_lighters(&self) -> Vec<String> {
        self.mode_lighters_in(self.window_buffer())
    }

    pub fn mode_lighters_in(&self, b: &Buffer) -> Vec<String> {
        self.minor_modes
            .iter()
            .rev()
            .filter(|m| !m.lighter.is_empty() && self.minor_mode_on(b, &m.name))
            .map(|m| m.lighter.clone())
            .collect()
    }
}
