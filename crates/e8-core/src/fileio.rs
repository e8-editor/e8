//! Reading and writing visited files, as Emacs's fileio.c and the parts of
//! files.el that touch the disk: decoding and encoding, backups, the
//! visited file's modification time, auto-saving, and reverting.

use crate::vfs as fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::buffer::Buffer;
use crate::coding::{Coding, Eol};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// What a buffer knows about the file it visits, beyond its name.
#[derive(Clone, Debug, Default)]
pub struct FileState {
    /// When the file was last modified as of visiting or saving it, as
    /// Emacs's `visited-file-modtime`; `None` if it did not exist then.
    pub(crate) modtime: Option<SystemTime>,
    /// Whether `modtime` is known. After the buffer is made to visit
    /// another file it is not, and the file counts as unchanged, as a
    /// cleared modtime does in Emacs.
    pub(crate) modtime_known: bool,
    /// Whether the file was backed up since it was visited, as Emacs's
    /// `buffer-backed-up`: only the first save makes a backup.
    pub(crate) backed_up: bool,
    /// Where the buffer is auto-saved, as `buffer-auto-save-file-name`;
    /// `None` while auto-saving is off.
    pub(crate) auto_save: Option<PathBuf>,
    /// The buffer's tick when it was last auto-saved or saved.
    pub(crate) auto_saved_tick: u64,
    /// The buffer's tick when it was last visited, saved or reverted, as
    /// Emacs's SAVE_MODIFF.
    pub(crate) saved_tick: u64,
    /// Lets edits go ahead although the file changed on disk, while the
    /// user's answer or a revert has them made.
    pub(crate) allow_supersession: bool,
    /// Set when an edit was refused because the file changed on disk, for
    /// the editor to ask what to do.
    pub(crate) threatened: bool,
    /// Whether this buffer holds its file's lock, `.#name`.
    pub(crate) locked: bool,
    /// Whether the user chose to edit without the lock another holds.
    pub(crate) lock_ignored: bool,
    /// Who holds the lock, when an edit was refused because another does,
    /// for the editor to ask what to do.
    pub(crate) lock_threat: Option<String>,
}

/// The modification time of a file, if it exists.
fn modtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Where Emacs auto-saves a file: `#name#` beside it.
pub fn auto_save_file_name(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("#{name}#"))
}

/// Where the first save backs a file up: `name~` beside it, as Emacs's
/// `make-backup-file-name` without version control.
pub fn backup_file_name(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push("~");
    PathBuf::from(name)
}

/// Whether files there are backed up, as Emacs's
/// `normal-backup-enable-predicate`: not in the temporary directory.
fn backup_enabled(path: &Path) -> bool {
    let temp = crate::clock::temp_dir();
    let real_temp = fs::canonicalize(&temp).unwrap_or_else(|_| temp.clone());
    let real = path.parent().and_then(|p| fs::canonicalize(p).ok()).unwrap_or_else(|| path.to_path_buf());
    !(path.starts_with(&temp) || real.starts_with(&real_temp))
}

/// Reads a file and decodes it, in `coding` if given, as
/// `coding-system-for-read` gives one, else as the file says it is or its
/// bytes look, as Emacs's `set-auto-coding` and detection decide.
/// Where new text differs from old, as replacing one with the other keeps
/// what is the same at the start and the end, in characters: the same
/// `prefix`, then what differs, to `old_end` in the old text and `new_end`
/// in the new. Found walking both texts from each end, with no copy of
/// either.
pub(crate) struct Difference {
    pub(crate) prefix: usize,
    pub(crate) old_end: usize,
    pub(crate) new_end: usize,
}

impl Difference {
    pub(crate) fn between(old: ropey::RopeSlice, new: &str) -> Difference {
        let (old_len, new_len) = (old.len_chars(), new.chars().count());
        let prefix = old.chars().zip(new.chars()).take_while(|(a, b)| a == b).count();
        let room = old_len.min(new_len) - prefix;
        let suffix = old.chars_at(old_len).reversed().zip(new.chars().rev()).take(room).take_while(|(a, b)| a == b).count();
        Difference { prefix, old_end: old_len - suffix, new_end: new_len - suffix }
    }

    /// What of the new text replaces the old.
    pub(crate) fn middle<'a>(&self, new: &'a str) -> &'a str {
        let byte = |k: usize| new.char_indices().nth(k).map_or(new.len(), |(i, _)| i);
        &new[byte(self.prefix)..byte(self.new_end)]
    }

    /// Where a position in the old text goes: the same in the start kept,
    /// moved with the end kept, and in proportion within what changes.
    pub(crate) fn keep(&self, pos: usize) -> usize {
        if pos <= self.prefix {
            pos
        } else if pos >= self.old_end {
            pos + self.new_end - self.old_end
        } else {
            self.prefix + (pos - self.prefix) * (self.new_end - self.prefix) / (self.old_end - self.prefix)
        }
    }
}

pub(crate) fn read_file(path: &Path, coding: impl Into<crate::coding::FileCoding>) -> Result<(String, Coding)> {
    let bytes = fs::read(path).map_err(|e| crate::fileops::file_error("Opening input file", &e, &[path]))?;
    Ok(crate::coding::decode_file(&bytes, coding))
}

impl Buffer {
    /// The buffer's coding system, from `buffer-file-coding-system`.
    pub(crate) fn coding(&self) -> Coding {
        match self.locals.get("buffer-file-coding-system") {
            Some(Value::Str(name)) => Coding::parse(name).map_or_else(Coding::default, |c| c.with_eol(Some(c.eol.unwrap_or(Eol::Unix)))),
            // Not visited from a file: the variable's default.
            _ => Coding::named("utf-8-unix"),
        }
    }

    pub(crate) fn set_coding(&mut self, coding: Coding) {
        self.locals.insert("buffer-file-coding-system".into(), Value::Str(coding.name()));
    }

    /// What the mode line shows for the coding, as `U:` or `-\`.
    pub fn coding_mnemonic(&self) -> String {
        self.coding().mnemonic()
    }

    /// Whether the buffer has changes its auto-save file does not have yet.
    pub(crate) fn needs_auto_save(&self) -> bool {
        self.file.auto_save.is_some() && self.is_modified() && self.file.auto_saved_tick != self.modified_tick()
    }

    /// Whether the file changed on disk since it was visited or saved: the
    /// negation of Emacs's `verify-visited-file-modtime`, for a file that
    /// still exists.
    pub fn visited_file_changed(&self) -> bool {
        let Some(path) = &self.path else { return false };
        if !self.file.modtime_known {
            return false;
        }
        match modtime(path) {
            Some(now) => self.file.modtime != Some(now),
            None => false,
        }
    }

    /// Takes the file's current modification time as the one visited, as
    /// visiting, saving and reverting do, the buffer being as the file is.
    pub fn set_visited_file_modtime(&mut self) {
        self.take_visited_file_modtime();
        self.file.saved_tick = self.modified_tick();
    }

    /// Takes the file's current modification time as the one visited, as
    /// Emacs's `set-visited-file-modtime` does, the text aside.
    pub fn take_visited_file_modtime(&mut self) {
        self.file.modtime = self.path.as_deref().and_then(modtime);
        self.file.modtime_known = true;
    }

    /// Whether the buffer was auto-saved since it was visited or last
    /// saved, as Emacs's `recent-auto-save-p`.
    pub fn recent_auto_save_p(&self) -> bool {
        self.file.auto_saved_tick > self.file.saved_tick
    }

    /// Takes the buffer as auto-saved as it is now, as Emacs's
    /// `set-buffer-auto-saved`.
    pub fn set_buffer_auto_saved(&mut self) {
        self.file.auto_saved_tick = self.modified_tick();
    }

    /// Takes a time as the visited file's modification time, as Emacs's
    /// `set-visited-file-modtime` given one, `None` meaning the file does
    /// not exist, as its -1 does.
    pub fn set_visited_file_modtime_to(&mut self, time: Option<SystemTime>) {
        self.file.modtime = time;
        self.file.modtime_known = true;
    }

    /// When the visited file was last modified, as the system says now.
    pub fn visited_file_modtime_now(&self) -> Option<SystemTime> {
        self.path.as_deref().and_then(modtime)
    }

    /// Forgets the visited file's modification time, as Emacs's
    /// `clear-visited-file-modtime`, so the file is taken as unchanged.
    pub fn clear_visited_file_modtime(&mut self) {
        self.file.modtime = None;
        self.file.modtime_known = false;
    }

    /// The visited file's modification time, as Emacs's
    /// `visited-file-modtime`: `Ok(Some(time))`, `Ok(None)` if the file did
    /// not exist when visited, and `Err(())` if none is recorded, which
    /// Emacs gives as 0.
    pub fn visited_file_modtime(&self) -> std::result::Result<Option<SystemTime>, ()> {
        if self.file.modtime_known { Ok(self.file.modtime) } else { Err(()) }
    }

    /// Whether the visited file is as it was when visited or last saved,
    /// as Emacs's `verify-visited-file-modtime`: true for a buffer visiting
    /// no file or with no time recorded, and false for a file deleted
    /// since, or made where there was none.
    pub fn verify_visited_file_modtime(&self) -> bool {
        let Some(path) = &self.path else { return true };
        !self.file.modtime_known || modtime(path) == self.file.modtime
    }

    /// Refuses the first change to an unmodified buffer whose file changed
    /// on disk, as Emacs's lock_file does before asking
    /// `ask-user-about-supersession-threat`. A file with the same text as
    /// the buffer is no threat, as `userlock--check-content-unchanged` says.
    pub(crate) fn check_supersession(&mut self) -> Result<()> {
        if self.is_modified() || self.file.allow_supersession || !self.visited_file_changed() {
            return Ok(());
        }
        let path = self.path.clone().expect("visited_file_changed checks it");
        if read_file(&path, None).is_ok_and(|(text, _)| *self.text() == text.as_str()) {
            self.set_visited_file_modtime();
            return Ok(());
        }
        self.file.threatened = true;
        Err(Error::new(format!("File changed on disk: {}", crate::files::abbreviate_path(&path))))
    }
}

impl Editor {
    /// Which coding to read a file by this name with: `coding-system-for-read`
    /// if it names one, and what `file-coding-system-alist` says for the
    /// name, which the file's own `coding:` cookie wins over, as Emacs's
    /// `insert-file-contents` asks `set-auto-coding` first.
    ///
    /// `args` are `insert-file-contents`'s own arguments, the file's name
    /// first, which a function in the alist is handed.
    pub(crate) fn file_coding_for_read(&mut self, args: &[Value]) -> Result<crate::coding::FileCoding> {
        let forced = self.coding_for_read();
        if forced.is_some() {
            return Ok(crate::coding::FileCoding { forced, by_name: None });
        }
        let found = self.find_operation_coding_system("insert-file-contents", args)?;
        let by_name = found.and_then(|(decode, _)| decode.as_str().and_then(Coding::parse)).filter(|c| !c.is_undecided());
        Ok(crate::coding::FileCoding { forced, by_name })
    }

    /// The coding to write a file by this name with: `coding-system-for-write`
    /// first, then, for a buffer with no `buffer-file-coding-system` of its
    /// own, what `file-coding-system-alist` says for the name, then the
    /// buffer's own, as Emacs's choose_write_coding_system decides. A
    /// buffer visiting a file has its own, so saving keeps the coding it
    /// was read in.
    ///
    /// `args` are `write-region`'s own arguments, the file's name third,
    /// which a function in the alist is handed.
    pub(crate) fn file_coding_for_write(&mut self, args: &[Value]) -> Result<Coding> {
        let forced = self.variable("coding-system-for-write").and_then(|v| v.as_str().and_then(Coding::parse));
        let has_own = self.buffer().locals.contains_key("buffer-file-coding-system");
        if forced.is_none() && !has_own {
            let found = self.find_operation_coding_system("write-region", args)?;
            if let Some(coding) = found.and_then(|(_, encode)| encode.as_str().and_then(Coding::parse)).filter(|c| !c.is_undecided()) {
                let own = self.coding_for_write();
                return Ok(coding.with_eol(Some(coding.eol.or(own.eol).unwrap_or(Eol::Unix))));
            }
        }
        Ok(self.coding_for_write())
    }

    /// The coding `coding-system-for-read` says to read files with, if any.
    pub(crate) fn coding_for_read(&self) -> Option<Coding> {
        self.variable("coding-system-for-read").and_then(|v| v.as_str().and_then(Coding::parse))
    }

    /// The coding to write the current buffer with: `coding-system-for-write`
    /// if it names one, with the buffer's line ends if it gives none, else
    /// the buffer's own, as Emacs's choose_write_coding_system decides.
    pub(crate) fn coding_for_write(&self) -> Coding {
        // A buffer with no coding of its own, as a new file's, has the
        // variable's default, which prefer-coding-system sets, and one
        // still undecided, as an ASCII file's, writes in the default with
        // its own line ends, as select-safe-coding-system chooses.
        let default = self.default_value("buffer-file-coding-system").and_then(|v| v.as_str().and_then(Coding::parse));
        let own = match (self.buffer().locals.get("buffer-file-coding-system"), default) {
            (None, Some(c)) => c.with_eol(Some(c.eol.unwrap_or(Eol::Unix))),
            (Some(_), Some(c)) if self.buffer().coding().is_undecided() && !c.is_undecided() => {
                let own = self.buffer().coding();
                c.with_eol(Some(own.eol.or(c.eol).unwrap_or(Eol::Unix)))
            }
            _ => self.buffer().coding(),
        };
        match self.variable("coding-system-for-write").and_then(|v| v.as_str().and_then(Coding::parse)) {
            Some(coding) => coding.with_eol(Some(coding.eol.or(own.eol).unwrap_or(Eol::Unix))),
            None => own,
        }
    }

    /// Decodes a visited file into a new buffer, noting its coding and
    /// modification time. A missing file gives an empty buffer.
    pub(crate) fn read_visited_file(path: &Path, coding: impl Into<crate::coding::FileCoding>) -> Result<Buffer> {
        // A new file is written with buffer-file-coding-system's default.
        let (text, coding) = match fs::metadata(path) {
            Ok(_) => read_file(path, coding).map(|(text, coding)| (text, Some(coding)))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), None),
            Err(e) => return Err(e.into()),
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let mut buffer = Buffer::new(name);
        buffer.set_text(&text);
        buffer.path = Some(path.to_path_buf());
        crate::files::set_file_default_directory(&mut buffer, path);
        if let Some(coding) = coding {
            buffer.set_coding(coding);
        }
        buffer.set_visited_file_modtime();
        Ok(buffer)
    }

    /// Writes the current buffer to its file, as Emacs's
    /// `basic-save-buffer-2`: the first save backs the old file up as
    /// `name~`, renaming it unless `backup-by-copying` or a hard link says to
    /// copy, and the file is written in the buffer's coding, through to the
    /// disk. With `file-precious-flag`, the text goes to a new file that
    /// then replaces the old one, so a failed write leaves the old intact.
    /// Afterwards the buffer is unmodified and its auto-save file deleted.
    pub fn write_visited_file(&mut self) -> Result<()> {
        let make_backups = self.variable("make-backup-files").is_none_or(|v| v.is_true());
        let by_copying = self.variable("backup-by-copying").is_some_and(|v| v.is_true());
        let precious = self.variable("file-precious-flag").is_some_and(|v| v.is_true());
        let delete_auto_save = self.variable("delete-auto-save-files").is_none_or(|v| v.is_true());
        let path = self.buffers[self.current].path.clone().ok_or_else(|| Error::new("Buffer is not visiting a file"))?;
        // A file a handler serves is written through it, as basic-save-buffer
        // writes with write-region.
        let name = path.display().to_string();
        if self.find_file_name_handler(&name, "write-region").is_some() {
            return self.write_region(crate::filefns::WriteSource::Buffer, &name, false, crate::filefns::Visit::Yes, false);
        }
        self.check_permission(&format!("write {}", crate::files::abbreviate_path(&path)))?;
        // save-buffer writes the whole buffer, visiting it, as Emacs's does.
        let whole = [Value::Null, Value::Null, Value::Str(name.clone()), Value::Null, Value::Bool(true), Value::Null];
        let coding = self.file_coding_for_write(&whole)?;
        let b = &mut self.buffers[self.current];
        // Through symbolic links to the file itself, as Emacs's file-chase-links.
        let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let (bytes, coding) = coding.encode(&b.text().to_string());
        let old = fs::metadata(&real).ok();
        let mut renamed = false;
        if let Some(meta) = &old
            && make_backups
            && !b.file.backed_up
            && backup_enabled(&real)
        {
            #[cfg(unix)]
            let linked = std::os::unix::fs::MetadataExt::nlink(meta) > 1;
            #[cfg(not(unix))]
            let linked = { let _ = meta; false };
            let backup = backup_file_name(&real);
            let result = if by_copying || precious || linked {
                fs::copy(&real, &backup).map(drop)
            } else {
                renamed = true;
                fs::rename(&real, &backup)
            };
            result.map_err(|e| Error::new(format!("Cannot write backup file {}: {e}", backup.display())))?;
            b.file.backed_up = true;
        }
        let written = if precious {
            let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let temp = real.with_file_name(format!(".{name}.e8-{}", crate::clock::process_id()));
            write_synced(&temp, &bytes, old.as_ref()).and_then(|()| fs::rename(&temp, &real)).inspect_err(|_| {
                let _ = fs::remove_file(&temp);
            })
        } else {
            write_synced(&real, &bytes, old.as_ref().filter(|_| renamed))
        };
        written.map_err(|e| Error::new(format!("Writing {}: {e}", path.display())))?;
        let b = &mut self.buffers[self.current];
        if coding != b.coding() {
            b.set_coding(coding);
        }
        b.mark_saved();
        b.set_visited_file_modtime();
        b.file.auto_saved_tick = b.modified_tick();
        if delete_auto_save && let Some(auto) = b.file.auto_save.clone() {
            let _ = fs::remove_file(auto);
        }
        Ok(())
    }

    /// Replaces the current buffer's text with a file's, as reverting does,
    /// and returns the coding the file was read with. Only what differs is
    /// replaced, as Emacs's `insert-file-contents` with REPLACE: text the
    /// same at the start and the end stays, with point and the mark in it,
    /// and point within what changed keeps its place in proportion. The
    /// change can be undone. Read-only buffers are reverted too.
    pub fn replace_with_file(&mut self, path: &Path) -> Result<Coding> {
        // Reverting reads the whole file, replacing what is there.
        let name = Value::Str(path.display().to_string());
        let whole = [name, Value::Null, Value::Null, Value::Null, Value::Bool(true)];
        let coding = self.file_coding_for_read(&whole)?;
        let (new, coding) = read_file(path, coding)?;
        let b = &mut self.buffers[self.current];
        b.widen();
        let change = Difference::between(b.text().slice(..), &new);
        let point = change.keep(b.point());
        let read_only = std::mem::replace(&mut b.read_only, false);
        b.file.allow_supersession = true;
        let replaced = b.delete(change.prefix..change.old_end).and_then(|_| b.insert_at(change.prefix, change.middle(&new)));
        b.file.allow_supersession = false;
        b.read_only = read_only;
        replaced?;
        b.set_point(point);
        Ok(coding)
    }

    /// Reverts the current buffer to its file: replaces its text with the
    /// file's, then marks it unmodified and as visited now.
    pub fn revert_to_visited_file(&mut self) -> Result<()> {
        let b = &self.buffers[self.current];
        let path = b.path.clone().ok_or_else(|| Error::new("Buffer does not seem to be associated with any file"))?;
        if !fs::path_exists(&path) {
            return Err(Error::new(format!("File {} no longer exists!", path.display())));
        }
        // Reverting leaves the region as it was, as in Emacs.
        let changed = self.buffers[self.current].take_changed();
        let replaced = self.replace_with_file(&path);
        self.buffers[self.current].set_changed(changed);
        let coding = replaced?;
        let b = &mut self.buffers[self.current];
        b.set_coding(coding);
        b.mark_saved();
        b.set_visited_file_modtime();
        b.file.auto_saved_tick = b.modified_tick();
        Ok(())
    }

    /// Replaces the current buffer's text with its auto-save file's, as
    /// `recover-file` does once asked. The buffer is left modified, its
    /// coding kept, and point at the start.
    pub fn recover_from_auto_save(&mut self) -> Result<()> {
        let b = &self.buffers[self.current];
        let path = b.path.clone().ok_or_else(|| Error::new("This buffer is not visiting a file"))?;
        let auto = auto_save_file_name(&path);
        let (text, _) = read_file(&auto, None)?;
        let b = &mut self.buffers[self.current];
        let read_only = std::mem::replace(&mut b.read_only, false);
        b.file.allow_supersession = true;
        let len = b.len();
        let replaced = b.delete(0..len).and_then(|_| b.insert_at(0, &text));
        b.file.allow_supersession = false;
        b.read_only = read_only;
        replaced?;
        b.set_point(0);
        b.file.auto_saved_tick = b.modified_tick();
        Ok(())
    }

    /// Auto-saves every buffer that changed since it was last saved or
    /// auto-saved, as Emacs's `do-auto-save`, and says so unless `quiet`.
    /// Returns whether anything was written.
    pub fn do_auto_save(&mut self, quiet: bool) -> bool {
        let mut saved = false;
        let mut failed = None;
        for b in &mut self.buffers {
            if !b.needs_auto_save() {
                continue;
            }
            let auto = b.file.auto_save.clone().expect("needs_auto_save checks it");
            // Emacs writes auto-save files in its own coding, UTF-8 with
            // Unix line ends, whatever the visited file uses.
            match fs::write(&auto, b.text().to_string()) {
                Ok(()) => {
                    b.file.auto_saved_tick = b.modified_tick();
                    saved = true;
                }
                Err(e) => failed = Some(format!("Auto-saving {}: {e}", b.name)),
            }
        }
        if let Some(message) = failed {
            self.message(message);
        } else if saved && !quiet {
            self.message("Auto-saving...done");
        }
        saved
    }

    /// Makes the current buffer visit another file, as Emacs's
    /// `set-visited-file-name`: the buffer takes the file's name, the next
    /// save backs nothing up unless the file is there, and auto-saving
    /// moves to the new name.
    pub fn set_visited_file_name(&mut self, path: &Path) -> Result<()> {
        self.set_visited_file_name_along(path, false)
    }

    /// As [`Editor::set_visited_file_name`]; `along_with_file` says the file
    /// was renamed with the buffer, which then stays as modified as it was,
    /// knowing its file, as Emacs's ALONG-WITH-FILE.
    pub fn set_visited_file_name_along(&mut self, path: &Path, along_with_file: bool) -> Result<()> {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::new("Not a file name"))?;
        let b = &self.buffers[self.current];
        let name = if b.name == name { name } else { self.unique_buffer_name(&name) };
        let b = &mut self.buffers[self.current];
        b.name = name;
        b.path = Some(path.to_path_buf());
        crate::files::set_file_default_directory(b, path);
        if !along_with_file {
            b.file.modtime_known = false;
            b.file.backed_up = false;
            b.set_modified(true);
        }
        // An auto-save file there is moves to the new name, as Emacs's
        // set-visited-file-name renames it.
        if let Some(old) = b.file.auto_save.take() {
            let new = auto_save_file_name(path);
            if old != new && fs::path_exists(&old) {
                let _ = fs::rename(&old, &new);
            }
            b.file.auto_save = Some(new);
        }
        Ok(())
    }

    /// Makes the current buffer visit no file, giving up the file's lock,
    /// as Emacs's `set-visited-file-name` with nil.
    pub fn forget_visited_file(&mut self) {
        let b = &mut self.buffers[self.current];
        if std::mem::take(&mut b.file.locked)
            && let Some(path) = &b.path
        {
            crate::filelock::unlock(path);
        }
        b.path = None;
        b.file.modtime_known = false;
    }

    /// Asks the front end to exit, as Emacs's `kill-emacs`.
    pub fn kill_emacs(&mut self) -> Result<()> {
        self.kill_emacs_with_status(0)
    }

    /// As [`Editor::kill_emacs`], the program exiting with `status`, as
    /// `(kill-emacs 1)` does: batch mode's runs report failure this way.
    pub fn kill_emacs_with_status(&mut self, status: i32) -> Result<()> {
        self.check_permission("quit E8")?;
        self.exit_status = status;
        if let Err(e) = self.run_hooks("kill-emacs-hook") {
            self.message(format!("Error in kill-emacs-hook: {e}"));
        }
        self.hang_up_processes();
        // As Emacs's unlock_all_files on the way out.
        self.release_all_locks();
        self.quit = true;
        Ok(())
    }

    /// Turns auto-saving on or off for the current buffer, as
    /// `auto-save-mode`. Only buffers visiting files auto-save.
    pub fn set_auto_save(&mut self, on: bool) {
        let b = &mut self.buffers[self.current];
        b.file.auto_save = if on { b.path.as_deref().map(auto_save_file_name) } else { None };
    }

    /// Whether the current buffer auto-saves.
    pub fn auto_saving(&self) -> bool {
        self.buffers[self.current].file.auto_save.is_some()
    }

    /// Whether a file's auto-save file is newer than it, as
    /// `after-find-file` checks to suggest `recover-this-file`.
    pub fn has_newer_auto_save(path: &Path) -> bool {
        match (modtime(&auto_save_file_name(path)), modtime(path)) {
            (Some(auto), Some(file)) => auto > file,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

/// Writes bytes to a file and through to the disk, giving it `like`'s
/// permissions when it is new, as Emacs's `set-file-modes` after a backup
/// by renaming.
fn write_synced(path: &Path, bytes: &[u8], like: Option<&fs::Metadata>) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if let Some(meta) = like {
        fs::set_permissions(path, meta.permissions())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_save_and_backup_names_are_emacs_names() {
        let path = Path::new("/notes/today.org");
        assert_eq!(auto_save_file_name(path), Path::new("/notes/#today.org#"));
        assert_eq!(backup_file_name(path), Path::new("/notes/today.org~"));
    }

    #[test]
    fn a_difference_keeps_what_is_the_same_at_each_end() {
        let differ = |old: &str, new: &str| {
            let rope = ropey::Rope::from_str(old);
            let d = Difference::between(rope.slice(..), new);
            (d.prefix, d.old_end, d.new_end, d.middle(new).to_string())
        };
        assert_eq!(differ("héllo wörld", "héllo brave wörld"), (6, 6, 12, "brave ".into()));
        assert_eq!(differ("aaa", "aaaa"), (3, 3, 4, "a".into()));
        assert_eq!(differ("same", "same"), (4, 4, 4, String::new()));
        assert_eq!(differ("", "new"), (0, 0, 3, "new".into()));
        assert_eq!(differ("ünchanged ends", "ünc-h-anged ends"), (3, 4, 6, "-h-".into()));
        let d = Difference { prefix: 2, old_end: 6, new_end: 4 };
        assert_eq!((d.keep(1), d.keep(4), d.keep(8)), (1, 3, 6));
    }
}
