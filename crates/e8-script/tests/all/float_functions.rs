//! floatfns.c's arithmetic and alloc.c's questions about memory (ADR
//! 0103). Each expectation is what Emacs 30.2 gives for the same calls.

use e8_core::Editor;
use e8_script::Scripting;

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn numbers_are_rounded_as_lisp_rounds_them() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // 2 4 -2 4 2 -4: halves to the even neighbour, with divisors.
    assert_eq!(r("return [e8.round(2.5), e8.round(3.5), e8.round(-2.5), e8.round(7, 2), e8.round(5, 2), e8.round(-7, 2)];"), "[2,4,-2,4,2,-4]");
    assert_eq!(r("return [e8.floor(2.7), e8.floor(-2.7), e8.floor(7, 2), e8.floor(-7, 2), e8.floor(7.5, 2)];"), "[2,-3,3,-4,3]");
    assert_eq!(r("return [e8.ceiling(2.1), e8.ceiling(7, 2), e8.ceiling(-7, 2), e8.truncate(-2.7), e8.truncate(7, -2)];"), "[3,4,-3,-2,-3]");
    assert_eq!(r("return [e8.fround(2.5), e8.ffloor(2.7), e8.fceiling(2.1), e8.ftruncate(-2.7)];"), "[2,2,3,-2]");
    assert_eq!(r("return e8.round(1, 0);"), "ERR arith-error Arithmetic error");
}

#[test]
fn floats_come_apart_and_together() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // (0.5 . 4) (0.0 . 0) (-0.75 . 2).
    assert_eq!(r("return [e8.frexp(8), e8.frexp(0), e8.frexp(-3)];"), "[[0.5,4],[0,0],[-0.75,2]]");
    assert_eq!(r("return [e8.ldexp(0.5, 4), e8.logb(8), e8.logb(10), e8.copysign(1, -2), e8.copysign(-3, 0), e8.isnan(NaN), e8.isnan(1)];"), "[8,3,3,-1,3,true,false]");
    assert_eq!(r("return [e8.expt(2, 10), e8.expt(2, 0.5), e8.expt(2, -1), e8.expt(0, 0)];"), "[1024,1.4142135623730951,0.5,1]");
    assert_eq!(r("return [e8.logarithm(8, 2), e8.funcall(\"log\", 100, 10), e8.logarithm(1), e8.float(3), e8.abs(-5), e8.sqrt(16), e8.atan(1, 1), e8.atan(1)];"), "[3,2,0,3,5,4,0.7853981633974483,0.7853981633974483]");
    assert_eq!(r("return [e8.memoryUseCounts().length, e8.garbageCollectMaybe(1) ?? null];"), "[7,null]");
    // memory-info is nil on macOS, as Emacs's is, and four numbers on Linux.
    let info = r("return e8.memoryInfo() ?? null;");
    if cfg!(target_os = "linux") {
        assert!(info.starts_with('[') && info.matches(',').count() == 3, "{info}");
    } else {
        assert_eq!(info, "null");
    }
}
