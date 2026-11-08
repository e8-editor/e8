//! The file primitives Lisp calls itself, as Emacs's fileio.c and dired.c
//! give them: `insert-file-contents` and `write-region`, the `file-*-p`
//! predicates, modes and times, temporary files, true names and
//! substituting variables in names, with each first offered to a handler
//! in `file-name-handler-alist`, as TRAMP and archive modes are built on.
//!
//! A handler is a function called with the operation's name and its
//! arguments, which does the operation itself, perhaps on another machine
//! or inside an archive. To do the real operation in turn it binds
//! `inhibit-file-name-handlers` to a list with itself and
//! `inhibit-file-name-operation` to the operation, as in Emacs.

use crate::vfs as fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::fileops::file_error;
use crate::variables::Value;

/// What `write-region` writes: the whole buffer, a stretch of it, or a string.
#[derive(Clone, Debug, PartialEq)]
pub enum WriteSource {
    Buffer,
    Region(usize, usize),
    Text(String),
}

/// What `write-region` does with the file it writes, as its VISIT says:
/// nothing but say so (nil), nothing at all (a symbol other than t), make
/// the buffer visit it (t), or visit another name (a string).
#[derive(Clone, Debug, PartialEq)]
pub enum Visit {
    No,
    Quiet,
    Yes,
    Name(String),
}

fn s(text: &str) -> Value {
    Value::Str(text.to_string())
}

/// Whether the system lets this process at a file in a way, as access(2) says.
#[cfg(all(unix, not(feature = "memory-fs")))]
fn access(path: &Path, mode: libc::c_int) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(c.as_ptr(), mode) == 0 }
}

/// As access(2) would say of a file in memory: anything there can be read,
/// what is not read-only written, and only directories gone into.
#[cfg(all(unix, feature = "memory-fs"))]
fn access(path: &Path, mode: libc::c_int) -> bool {
    fs::metadata(path).is_ok_and(|m| (mode & libc::W_OK == 0 || !m.permissions().readonly()) && (mode & libc::X_OK == 0 || m.is_dir()))
}

impl Editor {
    /// The handler for an operation on a file name, as Emacs's
    /// `find-file-name-handler`: of the entries of `file-name-handler-alist`
    /// whose regexp matches the name, the one matching furthest along it,
    /// leaving out those `inhibit-file-name-handlers` lists while the
    /// operation is `inhibit-file-name-operation`, and those whose
    /// `operations` property does not name the operation.
    pub fn find_file_name_handler(&self, file: &str, operation: &str) -> Option<Value> {
        let Some(Value::List(alist)) = self.variable("file-name-handler-alist") else { return None };
        let inhibited = match (self.variable("inhibit-file-name-operation"), self.variable("inhibit-file-name-handlers")) {
            (Some(op), Some(Value::List(handlers))) if op.as_str() == Some(operation) => handlers,
            _ => Vec::new(),
        };
        let name_of = |v: &Value| v.as_str().map(str::to_string);
        let mut best: Option<(usize, Value)> = None;
        for entry in alist {
            let Value::List(pair) = entry else { continue };
            let (Some(regexp), Some(handler)) = (pair.first().and_then(Value::as_str), pair.get(1)) else { continue };
            if inhibited.iter().any(|h| h == handler || (name_of(h).is_some() && name_of(h) == name_of(handler))) {
                continue;
            }
            if let Some(name) = name_of(handler)
                && let Some(Value::List(ops)) = self.get(&name, "operations")
                && !ops.iter().any(|o| o.as_str() == Some(operation))
            {
                continue;
            }
            if let Ok(Some(m)) = self.string_match(regexp, file, 0, false)
                && best.as_ref().is_none_or(|(at, _)| m.start > *at)
            {
                best = Some((m.start, handler.clone()));
            }
        }
        best.map(|(_, handler)| handler)
    }

    /// Offers an operation on a file to its handler, if it has one: the
    /// handler's value, or `None` to do the operation here.
    pub(crate) fn handled(&mut self, operation: &str, file: &str, args: Vec<Value>) -> Option<Result<Value>> {
        let handler = self.find_file_name_handler(file, operation)?;
        let mut all = vec![Value::Symbol(operation.to_string())];
        all.extend(args);
        Some(self.funcall(&handler, &all))
    }

    /// A file name made absolute, as the primitives take it before looking
    /// for a handler.
    fn absolute(&self, file: &str) -> String {
        self.expand_file_name(file).display().to_string()
    }

    fn predicate(&mut self, operation: &str, file: &str, test: impl FnOnce(&Path) -> bool) -> Result<bool> {
        let file = self.absolute(file);
        if let Some(r) = self.handled(operation, &file, vec![s(&file)]) {
            return r.map(|v| v.is_true());
        }
        Ok(test(Path::new(&file)))
    }

    /// Whether a file exists, through symbolic links, as `file-exists-p`.
    pub fn file_exists_p(&mut self, file: &str) -> Result<bool> {
        self.predicate("file-exists-p", file, |p| fs::path_exists(p))
    }

    /// Whether this process can read a file, as `file-readable-p`.
    pub fn file_readable_p(&mut self, file: &str) -> Result<bool> {
        #[cfg(unix)]
        return self.predicate("file-readable-p", file, |p| access(p, libc::R_OK));
        #[cfg(not(unix))]
        return self.predicate("file-readable-p", file, |p| fs::File::open(p).is_ok());
    }

    /// Whether this process could write a file: the file itself if it
    /// exists, else its directory, as `file-writable-p`.
    pub fn file_writable_p(&mut self, file: &str) -> Result<bool> {
        self.predicate("file-writable-p", file, |p| {
            #[cfg(unix)]
            {
                if fs::path_exists(p) {
                    access(p, libc::W_OK)
                } else {
                    p.parent().is_some_and(|d| fs::path_is_dir(d) && access(d, libc::W_OK))
                }
            }
            #[cfg(not(unix))]
            {
                fs::metadata(p).map_or_else(|_| p.parent().is_some_and(|d| fs::path_is_dir(d)), |m| !m.permissions().readonly())
            }
        })
    }

    /// Whether a file can be run, or a directory searched, as `file-executable-p`.
    pub fn file_executable_p(&mut self, file: &str) -> Result<bool> {
        #[cfg(unix)]
        return self.predicate("file-executable-p", file, |p| access(p, libc::X_OK));
        #[cfg(not(unix))]
        return self.predicate("file-executable-p", file, |p| fs::path_is_dir(p));
    }

    /// Whether a file is a directory, through symbolic links, as `file-directory-p`.
    pub fn file_directory_p(&mut self, file: &str) -> Result<bool> {
        self.predicate("file-directory-p", file, |p| fs::path_is_dir(p))
    }

    /// Whether a file is a regular file, through symbolic links, as `file-regular-p`.
    pub fn file_regular_p(&mut self, file: &str) -> Result<bool> {
        self.predicate("file-regular-p", file, |p| fs::path_is_file(p))
    }

    /// Whether a directory can be listed and entered, as `file-accessible-directory-p`.
    pub fn file_accessible_directory_p(&mut self, file: &str) -> Result<bool> {
        #[cfg(unix)]
        return self.predicate("file-accessible-directory-p", file, |p| fs::path_is_dir(p) && access(p, libc::X_OK));
        #[cfg(not(unix))]
        return self.predicate("file-accessible-directory-p", file, |p| fs::path_is_dir(p));
    }

    /// What a symbolic link points to, as `file-symlink-p`, or `None` if
    /// the file is not one.
    pub fn file_symlink_p(&mut self, file: &str) -> Result<Option<String>> {
        let file = self.absolute(file);
        if let Some(r) = self.handled("file-symlink-p", &file, vec![s(&file)]) {
            return r.map(|v| v.as_str().map(str::to_string));
        }
        Ok(fs::read_link(&file).ok().map(|t| t.display().to_string()))
    }

    /// Whether the file system holding `file` ignores the case of names, as
    /// `file-name-case-insensitive-p`: asked of the nearest directory that
    /// exists, on macOS by pathconf, as Emacs asks; elsewhere case counts.
    pub fn file_name_case_insensitive_p(&mut self, file: &str) -> bool {
        let mut path = PathBuf::from(self.absolute(file));
        while !fs::path_exists(&path) {
            if !path.pop() {
                return false;
            }
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
            // 0 for a file system that ignores case.
            unsafe { libc::pathconf(c.as_ptr(), libc::_PC_CASE_SENSITIVE) == 0 }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            false
        }
    }

    /// Whether one file was modified after another, as
    /// `file-newer-than-file-p`: if only the first exists, it is newer.
    pub fn file_newer_than_file_p(&mut self, a: &str, b: &str) -> Result<bool> {
        let (a, b) = (self.absolute(a), self.absolute(b));
        if let Some(r) = self.handled("file-newer-than-file-p", &a, vec![s(&a), s(&b)]) {
            return r.map(|v| v.is_true());
        }
        let time = |p: &str| fs::metadata(p).and_then(|m| m.modified()).ok();
        Ok(match (time(&a), time(&b)) {
            (Some(ta), Some(tb)) => ta > tb,
            (Some(_), None) => true,
            _ => false,
        })
    }

    /// A file's mode bits, as `file-modes`, or `None` if there is no such
    /// file; with `nofollow`, a symbolic link's own.
    pub fn file_modes(&mut self, file: &str, nofollow: bool) -> Result<Option<u32>> {
        let file = self.absolute(file);
        if let Some(r) = self.handled("file-modes", &file, vec![s(&file)]) {
            return r.map(|v| v.as_number().map(|n| n as u32));
        }
        let meta = if nofollow { fs::symlink_metadata(&file) } else { fs::metadata(&file) };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            Ok(meta.ok().map(|m| m.permissions().mode() & 0o7777))
        }
        #[cfg(not(unix))]
        Ok(meta.ok().map(|m| if m.permissions().readonly() { 0o444 } else { 0o644 }))
    }

    /// Sets a file's mode bits, as `set-file-modes`.
    pub fn set_file_modes(&mut self, file: &str, mode: u32) -> Result<()> {
        let file = self.absolute(file);
        if let Some(r) = self.handled("set-file-modes", &file, vec![s(&file), Value::Number(mode as f64)]) {
            return r.map(drop);
        }
        self.check_permission(&format!("change the modes of {}", crate::files::abbreviate_path(Path::new(&file))))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).map_err(|e| file_error("Doing chmod", &e, &[Path::new(&file)]))
        }
        #[cfg(not(unix))]
        Ok(())
    }

    /// Sets when a file was last modified and read, to `time` in
    /// milliseconds since 1970 or to now, as `set-file-times`.
    pub fn set_file_times(&mut self, file: &str, time: Option<f64>) -> Result<()> {
        let file = self.absolute(file);
        let arg = time.map_or(Value::Null, Value::Number);
        if let Some(r) = self.handled("set-file-times", &file, vec![s(&file), arg]) {
            return r.map(drop);
        }
        self.check_permission(&format!("change the times of {}", crate::files::abbreviate_path(Path::new(&file))))?;
        let when = time.map_or_else(crate::clock::system_now, |ms| UNIX_EPOCH + Duration::from_millis(ms.max(0.0) as u64));
        let f = fs::File::options().write(true).open(&file).or_else(|_| fs::File::open(&file)).map_err(|e| file_error("Setting file times", &e, &[Path::new(&file)]))?;
        f.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when)).map_err(|e| file_error("Setting file times", &e, &[Path::new(&file)]))
    }

    /// A file's name with the symbolic links in it followed, as
    /// `file-truename`: as much of it as exists, the rest as it is.
    pub fn file_truename(&mut self, file: &str) -> Result<String> {
        let file = self.absolute(file);
        if let Some(r) = self.handled("file-truename", &file, vec![s(&file)]) {
            return r.map(|v| v.as_str().unwrap_or(&file).to_string());
        }
        let path = PathBuf::from(&file);
        let mut existing = path.clone();
        let mut rest = Vec::new();
        while !fs::path_exists(&existing) {
            let Some(name) = existing.file_name().map(|n| n.to_os_string()) else { break };
            rest.push(name);
            if !existing.pop() {
                break;
            }
        }
        let mut real = fs::canonicalize(&existing).unwrap_or(existing);
        for name in rest.into_iter().rev() {
            real.push(name);
        }
        let mut out = real.display().to_string();
        if file.ends_with('/') && !out.ends_with('/') {
            out.push('/');
        }
        Ok(out)
    }

    /// The names in a directory, as Emacs's `directory-files`: with `full`,
    /// as absolute names; only those `pattern`, an Emacs regexp, matches;
    /// sorted unless `nosort`; at most `count` of them.
    pub fn directory_files(&mut self, dir: &str, full: bool, pattern: Option<&str>, nosort: bool, count: Option<usize>) -> Result<Vec<String>> {
        let dir = self.absolute(dir);
        let args = vec![s(&dir), Value::Bool(full), pattern.map_or(Value::Null, s), Value::Bool(nosort), count.map_or(Value::Null, |c| Value::Number(c as f64))];
        if let Some(r) = self.handled("directory-files", &dir, args) {
            return r.map(|v| match v {
                Value::List(items) => items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            });
        }
        let mut names = crate::fileops::directory_files(Path::new(&dir))?;
        if let Some(pattern) = pattern {
            let mut kept = Vec::new();
            for name in names {
                if self.string_match(pattern, &name, 0, false)?.is_some() {
                    kept.push(name);
                }
            }
            names = kept;
        }
        // Unsorted, Emacs gives the directory's own order; sorted serves as well.
        let _ = nosort;
        if let Some(count) = count {
            names.truncate(count);
        }
        if full {
            let base = PathBuf::from(&dir);
            names = names.into_iter().map(|n| base.join(n).display().to_string()).collect();
        }
        Ok(names)
    }

    /// Makes a file, or with `dir` a directory, of a new name starting with
    /// `prefix` in `temporary-file-directory`, holding `text` if given, as
    /// `make-temp-file`, and returns its name.
    pub fn make_temp_file(&mut self, prefix: &str, dir: bool, suffix: &str, text: Option<&str>) -> Result<String> {
        let base = match self.variable("temporary-file-directory").and_then(|v| v.as_str().map(str::to_string)) {
            Some(t) => PathBuf::from(t),
            None => crate::clock::temp_dir(),
        };
        let base = if fs::is_absolute(prefix) { PathBuf::new() } else { base };
        // Making a file is writing one, which waits for the user's approval
        // while an agent acts, wherever it is.
        let place = base.join(prefix);
        self.check_permission(&format!("make a temporary file at {}", place.display()))?;
        const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let mut seed = crate::clock::system_now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64) ^ ((crate::clock::process_id() as u64) << 32);
        for _ in 0..100 {
            let mut name = String::from(prefix);
            for _ in 0..6 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                name.push(LETTERS[(seed >> 33) as usize % LETTERS.len()] as char);
            }
            name.push_str(suffix);
            let path = base.join(&name);
            let made = if dir {
                fs::create_dir(&path)
            } else {
                fs::File::options().write(true).create_new(true).open(&path).and_then(|mut f| {
                    use std::io::Write;
                    f.write_all(text.unwrap_or_default().as_bytes())
                })
            };
            match made {
                Ok(()) => return Ok(path.display().to_string()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(file_error("Creating file with prefix", &e, &[&path])),
            }
        }
        Err(Error::new("Cannot create temporary file"))
    }

    /// Inserts a file's text after point, as Emacs's `insert-file-contents`,
    /// decoded as the file's coding says, and returns the file's absolute
    /// name and how many characters went in; `beg` and `end` take only those
    /// bytes. With `visit`, in an unmodified buffer, the buffer visits the
    /// file and is unmodified afterwards, though the file need not exist.
    /// With `replace`, the file's text replaces the buffer's accessible text,
    /// what is the same at its start and end staying, point and markers there.
    pub fn insert_file_contents(&mut self, file: &str, visit: bool, beg: Option<usize>, end: Option<usize>, replace: bool) -> Result<(String, usize)> {
        let file = self.absolute(file);
        let num = |n: Option<usize>| n.map_or(Value::Null, |n| Value::Number(n as f64));
        if let Some(r) = self.handled("insert-file-contents", &file, vec![s(&file), Value::Bool(visit), num(beg), num(end), Value::Bool(replace)]) {
            let v = r?;
            let Value::List(items) = v else { return Ok((file, 0)) };
            let name = items.first().and_then(Value::as_str).unwrap_or(&file).to_string();
            let n = items.get(1).and_then(Value::as_number).unwrap_or(0.0) as usize;
            return Ok((name, n));
        }
        let path = PathBuf::from(&file);
        if visit && (beg.is_some() || end.is_some()) {
            return Err(Error::new("Attempt to visit less than an entire file"));
        }
        if visit && self.buffer().is_modified() && !replace {
            return Err(Error::new("Cannot do file visiting in a non-empty buffer"));
        }
        if visit {
            let b = self.buffer_mut();
            b.path = Some(path.clone());
            b.set_visited_file_modtime();
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => return Err(file_error("Opening input file", &e, &[&path])),
        };
        let bytes = match (beg, end) {
            (None, None) => &bytes[..],
            (b, e) => &bytes[b.unwrap_or(0).min(bytes.len())..e.unwrap_or(bytes.len()).min(bytes.len()).max(b.unwrap_or(0).min(bytes.len()))],
        };
        let (text, coding) = crate::coding::decode_file(bytes, self.coding_for_read());
        self.set_variable("last-coding-system-used", Value::Str(coding.name()));
        let n = text.chars().count();
        if replace {
            self.replace_accessible_text(&text)?;
        } else {
            let point = self.buffer().point();
            self.insert(&text)?;
            self.buffer_mut().set_point(point);
        }
        if visit {
            let b = self.buffer_mut();
            b.set_coding(coding);
            b.mark_saved();
        }
        Ok((file, n))
    }

    /// Replaces the accessible text with `text`, keeping what is the same at
    /// its start and end, with point kept in proportion within what changes,
    /// as reverting and `insert-file-contents` with REPLACE do.
    pub(crate) fn replace_accessible_text(&mut self, text: &str) -> Result<()> {
        let b = self.buffer();
        let (min, max) = (b.point_min(), b.point_max());
        let change = crate::fileio::Difference::between(b.text().slice(min..max), text);
        let point = change.keep(b.point() - min);
        self.replace_range(min + change.prefix, min + change.old_end, change.middle(text))?;
        self.buffer_mut().set_point(min + point);
        Ok(())
    }

    /// Writes text to a file, as Emacs's `write-region`: the buffer, a
    /// stretch of it or a string, encoded as `buffer-file-coding-system`
    /// says; `append` adds to the end of the file; `mustbenew` refuses a
    /// file that exists. Says "Wrote" unless `visit` is quiet; with `visit`,
    /// the buffer visits the file and is unmodified afterwards.
    pub fn write_region(&mut self, source: WriteSource, file: &str, append: bool, visit: Visit, mustbenew: bool) -> Result<()> {
        let file = self.absolute(file);
        let source_value = match &source {
            WriteSource::Buffer => (Value::Null, Value::Null),
            WriteSource::Region(a, b) => (Value::Number(*a as f64), Value::Number(*b as f64)),
            WriteSource::Text(t) => (s(t), Value::Null),
        };
        let visit_value = match &visit {
            Visit::No => Value::Null,
            Visit::Quiet => Value::Symbol("quiet".into()),
            Visit::Yes => Value::Bool(true),
            Visit::Name(n) => s(n),
        };
        let args = vec![source_value.0, source_value.1, s(&file), Value::Bool(append), visit_value, Value::Null, Value::Bool(mustbenew)];
        if let Some(r) = self.handled("write-region", &file, args) {
            return r.map(drop);
        }
        let path = PathBuf::from(&file);
        self.check_permission(&format!("write {}", crate::files::abbreviate_path(&path)))?;
        if mustbenew && fs::symlink_metadata(&path).is_ok() {
            return Err(Error::signal("file-already-exists", format!("File exists: {file}"), vec![s("File exists"), s(&file)]));
        }
        let write_coding = self.coding_for_write();
        let b = self.buffer();
        let text = match &source {
            WriteSource::Buffer => b.slice(0..b.len()),
            WriteSource::Region(a, e) => b.slice((*a).min(*e).min(b.len())..(*a).max(*e).min(b.len())),
            WriteSource::Text(t) => t.clone(),
        };
        let (bytes, coding) = write_coding.encode(&text);
        let mut options = fs::File::options();
        options.write(true).create(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let written = options.open(&path).and_then(|mut f| {
            use std::io::Write;
            f.write_all(&bytes)
        });
        written.map_err(|e| file_error("Opening output file", &e, &[&path]))?;
        let visited = match &visit {
            Visit::Yes => Some(path.clone()),
            Visit::Name(name) => Some(self.expand_file_name(name)),
            _ => None,
        };
        if let Some(visited) = &visited {
            let b = self.buffer_mut();
            b.path = Some(visited.clone());
            b.set_coding(coding);
            b.mark_saved();
            b.set_visited_file_modtime();
        }
        if visit != Visit::Quiet {
            let done = if append { "Added to" } else { "Wrote" };
            self.message(format!("{done} {}", visited.as_deref().unwrap_or(&path).display()));
        }
        Ok(())
    }
}

/// Whether a file name is absolute, as Emacs's `file-name-absolute-p`:
/// starting with `/`, or with `~` for a home directory.
pub fn file_name_absolute_p(name: &str) -> bool {
    if name.starts_with('/') {
        return true;
    }
    let Some(rest) = name.strip_prefix('~') else { return false };
    let user = rest.split('/').next().unwrap_or_default();
    user.is_empty() || fs::path_is_dir(Path::new("/Users").join(user)) || fs::path_is_dir(Path::new("/home").join(user))
}

/// Joins a directory and file names with one slash between each, as
/// Emacs's `file-name-concat`, leaving out empty ones.
pub fn file_name_concat(parts: &[&str]) -> String {
    let parts: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    let mut out = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 && !out.ends_with('/') {
            out.push('/');
        }
        // One slash between each, whichever side has it.
        out.push_str(if out.ends_with('/') { part.trim_start_matches('/') } else { part });
    }
    out
}

/// A file name with `$VAR` and `${VAR}` replaced by the environment's, `$$`
/// by `$`, and starting again after `//` or `/~`, as Emacs's
/// `substitute-in-file-name`.
pub fn substitute_in_file_name(name: &str) -> Result<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut start = 0;
    for i in 1..chars.len() {
        if chars[i - 1] == '/' && (chars[i] == '/' || chars[i] == '~') {
            start = i;
        }
    }
    let rest: String = chars[start..].iter().collect();
    let mut out = String::new();
    let mut it = rest.chars().peekable();
    while let Some(c) = it.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('$') => {
                it.next();
                out.push('$');
            }
            Some('{') => {
                it.next();
                let var: String = it.by_ref().take_while(|&c| c != '}').collect();
                out.push_str(&env_value(&var)?);
            }
            Some(c) if c.is_alphanumeric() || *c == '_' => {
                let mut var = String::new();
                while let Some(&c) = it.peek().filter(|c| c.is_alphanumeric() || **c == '_') {
                    var.push(c);
                    it.next();
                }
                out.push_str(&env_value(&var)?);
            }
            _ => out.push('$'),
        }
    }
    Ok(out)
}

fn env_value(var: &str) -> Result<String> {
    std::env::var(var).map_err(|_| Error::new(format!("Substituting nonexistent environment variable \"{var}\"")))
}
