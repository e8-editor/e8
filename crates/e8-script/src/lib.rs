//! TypeScript extensions for E8, run on QuickJS or V8.
//!
//! [`Scripting`] owns the JavaScript engine, `quickjs` or `v8` as the
//! crate's features choose: the engine-specific code is in that module, and
//! everything else, the natives' bodies included, is the same for both. Scripts reach the editor through
//! the `e8` global; [`type_definitions`] generates its TypeScript
//! declarations from the command registry.

pub mod batch;
pub mod config;
mod natives;
#[cfg(feature = "quickjs")]
mod quickjs;
#[cfg(feature = "quickjs")]
use quickjs as engine;
#[cfg(feature = "v8")]
mod v8engine;
#[cfg(feature = "v8")]
use v8engine as engine;

#[cfg(all(feature = "quickjs", feature = "v8"))]
compile_error!("e8-script runs one engine: with the feature \"quickjs\", turn off the default features, which choose \"v8\"");
#[cfg(not(any(feature = "quickjs", feature = "v8")))]
compile_error!("e8-script needs an engine: the feature \"quickjs\" or \"v8\"");
mod strip;
mod strip_js;
mod types;
mod values;

pub use strip::{strip_module_types, strip_types};
pub use types::type_definitions;

use std::cell::{Cell, RefCell};
use e8_core::vfs as fs;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::thread::LocalKey;
use std::time::Duration;

use e8_core::clock::Instant;

use std::rc::Rc;

use e8_core::{
    Arg, Background, Command, Editor, Error, Face, FaceAttrs, HookFn, Key, MinorMode, ParamKind, Reading,
    Result, Value as EditorValue, Variable, abbreviate_path, expand_file_name,
};

const PRELUDE: &str = include_str!("prelude.js");

/// The file and source of the package a module name names: "subr", or as
/// the loader names it, "packages/subr.ts"; else NAME.ts in a directory of
/// `load-path`, a package of the user's, named by its path.
fn package_source(name: &str) -> Option<(String, Cow<'static, str>)> {
    // A package loaded again, as Emacs's load runs a file again, is a
    // module of its own, NAME#N, so each engine compiles and runs it anew.
    if let Some((base, again)) = name.rsplit_once('#')
        && !again.is_empty()
        && again.bytes().all(|b| b.is_ascii_digit())
    {
        return package_source(base).map(|(file, source)| (format!("{file}#{again}"), source));
    }
    let feature = name.trim_start_matches("packages/").trim_end_matches(".ts");
    if let Some((file, source)) =
        PACKAGES.iter().chain(LIBRARY).find(|(file, _)| file.trim_start_matches("packages/").trim_end_matches(".ts") == feature)
    {
        return Some((file.to_string(), Cow::Borrowed(source)));
    }
    let path = if fs::is_absolute(name) {
        Some(PathBuf::from(name))
    } else {
        LOAD_PATH.with_borrow(|dirs| dirs.iter().map(|d| d.join(format!("{feature}.ts"))).find(|p| fs::path_is_file(p)))
    }?;
    let source = fs::read_to_string(&path).ok()?;
    Some((path.display().to_string(), Cow::Owned(source)))
}

thread_local! {
    /// The directories of `load-path` as `require` last read them, for the
    /// loaders to find a package of the user's in.
    static LOAD_PATH: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

/// Reads `load-path` before `require` imports a feature, and whether there
/// is a package by that name, shipped or the user's.
fn prepare_require(ed: &Editor, feature: &str) -> bool {
    let dirs = match ed.variable("load-path") {
        Some(EditorValue::List(dirs)) => {
            dirs.iter().filter_map(|d| d.as_str().map(expand_file_name)).collect()
        }
        _ => Vec::new(),
    };
    LOAD_PATH.set(dirs);
    package_source(feature).is_some()
}

include!(concat!(env!("OUT_DIR"), "/stripped.rs"));

/// The packages that ship with E8, in the order they load. Like the Lisp
/// that Emacs preloads, they are part of the editor: `-q` skips init.ts but
/// not these. Named by their path in the repository.
const PACKAGES: &[(&str, &str)] = &[
    ("packages/subr.ts", include_str!("../../../packages/subr.ts")),
    ("packages/simple.ts", include_str!("../../../packages/simple.ts")),
    ("packages/bindings.ts", include_str!("../../../packages/bindings.ts")),
    ("packages/iso-transl.ts", include_str!("../../../packages/iso-transl.ts")),
    ("packages/paragraphs.ts", include_str!("../../../packages/paragraphs.ts")),
    ("packages/page.ts", include_str!("../../../packages/page.ts")),
    ("packages/indent.ts", include_str!("../../../packages/indent.ts")),
    ("packages/fill.ts", include_str!("../../../packages/fill.ts")),
    ("packages/newcomment.ts", include_str!("../../../packages/newcomment.ts")),
    ("packages/lisp.ts", include_str!("../../../packages/lisp.ts")),
    ("packages/paren.ts", include_str!("../../../packages/paren.ts")),
    ("packages/display-line-numbers.ts", include_str!("../../../packages/display-line-numbers.ts")),
    ("packages/mule.ts", include_str!("../../../packages/mule.ts")),
    ("packages/mule-diag.ts", include_str!("../../../packages/mule-diag.ts")),
    ("packages/files.ts", include_str!("../../../packages/files.ts")),
    ("packages/easymenu.ts", include_str!("../../../packages/easymenu.ts")),
    ("packages/menu-bar.ts", include_str!("../../../packages/menu-bar.ts")),
    ("packages/text-mode.ts", include_str!("../../../packages/text-mode.ts")),
    ("packages/face-remap.ts", include_str!("../../../packages/face-remap.ts")),
    ("packages/case-table.ts", include_str!("../../../packages/case-table.ts")),
    ("packages/outline.ts", include_str!("../../../packages/outline.ts")),
    // Before the modes that give help-guide their guides, which import it.
    ("packages/help.ts", include_str!("../../../packages/help.ts")),
    ("packages/help-guide.ts", include_str!("../../../packages/help-guide.ts")),
    ("packages/prog-mode.ts", include_str!("../../../packages/prog-mode.ts")),
    ("packages/lisp-mode.ts", include_str!("../../../packages/lisp-mode.ts")),
    ("packages/elisp-mode.ts", include_str!("../../../packages/elisp-mode.ts")),
    ("packages/subword.ts", include_str!("../../../packages/subword.ts")),
    ("packages/imenu.ts", include_str!("../../../packages/imenu.ts")),
    ("packages/treesit.ts", include_str!("../../../packages/treesit.ts")),
    ("packages/hideshow.ts", include_str!("../../../packages/hideshow.ts")),
    ("packages/treesit-modes.ts", include_str!("../../../packages/treesit-modes.ts")),
    ("packages/delsel.ts", include_str!("../../../packages/delsel.ts")),
    ("packages/elec-pair.ts", include_str!("../../../packages/elec-pair.ts")),
    ("packages/faces.ts", include_str!("../../../packages/faces.ts")),
    ("packages/custom.ts", include_str!("../../../packages/custom.ts")),
    ("packages/image.ts", include_str!("../../../packages/image.ts")),
    ("packages/repeat.ts", include_str!("../../../packages/repeat.ts")),
    ("packages/kmacro.ts", include_str!("../../../packages/kmacro.ts")),
    ("packages/window.ts", include_str!("../../../packages/window.ts")),
    ("packages/tab-bar.ts", include_str!("../../../packages/tab-bar.ts")),
    // Preloaded for their commands and winner-mode, which Emacs autoloads.
    ("packages/windmove.ts", include_str!("../../../packages/windmove.ts")),
    ("packages/winner.ts", include_str!("../../../packages/winner.ts")),
    ("packages/which-key.ts", include_str!("../../../packages/which-key.ts")),
    ("packages/mouse.ts", include_str!("../../../packages/mouse.ts")),
    ("packages/isearch.ts", include_str!("../../../packages/isearch.ts")),
    ("packages/minibuffer.ts", include_str!("../../../packages/minibuffer.ts")),
    ("packages/icomplete.ts", include_str!("../../../packages/icomplete.ts")),
    ("packages/recentf.ts", include_str!("../../../packages/recentf.ts")),
    ("packages/savehist.ts", include_str!("../../../packages/savehist.ts")),
    ("packages/saveplace.ts", include_str!("../../../packages/saveplace.ts")),
    ("packages/desktop.ts", include_str!("../../../packages/desktop.ts")),
    ("packages/editorconfig.ts", include_str!("../../../packages/editorconfig.ts")),
    ("packages/ffap.ts", include_str!("../../../packages/ffap.ts")),
    ("packages/dired.ts", include_str!("../../../packages/dired.ts")),
    ("packages/nsm.ts", include_str!("../../../packages/nsm.ts")),
    ("packages/gnutls.ts", include_str!("../../../packages/gnutls.ts")),
    ("packages/network-stream.ts", include_str!("../../../packages/network-stream.ts")),
    ("packages/compile.ts", include_str!("../../../packages/compile.ts")),
    ("packages/ansi-color.ts", include_str!("../../../packages/ansi-color.ts")),
    ("packages/comint.ts", include_str!("../../../packages/comint.ts")),
    ("packages/shell.ts", include_str!("../../../packages/shell.ts")),
    ("packages/xref.ts", include_str!("../../../packages/xref.ts")),
    ("packages/project.ts", include_str!("../../../packages/project.ts")),
    ("packages/eglot.ts", include_str!("../../../packages/eglot.ts")),
    ("packages/acp.ts", include_str!("../../../packages/acp.ts")),
    ("packages/replace.ts", include_str!("../../../packages/replace.ts")),
    ("packages/dired-aux.ts", include_str!("../../../packages/dired-aux.ts")),
    ("packages/dired-x.ts", include_str!("../../../packages/dired-x.ts")),
    ("packages/wdired.ts", include_str!("../../../packages/wdired.ts")),
    ("packages/sort.ts", include_str!("../../../packages/sort.ts")),
    ("packages/rect.ts", include_str!("../../../packages/rect.ts")),
    ("packages/register.ts", include_str!("../../../packages/register.ts")),
    ("packages/dabbrev.ts", include_str!("../../../packages/dabbrev.ts")),
    ("packages/tabulated-list.ts", include_str!("../../../packages/tabulated-list.ts")),
    ("packages/buff-menu.ts", include_str!("../../../packages/buff-menu.ts")),
    ("packages/hi-lock.ts", include_str!("../../../packages/hi-lock.ts")),
    ("packages/bookmark.ts", include_str!("../../../packages/bookmark.ts")),
    ("packages/misc.ts", include_str!("../../../packages/misc.ts")),
    ("packages/whitespace.ts", include_str!("../../../packages/whitespace.ts")),
    ("packages/files-x.ts", include_str!("../../../packages/files-x.ts")),
    ("packages/ispell.ts", include_str!("../../../packages/ispell.ts")),
    ("packages/flyspell.ts", include_str!("../../../packages/flyspell.ts")),
    ("packages/view.ts", include_str!("../../../packages/view.ts")),
    ("packages/diff.ts", include_str!("../../../packages/diff.ts")),
    // Ediff's entry commands, which load ediff.ts, as Emacs autoloads it.
    ("packages/ediff-hook.ts", include_str!("../../../packages/ediff-hook.ts")),
    ("packages/abbrev.ts", include_str!("../../../packages/abbrev.ts")),
    ("packages/org-macs.ts", include_str!("../../../packages/org-macs.ts")),
    ("packages/org-table.ts", include_str!("../../../packages/org-table.ts")),
    ("packages/org.ts", include_str!("../../../packages/org.ts")),
    ("packages/org-element.ts", include_str!("../../../packages/org-element.ts")),
    ("packages/org-fold.ts", include_str!("../../../packages/org-fold.ts")),
    ("packages/org-list.ts", include_str!("../../../packages/org-list.ts")),
    ("packages/org-indent.ts", include_str!("../../../packages/org-indent.ts")),
    ("packages/org-refile.ts", include_str!("../../../packages/org-refile.ts")),
    ("packages/ol.ts", include_str!("../../../packages/ol.ts")),
    ("packages/org-id.ts", include_str!("../../../packages/org-id.ts")),
    ("packages/org-habit.ts", include_str!("../../../packages/org-habit.ts")),
    ("packages/org-datetree.ts", include_str!("../../../packages/org-datetree.ts")),
    ("packages/org-agenda.ts", include_str!("../../../packages/org-agenda.ts")),
    ("packages/org-clock.ts", include_str!("../../../packages/org-clock.ts")),
    ("packages/org-capture.ts", include_str!("../../../packages/org-capture.ts")),
    ("packages/org-src.ts", include_str!("../../../packages/org-src.ts")),
    ("packages/ob-tangle.ts", include_str!("../../../packages/ob-tangle.ts")),
    // Preloaded for its commands, which Emacs autoloads.
    ("packages/package-vc.ts", include_str!("../../../packages/package-vc.ts")),
    ("packages/agent-shell.ts", include_str!("../../../packages/agent-shell.ts")),
];

/// The packages that ship with E8 but load only when a configuration
/// requires them (`e8.require("org-tempo")`), as Emacs's Lisp that is
/// not preloaded and that loading turns on.
const LIBRARY: &[(&str, &str)] = &[
    ("packages/ediff.ts", include_str!("../../../packages/ediff.ts")),
    ("packages/ert.ts", include_str!("../../../packages/ert.ts")),
    ("packages/org-tempo.ts", include_str!("../../../packages/org-tempo.ts")),
    ("packages/transient.ts", include_str!("../../../packages/transient.ts")),
    ("packages/use-package.ts", include_str!("../../../packages/use-package.ts")),
];

/// The packages that ship with E8, preloaded or not, as each one's file
/// name (`subr.ts`) and TypeScript: what a package outside the tree imports
/// by name, written beside `e8.d.ts` for `tsc` to check it against.
pub fn shipped_packages() -> impl Iterator<Item = (&'static str, &'static str)> {
    PACKAGES.iter().chain(LIBRARY).map(|(file, source)| (file.trim_start_matches("packages/"), *source))
}

/// How long a script may run before it is stopped, unless changed with
/// [`Scripting::set_time_limit`]: a backstop for a script that ignores
/// `C-g`, which quits it at its next call into the editor or loop check.
pub const DEFAULT_TIME_LIMIT: Duration = Duration::from_secs(60);

/// How many times `C-g` stops a script that has not answered it: the
/// emergency exit, which runs none of its `finally` blocks.
const QUITS_TO_STOP: u32 = 3;

thread_local! {
    /// The editor that host functions act on, set while a script runs.
    static EDITOR: Cell<Option<NonNull<Editor>>> = const { Cell::new(None) };
    /// When the outermost running script must stop.
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
    static TIME_LIMIT: Cell<Duration> = const { Cell::new(DEFAULT_TIME_LIMIT) };
    /// The running editor's quit flag, which the engine's stopper reads.
    static QUITTING: RefCell<Option<std::sync::Arc<e8_core::QuitState>>> = const { RefCell::new(None) };
    /// Whether the outermost script was stopped by `C-g` rather than the time limit.
    static STOPPED_BY_QUIT: Cell<bool> = const { Cell::new(false) };
    /// Whether the outermost script was stopped without unwinding, so what
    /// it bound is restored from the binding stack.
    static STOPPED: Cell<bool> = const { Cell::new(false) };
    /// Files being loaded, innermost last, so commands know where they were defined.
    static LOADING: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// A module's JavaScript, its body credited to its file: what it defines
/// records that file, as each Lisp file's own `load-history` entry does,
/// whether it is imported by a package, required, or loaded itself. A
/// module's body runs whole before the next one's, so marking where it
/// starts and ends is enough. On the first line, so lines keep their numbers.
pub(crate) fn module_js(file: &str, js: String) -> String {
    let mut name = String::from("\"");
    for c in file.chars() {
        match c {
            '"' | '\\' => {
                name.push('\\');
                name.push(c);
            }
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => name += &format!("\\u{:04x}", c as u32),
            c => name.push(c),
        }
    }
    name.push('"');
    format!("__e8Loading({name}, true);{js}\n;__e8Loading({name}, false);\n")
}

/// Notes that a file starts or stops being loaded. Stopping takes it, and
/// anything a failure left after it, off the stack.
pub(crate) fn note_loading(file: &str, entering: bool) {
    LOADING.with_borrow_mut(|files| {
        if entering {
            files.push(file.to_string());
        } else if let Some(at) = files.iter().rposition(|f| f == file) {
            files.truncate(at);
        }
    });
}

/// Runs `f` with `file` being loaded, the stack as it was afterwards
/// whatever `f` left on it.
fn loading<T>(file: String, f: impl FnOnce() -> T) -> T {
    let depth = LOADING.with_borrow_mut(|files| {
        files.push(file);
        files.len() - 1
    });
    let result = f();
    LOADING.with_borrow_mut(|files| files.truncate(depth));
    result
}

/// The JavaScript engine and the `e8` API. Clones share one engine.
#[derive(Clone)]
pub struct Scripting {
    engine: engine::Engine,
}

impl Scripting {
    /// Starts an engine, installs the `e8` global, adds the script commands
    /// `load-file` and `eval-expression` (M-:) to the editor, and loads the
    /// packages that ship with E8.
    pub fn new(ed: &mut Editor) -> Result<Scripting> {
        let (scripting, failures) = Scripting::start(ed)?;
        match failures.into_iter().next() {
            Some(e) => Err(e),
            None => Ok(scripting),
        }
    }

    /// As [`Scripting::new`], but a package that fails to load is left
    /// out and the rest load, as an error in one Lisp file leaves Emacs
    /// running: returns the failures, for the front ends to show.
    pub fn start(ed: &mut Editor) -> Result<(Scripting, Vec<Error>)> {
        let scripting = Scripting { engine: engine::Engine::new(ed)? };
        scripting.define_commands(ed);
        let mut failures = Vec::new();
        // Each package is an ES module, imported in this order; one that
        // imports another not yet loaded loads it first, as require does.
        for (name, _) in PACKAGES {
            if let Err(e) = loading(name.to_string(), || scripting.engine.import(ed, name)) {
                failures.push(e);
            }
        }
        Ok((scripting, failures))
    }

    /// Changes how long a script may run before it is stopped.
    pub fn set_time_limit(&self, limit: Duration) {
        TIME_LIMIT.set(limit);
    }

    /// Runs a TypeScript file as a script.
    pub fn load_file(&self, ed: &mut Editor, path: &Path) -> Result<()> {
        let name = abbreviate_path(path);
        let source = fs::read_to_string(path).map_err(|e| Error::new(format!("{name}: {e}")))?;
        loading(name.clone(), || self.eval_typescript(ed, &name, source))
    }

    /// Imports a TypeScript file as an ES module, as `e8 --batch -l`
    /// does, so it can import packages by name (`import { should } from
    /// "ert"`) and they it, along `load-path` as it is now. A file already
    /// imported is not run again.
    pub fn load_module(&self, ed: &mut Editor, path: &Path) -> Result<()> {
        let path = if fs::is_absolute(path) { path.to_path_buf() } else { fs::current_dir().unwrap_or_default().join(path) };
        if !fs::path_is_file(&path) {
            return Err(Error::signal(
                "file-missing",
                format!("Cannot open load file: No such file or directory, {}", path.display()),
                vec![EditorValue::Str(path.display().to_string())],
            ));
        }
        prepare_require(ed, "");
        let name = path.display().to_string();
        loading(abbreviate_path(&path), || self.engine.import(ed, &name))
    }

    /// Runs TypeScript source as a script. `filename` is used in error locations.
    ///
    /// Each script runs in its own block scope, so its top-level `const` and
    /// `let` do not clash with other scripts or with an earlier load of the
    /// same file. The opening brace shares line 1, so line numbers are unchanged.
    pub fn eval_typescript(&self, ed: &mut Editor, filename: &str, source: String) -> Result<()> {
        let js = format!("{{{}\n}}", strip_types(filename, source)?);
        self.engine.run(ed, filename, js)
    }

    /// Evaluates a TypeScript expression and returns its value as JSON, or
    /// `undefined`, as M-: does.
    pub fn eval_expression(&self, ed: &mut Editor, source: &str) -> Result<String> {
        let js = strip_types("expression", format!("({source}\n)"))?;
        self.engine.eval_json(ed, js)
    }

    fn define_commands(&self, ed: &mut Editor) {
        let scripting = self.clone();
        ed.define_command(
            Command::new(
                "load-file",
                "Run a TypeScript file, such as init.ts after editing it.\n\nCommands it defines replace existing commands with the same name.",
                move |ed, args| {
                    let path = expand_file_name(args[0].as_str()?);
                    ed.check_permission(&format!("run the TypeScript in {}", abbreviate_path(&path)))?;
                    scripting.load_file(ed, &path)?;
                    ed.message(format!("Loaded {}", abbreviate_path(&path)));
                    Ok(())
                },
            )
            .param("file", ParamKind::File, "Load file: "),
        );
        let scripting = self.clone();
        ed.define_command(
            Command::new(
                "eval-expression",
                "Evaluate a TypeScript expression and show its value.\n\nThe `e8` API is available, as in init.ts.",
                move |ed, args| {
                    ed.check_permission("run TypeScript")?;
                    let value = scripting.eval_expression(ed, args[0].as_str()?)?;
                    ed.message(value);
                    Ok(())
                },
            )
            .param("expression", ParamKind::String, "Eval: "),
        );
        let map = ed.global_map();
        ed.keymaps_mut().bind_str(map, "M-:", "eval-expression");
    }
}

/// Sets a thread-local cell and puts the old value back when dropped, even on panic.
struct Restore<T: Copy + 'static> {
    cell: &'static LocalKey<Cell<T>>,
    old: T,
}

impl<T: Copy + 'static> Restore<T> {
    fn set(cell: &'static LocalKey<Cell<T>>, value: T) -> Restore<T> {
        Restore { cell, old: cell.replace(value) }
    }
}

impl<T: Copy + 'static> Drop for Restore<T> {
    fn drop(&mut self) {
        self.cell.set(self.old);
    }
}

/// A script's arguments for a command, as the command's parameters take
/// them: numbers for counts and positions, Emacs's forms for a prefix
/// argument, and text, from which any of them can be read too.
fn command_args(ed: &Editor, name: &str, args: Vec<natives::ArgText>) -> Result<Vec<Arg>> {
    let command = ed.command(name).ok_or_else(|| Error::new(format!("No such command: {name}")))?;
    args.into_iter()
        .enumerate()
        .map(|(i, text)| Arg::from_text(command.params.get(i).map_or(ParamKind::String, |p| p.kind), &text.0))
        .collect()
}

/// The running editor's quit flag, read at the outermost entry.
fn with_editor_ref<T>(f: impl FnOnce(&Editor) -> T) -> Option<T> {
    // SAFETY: as in `with_editor`; only read, before the script runs.
    EDITOR.get().map(|ptr| f(unsafe { ptr.as_ref() }))
}

/// Runs `f`, which waits for input, with the script's time limit stopped:
/// the time the person takes to answer is not the script's (ADR 0053).
fn waiting<T>(f: impl FnOnce() -> T) -> T {
    let deadline = DEADLINE.take();
    let result = f();
    DEADLINE.set(deadline.map(|_| Instant::now() + TIME_LIMIT.get()));
    result
}

/// Gives a native the editor. Unless `safe_point` is false, the call is a
/// safe point: a quit asked for since the script last called in is
/// signalled here, as `quit`, which the script can catch, as Lisp's
/// primitives check `quit-flag`. The engine throws the error to the script.
fn editor_call<T>(safe_point: bool, f: impl FnOnce(&mut Editor) -> Result<T>) -> Result<T> {
    let Some(ptr) = EDITOR.get() else {
        return Err(Error::new("No editor is active"));
    };
    // SAFETY: the engine's entry set this from a live `&mut Editor` that is
    // not used while the script runs, and restores the previous value afterwards.
    let ed = unsafe { &mut *ptr.as_ptr() };
    if safe_point {
        ed.maybe_quit()?;
    }
    let result = f(ed);
    // What the call changed in a buffer sharing its text, the others see.
    ed.sync_shared_text();
    result
}

/// Runs a native's body, catching a panic in it so the engine can throw
/// it to the script, with the command loop's state put back as it was
/// before the body, as the editor's own catch does.
fn catch_native<T>(f: impl FnOnce() -> T) -> std::thread::Result<T> {
    let state = with_editor_ref(|ed| ed.loop_state());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    if result.is_err()
        && let (Some(state), Some(ptr)) = (state, EDITOR.get())
    {
        // SAFETY: as in `editor_call`; the body that held the editor has unwound.
        unsafe { &mut *ptr.as_ptr() }.restore_loop_state(state);
    }
    result
}

/// What a panic says.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default()
}

/// What the outermost entry into scripts sets up, and puts back when
/// dropped: the time limit, the quit flag the engine's stopper reads, and
/// the height of the binding stack, to unwind to if the script is stopped.
struct Outermost {
    _deadline: Restore<Option<Instant>>,
    quitting: Option<std::sync::Arc<e8_core::QuitState>>,
    depth: usize,
}

impl Outermost {
    fn begin() -> Outermost {
        let deadline = Restore::set(&DEADLINE, Some(Instant::now() + TIME_LIMIT.get()));
        let state = with_editor_ref(|ed| ed.quit_state().clone());
        let quitting = QUITTING.with_borrow_mut(|q| std::mem::replace(q, state));
        STOPPED_BY_QUIT.set(false);
        STOPPED.set(false);
        let depth = with_editor_ref(|ed| ed.specpdl_depth()).unwrap_or(0);
        Outermost { _deadline: deadline, quitting, depth }
    }

    /// After the script: one stopped where no `finally` ran has what it
    /// bound restored, as Emacs's emergency escape unwinds to top level.
    fn unwind_if_stopped(&self) {
        if STOPPED.get()
            && let Some(ptr) = EDITOR.get()
        {
            // SAFETY: as in `editor_call`; the script has stopped.
            unsafe { &mut *ptr.as_ptr() }.unbind_to(self.depth);
        }
    }
}

impl Drop for Outermost {
    fn drop(&mut self) {
        let previous = self.quitting.take();
        QUITTING.with_borrow_mut(|q| *q = previous);
    }
}

/// A nested entry into scripts, from a command run while a prompt waits,
/// gets a time limit of its own, as waiting cleared the asker's.
fn nested_deadline() -> Option<Restore<Option<Instant>>> {
    DEADLINE.get().is_none().then(|| Restore::set(&DEADLINE, Some(Instant::now() + TIME_LIMIT.get())))
}

/// Whether the running script must be stopped without unwinding: `C-g`
/// pressed again and again while it went on, or the time limit passed.
/// The engine asks this from time to time while a script runs.
fn should_stop() -> bool {
    let quit = QUITTING.with_borrow(|q| q.as_ref().is_some_and(|q| q.presses() >= QUITS_TO_STOP));
    if quit {
        STOPPED_BY_QUIT.set(true);
    }
    let stop = quit || DEADLINE.get().is_some_and(|deadline| Instant::now() > deadline);
    if stop {
        STOPPED.set(true);
    }
    stop
}

/// The message for a script that was stopped.
fn stopped_message() -> String {
    if STOPPED_BY_QUIT.get() {
        "Quit: the command was stopped".to_string()
    } else {
        format!("Script stopped after running for {:?}", TIME_LIMIT.get())
    }
}

/// Where a line starts and ends within the accessible portion, as Emacs's
/// `line-beginning-position` and `line-end-position` stop at `point-min`
/// and `point-max` in a narrowed buffer: a line the narrowing cuts through
/// is only its accessible part. A line wholly outside is left whole, as
/// code that looks there is looking past the buffer's ends.
fn accessible_line(b: &e8_core::Buffer, line: usize) -> (usize, usize) {
    let line = line.min(b.line_count() - 1);
    let (start, end) = (b.line_start(line), b.line_end(line));
    let (min, max) = (b.point_min(), b.point_max());
    if end < min || start > max {
        return (start, end);
    }
    let start = start.clamp(min, max);
    (start, end.clamp(start, max))
}

/// The Emacs attribute a script's face attribute key stands for: `weight`
/// is `:weight`, `inverseVideo` `:inverse-video`, and `bold`, `italic` and
/// `strike` are shorthands for `:weight bold`, `:slant italic` and
/// `:strike-through`.
fn face_attribute_key(key: &str) -> String {
    match key {
        "strike" => ":strike-through".into(),
        _ if key.starts_with(':') => key.into(),
        _ => {
            let mut out = String::from(":");
            for c in key.chars() {
                if c.is_ascii_uppercase() {
                    out.push('-');
                    out.push(c.to_ascii_lowercase());
                } else {
                    out.push(c);
                }
            }
            out
        }
    }
}

/// A face attribute's key as scripts give it: `:inverse-video` is `inverseVideo`.
fn camel_key(key: &str) -> String {
    let mut name = String::new();
    let mut upper = false;
    for c in key.trim_start_matches(':').chars() {
        if c == '-' {
            upper = true;
        } else {
            name.push(if upper { c.to_ascii_uppercase() } else { c });
            upper = false;
        }
    }
    name
}

/// What a failed script threw: its message, whether it looks like a bug in
/// the script rather than a deliberate error, and where it was thrown.
struct Failure {
    message: String,
    is_bug: bool,
    location: Option<String>,
    /// The condition and data a script's error carries, as e8.signal gives them.
    symbol: Option<String>,
    data: Vec<EditorValue>,
}

impl Failure {
    /// What a script threw, from its error's name, message, stack and
    /// condition. Errors the engine raises point at mistakes in the
    /// script, and their message says their type.
    fn thrown(name: &str, message: String, stack: Option<&str>, symbol: Option<String>, data: Vec<EditorValue>) -> Failure {
        let location = stack.and_then(first_location);
        let is_bug = matches!(name, "TypeError" | "ReferenceError" | "SyntaxError" | "RangeError" | "InternalError");
        let message = if is_bug { format!("{name}: {message}") } else { message };
        Failure { message, is_bug, location, symbol, data }
    }

    /// A script stopped by the time limit or `C-g`.
    fn stopped(location: Option<String>) -> Failure {
        Failure { message: stopped_message(), is_bug: false, location, symbol: Some("quit".into()), data: Vec::new() }
    }

    /// An error for a failed command. Deliberate errors show just their
    /// message, as in Emacs; script bugs also say where they happened.
    fn into_error(self) -> Error {
        let message = match self.location {
            Some(location) if self.is_bug => format!("{} ({location})", self.message),
            _ => self.message,
        };
        Error::signal(self.symbol.as_deref().unwrap_or("error"), message, self.data)
    }

    /// An error for a failed file load, which always says where it happened.
    fn into_error_with_location(self) -> Error {
        let message = match self.location {
            Some(location) => format!("{location}: {}", self.message),
            None => self.message,
        };
        Error::signal(self.symbol.as_deref().unwrap_or("error"), message, self.data)
    }
}

/// The first `file:line:col` in a stack trace that is not in the prelude.
fn first_location(stack: &str) -> Option<String> {
    stack.lines().find_map(|line| {
        let line = line.trim().strip_prefix("at ")?;
        let location = match line.rfind('(') {
            Some(i) => line[i + 1..].trim_end_matches(')'),
            None => line,
        };
        let looks_like_location = location.contains(':') && !location.starts_with("e8:prelude");
        looks_like_location.then(|| location.to_string())
    })
}

/// A process's codings from a script: one name for both ways, or [decode, encode].
fn coding_pair(value: Option<&EditorValue>) -> Result<Option<(e8_core::coding::Coding, e8_core::coding::Coding)>> {
    let Some(value) = value else { return Ok(None) };
    let names: Vec<String> = match value {
        EditorValue::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        v => v.as_str().map(|s| vec![s.to_string(), s.to_string()]).unwrap_or_default(),
    };
    let parse = |n: Option<&String>| -> Result<e8_core::coding::Coding> {
        let n = n.ok_or_else(|| Error::signal("wrong-type-argument", "A coding system for each way", Vec::new()))?;
        e8_core::coding::Coding::parse(n)
            .ok_or_else(|| Error::signal("wrong-type-argument", format!("Invalid coding system: {n}"), Vec::new()))
    };
    Ok(Some((parse(names.first())?, parse(names.get(1).or(names.first()))?)))
}

/// A script's function as a hook function, as a process's filter or a timer runs it.
fn hook_of(f: e8_core::Function) -> HookFn {
    Rc::new(move |ed, args| f.call(ed, args).map(drop))
}

/// The keymap a value names, or none for null.
fn keymap_or_none(ed: &Editor, value: &EditorValue) -> Result<Option<e8_core::KeymapId>> {
    if matches!(value, EditorValue::Null) { Ok(None) } else { ed.keymap_of(value).map(Some) }
}

