//! File notifications on Linux, as Emacs's inotify.c gives them:
//! `inotify-add-watch`, `inotify-rm-watch` and `inotify-valid-p`.
//!
//! One inotify instance serves the editor, made with the first watch and
//! closed with the last. The system gives one watch descriptor per file,
//! however many watches are on it, so each watch has an id of its own
//! beside it, as inotify.c's (DESCRIPTOR . ID): here one number,
//! descriptor × 65536 + id, as E8 has no conses. The instance is read on
//! the editor's thread, as Emacs reads it when it waits for input, by a
//! timer every [`POLL`] seconds while anything is watched; each watch's
//! callback is called with `[descriptor, aspects, name, cookie]` for the
//! events its aspects ask for. Elsewhere there is no inotify, and
//! `inotify-add-watch` signals `file-notify-error`, as kqueue's does on
//! Linux.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// How often, in seconds, the instance is read while files are watched.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const POLL: f64 = 0.05;

/// The aspects a watch can ask for, by name, and their bits, as inotify.c's
/// symbol_to_inotifymask; and those an event can carry, in the order
/// mask_to_aspects conses them, so the list reads backwards.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub mod sys {
    pub const ASPECTS: &[(&str, u32)] = &[
        ("access", 0x1),
        ("modify", 0x2),
        ("attrib", 0x4),
        ("close-write", 0x8),
        ("close-nowrite", 0x10),
        ("open", 0x20),
        ("moved-from", 0x40),
        ("moved-to", 0x80),
        ("create", 0x100),
        ("delete", 0x200),
        ("delete-self", 0x400),
        ("move-self", 0x800),
        ("move", 0x40 | 0x80),
        ("close", 0x8 | 0x10),
        ("dont-follow", 0x0200_0000),
        ("onlydir", 0x0100_0000),
        ("ignored", 0x8000),
        ("unmount", 0x2000),
        ("all-events", 0xfff),
        ("t", 0xfff),
    ];

    /// What an event's mask says, as mask_to_aspects lists it.
    pub fn mask_to_aspects(mask: u32) -> Vec<&'static str> {
        const ORDER: &[(&str, u32)] = &[
            ("access", 0x1),
            ("attrib", 0x4),
            ("close-write", 0x8),
            ("close-nowrite", 0x10),
            ("create", 0x100),
            ("delete", 0x200),
            ("delete-self", 0x400),
            ("modify", 0x2),
            ("move-self", 0x800),
            ("moved-from", 0x40),
            ("moved-to", 0x80),
            ("open", 0x20),
            ("ignored", 0x8000),
            ("isdir", 0x4000_0000),
            ("q-overflow", 0x4000),
            ("unmount", 0x2000),
        ];
        let mut out = Vec::new();
        for (name, bit) in ORDER {
            if mask & bit != 0 {
                out.insert(0, *name);
            }
        }
        out
    }

    /// An event read from the instance.
    pub struct Event {
        pub wd: i32,
        pub mask: u32,
        pub cookie: u32,
        pub name: Option<String>,
    }

    /// Splits what was read into events: each a header of wd, mask,
    /// cookie and len, then len bytes of name padded with NULs.
    pub fn parse(bytes: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 16 <= bytes.len() {
            let word = |at: usize| u32::from_ne_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
            let (wd, mask, cookie, len) = (word(i) as i32, word(i + 4), word(i + 8), word(i + 12) as usize);
            let end = (i + 16 + len).min(bytes.len());
            let raw = &bytes[i + 16..end];
            let raw = &raw[..raw.iter().position(|&b| b == 0).unwrap_or(raw.len())];
            let name = (len > 0).then(|| String::from_utf8_lossy(raw).into_owned());
            out.push(Event { wd, mask, cookie, name });
            i = end;
        }
        out
    }

    #[cfg(target_os = "linux")]
    pub mod linux {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

        /// A new instance, not blocking and closed on exec, as inotify.c makes it.
        pub fn init() -> std::io::Result<OwnedFd> {
            // SAFETY: inotify_init1 takes flags and gives a new descriptor or -1.
            let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: fd was just made and is owned by nothing else.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }

        /// Watches a file, adding to what the instance already watches of it.
        pub fn add(fd: &OwnedFd, file: &str, mask: u32) -> std::io::Result<i32> {
            let c = std::ffi::CString::new(file).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            // SAFETY: c is NUL-terminated and outlives the call.
            let wd = unsafe { libc::inotify_add_watch(fd.as_raw_fd(), c.as_ptr(), mask | libc::IN_MASK_ADD | libc::IN_EXCL_UNLINK) };
            if wd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(wd) }
        }

        pub fn remove(fd: &OwnedFd, wd: i32) -> std::io::Result<()> {
            // SAFETY: inotify_rm_watch takes two integers.
            if unsafe { libc::inotify_rm_watch(fd.as_raw_fd(), wd) } != 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
        }

        /// Everything waiting to be read, or nothing.
        pub fn read(fd: &OwnedFd) -> Vec<u8> {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                // SAFETY: read writes at most buf.len() bytes into buf.
                let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n <= 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n as usize]);
            }
            out
        }
    }
}

/// A watch on a file: its id among the file's watches, the name it was
/// given, its callback, and the aspects it asked for.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Watch {
    id: i64,
    file: String,
    callback: Value,
    mask: u32,
}

/// The watches by the system's descriptor, as inotify.c's watch_list.
#[derive(Default)]
pub(crate) struct Inotify {
    #[cfg(target_os = "linux")]
    fd: Option<std::os::fd::OwnedFd>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    watches: Vec<(i32, Vec<Watch>)>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    timer: Option<u64>,
}

fn notify_error(what: &str, data: Value) -> Error {
    crate::error::define_error("file-notify-error", "file-error");
    Error::signal("file-notify-error", format!("{what}, {data}"), vec![Value::Str(what.to_string()), data])
}

/// The number a watch is known by: the system's descriptor and its id.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn descriptor(wd: i32, id: i64) -> Value {
    Value::Number((wd as i64 * 65536 + id) as f64)
}

/// A descriptor's parts, if it is one.
fn parts(descriptor: &Value) -> Option<(i32, i64)> {
    let n = descriptor.as_number().filter(|n| *n >= 0.0 && n.fract() == 0.0)? as i64;
    Some(((n / 65536) as i32, n % 65536))
}

/// The bits the aspects ask for, as aspect_to_inotifymask: one aspect, or a list.
fn aspect_mask(aspect: &Value) -> Result<u32> {
    let names: Vec<Value> = match aspect {
        Value::List(items) => items.clone(),
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    };
    let mut mask = 0;
    for name in &names {
        let text = match name {
            Value::Bool(true) => "t",
            other => other.as_str().unwrap_or(""),
        };
        match sys::ASPECTS.iter().find(|(n, _)| *n == text) {
            Some((_, bit)) => mask |= bit,
            None => return Err(notify_error("Unknown aspect", name.clone())),
        }
    }
    Ok(mask)
}

impl Editor {
    /// Watches a file or directory for the aspects named, calling
    /// `callback` with each event, as Emacs's `inotify-add-watch`. Returns
    /// the watch's descriptor.
    pub fn inotify_add_watch(&mut self, file: &Value, aspect: &Value, callback: &Value) -> Result<Value> {
        let Some(name) = file.as_str().map(str::to_string) else { return Err(crate::xfaces::wrong_type("stringp", file)) };
        let mask = aspect_mask(aspect)?;
        self.add_inotify_watch(name, mask, callback.clone())
    }

    /// Stops a watch, as Emacs's `inotify-rm-watch`: true, or a
    /// `file-notify-error` for what is not a descriptor.
    pub fn inotify_rm_watch(&mut self, descriptor: &Value) -> Result<bool> {
        let Some((wd, id)) = parts(descriptor) else { return Err(notify_error("Invalid descriptor ", descriptor.clone())) };
        self.remove_inotify_watch(wd, id)?;
        Ok(true)
    }

    /// Whether a watch is in place, as Emacs's `inotify-valid-p`: not once
    /// removed, or once what it watched has gone.
    pub fn inotify_valid_p(&self, descriptor: &Value) -> bool {
        let Some((wd, id)) = parts(descriptor) else { return false };
        self.inotify.watches.iter().any(|(w, list)| *w == wd && list.iter().any(|x| x.id == id))
    }

    #[cfg(not(target_os = "linux"))]
    fn add_inotify_watch(&mut self, _file: String, _mask: u32, _callback: Value) -> Result<Value> {
        Err(notify_error("File watching is not available", Value::Null))
    }

    #[cfg(not(target_os = "linux"))]
    fn remove_inotify_watch(&mut self, _wd: i32, _id: i64) -> Result<()> {
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn add_inotify_watch(&mut self, file: String, mask: u32, callback: Value) -> Result<Value> {
        if self.inotify.fd.is_none() {
            let fd = sys::linux::init().map_err(|_| notify_error("File watching is not available", Value::Null))?;
            self.inotify.fd = Some(fd);
            self.inotify.watches.clear();
        }
        let wd = match sys::linux::add(self.inotify.fd.as_ref().expect("made above"), &file, mask) {
            Ok(wd) => wd,
            Err(_) => {
                self.close_inotify_if_idle();
                return Err(notify_error("Could not add watch for file", Value::Str(file)));
            }
        };
        let list = match self.inotify.watches.iter().position(|(w, _)| *w == wd) {
            Some(i) => &mut self.inotify.watches[i].1,
            None => {
                self.inotify.watches.insert(0, (wd, Vec::new()));
                &mut self.inotify.watches[0].1
            }
        };
        // The first id not in use, the list kept sorted, as add_watch does.
        let mut id = 0;
        while list.iter().any(|w| w.id == id) {
            id += 1;
        }
        let at = list.iter().position(|w| w.id > id).unwrap_or(list.len());
        list.insert(at, Watch { id, file, callback, mask });
        if self.inotify.timer.is_none() {
            let timer = self.run_with_timer(POLL, Some(POLL), std::rc::Rc::new(|ed: &mut Editor, _: &[Value]| {
                ed.inotify_poll();
                Ok(())
            }));
            self.inotify.timer = Some(timer);
        }
        Ok(descriptor(wd, id))
    }

    /// Takes a watch away, the system's watch with its last, as remove_watch.
    #[cfg(target_os = "linux")]
    fn remove_inotify_watch(&mut self, wd: i32, id: i64) -> Result<()> {
        let Some(i) = self.inotify.watches.iter().position(|(w, _)| *w == wd) else { return Ok(()) };
        self.inotify.watches[i].1.retain(|w| w.id != id);
        if self.inotify.watches[i].1.is_empty() {
            self.inotify.watches.remove(i);
            let failed = self.inotify.fd.as_ref().map(|fd| sys::linux::remove(fd, wd)).transpose().is_err();
            self.close_inotify_if_idle();
            if failed {
                return Err(notify_error("Could not rm watch", Value::Number(wd as f64)));
            }
        }
        Ok(())
    }

    /// Closes the instance and stops reading it once nothing is watched.
    #[cfg(target_os = "linux")]
    fn close_inotify_if_idle(&mut self) {
        if !self.inotify.watches.is_empty() {
            return;
        }
        self.inotify.fd = None;
        if let Some(timer) = self.inotify.timer.take() {
            self.cancel_timer(timer);
        }
    }

    /// Reads every event waiting and calls the callbacks of the watches
    /// whose aspects each concerns, as inotify_callback; a watch the system
    /// dropped, as for a deleted file, goes, as on IN_IGNORED.
    #[cfg(target_os = "linux")]
    fn inotify_poll(&mut self) {
        let Some(fd) = self.inotify.fd.as_ref() else { return };
        let events = sys::parse(&sys::linux::read(fd));
        let mut calls = Vec::new();
        for ev in events {
            let Some(i) = self.inotify.watches.iter().position(|(w, _)| *w == ev.wd) else { continue };
            for w in &self.inotify.watches[i].1 {
                if w.mask & ev.mask == 0 {
                    continue;
                }
                let aspects = Value::List(sys::mask_to_aspects(ev.mask).into_iter().map(|a| Value::Str(a.into())).collect());
                let name = Value::Str(ev.name.clone().unwrap_or_else(|| w.file.clone()));
                let event = Value::List(vec![descriptor(ev.wd, w.id), aspects, name, Value::Number(ev.cookie as f64)]);
                calls.push((w.callback.clone(), event));
            }
            if ev.mask & 0x8000 != 0 {
                self.inotify.watches.remove(i);
            }
        }
        self.close_inotify_if_idle();
        for (callback, event) in calls {
            if let Err(e) = self.funcall(&callback, &[event]) {
                self.message(format!("Error in file notification callback: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_read_as_the_system_writes_them() {
        let mut bytes = Vec::new();
        for (wd, mask, cookie, name) in [(1i32, 0x100u32, 0u32, &b"new.txt\0\0\0\0\0\0\0\0\0"[..]), (2, 0x8000, 7, &b""[..])] {
            bytes.extend_from_slice(&wd.to_ne_bytes());
            bytes.extend_from_slice(&mask.to_ne_bytes());
            bytes.extend_from_slice(&cookie.to_ne_bytes());
            bytes.extend_from_slice(&(name.len() as u32).to_ne_bytes());
            bytes.extend_from_slice(name);
        }
        let events = sys::parse(&bytes);
        assert_eq!(events.len(), 2);
        assert_eq!((events[0].wd, events[0].mask, events[0].name.as_deref()), (1, 0x100, Some("new.txt")));
        assert_eq!((events[1].wd, events[1].cookie, events[1].name.as_deref()), (2, 7, None));
        assert_eq!(sys::mask_to_aspects(0x100 | 0x4000_0000), vec!["isdir", "create"]);
    }

    #[test]
    fn descriptors_hold_both_numbers() {
        assert_eq!(parts(&descriptor(5, 2)), Some((5, 2)));
        assert!(aspect_mask(&Value::List(vec![Value::Str("bogus".into())])).is_err());
        assert_eq!(aspect_mask(&Value::List(vec![Value::Str("move".into()), Value::Str("attrib".into())])).unwrap(), 0x40 | 0x80 | 0x4);
    }
}
