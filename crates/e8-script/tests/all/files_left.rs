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
    std::fs::set_permissions(dir.path().join("beta"), std::fs::Permissions::from_mode(0)).unwrap();
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
    // Touched to 1970: changed, until the buffer takes the new time.
    assert_eq!(eval(&mut ed, &s, &format!("(e8.setFileTimes({file:?}, 0), e8.verifyVisitedFileModtime())")), "false");
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[true,0]");
    assert_eq!(eval(&mut ed, &s, "(e8.clearVisitedFileModtime(), [e8.verifyVisitedFileModtime(), e8.visitedFileModtime()])"), "[true,0]");
    // Deleted since: changed.
    std::fs::remove_file(&file).unwrap();
    assert_eq!(eval(&mut ed, &s, "(e8.setVisitedFileModtime(5000), e8.verifyVisitedFileModtime())"), "false");
    // A buffer visiting no file, asked by name.
    assert_eq!(eval(&mut ed, &s, r#"e8.verifyVisitedFileModtime("*scratch*")"#), "true");
}
