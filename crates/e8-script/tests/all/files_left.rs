//! The file primitives of ADR 0072: default modes, whether a visited file
//! changed, completing file names, listing a directory with attributes and
//! access-file. The answers are what Emacs 30 gives in batch on the same
//! files.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    for name in ["alpha.txt", "alphabet.el", "alphabet.elc", "beta", "Gamma.TXT", ".hidden", "foo~"] {
        std::fs::write(dir.path().join(name), "x").unwrap();
    }
    std::fs::create_dir(dir.path().join("alphadir")).unwrap();
    std::fs::create_dir(dir.path().join("betadir")).unwrap();
    let cd = format!("(e8.makeLocalVariable(\"default-directory\"), e8.setVariable(\"default-directory\", {:?}))", format!("{}/", dir.path().display()));
    scripting.eval_expression(&mut ed, &cd).unwrap();
    (ed, scripting, dir)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn file_name_completion_as_emacs_completes() {
    let (mut ed, s, _dir) = setup();
    let complete = |ed: &mut Editor, file: &str| eval(ed, &s, &format!("e8.fileNameCompletion({file:?}, e8.variable(\"default-directory\")) ?? null"));
    // What the names share; .elc and ~ files only when nothing else matches.
    assert_eq!(complete(&mut ed, "a"), r#""alpha""#);
    assert_eq!(complete(&mut ed, "alphab"), r#""alphabet.el""#);
    assert_eq!(complete(&mut ed, "alphabet.el"), "true");
    assert_eq!(complete(&mut ed, "foo"), r#""foo~""#);
    // An exact name that is not the only one; a directory with its slash.
    assert_eq!(complete(&mut ed, "beta"), r#""beta""#);
    assert_eq!(complete(&mut ed, "betad"), r#""betadir/""#);
    assert_eq!(complete(&mut ed, "z"), "null");
    assert_eq!(complete(&mut ed, ""), r#""""#);
    // . and .. give way to other names.
    assert_eq!(complete(&mut ed, "."), r#"".hidden""#);
    let got = eval(&mut ed, &s, r#"e8.letBind({ "completion-ignore-case": true }, () => e8.fileNameCompletion("g", e8.variable("default-directory")))"#);
    assert_eq!(got, r#""Gamma.TXT""#);
    // The predicate is called with names relative to the directory.
    let got = eval(&mut ed, &s, r#"e8.fileNameCompletion("alpha", "/", (name) => e8.fileDirectoryP(name)) ?? null"#);
    assert_eq!(got, "null");
    let got = eval(&mut ed, &s, r#"e8.fileNameCompletion("alpha", e8.variable("default-directory"), (name) => e8.fileDirectoryP(name))"#);
    assert_eq!(got, r#""alphadir/""#);
}

#[test]
fn file_name_all_completions_lists_every_name() {
    let (mut ed, s, _dir) = setup();
    let all = |ed: &mut Editor, file: &str| eval(ed, &s, &format!("e8.fileNameAllCompletions({file:?}, e8.variable(\"default-directory\")).sort()"));
    assert_eq!(all(&mut ed, "alpha"), r#"["alpha.txt","alphabet.el","alphabet.elc","alphadir/"]"#);
    assert_eq!(
        all(&mut ed, ""),
        r#"["../","./",".hidden","Gamma.TXT","alpha.txt","alphabet.el","alphabet.elc","alphadir/","beta","betadir/","foo~"]"#
    );
    assert_eq!(all(&mut ed, "."), r#"["../","./",".hidden"]"#);
}

#[test]
fn directory_files_and_attributes_pairs_names_with_attributes() {
    let (mut ed, s, _dir) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"e8.directoryFilesAndAttributes(e8.variable("default-directory"), false, "^a").map(([name, a]) => [name, a.type])"#,
    );
    assert_eq!(got, r#"[["alpha.txt","file"],["alphabet.el","file"],["alphabet.elc","file"],["alphadir","directory"]]"#);
    // Full names, at most `count` of them: which, Emacs leaves to the order it reads the directory in.
    let got = eval(&mut ed, &s, r#"e8.directoryFilesAndAttributes(e8.variable("default-directory"), true, "a", null, null, 2).map(([name]) => name.startsWith(e8.variable("default-directory")))"#);
    assert_eq!(got, "[true,true]");
    assert_eq!(eval(&mut ed, &s, r#"e8.directoryFilesAndAttributes(e8.variable("default-directory"), false, null, true).length"#), "11");
    assert_eq!(eval(&mut ed, &s, r#"[e8.fileAttributesLessp(["a", 1], ["b", 0]), e8.fileAttributesLessp(["b", 1], ["a", 0])]"#), "[true,false]");
}

#[test]
fn access_file_says_why_a_file_cannot_be_read() {
    let (mut ed, s, dir) = setup();
    let access = r#"e8.conditionCase(() => e8.accessFile(NAME, "Reading") ?? null, { error: (e) => [e.symbol, ...e.data] })"#;
    assert_eq!(eval(&mut ed, &s, &access.replace("NAME", r#""beta""#)), "null");
    assert_eq!(eval(&mut ed, &s, &access.replace("NAME", r#""nope""#)), r#"["file-missing","Reading","No such file or directory","nope"]"#);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path().join("beta"), std::fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(eval(&mut ed, &s, &access.replace("NAME", r#""beta""#)), r#"["permission-denied","Reading","Permission denied","beta"]"#);
}

#[test]
fn default_file_modes_are_the_umask_and_with_file_modes_puts_them_back() {
    let (mut ed, s, dir) = setup();
    let before = eval(&mut ed, &s, "e8.defaultFileModes()");
    assert_eq!(eval(&mut ed, &s, "(e8.setDefaultFileModes(0o700), e8.defaultFileModes())"), "448");
    // A file written now can be read only by its owner.
    std::fs::write(dir.path().join("private"), "secret").unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.path().join("private")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(eval(&mut ed, &s, &format!("(e8.setDefaultFileModes({before}), e8.defaultFileModes())")), before);
    let module = dir.path().join("modes.ts");
    std::fs::write(&module, "import { withFileModes } from \"subr\";\nglobalThis.inside = withFileModes(0o700, () => e8.defaultFileModes());\n").unwrap();
    s.load_module(&mut ed, &module).unwrap();
    assert_eq!(eval(&mut ed, &s, "[inside, e8.defaultFileModes()]"), format!("[448,{before}]"));
}

#[test]
fn verify_visited_file_modtime_as_emacs_answers() {
    let (mut ed, s, dir) = setup();
    let file = dir.path().join("beta").display().to_string();
    ed.call("find-file", vec![Arg::Str(file.clone())]).unwrap();
    assert_eq!(eval(&mut ed, &s, "[e8.verifyVisitedFileModtime(), e8.visitedFileModtime() > 0]"), "[true,true]");
    // Read and set back, it is the same, to the nanosecond.
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(e8.visitedFileModtime()), e8.verifyVisitedFileModtime())"), "true");
    assert_eq!(eval(&mut ed, &s, &format!("(e8.setVisitedFileModtime(e8.fileAttributes({file:?}).modified), e8.verifyVisitedFileModtime())")), "true");
    // Touched to a second after 1970: changed, until the buffer takes the new time.
    assert_eq!(eval(&mut ed, &s, &format!("(e8.setFileTimes({file:?}, 1000), e8.verifyVisitedFileModtime())")), "false");
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[true,1000]");
    // 0 and -1 as Emacs's: none known, and a file that does not exist.
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(0), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[true,0]");
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(-1), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[false,-1]");
    assert_eq!(eval(&mut ed, &s, "(e8.clearVisitedFileModtime(), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[true,0]");
    // Deleted since: changed.
    std::fs::remove_file(&file).unwrap();
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(5000), e8.verifyVisitedFileModtime())"), "false");
    // A buffer visiting no file, asked by name.
    assert_eq!(eval(&mut ed, &s, r#"e8.verifyVisitedFileModtime("*scratch*")"#), "true");
}

#[test]
fn completion_ignores_extensions_and_chooses_case_as_emacs_does() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    for name in [".gitignore", "x.a", "x.asm", "Foobar", "foo.txt", "Gamma.TXT"] {
        std::fs::write(dir.path().join(name), "x").unwrap();
    }
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    std::fs::create_dir(dir.path().join("CVS")).unwrap();
    let d = format!("{}/", dir.path().display());
    let complete = |ed: &mut Editor, file: &str, fold: bool| {
        eval(ed, &s, &format!("e8.letBind({{ \"completion-ignore-case\": {fold} }}, () => e8.fileNameCompletion({file:?}, {d:?}))"))
    };
    // As Emacs 30 gives them: a directory named as an ignored one, an
    // ignored extension only past what was typed.
    assert_eq!(complete(&mut ed, ".g", false), r#"".gitignore""#);
    assert_eq!(complete(&mut ed, "C", false), r#""CVS/""#);
    assert_eq!(complete(&mut ed, "x.a", false), r#""x.a""#);
    assert_eq!(complete(&mut ed, "x", false), r#""x.asm""#);
    // Ignoring case: the case of an exact match, else of a name starting as typed.
    assert_eq!(complete(&mut ed, "gamma.txt", true), r#""Gamma.TXT""#);
    assert_eq!(complete(&mut ed, "f", true), r#""foo""#);
    assert_eq!(complete(&mut ed, "F", true), r#""Foo""#);
    assert_eq!(complete(&mut ed, "f", false), r#""foo.txt""#);
    // completion-regexp-list keeps only the names its regexps match.
    let got = eval(&mut ed, &s, &format!("e8.letBind({{ \"completion-regexp-list\": [\"txt\"] }}, () => e8.fileNameAllCompletions(\"\", {d:?}).sort())"));
    assert_eq!(got, r#"["foo.txt"]"#);
    // access-file says what the system says.
    let got = eval(&mut ed, &s, &format!("e8.conditionCase(() => e8.accessFile({:?}, \"Reading\") ?? null, {{ error: (e) => [e.symbol, ...e.data] }})", format!("{d}foo.txt/sub")));
    assert_eq!(got, format!(r#"["file-error","Reading","Not a directory","{d}foo.txt/sub"]"#));
    assert_eq!(eval(&mut ed, &s, r#"e8.conditionCase(() => e8.fileAttributesLessp([1], ["a"]), { "wrong-type-argument": () => "wrong-type-argument" })"#), r#""wrong-type-argument""#);
}

#[test]
fn auto_save_state_and_locks_as_emacs_keeps_them() {
    let (mut ed, s, dir) = setup();
    let file = dir.path().join("alpha.txt").display().to_string();
    ed.call("find-file", vec![Arg::Str(file.clone())]).unwrap();
    // As Emacs 30: not auto-saved since visiting, until it is taken as auto-saved.
    assert_eq!(eval(&mut ed, &s, "e8.recentAutoSaveP()"), "false");
    ed.type_text("z");
    assert_eq!(eval(&mut ed, &s, "e8.recentAutoSaveP()"), "false");
    assert_eq!(eval(&mut ed, &s, "(e8.setBufferAutoSaved(), e8.clearBufferAutoSaveFailure(), e8.recentAutoSaveP())"), "true");
    // Locks: Emacs gives (t nil t nil t nil).
    let locked = format!("Boolean(e8.fileLockedP({file:?}))");
    let got = eval(
        &mut ed,
        &s,
        &format!(
            "[{locked}, (e8.unlockBuffer(), {locked}), (e8.lockBuffer(), {locked}), (e8.unlockFile({file:?}), {locked}), (e8.lockFile({file:?}), {locked}), (e8.setBufferModified(false), e8.unlockBuffer(), {locked})]"
        ),
    );
    assert_eq!(got, "[true,false,true,false,true,false]");
    // Modified again, it holds the lock again, as Emacs's set-buffer-modified-p takes it.
    assert_eq!(eval(&mut ed, &s, &format!("(e8.setBufferModified(true), {locked})")), "true");
    eval(&mut ed, &s, "e8.setBufferModified(false)");
}

#[test]
fn the_internal_primitives_files_el_builds_on() {
    let (mut ed, s, dir) = setup();
    let d = format!("{}/", dir.path().display());
    let got = eval(&mut ed, &s, &format!(r#"(globalThis.f = e8.makeTempFileInternal({:?}, null, ".s"), [e8.fileExistsP(f), f.endsWith(".s")])"#, format!("{d}tmpx")));
    assert_eq!(got, "[true,true]");
    assert_eq!(eval(&mut ed, &s, &format!(r#"e8.fileDirectoryP(e8.makeTempFileInternal({:?}, true, ""))"#, format!("{d}tmpd"))), "true");
    let made: String = serde_json::from_str(&eval(&mut ed, &s, &format!(r#"e8.makeTempFileInternal({:?}, null, "", "hello")"#, format!("{d}tmpt")))).unwrap();
    assert_eq!(std::fs::read_to_string(made).unwrap(), "hello");
    assert_eq!(eval(&mut ed, &s, &format!(r#"e8.fileExistsP(e8.makeTempFileInternal({:?}, 0, ""))"#, format!("{d}tmpn"))), "false");
    // As Emacs 30: (nil t), file-already-exists, (nil nil), (nil nil), nil.
    let made = format!("{d}made");
    assert_eq!(eval(&mut ed, &s, &format!("[e8.makeDirectoryInternal({made:?}) ?? null, e8.fileDirectoryP({made:?})]")), "[null,true]");
    assert_eq!(eval(&mut ed, &s, &format!("e8.conditionCase(() => e8.makeDirectoryInternal({made:?}), {{ error: (e) => e.symbol }})")), r#""file-already-exists""#);
    assert_eq!(eval(&mut ed, &s, &format!("[e8.deleteDirectoryInternal({made:?}) ?? null, e8.fileExistsP({made:?})]")), "[null,false]");
    assert_eq!(eval(&mut ed, &s, &format!("[e8.deleteFileInternal({:?}) ?? null, e8.fileExistsP({:?})]", format!("{d}foo~"), format!("{d}foo~"))), "[null,false]");
    assert_eq!(eval(&mut ed, &s, &format!("e8.deleteFileInternal({:?}) ?? null", format!("{d}nope"))), "null");
}

#[test]
fn the_system_and_what_e8_does_not_support() {
    let (mut ed, s, _dir) = setup();
    assert_eq!(eval(&mut ed, &s, r#"[e8.unhandledFileNameDirectory("/tmp/foo/bar"), e8.unhandledFileNameDirectory("/tmp/foo/")]"#), r#"["/tmp/foo/bar/","/tmp/foo/"]"#);
    assert_eq!(eval(&mut ed, &s, r#"(globalThis.i = e8.fileSystemInfo("."), [i.length, i.every((n) => typeof n === "number" && n >= 0), i[0] >= i[1] && i[1] >= i[2]])"#), "[3,true,true]");
    // As Emacs 30 on a system without ACLs or SELinux.
    assert_eq!(
        eval(&mut ed, &s, r#"[e8.unixSync() ?? null, e8.setBinaryMode("stdout", true), e8.fileAcl("beta") ?? null, e8.fileSelinuxContext("beta"), e8.setFileAcl("beta", null), e8.setFileSelinuxContext("beta", [null, null, null, null])]"#),
        "[null,true,null,[null,null,null,null],false,false]"
    );
}

#[test]
fn unmodified_again_a_buffer_is_as_saved_and_explicit_locks_last() {
    let (mut ed, s, dir) = setup();
    let file = dir.path().join("beta").display().to_string();
    ed.call("find-file", vec![Arg::Str(file.clone())]).unwrap();
    // As Emacs 30: no longer modified, it was saved after its auto-save.
    ed.type_text("y");
    assert_eq!(eval(&mut ed, &s, "(e8.setBufferAutoSaved(), e8.setBufferModified(false), e8.recentAutoSaveP())"), "false");
    ed.type_text("y");
    assert_eq!(eval(&mut ed, &s, "(e8.setBufferAutoSaved(), e8.setBufferModified(false), e8.setBufferModified(true), e8.recentAutoSaveP())"), "false");
    eval(&mut ed, &s, "e8.setBufferModified(false)");
    // A lock taken on an unmodified buffer's file lasts past the command, until unlock-file.
    let other = dir.path().join("alpha.txt").display().to_string();
    ed.call("find-file", vec![Arg::Str(other.clone())]).unwrap();
    eval(&mut ed, &s, &format!("e8.lockFile({other:?})"));
    ed.press("C-f").unwrap();
    assert_eq!(eval(&mut ed, &s, &format!("Boolean(e8.fileLockedP({other:?}))")), "true");
    assert_eq!(eval(&mut ed, &s, &format!("(e8.unlockFile({other:?}), Boolean(e8.fileLockedP({other:?})))")), "false");
}

#[test]
fn internal_primitives_answer_as_emacs_does_at_the_edges() {
    let (mut ed, s, dir) = setup();
    // As Emacs 30: no file system for a missing directory, names not expanded,
    // a name only made nowhere, and rmdir refusing what is not empty.
    assert_eq!(eval(&mut ed, &s, r#"e8.fileSystemInfo("/nonexistent/x") ?? null"#), "null");
    assert_eq!(eval(&mut ed, &s, r#"[e8.unhandledFileNameDirectory("foo"), e8.unhandledFileNameDirectory("")]"#), r#"["foo/","./"]"#);
    assert_eq!(eval(&mut ed, &s, r#"(globalThis.n = e8.makeTempFileInternal("/nonexistent-dir/x", 0, ".s"), [n.startsWith("/nonexistent-dir/x"), n.endsWith(".s"), n.length])"#), "[true,true,26]");
    let busy = format!("{}/alphadir", dir.path().display());
    std::fs::write(format!("{busy}/inside"), "x").unwrap();
    assert_eq!(eval(&mut ed, &s, &format!("e8.conditionCase(() => e8.deleteDirectoryInternal({busy:?}), {{ error: (e) => e.data[1] }})")), r#""Directory not empty""#);
}
