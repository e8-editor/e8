//! Syntax tables for scripts, under Emacs's names: the standard table,
//! copies, raw descriptors, and the forms a syntax-table property takes,
//! checked against what Emacs 30.2 gives. Syntax tables are named.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn descriptors_become_emacs_s_raw_syntax() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.stringToSyntax("()"), e8.stringToSyntax(". 124b"), e8.stringToSyntax("w"), e8.stringToSyntax("@") ?? null,
          e8.stringToSyntax("\""), e8.stringToSyntax("< b"), e8.stringToSyntax("_ p"), e8.syntaxClassToChar(4),
          e8.conditionCase(() => e8.stringToSyntax("z"), { error: () => "error" }),
          e8.conditionCase(() => e8.syntaxClassToChar(-1), { "args-out-of-range": () => "out of range" })])"#,
    );
    // Emacs: (4 . 41) (2818049) (2) nil (7) (2097163) (1048579) 40
    assert_eq!(got, r#"[[4,")"],[2818049,null],[2,null],null,[7,null],[2097163,null],[1048579,null],"(","error","out of range"]"#);
}

#[test]
fn the_standard_table_and_copies_of_tables() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.std = e8.standardSyntaxTable(), globalThis.copy = e8.copySyntaxTable(),
          globalThis.text = e8.copySyntaxTable("text-mode-syntax-table"),
          e8.modifySyntaxEntry("'", "w", copy), e8.modifySyntaxEntry("'", ".", text),
          JSON.stringify([e8.syntaxTableP(std), e8.syntaxTableP(copy), e8.syntaxTableP("no-such-table"), e8.syntaxTableP(1),
            e8.syntaxEntry("'"), (e8.setSyntaxTable(copy), e8.syntaxEntry("'")),
            (e8.setSyntaxTable("text-mode-syntax-table"), e8.syntaxEntry("'")), (e8.setSyntaxTable(text), e8.syntaxEntry("'")),
            copy !== e8.copySyntaxTable()]))"#,
    );
    // Emacs: t t nil nil; ' is "." in the standard table, "w" in its modified copy; text-mode's stays "w p"
    assert_eq!(got, r#"[true,true,false,false,".","w","w p",".",true]"#);
}

#[test]
fn a_syntax_table_property_can_be_raw_syntax_or_a_table() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("a'b c"), e8.setVariable("parse-sexp-lookup-properties", true),
          globalThis.sexp = () => (e8.gotoChar(0), e8.call("forward-sexp"), e8.point() + 1),
          globalThis.table = e8.copySyntaxTable(), e8.modifySyntaxEntry("'", "w", table),
          JSON.stringify([sexp(),
            (e8.putTextProperty(1, 2, "syntax-table", e8.stringToSyntax("w")), sexp()),
            (e8.putTextProperty(1, 2, "syntax-table", table), sexp()),
            (e8.putTextProperty(1, 2, "syntax-table", "."), sexp()),
            (e8.putTextProperty(1, 2, "syntax-table", [258]), sexp())]))"#,
    );
    // Emacs: 2, then 4 with raw word syntax or a table that makes it a word, and 258's class is word, its bits 8 to 15 ignored
    assert_eq!(got, "[2,4,4,2,4]");
}
