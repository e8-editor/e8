//! Errors, as Emacs signals them: an error symbol, which conditions it
//! belongs to, and its data, as well as the message shown for it. Code
//! catches errors by condition, as `condition-case` does: a `file-missing`
//! error is a `file-error` too, and nearly every error is an `error`.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::{Mutex, OnceLock};

use crate::variables::Value;

/// An error, as Emacs's signal makes one, shown to the user in the echo area.
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    symbol: String,
    data: Vec<Value>,
    message: String,
}

/// The error symbols Emacs defines that E8 signals, each with its
/// parent condition, as `define-error` makes them.
const ERRORS: &[(&str, &str)] = &[
    ("user-error", "error"),
    // treesit.c's, each a `treesit-error`; Emacs 30 leaves
    // `treesit-predicate-not-found` undefined, which E8 makes one too.
    ("treesit-error", "error"),
    ("treesit-query-error", "treesit-error"),
    ("treesit-parse-error", "treesit-error"),
    ("treesit-range-invalid", "treesit-error"),
    ("treesit-load-language-error", "treesit-error"),
    ("treesit-node-outdated", "treesit-error"),
    ("treesit-node-buffer-killed", "treesit-error"),
    ("treesit-parser-deleted", "treesit-error"),
    ("treesit-invalid-predicate", "treesit-error"),
    ("treesit-predicate-not-found", "treesit-error"),
    ("scan-error", "error"),
    ("search-failed", "error"),
    ("invalid-regexp", "error"),
    ("buffer-read-only", "error"),
    ("text-read-only", "buffer-read-only"),
    ("beginning-of-buffer", "error"),
    ("end-of-buffer", "error"),
    ("args-out-of-range", "error"),
    ("wrong-type-argument", "error"),
    ("void-function", "error"),
    ("invalid-function", "error"),
    ("void-variable", "error"),
    ("end-of-file", "error"),
    ("invalid-read-syntax", "error"),
    ("file-error", "error"),
    ("file-missing", "file-error"),
    ("file-already-exists", "file-error"),
    ("file-date-error", "file-error"),
    ("permission-denied", "file-error"),
    ("minibuffer-quit", "quit"),
];

/// Error symbols code has defined, with their parents, as define-error adds them.
fn defined() -> &'static Mutex<HashMap<String, String>> {
    static DEFINED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    DEFINED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Defines an error symbol under a parent condition, as Emacs's define-error.
pub fn define_error(symbol: &str, parent: &str) {
    defined().lock().expect("not poisoned").insert(symbol.to_string(), parent.to_string());
}

/// The conditions an error symbol belongs to, itself first, as its
/// `error-conditions` property lists them. `quit` is not an `error`.
pub fn error_conditions(symbol: &str) -> Vec<String> {
    let mut out = vec![symbol.to_string()];
    let mut current = symbol.to_string();
    for _ in 0..16 {
        let parent = ERRORS
            .iter()
            .find(|(s, _)| *s == current)
            .map(|(_, p)| p.to_string())
            .or_else(|| defined().lock().expect("not poisoned").get(&current).cloned());
        match parent {
            Some(p) if !out.contains(&p) => {
                out.push(p.clone());
                current = p;
            }
            _ => break,
        }
    }
    if symbol != "quit" && !out.iter().any(|c| c == "quit" || c == "error") {
        out.push("error".to_string());
    }
    out
}

impl Error {
    /// A plain error, as Emacs's `error` signals.
    pub fn new(message: impl Into<String>) -> Error {
        Error { symbol: "error".to_string(), data: Vec::new(), message: message.into() }
    }

    /// An error of a given condition, as `signal` raises it, with its data
    /// and the message shown for it.
    pub fn signal(symbol: &str, message: impl Into<String>, data: Vec<Value>) -> Error {
        Error { symbol: symbol.to_string(), data, message: message.into() }
    }

    /// An error in what the user did rather than in the code, as user-error.
    pub fn user(message: impl Into<String>) -> Error {
        Error::signal("user-error", message, Vec::new())
    }

    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    pub fn data(&self) -> &[Value] {
        &self.data
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// Whether the error belongs to a condition, as condition-case matches it.
    pub fn is(&self, condition: &str) -> bool {
        error_conditions(&self.symbol).iter().any(|c| c == condition)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        let symbol = match e.kind() {
            io::ErrorKind::NotFound => "file-missing",
            io::ErrorKind::AlreadyExists => "file-already-exists",
            io::ErrorKind::PermissionDenied => "permission-denied",
            _ => "file-error",
        };
        Error::signal(symbol, e.to_string(), Vec::new())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditions_follow_the_hierarchy() {
        assert_eq!(error_conditions("file-missing"), ["file-missing", "file-error", "error"]);
        assert_eq!(error_conditions("quit"), ["quit"]);
        assert_eq!(error_conditions("minibuffer-quit"), ["minibuffer-quit", "quit"]);
        define_error("my-error", "file-error");
        assert!(Error::signal("my-error", "x", Vec::new()).is("file-error"));
        assert!(Error::new("x").is("error"));
    }
}
