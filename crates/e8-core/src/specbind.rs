//! The binding stack, as Emacs's specpdl: what `let` binds, which buffer
//! `with-current-buffer` left, where `save-excursion` was and the narrowing
//! `save-restriction` kept, each an entry to restore when the form ends.
//!
//! Scripts push entries through the `e8` API and pop them as their
//! forms end. The stack is the editor's, so when a script is stopped
//! without unwinding, as the emergency exit after `C-g` pressed three
//! times stops it, the editor restores what it had bound
//! ([`Editor::unbind_to`]). An async form waiting on a prompt keeps its
//! entries while other commands run, so an entry is popped by its id,
//! wherever it is, not only from the top.

use crate::editor::Editor;
use crate::variables::Value;

/// What one entry restores.
#[derive(Debug)]
enum Entry {
    /// A variable bound in a buffer, where it was local.
    Local { name: String, buffer: u64, old: Value },
    /// A variable's default value.
    Default { name: String, old: Value },
    /// The buffer that was current.
    Current(u64),
    /// The buffer and point, by a marker, as `save-excursion` keeps them.
    Excursion { buffer: u64, marker: u64 },
    /// A buffer's narrowing, by markers at its edges, or none.
    Restriction { buffer: u64, edges: Option<(u64, u64)>, labeled: Vec<crate::buffer::Labeled> },
    /// A buffer's undo history, `buffer-undo-list`, kept as it is.
    Undo { buffer: u64, binding: crate::buffer::UndoBinding },
}

#[derive(Debug, Default)]
pub(crate) struct Specpdl {
    entries: Vec<(u64, Entry)>,
    next: u64,
}

impl Editor {
    fn push_binding(&mut self, entry: Entry) -> u64 {
        self.specpdl.next += 1;
        let id = self.specpdl.next;
        self.specpdl.entries.push((id, entry));
        id
    }

    /// Binds a variable for a dynamic extent, as `let` does: where it is
    /// local in the current buffer, there, and otherwise its default
    /// value. Returns the entry to [`unbind`](Editor::unbind) after.
    pub fn specbind(&mut self, name: &str, value: Value) -> u64 {
        let entry = if name == "buffer-undo-list" {
            // Its history kept aside, not copied out as a list.
            let current = self.buffer_with_id(self.buffer().id()).expect("current");
            self.claim_undo(current);
            let buffer = self.buffer().id();
            let binding = self.buffer_mut().bind_undo();
            self.set_variable(name, value);
            Entry::Undo { buffer, binding }
        } else if self.is_local_variable(name) {
            let old = self.variable(name).unwrap_or(Value::Null);
            let buffer = self.buffer().id();
            self.set_variable(name, value);
            Entry::Local { name: name.to_string(), buffer, old }
        } else {
            let old = self.default_value(name).unwrap_or(Value::Null);
            self.set_default(name, value);
            Entry::Default { name: name.to_string(), old }
        };
        self.push_binding(entry)
    }

    /// Keeps the current buffer, to be current again after, as
    /// `save-current-buffer` does.
    pub fn record_current_buffer(&mut self) -> u64 {
        let id = self.buffer().id();
        self.push_binding(Entry::Current(id))
    }

    /// Keeps the current buffer and point, as `save-excursion` does.
    pub fn record_excursion(&mut self) -> u64 {
        let buffer = self.buffer().id();
        let point = self.buffer().point();
        let marker = self.buffer_mut().make_marker(point, false);
        self.push_binding(Entry::Excursion { buffer, marker })
    }

    /// Keeps the current buffer's narrowing, following edits to its edges,
    /// as `save-restriction` does.
    pub fn record_restriction(&mut self) -> u64 {
        let b = self.buffer_mut();
        let buffer = b.id();
        let narrowed = b.point_min() > 0 || b.point_max() < b.len();
        let edges = narrowed.then(|| {
            let (min, max) = (b.point_min(), b.point_max());
            (b.make_marker(min, false), b.make_marker(max, true))
        });
        let labeled = self.buffer().labeled.clone();
        self.push_binding(Entry::Restriction { buffer, edges, labeled })
    }

    /// How many entries the stack holds, for [`unbind_to`](Editor::unbind_to).
    pub fn specpdl_depth(&self) -> usize {
        self.specpdl.entries.len()
    }

    /// Restores one entry and takes it off the stack, as the end of its
    /// form does. An entry already restored is left alone.
    pub fn unbind(&mut self, id: u64) {
        if let Some(i) = self.specpdl.entries.iter().rposition(|(e, _)| *e == id) {
            let (_, entry) = self.specpdl.entries.remove(i);
            self.restore(entry);
        }
    }

    /// Restores every entry above `depth`, newest first, as Emacs's
    /// `unbind_to` does when a non-local exit passes their forms.
    pub fn unbind_to(&mut self, depth: usize) {
        while self.specpdl.entries.len() > depth {
            let (_, entry) = self.specpdl.entries.pop().expect("deeper than depth");
            self.restore(entry);
        }
    }

    /// Makes the buffer with an id current, if it is live.
    fn back_to(&mut self, buffer: u64) {
        if let Some(index) = self.buffer_with_id(buffer) {
            let name = self.buffers()[index].name.clone();
            let _ = self.set_current_buffer(&name);
        }
    }

    fn restore(&mut self, entry: Entry) {
        match entry {
            Entry::Local { name, buffer, old } => {
                let Some(index) = self.buffer_with_id(buffer) else { return };
                let back = self.buffer().id();
                let there = self.buffers()[index].name.clone();
                let _ = self.set_current_buffer(&there);
                self.set_variable(&name, old);
                self.back_to(back);
            }
            Entry::Default { name, old } => self.set_default(&name, old),
            Entry::Undo { buffer, binding } => {
                let Some(index) = self.buffer_with_id(buffer) else { return };
                self.claim_undo(index);
                self.buffers[index].unbind_undo(binding);
            }
            Entry::Current(buffer) => self.back_to(buffer),
            Entry::Excursion { buffer, marker } => {
                let at = self.marker_position(marker).map(|(_, p)| p);
                self.delete_marker(marker);
                self.back_to(buffer);
                if self.buffer().id() == buffer
                    && let Some(p) = at
                {
                    self.buffer_mut().set_point(p);
                }
            }
            Entry::Restriction { buffer, edges, labeled } => {
                let Some(index) = self.buffer_with_id(buffer) else {
                    if let Some((beg, end)) = edges {
                        self.delete_marker(beg);
                        self.delete_marker(end);
                    }
                    return;
                };
                let back = self.buffer().id();
                let there = self.buffers()[index].name.clone();
                let _ = self.set_current_buffer(&there);
                self.buffer_mut().widen();
                if let Some((beg, end)) = edges {
                    let start = self.marker_position(beg).map_or(0, |(_, p)| p);
                    let stop = self.marker_position(end).map_or(start, |(_, p)| p);
                    self.delete_marker(beg);
                    self.delete_marker(end);
                    self.buffer_mut().narrow(start, stop.max(start));
                }
                // The labeled restrictions as they were, as Emacs's
                // labeled_restrictions_restore puts them back; the markers
                // of those made since go.
                let b = self.buffer_mut();
                let now = std::mem::replace(&mut b.labeled, labeled);
                let gone: Vec<_> = now.into_iter().filter(|l| !b.labeled.contains(l)).collect();
                for l in gone {
                    b.remove_marker(l.start);
                    b.remove_marker(l.end);
                }
                self.back_to(back);
            }
        }
    }
}
