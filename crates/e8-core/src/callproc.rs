//! The environment programs run in and where they are found, as Emacs's
//! callproc.c keeps them: `process-environment`, `initial-environment`,
//! `exec-path` and `exec-suffixes`, `getenv-internal`, the environment
//! block a program is given, and finding a program along `exec-path`.
//!
//! As in Emacs, `process-environment` starts as a copy of the environment
//! E8 was started with, newest-first as callproc.c conses it, and is what
//! every program gets: an entry earlier in the list wins over a later one
//! for the same name, and a name alone, without "=", leaves the variable
//! out. `exec-path` starts as PATH's directories, and a program named
//! without a directory is looked for along it, not along the PATH the
//! program would be given.

use std::path::{Path, PathBuf};

use crate::editor::Editor;
use crate::variables::{Value, Variable};

pub(crate) fn install(ed: &mut Editor) {
    let initial = initial_environment();
    ed.define_variable(Variable::new(
        "initial-environment",
        "The environment variables E8 was started with, each a string \"NAME=VALUE\".",
        Value::List(initial.clone()),
    ));
    ed.define_variable(Variable::new(
        "process-environment",
        "The environment variables programs E8 starts are given, each a string \"NAME=VALUE\": an entry earlier in the list wins over a later one for the same name, and a name alone, without \"=VALUE\", leaves that variable out. Binding it around a call is how code changes one program's environment; setenv changes it for every program after.",
        Value::List(initial),
    ));
    ed.define_variable(Variable::new(
        "exec-path",
        "The directories a program named without one is looked for in, in order; nil for default-directory. It starts as PATH's directories.",
        Value::List(path_directories(std::env::var("PATH").ok().as_deref())),
    ));
    ed.define_variable(Variable::new("exec-suffixes", "Suffixes to try after a program's name when looking for it along exec-path; none on these systems.", Value::List(Vec::new())));
}

/// The environment E8 was started with, as `NAME=VALUE` strings, the last
/// first, as callproc.c conses each onto the list in turn.
fn initial_environment() -> Vec<Value> {
    let mut list: Vec<Value> = std::env::vars_os().map(|(k, v)| Value::Str(format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))).collect();
    list.reverse();
    list
}

/// PATH's directories, as decode_env_path splits it: an empty one is ".".
fn path_directories(path: Option<&str>) -> Vec<Value> {
    match path {
        Some(path) if !path.is_empty() => path.split(':').map(|d| Value::Str(if d.is_empty() { ".".into() } else { d.to_string() })).collect(),
        _ => Vec::new(),
    }
}

/// What an environment list says of a variable, as callproc.c's
/// getenv_internal_1: `Some(Some(value))` for "NAME=VALUE", `Some(None)`
/// for "NAME" alone, `None` if it is not there. Elements that are not
/// strings are passed over.
fn lookup(list: &[Value], var: &str) -> Option<Option<String>> {
    for entry in list {
        let Some(entry) = entry.as_str() else { continue };
        if let Some(rest) = entry.strip_prefix(var) {
            if rest.is_empty() {
                return Some(None);
            }
            if let Some(value) = rest.strip_prefix('=') {
                return Some(Some(value.to_string()));
            }
        }
    }
    None
}

impl Editor {
    fn environment_list(&self, name: &str) -> Vec<Value> {
        match self.variable(name) {
            Some(Value::List(list)) => list,
            _ => Vec::new(),
        }
    }

    /// A variable's value, as `getenv-internal`: with `env`, a list of
    /// "NAME=VALUE" strings, looked up in it, a name alone there giving
    /// `t`; without, looked up in `process-environment`, where a name alone
    /// unsets it, and DISPLAY, not there, in `initial-environment`.
    pub fn getenv_internal(&self, var: &str, env: Option<&[Value]>) -> Option<Value> {
        // An empty list is nil, which means process-environment.
        if let Some(env) = env.filter(|e| !e.is_empty()) {
            return lookup(env, var).map(|v| v.map_or(Value::Bool(true), Value::Str));
        }
        self.getenv(var).map(Value::Str)
    }

    /// An environment variable's value as programs E8 starts get it, from
    /// `process-environment`, as Emacs's `getenv` without a frame.
    pub fn getenv(&self, var: &str) -> Option<String> {
        match lookup(&self.environment_list("process-environment"), var) {
            Some(value) => value,
            None if var == "DISPLAY" => lookup(&self.environment_list("initial-environment"), var).flatten(),
            None => None,
        }
    }

    /// The environment a program running in `dir` is given, as callproc.c's
    /// make_environment_block: PWD set to `dir` if PWD is set at all, then
    /// DISPLAY from `initial-environment` if `process-environment` does not
    /// name it, then `process-environment`'s entries, the first for each
    /// name winning, those that are a name alone left out.
    pub fn environment_block(&self, dir: &Path) -> Vec<(String, String)> {
        let env = self.environment_list("process-environment");
        // (name, value), a name alone keeping its place so a later entry
        // for it is not taken, as add_env does.
        let mut block: Vec<(String, Option<String>)> = Vec::new();
        let add = |block: &mut Vec<(String, Option<String>)>, entry: &str| {
            let (name, value) = match entry.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (entry, None),
            };
            if !block.iter().any(|(n, _)| n == name) {
                block.push((name.to_string(), value));
            }
        };
        if self.getenv("PWD").is_some() {
            let mut pwd = dir.to_string_lossy().into_owned();
            // Trailing slashes off, leaving "/" and "//" alone.
            while pwd.len() > 2 && pwd.ends_with('/') {
                pwd.pop();
            }
            add(&mut block, &format!("PWD={pwd}"));
        }
        if lookup(&env, "DISPLAY").is_none()
            && let Some(Some(display)) = lookup(&self.environment_list("initial-environment"), "DISPLAY")
        {
            add(&mut block, &format!("DISPLAY={display}"));
        }
        for entry in &env {
            let Some(entry) = entry.as_str() else { break };
            add(&mut block, entry);
        }
        block.into_iter().filter_map(|(name, value)| Some((name, value?))).collect()
    }

    /// Gives a command the environment `environment_block` makes for it,
    /// and E8's own defaults where the user has not chosen otherwise: TERM
    /// "dumb" unless `process-environment` sets a TERM other than the one
    /// E8 was started with, and INSIDE_EMACS if it is not set.
    pub(crate) fn set_command_environment(&self, command: &mut std::process::Command, dir: &Path, inside_emacs: bool) {
        let block = self.environment_block(dir);
        command.env_clear();
        let chosen_term = {
            let term = block.iter().find(|(n, _)| n == "TERM").map(|(_, v)| v.clone());
            let initial = lookup(&self.environment_list("initial-environment"), "TERM").flatten();
            term.filter(|t| Some(t) != initial.as_ref())
        };
        let has_inside = block.iter().any(|(n, _)| n == "INSIDE_EMACS");
        for (name, value) in block {
            command.env(name, value);
        }
        command.env("TERM", chosen_term.as_deref().unwrap_or("dumb"));
        if inside_emacs && !has_inside {
            command.env("INSIDE_EMACS", "e8");
        }
    }

    /// Where a program is, as Emacs finds one with openp along `exec-path`
    /// with `exec-suffixes`: a name with a directory, or starting with "~",
    /// as itself; else in each directory in turn, nil meaning
    /// `default-directory`, the first file that can be run and is not a
    /// directory.
    pub fn locate_program(&self, program: &str) -> Option<PathBuf> {
        let suffixes: Vec<String> = match self.variable("exec-suffixes") {
            Some(Value::List(list)) => list.iter().filter_map(|s| s.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let suffixes = if suffixes.is_empty() { vec![String::new()] } else { suffixes };
        let runnable = |path: &Path| {
            if crate::vfs::path_is_dir(path) {
                return false;
            }
            #[cfg(unix)]
            return crate::filefns::access(path, libc::X_OK);
            #[cfg(not(unix))]
            return crate::vfs::path_exists(path);
        };
        let absolute = program.starts_with('/') || program.starts_with('~');
        let dirs: Vec<Option<String>> = if absolute {
            vec![None]
        } else {
            match self.variable("exec-path") {
                Some(Value::List(list)) => list.iter().map(|d| d.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            }
        };
        for dir in dirs {
            let base = match &dir {
                Some(dir) => crate::files::expand_file_name_in(program, &self.expand_file_name(dir)),
                None => self.expand_file_name(program),
            };
            for suffix in &suffixes {
                let mut candidate = base.clone().into_os_string();
                candidate.push(suffix);
                let candidate = PathBuf::from(candidate);
                if runnable(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// Finds a program as [`locate_program`](Self::locate_program) does, or
    /// Emacs's error, "Searching for program", if it is not there.
    pub(crate) fn find_program(&self, program: &str) -> crate::error::Result<PathBuf> {
        if (program.starts_with('/') || program.starts_with('~')) && crate::vfs::path_is_dir(self.expand_file_name(program)) {
            return Err(crate::error::Error::new("Specified program for new process is a directory"));
        }
        self.locate_program(program).ok_or_else(|| {
            let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
            crate::fileops::file_error("Searching for program", &missing, &[Path::new(program)])
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_path_element_is_the_current_directory() {
        let dirs = path_directories(Some("/bin::/usr/bin"));
        assert_eq!(dirs, vec![Value::Str("/bin".into()), Value::Str(".".into()), Value::Str("/usr/bin".into())]);
        assert!(path_directories(Some("")).is_empty());
    }

    #[test]
    fn a_name_alone_is_found_as_unset() {
        let env = vec![Value::Str("A".into()), Value::Str("A=1".into()), Value::Str("AB=2".into())];
        assert_eq!(lookup(&env, "A"), Some(None));
        assert_eq!(lookup(&env, "AB"), Some(Some("2".into())));
        assert_eq!(lookup(&env, "B"), None);
    }
}
