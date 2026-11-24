//! TODO dependencies where the Emacs oracle cannot show them: a blocked
//! change signals when typed, where batch Emacs, whose
//! called-interactively-p is always nil, only says so; and functions of
//! one's own on org-blocker-hook and org-trigger-hook.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str, enforce: bool) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_default("org-enforce-todo-dependencies", Value::Bool(enforce));
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// Typed, a blocked change signals with the heading that blocks it, as org-todo's user-error.
#[test]
fn a_typed_change_signals() {
    let (mut ed, _s) = org("* TODO Parent\n** TODO child\n", true);
    ed.press("C-c C-t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("TODO state change from TODO to DONE blocked (by \"TODO child\")".into()));
    assert_eq!(text(&ed), "* TODO Parent\n** TODO child\n");
}

/// The option read when Org mode starts decides, as org-mode puts the check on the hook then.
#[test]
fn the_option_counts_when_the_mode_starts() {
    let (mut ed, _s) = org("* TODO Parent\n** TODO child\n", false);
    ed.set_default("org-enforce-todo-dependencies", Value::Bool(true));
    ed.press("C-c C-t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* DONE Parent\n** TODO child\n");
}

/// A function of one's own on org-blocker-hook blocks, and org-trigger-hook
/// is given the change after it, with where and from what to what.
#[test]
fn hooks_of_ones_own() {
    let (mut ed, s) = org("* TODO A\n* TODO B\n", false);
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        e8.addHook("org-blocker-hook", (change: e8.Value[]) => !e8.lineText(e8.lineOf(e8.point())).includes("B"));
        e8.addHook("org-trigger-hook", (change: e8.Value[]) => { globalThis.seen.push(JSON.stringify(change.map((x) => (typeof x === "symbol" ? `'${e8.symbolName(x)}` : x)))); });
        e8.defineCommand({ name: "test-seen", run: () => e8.message(globalThis.seen.join(" ")) });
        "#
        .to_string(),
    )
    .unwrap();
    ed.press("C-c C-t").unwrap();
    ed.press("C-n C-c C-t").unwrap();
    assert!(ed.take_error().is_some(), "B is blocked");
    assert_eq!(text(&ed), "* DONE A\n* TODO B\n");
    ed.call("test-seen", vec![]).unwrap();
    // Org's property list, its keys and type symbols, the states strings.
    assert_eq!(ed.echo(), Some(r#"["':type","'todo-state-change","':from","TODO","':to","DONE","':position",0]"#));
}

/// org-todo-keywords as Org writes it, each list led by sequence or type:
/// the word is no keyword, and a type goes to the done keyword, or with
/// C-c C-t again to the next type.
#[test]
fn keyword_lists_led_by_sequence_or_type() {
    for (lists, keys, after) in [
        (r#"[["type", "A", "B", "|", "Z"]]"#, "C-c C-t", "* Z task\n"),
        (r#"[["type", "A", "B", "|", "Z"]]"#, "C-c C-t C-c C-t", "* task\n"),
        (r#"[["sequence", "T", "|", "D"]]"#, "C-c C-t", "* D task\n"),
        // priority reads as a type, as Org's interpretation is type-like for it.
        (r#"[["priority", "A", "B", "|", "Z"]]"#, "C-c C-t", "* Z task\n"),
        // A list of its own with no kind is keywords all (deliberate), as configs have it.
        (r#"[["A", "B", "|", "Z"]]"#, "C-c C-t", "* B task\n"),
    ] {
        let mut ed = Editor::new();
        let s = Scripting::new(&mut ed).unwrap();
        s.eval_expression(&mut ed, &format!("e8.setDefault('org-todo-keywords', {lists})")).unwrap();
        let first = if lists.contains("sequence") { "T" } else { "A" };
        ed.window_buffer_mut().set_text(&format!("* {first} task\n"));
        ed.call("org-mode", vec![]).unwrap();
        ed.window_buffer_mut().set_point(2);
        ed.press(keys).unwrap();
        assert_eq!(text(&ed), after, "{lists} {keys}");
    }
}

/// A flat org-todo-keywords is keywords all, a leading "type" one of them,
/// read as types when the old org-todo-interpretation says type.
#[test]
fn flat_keyword_lists() {
    for (interpretation, list, before, after) in [
        ("sequence", r#"["type", "A", "|", "Z"]"#, "* type task\n", "* A task\n"),
        ("type", r#"["A", "B", "|", "Z"]"#, "* A task\n", "* Z task\n"),
    ] {
        let mut ed = Editor::new();
        let s = Scripting::new(&mut ed).unwrap();
        s.eval_expression(&mut ed, &format!("(e8.setDefault('org-todo-keywords', {list}), e8.setDefault('org-todo-interpretation', {interpretation:?}))")).unwrap();
        ed.window_buffer_mut().set_text(before);
        ed.call("org-mode", vec![]).unwrap();
        ed.window_buffer_mut().set_point(2);
        ed.press("C-c C-t").unwrap();
        assert_eq!(text(&ed), after, "{interpretation} {list}");
    }
}

/// A check of one's own reads Org's property list as Lisp would: the type
/// a symbol, the states strings, or the symbols todo and done when
/// org-entry-blocked-p asks whether an entry could be done.
#[test]
fn a_check_reads_orgs_property_list() {
    let (mut ed, s) = org("* TODO A\n", false);
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        const name = (x: e8.Value) => (typeof x === "symbol" ? `'${e8.symbolName(x)}` : String(x));
        const get = (plist: e8.Value[], key: string) => plist[plist.findIndex((k) => typeof k === "symbol" && e8.symbolName(k) === key) + 1];
        e8.addHook("org-blocker-hook", (change: e8.Value[]) => {
          globalThis.seen.push([":type", ":from", ":to"].map((k) => name(get(change, k))).join(" "));
          return true;
        });
        e8.defineCommand({ name: "test-seen", run: () => e8.message(globalThis.seen.join(" / ")) });
        "#
        .to_string(),
    )
    .unwrap();
    s.eval_expression(&mut ed, "e8.funcall('org-entry-blocked-p')").unwrap();
    ed.press("C-c C-t").unwrap();
    ed.call("test-seen", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("'todo-state-change 'todo 'done / 'todo-state-change TODO DONE"));
}
