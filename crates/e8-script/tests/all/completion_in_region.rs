//! Completing the text at point in the buffer, as Emacs's completion-in-region:
//! what the oracle in tests/emacs/cases/completion-in-region.json cannot
//! show, as styles packages add, how the list is drawn, and when the
//! completions are asked for.

use e8_core::Editor;
use e8_script::Scripting;

/// A buffer holding `text`, point at its end, with a completion function
/// offering `names`, given as a JavaScript expression, for the word at point.
fn completing(text: &str, names: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    ed.window_buffer_mut().set_text(text);
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        format!(
            r#"(globalThis as any).asked = 0;
            e8.addHook("completion-at-point-functions", () => {{
              let start = e8.point();
              while (start > e8.pointMin() && /[-\w]/.test(e8.bufferText(start - 1, start))) start--;
              return [start, e8.point(), {names}];
            }}, {{ local: true }});"#
        ),
    )
    .unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) -> String {
    s.eval_expression(ed, source).unwrap()
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn completions_shown(ed: &Editor) -> bool {
    ed.windows().iter().any(|w| w.buffer.name == "*Completions*")
}

#[test]
fn a_style_a_package_adds_lists_its_matches_and_completes_its_only_one() {
    // A style that matches the input anywhere in a name, as orderless does.
    let (mut ed, s) = completing("bar", r#"["foo-bar", "bar-baz", "qux"]"#);
    s.eval_typescript(
        &mut ed,
        "style.ts",
        r#"import("minibuffer").then(({ defineCompletionStyle }) => {
          defineCompletionStyle("anywhere", {
            doc: "The input anywhere in a name.",
            all: (field) => ({ completions: field.names.filter((n) => n.includes(field.before + field.after)) }),
          });
          e8.setVariable("completion-styles", ["anywhere", "basic"]);
        });"#
            .to_string(),
    )
    .unwrap();
    // Two match, so the text stays and both are listed, though only one starts with it.
    ed.press("C-M-i").unwrap();
    assert_eq!(text(&ed), "bar");
    let list = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#);
    // As JSON: one to a line, as two fill only one column.
    assert!(list.ends_with(r#"2 possible completions:\nbar-baz\nfoo-bar""#), "{list}");
    // One matches: it goes in, whole, and the list goes.
    ed.press("C-a").unwrap();
    ed.press("C-k").unwrap();
    ed.type_text("baz");
    ed.press("C-M-i").unwrap();
    assert_eq!(text(&ed), "bar-baz");
    assert!(!completions_shown(&ed));
}

#[test]
fn the_completions_are_drawn_in_columns() {
    let (mut ed, _s) = completing("", r#"["apple", "apricot", "avocado", "banana", "blueberry", "cherry", "coconut", "date", "elderberry", "fig", "grape", "guava"]"#);
    ed.press("C-M-i").unwrap();
    // Into the list, as a person goes there to read it: it stays.
    ed.press("C-x o").unwrap();
    assert!(completions_shown(&ed));
    ed.redisplay();
    let rows: Vec<String> = ed.window_rows(10, true).iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect()).collect();
    // Six columns 13 wide, as Emacs's completion--insert-horizontal aligns them.
    let row = rows.iter().find(|r| r.starts_with("apple")).unwrap_or_else(|| panic!("{rows:#?}"));
    assert_eq!(row.trim_end(), "apple        apricot      avocado      banana       blueberry    cherry");
}

#[test]
fn m_down_marks_the_completion_it_moves_to() {
    let (mut ed, s) = completing("fooba", r#"["foobar", "foobaz"]"#);
    ed.press("C-M-i").unwrap();
    ed.press("M-<down>").unwrap();
    ed.press("M-<down>").unwrap();
    let marked = eval(
        &mut ed,
        &s,
        r#"e8.withCurrentBuffer("*Completions*", () => {
          const o = e8.overlaysIn(e8.pointMin(), e8.pointMax()).find((o) => e8.overlayGet(o, "face") === "completions-highlight");
          return o === undefined ? "" : e8.bufferText(e8.overlayStart(o), e8.overlayEnd(o));
        })"#,
    );
    assert_eq!(marked, r#""foobaz""#);
    ed.press("M-RET").unwrap();
    assert_eq!(text(&ed), "foobaz");
}

#[test]
fn a_table_that_is_a_function_is_asked_only_when_completing() {
    // As eglot's: the server is asked for completions only when they are needed.
    let (mut ed, s) = completing("fooba", r#"() => { (globalThis as any).asked++; return ["foobar", "foobaz"]; }"#);
    ed.press("C-M-i").unwrap();
    assert!(completions_shown(&ed));
    assert_eq!(eval(&mut ed, &s, "(globalThis as any).asked"), "1");
    // Moving in the text keeps the list, and asks nothing more.
    ed.press("C-b").unwrap();
    ed.press("C-f").unwrap();
    assert!(completions_shown(&ed));
    assert_eq!(eval(&mut ed, &s, "(globalThis as any).asked"), "1");
}

#[test]
fn leaving_the_text_takes_the_list_away() {
    let (mut ed, _s) = completing("x fooba", r#"["foobar", "foobaz"]"#);
    ed.press("C-M-i").unwrap();
    assert!(completions_shown(&ed));
    ed.press("C-a").unwrap();
    assert!(!completions_shown(&ed));
    assert_eq!(ed.variable("completion-in-region-mode").map(|v| v.is_true()), Some(false));
}

#[test]
fn a_click_on_a_completion_chooses_it() {
    let (mut ed, s) = completing("fooba", r#"["foobar", "foobaz"]"#);
    ed.press("C-M-i").unwrap();
    let window = ed.windows().iter().find(|w| w.buffer.name == "*Completions*").map(|w| w.id).unwrap();
    // On "foobaz", the list's last line, while the buffer's window is selected.
    let at: usize = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.pointMax() - 2)"#).parse().unwrap();
    let click = e8_core::Key::parse("<mouse-1>").unwrap();
    ed.mouse(click, e8_core::MouseEvent { window, position: Some(at), start: None });
    assert_eq!(text(&ed), "foobaz");
    assert!(!completions_shown(&ed));
}

#[test]
fn vertical_completions_go_down_the_columns_as_emacs_lays_them() {
    let (mut ed, s) = completing("", r#"["apple", "apricot", "avocado", "banana", "blueberry", "cherry", "coconut", "date", "elderberry", "fig", "grape", "guava"]"#);
    ed.set_variable("completions-format", e8_core::Value::Str("vertical".into()));
    ed.press("C-M-i").unwrap();
    let list = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#);
    // As Emacs 30.2 lays them out: a line more than 12 divide into 6 columns, so four columns of three.
    assert!(
        list.ends_with(r#"12 possible completions:\napple \tbanana \tcoconut \tfig\napricot \tblueberry \tdate \tgrape\navocado \tcherry \telderberry \tguava\n""#),
        "{list}"
    );
}

#[test]
fn an_exit_function_hears_of_a_completion_however_it_is_done() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    ed.window_buffer_mut().set_text("fooba");
    ed.window_buffer_mut().set_point(5);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"(globalThis as any).heard = [];
        e8.addHook("completion-at-point-functions", () => [0, e8.pointMax(), ["foobar", "foobaz"], ":exit-function",
          (text: string, status: string) => (globalThis as any).heard.push(`${text} ${status}`)], { local: true });"#
            .to_string(),
    )
    .unwrap();
    // Listed, then the mode's TAB completes the rest once "z" makes it one.
    ed.press("C-M-i").unwrap();
    ed.type_text("z");
    ed.press("TAB").unwrap();
    assert_eq!(text(&ed), "foobaz");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify((globalThis as any).heard)"), r#""[\"foobaz finished\"]""#);
    // Chosen from the list: finished too, as Emacs's insert-choice function says.
    ed.press("C-a C-k").unwrap();
    ed.type_text("fooba");
    ed.press("C-M-i M-<down> M-RET").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify((globalThis as any).heard)"), r#""[\"foobaz finished\",\"foobar finished\"]""#);
}

#[test]
fn text_put_in_before_the_word_keeps_the_list() {
    let (mut ed, s) = completing("x fooba", r#"["foobar", "foobaz"]"#);
    ed.press("C-M-i").unwrap();
    // As process output above a prompt: the word moves, and it is still the one being completed.
    eval(&mut ed, &s, r#"e8.saveExcursion(() => { e8.gotoChar(0); e8.insert("more\n"); })"#);
    ed.press("C-b").unwrap();
    assert!(completions_shown(&ed));
    ed.press("C-f M-<down> M-RET").unwrap();
    assert_eq!(text(&ed), "more\nx foobar");
}

#[test]
fn annotations_follow_their_completions_as_emacs_shows_them() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    ed.window_buffer_mut().set_text("Print");
    ed.window_buffer_mut().set_point(5);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"e8.addHook("completion-at-point-functions", () => [0, e8.point(), ["Printf", "Println", "Print", "Sprintf"],
          ":annotation-function", (c: string) => e8.concat(" ", e8.propertize(c === "Print" ? "func(a ...any)" : "func", { face: "font-lock-function-name-face" }))],
          { local: true });"#
            .to_string(),
    )
    .unwrap();
    ed.call("completion-help-at-point", vec![]).unwrap();
    // As Emacs 30.2 lists them: one to a line, as the widest with its annotation leaves room for one column.
    let list = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#);
    assert!(list.ends_with(r#"3 possible completions:\nPrint func(a ...any)\nPrintf func\nPrintln func""#), "{list}");
    // The annotation keeps its own face, and choosing on it chooses its completion.
    let props = eval(
        &mut ed,
        &s,
        r#"e8.withCurrentBuffer("*Completions*", () => { const p = e8.bufferText(e8.pointMin(), e8.pointMax()).indexOf("func(a"); return JSON.stringify([e8.getTextProperty(p, "face"), e8.getTextProperty(p, "completion--string"), e8.getTextProperty(p, "mouse-face") ?? null]); })"#,
    );
    assert_eq!(props, r#""[\"font-lock-function-name-face\",\"Print\",null]""#);
}

#[test]
fn a_display_sort_function_orders_the_list() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    ed.window_buffer_mut().set_text("a");
    ed.window_buffer_mut().set_point(1);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"e8.addHook("completion-at-point-functions", () => [0, e8.point(), ["ab", "ac", "aa"],
          ":display-sort-function", (cs: string[]) => [...cs].sort().reverse()], { local: true });"#
            .to_string(),
    )
    .unwrap();
    ed.press("C-M-i").unwrap();
    let list = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#);
    assert!(list.ends_with(r#"3 possible completions:\nac\nab\naa""#), "{list}");
}

/// A completion function with annotations naming the buffer they are asked in.
fn annotated(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    ed.window_buffer_mut().set_text(text);
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"e8.addHook("completion-at-point-functions", () => [0, e8.point(), ["foobar", "foobaz"],
          ":annotation-function", (c: string) => ` in ${e8.bufferName()}`], { local: true });"#
            .to_string(),
    )
    .unwrap();
    (ed, s)
}

#[test]
fn annotations_are_asked_for_in_the_buffer_being_completed_and_only_the_completion_is_marked() {
    let (mut ed, s) = annotated("fooba");
    ed.press("C-M-i").unwrap();
    let list = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#);
    assert!(list.ends_with(r#"foobar in *scratch*\nfoobaz in *scratch*""#), "{list}");
    ed.press("M-<down>").unwrap();
    let marked = eval(
        &mut ed,
        &s,
        r#"e8.withCurrentBuffer("*Completions*", () => {
          const o = e8.overlaysIn(e8.pointMin(), e8.pointMax()).find((o) => e8.overlayGet(o, "face") === "completions-highlight");
          return o === undefined ? "" : e8.bufferText(e8.overlayStart(o), e8.overlayEnd(o));
        })"#,
    );
    assert_eq!(marked, r#""foobar""#);
}

#[test]
fn a_click_on_an_annotation_only_moves_there() {
    let (mut ed, s) = annotated("fooba");
    ed.press("C-M-i").unwrap();
    let window = ed.windows().iter().find(|w| w.buffer.name == "*Completions*").map(|w| w.id).unwrap();
    let at: usize = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()).indexOf(" in *scratch*") + 3)"#)
        .parse()
        .unwrap();
    ed.mouse(e8_core::Key::parse("<mouse-1>").unwrap(), e8_core::MouseEvent { window, position: Some(at), start: None });
    assert_eq!(ed.window_buffer().name, "*Completions*");
    assert_eq!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("*scratch*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#), r#""fooba""#);
}

#[test]
fn cycling_goes_on_with_the_last_key_of_a_prefix_binding() {
    let (mut ed, _s) = completing("fooba", r#"["foobar", "foobaz"]"#);
    ed.set_variable("completion-cycle-threshold", e8_core::Value::Number(3.0));
    ed.call("global-set-key", vec![e8_core::Arg::Str("C-c c".into()), e8_core::Arg::Str("completion-at-point".into())]).unwrap();
    ed.press("C-c c").unwrap();
    assert_eq!(text(&ed), "foobar");
    ed.press("c").unwrap();
    assert_eq!(text(&ed), "foobaz");
    ed.press("c").unwrap();
    assert_eq!(text(&ed), "foobar");
    // Another key, and the cycle is over: c is typed.
    ed.press("C-e").unwrap();
    ed.press("c").unwrap();
    assert_eq!(text(&ed), "foobarc");
}

/// Fruits in groups by their first letter, shown upper case, as a group function transforms them.
fn grouped() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"e8.addHook("completion-at-point-functions", () => [e8.point(), e8.point(), ["apple", "banana", "avocado", "blueberry", "cherry"],
          ":group-function", (c: string, transform: boolean) => transform ? c.toUpperCase() : c.startsWith("a") ? "A fruits" : c.startsWith("b") ? "B fruits" : "Other"],
          { local: true });"#
            .to_string(),
    )
    .unwrap();
    (ed, s)
}

fn completions_text(ed: &mut Editor, s: &Scripting) -> String {
    ed.call("completion-help-at-point", vec![]).unwrap();
    eval(ed, s, r#"e8.withCurrentBuffer("*Completions*", () => e8.bufferText(e8.pointMin(), e8.pointMax()))"#)
}

#[test]
fn groups_are_listed_under_their_titles_as_emacs_lists_them() {
    let (mut ed, s) = grouped();
    // Each as Emacs 30.2 lists them, without completions-group, which only cycling reads.
    let head = r#"5 possible completions:\n     A fruits  \n"#;
    let horizontal = completions_text(&mut ed, &s);
    assert!(horizontal.ends_with(&format!(r#"{head}APPLE \tAVOCADO\n     B fruits  \nBANANA \tBLUEBERRY\n     Other  \nCHERRY""#)), "{horizontal}");
    ed.set_variable("completions-format", e8_core::Value::Str("vertical".into()));
    let vertical = completions_text(&mut ed, &s);
    assert!(vertical.ends_with(&format!(r#"{head}APPLE\nAVOCADO\n     B fruits  \nBANANA\nBLUEBERRY\n     Other  \nCHERRY\n""#)), "{vertical}");
    ed.set_variable("completions-format", e8_core::Value::Str("one-column".into()));
    ed.set_variable("completions-group-sort", e8_core::Value::Str("alphabetical".into()));
    let one = completions_text(&mut ed, &s);
    assert!(one.ends_with(&format!(r#"{head}APPLE\nAVOCADO\n     B fruits  \nBANANA\nBLUEBERRY\n     Other  \nCHERRY""#)), "{one}");
    // The title is in its face, and choosing what the group shows chooses the completion itself.
    let face = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Completions*", () => e8.getTextProperty(e8.bufferText(e8.pointMin(), e8.pointMax()).indexOf("A fruits"), "face"))"#);
    assert_eq!(face, r#""completions-group-title""#);
    ed.press("M-<down>").unwrap();
    ed.press("M-RET").unwrap();
    assert_eq!(text(&ed), "apple");
}

#[test]
fn groups_sort_alphabetically_when_asked() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    s.eval_typescript(
        &mut ed,
        "capf.ts",
        r#"e8.addHook("completion-at-point-functions", () => [e8.point(), e8.point(), ["zed", "alpha"],
          ":group-function", (c: string, transform: boolean) => transform ? c : c === "zed" ? "First" : "Second"], { local: true });"#
            .to_string(),
    )
    .unwrap();
    ed.set_variable("completions-group-sort", e8_core::Value::Str("alphabetical".into()));
    let list = completions_text(&mut ed, &s);
    assert!(list.ends_with(r#"2 possible completions:\n     First  \nzed\n     Second  \nalpha""#), "{list}");
}
