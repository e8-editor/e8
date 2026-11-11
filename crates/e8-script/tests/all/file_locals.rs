//! File-local variables where the oracle cannot look, as batch Emacs never
//! asks about a value that is not safe: the question in *Local Variables*
//! and its answers, enable-local-variables and enable-local-eval, risky
//! variables, `eval:`, `mode:`, and M-x normal-mode. The oracle
//! (tests/emacs/cases/file-locals.json) compares reading them with Emacs.

use std::fs;
use std::path::PathBuf;

use e8_core::Editor;
use e8_script::Scripting;

struct Visit {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
}

fn setup() -> Visit {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    Visit { ed, s, dir }
}

impl Visit {
    fn eval(&mut self, expression: &str) -> String {
        self.s.eval_expression(&mut self.ed, expression).unwrap()
    }

    fn file(&self, name: &str, text: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        fs::write(&path, text).unwrap();
        path
    }

    /// Visits a file with C-x C-f, then types `answer`, which answers what visiting asks.
    fn visit(&mut self, name: &str, text: &str, answer: &str) {
        let path = self.file(name, text);
        self.ed.press("C-x C-f").unwrap();
        self.ed.type_text(&format!("/{}", path.display()));
        self.ed.press(format!("RET {answer}").trim_end()).unwrap();
    }

    fn local(&mut self, variable: &str) -> String {
        self.eval(&format!("e8.prin1ToString(e8.variable('{variable}') ?? null)"))
    }
}

const UNSAFE: &str = "x\n\nLocal Variables:\nfill-column: 20\nmy-setting: 3\nEnd:\n";

/// Visits a file with C-x C-f on a driven editor, leaving it to ask.
fn visit_driven(d: &crate::driven::Driven, path: &std::path::Path) {
    d.press("C-x C-f");
    d.type_text(&format!("/{}", path.display()));
    d.press("RET");
}

/// The text of a buffer on a driven editor.
fn buffer_text(d: &crate::driven::Driven, name: &str) -> String {
    let name = name.to_string();
    d.with(move |ed| ed.buffers().iter().find(|b| b.name == name).map(|b| b.slice(0..b.len())).unwrap_or_default())
}

#[test]
fn unsafe_values_are_asked_about_and_set_on_y() {
    let t = setup();
    let path = t.file("a.txt", UNSAFE);
    let d = crate::driven::Driven::new("");
    visit_driven(&d, &path);
    assert_eq!(d.buffer_name(), "*Local Variables*", "the question shows them");
    assert_eq!(d.prompt().as_deref(), Some("Please type y, n, !, i: "));
    let shown = buffer_text(&d, "*Local Variables*");
    assert!(shown.starts_with("The local variables list in a.txt\nor .dir-locals.el contains values that may not be safe (*)."), "{shown}");
    assert!(shown.contains("\n    fill-column : 20\n  * my-setting : 3\n"), "{shown}");
    d.press("y");
    assert_eq!(d.buffer_name(), "a.txt");
    assert_eq!(d.variable("fill-column").as_deref(), Some("20"));
    assert_eq!(d.variable("my-setting").as_deref(), Some("3"));
    assert_eq!(buffer_text(&d, "*Local Variables*"), "", "killed");
}

#[test]
fn n_sets_none_of_them() {
    let mut t = setup();
    t.visit("a.txt", UNSAFE, "n");
    assert_eq!(t.local("fill-column"), "\"70\"", "safe ones are not set either");
    assert_eq!(t.local("my-setting"), "\"nil\"");
}

#[test]
fn bang_remembers_the_values_as_safe_and_i_as_ignored() {
    let mut t = setup();
    t.visit("a.txt", UNSAFE, "!");
    assert_eq!(t.local("my-setting"), "\"3\"");
    assert_eq!(t.eval("e8.prin1ToString(e8.variable('safe-local-variable-values'))"), "\"((my-setting 3))\"");
    // Not asked again.
    t.visit("b.txt", UNSAFE, "");
    assert_eq!(t.ed.window_buffer().name, "b.txt");
    assert_eq!(t.local("my-setting"), "\"3\"");
    // Ignored values are left out without asking.
    t.visit("c.txt", "x\n\nLocal Variables:\nother-setting: 4\nEnd:\n", "i");
    assert_eq!(t.local("other-setting"), "\"nil\"");
    t.visit("d.txt", "x\n\nLocal Variables:\nother-setting: 4\nfill-column: 30\nEnd:\n", "");
    assert_eq!(t.ed.window_buffer().name, "d.txt");
    assert_eq!(t.local("fill-column"), "\"30\"");
}

#[test]
fn risky_variables_cannot_be_marked_safe() {
    let t = setup();
    let path = t.file("a.txt", "x\n\nLocal Variables:\nmy-hook: ignore\nEnd:\n");
    let d = crate::driven::Driven::new("");
    visit_driven(&d, &path);
    let shown = buffer_text(&d, "*Local Variables*");
    assert!(shown.contains("contains variables that are risky (**)."), "{shown}");
    assert!(shown.contains(" ** my-hook : ignore\n") && !shown.contains("!  --"), "{shown}");
    assert_eq!(d.prompt().as_deref(), Some("Please type y or n: "));
    d.press("!");
    assert_eq!(d.prompt().as_deref(), Some("Please type y or n: "), "! is not an answer here");
    d.press("n");
    assert_eq!(d.buffer_name(), "a.txt");
    assert_eq!(d.variable("my-hook"), None);
}

#[test]
fn enable_local_variables_says_what_is_set() {
    let mut t = setup();
    t.eval("e8.setVariable('enable-local-variables', e8.intern(':safe'))");
    t.visit("a.txt", UNSAFE, "");
    assert_eq!((t.local("fill-column"), t.local("my-setting")), ("\"20\"".into(), "\"nil\"".into()), "only the safe ones, without asking");
    t.eval("e8.setVariable('enable-local-variables', e8.intern(':all'))");
    t.visit("b.txt", UNSAFE, "");
    assert_eq!(t.local("my-setting"), "\"3\"", "all of them");
    t.eval("e8.setVariable('enable-local-variables', null)");
    t.visit("c.txt", "x\n\nLocal Variables:\nfill-column: 25\nEnd:\n", "");
    assert_eq!(t.local("fill-column"), "\"70\"", "none");
    // M-x normal-mode sets them whatever it says.
    t.ed.press("M-x").unwrap();
    t.ed.type_text("normal-mode");
    t.ed.press("RET").unwrap();
    assert_eq!(t.local("fill-column"), "\"25\"");
}

#[test]
fn eval_runs_what_it_can_once_allowed() {
    let mut t = setup();
    t.visit("a.txt", "x\n\nLocal Variables:\neval: (setq-local fill-column 33)\neval: (visual-line-mode)\nEnd:\n", "y");
    assert_eq!(t.local("fill-column"), "\"33\"");
    assert_eq!(t.local("visual-line-mode"), "\"t\"");
    t.eval("e8.setVariable('enable-local-eval', null)");
    t.visit("b.txt", "x\n\nLocal Variables:\neval: (setq-local fill-column 44)\nEnd:\n", "");
    assert_eq!(t.ed.window_buffer().name, "b.txt", "not asked");
    assert_eq!(t.local("fill-column"), "\"70\"");
}

#[test]
fn a_minor_mode_call_is_safe_to_eval() {
    let mut t = setup();
    t.visit("a.txt", "x\n\nLocal Variables:\neval: (auto-fill-mode 1)\nEnd:\n", "");
    assert_eq!(t.ed.window_buffer().name, "a.txt", "not asked");
    assert_eq!(t.eval("String(e8.variable('auto-fill-function') !== null)"), "\"true\"");
}

#[test]
fn mode_in_the_list_chooses_the_major_mode() {
    let mut t = setup();
    t.visit("a.notes", "* A heading\n\nLocal Variables:\nmode: org\nfill-column: 50\nEnd:\n", "");
    assert_eq!(t.local("major-mode"), "\"\\\"org-mode\\\"\"");
    assert_eq!(t.local("fill-column"), "\"50\"");
    assert_eq!(t.eval("e8.prin1ToString(e8.variable('file-local-variables-alist'))"), "\"((fill-column 50))\"");
}

#[test]
fn a_file_chooses_its_spelling_dictionary() {
    let mut t = setup();
    t.visit("notes.org", "# -*- ispell-local-dictionary: \"sv_SE\" -*-\nHej\n", "");
    assert_eq!(t.ed.window_buffer().name, "notes.org", "safe, not asked");
    assert_eq!(t.local("ispell-local-dictionary"), "\"\\\"sv_SE\\\"\"");
    assert_eq!(t.eval("e8.prin1ToString(e8.defaultValue('ispell-local-dictionary') ?? null)"), "\"nil\"", "only this buffer's");
}

#[test]
fn changing_the_major_mode_keeps_the_files_variables() {
    let mut t = setup();
    t.visit("a.txt", "x\n\nLocal Variables:\nfill-column: 20\nEnd:\n", "");
    t.ed.press("M-x").unwrap();
    t.ed.type_text("fundamental-mode");
    t.ed.press("RET").unwrap();
    assert_eq!(t.local("fill-column"), "\"20\"", "set again after the mode's hooks, as run-mode-hooks does");
}

#[test]
fn values_are_read_and_written_as_lisp() {
    let mut t = setup();
    assert_eq!(t.eval("e8.prin1ToString(e8.readFromString('fill-column: (a \\\"b\\\" 3) ; x', 13)[0])"), r#""(a \"b\" 3)""#);
    assert_eq!(t.eval("e8.readFromString('fill-column: (a \\\"b\\\" 3) ; x', 13)[1]"), "22");
    assert_eq!(t.eval("e8.prin1ToString([e8.intern('quote'), [e8.intern('a'), 1.5, null, true]])"), r#""'(a 1.5 nil t)""#);
}

#[test]
fn an_eval_add_hook_is_not_added_again_when_the_mode_changes() {
    let mut t = setup();
    t.eval("(e8.defineVariable({ name: 'test-saves', value: 0 }), e8.defun('test-count-save', () => e8.setVariable('test-saves', Number(e8.variable('test-saves')) + 1)))");
    t.eval("e8.setVariable('safe-local-eval-forms', [[e8.intern('add-hook'), [e8.intern('quote'), e8.intern('before-save-hook')], [e8.intern('quote'), e8.intern('test-count-save')], null, true]])");
    t.visit("a.txt", "x\n\nLocal Variables:\neval: (add-hook 'before-save-hook 'test-count-save nil t)\nEnd:\n", "");
    for _ in 0..2 {
        t.ed.press("M-x").unwrap();
        t.ed.type_text("text-mode");
        t.ed.press("RET").unwrap();
    }
    t.eval("e8.runHooks('before-save-hook')");
    assert_eq!(t.local("test-saves"), "\"1\"", "once, however often the variables are set");
}

#[test]
fn a_value_after_characters_beyond_the_bmp_is_read_where_it_is() {
    let mut t = setup();
    t.visit("a.txt", "-*- my-title: \"\u{1F600}\"; fill-column: 20 -*-\n", "y");
    assert_eq!(t.local("fill-column"), "\"20\"");
    assert_eq!(t.local("my-title"), "\"\\\"\u{1F600}\\\"\"");
}

// Directory-local variables, from .dir-locals.el.

#[test]
fn a_notes_directory_chooses_its_spelling_dictionary() {
    let mut t = setup();
    t.file(".dir-locals.el", "((org-mode . ((ispell-local-dictionary . \"sv_SE\"))))\n");
    t.visit("notes.org", "* Hej\n", "");
    assert_eq!(t.ed.window_buffer().name, "notes.org", "safe, not asked");
    assert_eq!(t.local("ispell-local-dictionary"), "\"\\\"sv_SE\\\"\"");
    assert_eq!(t.eval("e8.prin1ToString(e8.variable('dir-local-variables-alist'))"), "\"((ispell-local-dictionary \\\"sv_SE\\\"))\"");
    t.visit("notes.txt", "Hello\n", "");
    assert_eq!(t.local("ispell-local-dictionary"), "\"nil\"", "only Org files");
}

#[test]
fn unsafe_directory_values_are_asked_about_with_plus_to_trust_the_directory() {
    let t = setup();
    // Named as the file was visited, its symbolic links not followed, as Emacs's dir-locals-find-file names it.
    let dir = format!("{}/", t.dir.path().display());
    t.file(".dir-locals.el", "((nil . ((my-setting . 3))))\n");
    let path = t.file("a.txt", "x\n");
    let d = crate::driven::Driven::new("");
    visit_driven(&d, &path);
    let shown = buffer_text(&d, "*Local Variables*");
    assert!(shown.starts_with(&format!("The local variables list in {dir}\nor .dir-locals.el contains values that may not be safe (*).")), "{shown}");
    assert!(shown.contains("+  -- to apply the local variables list, and trust all directory-local\n      variables in this directory"), "{shown}");
    assert_eq!(d.prompt().as_deref(), Some("Please type y, n, !, i, +: "));
    d.press("+");
    assert_eq!(d.variable("my-setting").as_deref(), Some("3"));
    // The directory is trusted from now on: another file there is not asked about.
    let other = t.file("b.txt", "y\n");
    visit_driven(&d, &other);
    assert_eq!(d.buffer_name(), "b.txt");
    assert_eq!(d.variable("my-setting").as_deref(), Some("3"));
}

#[test]
fn a_changed_dir_locals_file_is_read_again() {
    let mut t = setup();
    let locals = t.file(".dir-locals.el", "((nil . ((fill-column . 20))))\n");
    t.visit("a.txt", "x\n", "");
    assert_eq!(t.local("fill-column"), "\"20\"");
    fs::write(&locals, "((nil . ((fill-column . 30))))\n").unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    fs::File::options().write(true).open(&locals).unwrap().set_modified(later).unwrap();
    t.visit("b.txt", "y\n", "");
    assert_eq!(t.local("fill-column"), "\"30\"");
}

#[test]
fn a_class_can_be_given_to_a_directory_by_code() {
    let mut t = setup();
    // The directory as files in it are visited: Emacs matches a class's directory by its expanded name, not its truename.
    let dir = t.dir.path().display().to_string();
    t.eval(&format!(
        "(e8.funcall('dir-locals-set-class-variables', e8.intern('notes'), [[null, [e8.intern('fill-column'), 25]]]), \
         e8.funcall('dir-locals-set-directory-class', {dir:?}, e8.intern('notes')))"
    ));
    t.visit("a.txt", "x\n", "");
    assert_eq!(t.local("fill-column"), "\"25\"");
}

#[test]
fn dired_takes_up_the_directory_s_variables() {
    let mut t = setup();
    t.file(".dir-locals.el", "((dired-mode . ((fill-column . 33))))\n");
    t.file("a.txt", "x\n");
    let dir = t.dir.path().canonicalize().unwrap().display().to_string();
    t.ed.call("dired", vec![e8_core::Arg::Str(dir)]).unwrap();
    assert_eq!(t.local("major-mode"), "\"\\\"dired-mode\\\"\"");
    assert_eq!(t.local("fill-column"), "\"33\"");
}

#[test]
fn file_and_directory_variables_are_copied_between_them() {
    let mut t = setup();
    t.file(".dir-locals.el", "((nil . ((fill-column . 20))))\n");
    t.visit("a.txt", "Hello\n", "");
    t.ed.press("M-x").unwrap();
    t.ed.type_text("copy-dir-locals-to-file-locals");
    t.ed.press("RET").unwrap();
    let b = t.ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "Hello\n\n;; Local Variables:\n;; fill-column: 20\n;; End:\n");
}

#[test]
fn a_trusted_directory_may_be_written_without_its_slash() {
    let mut t = setup();
    let dir = t.dir.path().canonicalize().unwrap().display().to_string();
    t.eval(&format!("e8.setVariable('safe-local-variable-directories', [{dir:?}])"));
    t.file(".dir-locals.el", "((nil . ((my-setting . 3))))\n");
    t.visit("a.txt", "x\n", "");
    assert_eq!(t.ed.window_buffer().name, "a.txt", "not asked");
    assert_eq!(t.local("my-setting"), "\"3\"");
}

#[test]
fn a_trusted_directory_is_trusted_through_a_link_to_it() {
    // As Emacs compares safe-local-variable-directories with file-equal-p, which follows symbolic links.
    let t = setup();
    let real = t.dir.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join(".dir-locals.el"), "((nil . ((my-setting . 3))))\n").unwrap();
    fs::write(real.join("a.txt"), "x\n").unwrap();
    let link = t.dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let d = crate::driven::Driven::new(&format!(
        "e8.setVariable('safe-local-variable-directories', [{:?}])",
        format!("{}/", real.canonicalize().unwrap().display())
    ));
    visit_driven(&d, &link.join("a.txt"));
    assert_eq!(d.buffer_name(), "a.txt", "not asked");
    assert_eq!(d.variable("my-setting").as_deref(), Some("3"));
}
