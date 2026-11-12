//! What Emacs does with files and directories in C, in fileio.c and dired.c:
//! their attributes, listing a directory, copying, renaming and deleting
//! files, moving them to the trash, and making and deleting directories.
//! Each change asks [`Editor::check_permission`] first, so an agent needs
//! the user's approval.

use crate::vfs as fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::files::abbreviate_path;

/// What kind of file a name names, as the first of Emacs's file attributes.
#[derive(Clone, Debug, PartialEq)]
pub enum FileKind {
    File,
    Directory,
    /// A symbolic link, and what it points to.
    Symlink(String),
}

/// A file's attributes, as Emacs's `file-attributes` gives them, for the
/// file itself rather than what a link points to.
#[derive(Clone, Debug, PartialEq)]
pub struct FileAttributes {
    pub kind: FileKind,
    pub links: u64,
    pub uid: u32,
    pub gid: u32,
    pub user: String,
    pub group: String,
    pub size: u64,
    pub modified: SystemTime,
    pub accessed: SystemTime,
    /// The mode as `ls -l` writes it, such as `-rw-r--r--` or `drwxr-xr-x`.
    pub modes: String,
    pub inode: u64,
}

/// A file's attributes, or `None` if there is no such file.
pub fn file_attributes(path: &Path) -> Option<FileAttributes> {
    let meta = fs::symlink_metadata(path).ok()?;
    let kind = if meta.file_type().is_symlink() {
        FileKind::Symlink(fs::read_link(path).map(|t| t.display().to_string()).unwrap_or_default())
    } else if meta.is_dir() {
        FileKind::Directory
    } else {
        FileKind::File
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileAttributes {
            modes: mode_string(meta.mode(), &kind),
            kind,
            links: meta.nlink(),
            uid: meta.uid(),
            gid: meta.gid(),
            user: user_name(meta.uid()),
            group: group_name(meta.gid()),
            size: meta.len(),
            modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            accessed: meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH),
            inode: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let modes = match kind {
            FileKind::Directory => "drwxrwxrwx",
            FileKind::Symlink(_) => "lrwxrwxrwx",
            FileKind::File if meta.permissions().readonly() => "-r--r--r--",
            FileKind::File => "-rw-rw-rw-",
        };
        Some(FileAttributes {
            modes: modes.to_string(),
            kind,
            links: 1,
            uid: 0,
            gid: 0,
            user: String::new(),
            group: String::new(),
            size: meta.len(),
            modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            accessed: meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH),
            inode: 0,
        })
    }
}

/// A mode as `ls -l` writes it.
#[cfg(unix)]
fn mode_string(mode: u32, kind: &FileKind) -> String {
    let kind = match kind {
        FileKind::Directory => 'd',
        FileKind::Symlink(_) => 'l',
        FileKind::File => match mode & 0o170000 {
            0o060000 => 'b',
            0o020000 => 'c',
            0o010000 => 'p',
            0o140000 => 's',
            _ => '-',
        },
    };
    let mut out = String::from(kind);
    for (shift, special, set, unset) in [(6, 0o4000, 's', 'S'), (3, 0o2000, 's', 'S'), (0, 0o1000, 't', 'T')] {
        let bits = (mode >> shift) & 7;
        out.push(if bits & 4 != 0 { 'r' } else { '-' });
        out.push(if bits & 2 != 0 { 'w' } else { '-' });
        out.push(match (bits & 1 != 0, mode & special != 0) {
            (true, true) => set,
            (false, true) => unset,
            (true, false) => 'x',
            (false, false) => '-',
        });
    }
    out
}

#[cfg(unix)]
pub(crate) fn user_name(uid: u32) -> String {
    let mut buf = vec![0u8; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    // SAFETY: getpwuid_r writes only into pwd and buf, which outlive the call.
    let ok = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result) } == 0;
    if !ok || result.is_null() {
        return uid.to_string();
    }
    // SAFETY: on success pw_name points to a NUL-terminated string in buf.
    unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }.to_string_lossy().into_owned()
}

#[cfg(unix)]
pub(crate) fn group_name(gid: u32) -> String {
    let mut buf = vec![0u8; 4096];
    let mut grp: libc::group = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    // SAFETY: getgrgid_r writes only into grp and buf, which outlive the call.
    let ok = unsafe { libc::getgrgid_r(gid, &mut grp, buf.as_mut_ptr().cast(), buf.len(), &mut result) } == 0;
    if !ok || result.is_null() {
        return gid.to_string();
    }
    // SAFETY: on success gr_name points to a NUL-terminated string in buf.
    unsafe { std::ffi::CStr::from_ptr(grp.gr_name) }.to_string_lossy().into_owned()
}

/// The names in a directory, with `.` and `..`, sorted, as Emacs's
/// `directory-files`.
pub fn directory_files(dir: &Path) -> Result<Vec<String>> {
    let entries = fs::read_dir(dir).map_err(|e| file_error("Opening directory", &e, &[dir]))?;
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.extend([".".to_string(), "..".to_string()]);
    names.sort();
    Ok(names)
}

/// An error as Emacs reports a failed system call on files: what it was
/// doing, why it failed, and the files, as "Renaming: No such file or
/// directory, /a, /b".
pub fn file_error(doing: &str, e: &io::Error, files: &[&Path]) -> Error {
    let why = match e.kind() {
        io::ErrorKind::NotFound => "No such file or directory".to_string(),
        io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        io::ErrorKind::AlreadyExists => "File exists".to_string(),
        io::ErrorKind::DirectoryNotEmpty => "Directory not empty".to_string(),
        _ => {
            let text = e.to_string();
            text.split(" (os error").next().unwrap_or(&text).to_string()
        }
    };
    let names: Vec<String> = files.iter().map(|f| f.display().to_string()).collect();
    // file-error's family, with its data as Emacs's: what, why, the files.
    let symbol = match e.kind() {
        io::ErrorKind::NotFound => "file-missing",
        io::ErrorKind::AlreadyExists => "file-already-exists",
        io::ErrorKind::PermissionDenied => "permission-denied",
        _ => "file-error",
    };
    let mut data = vec![crate::Value::Str(doing.to_string()), crate::Value::Str(why.clone())];
    data.extend(names.iter().map(|n| crate::Value::Str(n.clone())));
    Error::signal(symbol, format!("{doing}: {why}, {}", names.join(", ")), data)
}

/// Where a copy or rename to `to` goes: into it, if it is a directory name,
/// ending in a slash, as Emacs's `expand_cp_target`.
fn target(from: &Path, to: &Path, to_is_dir_name: bool) -> PathBuf {
    if to_is_dir_name {
        to.join(from.file_name().unwrap_or_default())
    } else {
        to.to_path_buf()
    }
}

/// The directories version control keeps to itself, as Emacs's
/// `vc-directory-exclusion-list`.
pub const VC_DIRECTORIES: &[&str] = &["SCCS", "RCS", "CVS", "MCVS", ".src", ".svn", ".git", ".hg", ".bzr", "_MTN", "_darcs", "{arch}", ".repo", ".jj"];

/// A Git work tree's files, as `git ls-files` lists those it tracks and
/// those it does not ignore, the way Emacs's `project-files` asks for them,
/// or `None` if `root` is not in one or Git cannot be run.
pub fn vc_files(root: &Path) -> Option<Vec<PathBuf>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "-c", "-o", "--exclude-standard"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut files: Vec<PathBuf> = output
        .stdout
        .split(|&b| b == 0)
        .filter(|name| !name.is_empty())
        .map(|name| root.join(String::from_utf8_lossy(name).as_ref()))
        .filter(|path| fs::path_exists(path))
        .collect();
    files.sort();
    files.dedup();
    Some(files)
}

/// The files under a directory, leaving out version control's own and those
/// in `ignores`, as Emacs's `project--files-in-directory`.
pub fn files_in_directory(dir: &Path, ignores: &[String]) -> Vec<PathBuf> {
    fn walk(dir: &Path, ignores: &[String], out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if VC_DIRECTORIES.contains(&name.as_str()) || ignores.contains(&name) {
                continue;
            }
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&path, ignores, out),
                Ok(_) => out.push(path),
                Err(_) => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, ignores, &mut out);
    out.sort();
    out
}

impl Editor {
    /// Copies a file, as Emacs's `copy-file`: into `to` if it is a directory name,
    /// keeping the modification time if asked. A file already there is
    /// replaced only if `ok_if_exists`.
    pub fn copy_file(&mut self, from: &Path, to: &Path, to_is_dir_name: bool, ok_if_exists: bool, keep_time: bool) -> Result<PathBuf> {
        let to = target(from, to, to_is_dir_name);
        if !fs::path_exists(from) {
            return Err(file_error("Opening input file", &io::Error::from(io::ErrorKind::NotFound), &[from]));
        }
        // As Emacs's copy-file, which copies only regular files.
        if fs::path_is_dir(from) {
            return Err(file_error("Non-regular file", &io::Error::other("Is a directory"), &[from]));
        }
        if fs::path_exists(&to) && !ok_if_exists {
            return Err(Error::new(format!("File already exists: {}", to.display())));
        }
        self.check_permission(&format!("copy {} to {}", abbreviate_path(from), abbreviate_path(&to)))?;
        fs::copy(from, &to).map_err(|e| file_error("Copying file", &e, &[from, &to]))?;
        if keep_time && let Ok(meta) = fs::metadata(from) {
            let times = fs::FileTimes::new().set_modified(meta.modified().unwrap_or(crate::clock::system_now()));
            let _ = fs::File::options().write(true).open(&to).and_then(|f| f.set_times(times));
        }
        Ok(to)
    }

    /// Copies a directory and what it holds, as Emacs's `copy-directory`:
    /// into `to` if that is a directory already, else as `to`.
    pub fn copy_directory(&mut self, from: &Path, to: &Path, keep_time: bool) -> Result<PathBuf> {
        let to = if fs::path_is_dir(to) { to.join(from.file_name().unwrap_or_default()) } else { to.to_path_buf() };
        self.check_permission(&format!("copy {} to {}", abbreviate_path(from), abbreviate_path(&to)))?;
        fn copy_tree(from: &Path, to: &Path, keep_time: bool) -> io::Result<()> {
            fs::create_dir_all(to)?;
            for entry in fs::read_dir(from)? {
                let entry = entry?;
                let (src, dst) = (entry.path(), to.join(entry.file_name()));
                if entry.file_type()?.is_dir() {
                    copy_tree(&src, &dst, keep_time)?;
                } else {
                    fs::copy(&src, &dst)?;
                    if keep_time && let Ok(meta) = fs::metadata(&src) {
                        let times = fs::FileTimes::new().set_modified(meta.modified()?);
                        fs::File::options().write(true).open(&dst)?.set_times(times)?;
                    }
                }
            }
            Ok(())
        }
        copy_tree(from, &to, keep_time).map_err(|e| file_error("Copying directory", &e, &[from, &to]))?;
        Ok(to)
    }

    /// Renames a file or directory, as Emacs's `rename-file`: into `to` if it
    /// is a directory name. A file already there is replaced only if
    /// `ok_if_exists`.
    pub fn rename_file(&mut self, from: &Path, to: &Path, to_is_dir_name: bool, ok_if_exists: bool) -> Result<PathBuf> {
        let to = target(from, to, to_is_dir_name);
        if fs::symlink_metadata(from).is_err() {
            return Err(file_error("Renaming", &io::Error::from(io::ErrorKind::NotFound), &[from, &to]));
        }
        if fs::path_exists(&to) && !ok_if_exists {
            return Err(Error::new(format!("File already exists: {}", to.display())));
        }
        self.check_permission(&format!("rename {} to {}", abbreviate_path(from), abbreviate_path(&to)))?;
        if let Err(e) = fs::rename(from, &to) {
            // Across file systems, copy and delete, as Emacs does.
            if e.raw_os_error() != Some(18) || fs::path_is_dir(from) {
                return Err(file_error("Renaming", &e, &[from, &to]));
            }
            fs::copy(from, &to).map_err(|e| file_error("Renaming", &e, &[from, &to]))?;
            fs::remove_file(from).map_err(|e| file_error("Removing old name", &e, &[from]))?;
        }
        Ok(to)
    }

    /// Makes `link` a symbolic link to `target`, as Emacs's
    /// `make-symbolic-link`: `target` is kept as written, so a relative one
    /// is relative to the link's directory. A file already at `link` is
    /// replaced only if `ok_if_exists`.
    pub fn make_symbolic_link(&mut self, target: &str, link: &Path, ok_if_exists: bool) -> Result<()> {
        if fs::symlink_metadata(link).is_ok() {
            if !ok_if_exists {
                return Err(Error::new(format!("File already exists: {}", link.display())));
            }
            self.check_permission(&format!("replace {} with a link to {target}", abbreviate_path(link)))?;
            fs::remove_file(link).map_err(|e| file_error("Making symbolic link", &e, &[link]))?;
        } else {
            self.check_permission(&format!("make {} a link to {target}", abbreviate_path(link)))?;
        }
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, link).map_err(|e| file_error("Making symbolic link", &e, &[Path::new(target), link]));
        #[cfg(not(unix))]
        Err(Error::new("Symbolic links are not supported here"))
    }

    /// Gives `file` another name, `new`, as Emacs's `add-name-to-file`: a
    /// hard link. A file already at `new` is replaced only if `ok_if_exists`.
    pub fn add_name_to_file(&mut self, file: &Path, new: &Path, ok_if_exists: bool) -> Result<()> {
        if fs::symlink_metadata(new).is_ok() {
            if !ok_if_exists {
                return Err(Error::new(format!("File already exists: {}", new.display())));
            }
            self.check_permission(&format!("replace {} with another name for {}", abbreviate_path(new), abbreviate_path(file)))?;
            fs::remove_file(new).map_err(|e| file_error("Adding new name", &e, &[new]))?;
        } else {
            self.check_permission(&format!("give {} the name {}", abbreviate_path(file), abbreviate_path(new)))?;
        }
        fs::hard_link(file, new).map_err(|e| file_error("Adding new name", &e, &[file, new]))
    }

    /// Deletes a file, as Emacs's `delete-file`: to the system's trash if
    /// `trash` and `delete-by-moving-to-trash` say so. A file that does not
    /// exist is no error.
    pub fn delete_file(&mut self, file: &Path, trash: bool) -> Result<()> {
        if fs::symlink_metadata(file).is_err() {
            return Ok(());
        }
        if fs::path_is_dir(file) && !fs::path_is_symlink(file) {
            return Err(Error::new(format!("Removing old name: Is a directory, {}", file.display())));
        }
        self.remove(file, trash, false)
    }

    /// Makes a directory, as Emacs's `make-directory`, with any missing
    /// parents if `parents`. Without, a directory already there is an error.
    pub fn make_directory(&mut self, dir: &Path, parents: bool) -> Result<()> {
        if parents && fs::path_is_dir(dir) {
            return Ok(());
        }
        self.check_permission(&format!("make directory {}", abbreviate_path(dir)))?;
        let made = if parents { fs::create_dir_all(dir) } else { fs::create_dir(dir) };
        made.map_err(|e| file_error("Creating directory", &e, &[dir]))
    }

    /// Deletes a directory, as Emacs's `delete-directory`: one with files in
    /// it only if `recursive`, to the trash if `trash` and
    /// `delete-by-moving-to-trash` say so.
    pub fn delete_directory(&mut self, dir: &Path, recursive: bool, trash: bool) -> Result<()> {
        if !recursive && fs::read_dir(dir).is_ok_and(|mut d| d.next().is_some()) {
            return Err(file_error("Removing directory", &io::Error::from(io::ErrorKind::DirectoryNotEmpty), &[dir]));
        }
        self.remove(dir, trash, true)
    }

    /// Moves a file or directory to the system's trash, as Emacs's
    /// `system-move-file-to-trash`. Files in memory have no trash; there
    /// it is deleted.
    pub fn system_move_file_to_trash(&mut self, path: &Path) -> Result<()> {
        self.check_permission(&format!("move to the trash {}", abbreviate_path(path)))?;
        #[cfg(not(any(target_arch = "wasm32", feature = "memory-fs")))]
        {
            trash::delete(path).map_err(|e| Error::new(format!("Moving to trash: {e}, {}", path.display())))
        }
        #[cfg(any(target_arch = "wasm32", feature = "memory-fs"))]
        {
            let removed = if fs::path_is_dir(path) { fs::remove_dir_all(path) } else { fs::remove_file(path) };
            removed.map_err(|e| file_error("Removing old name", &e, &[path]))
        }
    }

    /// Writes text to a file, replacing what it held, as Emacs's
    /// `write-region` of a whole temporary buffer does, for saved state
    /// such as recentf's list.
    pub fn write_text_file(&mut self, path: &Path, text: &str) -> Result<()> {
        self.write_text_file_with_mode(path, text, None)
    }

    /// Writes a file and, on Unix, gives it permissions `mode`, as
    /// savehist-file-modes keeps history private.
    pub fn write_text_file_with_mode(&mut self, path: &Path, text: &str, mode: Option<u32>) -> Result<()> {
        self.check_permission(&format!("write {}", abbreviate_path(path)))?;
        fs::write(path, text).map_err(|e| file_error("Opening output file", &e, &[path]))?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| file_error("Setting file modes", &e, &[path]))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        Ok(())
    }

    fn remove(&mut self, path: &Path, trash: bool, dir: bool) -> Result<()> {
        let to_trash = trash && self.variable("delete-by-moving-to-trash").is_some_and(|v| v.is_true());
        let what = if to_trash { "move to the trash" } else { "delete" };
        self.check_permission(&format!("{what} {}", abbreviate_path(path)))?;
        // Files in memory have no trash: deleting them is final.
        #[cfg(not(any(target_arch = "wasm32", feature = "memory-fs")))]
        if to_trash {
            return trash::delete(path).map_err(|e| Error::new(format!("Moving to trash: {e}, {}", path.display())));
        }
        let removed = if dir { fs::remove_dir_all(path) } else { fs::remove_file(path) };
        removed.map_err(|e| file_error(if dir { "Removing directory" } else { "Removing old name" }, &e, &[path]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_read_as_ls_writes_them() {
        assert_eq!(mode_string(0o100644, &FileKind::File), "-rw-r--r--");
        assert_eq!(mode_string(0o040755, &FileKind::Directory), "drwxr-xr-x");
        assert_eq!(mode_string(0o104755, &FileKind::File), "-rwsr-xr-x");
        assert_eq!(mode_string(0o041777, &FileKind::Directory), "drwxrwxrwt");
    }

    #[test]
    fn copying_renaming_and_deleting_as_emacs_does() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        fs::write(&a, "one").unwrap();
        let mut ed = Editor::new();
        let b = dir.path().join("b.txt");
        ed.copy_file(&a, &b, false, false, false).unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "one");
        let again = ed.copy_file(&a, &b, false, false, false).unwrap_err();
        assert_eq!(again.to_string(), format!("File already exists: {}", b.display()));
        let sub = dir.path().join("sub");
        ed.make_directory(&sub, false).unwrap();
        assert!(ed.make_directory(&sub, false).unwrap_err().to_string().starts_with("Creating directory: File exists, "));
        let moved = ed.rename_file(&b, &sub, true, false).unwrap();
        assert_eq!(moved, sub.join("b.txt"), "into a directory");
        let refused = ed.delete_directory(&sub, false, false).unwrap_err();
        assert_eq!(refused.to_string(), format!("Removing directory: Directory not empty, {}", sub.display()));
        ed.delete_file(&moved, false).unwrap();
        ed.delete_directory(&sub, false, false).unwrap();
        assert_eq!(directory_files(dir.path()).unwrap(), [".", "..", "a.txt"]);
        ed.delete_file(&dir.path().join("nothing"), false).unwrap();
    }

    #[test]
    fn an_agent_needs_approval() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        fs::write(&a, "one").unwrap();
        let mut ed = Editor::new();
        ed.set_agent_acting(true);
        let refused = ed.delete_file(&a, false).unwrap_err();
        assert!(refused.to_string().starts_with("Needs the user's approval: delete "), "{refused}");
        assert!(a.exists());
    }
}
