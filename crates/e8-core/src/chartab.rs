//! Char-tables, as Emacs's chartab.c: a value for every character, with
//! a default for those whose value is nil, a parent to look in after
//! that, a subtype naming what the table is for, and extra slots, which
//! case tables and category tables keep their other tables in.
//!
//! A table is runs of characters with one value each, so setting a range
//! costs as little as setting a character. Scripts hold a table as a
//! value (`Value::CharTable`), its id, as they hold a keymap.

use std::collections::BTreeMap;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

pub type CharTableId = u64;

/// The largest character code, as Emacs's `max-char`.
pub const MAX_CHAR: u32 = 0x3F_FFFF;

#[derive(Clone, Debug)]
pub struct CharTable {
    pub(crate) subtype: String,
    /// What characters not given values of their own have, as
    /// `make-char-table`'s INIT gives every character.
    init: Value,
    /// What a nil value stands for, `char-table-range`'s nil.
    pub(crate) default: Value,
    /// Runs of characters given one value: first → (last, value).
    runs: BTreeMap<u32, (u32, Value)>,
    pub(crate) parent: Option<CharTableId>,
    pub(crate) extras: Vec<Value>,
    /// How many times it has been changed, so what is worked out from it
    /// can tell when it is out of date.
    pub(crate) tick: u64,
}

impl CharTable {
    pub(crate) fn new(subtype: &str, init: Value, extras: usize) -> CharTable {
        CharTable { subtype: subtype.to_string(), default: init.clone(), init, runs: BTreeMap::new(), parent: None, extras: vec![Value::Null; extras], tick: 0 }
    }

    /// A character's own value, before the default and the parent.
    pub(crate) fn own(&self, c: u32) -> &Value {
        match self.runs.range(..=c).next_back() {
            Some((_, (last, value))) if c <= *last => value,
            _ => &self.init,
        }
    }

    /// Gives every character from `from` to `to` a value.
    pub(crate) fn set_range(&mut self, from: u32, to: u32, value: Value) {
        let overlapping: Vec<u32> = self.runs.range(..=to).filter(|(_, (last, _))| *last >= from).map(|(first, _)| *first).collect();
        for first in overlapping {
            let (last, old) = self.runs.remove(&first).expect("listed");
            if first < from {
                self.runs.insert(first, (from - 1, old.clone()));
            }
            if last > to {
                self.runs.insert(to + 1, (last, old));
            }
        }
        self.runs.insert(from, (to, value));
        self.tick += 1;
    }

    /// Every character's own value, as runs: (first, last, value), in
    /// order, neighbouring runs of equal values joined.
    pub(crate) fn spans(&self) -> Vec<(u32, u32, Value)> {
        let mut out: Vec<(u32, u32, Value)> = Vec::new();
        let mut push = |first: u32, last: u32, value: &Value| match out.last_mut() {
            Some((_, l, v)) if *l + 1 == first && v == value => *l = last,
            _ => out.push((first, last, value.clone())),
        };
        let mut next = 0;
        for (&first, (last, value)) in &self.runs {
            if first > next {
                push(next, first - 1, &self.init);
            }
            push(first, *last, value);
            next = last + 1;
        }
        if next <= MAX_CHAR {
            push(next, MAX_CHAR, &self.init);
        }
        out
    }

}

/// A range of characters `char-table-range` and `set-char-table-range`
/// take: the default (nil), one character, or a run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CharRange {
    Default,
    Char(u32),
    Range(u32, u32),
}

impl Editor {
    pub(crate) fn add_char_table(&mut self, table: CharTable) -> CharTableId {
        self.next_char_table += 1;
        let id = self.next_char_table;
        self.char_tables.insert(id, table);
        id
    }

    pub(crate) fn char_table(&self, id: CharTableId) -> Result<&CharTable> {
        self.char_tables.get(&id).ok_or_else(|| Error::signal("wrong-type-argument", "Wrong type argument: char-table-p", Vec::new()))
    }

    fn char_table_mut(&mut self, id: CharTableId) -> Result<&mut CharTable> {
        self.char_tables.get_mut(&id).ok_or_else(|| Error::signal("wrong-type-argument", "Wrong type argument: char-table-p", Vec::new()))
    }

    /// Makes a char-table, as Emacs's `make-char-table`: every character's
    /// value `init`, with as many extra slots as the subtype's
    /// `char-table-extra-slots` property says, none by default.
    pub fn make_char_table(&mut self, subtype: &str, init: Value) -> Result<CharTableId> {
        // As Emacs puts the property on the subtypes it defines.
        let builtin = match subtype {
            "case-table" => 3.0,
            "category-table" => 2.0,
            "display-table" => 6.0,
            "char-code-property-table" => 5.0,
            _ => 0.0,
        };
        let extras = self.get(subtype, "char-table-extra-slots").and_then(|v| v.as_number()).unwrap_or(builtin);
        if !(0.0..=10.0).contains(&extras) {
            return Err(Error::signal("args-out-of-range", format!("Args out of range: {extras}"), Vec::new()));
        }
        Ok(self.add_char_table(CharTable::new(subtype, init, extras as usize)))
    }

    /// A copy of a char-table, as `copy-sequence` makes one: its own
    /// values, default, parent, subtype and extra slots, which are shared.
    pub fn copy_char_table(&mut self, id: CharTableId) -> Result<CharTableId> {
        let mut copy = self.char_table(id)?.clone();
        copy.tick = 0;
        Ok(self.add_char_table(copy))
    }

    pub fn char_table_p(&self, id: CharTableId) -> bool {
        self.char_tables.contains_key(&id)
    }

    pub fn char_table_subtype(&self, id: CharTableId) -> Result<String> {
        Ok(self.char_table(id)?.subtype.clone())
    }

    pub fn char_table_parent(&self, id: CharTableId) -> Result<Option<CharTableId>> {
        Ok(self.char_table(id)?.parent)
    }

    /// Gives a table a parent to take values from where its own are nil,
    /// as `set-char-table-parent`; a table cannot be its own ancestor.
    pub fn set_char_table_parent(&mut self, id: CharTableId, parent: Option<CharTableId>) -> Result<()> {
        let mut p = parent;
        while let Some(ancestor) = p {
            if ancestor == id {
                return Err(Error::new("Attempt to make a chartable be its own parent"));
            }
            p = self.char_table(ancestor)?.parent;
        }
        let table = self.char_table_mut(id)?;
        table.parent = parent;
        table.tick += 1;
        Ok(())
    }

    pub fn char_table_extra_slot(&self, id: CharTableId, n: usize) -> Result<Value> {
        self.char_table(id)?.extras.get(n).cloned().ok_or_else(|| Error::signal("args-out-of-range", format!("Args out of range: {n}"), Vec::new()))
    }

    pub fn set_char_table_extra_slot(&mut self, id: CharTableId, n: usize, value: Value) -> Result<()> {
        let table = self.char_table_mut(id)?;
        let slot = table.extras.get_mut(n).ok_or_else(|| Error::signal("args-out-of-range", format!("Args out of range: {n}"), Vec::new()))?;
        *slot = value;
        table.tick += 1;
        Ok(())
    }

    /// A character's value, as `aref` gives it: its own, else the default
    /// if that is nil, else the parent's.
    pub fn char_table_get(&self, id: CharTableId, c: u32) -> Value {
        let mut table = self.char_tables.get(&id);
        for _ in 0..16 {
            let Some(t) = table else { break };
            let value = t.own(c);
            if value.is_true() || matches!(value, Value::Number(_)) {
                return value.clone();
            }
            if t.default.is_true() {
                return t.default.clone();
            }
            table = t.parent.and_then(|p| self.char_tables.get(&p));
        }
        Value::Null
    }

    /// Sets a character's value, as `aset` does on a char-table.
    pub fn char_table_set(&mut self, id: CharTableId, c: u32, value: Value) -> Result<()> {
        self.char_table_mut(id)?.set_range(c, c, value);
        Ok(())
    }

    /// The value for a range, as `char-table-range`: the default for
    /// `Default`, else the value of the range's first character.
    pub fn char_table_range(&self, id: CharTableId, range: CharRange) -> Result<Value> {
        let table = self.char_table(id)?;
        Ok(match range {
            CharRange::Default => table.default.clone(),
            CharRange::Char(c) | CharRange::Range(c, _) => self.char_table_get(id, c),
        })
    }

    /// Sets the value of a range, as `set-char-table-range`: the default for
    /// `Default`, else every character in it.
    pub fn set_char_table_range(&mut self, id: CharTableId, range: CharRange, value: Value) -> Result<()> {
        let table = self.char_table_mut(id)?;
        match range {
            CharRange::Default => {
                table.default = value;
                table.tick += 1;
            }
            CharRange::Char(c) => table.set_range(c, c, value),
            CharRange::Range(from, to) => table.set_range(from.min(to), from.max(to).min(MAX_CHAR), value),
        }
        Ok(())
    }

    /// The runs of characters with one value that is not nil, the default
    /// and the parent's values filled in, as `map-char-table` visits them.
    pub fn map_char_table(&self, id: CharTableId) -> Result<Vec<(u32, u32, Value)>> {
        let table = self.char_table(id)?;
        let mut out: Vec<(u32, u32, Value)> = Vec::new();
        let parent = table.parent.map(|p| self.map_char_table(p)).transpose()?;
        for (first, last, value) in table.spans() {
            let value = if value == Value::Null { table.default.clone() } else { value };
            if value != Value::Null {
                out.push((first, last, value));
                continue;
            }
            // Where the parent has values instead.
            for (pf, pl, pv) in parent.iter().flatten() {
                let (f, l) = ((*pf).max(first), (*pl).min(last));
                if f <= l {
                    out.push((f, l, pv.clone()));
                }
            }
        }
        Ok(out)
    }

    /// The char-table of a Unicode property, as
    /// `unicode-property-table-internal`: the same table each time it is
    /// asked for, and `None` for a property E8 holds no data for, as
    /// Emacs answers nil for one whose table it cannot load.
    ///
    /// E8 holds the bidi properties ([ADR 0047]), and no others.
    ///
    /// [ADR 0047]: ../../../../docs/adr/0047-bidirectional-text.md
    pub fn unicode_property_table(&mut self, property: &str) -> Option<CharTableId> {
        if let Some(id) = self.unicode_property_tables.get(property) {
            return Some(*id);
        }
        let (default, runs) = crate::bidi::property_runs(property)?;
        let mut table = CharTable::new(property, default, 0);
        for (first, last, value) in runs {
            table.set_range(first, last, value);
        }
        let id = self.add_char_table(table);
        self.unicode_property_tables.insert(property.to_string(), id);
        Some(id)
    }
}
