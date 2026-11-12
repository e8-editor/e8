//! Lock files, as Emacs's filelock.c: the first change to a buffer
//! visiting a file makes `.#name` beside the file, a symbolic link to
//! `user@host.pid:boot-time`, so another Emacs or E8 about to edit it
//! asks first; saving, reverting or killing the buffer takes the lock away.
//! A lock left by a process no longer running on this machine is taken
//! over without asking, as Emacs does.

use crate::vfs as fs;
use std::path::{Path, PathBuf};

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// Whose a lock is.
#[derive(Clone, Debug, PartialEq)]
pub enum LockOwner {
    None,
    Me,
    /// Another process, as `user@host (pid N)`.
    Other(String),
}

/// Where a file's lock goes: `.#name` in its directory, as Emacs's
/// `make-lock-file-name` makes it without `lock-file-name-transforms`.
pub fn lock_file_name(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".#{name}"))
}

/// The user's login name, as Emacs's `user-login-name`.
pub fn user_login_name() -> String {
    #[cfg(unix)]
    return crate::fileops::user_name(unsafe { libc::getuid() });
    #[cfg(not(unix))]
    std::env::var("USERNAME").unwrap_or_default()
}

/// The machine's name, as Emacs's `system-name`, with any @ made a -.
pub fn system_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).replace('@', "-");
        }
    }
    std::env::var("HOSTNAME").unwrap_or_default().replace('@', "-")
}

/// When the machine last started, in seconds since 1970, if known.
fn boot_time() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        let mut tv: libc::timeval = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::timeval>();
        let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        let ok = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut tv as *mut libc::timeval).cast(), &mut size, std::ptr::null_mut(), 0) } == 0;
        if ok {
            return Some(tv.tv_sec);
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(stat) = fs::read_to_string("/proc/stat") {
        return stat.lines().find_map(|l| l.strip_prefix("btime ")).and_then(|t| t.trim().parse().ok());
    }
    None
}

/// What this process writes in its locks.
fn lock_info() -> String {
    let base = format!("{}@{}.{}", user_login_name(), system_name(), crate::clock::process_id());
    match boot_time() {
        Some(boot) => format!("{base}:{boot}"),
        None => base,
    }
}

/// Whether a process is running here.
/// Whether a process of this machine is running, as Emacs's
/// `process-attributes` finds one.
pub fn alive(pid: i64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
        pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Who holds a lock, as Emacs's current_lock_owner reads it: a stale lock,
/// left here by a process no longer running, is deleted and counts as none.
pub fn current_lock_owner(lock: &Path) -> LockOwner {
    let info = match fs::read_link(lock) {
        Ok(target) => target.display().to_string(),
        // A lock written as a file, where links cannot be made.
        Err(_) => match fs::read_to_string(lock) {
            Ok(text) => text,
            Err(_) => return LockOwner::None,
        },
    };
    let Some(at) = info.rfind('@') else { return LockOwner::Other(info) };
    let Some(dot) = info[at..].rfind('.').map(|d| at + d) else { return LockOwner::Other(info) };
    let (user, host) = (&info[..at], &info[at + 1..dot]);
    let rest = &info[dot + 1..];
    let (pid, boot) = match rest.split_once(':') {
        Some((pid, boot)) => (pid, boot.parse::<i64>().ok()),
        None => (rest, None),
    };
    let pid: i64 = pid.parse().unwrap_or(-1);
    let shown = format!("{user}@{host} (pid {pid})");
    if host != system_name() {
        return LockOwner::Other(shown);
    }
    if pid == crate::clock::process_id() as i64 {
        return LockOwner::Me;
    }
    let same_boot = boot.is_none_or(|b| b == 0 || boot_time().is_none_or(|now| (b - now).abs() <= 1));
    if alive(pid) && same_boot {
        return LockOwner::Other(shown);
    }
    let _ = fs::remove_file(lock);
    LockOwner::None
}

/// Makes this process's lock, replacing what is there with `force`.
fn create_lock(lock: &Path, force: bool) -> std::io::Result<()> {
    let info = lock_info();
    if force {
        let _ = fs::remove_file(lock);
    }
    #[cfg(unix)]
    return std::os::unix::fs::symlink(&info, lock);
    #[cfg(not(unix))]
    return fs::File::options().write(true).create_new(true).open(lock).and_then(|mut f| {
        use std::io::Write;
        f.write_all(info.as_bytes())
    });
}

impl Editor {
    /// Whether the current buffer makes lock files, as `create-lockfiles` says.
    fn lockfiles(&self) -> bool {
        self.variable("create-lockfiles").is_none_or(|v| v.is_true())
    }

    /// Locks the file of an unmodified buffer about to change, as Emacs's
    /// lock_file does from prepare_to_modify_buffer. If another process
    /// holds the lock, the change is refused, for the command loop to ask
    /// whether to take the lock, go ahead without it, or leave the file.
    pub(crate) fn lock_on_first_change(&mut self) -> Result<()> {
        let b = self.buffer();
        let Some(path) = b.path.clone() else { return Ok(()) };
        if b.is_modified() || b.file.locked || b.file.lock_ignored || !self.lockfiles() {
            return Ok(());
        }
        let lock = lock_file_name(&path);
        // A stale lock is deleted and the lock made again; one that can be
        // neither read nor deleted, such as a directory of the name, would
        // come back each time, so after a few tries editing goes on without one.
        let mut tries = 0;
        loop {
            match create_lock(&lock, false) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match current_lock_owner(&lock) {
                    LockOwner::None if tries < 3 => tries += 1,
                    LockOwner::None => return Ok(()),
                    LockOwner::Me => break,
                    LockOwner::Other(owner) => {
                        self.buffer_mut().file.lock_threat = Some(owner.clone());
                        return Err(Error::signal("file-locked", format!("File is locked: {}, {owner}", path.display()), vec![Value::Str(path.display().to_string()), Value::Str(owner)]));
                    }
                },
                // Where no lock can be made, editing goes on without one, as in Emacs.
                Err(_) => return Ok(()),
            }
        }
        self.buffer_mut().file.locked = true;
        Ok(())
    }

    /// Takes away the locks of buffers no longer modified or gone, as
    /// Emacs's unlock_file does when a buffer is saved, reverted or killed.
    pub(crate) fn release_locks(&mut self) {
        for b in &mut self.buffers {
            if b.file.locked && !b.is_modified() {
                b.file.locked = false;
                if let Some(path) = &b.path {
                    unlock(path);
                }
            }
            b.file.lock_ignored &= b.is_modified();
        }
    }

    /// Takes away a buffer's lock before it goes.
    pub(crate) fn release_lock_of(&mut self, index: usize) {
        let b = &mut self.buffers[index];
        if std::mem::take(&mut b.file.locked)
            && let Some(path) = &b.path
        {
            unlock(path);
        }
    }

    /// Takes every lock this process holds away, as Emacs does when it exits.
    pub fn release_all_locks(&mut self) {
        for i in 0..self.buffers.len() {
            self.release_lock_of(i);
        }
    }

    /// Whose a file's lock is, as Emacs's `file-locked-p`.
    pub fn file_locked_p(&mut self, file: &str) -> Result<LockOwner> {
        let file = self.expand_file_name(file).display().to_string();
        if let Some(r) = self.handled("file-locked-p", &file, vec![Value::Str(file.clone())]) {
            return r.map(|v| match v {
                Value::Bool(true) => LockOwner::Me,
                Value::Str(owner) => LockOwner::Other(owner),
                _ => LockOwner::None,
            });
        }
        Ok(current_lock_owner(&lock_file_name(Path::new(&file))))
    }

    /// Locks a file, as Emacs's `lock-file`: unless `create-lockfiles` is
    /// off, makes its lock file, `file-locked` signalled if another
    /// process holds it, a file name handler doing it for a name of its
    /// own. The lock lasts until `unlock-file`, or until a modified buffer
    /// visiting the file is saved or stops being modified.
    pub fn lock_file(&mut self, file: &str) -> Result<()> {
        let path = self.expand_file_name(file);
        let name = path.display().to_string();
        if let Some(r) = self.handled("lock-file", &name, vec![Value::Str(name.clone())]) {
            return r.map(drop);
        }
        if !self.lockfiles() {
            return Ok(());
        }
        let lock = lock_file_name(&path);
        let held = match create_lock(&lock, false) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match current_lock_owner(&lock) {
                LockOwner::Other(owner) => {
                    return Err(Error::signal("file-locked", format!("File is locked: {name}, {owner}"), vec![Value::Str(name.clone()), Value::Str(owner)]));
                }
                LockOwner::None => {
                    let _ = fs::remove_file(&lock);
                    create_lock(&lock, false).is_ok()
                }
                LockOwner::Me => true,
            },
            // Where no lock can be made, editing goes on without one, as in Emacs.
            Err(_) => false,
        };
        // Modified buffers hold it, to give it up when saved; an unmodified
        // one would give it up after the command, where Emacs keeps it.
        for b in &mut self.buffers {
            if held && b.is_modified() && b.path.as_deref() == Some(path.as_path()) {
                b.file.locked = true;
            }
        }
        Ok(())
    }

    /// Takes a file's lock away if this process holds it, as Emacs's
    /// `unlock-file`, buffers visiting it no longer holding it, a file name
    /// handler doing it for a name of its own.
    pub fn unlock_file(&mut self, file: &str) {
        let path = self.expand_file_name(file);
        let name = path.display().to_string();
        if self.handled("unlock-file", &name, vec![Value::Str(name.clone())]).is_some() {
            return;
        }
        unlock(&path);
        for b in &mut self.buffers {
            if b.path.as_deref() == Some(path.as_path()) {
                b.file.locked = false;
            }
        }
    }

    /// Locks `file`, or the current buffer's, if the buffer is modified, as
    /// Emacs's `lock-buffer`.
    pub fn lock_buffer(&mut self, file: Option<&str>) -> Result<()> {
        let b = self.buffer();
        let Some(file) = file.map(str::to_string).or_else(|| b.path.as_ref().map(|p| p.display().to_string())) else { return Ok(()) };
        if b.is_modified() { self.lock_file(&file) } else { Ok(()) }
    }

    /// Takes the current buffer's file's lock away if the buffer is
    /// modified, as Emacs's `unlock-buffer`: an unmodified one holds none.
    pub fn unlock_buffer(&mut self) {
        let b = self.buffer();
        if b.is_modified()
            && let Some(path) = b.path.as_ref().map(|p| p.display().to_string())
        {
            self.unlock_file(&path);
        }
    }

    /// Marks the current buffer modified or not, as Emacs's
    /// `set-buffer-modified-p`, its file locked as it becomes modified and
    /// unlocked as it stops being so.
    pub fn set_buffer_modified_p(&mut self, modified: bool) -> Result<()> {
        if modified == self.buffer().is_modified() {
            return Ok(());
        }
        if modified {
            self.lock_on_first_change()?;
            self.buffer_mut().set_modified(true);
        } else {
            self.buffer_mut().set_modified(false);
            let index = self.buffer_with_id(self.buffer().id()).expect("current");
            self.release_lock_of(index);
        }
        Ok(())
    }

    /// Takes the lock of a file, as answering s to a locked file's question does.
    pub(crate) fn steal_lock(&mut self, buffer: u64) {
        let Some(b) = self.buffers.iter_mut().find(|b| b.id == buffer) else { return };
        if let Some(path) = &b.path
            && create_lock(&lock_file_name(path), true).is_ok()
        {
            b.file.locked = true;
        }
    }
}

/// Takes a file's lock away if this process holds it.
pub(crate) fn unlock(path: &Path) {
    let lock = lock_file_name(path);
    if current_lock_owner(&lock) == LockOwner::Me {
        let _ = fs::remove_file(lock);
    }
}
