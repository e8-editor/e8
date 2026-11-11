//! The user's configuration directory: `init.ts`, plus the `e8.d.ts` and
//! `tsconfig.json` that let editors and `tsc` check it.

use std::env;
use e8_core::vfs as fs;
use std::io;
use std::path::{Path, PathBuf};

use e8_core::Editor;
use crate::{Scripting, shipped_packages, type_definitions};

/// `$E8_CONFIG_DIR`, else `$XDG_CONFIG_HOME/e8`, else `~/.config/e8`.
pub fn config_dir() -> PathBuf {
    if let Some(dir) = env::var_os("E8_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| e8_core::vfs::home_dir().unwrap_or_default().join(".config"));
    base.join("e8")
}

/// Starts scripting, loads `init.ts` unless `load_init` is false, and writes
/// the type files. Problems are shown in the echo area; the editor starts anyway.
pub fn setup(ed: &mut Editor, load_init: bool) -> Option<Scripting> {
    setup_with(ed, load_init, |_, _| Ok(()))
}

/// Like [`setup`], installing extensions such as E8's agent once the
/// packages are loaded and before `init.ts`, so it can configure them.
pub fn setup_with(
    ed: &mut Editor,
    load_init: bool,
    extensions: impl FnOnce(&mut Editor, &Scripting) -> e8_core::Result<()>,
) -> Option<Scripting> {
    setup_in(ed, &config_dir(), load_init, extensions)
}

/// As [`setup_with`], with the configuration in `dir`.
pub fn setup_in(
    ed: &mut Editor,
    dir: &Path,
    load_init: bool,
    extensions: impl FnOnce(&mut Editor, &Scripting) -> e8_core::Result<()>,
) -> Option<Scripting> {
    let scripting = start_in(ed, dir, load_init, extensions)?;
    if let Err(e) = write_type_files(ed, dir) {
        ed.message(format!("Could not write e8.d.ts: {e}"));
    }
    Some(scripting)
}

/// Starts scripting for batch mode, as `emacs --batch` starts: the
/// configuration directory known, so packages can be installed and
/// found there, but `init.ts` not loaded and nothing written.
pub fn setup_batch(ed: &mut Editor) -> Option<Scripting> {
    start_in(ed, &config_dir(), false, |_, _| Ok(()))
}

fn start_in(
    ed: &mut Editor,
    dir: &Path,
    load_init: bool,
    extensions: impl FnOnce(&mut Editor, &Scripting) -> e8_core::Result<()>,
) -> Option<Scripting> {
    let dir = dir.to_path_buf();
    let scripting = match Scripting::start(ed) {
        Ok((scripting, failures)) => {
            for e in failures {
                ed.message(format!("Error loading a package: {e}"));
            }
            scripting
        }
        Err(e) => {
            ed.message(format!("Scripting is unavailable: {e}"));
            return None;
        }
    };
    ed.set_variable("user-emacs-directory", e8_core::Value::Str(format!("{}/", dir.display())));
    ed.set_variable("load-path", e8_core::Value::List(vec![e8_core::Value::Str(dir.join("packages").display().to_string())]));
    if let Err(e) = extensions(ed, &scripting) {
        ed.message(format!("An extension failed to load: {e}"));
    }
    // As Emacs runs it before its init file, with -q too: what the packages set up, before init.ts changes it.
    if let Err(e) = ed.run_hooks("before-init-hook") {
        ed.message(format!("Error in before-init-hook: {e}"));
    }
    if load_init {
        // The window shows the editor while init.ts runs, which can take a
        // while, as when it installs packages, and its messages as they come.
        ed.redisplay_now();
        self::load_init(ed, &scripting, &dir);
    }
    // As Emacs runs them once its init file is loaded, with -q too.
    for hook in ["after-init-hook", "emacs-startup-hook"] {
        if let Err(e) = ed.run_hooks(hook) {
            ed.message(format!("Error in {hook}: {e}"));
        }
    }
    Some(scripting)
}

/// Loads `init.ts` if there is one. Errors are shown in the echo area, as
/// Emacs reports a broken init file, and the editor starts anyway.
pub fn load_init(ed: &mut Editor, scripting: &Scripting, dir: &Path) {
    let init = dir.join("init.ts");
    if fs::path_exists(&init)
        && let Err(e) = scripting.load_file(ed, &init)
    {
        // The error already starts with the file and line.
        ed.message(e.to_string());
    }
}

const TSCONFIG: &str = r#"{
  // Written by E8. Lets `tsc -p .` and editors check init.ts against e8.d.ts.
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    // Each .ts file is its own module, as E8 runs each file in its own scope.
    "moduleDetection": "force",
    // Packages import each other by feature name, as Lisp files require each
    // other: your own in packages/, E8's in shipped/, which E8 writes.
    "module": "preserve",
    "paths": { "*": ["./packages/*", "./shipped/*"] },
    // E8 erases types rather than compiling them, so enums and the like are not allowed.
    "erasableSyntaxOnly": true
  },
  "include": ["*.ts", "packages/*.ts"]
}
"#;

/// Writes the declarations and `tsconfig.json` if there is none. Does
/// nothing if the configuration directory does not exist.
pub fn write_type_files(ed: &Editor, dir: &Path) -> io::Result<()> {
    if !fs::path_is_dir(dir) {
        return Ok(());
    }
    write_declarations(ed, dir)?;
    let tsconfig = dir.join("tsconfig.json");
    if !fs::path_exists(&tsconfig) {
        fs::write(tsconfig, TSCONFIG)?;
    }
    Ok(())
}

/// Writes, into `dir`, what a package or a configuration is checked
/// against: `e8.d.ts`, and in `shipped/` the packages that ship with
/// E8, which other packages import by name. Each file is written only
/// when it has changed, and `dir` is made if it is missing, as `e8
/// --print-types DIR` does for a package's repository.
pub fn write_declarations(ed: &Editor, dir: &Path) -> io::Result<()> {
    let shipped = dir.join("shipped");
    fs::create_dir_all(&shipped)?;
    write_if_changed(&dir.join("e8.d.ts"), &type_definitions(ed))?;
    for (file, source) in shipped_packages() {
        write_if_changed(&shipped.join(file), source)?;
    }
    Ok(())
}

fn write_if_changed(path: &Path, text: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() != Some(text) {
        fs::write(path, text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_requires_packages_from_the_config_directory() {
        // As a user's own package, outside E8: found in packages/, along load-path.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("packages")).unwrap();
        fs::write(dir.path().join("packages/my-own.ts"), "import { truthy } from \"subr\";\ne8.setVariable(\"my-own-loaded\", truthy(1));\n").unwrap();
        fs::write(dir.path().join("init.ts"), "e8.require(\"my-own\");\n").unwrap();
        let mut ed = Editor::new();
        let _scripting = setup_in(&mut ed, dir.path(), true, |_, _| Ok(())).unwrap();
        assert_eq!(ed.variable("my-own-loaded"), Some(e8_core::Value::Bool(true)));
    }

    #[test]
    fn loads_init_and_writes_type_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("init.ts"),
            "e8.defineCommand({ name: \"from-init\", run: () => {} });",
        )
        .unwrap();
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        load_init(&mut ed, &scripting, dir.path());
        assert!(ed.command("from-init").is_some());
        write_type_files(&ed, dir.path()).unwrap();
        let dts = fs::read_to_string(dir.path().join("e8.d.ts")).unwrap();
        assert!(dts.contains("\"from-init\": [];"));
        assert!(dir.path().join("tsconfig.json").exists());
    }

    #[test]
    fn a_broken_init_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("init.ts"), "let x: = 1;").unwrap();
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        load_init(&mut ed, &scripting, dir.path());
        let echo = ed.echo().unwrap();
        assert!(echo.contains("init.ts:1:"), "{echo}");
    }

    #[test]
    fn missing_config_dir_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        write_type_files(&Editor::new(), &missing).unwrap();
        assert!(!missing.exists());
    }
}
