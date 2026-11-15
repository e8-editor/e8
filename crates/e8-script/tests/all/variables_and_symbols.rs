//! Variables and symbols as data.c, eval.c and lread.c have them (ADR
//! 0101). Each expectation is what Emacs 30.2 gives for the same calls.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, symbols as `~name`, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null, (k, v) => typeof v === 'symbol' ? `~${{Symbol.keyFor(v)}}` : v); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn aliases_and_watchers_follow_variables() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.defineVariable({ name: "my-base", value: 1 }); e8.defvaralias("my-alias", "my-base");"#);
    assert_eq!(r(r#"return [e8.variable("my-alias"), e8.indirectVariable("my-alias")];"#), r#"[1,"my-base"]"#);
    assert_eq!(r(r#"e8.setVariable("my-alias", 5); return e8.variable("my-base");"#), "5");
    assert_eq!(r(r#"return e8.defvaralias("my-base", "my-alias");"#), "ERR cyclic-variable-indirection Symbol's chain of variable indirections contains a loop: my-alias");
    // ((my-base 7 set nil) (my-base 8 set nil) (my-base 9 set #<buffer>) (my-base nil makunbound nil)).
    assert_eq!(
        r(r#"const log: e8.Value[] = []; globalThis.watchLog = log;
            e8.addVariableWatcher("my-base", (s, n, o, w) => log.push([s, n, o, w === null || w === undefined ? null : "buffer"]));
            e8.setVariable("my-base", 7); e8.setVariable("my-alias", 8);
            e8.makeLocalVariable("my-base"); e8.setVariable("my-base", 9); e8.killLocalVariable("my-base");
            e8.makunbound("my-base"); return log;"#),
        r#"[["~my-base",7,"~set",null],["~my-base",8,"~set",null],["~my-base",9,"~set","buffer"],["~my-base",null,"~makunbound","buffer"],["~my-base",null,"~makunbound",null]]"#
    );
    assert_eq!(r(r#"return [e8.getVariableWatchers("my-base").length, e8.boundp("my-base"), e8.boundp("nope"), e8.defaultBoundp("my-base")];"#), "[1,false,false,false]");
    assert_eq!(r(r#"e8.removeVariableWatcher("my-base", e8.getVariableWatchers("my-base")[0]); return e8.getVariableWatchers("my-base").length;"#), "0");
}

#[test]
fn variables_are_bound_local_and_special() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.defineVariable({ name: "my-l", value: 1 }); e8.makeLocalVariable("my-l"); e8.setVariable("my-l", 2);"#);
    assert_eq!(r(r#"return [e8.localVariableP("my-l"), e8.localVariableIfSetP("my-l"), e8.localVariableP("my-l", e8.getBufferCreate("other"))];"#), "[true,true,false]");
    r(r#"e8.makeVariableBufferLocal("my-auto");"#);
    assert_eq!(r(r#"const before = e8.localVariableIfSetP("my-auto"); e8.setVariable("my-auto", 3); return [before, e8.localVariableP("my-auto")];"#), "[true,true]");
    assert_eq!(r(r#"return [e8.specialVariableP("my-l"), e8.specialVariableP("nope2"), e8.symbolValue("my-l")];"#), "[true,false,2]");
    assert_eq!(r(r#"return e8.symbolValue("nope3");"#), "ERR void-variable Symbol’s value as variable is void: nope3");
}

#[test]
fn symbols_numbers_errors_commands_hooks_and_files() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"e8.defineVariable({ name: "my-l", value: 1 }); return [e8.internSoft("my-l"), e8.internSoft("surely-not-a-symbol-xyz") ?? null];"#), r#"["my-l",null]"#);
    assert_eq!(r(r#"let n = 0; e8.mapatoms((s) => { if (s === "my-l") n++; }); return [n, e8.unintern("my-l"), e8.internSoft("my-l") ?? null];"#), "[1,true,null]");
    // 12 -150.0 255 0 0 0.5 100000.0 7, then "3" "1.5" "-0.25".
    assert_eq!(
        r(r#"return [e8.stringToNumber("12"), e8.stringToNumber(" -1.5e2x"), e8.stringToNumber("ff", 16), e8.stringToNumber("0x10"), e8.stringToNumber("abc"), e8.stringToNumber(".5"), e8.stringToNumber("1e5"), e8.stringToNumber("+7")];"#),
        "[12,-150,255,0,0,0.5,100000,7]"
    );
    assert_eq!(r("return [e8.numberToString(3), e8.numberToString(1.5), e8.numberToString(-0.25)];"), r#"["3","1.5","-0.25"]"#);
    assert_eq!(
        r(r#"return [e8.errorMessageString(["error", "Hi"]), e8.errorMessageString(["void-variable", Symbol.for("foo")]), e8.errorMessageString(["wrong-type-argument", Symbol.for("stringp"), 1]), e8.errorMessageString(["file-missing", "Opening input file", "No such file or directory", "/x"])];"#),
        r#"["Hi","Symbol’s value as variable is void: foo","Wrong type argument: stringp, 1","Opening input file: No such file or directory, /x"]"#
    );
    assert_eq!(r(r#"return [e8.errorMessageString(["args-out-of-range", "abc", 7]), e8.errorMessageString(["user-error", "Nope %s"]), e8.errorMessageString(["quit"])];"#), r#"["Args out of range: \"abc\", 7","Nope %s","Quit"]"#);
    assert_eq!(r(r#"try { e8.signal("search-failed", "Search failed: \"x\"", ["x"]); } catch (e: any) { return e8.errorMessageString(e); }"#), r#""Search failed: \"x\"""#);
    assert_eq!(r(r#"return [e8.commandp("forward-char"), e8.commandp("car"), e8.commandp(["a", "b"])];"#), "[true,false,true]");
    // (21 21), then 21.
    r(r#"e8.addHook("my-hook", (x: number) => x * 2); globalThis.second = (x: number) => x; e8.addHook("my-hook", globalThis.second, { append: true });"#);
    assert_eq!(r(r#"const seen: e8.Value[] = []; e8.runHookWrapped("my-hook", (f: e8.Value, a: e8.Value) => { seen.push(a); return null; }, 21); return seen;"#), "[21,21]");
    assert_eq!(r(r#"return e8.runHookWrapped("my-hook", (f: e8.Value, a: e8.Value) => (f === globalThis.second ? a : null), 21);"#), "21");
    assert_eq!(r(r#"return [e8.locateFileInternal("ls", ["/bin", "/usr/bin"]), e8.locateFileInternal("nonexist", ["/bin"]) ?? null, e8.locateFileInternal("l", ["/bin"], ["s", "x"])];"#), r#"["/bin/ls",null,"/bin/ls"]"#);
}
