use std::path::{Path, PathBuf};

fn home_dir() -> Option<PathBuf> {
    crate::vfs::home_dir()
}

/// Turns minibuffer input into an absolute path the Emacs way: `~` means the
/// home directory, and typing `//` or `/~/` after the default directory starts
/// over from the root or from home.
pub fn expand_file_name(input: &str) -> PathBuf {
    expand_file_name_in(input, &crate::vfs::current_dir().unwrap_or_default())
}

/// As [`expand_file_name`], with relative names in `dir`, as Emacs's
/// `expand-file-name` takes them in `default-directory`. `.` and `..` are
/// worked out as Emacs does, without looking at the disk.
pub fn expand_file_name_in(input: &str, dir: &Path) -> PathBuf {
    let mut s = input;
    if let Some(i) = s.rfind("//") {
        s = &s[i + 1..];
    }
    if let Some(i) = s.rfind("/~/") {
        s = &s[i + 1..];
    }
    let home = home_dir().unwrap_or_default();
    let path = if s == "~" {
        home
    } else if let Some(rest) = s.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(s)
    };
    let path = if crate::vfs::is_absolute(&path) { path } else { dir.join(path) };
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// A file name made absolute as Lisp's `expand-file-name` gives it: as
/// [`expand_file_name_in`], keeping a trailing slash when the name ends in
/// one, as a directory name does, `"foo/"` giving `"/tmp/foo/"`.
pub fn expand_file_name_string(input: &str, dir: &Path) -> String {
    let out = expand_file_name_in(input, dir).display().to_string();
    if input.ends_with('/') && !out.ends_with('/') { out + "/" } else { out }
}

/// Writes a path with the home directory as `~`.
pub fn abbreviate_path(path: &Path) -> String {
    match home_dir() {
        Some(home) if path.starts_with(&home) => {
            let rest = path.strip_prefix(&home).unwrap_or(path);
            if rest.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rest.display())
            }
        }
        _ => path.display().to_string(),
    }
}

/// Gives a buffer visiting PATH the file's directory as its own
/// `default-directory`, as Emacs's find-file and set-visited-file-name do.
pub(crate) fn set_file_default_directory(buffer: &mut crate::buffer::Buffer, path: &Path) {
    if let Some(dir) = path.parent() {
        buffer.locals.insert("default-directory".to_string(), crate::variables::Value::Str(abbreviate_dir(dir)));
    }
}

/// Writes a directory the way the minibuffer shows it: home as `~`, with a trailing slash.
pub fn abbreviate_dir(dir: &Path) -> String {
    let s = abbreviate_path(dir);
    if s.ends_with('/') { s } else { s + "/" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_slash_and_tilde_start_over() {
        assert_eq!(expand_file_name("~/proj//tmp/x"), PathBuf::from("/tmp/x"));
        let home = home_dir().unwrap();
        assert_eq!(expand_file_name("/a/b/~/notes.org"), home.join("notes.org"));
        assert_eq!(expand_file_name("~"), home);
    }

    #[test]
    fn a_directory_name_keeps_its_slash_as_in_emacs() {
        // What Emacs 30's expand-file-name gives for each.
        let tmp = Path::new("/tmp/");
        let home = home_dir().unwrap().display().to_string();
        for (name, dir, expanded) in [
            ("/tmp/", tmp, "/tmp/".to_string()),
            ("foo/", tmp, "/tmp/foo/".to_string()),
            ("foo/", Path::new("/tmp"), "/tmp/foo/".to_string()),
            ("foo", Path::new("/tmp"), "/tmp/foo".to_string()),
            ("~/", tmp, format!("{home}/")),
            ("~", tmp, home.clone()),
            ("~/a/", Path::new("/x/"), format!("{home}/a/")),
            ("", tmp, "/tmp".to_string()),
            (".", tmp, "/tmp".to_string()),
            ("./", tmp, "/tmp/".to_string()),
            ("foo/.", tmp, "/tmp/foo".to_string()),
            ("foo/./", tmp, "/tmp/foo/".to_string()),
            ("foo/..", tmp, "/tmp".to_string()),
            ("foo/../", tmp, "/tmp/".to_string()),
            ("..", Path::new("/tmp/a/"), "/tmp".to_string()),
            ("../", Path::new("/tmp/a/"), "/tmp/".to_string()),
            ("/", tmp, "/".to_string()),
        ] {
            assert_eq!(expand_file_name_string(name, dir), expanded, "{name:?} in {dir:?}");
        }
    }

    #[test]
    fn abbreviates_home() {
        let home = home_dir().unwrap();
        assert_eq!(abbreviate_dir(&home.join("proj")), "~/proj/");
        assert_eq!(abbreviate_dir(&home), "~/");
        assert_eq!(abbreviate_dir(Path::new("/tmp")), "/tmp/");
    }
}
