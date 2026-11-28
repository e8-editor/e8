//! Org's inline tasks, org-inlinetask.ts, where the Emacs oracle does not
//! look: their faces, org-indent-mode's prefixes for them, and the
//! library's functions. Each expected value is what Emacs 30's Org 9.7
//! gives on the same text with (require 'org-inlinetask), from a batch
//! script asking for it.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TEXT: &str = "* Heading\n*************** TODO Task :tag:\nbody\n*************** END\nText.\n";

/// An Org buffer holding `text`, with org-inlinetask loaded and `setup` run before Org mode starts.
fn org(text: &str, setup: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "setup.ts", format!("e8.require(\"org-inlinetask\");\n{setup}")).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.redisplay();
    (ed, s)
}

fn json(v: &Value) -> String {
    match v {
        Value::Str(s) | Value::Symbol(s) => format!("{s:?}"),
        // A propertized string, as a prefix is, by its text.
        Value::Text(t) => format!("{:?}", t.string),
        Value::List(items) => format!("[{}]", items.iter().map(json).collect::<Vec<_>>().join(",")),
        other => format!("{other:?}"),
    }
}

/// A text property at a position, as JSON, or "" for none.
fn prop(ed: &Editor, pos: usize, name: &str) -> String {
    ed.window_buffer().text_property(pos, name).map(json).unwrap_or_default()
}

/// What TypeScript returns, run in the editor, as JSON.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "run.ts", format!("globalThis.result = JSON.stringify((() => {{ {code} }})() ?? null);")).unwrap();
    serde_json::from_str(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

/// All stars but the last two are hidden, the rest of the line is in the
/// org-inlinetask face, under the keyword's and tags' faces, as
/// org-inlinetask-fontify gives them from org-font-lock-hook.
#[test]
fn an_inline_task_shows_its_last_two_stars() {
    let (ed, _s) = org(TEXT, "");
    for p in [10, 11, 22] {
        assert_eq!(prop(&ed, p, "face"), r#""org-hide""#, "star at {p}");
    }
    for p in [23, 24, 25, 31] {
        assert_eq!(prop(&ed, p, "face"), r#""org-inlinetask""#, "at {p}");
    }
    assert_eq!(prop(&ed, 26, "face"), r#"["org-todo","org-inlinetask"]"#);
    assert_eq!(prop(&ed, 36, "face"), r#"["org-tag","org-inlinetask"]"#);
    assert_eq!(prop(&ed, 42, "face"), "");
    // The END line likewise.
    assert_eq!(prop(&ed, 47, "face"), r#""org-hide""#);
    assert_eq!(prop(&ed, 59, "face"), r#""org-hide""#);
    assert_eq!(prop(&ed, 60, "face"), r#""org-inlinetask""#);
    // An ordinary heading keeps its level's face.
    assert_eq!(prop(&ed, 2, "face"), r#""org-level-1""#);
}

/// With org-inlinetask-show-first-star, the first star shows too, in the
/// org-warning face.
#[test]
fn the_first_star_can_show() {
    let (ed, _s) = org(TEXT, r#"e8.setVariable("org-inlinetask-show-first-star", true);"#);
    assert_eq!(prop(&ed, 10, "face"), r#""org-warning""#);
    assert_eq!(prop(&ed, 11, "face"), r#""org-hide""#);
    assert_eq!(prop(&ed, 23, "face"), r#""org-inlinetask""#);
}

/// Without the library, a line of fifteen stars is a heading of level 15.
#[test]
fn without_the_library_it_is_a_heading() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(TEXT);
    ed.call("org-mode", vec![]).unwrap();
    ed.redisplay();
    assert_eq!(prop(&ed, 31, "face"), r#""org-level-7""#);
}

/// org-indent-mode gives an inline task's line the prefix of its stars'
/// level and leaves the text after it at its entry's level, as
/// org-indent-add-properties does.
#[test]
fn org_indent_mode_indents_inline_tasks_as_org_does() {
    let (mut ed, s) = org(TEXT, "");
    ed.call("org-indent-mode", vec![]).unwrap();
    s.eval_typescript(&mut ed, "indent.ts", r#"e8.call("org-indent-indent-buffer");"#.into()).unwrap();
    let stars14 = format!("{:?}", "*".repeat(14));
    let wrap = format!("{:?}", format!("{} ", "*".repeat(29)));
    for p in [10, 41, 47, 66] {
        assert_eq!(prop(&ed, p, "line-prefix"), stars14, "line-prefix at {p}");
        assert_eq!(prop(&ed, p, "wrap-prefix"), wrap, "wrap-prefix at {p}");
    }
    // The body and the text after the task are under level 1.
    assert_eq!(prop(&ed, 42, "line-prefix"), r#""  ""#);
    assert_eq!(prop(&ed, 67, "line-prefix"), r#""  ""#);
    assert_eq!(prop(&ed, 0, "wrap-prefix"), r#""* ""#);
}

/// Where the library's functions find the task around a position, as
/// org-inlinetask-in-task-p, -at-task-p, -end-p, -get-task-level,
/// -goto-end and -goto-beginning do.
#[test]
fn the_task_around_a_position() {
    let (mut ed, s) = org(TEXT, "");
    let got = run(
        &mut ed,
        &s,
        r#"return [0, 10, 41, 46, 66].map((p) => {
  const at = (f: () => unknown) => e8.saveExcursion(() => { e8.gotoChar(p); return f(); });
  const truthy = (v: unknown) => v !== null && v !== undefined && v !== false;
  return [
    p,
    truthy(at(() => e8.funcall("org-inlinetask-in-task-p"))),
    truthy(at(() => e8.funcall("org-inlinetask-at-task-p"))),
    truthy(at(() => e8.funcall("org-inlinetask-end-p"))),
    at(() => e8.funcall("org-inlinetask-goto-end")),
    at(() => { e8.funcall("org-inlinetask-goto-beginning"); return e8.point(); }),
  ];
});"#,
    );
    assert_eq!(
        got,
        "[[0,false,false,false,42,9],[10,true,true,false,67,10],[41,true,true,false,67,10],[46,true,false,false,67,10],[66,true,false,true,67,10]]"
    );
    assert_eq!(run(&mut ed, &s, r#"e8.gotoChar(46); return e8.funcall("org-inlinetask-get-task-level");"#), "15");
    assert_eq!(run(&mut ed, &s, r#"return e8.funcall("org-inlinetask-outline-regexp");"#), r#""^\\(\\*\\{15,\\}\\)[ \t]+""#);
}

/// An END line, and the blank lines before it, go, as org-inlinetask-remove-END-maybe takes them after archiving or refiling.
#[test]
fn an_end_line_is_removed() {
    let (mut ed, s) = org("a\n\n  \n*************** END  \nb\n", "");
    let got = run(&mut ed, &s, r#"e8.gotoChar(2); e8.funcall("org-inlinetask-remove-END-maybe"); return e8.bufferText(0, e8.bufferSize());"#);
    assert_eq!(got, r#""a\n\nb\n""#);
}

/// The task's text folds and unfolds, its heading line left showing, as
/// org-inlinetask-toggle-visibility does, with `fold` and `unfold` as
/// they say whatever it was.
#[test]
fn a_task_folds_and_unfolds() {
    let (mut ed, s) = org(TEXT, "");
    let got = run(
        &mut ed,
        &s,
        r#"e8.gotoChar(10);
const hidden = () => e8.invisibleAt(42);
const out: boolean[] = [];
e8.funcall("org-inlinetask-toggle-visibility"); out.push(hidden(), e8.invisibleAt(41));
e8.funcall("org-inlinetask-toggle-visibility"); out.push(hidden());
e8.funcall("org-inlinetask-toggle-visibility", "unfold"); out.push(hidden());
e8.funcall("org-inlinetask-toggle-visibility", "fold"); e8.funcall("org-inlinetask-toggle-visibility", "fold"); out.push(hidden());
return out;"#,
    );
    assert_eq!(got, "[true,true,false,false,true]");
}

/// C-c C-x t inserts a task, with its END line, point on its heading.
#[test]
fn the_key_inserts_a_task() {
    let (mut ed, _s) = org("* H\ntext\n", "");
    ed.window_buffer_mut().set_point(9);
    ed.press("C-c C-x t").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "* H\ntext\n*************** \n*************** END\n");
    assert_eq!(ed.window_buffer().point(), 25);
}
