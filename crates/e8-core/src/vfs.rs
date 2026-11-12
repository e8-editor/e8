//! The file system the editor uses: `std::fs` natively, and on the web,
//! where std has none, a tree of files in memory with the same interface.
//!
//! Code reaches files through this module, `use crate::vfs as fs`, rather
//! than `std::fs`, and asks about paths with [`path_exists`] and its kin
//! rather than `Path::exists`, which reads std's file system behind the
//! scenes. Natively every function here is std's own, so nothing changes;
//! on the web a front end fills the tree before the editor starts, and
//! [`watch`] tells it of each change, to keep them. The `memory-fs` feature
//! uses the tree natively too, for tests.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(not(any(target_arch = "wasm32", feature = "memory-fs")))]
pub use std::fs::*;

#[cfg(any(target_arch = "wasm32", feature = "memory-fs"))]
pub use memory::*;

/// Whether `path` starts from the root, as `Path::is_absolute` says on
/// Unix. On the web std says no path is absolute, as that target is not
/// Unix, though the editor's paths there are.
pub fn is_absolute(path: impl AsRef<Path>) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        path.as_ref().has_root()
    }
    #[cfg(not(target_arch = "wasm32"))]
    path.as_ref().is_absolute()
}

/// Whether `path` names something, as `Path::exists`.
pub fn path_exists(path: impl AsRef<Path>) -> bool {
    metadata(path).is_ok()
}

/// Whether `path` names a directory, following links, as `Path::is_dir`.
pub fn path_is_dir(path: impl AsRef<Path>) -> bool {
    metadata(path).is_ok_and(|m| m.is_dir())
}

/// Whether `path` names a file, following links, as `Path::is_file`.
pub fn path_is_file(path: impl AsRef<Path>) -> bool {
    metadata(path).is_ok_and(|m| m.is_file())
}

/// Whether `path` names a symbolic link, as `Path::is_symlink`.
pub fn path_is_symlink(path: impl AsRef<Path>) -> bool {
    symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// The permissions new files may have, as Emacs's `default-file-modes`:
/// those the umask leaves. As Emacs keeps it in `realmask`, the mask is
/// read from the process once, by setting it and setting it back, and kept
/// after, so no other thread ever sees it changed. On the web and in
/// memory, the editor's own, from 0o022.
pub fn default_file_modes() -> u32 {
    !umask().load(std::sync::atomic::Ordering::Relaxed) & 0o777
}

/// Sets the permissions new files may have, as Emacs's
/// `set-default-file-modes`: the umask, for the whole process and the
/// programs it starts afterwards.
pub fn set_default_file_modes(modes: u32) {
    let mask = !modes & 0o777;
    umask().store(mask, std::sync::atomic::Ordering::Relaxed);
    #[cfg(all(unix, not(any(target_arch = "wasm32", feature = "memory-fs"))))]
    // SAFETY: umask only sets the process's mask.
    unsafe {
        libc::umask(mask as libc::mode_t);
    }
}

/// Writes what the system holds of files to disk, as sync(2), which
/// Emacs's `unix-sync` calls; in memory there is nothing to write.
pub fn sync() {
    #[cfg(all(unix, not(any(target_arch = "wasm32", feature = "memory-fs"))))]
    // SAFETY: sync takes no arguments and cannot fail.
    unsafe {
        libc::sync();
    }
}

/// The umask as the editor knows it.
fn umask() -> &'static std::sync::atomic::AtomicU32 {
    static MASK: std::sync::OnceLock<std::sync::atomic::AtomicU32> = std::sync::OnceLock::new();
    MASK.get_or_init(|| {
        #[cfg(all(unix, not(any(target_arch = "wasm32", feature = "memory-fs"))))]
        // SAFETY: umask only swaps the process's mask, set back at once.
        let mask = unsafe {
            let mask = libc::umask(0o022);
            libc::umask(mask);
            mask as u32
        };
        #[cfg(not(all(unix, not(any(target_arch = "wasm32", feature = "memory-fs")))))]
        let mask = 0o022;
        std::sync::atomic::AtomicU32::new(mask)
    })
}

/// The working directory, as `std::env::current_dir`; on the web, the
/// home directory.
pub fn current_dir() -> io::Result<PathBuf> {
    #[cfg(any(target_arch = "wasm32", feature = "memory-fs"))]
    {
        Ok(PathBuf::from(memory::HOME))
    }
    #[cfg(not(any(target_arch = "wasm32", feature = "memory-fs")))]
    std::env::current_dir()
}

/// The home directory: `$HOME` natively, and on the web the one the tree
/// keeps the person's files in.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(any(target_arch = "wasm32", feature = "memory-fs"))]
    {
        Some(PathBuf::from(memory::HOME))
    }
    #[cfg(not(any(target_arch = "wasm32", feature = "memory-fs")))]
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(any(target_arch = "wasm32", feature = "memory-fs"))]
mod memory {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::io::{self, ErrorKind};
    use std::path::{Component, Path, PathBuf};
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::SystemTime;

    use crate::clock::system_now;

    /// Where the person's files are.
    pub const HOME: &str = "/home/e8";

    /// A file, or a directory when it has no contents, with its permission
    /// bits, as `ls -l` shows them.
    #[derive(Clone)]
    struct Node {
        data: Option<Vec<u8>>,
        modified: SystemTime,
        accessed: SystemTime,
        mode: u32,
    }

    impl Node {
        fn dir() -> Node {
            Node { data: None, modified: system_now(), accessed: system_now(), mode: 0o755 }
        }

        fn file(data: Vec<u8>) -> Node {
            Node { data: Some(data), modified: system_now(), accessed: system_now(), mode: 0o644 }
        }

        fn readonly(&self) -> bool {
            self.mode & 0o222 == 0
        }
    }

    /// Every file and directory by its absolute, normal path. Only the
    /// editor's worker uses it once the editor has started, so the lock is
    /// never waited for on the browser's main thread.
    static TREE: Mutex<BTreeMap<PathBuf, Node>> = Mutex::new(BTreeMap::new());

    fn tree() -> MutexGuard<'static, BTreeMap<PathBuf, Node>> {
        let mut tree = TREE.lock().unwrap_or_else(|e| e.into_inner());
        if tree.is_empty() {
            tree.insert(PathBuf::from("/"), Node::dir());
        }
        tree
    }

    /// A change to the tree, for a front end that keeps the files.
    pub enum Change<'a> {
        /// A file was written, with all its contents.
        Write(&'a Path, &'a [u8]),
        /// A directory was made.
        MakeDir(&'a Path),
        /// A file or directory, and everything in it, was removed.
        Remove(&'a Path),
    }

    static WATCHER: OnceLock<fn(Change)> = OnceLock::new();

    /// Calls `watcher` with each change to the tree from now on.
    pub fn watch(watcher: fn(Change)) {
        let _ = WATCHER.set(watcher);
    }

    fn changed(change: Change) {
        if let Some(watcher) = WATCHER.get() {
            watcher(change);
        }
    }

    /// Puts files in the tree without telling the watcher, as a front end
    /// restores what it kept: directories ending in `/`, and the
    /// directories files are in made as needed.
    pub fn restore(files: impl IntoIterator<Item = (String, Vec<u8>)>) {
        let mut tree = tree();
        for (name, data) in files {
            let dir = name.ends_with('/');
            let path = normal(Path::new(&name));
            let mut parent = path.parent();
            while let Some(p) = parent {
                tree.entry(p.to_path_buf()).or_insert_with(Node::dir);
                parent = p.parent();
            }
            tree.insert(path, if dir { Node::dir() } else { Node::file(data) });
        }
    }

    /// `path` absolute, in the home directory if relative, with `.` and
    /// `..` worked out.
    fn normal(path: &Path) -> PathBuf {
        let mut out = PathBuf::from("/");
        if !super::is_absolute(path) {
            out.push(HOME);
        }
        for part in path.components() {
            match part {
                Component::Normal(p) => out.push(p),
                Component::ParentDir => {
                    out.pop();
                }
                Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            }
        }
        out
    }

    fn error(kind: ErrorKind) -> io::Error {
        io::Error::from(kind)
    }

    /// The node at `path`, or not found.
    fn node(path: &Path) -> io::Result<Node> {
        tree().get(&normal(path)).cloned().ok_or_else(|| error(ErrorKind::NotFound))
    }

    /// Writes a file whose directory exists, unless it is a directory.
    fn put(path: &Path, data: Vec<u8>) -> io::Result<()> {
        let path = normal(path);
        {
            let mut tree = tree();
            match path.parent().and_then(|p| tree.get(p)) {
                Some(parent) if parent.data.is_none() => {}
                Some(_) => return Err(error(ErrorKind::NotADirectory)),
                None => return Err(error(ErrorKind::NotFound)),
            }
            match tree.get_mut(&path) {
                Some(n) if n.data.is_none() => return Err(error(ErrorKind::IsADirectory)),
                Some(n) if n.readonly() => return Err(error(ErrorKind::PermissionDenied)),
                Some(n) => {
                    n.data = Some(data.clone());
                    n.modified = system_now();
                }
                None => {
                    tree.insert(path.clone(), Node::file(data.clone()));
                }
            }
        }
        changed(Change::Write(&path, &data));
        Ok(())
    }

    /// What is directly in `dir`.
    fn children(tree: &BTreeMap<PathBuf, Node>, dir: &Path) -> Vec<PathBuf> {
        tree.range(dir.to_path_buf()..).skip(1).take_while(|(p, _)| p.starts_with(dir)).filter(|(p, _)| p.parent() == Some(dir)).map(|(p, _)| p.clone()).collect()
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct FileType {
        dir: bool,
    }

    impl FileType {
        pub fn is_dir(&self) -> bool {
            self.dir
        }

        pub fn is_file(&self) -> bool {
            !self.dir
        }

        pub fn is_symlink(&self) -> bool {
            false
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Permissions {
        mode: u32,
    }

    impl Permissions {
        pub fn readonly(&self) -> bool {
            self.mode & 0o222 == 0
        }

        pub fn set_readonly(&mut self, readonly: bool) {
            if readonly {
                self.mode &= !0o222;
            } else {
                self.mode |= 0o200;
            }
        }
    }

    #[cfg(unix)]
    impl std::os::unix::fs::PermissionsExt for Permissions {
        fn mode(&self) -> u32 {
            self.mode
        }

        fn set_mode(&mut self, mode: u32) {
            self.mode = mode & 0o7777;
        }

        fn from_mode(mode: u32) -> Permissions {
            Permissions { mode: mode & 0o7777 }
        }
    }

    #[derive(Clone, Debug)]
    pub struct Metadata {
        dir: bool,
        len: u64,
        modified: SystemTime,
        accessed: SystemTime,
        mode: u32,
    }

    // As std's Metadata, which has no is_empty either.
    #[allow(clippy::len_without_is_empty)]
    impl Metadata {
        fn of(node: &Node) -> Metadata {
            Metadata {
                dir: node.data.is_none(),
                len: node.data.as_ref().map_or(0, |d| d.len() as u64),
                modified: node.modified,
                accessed: node.accessed,
                mode: node.mode,
            }
        }

        pub fn is_dir(&self) -> bool {
            self.dir
        }

        pub fn is_file(&self) -> bool {
            !self.dir
        }

        pub fn is_symlink(&self) -> bool {
            false
        }

        pub fn len(&self) -> u64 {
            self.len
        }

        pub fn file_type(&self) -> FileType {
            FileType { dir: self.dir }
        }

        pub fn permissions(&self) -> Permissions {
            Permissions { mode: self.mode }
        }

        pub fn modified(&self) -> io::Result<SystemTime> {
            Ok(self.modified)
        }

        pub fn accessed(&self) -> io::Result<SystemTime> {
            Ok(self.accessed)
        }

        pub fn created(&self) -> io::Result<SystemTime> {
            Ok(self.modified)
        }
    }

    /// What `stat` would say of a file in memory: owned by whoever runs the
    /// editor, one link, its number made from its name.
    #[cfg(unix)]
    impl std::os::unix::fs::MetadataExt for Metadata {
        fn dev(&self) -> u64 {
            0
        }
        fn ino(&self) -> u64 {
            0
        }
        fn mode(&self) -> u32 {
            (if self.dir { 0o040000 } else { 0o100000 }) | self.mode
        }
        fn nlink(&self) -> u64 {
            1
        }
        fn uid(&self) -> u32 {
            unsafe { libc::getuid() }
        }
        fn gid(&self) -> u32 {
            unsafe { libc::getgid() }
        }
        fn rdev(&self) -> u64 {
            0
        }
        fn size(&self) -> u64 {
            self.len
        }
        fn atime(&self) -> i64 {
            seconds(self.accessed)
        }
        fn atime_nsec(&self) -> i64 {
            0
        }
        fn mtime(&self) -> i64 {
            seconds(self.modified)
        }
        fn mtime_nsec(&self) -> i64 {
            0
        }
        fn ctime(&self) -> i64 {
            seconds(self.modified)
        }
        fn ctime_nsec(&self) -> i64 {
            0
        }
        fn blksize(&self) -> u64 {
            4096
        }
        fn blocks(&self) -> u64 {
            self.len.div_ceil(512)
        }
    }

    #[cfg(unix)]
    fn seconds(t: SystemTime) -> i64 {
        t.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
    }

    pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
        node(path.as_ref()).map(|n| Metadata::of(&n))
    }

    /// As [`metadata`]: there are no links.
    pub fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
        metadata(path)
    }

    pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
        node(path.as_ref())?.data.ok_or_else(|| error(ErrorKind::IsADirectory))
    }

    pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
        String::from_utf8(read(path)?).map_err(|_| error(ErrorKind::InvalidData))
    }

    pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
        put(path.as_ref(), contents.as_ref().to_vec())
    }

    pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normal(path.as_ref());
        {
            let mut tree = tree();
            if tree.contains_key(&path) {
                return Err(error(ErrorKind::AlreadyExists));
            }
            match path.parent().and_then(|p| tree.get(p)) {
                Some(parent) if parent.data.is_none() => {}
                Some(_) => return Err(error(ErrorKind::NotADirectory)),
                None => return Err(error(ErrorKind::NotFound)),
            }
            tree.insert(path.clone(), Node::dir());
        }
        changed(Change::MakeDir(&path));
        Ok(())
    }

    pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normal(path.as_ref());
        let mut made = Vec::new();
        {
            let mut tree = tree();
            for dir in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
                match tree.get(dir) {
                    Some(n) if n.data.is_some() => return Err(error(ErrorKind::NotADirectory)),
                    Some(_) => {}
                    None => {
                        tree.insert(dir.to_path_buf(), Node::dir());
                        made.push(dir.to_path_buf());
                    }
                }
            }
        }
        for dir in &made {
            changed(Change::MakeDir(dir));
        }
        Ok(())
    }

    pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normal(path.as_ref());
        {
            let mut tree = tree();
            match tree.get(&path) {
                None => return Err(error(ErrorKind::NotFound)),
                Some(n) if n.data.is_none() => return Err(error(ErrorKind::IsADirectory)),
                Some(_) => tree.remove(&path),
            };
        }
        changed(Change::Remove(&path));
        Ok(())
    }

    pub fn remove_dir(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normal(path.as_ref());
        {
            let mut tree = tree();
            match tree.get(&path) {
                None => return Err(error(ErrorKind::NotFound)),
                Some(n) if n.data.is_some() => return Err(error(ErrorKind::NotADirectory)),
                Some(_) if !children(&tree, &path).is_empty() => return Err(error(ErrorKind::DirectoryNotEmpty)),
                Some(_) => tree.remove(&path),
            };
        }
        changed(Change::Remove(&path));
        Ok(())
    }

    pub fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normal(path.as_ref());
        {
            let mut tree = tree();
            if !tree.contains_key(&path) {
                return Err(error(ErrorKind::NotFound));
            }
            tree.retain(|p, _| !p.starts_with(&path));
        }
        changed(Change::Remove(&path));
        Ok(())
    }

    /// Moves a file or a directory with everything in it.
    pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
        let (from, to) = (normal(from.as_ref()), normal(to.as_ref()));
        if from == to {
            return Ok(());
        }
        let moved: Vec<(PathBuf, Node)> = {
            let mut tree = tree();
            if !tree.contains_key(&from) {
                return Err(error(ErrorKind::NotFound));
            }
            if to.starts_with(&from) {
                return Err(error(ErrorKind::InvalidInput));
            }
            match to.parent().and_then(|p| tree.get(p)) {
                Some(parent) if parent.data.is_none() => {}
                _ => return Err(error(ErrorKind::NotFound)),
            }
            if let Some(target) = tree.get(&to) {
                let from_dir = tree[&from].data.is_none();
                if target.data.is_none() != from_dir || (from_dir && !children(&tree, &to).is_empty()) {
                    return Err(error(if from_dir { ErrorKind::DirectoryNotEmpty } else { ErrorKind::IsADirectory }));
                }
                tree.remove(&to);
            }
            let keys: Vec<PathBuf> = tree.keys().filter(|p| p.starts_with(&from)).cloned().collect();
            let moved: Vec<(PathBuf, Node)> = keys.into_iter().map(|p| (to.join(p.strip_prefix(&from).unwrap_or(Path::new(""))), tree.remove(&p).unwrap_or_else(Node::dir))).collect();
            for (p, n) in &moved {
                tree.insert(p.clone(), n.clone());
            }
            moved
        };
        changed(Change::Remove(&from));
        changed(Change::Remove(&to));
        for (p, n) in &moved {
            match &n.data {
                Some(data) => changed(Change::Write(p, data)),
                None => changed(Change::MakeDir(p)),
            }
        }
        Ok(())
    }

    pub fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
        let data = read(from)?;
        let len = data.len() as u64;
        put(to.as_ref(), data)?;
        Ok(len)
    }

    /// The normal absolute path, which must exist: there are no links to
    /// follow.
    pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
        let path = normal(path.as_ref());
        if tree().contains_key(&path) { Ok(path) } else { Err(error(ErrorKind::NotFound)) }
    }

    pub fn read_link(path: impl AsRef<Path>) -> io::Result<PathBuf> {
        node(path.as_ref())?;
        Err(error(ErrorKind::InvalidInput))
    }

    pub fn hard_link(_from: impl AsRef<Path>, _to: impl AsRef<Path>) -> io::Result<()> {
        Err(error(ErrorKind::Unsupported))
    }

    pub fn set_permissions(path: impl AsRef<Path>, permissions: Permissions) -> io::Result<()> {
        let path = normal(path.as_ref());
        let mut tree = tree();
        let node = tree.get_mut(&path).ok_or_else(|| error(ErrorKind::NotFound))?;
        node.mode = permissions.mode;
        Ok(())
    }

    pub struct DirEntry {
        path: PathBuf,
        dir: bool,
    }

    impl DirEntry {
        pub fn path(&self) -> PathBuf {
            self.path.clone()
        }

        pub fn file_name(&self) -> OsString {
            self.path.file_name().unwrap_or_default().to_os_string()
        }

        pub fn file_type(&self) -> io::Result<FileType> {
            Ok(FileType { dir: self.dir })
        }

        pub fn metadata(&self) -> io::Result<Metadata> {
            metadata(&self.path)
        }
    }

    pub struct ReadDir(std::vec::IntoIter<DirEntry>);

    impl Iterator for ReadDir {
        type Item = io::Result<DirEntry>;

        fn next(&mut self) -> Option<io::Result<DirEntry>> {
            self.0.next().map(Ok)
        }
    }

    pub fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
        let path = normal(path.as_ref());
        let tree = tree();
        match tree.get(&path) {
            None => return Err(error(ErrorKind::NotFound)),
            Some(n) if n.data.is_some() => return Err(error(ErrorKind::NotADirectory)),
            Some(_) => {}
        }
        let entries = children(&tree, &path).into_iter().map(|p| DirEntry { dir: tree[&p].data.is_none(), path: p }).collect::<Vec<_>>();
        Ok(ReadDir(entries.into_iter()))
    }

    #[derive(Clone, Copy, Default)]
    pub struct FileTimes {
        modified: Option<SystemTime>,
        accessed: Option<SystemTime>,
    }

    impl FileTimes {
        pub fn new() -> FileTimes {
            FileTimes::default()
        }

        pub fn set_modified(mut self, t: SystemTime) -> FileTimes {
            self.modified = Some(t);
            self
        }

        pub fn set_accessed(mut self, t: SystemTime) -> FileTimes {
            self.accessed = Some(t);
            self
        }
    }

    /// An open file: what it holds, read from or written to, written back
    /// to the tree when flushed or closed.
    pub struct File {
        path: PathBuf,
        data: Vec<u8>,
        at: usize,
        write: bool,
        dirty: bool,
    }

    impl File {
        pub fn open(path: impl AsRef<Path>) -> io::Result<File> {
            OpenOptions::new().read(true).open(path)
        }

        pub fn create(path: impl AsRef<Path>) -> io::Result<File> {
            OpenOptions::new().write(true).create(true).truncate(true).open(path)
        }

        pub fn options() -> OpenOptions {
            OpenOptions::new()
        }

        pub fn sync_all(&mut self) -> io::Result<()> {
            io::Write::flush(self)
        }

        pub fn set_times(&self, times: FileTimes) -> io::Result<()> {
            let mut tree = tree();
            let node = tree.get_mut(&self.path).ok_or_else(|| error(ErrorKind::NotFound))?;
            if let Some(t) = times.modified {
                node.modified = t;
            }
            if let Some(t) = times.accessed {
                node.accessed = t;
            }
            Ok(())
        }

        pub fn metadata(&self) -> io::Result<Metadata> {
            metadata(&self.path)
        }
    }

    impl io::Read for File {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(self.data.len() - self.at.min(self.data.len()));
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    impl io::Write for File {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if !self.write {
                return Err(error(ErrorKind::PermissionDenied));
            }
            self.data.truncate(self.at);
            self.data.extend_from_slice(buf);
            self.at = self.data.len();
            self.dirty = true;
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.dirty {
                self.dirty = false;
                put(&self.path, self.data.clone())?;
            }
            Ok(())
        }
    }

    impl Drop for File {
        fn drop(&mut self) {
            let _ = io::Write::flush(self);
        }
    }

    #[derive(Clone, Default)]
    pub struct OpenOptions {
        read: bool,
        write: bool,
        append: bool,
        truncate: bool,
        create: bool,
        create_new: bool,
    }

    impl OpenOptions {
        pub fn new() -> OpenOptions {
            OpenOptions::default()
        }

        pub fn read(&mut self, on: bool) -> &mut OpenOptions {
            self.read = on;
            self
        }

        pub fn write(&mut self, on: bool) -> &mut OpenOptions {
            self.write = on;
            self
        }

        pub fn append(&mut self, on: bool) -> &mut OpenOptions {
            self.append = on;
            self
        }

        pub fn truncate(&mut self, on: bool) -> &mut OpenOptions {
            self.truncate = on;
            self
        }

        pub fn create(&mut self, on: bool) -> &mut OpenOptions {
            self.create = on;
            self
        }

        pub fn create_new(&mut self, on: bool) -> &mut OpenOptions {
            self.create_new = on;
            self
        }

        pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
            let path = normal(path.as_ref());
            let write = self.write || self.append;
            let existing = tree().get(&path).cloned();
            let truncated = write && self.truncate && existing.as_ref().is_some_and(|n| n.data.as_ref().is_some_and(|d| !d.is_empty()));
            let data = match existing {
                Some(_) if self.create_new => return Err(error(ErrorKind::AlreadyExists)),
                Some(n) => match n.data {
                    None if write => return Err(error(ErrorKind::IsADirectory)),
                    None => Vec::new(),
                    Some(_) if write && n.readonly() => return Err(error(ErrorKind::PermissionDenied)),
                    Some(_) if self.truncate => Vec::new(),
                    Some(d) => d,
                },
                None if write && (self.create || self.create_new) => {
                    put(&path, Vec::new())?;
                    Vec::new()
                }
                None => return Err(error(ErrorKind::NotFound)),
            };
            let at = if self.append { data.len() } else { 0 };
            Ok(File { path, data, at, write, dirty: truncated })
        }
    }
}
