//! The command loop's own primitives, as Emacs's keyboard.c has them:
//! reading keys partway through a command (`read-key`, `read-key-sequence`,
//! `read-char`, `read-event`), the keys that ran the command running
//! (`this-command-keys`), the keys typed lately and the commands they ran
//! (`recent-keys`, which `C-h l` shows), and recursive edits.
//!
//! As in Emacs, the reading command waits for the key, which is returned:
//! the editor runs its command loop meanwhile (ADR 0053), as questions do
//! (`questions.rs`). A recursive edit is the same: the editor goes on
//! taking commands until `exit-recursive-edit` returns from it, or
//! `abort-recursive-edit` quits it.

use std::collections::VecDeque;

use crate::editor::{AnswerSlot, Editor};
use crate::error::{Error, Result};
use crate::key::{Key, KeyCode, format_keys};
use crate::keymap::Lookup;
use crate::variables::Value;

/// What is being read: one key, as `read-key` and `read-event` give it, a
/// character, as `read-char`, or a whole key sequence, as the command loop
/// reads one, by `read-key-sequence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadKind {
    Key,
    Event,
    Char,
    KeySequence,
}

pub(crate) struct KeyReader {
    kind: ReadKind,
    prompt: String,
    keys: Vec<Key>,
    /// Where the key goes, for the command waiting on it.
    answer: AnswerSlot,
    /// When to stop waiting and answer nil, as `read-event`'s SECONDS.
    deadline: Option<crate::clock::Instant>,
}

pub(crate) struct RecursiveEdit {
    /// Where leaving it, or quitting it, goes, for the command in it.
    answer: AnswerSlot,
    /// How many minibuffers were open when it was entered, so a minibuffer
    /// opened in it is left first.
    minibuffers: usize,
}

/// One entry of the keys typed lately: a key, or the command the keys
/// before it ran, as `recent-keys` lists `(nil . COMMAND)`.
#[derive(Clone, Debug, PartialEq)]
pub enum Lossage {
    Key(Key),
    Command(String),
}

/// How many keys `recent-keys` keeps, as Emacs's `lossage-size` starts.
pub(crate) const LOSSAGE_SIZE: usize = 300;

/// The keyboard's state that the command loop keeps.
pub(crate) struct Keyboard {
    pub(crate) reader: Option<KeyReader>,
    pub(crate) recursive_edits: Vec<RecursiveEdit>,
    pub(crate) lossage: VecDeque<Lossage>,
    pub(crate) lossage_size: usize,
    /// The keys of the command running, or that ran last.
    pub(crate) this_command_keys: Vec<Key>,
    /// What `sleep-for` calls wait on, which `C-g` quits.
    pub(crate) sleeping: Vec<AnswerSlot>,
    /// Keys read so far for a command parameter of kind [`crate::ParamKind::Keys`].
    pub(crate) reading_keys: Option<Vec<Key>>,
    /// Keys typed so far of a multi-key binding such as `C-x C-f`.
    pub(crate) pending_keys: Vec<Key>,
    pub(crate) esc_prefix: bool,
    /// Whether the key that ran the current command had Shift removed to find
    /// its binding. Shift selection uses it.
    pub(crate) shift_translated: bool,
    /// Keys to read next, after the current one, as Emacs's `unread-command-events`.
    pub(crate) unread_keys: VecDeque<Key>,
    /// Keys typed ahead, as [`Editor::press`] gives them: a command they
    /// start that waits for input reads the rest of them first.
    pub(crate) typeahead: VecDeque<Key>,
    /// The last number given a prompt or a wait, and those of the waits
    /// open, for [`Editor::waiting_for_input`].
    pub(crate) input_serial: u64,
    pub(crate) wait_serials: Vec<u64>,
    /// What each command waiting for input waits for, innermost last, so
    /// keys typed ahead stop once one has its answer.
    pub(crate) waits: Vec<crate::editor::WaitDone>,
    /// What a command waiting for input reads from once the typeahead is
    /// used up, where no command loop runs: tests' and the oracle's
    /// answers. It returns false when it has nothing more.
    pub(crate) input_source: Option<crate::editor::InputSource>,
    pub(crate) reading_unread: bool,
}

impl Default for Keyboard {
    fn default() -> Keyboard {
        Keyboard {
            reader: None,
            recursive_edits: Vec::new(),
            lossage: VecDeque::new(),
            lossage_size: LOSSAGE_SIZE,
            this_command_keys: Vec::new(),
            sleeping: Vec::new(),
            reading_keys: None,
            pending_keys: Vec::new(),
            esc_prefix: false,
            shift_translated: false,
            unread_keys: VecDeque::new(),
            typeahead: VecDeque::new(),
            input_serial: 0,
            wait_serials: Vec::new(),
            waits: Vec::new(),
            input_source: None,
            reading_unread: false,
        }
    }
}

impl Editor {
    /// Reads a key partway through a command, showing `prompt` in the echo
    /// area, and returns it, as Emacs's `read-key`, `read-event`,
    /// `read-char` and `read-key-sequence` do: a key's description, such as
    /// "C-x" or "<f1>", or a key sequence's, "C-x C-f". `C-g` quits, but
    /// for a key sequence, where it is a key like others. With a `timeout`,
    /// it is `None` if no key comes in that time, as `read-event` and
    /// `read-char` with SECONDS.
    pub fn read_key_event(&mut self, kind: ReadKind, prompt: &str, timeout: Option<std::time::Duration>) -> Result<Option<String>> {
        if self.keyboard.reader.is_some() {
            return Err(Error::new("Already reading a key"));
        }
        let asker = self.resume_point();
        let deadline = timeout.map(|t| self.now() + t);
        let answer = AnswerSlot::default();
        self.keyboard.reader = Some(KeyReader { kind, prompt: prompt.to_string(), keys: Vec::new(), answer: answer.clone(), deadline });
        // With no prompt, what the echo area shows stays, as sit-for's message does.
        if !prompt.is_empty() {
            self.message = Some(prompt.to_string());
        }
        let result = self.wait_for_answer(&asker, &answer);
        // Gone however the wait ended, as when the editor closes.
        if self.keyboard.reader.as_ref().is_some_and(|r| std::rc::Rc::ptr_eq(&r.answer, &answer)) {
            self.keyboard.reader = None;
        }
        Ok(result?.as_str().map(str::to_string))
    }

    /// When code reading a key with a timeout stops waiting, if it does.
    pub(crate) fn key_read_deadline(&self) -> Option<crate::clock::Instant> {
        self.keyboard.reader.as_ref().and_then(|r| r.deadline)
    }

    /// Answers nil to code reading a key whose timeout has passed, as
    /// `read-event` returns nil when SECONDS pass with no input.
    pub(crate) fn key_read_timed_out(&mut self) {
        let now = self.now();
        if !self.keyboard.reader.as_ref().is_some_and(|r| r.deadline.is_some_and(|d| d <= now)) {
            return;
        }
        let reader = self.keyboard.reader.take().expect("a reader waits");
        if !reader.prompt.is_empty() {
            self.message = None;
        }
        reader.answer.borrow_mut().get_or_insert(Ok(Value::Null));
    }

    /// Waits `secs` seconds, as Emacs's `sleep-for`. Keys typed meanwhile
    /// run their commands, and `C-g` quits it. In batch mode, with no
    /// command loop to read keys, it waits on the clock, running timers and
    /// process output, and reads no input, as batch Emacs's does.
    pub fn sleep_for(&mut self, secs: f64) -> Result<()> {
        if self.noninteractive() && self.command_loop.is_none() {
            self.sleep_without_input(secs);
            return Ok(());
        }
        let asker = self.resume_point();
        let answer = AnswerSlot::default();
        let done = answer.clone();
        let timer = self.run_with_timer(
            secs,
            None,
            std::rc::Rc::new(move |_: &mut Editor, _: &[Value]| {
                done.borrow_mut().get_or_insert(Ok(Value::Null));
                Ok(())
            }),
        );
        self.keyboard.sleeping.push(answer.clone());
        let result = self.wait_for_answer(&asker, &answer);
        self.keyboard.sleeping.retain(|s| !std::rc::Rc::ptr_eq(s, &answer));
        self.cancel_timer(timer);
        result.map(|_| ())
    }

    /// Waits `secs` seconds of real time, running timers as they come due
    /// and output as processes write it, as Emacs's wait_reading_process_output
    /// does when it is not reading the keyboard.
    fn sleep_without_input(&mut self, secs: f64) {
        let until = self.now() + std::time::Duration::from_secs_f64(secs.max(0.0));
        loop {
            self.run_timers();
            let now = self.now();
            if now >= until {
                return;
            }
            let mut wait = until - now;
            if let Some(timer) = self.next_timer_in() {
                wait = wait.min(timer);
            }
            if self.processes_running() {
                // Woken by their output as it comes, as accept-process-output is.
                self.processes.wait_for_event(wait.min(std::time::Duration::from_millis(5)));
                continue;
            }
            std::thread::sleep(wait.max(std::time::Duration::from_micros(100)));
        }
    }

    /// Whether code is waiting for a key, which the next key goes to.
    pub fn reading_key(&self) -> bool {
        self.keyboard.reader.is_some()
    }

    /// Gives a key to code waiting for one. Returns false if none waits.
    pub(crate) fn key_read(&mut self, key: Key) -> bool {
        let Some(mut reader) = self.keyboard.reader.take() else { return false };
        let quit = key == Key::parse("C-g").expect("C-g parses");
        if quit && reader.kind != ReadKind::KeySequence {
            self.message = None;
            reader.answer.borrow_mut().get_or_insert(Err(Error::signal("quit", "Quit", Vec::new())));
            return true;
        }
        reader.keys.push(key);
        let answer = match reader.kind {
            ReadKind::KeySequence => {
                if self.lookup(&reader.keys) == Lookup::Prefix {
                    self.message = Some(format!("{}{}-", reader.prompt, format_keys(&reader.keys)));
                    self.keyboard.reader = Some(reader);
                    return true;
                }
                self.keyboard.this_command_keys = reader.keys.clone();
                Ok(format_keys(&reader.keys))
            }
            ReadKind::Char => match key.code {
                KeyCode::Char(_) | KeyCode::Enter | KeyCode::Tab | KeyCode::Backspace | KeyCode::Esc => Ok(key.to_string()),
                _ => Err(Error::new("Non-character input-event")),
            },
            ReadKind::Key | ReadKind::Event => Ok(key.to_string()),
        };
        self.message = None;
        reader.answer.borrow_mut().get_or_insert(answer.map(Value::Str));
        true
    }

    /// Notes a key typed, for `recent-keys`, keeping the last
    /// `lossage-size` keys, unless the current buffer's
    /// `inhibit--record-char` says not to, as a password prompt's does.
    pub(crate) fn record_lossage_key(&mut self, key: Key) {
        if self.variable("inhibit--record-char").is_some_and(|v| v.is_true()) {
            return;
        }
        let k = &mut self.keyboard;
        k.lossage.push_back(Lossage::Key(key));
        while k.lossage.iter().filter(|e| matches!(e, Lossage::Key(_))).count() > k.lossage_size {
            k.lossage.pop_front();
            while matches!(k.lossage.front(), Some(Lossage::Command(_))) {
                k.lossage.pop_front();
            }
        }
    }

    /// Notes the command the keys typed ran, for `recent-keys`.
    pub(crate) fn record_lossage_command(&mut self, name: &str) {
        if self.executing_macro == 0 {
            self.keyboard.lossage.push_back(Lossage::Command(name.to_string()));
        }
    }

    /// The keys typed lately, oldest first, as Emacs's `recent-keys`; with
    /// `include_cmds`, each command after the keys that ran it. Keys a
    /// keyboard macro replays are not among them.
    pub fn recent_keys(&self, include_cmds: bool) -> Vec<Lossage> {
        self.keyboard.lossage.iter().filter(|e| include_cmds || matches!(e, Lossage::Key(_))).cloned().collect()
    }

    /// How many keys `recent-keys` keeps, as `lossage-size`.
    pub fn lossage_size(&self) -> usize {
        self.keyboard.lossage_size
    }

    /// Keeps `size` keys from now on, the oldest forgotten if there are
    /// more, as `lossage-size` with an argument; at least 100, as Emacs has it.
    pub fn set_lossage_size(&mut self, size: usize) -> Result<()> {
        if size < 100 {
            return Err(Error::user("Value must be >= 100"));
        }
        self.keyboard.lossage_size = size;
        let keys: Vec<Key> = self.keyboard.lossage.iter().filter_map(|e| if let Lossage::Key(k) = e { Some(*k) } else { None }).collect();
        if keys.len() > size {
            let mut drop = keys.len() - size;
            while drop > 0 {
                if let Some(Lossage::Key(_)) = self.keyboard.lossage.pop_front() {
                    drop -= 1;
                }
            }
            while matches!(self.keyboard.lossage.front(), Some(Lossage::Command(_))) {
                self.keyboard.lossage.pop_front();
            }
        }
        Ok(())
    }

    /// The keys that ran the command running, as Emacs's
    /// `this-command-keys`: not those of its prefix argument, which ran
    /// commands of their own; after `read-key-sequence`, the sequence it read.
    pub fn this_command_keys(&self) -> &[Key] {
        &self.keyboard.this_command_keys
    }

    /// The keys of a key sequence read so far, while a prefix waits for
    /// more, as Emacs's `this-single-command-keys` gives them to a timer
    /// that runs then; else the keys of the command running.
    pub fn this_single_command_keys(&self) -> &[Key] {
        if self.keyboard.pending_keys.is_empty() { &self.keyboard.this_command_keys } else { &self.keyboard.pending_keys }
    }

    /// Keeps the keys of a command about to run.
    pub(crate) fn note_command_keys(&mut self, keys: &[Key]) {
        self.keyboard.this_command_keys = keys.to_vec();
    }

    /// Whether code waits for a single key, which takes ESC as it comes,
    /// as Emacs's `read-key` does, rather than as a prefix for Meta.
    pub fn reading_single_key(&self) -> bool {
        self.keyboard.reader.as_ref().is_some_and(|r| r.kind != ReadKind::KeySequence)
    }

    /// Whether keys are waiting to be read, as Emacs's `input-pending-p`:
    /// keys a command gave back with `unread-command-events`.
    pub fn input_pending_p(&self) -> bool {
        !self.keyboard.unread_keys.is_empty()
    }

    /// Forgets keys waiting to be read, as `discard-input`.
    pub fn discard_input(&mut self) {
        self.keyboard.unread_keys.clear();
    }

    /// Edits recursively, as Emacs's `recursive-edit`: the editor goes on
    /// taking commands, the mode line shows `[` `]` around the modes for
    /// each level, until `exit-recursive-edit` (`C-M-c`) returns from it, or
    /// `abort-recursive-edit` (`C-]`) quits it.
    pub fn recursive_edit(&mut self) -> Result<()> {
        let asker = self.resume_point();
        let minibuffers = self.minibuffer_depth();
        let answer = AnswerSlot::default();
        self.keyboard.recursive_edits.push(RecursiveEdit { answer: answer.clone(), minibuffers });
        self.update_mode_lines();
        let result = self.wait_for_answer(&asker, &answer);
        // Gone however the wait ended, as when the editor closes.
        self.keyboard.recursive_edits.retain(|e| !std::rc::Rc::ptr_eq(&e.answer, &answer));
        self.update_mode_lines();
        result.map(|_| ())
    }

    /// How deep in recursive edits and minibuffers the editor is, as
    /// Emacs's `recursion-depth`.
    pub fn recursion_depth(&self) -> usize {
        self.keyboard.recursive_edits.len() + self.minibuffer_depth()
    }

    /// How many recursive edits are open, which the mode line's `%[` shows.
    pub fn recursive_edit_depth(&self) -> usize {
        self.keyboard.recursive_edits.len()
    }

    /// Whether the innermost level is a minibuffer opened inside the
    /// innermost recursive edit, or there is no recursive edit.
    fn minibuffer_innermost(&self) -> bool {
        match self.keyboard.recursive_edits.last() {
            Some(edit) => self.minibuffer_depth() > edit.minibuffers,
            None => self.minibuffer_depth() > 0,
        }
    }

    /// Leaves the innermost recursive edit and runs what waited for it, as
    /// Emacs's `exit-recursive-edit`; in a minibuffer opened inside it, the
    /// minibuffer is left as RET leaves it.
    pub fn exit_recursive_edit(&mut self) -> Result<()> {
        if self.minibuffer_innermost() {
            return self.call("exit-minibuffer", Vec::new());
        }
        let Some(edit) = self.keyboard.recursive_edits.pop() else {
            return Err(Error::user("No recursive edit is in progress"));
        };
        self.update_mode_lines();
        edit.answer.borrow_mut().get_or_insert(Ok(Value::Null));
        Ok(())
    }

    /// Quits the innermost recursive edit or minibuffer, as Emacs's
    /// `abort-recursive-edit`: what waited for it is told it was quit.
    pub fn abort_recursive_edit(&mut self) -> Result<()> {
        if self.minibuffer_innermost() {
            self.abort();
            return Err(Error::signal("quit", "Quit", Vec::new()));
        }
        let Some(edit) = self.keyboard.recursive_edits.pop() else {
            return Err(Error::user("No recursive edit is in progress"));
        };
        self.update_mode_lines();
        edit.answer.borrow_mut().get_or_insert(Err(Error::signal("quit", "Quit", Vec::new())));
        Err(Error::signal("quit", "Quit", Vec::new()))
    }

    /// Leaves every recursive edit and minibuffer, back to the top level,
    /// as Emacs's `top-level`.
    pub fn top_level(&mut self) {
        for _ in 0..self.minibuffer_depth() {
            self.abort();
        }
        while let Some(edit) = self.keyboard.recursive_edits.pop() {
            edit.answer.borrow_mut().get_or_insert(Err(Error::signal("quit", "Quit", Vec::new())));
        }
        if let Some(reader) = self.keyboard.reader.take() {
            reader.answer.borrow_mut().get_or_insert(Err(Error::signal("quit", "Quit", Vec::new())));
        }
        self.update_mode_lines();
        self.message("Back to top level");
    }
}
