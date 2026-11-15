//! Running a buffer's TypeScript, as Emacs's eval-buffer and eval-region
//! run its Lisp, and read-char-exclusive (ADR 0104).

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn variable(ed: &Editor, name: &str) -> String {
    format!("{:?}", ed.variable(name))
}

#[test]
fn a_buffer_s_typescript_runs() {
    let (mut ed, _s) = setup();
    ed.type_text("const n: number = 41;\ne8.setVariable(\"eval-test\", n + 1);\n");
    ed.call("eval-buffer", vec![]).unwrap();
    assert_eq!(variable(&ed, "eval-test"), "Some(Number(42.0))");
    // Run twice, its top-level const does not clash, as each run has a scope of its own.
    ed.call("eval-buffer", vec![]).unwrap();
}

#[test]
fn a_region_s_typescript_runs() {
    let (mut ed, _s) = setup();
    ed.type_text("e8.setVariable(\"first\", 1);\ne8.setVariable(\"second\", 2);\n");
    // Only the second line.
    let start = "e8.setVariable(\"first\", 1);\n".chars().count();
    let end = ed.buffer().len();
    ed.call("eval-region", vec![Arg::Int(start as i64), Arg::Int(end as i64)]).unwrap();
    assert_eq!((variable(&ed, "first"), variable(&ed, "second")), ("None".to_string(), "Some(Number(2.0))".to_string()));
}

#[test]
fn a_buffer_that_imports_runs_as_a_module() {
    let (mut ed, _s) = setup();
    ed.type_text("import { truthy } from \"subr\";\ne8.setVariable(\"eval-mod\", truthy(1));\n");
    ed.call("eval-buffer", vec![]).unwrap();
    assert_eq!(variable(&ed, "eval-mod"), "Some(Bool(true))");
}

#[test]
fn read_char_exclusive_passes_over_other_events() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.defineCommand({ name: "test-read", run: () => e8.setVariable("got", e8.readCharExclusive("Char: ")) });
           e8.bindKey("C-c z", "test-read");"#
            .to_string(),
    )
    .unwrap();
    ed.press("C-c z <f1> a").unwrap();
    assert_eq!(variable(&ed, "got"), "Some(Str(\"a\"))");
}
