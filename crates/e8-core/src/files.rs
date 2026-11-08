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
    fn abbreviates_home() {
        let home = home_dir().unwrap();
        assert_eq!(abbreviate_dir(&home.join("proj")), "~/proj/");
        assert_eq!(abbreviate_dir(&home), "~/");
        assert_eq!(abbreviate_dir(Path::new("/tmp")), "/tmp/");
    }
}
