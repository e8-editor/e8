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
use crate::vfs as fs;
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
    /// The keys of the sequence being read as they came, before translation.
    pub(crate) raw_keys: Vec<Key>,
    /// The keys of the last sequence read as they came, before translation.
    pub(crate) this_command_raw_keys: Vec<Key>,
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
    /// Whether a key is being handled, so the editor is not idle, as
    /// Emacs's `timer_idleness_start_time` is unset while it reads one.
    pub(crate) handling_key: bool,
    /// How the terminal is read, as `current-input-mode` says: interrupts
    /// rather than CBREAK, `^S`/`^Q` flow control, the eighth bit as meta,
    /// and the key that quits. E8's front ends read keys themselves, so
    /// only the quit key changes anything ([ADR 0079]).
    ///
    /// [ADR 0079]: ../../../../docs/adr/0079-the-keyboards-odds-and-ends.md
    pub(crate) input_mode: InputMode,
    /// The file `open-dribble-file` writes every key typed to, in the
    /// file system the editor uses, which is a tree in memory on the web.
    pub(crate) dribble: Option<fs::File>,
}

/// How a terminal reads keys, as `current-input-mode` lists it.
#[derive(Clone, Debug)]
pub struct InputMode {
    pub interrupt: bool,
    pub flow: bool,
    /// `true`, `"encoded"`, or nil for ignoring the eighth bit.
    pub meta: Value,
    /// The character that quits, `C-g` to begin with.
    pub quit: u32,
}

impl Default for InputMode {
    fn default() -> InputMode {
        InputMode { interrupt: true, flow: false, meta: Value::Bool(true), quit: 7 }
    }
}

impl Default for Keyboard {
    fn default() -> Keyboard {
        Keyboard {
            reader: None,
            recursive_edits: Vec::new(),
            lossage: VecDeque::new(),
            lossage_size: LOSSAGE_SIZE,
            this_command_keys: Vec::new(),
            raw_keys: Vec::new(),
            this_command_raw_keys: Vec::new(),
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
            handling_key: false,
            input_mode: InputMode::default(),
            dribble: None,
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
        // Keys run their commands meanwhile, but sleep-for reads none, as
        // Emacs's waits with read_kbd 0, for waiting-for-user-input-p.
        let result = self.wait_for_answer_reading(&asker, &answer, false);
        self.keyboard.sleeping.retain(|s| !std::rc::Rc::ptr_eq(s, &answer));
        self.cancel_timer(timer);
        result.map(|_| ())
    }

    /// Waits `secs` seconds of real time, running timers as they come due
    /// and output as processes write it, as Emacs's wait_reading_process_output
    /// does when it is not reading the keyboard.
    fn sleep_without_input(&mut self, secs: f64) {
        self.not_awaiting_input(|ed| ed.sleep_without_input_for(secs));
    }

    fn sleep_without_input_for(&mut self, secs: f64) {
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
                self.keyboard.this_command_raw_keys = reader.keys.clone();
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
        self.keyboard.this_command_raw_keys = std::mem::take(&mut self.keyboard.raw_keys);
    }

    /// The keys of the last key sequence read, by the command loop or
    /// `read-key-sequence`, as they came before `input-decode-map` and
    /// `key-translation-map` and Shift translation, as Emacs's
    /// `this-single-command-raw-keys`; while a prefix waits, those read so far.
    pub fn this_single_command_raw_keys(&self) -> &[Key] {
        if self.keyboard.pending_keys.is_empty() { &self.keyboard.this_command_raw_keys } else { &self.keyboard.raw_keys }
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

    /// The buffers of the minibuffers open, the outermost first, as the
    /// active part of Emacs's `minibuffer-list`.
    pub fn active_minibuffers(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.outer_prompts.iter().map(|outer| outer.minibuffer).collect();
        if self.prompt.is_some() {
            ids.push(self.minibuffer_id);
        }
        ids
    }

    /// How deep the open minibuffer whose buffer is `id` is, the outermost
    /// being 1, or 0 when it is no open minibuffer, as Emacs's
    /// `this_minibuffer_depth`.
    pub fn this_minibuffer_depth(&self, id: u64) -> usize {
        self.active_minibuffers().iter().position(|&m| m == id).map_or(0, |i| i + 1)
    }

    /// Whether the buffer `id` is the innermost open minibuffer, as Emacs's
    /// `innermost-minibuffer-p`.
    pub fn innermost_minibuffer_p(&self, id: u64) -> bool {
        let depth = self.this_minibuffer_depth(id);
        depth > 0 && depth == self.minibuffer_depth()
    }

    /// Whether the buffer `id` is an open minibuffer that no recursive edit
    /// was entered inside, as Emacs's `minibuffer-innermost-command-loop-p`.
    pub fn minibuffer_innermost_command_loop_p(&self, id: u64) -> bool {
        let depth = self.this_minibuffer_depth(id);
        depth > 0 && self.keyboard.recursive_edits.last().is_none_or(|edit| edit.minibuffers < depth)
    }

    /// Quits the current buffer's minibuffer and every one opened inside
    /// it, as Emacs's `abort-minibuffers`, asking first when that is more
    /// than the innermost.
    pub fn abort_minibuffers(&mut self) -> Result<()> {
        let id = self.buffer().id;
        let depth = self.this_minibuffer_depth(id);
        if depth == 0 {
            return Err(Error::new("Not in a minibuffer"));
        }
        if !self.minibuffer_innermost_command_loop_p(id) {
            return Err(Error::new("Not in most nested command loop"));
        }
        let level = self.minibuffer_depth();
        let levels = level - depth + 1;
        if levels > 1 && !self.yes_or_no_p(&format!("Abort {levels} minibuffer levels? "))? {
            return Ok(());
        }
        for _ in 0..levels {
            // The prompt an inner one opened inside comes back, to be quit
            // in turn, as does the one M-x's own minibuffer opened inside
            // when this runs from M-x.
            self.resume_outer_minibuffer();
            self.abort_with(minibuffer_quit);
        }
        // As minibuffer-quit-recursive-edit: the read signals
        // minibuffer-quit, which leaves typeahead and a keyboard macro going.
        Err(minibuffer_quit())
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

impl Editor {
    /// How long the editor has been idle, in seconds, or `None` while a
    /// key is being handled, as Emacs's `current-idle-time` is nil while
    /// it is not idle ([ADR 0079]).
    ///
    /// [ADR 0079]: ../../../../docs/adr/0079-the-keyboards-odds-and-ends.md
    pub fn current_idle_time(&self) -> Option<f64> {
        (!self.keyboard.handling_key).then(|| self.idle_seconds())
    }

    /// Forgets the keys `this-command-keys` gives, and, unless
    /// `keep_record`, the keys typed lately too, as
    /// `clear-this-command-keys`.
    pub fn clear_this_command_keys(&mut self, keep_record: bool) {
        // Emacs clears the command's keys and, without KEEP-RECORD, the
        // keys typed lately; `this-single-command-raw-keys` it keeps.
        self.keyboard.this_command_keys.clear();
        if !keep_record {
            self.keyboard.lossage.clear();
        }
    }

    /// Makes `this-command-keys` give these keys, as
    /// `set--this-command-keys`; a key sequence's description, as
    /// `this-command-keys` gives one.
    pub fn set_this_command_keys(&mut self, keys: &str) -> Result<()> {
        let keys = Key::parse_seq(keys).ok_or_else(|| Error::new(format!("Not a key sequence: {keys}")))?;
        self.keyboard.this_command_keys = keys.clone();
        self.keyboard.this_command_raw_keys = keys;
        Ok(())
    }

    /// How the terminal is read, as `current-input-mode`.
    pub fn current_input_mode(&self) -> InputMode {
        self.keyboard.input_mode.clone()
    }

    /// Sets how the terminal is read, as `set-input-mode` and the four
    /// that set one part each. Only the quit key changes anything.
    pub fn set_input_mode(&mut self, mode: InputMode) {
        self.keyboard.input_mode = mode;
    }

    /// Starts writing every key typed to a file, closing the one open, as
    /// `open-dribble-file`; no name closes it.
    pub fn open_dribble_file(&mut self, name: Option<&str>) -> Result<()> {
        self.keyboard.dribble = None;
        let Some(name) = name else { return Ok(()) };
        let path = self.expand_file_name(name);
        self.check_permission(&format!("write {}", crate::files::abbreviate_path(&path)))?;
        // The file records every key typed, passwords among them, so it is
        // made afresh and readable only by its owner, as Emacs makes it.
        let mut options = fs::File::options();
        options.write(true).create_new(true);
        // Only the real file system has permissions; the tree in memory
        // the web build uses has none, as vfs.rs's own cfgs read.
        #[cfg(all(unix, not(any(target_arch = "wasm32", feature = "memory-fs"))))]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if fs::symlink_metadata(&path).is_ok() {
            let _ = fs::remove_file(&path);
        }
        let file = options.open(&path).map_err(|e| crate::fileops::file_error("Opening output file", &e, &[&path]))?;
        self.keyboard.dribble = Some(file);
        Ok(())
    }

    /// Writes a key to the dribble file, if one is open. A file that
    /// cannot be written is closed, as Emacs stops dribbling on an error.
    pub(crate) fn write_to_dribble(&mut self, key: Key) {
        use std::io::Write;
        let Some(file) = self.keyboard.dribble.as_mut() else { return };
        // A plain character as itself, anything else as `<description>`,
        // as keyboard.c writes a character's byte and a symbol's name.
        let described = format_keys(std::slice::from_ref(&key));
        let text = match key.printable() {
            Some(c) if described == c.to_string() => described,
            _ => format!("<{described}>"),
        };
        if write!(file, "{text}").and_then(|()| file.flush()).is_err() {
            self.keyboard.dribble = None;
        }
    }

    /// Puts an event into the keyboard macro being defined, as
    /// `store-kbd-macro-event`; it is ignored when none is.
    pub fn store_kbd_macro_event(&mut self, key: &str) -> Result<()> {
        let key = Key::parse(key).ok_or_else(|| Error::new(format!("Not a key: {key}")))?;
        if let Some(keys) = &mut self.defining_macro {
            keys.push(key);
        }
        Ok(())
    }
}

/// A character with a modifier folded into it, as `char-resolve-modifiers`:
/// Shift upper-cases a letter and is dropped on a control character or
/// space; Control makes `C-a` 1, `C-?` 127 and `C-SPC` 0. A character
/// that is no ASCII one takes no modifier into itself, as character.c's
/// `char_resolve_modifier_mask` leaves it.
pub fn char_resolve_modifiers(code: u32) -> u32 {
    const CTRL: u32 = 1 << 26;
    const SHIFT: u32 = 1 << 25;
    let mut code = code;
    // A character that is no ASCII one keeps its modifiers.
    if code & !MODIFIER_MASK > 0x7F {
        return code;
    }
    let low = |c: u32| c & 0o377;
    if code & SHIFT != 0 {
        // Shift means something only on a letter; on a control character
        // or space it is dropped, and elsewhere it stays.
        if (0x41..=0x5A).contains(&low(code)) {
            code &= !SHIFT;
        } else if (0x61..=0x7A).contains(&low(code)) {
            code = (code & !SHIFT) - 0x20;
        } else if code & !MODIFIER_MASK <= 0x20 {
            code &= !SHIFT;
        }
    }
    if code & CTRL != 0 {
        if low(code) == 0x20 {
            code &= !0o177 & !CTRL;
        } else if low(code) == 0x3F {
            code = 0o177 | (code & !0o177 & !CTRL);
        } else if (0o101..=0o132).contains(&(code & 0o137)) || (0o100..=0o137).contains(&(code & 0o177)) {
            code &= 0o37 | (!0o177 & !CTRL);
        }
    }
    code
}

/// The bits above a character's own code that hold its modifiers, as
/// Emacs's `CHAR_MODIFIER_MASK`: alt, super, hyper, shift, control, meta.
const MODIFIER_MASK: u32 = (1 << 22) | (1 << 23) | (1 << 24) | (1 << 25) | (1 << 26) | (1 << 27);

impl Editor {
    /// Reports an error the command loop did not handle: its message in
    /// the echo area with `context` before it, and the bell, as Emacs's
    /// `command-error-default-function` does. `--batch` writes it to
    /// standard error instead, as Emacs's does with no frame up.
    pub fn command_error_default_function(&mut self, message: &str, context: &str, condition: Option<&str>) -> Result<()> {
        // Leaving a minibuffer only rings; any other error throws away
        // what was typed ahead first, as keyboard.c does.
        if condition == Some("minibuffer-quit") {
            self.message(format!("{context}{message}"));
            return self.ding();
        }
        self.discard_input();
        self.show_error(format!("{context}{message}"));
        self.ding()
    }

    /// Selects the frame a focus-in event names, as
    /// `internal-handle-focus-in` does; anything else is an error.
    pub fn internal_handle_focus_in(&mut self, event: &[Value]) -> Result<()> {
        let kind = event.first().and_then(Value::as_str);
        let frame = match (kind, event.get(1)) {
            (Some("focus-in"), Some(Value::Frame(id))) => *id,
            _ => return Err(Error::new("invalid focus-in event")),
        };
        // Emacs leaves a frame that is already selected alone, and makes
        // a switch-frame event for any other; E8 selects it here.
        if self.selected_frame() == frame { Ok(()) } else { self.select_frame(frame) }
    }
}

/// The error a minibuffer quit by `abort-minibuffers` signals, as Emacs's
/// `minibuffer-quit`, a kind of `quit`.
fn minibuffer_quit() -> Error {
    Error::signal("minibuffer-quit", "Quit", Vec::new())
}
