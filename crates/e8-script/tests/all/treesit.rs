//! Tree-sitter highlighting and the modes that use it.

use e8_core::{Editor, palette};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// The colour of the first segment of the first row whose text is `text`.
fn color_of(ed: &Editor, text: &str) -> Option<e8_core::Color> {
    ed.window_rows(20, true)
        .iter()
        .flat_map(|r| r.segments.iter())
        .find(|s| s.text == text)
        .unwrap_or_else(|| panic!("no segment {text:?} in {:?}", ed.window_rows(20, true)))
        .style
        .foreground
}

#[test]
fn visiting_a_rust_file_highlights_it() {
    let (mut ed, _scripting) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("main.rs");
    std::fs::write(&file, "fn main() {\n    let s = \"hi\"; // note\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Rust");
    assert_eq!(ed.buffer_language(), Some("rust"));
    assert_eq!(color_of(&ed, "fn"), palette("accent-ink", true), "keywords");
    assert_eq!(color_of(&ed, "\"hi\""), palette("good", true), "strings");
    let rows = ed.window_rows(20, true);
    let comment = rows[1].segments.iter().find(|s| s.text == "// note").unwrap();
    assert!(comment.style.italic, "comments");
}

#[test]
fn edits_update_the_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("let x = 1;\n");
    ed.call("rust-ts-mode", vec![]).unwrap();
    assert_eq!(color_of(&ed, "1"), palette("bad", true), "numbers");
    // Replacing the number with a string highlights the string.
    ed.press("M-< C-u 9 C-f DEL").unwrap();
    ed.type_text("\"one\"");
    assert_eq!(color_of(&ed, "\"one\""), palette("good", true));
    // Undo takes it back.
    ed.press("C-/").unwrap();
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), "let x = ;\n");
    assert!(ed.window_rows(1, true)[0].segments.iter().all(|s| !s.text.contains('"')));
}

#[test]
fn leaving_the_mode_stops_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("{\"a\": 1}");
    ed.call("json-ts-mode", vec![]).unwrap();
    assert_eq!(ed.mode_name(), "JSON");
    assert!(ed.window_rows(1, true)[0].segments.len() > 1);
    ed.call("fundamental-mode", vec![]).unwrap();
    assert_eq!(ed.buffer_language(), None);
    assert_eq!(ed.window_rows(1, true)[0].segments.len(), 1);
}

#[test]
fn scripts_can_ask_about_nodes() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("def f(x):\n    return x\n");
    ed.call("python-ts-mode", vec![]).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            import("treesit").then(({ nodeAt }) => {
              const node = nodeAt(4)!;
              e8.message(`${e8.treesitNodeType(node)} ${e8.treesitNodeStart(node)} ${e8.treesitNodeEnd(node)} ${e8.treesitLanguage()} ${e8.treesitLanguageAvailable("rust")}`);
            });
            "#
            .to_string(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("identifier 4 5 python true"));
}

#[test]
fn prog_mode_hook_runs_for_programming_modes() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"e8.addHook("prog-mode-hook", () => e8.message("programming"));"#.to_string(),
        )
        .unwrap();
    ed.call("python-ts-mode", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("programming"));
}

/// Runs TypeScript with treesit.ts's functions as `t`, and gives what it
/// leaves in `globalThis.result`, as JSON.
fn with_treesit(ed: &mut Editor, scripting: &Scripting, code: &str) -> String {
    scripting
        .eval_typescript(ed, "test.ts", format!("import(\"treesit\").then((t: any) => {{ globalThis.result = JSON.stringify((() => {{ {code} }})()); }});"))
        .unwrap();
    let got = scripting.eval_expression(ed, "globalThis.result").unwrap();
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

const RUST: &str = "fn main() {\n    let x = 1;\n    foo(x, 2);\n}\n\nfn other() {}\n";

#[test]
fn nodes_as_emacs_gives_them() {
    // Emacs 30.2 on the same text, its positions counting from 1.
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = e8.treesitParserCreate("rust");
        const root = e8.treesitParserRootNode(p);
        const fn = e8.treesitNodeChild(root, 0)!;
        const body = e8.treesitNodeChildByFieldName(fn, "body")!;
        const type = e8.treesitNodeType;
        return [type(root), e8.treesitNodeStart(root), e8.treesitNodeEnd(root), e8.treesitNodeChildCount(root),
          e8.treesitNodeChildCount(fn), e8.treesitNodeChildCount(fn, true), type(fn), type(e8.treesitNodeChild(fn, -1)),
          type(e8.treesitNodeChild(fn, 0)), type(e8.treesitNodeChild(fn, 0, true)), e8.treesitNodeFieldNameForChild(fn, 1),
          e8.treesitNodeFieldNameForChild(fn, 0) ?? null, type(e8.treesitNodeNextSibling(fn)), type(e8.treesitNodeNextSibling(fn, true)),
          type(e8.treesitNodePrevSibling(e8.treesitNodeChild(root, 1))), type(e8.treesitNodeParent(body)),
          type(e8.treesitNodeFirstChildForPos(body, 19)), type(e8.treesitNodeFirstChildForPos(body, 19, true)),
          type(e8.treesitNodeDescendantForRange(root, 19, 20)), type(e8.treesitNodeDescendantForRange(root, 19, 20, true)),
          e8.treesitNodeString(e8.treesitNodeChild(root, 1)), e8.treesitNodeEq(e8.treesitNodeParent(body), fn),
          type(t.nodeAt(20)), type(t.nodeAt(11)), type(t.nodeAt(11, undefined, true)), e8.treesitNodeStart(t.nodeAt(44)),
          type(t.nodeOn(16, 26)), t.nodeText(e8.treesitNodeChildByFieldName(fn, "name"), true),
          e8.treesitNodeCheck(fn, "named"), e8.treesitNodeCheck(e8.treesitNodeChild(fn, 0)!, "named"), e8.treesitNodeCheck(fn, "has-error")];
        "#,
    );
    // Emacs: ("source_file" 1 60 2 4 3 "function_item" "block" "fn" "identifier" "name" nil "function_item" ...)
    assert_eq!(
        got,
        r#"["source_file",0,59,2,4,3,"function_item","block","fn","identifier","name",null,"function_item","function_item","function_item","function_item","let_declaration","let_declaration","let_declaration","let_declaration","(function_item name: (identifier) parameters: (parameters) body: (block))",true,"identifier","{","identifier",45,"let_declaration","main",true,false,false]"#
    );
}

#[test]
fn queries_and_searches_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    s.eval_typescript(&mut ed, "pred.ts", r#"e8.defun("long-name-p", (n: e8.TreesitNode) => e8.treesitNodeEnd(n)! - e8.treesitNodeStart(n)! > 3);"#.into()).unwrap();
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const root = e8.treesitParserRootNode(e8.treesitParserCreate("rust"));
        const fn = e8.treesitNodeChild(root, 0)!;
        const text = (n: any) => (n === undefined ? null : t.nodeText(n, true));
        const pairs = (cs: [string, e8.TreesitNode][]) => cs.map(([name, n]) => [name, text(n)]);
        return [
          pairs(e8.treesitQueryCapture(root, "(function_item name: (identifier) @name) (call_expression function: (identifier) @call)")),
          pairs(e8.treesitQueryCapture(root, "(call_expression function: (identifier) @f arguments: (arguments (integer_literal) @n))", 14, 39)),
          e8.treesitQueryCapture("rust", "(integer_literal) @n", null, null, true).map(text),
          e8.treesitNodeType(t.searchForward(t.nodeAt(20), "identifier")), text(t.searchForward(t.nodeAt(20), "identifier")),
          text(t.searchForward(t.nodeAt(20), "identifier", true)), e8.treesitNodeType(t.searchForward(t.nodeAt(20), "block")),
          text(t.searchSubtree(fn, "integer_literal")), text(t.searchSubtree(fn, "integer_literal", true)),
          e8.treesitNodeType(t.searchSubtree(fn, "integer_literal", false, false, 2)) ?? null,
          // Emacs's predicates, which its string queries write as tree-sitter's.
          e8.treesitQueryCapture(root, '((identifier) @id (#match "^o" @id))', null, null, true).map(text),
          e8.treesitQueryCapture(root, '((identifier) @id (#equal @id "x"))', null, null, true).map(text),
          e8.treesitQueryCapture(root, '((identifier) @id (#pred long-name-p @id))', null, null, true).map(text),
          e8.treesitQueryCapture(root, "(let_declaration pattern: (_) @p value: (_) @v)", null, null, false, true).map(pairs),
        ];
        "#,
    );
    // Emacs: ((name . "main") (call . "foo") (name . "other")) ((f . "foo") (n . "2")) ("1" "2")
    //        ("identifier" "foo" "main" "block" "1" "2" nil)
    assert_eq!(
        got,
        r#"[[["name","main"],["call","foo"],["name","other"]],[["f","foo"],["n","2"]],["1","2"],"identifier","foo","main","block","1","2",null,["other"],["x","x"],["main","other"],[[["p","x"],["v","1"]]]]"#
    );
}

#[test]
fn parsers_and_nodes_out_of_date() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = e8.treesitParserCreate("rust");
        const root = e8.treesitParserRootNode(p);
        const counts = [e8.treesitParserList().length, e8.treesitParserCreate("rust") === p, e8.treesitParserCreate("rust", null, true) === p,
          e8.treesitParserList().length, (e8.treesitParserCreate("rust", null, false, "mine"), e8.treesitParserList().length),
          e8.treesitParserList(null, null, true).length, e8.treesitParserList(null, "rust", "mine").length,
          e8.treesitParserLanguage(p), e8.treesitParserTag(p) ?? null];
        const old = e8.treesitNodeChild(root, 0)!;
        e8.gotoChar(0);
        e8.insert("// c\n");
        // Out of date only once the tree is parsed again, as Emacs's.
        const before = [e8.treesitNodeCheck(old, "outdated"), e8.treesitNodeCheck(old, "live"), e8.treesitNodeType(old)];
        const now = e8.treesitNodeType(e8.treesitNodeChild(e8.treesitParserRootNode(p), 0));
        const after = [e8.treesitNodeCheck(old, "outdated"), e8.conditionCase(() => e8.treesitNodeType(old), { "treesit-node-outdated": () => "outdated" })];
        e8.treesitParserDelete(p);
        return [...counts, ...before, now, ...after, e8.treesitNodeCheck(old, "live"), e8.treesitParserList(null, null, true).length];
        "#,
    );
    // Emacs: (1 t nil 2 2 3 1 rust nil) (nil t "function_item" "line_comment")
    assert_eq!(got, r#"[1,true,false,2,2,3,1,"rust",null,false,true,"function_item","line_comment",true,"outdated",false,2]"#);
}

#[test]
fn predicates_searches_and_sparse_trees_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    s.eval_typescript(&mut ed, "pred.ts", r#"e8.defun("long-p", (n: e8.TreesitNode) => e8.treesitNodeEnd(n)! - e8.treesitNodeStart(n)! > 3);"#.into()).unwrap();
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = e8.treesitParserCreate("rust");
        const root = e8.treesitParserRootNode(p);
        const fn = e8.treesitNodeChild(root, 0)!;
        const text = (n: any) => (n === undefined ? null : t.nodeText(n, true));
        const type = (n: any) => (n === undefined ? null : e8.treesitNodeType(n));
        const types = (tree: any): any => (tree === undefined || tree === null ? null : typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(types) : e8.treesitNodeType(tree));
        const caught = (f: () => unknown) => e8.conditionCase(f, { "treesit-predicate-not-found": () => "not-found", "treesit-invalid-predicate": () => "invalid" });
        e8.setVariable("treesit-thing-settings", [["rust", [["defun", "function_item"], ["num", "integer_literal"],
          ["both", ["or", "integer_literal", "identifier"]], ["notid", ["not", "identifier"]], ["bad", 3]]]] as any);
        const at = t.nodeAt(15);
        return [
          e8.treesitNodeMatchP(fn, "function"), e8.treesitNodeMatchP(fn, Symbol.for("defun")), e8.treesitNodeMatchP(fn, Symbol.for("nosuch"), true),
          caught(() => e8.treesitNodeMatchP(fn, Symbol.for("nosuch"))), caught(() => e8.treesitNodeMatchP(fn, [Symbol.for("foo"), Symbol.for("bar")])),
          caught(() => e8.treesitNodeMatchP(fn, Symbol.for("bad"), true)), e8.treesitNodeMatchP(fn, ["not", "identifier"]),
          e8.treesitNodeMatchP(fn, ["function", Symbol.for("long-p")]), e8.treesitNodeMatchP(undefined, "x"),
          text(e8.treesitSearchSubtree(root, Symbol.for("num"))), text(e8.treesitSearchSubtree(root, Symbol.for("num"), true)),
          type(e8.treesitSearchSubtree(root, Symbol.for("nosuch"))), type(e8.treesitSearchSubtree(root, "block", false, false, 1)),
          type(e8.treesitSearchSubtree(root, "block", false, false, 2)),
          text(e8.treesitSearchForward(at, Symbol.for("both"))), text(e8.treesitSearchForward(at, Symbol.for("both"), true)),
          type(e8.treesitSearchForward(at, "(", false, true)), type(e8.treesitSearchForward(at, "(", true, true)),
          type(e8.treesitSearchForward(at, "(")),
          types(e8.treesitInduceSparseTree(root, Symbol.for("defun"))),
          types(e8.treesitInduceSparseTree(root, Symbol.for("both"), (n) => e8.treesitNodeType(n), 4)),
          types(e8.treesitInduceSparseTree(root, "source_file\\|block", null, 2)),
          types(e8.treesitInduceSparseTree(root, "nosuch")),
          e8.treesitSubtreeStat(root), e8.treesitSubtreeStat(fn),
          // treesit.ts's functions are these.
          text(t.searchSubtree(root, Symbol.for("num"))), types(t.induceSparseTree(root, Symbol.for("defun"))),
        ];
        "#,
    );
    // Emacs 30.2: (t t nil treesit-predicate-not-found treesit-invalid-predicate treesit-invalid-predicate t t nil
    //  "1" "2" nil nil "block" "x" "main" "(" "(" nil (nil ("function_item") ("function_item"))
    //  (nil ("identifier") ("identifier") ("integer_literal") ("identifier")) (nil ("source_file" ("block") ("block"))) nil
    //  (6 5 35) (5 5 25))
    assert_eq!(
        got,
        r#"[true,true,false,"not-found","invalid","invalid",true,true,false,"1","2",null,null,"block","x","main","(","(",null,[null,["function_item"],["function_item"]],[null,["identifier"],["identifier"],["integer_literal"],["identifier"]],[null,["source_file",["block"],["block"]]],null,[6,5,35],[5,5,25],"1",[null,["function_item"],["function_item"]]]"#
    );
}

#[test]
fn queries_as_objects_and_lisp_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const root = e8.treesitParserRootNode(e8.treesitParserCreate("rust"));
        const text = (n: any) => t.nodeText(n, true);
        const S = Symbol.for;
        const q = e8.treesitQueryCompile("rust", "(integer_literal) @n");
        return [
          e8.treesitQueryP("x"), e8.treesitQueryP([[S("identifier")], S("@i")]), e8.treesitQueryP(3),
          [e8.treesitCompiledQueryP(q), e8.treesitQueryLanguage(q), e8.treesitQueryCapture(root, q, null, null, true).map(text)],
          e8.treesitQueryCompile("rust", q) === q,
          e8.conditionCase(() => e8.treesitQueryCompile("rust", "(nosuch) @n", true), { "treesit-query-error": () => "treesit-query-error" }),
          e8.treesitCompiledQueryP(e8.treesitQueryCompile("rust", "(nosuch) @n")),
          e8.treesitQueryExpand([[S("function_item"), S("name:"), [S("identifier")], S("@name")], [S("["), [S("integer_literal")], "fn"],
            S(":anchor"), [S("_")], [[S("identifier")], S("@id"), [S(":match"), "^f", S("@id")]]]),
          e8.treesitPatternExpand(S(":*")), e8.treesitPatternExpand('a"b\n'),
          e8.treesitQueryCapture(root, [[[S("identifier")], S("@id"), [S(":match"), "^o", S("@id")]]], null, null, true).map(text),
          e8.treesitLibraryAbiVersion(), e8.treesitLibraryAbiVersion(true), e8.treesitLanguageAbiVersion("rust"),
          e8.treesitLanguageAbiVersion("nosuch") ?? null,
        ];
        "#,
    );
    // Emacs 30.2: (t t nil (t rust ("1" "2")) treesit-query-error t
    //  "(function_item name: (identifier) @name) [(integer_literal) \"fn\"] . (_) ((identifier) @id (#match \"^f\" @id))"
    //  "*" "\"a\\\"b\\n\"" ("other") 15 13 14 nil); the Rust grammar E8 compiles in is ABI 15, Emacs's installed one 14.
    assert_eq!(
        got,
        r#"[true,true,false,[true,"rust",["1","2"]],true,"treesit-query-error",true,"(function_item name: (identifier) @name) [(integer_literal) \"fn\"] . (_) ((identifier) @id (#match \"^f\" @id))","*","\"a\\\"b\\n\"",["other"],15,13,15,null]"#
    );
}

#[test]
fn included_ranges_and_notifiers_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("x [1, 2] y {\"a\": 3} z");
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = e8.treesitParserCreate("json");
        e8.treesitParserSetIncludedRanges(p, [[2, 8], [11, 19]]);
        const invalid = (ranges: any) => e8.conditionCase(() => e8.treesitParserSetIncludedRanges(p, ranges), { "treesit-range-invalid": () => "treesit-range-invalid" });
        return [e8.treesitParserIncludedRanges(p), e8.treesitNodeString(e8.treesitParserRootNode(p)), invalid([[4, 8], [2, 3]]), invalid([[2, 98]]),
          (e8.treesitParserSetIncludedRanges(p, null), e8.treesitParserIncludedRanges(p) ?? null), e8.treesitNodeType(e8.treesitParserRootNode(p))];
        "#,
    );
    // Emacs 30.2: (((3 . 9) (12 . 20)) "(document (array (number) (number)) (object (pair ...)))" treesit-range-invalid treesit-range-invalid nil "document")
    assert_eq!(
        got,
        r#"[[[2,8],[11,19]],"(document (array (number) (number)) (object (pair key: (string (string_content)) value: (number))))","treesit-range-invalid","treesit-range-invalid",null,"document"]"#
    );

    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("fn main() {}\n");
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const seen: unknown[] = [];
        e8.defun("probe-note", (ranges: unknown) => { seen.push(ranges); });
        e8.defun("probe-ignore", () => {});
        const p = e8.treesitParserCreate("rust");
        e8.treesitParserAddNotifier(p, "probe-note");
        e8.treesitParserAddNotifier(p, "probe-note");
        e8.treesitParserAddNotifier(p, Symbol.for("probe-ignore"));
        const names = () => e8.treesitParserNotifiers(p).map((f) => f.description);
        const before = names();
        e8.treesitParserRootNode(p);
        e8.gotoChar(e8.pointMax());
        e8.insert("fn z() {}\n");
        e8.treesitParserRootNode(p);
        e8.treesitParserRemoveNotifier(p, "probe-ignore");
        return [before, names(), seen];
        "#,
    );
    // Emacs 30.2: (probe-note ignore) ((probe-note) (((1 . 14)) ((14 . 23))))
    assert_eq!(got, r#"[["probe-note","probe-ignore"],["probe-note"],[[[0,13]],[[13,22]]]]"#);
}

/// Each run of the same style in the first rows, with its text.
fn face_runs(ed: &mut Editor) -> Vec<(String, e8_core::Style)> {
    ed.redisplay();
    ed.window_rows(20, true).iter().flat_map(|r| r.segments.iter()).map(|s| (s.text.clone(), s.style.clone())).collect()
}

/// The style a face draws in.
fn style(ed: &Editor, face: &str) -> e8_core::Style {
    ed.style_for(&[face.to_string()], true)
}

#[test]
fn font_lock_rules_highlight_in_place_of_the_grammars_query() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("{\"a\": 1, \"b\": true}");
    ed.call("json-ts-mode", vec![]).unwrap();
    // The rules' order and overrides decide, as treesit-font-lock-fontify-region's do:
    // the first rule's face stays where nil overrides, the third's goes over it with t.
    s.eval_expression(
        &mut ed,
        r#"e8.treesitSetFontLockRules("json", [
            ["(pair key: (_) @font-lock-keyword-face)", null],
            ["(pair) @font-lock-warning-face", null],
            ["(true) @font-lock-builtin-face", "t"],
            ["(number) @font-lock-type-face", null]])"#,
    )
    .unwrap();
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    assert_eq!(style_of("\"a\""), style(&ed, "font-lock-keyword-face"));
    // A pair whose key has a face already keeps it, rather than taking the second rule's.
    assert!(!runs.iter().any(|(_, f)| *f == style(&ed, "font-lock-warning-face")), "{runs:?}");
    assert_eq!(style_of("true"), style(&ed, "font-lock-builtin-face"));
    assert_eq!(style_of("1"), style(&ed, "font-lock-type-face"));
}

#[test]
fn a_mode_without_its_grammar_warns_and_stays_plain() {
    let (mut ed, _s) = setup();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("user-emacs-directory", e8_core::Value::Str(format!("{}/", dir.path().display())));
    ed.call("go-ts-mode", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("Cannot activate tree-sitter, because language grammar for go is unavailable"));
    assert_eq!(ed.buffer_language(), None);
}

/// Go's grammar as Emacs's treesit-install-language-grammar builds it, if
/// this machine has one: E8 does not ship it.
fn go_grammar() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("HOME")?).join(".emacs.d/tree-sitter");
    dir.join("libtree-sitter-go.dylib").exists().then_some(dir)
}

#[test]
fn go_ts_mode_loads_its_grammar_and_highlights_with_its_rules() {
    let Some(grammars) = go_grammar() else {
        eprintln!("No libtree-sitter-go in ~/.emacs.d/tree-sitter: skipped");
        return;
    };
    let (mut ed, _s) = setup();
    ed.set_variable("treesit-extra-load-path", e8_core::Value::List(vec![e8_core::Value::Str(grammars.display().to_string())]));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("main.go");
    std::fs::write(&file, "package main\n\nfunc main() {\n\tx := len(\"hi\")\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Go");
    assert_eq!(ed.buffer_language(), Some("go"));
    assert_eq!(ed.variable("indent-tabs-mode"), Some(e8_core::Value::Bool(true)));
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    assert_eq!(style_of("package"), style(&ed, "font-lock-keyword-face"));
    assert_eq!(style_of("\"hi\""), style(&ed, "font-lock-string-face"));
    assert_eq!(style_of("len"), style(&ed, "font-lock-builtin-face"));
    assert_eq!(style_of("func"), style(&ed, "font-lock-keyword-face"));
    // Indenting by Emacs's rules: a block's statements one tab in.
    ed.press("M-< C-n C-n C-n TAB").unwrap();
    assert_eq!(ed.window_buffer().line_text(3), "\tx := len(\"hi\")");
    // Imenu from treesit-simple-imenu-settings, and C-M-a by defuns.
    ed.press("C-M-a").unwrap();
    assert_eq!(ed.window_buffer().point(), 14);
}

#[test]
fn bash_ts_mode_highlights_and_indents_as_emacs_does() {
    let Some(grammars) = go_grammar().filter(|d| d.join("libtree-sitter-bash.dylib").exists()) else {
        eprintln!("No libtree-sitter-bash in ~/.emacs.d/tree-sitter: skipped");
        return;
    };
    let (mut ed, _s) = setup();
    ed.set_variable("treesit-extra-load-path", e8_core::Value::List(vec![e8_core::Value::Str(grammars.display().to_string())]));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.sh");
    std::fs::write(&file, "#!/bin/bash\n# Note\nf() {\n  local x=1\n  if [ \"$x\" = 2 ]; then\n    echo \"hi $HOME\" $(date) | grep h\n  fi\n  return 0\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Bash");
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    // As Emacs 30's bash-ts-mode fontifies it at the default level.
    for (text, face) in [
        ("#!/bin/bash", "font-lock-comment-face"),
        ("f", "font-lock-function-name-face"),
        ("local", "font-lock-keyword-face"),
        ("x", "font-lock-variable-name-face"),
        ("if", "font-lock-keyword-face"),
        ("\"$x\"", "font-lock-string-face"),
        ("echo", "font-lock-function-name-face"),
        ("$(date)", "sh-quoted-exec"),
        ("grep", "font-lock-function-name-face"),
        ("fi", "font-lock-keyword-face"),
        ("return", "font-lock-keyword-face"),
    ] {
        assert_eq!(style_of(text), style(&ed, face), "{text}");
    }
    // Emacs's indentation, with tabs for each eight columns.
    ed.window_buffer_mut().set_text("f() {\nlocal x=1\nif [ 1 ]; then\necho a\nfi\nfor i in 1 2; do\necho $i\ndone\n}\n");
    ed.press("C-x h C-M-\\").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "f() {\n    local x=1\n    if [ 1 ]; then\n\techo a\n    fi\n    for i in 1 2; do\n\techo $i\n    done\n}\n");
}
