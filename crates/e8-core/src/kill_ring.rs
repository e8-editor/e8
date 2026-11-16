//! The kill ring, as simple.el keeps it: kills with their text
//! properties, consecutive kills joined, the yank pointer, and the system
//! clipboard it shares the newest kill with (select.rs).

use crate::commands;
use crate::editor::Editor;
use crate::error::{Error, Result};

/// Kills, oldest first, and where yanking takes the next one from.
#[derive(Default)]
pub(crate) struct KillRing {
    /// Kills, oldest first, with their text properties, as Emacs keeps them.
    pub(crate) kills: Vec<crate::properties::Text>,
    /// The system clipboard, if the front end has one, and the text the
    /// editor last put there or took in from it.
    pub(crate) clipboard: Option<Box<dyn crate::select::Clipboard>>,
    pub(crate) last_selected_text: Option<String>,
    /// Which kill yanking takes next, counting back from the newest (Emacs's
    /// `kill-ring-yank-pointer`).
    pub(crate) yank_pointer: usize,
    /// The text the editor owns of selections other than the clipboard,
    /// PRIMARY and SECONDARY, by name (ADR 0097).
    pub(crate) selections: Vec<(String, String)>,
}

impl Editor {
    /// Adds killed text to the kill ring. Kills made by consecutive kill
    /// commands join into one entry, as in Emacs.
    pub(crate) fn kill(&mut self, text: crate::properties::Text, prepend: bool) {
        let continuing = self
            .last_command()
            .is_some_and(|c| commands::KILL_COMMANDS.contains(&c));
        self.kill_ring.yank_pointer = 0;
        match self.kill_ring.kills.last_mut() {
            Some(last) if continuing => {
                let (front, back) = if prepend { (text, std::mem::take(last)) } else { (std::mem::take(last), text) };
                *last = front.concat(back);
            }
            _ => self.kill_ring.kills.push(text),
        }
        self.trim_kill_ring();
        // The whole kill goes to the clipboard, as kill-append gives it there.
        let newest = self.kill_ring.kills.last().map(|t| t.string.clone()).unwrap_or_default();
        self.interprogram_cut(&newest);
    }

    /// Lets the oldest kills go past `kill-ring-max`, as kill-new does.
    fn trim_kill_ring(&mut self) {
        let max = self.variable("kill-ring-max").and_then(|v| v.as_number()).map_or(120, |n| n.max(1.0) as usize);
        let kills = &mut self.kill_ring.kills;
        if kills.len() > max {
            kills.drain(..kills.len() - max);
        }
    }

    /// Puts text in the kill ring as a kill of its own, as Emacs's
    /// `kill-new`, and on the system clipboard.
    pub fn kill_new(&mut self, text: &str) {
        self.kill_ring.yank_pointer = 0;
        self.kill_ring.kills.push(crate::properties::Text { string: text.to_string(), props: Vec::new() });
        self.trim_kill_ring();
        self.interprogram_cut(text);
    }

    /// Makes the kill `index` places from the newest the one the next yank
    /// inserts, as setting `kill-ring-yank-pointer` does.
    pub fn set_kill_ring_yank_pointer(&mut self, index: usize) {
        self.kill_ring.yank_pointer = index.min(self.kill_ring.kills.len().saturating_sub(1));
    }

    /// The kill `n` entries back from the one yanked last, moving the yank
    /// pointer there, as Emacs's `current-kill` does. 0 is the kill yanking
    /// would insert now; M-y asks for 1, the one before it.
    pub fn current_kill(&mut self, n: i64) -> Result<String> {
        self.current_kill_text(n).map(|t| t.string)
    }

    /// As [`Editor::current_kill`], with the kill's text properties.
    pub fn current_kill_text(&mut self, n: i64) -> Result<crate::properties::Text> {
        // Text another program put on the clipboard since is the newest
        // kill, as current-kill takes it in through interprogram-paste-function.
        if n == 0
            && let Some(text) = self.interprogram_paste()
        {
            self.kill_ring.yank_pointer = 0;
            self.kill_ring.kills.push(crate::properties::Text { string: text, props: Vec::new() });
            self.trim_kill_ring();
        }
        if self.kill_ring.kills.is_empty() {
            return Err(Error::new("Kill ring is empty"));
        }
        let len = self.kill_ring.kills.len() as i64;
        self.kill_ring.yank_pointer = (self.kill_ring.yank_pointer as i64 + n).rem_euclid(len) as usize;
        Ok(self.kill_ring.kills[(len - 1) as usize - self.kill_ring.yank_pointer].clone())
    }

    /// The kills' text, oldest first.
    pub fn kill_ring(&self) -> Vec<String> {
        self.kill_ring.kills.iter().map(|t| t.string.clone()).collect()
    }

    /// Takes the newest kill off the kill ring, as `(pop kill-ring)` does in
    /// Lisp, and returns it.
    pub fn pop_kill(&mut self) -> Option<String> {
        let kill = self.kill_ring.kills.pop();
        self.kill_ring.yank_pointer = self.kill_ring.yank_pointer.min(self.kill_ring.kills.len().saturating_sub(1));
        kill.map(|t| t.string)
    }
}
