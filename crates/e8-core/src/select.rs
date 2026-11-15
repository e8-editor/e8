//! The system clipboard, as Emacs's select.el links it to the kill ring
//! with `select-enable-clipboard`: what is killed or copied goes to the
//! clipboard too, and yanking first takes in what another program put
//! there since, as `interprogram-cut-function` and
//! `interprogram-paste-function` do. The front end reads and writes the
//! clipboard; without one, as in tests and the terminal, the kill ring
//! keeps to itself.

use crate::editor::Editor;

/// A front end's access to the system clipboard.
pub trait Clipboard: Send {
    /// The text on the clipboard, if any.
    fn get_text(&mut self) -> Option<String>;
    fn set_text(&mut self, text: &str);
}

impl Editor {
    /// Gives the editor the system clipboard.
    pub fn set_clipboard(&mut self, clipboard: Box<dyn Clipboard>) {
        self.kill_ring.clipboard = Some(clipboard);
    }

    fn clipboard_enabled(&self) -> bool {
        self.variable("select-enable-clipboard").is_none_or(|v| v.is_true())
    }

    /// Puts killed text on the clipboard, as `gui-select-text` does.
    pub(crate) fn interprogram_cut(&mut self, text: &str) {
        if !self.clipboard_enabled() {
            return;
        }
        if let Some(clipboard) = &mut self.kill_ring.clipboard {
            clipboard.set_text(text);
            self.kill_ring.last_selected_text = Some(text.to_string());
        }
    }

    /// What another program put on the clipboard since the editor last put
    /// text there or took it in, as `gui-selection-value` gives it: nothing
    /// if it is what the editor put there itself.
    pub(crate) fn interprogram_paste(&mut self) -> Option<String> {
        if !self.clipboard_enabled() {
            return None;
        }
        let text = self.kill_ring.clipboard.as_mut()?.get_text().filter(|t| !t.is_empty())?;
        if self.kill_ring.last_selected_text.as_ref() == Some(&text) {
            return None;
        }
        self.kill_ring.last_selected_text = Some(text.clone());
        Some(text)
    }
}

/// Selections as macOS's pasteboards stand for them (ADR 0097): CLIPBOARD
/// is the system clipboard, where the front end has one; PRIMARY and
/// SECONDARY are kept by the editor, as Emacs's NS port keeps them on
/// pasteboards of its own.
impl Editor {
    /// The text of a selection, as `ns-get-selection` gives it.
    pub fn selection_value(&mut self, selection: &str) -> Option<String> {
        if selection == "CLIPBOARD" {
            return self.kill_ring.clipboard.as_mut()?.get_text();
        }
        self.kill_ring.selections.iter().find(|(n, _)| n == selection).map(|(_, t)| t.clone())
    }

    /// Makes the editor own a selection with this text, as
    /// `ns-own-selection-internal`.
    pub fn own_selection(&mut self, selection: &str, text: &str) {
        if selection == "CLIPBOARD" {
            if let Some(clipboard) = &mut self.kill_ring.clipboard {
                clipboard.set_text(text);
                self.kill_ring.last_selected_text = Some(text.to_string());
            }
            return;
        }
        self.kill_ring.selections.retain(|(n, _)| n != selection);
        self.kill_ring.selections.push((selection.to_string(), text.to_string()));
    }

    /// Gives up a selection, as `ns-disown-selection-internal`: the
    /// clipboard keeps its text, which is no longer the editor's.
    pub fn disown_selection(&mut self, selection: &str) {
        if selection == "CLIPBOARD" {
            self.kill_ring.last_selected_text = None;
        }
        self.kill_ring.selections.retain(|(n, _)| n != selection);
    }

    /// Whether the editor owns a selection, as `ns-selection-owner-p`: for
    /// the clipboard, whether it still holds what the editor put there.
    pub fn selection_owner_p(&mut self, selection: &str) -> bool {
        if selection == "CLIPBOARD" {
            let Some(mine) = self.kill_ring.last_selected_text.clone() else { return false };
            return self.selection_value("CLIPBOARD").as_deref() == Some(mine.as_str());
        }
        self.kill_ring.selections.iter().any(|(n, _)| n == selection)
    }

    /// Whether a selection holds anything, as `ns-selection-exists-p`.
    pub fn selection_exists_p(&mut self, selection: &str) -> bool {
        self.selection_value(selection).is_some_and(|t| !t.is_empty())
    }
}
