//! File notifications, as Emacs's kqueue.c gives them on macOS and the
//! BSDs: `kqueue-add-watch`, `kqueue-rm-watch` and `kqueue-valid-p`.
//!
//! A watch is a file opened for events only, registered with one kqueue
//! for the editor, its descriptor that file's descriptor, as in Emacs.
//! A watched directory keeps a listing of what is in it, and a write to it
//! is reported as the files created, deleted, renamed, written and changed
//! in it, found by comparing listings, as kqueue.c's
//! `kqueue_compare_dir_list` does.
//!
//! The kqueue is read on the editor's thread, as Emacs reads it when it
//! waits for input: a timer looks at it every [`POLL`] seconds while
//! anything is watched, takes every event waiting, and then calls each
//! watch's callback with `(DESCRIPTOR ACTIONS FILE [FILE1])`, as Emacs
//! queues a `file-notify` event whose handler calls it. Events waiting
//! together are merged as the kernel merges them, as in Emacs. Actions
//! are given as strings, as E8 gives Lisp's symbols. Elsewhere, Linux and
//! the web, there is no kqueue: `kqueue-add-watch` signals
//! `file-notify-error`, as kqueue.c does when it cannot make a kqueue.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// How often, in seconds, the kqueue is looked at while files are watched.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")), allow(dead_code))]
const POLL: f64 = 0.05;

/// The events kqueue-add-watch knows, in the order kqueue.c looks at them.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")), allow(dead_code))]
const ACTIONS: &[&str] = &["delete", "write", "extend", "attrib", "link", "rename", "revoke"];

/// A file-notify-error, a file-error, with its message and data as Emacs's.
fn notify_error(what: &str, data: Value) -> Error {
    crate::error::define_error("file-notify-error", "file-error");
    let shown = match &data {
        Value::Null => what.to_string(),
        Value::Str(s) => format!("{what}, {s}"),
        Value::Number(n) if n.fract() == 0.0 => format!("{what}, {}", *n as i64),
        other => format!("{what}, {other}"),
    };
    Error::signal("file-notify-error", shown, vec![Value::Str(what.to_string()), data])
}

/// The watches, newest first, as kqueue.c's watch_list.
#[derive(Default)]
pub(crate) struct Kqueue {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
    imp: imp::State,
}

impl Editor {
    /// Watches a file or directory for the events `flags` names, calling
    /// `callback` with each, as Emacs's `kqueue-add-watch`. Returns the
    /// watch's descriptor.
    pub fn kqueue_add_watch(&mut self, file: &Value, flags: &Value, callback: &Value) -> Result<Value> {
        let Some(name) = (match file {
            Value::Str(s) => Some(s.clone()),
            Value::Text(t) => Some(t.string.clone()),
            _ => None,
        }) else {
            return Err(crate::xfaces::wrong_type("stringp", file));
        };
        let file = directory_file_name(&self.expand_file_name(&name).display().to_string());
        if !crate::vfs::path_exists(std::path::Path::new(&file)) {
            return Err(Error::signal(
                "file-missing",
                format!("File does not exist: No such file or directory, {file}"),
                vec![Value::Str("File does not exist".into()), Value::Str("No such file or directory".into()), Value::Str(file)],
            ));
        }
        let flags: Vec<String> = match flags {
            Value::Null => Vec::new(),
            Value::List(items) => items.iter().filter_map(|f| f.as_str().map(str::to_string)).collect(),
            other => return Err(crate::xfaces::wrong_type("listp", other)),
        };
        let callable = match callback {
            Value::Function(_) => true,
            Value::Str(n) | Value::Symbol(n) => self.fboundp(n),
            _ => false,
        };
        if !callable {
            return Err(crate::xfaces::wrong_type("invalid-function", callback));
        }
        self.add_watch(file, flags, callback.clone())
    }

    /// Stops a watch, as Emacs's `kqueue-rm-watch`: true, or a
    /// `file-notify-error` if `descriptor` is not one.
    pub fn kqueue_rm_watch(&mut self, descriptor: &Value) -> Result<bool> {
        if !self.remove_watch(descriptor) {
            return Err(notify_error("Not a watch descriptor", descriptor.clone()));
        }
        Ok(true)
    }

    /// Whether a watch is still in place, as Emacs's `kqueue-valid-p`: not
    /// once removed, or once what it watched was deleted or renamed.
    pub fn kqueue_valid_p(&self, descriptor: &Value) -> bool {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
        return self.kqueue.imp.find(descriptor).is_some();
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")))]
        {
            let _ = descriptor;
            false
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")))]
    fn add_watch(&mut self, _file: String, _flags: Vec<String>, _callback: Value) -> Result<Value> {
        Err(notify_error("File watching is not available", Value::Null))
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")))]
    fn remove_watch(&mut self, _descriptor: &Value) -> bool {
        false
    }
}

/// A file name without the slash a directory's name may end in, as
/// Emacs's `directory-file-name`.
fn directory_file_name(name: &str) -> String {
    let trimmed = name.trim_end_matches('/');
    if trimmed.is_empty() && name.starts_with('/') {
        // "//" stays itself in Emacs; "/" and "///" are "/".
        if name == "//" { "//".into() } else { "/".into() }
    } else {
        trimmed.to_string()
    }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
mod imp {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    use super::{notify_error, ACTIONS, POLL};
    use crate::editor::Editor;
    use crate::error::{Error, Result};
    use crate::variables::Value;

    /// One entry of a directory's listing, as kqueue_directory_listing
    /// makes them: inode, name, modification and status change times, size.
    #[derive(Clone, PartialEq)]
    struct Entry {
        inode: u64,
        name: String,
        modified: (i64, i64),
        changed: (i64, i64),
        size: u64,
    }

    struct Watch {
        /// The file opened for events, whose number is the descriptor.
        fd: OwnedFd,
        file: String,
        flags: Vec<String>,
        callback: Value,
        /// What a directory held when last looked at, as kqueue.c's DIRLIST.
        listing: Option<Vec<Entry>>,
    }

    #[derive(Default)]
    pub(crate) struct State {
        kq: Option<OwnedFd>,
        timer: Option<u64>,
        watches: Vec<Watch>,
    }

    impl State {
        pub(super) fn find(&self, descriptor: &Value) -> Option<usize> {
            let Value::Number(n) = descriptor else { return None };
            self.watches.iter().position(|w| w.fd.as_raw_fd() as f64 == *n)
        }
    }

    /// What is in a directory, as kqueue_directory_listing makes it from
    /// directory-files-and-attributes: by name, last first, without "."
    /// and "..", each file's attributes its own, not those of what a link
    /// points to.
    fn listing(dir: &str) -> Vec<Entry> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut out: Vec<Entry> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let m = std::fs::symlink_metadata(e.path()).ok()?;
                Some(Entry {
                    inode: m.ino(),
                    name: e.file_name().to_string_lossy().into_owned(),
                    modified: (m.mtime(), m.mtime_nsec()),
                    changed: (m.ctime(), m.ctime_nsec()),
                    size: m.size(),
                })
            })
            .collect();
        out.sort_by(|a, b| b.name.cmp(&a.name));
        out
    }

    fn is_directory(file: &str) -> bool {
        std::fs::metadata(file).is_ok_and(|m| m.is_dir())
    }

    /// A file-error as Emacs's report_file_error makes one for a failed
    /// system call: what, why, the file.
    fn file_error(what: &str, e: &std::io::Error, file: &str) -> Error {
        crate::fileops::file_error(what, e, &[std::path::Path::new(file)])
    }

    fn note(action: &str) -> u32 {
        match action {
            "delete" => libc::NOTE_DELETE,
            "write" => libc::NOTE_WRITE,
            "extend" => libc::NOTE_EXTEND,
            "attrib" => libc::NOTE_ATTRIB,
            "link" => libc::NOTE_LINK,
            "rename" => libc::NOTE_RENAME,
            "revoke" => libc::NOTE_REVOKE,
            _ => 0,
        }
    }

    /// Events found for a watch, to call its callback with once every
    /// event waiting has been taken, as Emacs queues them.
    struct Pending {
        callback: Value,
        event: Value,
    }

    /// Queues an event if the watch asked for any of its actions, with the
    /// actions it did not ask for left out, as kqueue_generate_event.
    fn generate(w: &Watch, actions: Vec<&str>, file: &str, file1: Option<&str>, out: &mut Vec<Pending>) {
        let actions: Vec<Value> = actions.into_iter().filter(|a| w.flags.iter().any(|f| f == a)).map(|a| Value::Str(a.into())).collect();
        if actions.is_empty() {
            return;
        }
        let mut event = vec![Value::Number(w.fd.as_raw_fd() as f64), Value::List(actions), Value::Str(file.into())];
        if let Some(f1) = file1 {
            event.push(Value::Str(f1.into()));
        }
        out.push(Pending { callback: w.callback.clone(), event: Value::List(event) });
    }

    /// Compares a watched directory's listing with what it holds now and
    /// queues what changed, then keeps the new listing, as
    /// kqueue_compare_dir_list: files by inode and name, each file's name
    /// as it is in the directory.
    fn compare_listings(w: &mut Watch, out: &mut Vec<Pending>) {
        if !is_directory(&w.file) {
            let file = w.file.clone();
            generate(w, vec!["delete"], &file, None, out);
            return;
        }
        let old = w.listing.clone().unwrap_or_default();
        let fresh = listing(&w.file);
        let mut new_dl = fresh.clone();
        let mut pending: Vec<Entry> = Vec::new();
        let mut deleted: Vec<Entry> = Vec::new();
        let take = |list: &mut Vec<Entry>, i: usize| list.remove(i);
        for old_entry in &old {
            // The same inode: the same file, unchanged, written, changed
            // or renamed.
            if let Some(i) = new_dl.iter().position(|e| e.inode == old_entry.inode) {
                let new_entry = take(&mut new_dl, i);
                if new_entry == *old_entry {
                    continue;
                }
                if new_entry.name == old_entry.name {
                    if new_entry.modified != old_entry.modified {
                        generate(w, vec!["write"], &old_entry.name, None, out);
                    }
                    if new_entry.changed != old_entry.changed {
                        generate(w, vec!["attrib"], &old_entry.name, None, out);
                    }
                } else {
                    generate(w, vec!["rename"], &old_entry.name, Some(&new_entry.name), out);
                    deleted.insert(0, new_entry);
                }
                continue;
            }
            // Another file of the same name, for now.
            if let Some(i) = new_dl.iter().position(|e| e.name == old_entry.name) {
                let new_entry = take(&mut new_dl, i);
                pending.insert(0, new_entry);
                continue;
            }
            match pending.iter().position(|e| e.inode == old_entry.inode) {
                Some(i) => {
                    let new_entry = take(&mut pending, i);
                    generate(w, vec!["rename"], &old_entry.name, Some(&new_entry.name), out);
                }
                None => {
                    // Already reported as renamed to here.
                    if let Some(i) = deleted.iter().position(|e| e.name == old_entry.name) {
                        deleted.remove(i);
                        continue;
                    }
                    generate(w, vec!["delete"], &old_entry.name, None, out);
                }
            }
        }
        // New files, written to if they have something in them.
        for entry in &new_dl {
            generate(w, vec!["create"], &entry.name, None, out);
            if entry.size > 0 {
                generate(w, vec!["write"], &entry.name, None, out);
            }
        }
        // Files still pending, taken as written.
        for entry in &pending {
            generate(w, vec!["write"], &entry.name, None, out);
        }
        w.listing = Some(fresh);
    }

    impl Editor {
        pub(super) fn add_watch(&mut self, file: String, flags: Vec<String>, callback: Value) -> Result<Value> {
            let state = &mut self.kqueue.imp;
            // As kqueue.c, leaving 50 descriptors for the rest of the editor.
            let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            // SAFETY: getrlimit writes the one rlimit given it.
            let maxfd = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 { limit.rlim_cur as i64 } else { 256 };
            if maxfd - 50 < state.watches.len() as i64 {
                crate::error::define_error("file-notify-error", "file-error");
                return Err(Error::signal(
                    "file-notify-error",
                    format!("File watching not possible, no file descriptor left, {}", state.watches.len()),
                    vec![Value::Str("File watching not possible, no file descriptor left".into()), Value::Number(state.watches.len() as f64)],
                ));
            }
            if state.kq.is_none() {
                // SAFETY: kqueue takes nothing and gives a new descriptor or -1.
                let kq = unsafe { libc::kqueue() };
                if kq < 0 {
                    return Err(notify_error("File watching is not available", Value::Null));
                }
                // SAFETY: kq is a descriptor just made, owned by nothing else.
                state.kq = Some(unsafe { OwnedFd::from_raw_fd(kq) });
            }
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            let oflags = libc::O_NONBLOCK | libc::O_EVTONLY | libc::O_SYMLINK;
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let oflags = libc::O_NONBLOCK | libc::O_RDONLY | libc::O_NOFOLLOW;
            let path = std::ffi::CString::new(std::path::Path::new(&file).as_os_str().as_bytes()).map_err(|_| Error::new("File name contains a null byte"))?;
            // SAFETY: path is a NUL-terminated string that outlives the call.
            let fd = unsafe { libc::open(path.as_ptr(), oflags | libc::O_CLOEXEC) };
            if fd < 0 {
                let e = std::io::Error::last_os_error();
                self.close_kqueue_if_idle();
                return Err(file_error("File cannot be opened", &e, &file));
            }
            // SAFETY: fd is a descriptor just opened, owned by nothing else.
            let fd = unsafe { OwnedFd::from_raw_fd(fd) };
            let fflags = flags.iter().fold(0u32, |acc, f| acc | note(f));
            let kq = self.kqueue.imp.kq.as_ref().expect("made above").as_raw_fd();
            // SAFETY: an all-zero kevent is a valid one, its fields set below.
            let mut kev: libc::kevent = unsafe { std::mem::zeroed() };
            kev.ident = fd.as_raw_fd() as _;
            kev.filter = libc::EVFILT_VNODE as _;
            kev.flags = (libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR) as _;
            kev.fflags = fflags as _;
            // SAFETY: kevent reads the one change given it and writes nothing.
            if unsafe { libc::kevent(kq, &kev, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0 {
                let e = std::io::Error::last_os_error();
                drop(fd);
                self.close_kqueue_if_idle();
                return Err(file_error("Cannot watch file", &e, &file));
            }
            let descriptor = Value::Number(fd.as_raw_fd() as f64);
            let listing = is_directory(&file).then(|| listing(&file));
            self.kqueue.imp.watches.insert(0, Watch { fd, file, flags, callback, listing });
            if self.kqueue.imp.timer.is_none() {
                let timer = self.run_with_timer(POLL, Some(POLL), std::rc::Rc::new(|ed: &mut Editor, _: &[Value]| {
                    ed.kqueue_poll();
                    Ok(())
                }));
                self.kqueue.imp.timer = Some(timer);
            }
            Ok(descriptor)
        }

        pub(super) fn remove_watch(&mut self, descriptor: &Value) -> bool {
            let Some(i) = self.kqueue.imp.find(descriptor) else { return false };
            // Closing the file takes its events off the kqueue.
            self.kqueue.imp.watches.remove(i);
            self.close_kqueue_if_idle();
            true
        }

        /// Closes the kqueue and stops looking at it once nothing is
        /// watched, as kqueue-rm-watch does.
        fn close_kqueue_if_idle(&mut self) {
            if !self.kqueue.imp.watches.is_empty() {
                return;
            }
            self.kqueue.imp.kq = None;
            if let Some(timer) = self.kqueue.imp.timer.take() {
                self.cancel_timer(timer);
            }
        }

        /// Takes every event waiting on the kqueue, then calls the
        /// callbacks with what they report, as kqueue_callback and then
        /// Emacs's handling of the `file-notify` events it queues.
        fn kqueue_poll(&mut self) {
            let mut out = Vec::new();
            while let Some(kq) = self.kqueue.imp.kq.as_ref().map(|k| k.as_raw_fd()) {
                // SAFETY: an all-zero kevent is a valid one for kevent to fill.
                let mut kev: libc::kevent = unsafe { std::mem::zeroed() };
                let now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
                // SAFETY: kevent writes at most the one event given room for.
                let n = unsafe { libc::kevent(kq, std::ptr::null(), 0, &mut kev, 1, &now) };
                if n < 1 {
                    break;
                }
                let fflags = kev.fflags as u32;
                let descriptor = Value::Number(kev.ident as f64);
                let Some(i) = self.kqueue.imp.find(&descriptor) else { continue };
                let w = &mut self.kqueue.imp.watches[i];
                // Each action found is put first, as kqueue.c conses them.
                let mut actions: Vec<&str> = Vec::new();
                for &action in ACTIONS {
                    if fflags & note(action) == 0 {
                        continue;
                    }
                    if action == "write" && w.listing.is_some() {
                        compare_listings(w, &mut out);
                    } else {
                        actions.insert(0, action);
                    }
                }
                if !actions.is_empty() {
                    let file = w.file.clone();
                    generate(w, actions, &file, None, &mut out);
                }
                // What was watched has gone, or its file system has.
                if fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE) != 0 {
                    self.remove_watch(&descriptor);
                }
            }
            for Pending { callback, event } in out {
                if let Err(e) = self.funcall(&callback, &[event]) {
                    self.message(format!("Error in file notification callback: {e}"));
                }
            }
        }
    }
}
