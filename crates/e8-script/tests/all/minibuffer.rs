//! The minibuffer: history with M-p and M-n, and completion styles.

use crate::driven::Driven;
use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn input(ed: &Editor) -> String {
    ed.minibuffer_input()
}

fn strings(ed: &Editor, variable: &str) -> Vec<String> {
    match ed.variable(variable) {
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        other => panic!("{variable} is {other:?}"),
    }
}

#[test]
fn m_x_remembers_commands() {
    let (mut ed, _scripting) = setup();
    for command in ["forward-char", "move-end-of-line", "forward-char"] {
        ed.press("M-x").unwrap();
        ed.type_text(&format!("{command}\n"));
    }
    assert_eq!(strings(&ed, "extended-command-history"), ["forward-char", "move-end-of-line", "forward-char"]);
    // Again straight away does not add it twice.
    ed.press("M-x").unwrap();
    ed.type_text("forward-char\n");
    assert_eq!(strings(&ed, "extended-command-history").len(), 3);

    ed.press("M-x").unwrap();
    ed.type_text("beg");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "forward-char");
    ed.press("M-p").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("<up> M-p").unwrap();
    assert_eq!(input(&ed), "forward-char", "no further back than the oldest");
    assert_eq!(ed.echo(), Some("Beginning of history; no preceding item"));
    ed.press("M-n").unwrap();
    assert_eq!(input(&ed), "move-end-of-line");
    ed.press("M-n <down>").unwrap();
    assert_eq!(input(&ed), "beg", "back to what was typed");
    ed.press("M-n").unwrap();
    assert_eq!(ed.echo(), Some("End of history; no default available"));
    ed.press("C-g").unwrap();
}

#[test]
fn prompts_keep_separate_histories() {
    let (mut ed, _scripting) = setup();
    ed.press("C-x b").unwrap();
    ed.type_text("notes\n");
    ed.call("query-replace", vec![]).ok();
    ed.press("M-%").unwrap();
    ed.type_text("old\nnew\n");
    assert_eq!(strings(&ed, "buffer-name-history"), ["notes"]);
    assert_eq!(strings(&ed, "query-replace-history"), ["new", "old"]);
    ed.press("C-x b M-p").unwrap();
    assert_eq!(input(&ed), "notes");
    ed.press("C-g M-% M-p").unwrap();
    assert_eq!(input(&ed), "new");
}

#[test]
fn partial_completion_completes_word_by_word() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    // split-root-window-below matches s-w-be too, as in Emacs 29.
    ed.type_text("s-w-be");
    assert_eq!(ed.minibuffer_completions(), ["split-root-window-below", "split-window-below"]);
    ed.press("C-g M-x").unwrap();
    ed.type_text("sw-t-b-o-w");
    assert_eq!(ed.minibuffer_completions(), ["switch-to-buffer-other-window"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "switch-to-buffer-other-window");
    ed.press("C-g").unwrap();
    // RET runs the only command the input matches.
    ed.window_buffer_mut().set_text("abc");
    ed.press("M-x").unwrap();
    ed.type_text("e-o-l\n");
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn completion_styles_can_change() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("window-below");
    assert!(ed.minibuffer_completions().is_empty(), "no prefix or partial match");
    ed.press("C-g").unwrap();
    let styles = ["basic", "substring"].map(|s| Value::Str(s.into())).to_vec();
    ed.set_variable("completion-styles", Value::List(styles));
    ed.press("M-x").unwrap();
    ed.type_text("it-window-below");
    assert_eq!(ed.minibuffer_completions(), ["split-window-below"]);
    ed.press("TAB").unwrap();
    assert_eq!(input(&ed), "split-window-below");
}

#[test]
fn tab_says_when_completion_is_not_unique() {
    let (mut ed, _scripting) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("isearch-forward");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[Complete, but not unique]"));
    ed.press("C-g").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("zzz");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("[No match]"));
}

/// An editor with `pick`, which reads one of some fruit and keeps the
/// answer in `picked`, on a driver, as the prompt waits for its answer.
fn driven_pick(options: &str) -> Driven {
    Driven::new(&format!(
        r#"e8.defineVariable({{ name: "picked", value: null }});
        e8.defineCommand({{ name: "pick", run: () => e8.setVariable("picked", e8.completingRead("Fruit: ",
          ["apple", "apricot", "banana", "avocado"], {options})) }});"#
    ))
}

fn picked(d: &Driven) -> Option<String> {
    d.variable("picked").map(|v| v.trim_matches('"').to_string()).filter(|v| v != "null")
}

/// What icomplete shows after the input, on a driven editor.
fn shown_by(d: &Driven) -> String {
    d.with(|ed| ed.minibuffer_strings().1)
}

#[test]
fn icomplete_shows_what_the_input_completes_to() {
    let d = driven_pick("{ requireMatch: true }");
    d.press("M-x");
    d.type_text("pick\n");
    assert_eq!(d.prompt().as_deref(), Some("Fruit: "));
    assert_eq!(shown_by(&d), "", "nothing until something is typed");
    d.type_text("ap");
    assert_eq!(shown_by(&d), "{ple | ricot}", "the part they share is left out");
    d.type_text("r");
    assert_eq!(shown_by(&d), "(icot) [Matched]", "parentheses: the answer must match");
    d.press("DEL DEL DEL");
    d.type_text("x");
    assert_eq!(shown_by(&d), " (No matches)");
    d.press("DEL");
    d.type_text("a");
    assert_eq!(shown_by(&d), "{pple | pricot | vocado}", "shortest first, then alphabetical");
    d.press("C-.");
    assert_eq!(shown_by(&d), "{pricot | vocado | pple}");
    d.press("C-,");
    assert_eq!(shown_by(&d), "{pple | pricot | vocado}");
    d.press("C-. C-j");
    assert_eq!(picked(&d).as_deref(), Some("apricot"), "C-j takes the first shown");
    assert_eq!(d.prompt(), None);
}

#[test]
fn answers_that_must_match_complete_before_they_finish() {
    let d = driven_pick("{ requireMatch: true }");
    d.press("M-x");
    d.type_text("pick\nap\n");
    assert_eq!(d.prompt().as_deref(), Some("Fruit: "), "ap could be either");
    d.press("C-a C-k");
    d.type_text("q\n");
    assert_eq!(d.message().as_deref(), Some("[No match]"));
    d.press("DEL");
    d.type_text("b\n");
    assert_eq!(picked(&d).as_deref(), Some("banana"), "the only match");
    // Earlier answers come first.
    d.press("M-x");
    d.type_text("pick\na");
    assert_eq!(shown_by(&d), "{pple | pricot | vocado}");
    d.press("C-g");
    d.mx("pick");
    d.type_text("avocado\n");
    d.mx("pick");
    d.type_text("a");
    assert_eq!(shown_by(&d), "{vocado | pple | pricot}");
}

#[test]
fn readers_return_their_defaults() {
    let d = Driven::new(
        r#"e8.defineVariable({ name: "answer", value: null });
        e8.defineCommand({ name: "ask-name", run: () => e8.setVariable("answer", e8.readString("Name: ", { default: "Ada" })) });
        e8.defineCommand({ name: "ask-file", run: () =>
          e8.setVariable("answer", e8.readFileName("File: ", { dir: "/tmp/", default: "/tmp/x.txt" })) });"#,
    );
    let answer = || d.variable("answer").map(|v| v.trim_matches('"').to_string());
    d.mx("ask-name");
    d.press("RET");
    assert_eq!(answer().as_deref(), Some("Ada"));
    d.mx("ask-name");
    d.type_text("Grace\n");
    assert_eq!(answer().as_deref(), Some("Grace"));
    d.mx("ask-file");
    assert_eq!(d.minibuffer_input(), "/tmp/");
    d.press("RET");
    assert_eq!(answer().as_deref(), Some("/tmp/x.txt"), "left as it started");
    assert_eq!(d.with(|ed| strings(ed, "minibuffer-history")), ["Grace", "Ada"]);
}

#[test]
fn fido_takes_the_first_completion_and_walks_directories() {
    let dir = tempfile::tempdir().unwrap();
    for f in ["alpha.txt", "notes.org", "notes.org~"] {
        std::fs::write(dir.path().join(f), "").unwrap();
    }
    std::fs::create_dir(dir.path().join("beta")).unwrap();
    std::fs::write(dir.path().join("beta/inner.txt"), "").unwrap();
    let root = format!("{}/", dir.path().display());
    let d = Driven::new(&format!(
        r#"e8.defineVariable({{ name: "answer", value: null }});
        e8.defineCommand({{ name: "ask-file", run: () =>
          e8.setVariable("answer", e8.readFileName("File: ", {{ dir: "{root}" }})) }});"#
    ));
    let answer = || d.variable("answer").map(|v| v.trim_matches('"').to_string());
    d.mx("fido-mode");
    d.mx("ask-file");
    // Matches show at once, ./ first, without backups or ../.
    assert_eq!(shown_by(&d), "{./ | beta/ | alpha.txt | notes.org}");
    d.type_text("bt");
    assert_eq!(shown_by(&d), "[…eta/] [Matched]", "as Emacs shows it");
    d.press("RET");
    assert_eq!(d.minibuffer_input(), format!("{root}beta/"), "RET on a directory goes into it");
    assert_eq!(shown_by(&d), "{./ | inner.txt}");
    d.press("DEL");
    assert_eq!(d.minibuffer_input(), root, "DEL after a slash goes up");
    d.type_text("NOT");
    assert_eq!(shown_by(&d), "[es.org] [Matched]", "flex, ignoring case");
    d.press("RET");
    assert_eq!(answer(), Some(format!("{root}notes.org")));

    // M-j takes the input as typed.
    d.mx("ask-file");
    d.type_text("note");
    d.press("M-j");
    assert_eq!(answer(), Some(format!("{root}note")));
}

#[test]
fn fido_vertical_scrolls_through_completions() {
    let d = driven_pick("{}");
    d.mx("fido-vertical-mode");
    d.with(|ed| ed.set_frame_size(80, 39));
    d.mx("pick");
    let before = || d.with(|ed| ed.minibuffer_strings().0);
    assert_eq!(before(), "1/4 ");
    assert_eq!(shown_by(&d), " \napple  \nbanana \napricot\navocado\n");
    d.press("C-n C-n");
    assert_eq!(before(), "3/4 ");
    d.press("M->");
    assert_eq!(before(), "4/4 ");
    d.press("M-< C-n RET");
    assert_eq!(picked(&d).as_deref(), Some("banana"));
}

#[test]
fn icomplete_can_be_turned_off() {
    let d = driven_pick("{}");
    d.eval(r#"e8.callWithPrefix(0, "icomplete-mode");"#);
    d.mx("pick");
    d.type_text("a");
    assert_eq!(d.with(|ed| ed.minibuffer_strings()), (String::new(), String::new()));
}

#[test]
fn the_minibuffer_is_a_buffer_like_any_other() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        e8.addHook("minibuffer-setup-hook", () => {
          const b = e8.currentBuffer();
          seen.push(b.name, e8.bufferLiveP(b));
          // Its own variables and text properties, as any buffer's.
          e8.makeLocalVariable("fill-column");
          e8.setVariable("fill-column", seen.length);
        });
        "#
        .to_string(),
    )
    .unwrap();
    ed.press("C-x b").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "seen").unwrap(), r#"[" *Minibuf-1*",true]"#);
    assert!(ed.in_minibuffer());
    assert_eq!(ed.buffer().name, " *Minibuf-1*");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    ed.type_text("abc");
    assert_eq!(s.eval_expression(&mut ed, r#"e8.withCurrentBuffer(" *Minibuf-1*", () => e8.minibufferContents())"#).unwrap(), r#""abc""#);
    // It is not offered as a buffer to switch to, nor killed.
    assert!(!ed.minibuffer_completions().iter().any(|n| n.starts_with(' ')));
    ed.press("C-g").unwrap();
    assert!(!ed.in_minibuffer());
    assert_eq!(ed.buffer().name, "*scratch*");
    assert!(ed.kill_buffer(" *Minibuf-1*").is_err());
    assert_ne!(ed.other_buffer(), Some(" *Minibuf-1*"));
    // Its own values went when the prompt closed and come anew with the next.
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(70.0)));
    ed.press("C-x b").unwrap();
    assert_eq!(ed.variable("fill-column"), Some(Value::Number(4.0)));
    ed.press("C-g").unwrap();
}

#[test]
fn the_prompt_is_read_only_text_before_the_input() {
    let (mut ed, s) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("forward word");
    let text = |ed: &mut Editor| s.eval_expression(ed, "e8.bufferText()").unwrap();
    assert_eq!(text(&mut ed), r#""M-x forward word""#);
    assert_eq!(s.eval_expression(&mut ed, "e8.minibufferPromptEnd()").unwrap(), "4");
    assert_eq!(s.eval_expression(&mut ed, r#"e8.getTextProperty(0, "face")"#).unwrap(), r#""minibuffer-prompt""#);
    // Point stays in the input: C-a and M-< go to its start, and words stop there.
    ed.press("C-a").unwrap();
    assert_eq!(ed.minibuffer().point(), 4);
    ed.press("C-e M-< ").unwrap();
    assert_eq!(ed.minibuffer().point(), 4);
    ed.press("C-e M-b M-b M-b M-b").unwrap();
    assert_eq!(ed.minibuffer().point(), 4);
    // The prompt cannot be deleted; the input can.
    ed.press("DEL").unwrap();
    assert_eq!(text(&mut ed), r#""M-x forward word""#);
    ed.press("C-e M-DEL M-DEL M-DEL").unwrap();
    assert_eq!(text(&mut ed), r#""M-x ""#);
    ed.type_text("end-of-buffer");
    assert_eq!(input(&ed), "end-of-buffer");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), None);
}

#[test]
fn c_x_o_leaves_the_minibuffer_and_comes_back() {
    let (mut ed, s) = setup();
    ed.press("M-x").unwrap();
    ed.type_text("end-of-b");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify([e8.windowList().map((w) => w.id), e8.selectedWindow().id])").unwrap(), r#""[[1,0],0]""#);
    ed.press("C-x o").unwrap();
    // The prompt stays open while another window is selected; keys act there.
    assert_eq!(ed.prompt(), Some("M-x "));
    assert!(!ed.minibuffer_window_selected());
    ed.type_text("hello");
    assert_eq!(ed.window_buffer().slice(0..5), "hello");
    assert_eq!(input(&ed), "end-of-b");
    ed.press("C-a C-x o").unwrap();
    assert!(ed.minibuffer_window_selected());
    ed.press("TAB RET").unwrap();
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.window_buffer().point(), 5, "end-of-buffer ran in the window's buffer");
}

#[test]
fn a_recursive_minibuffer_opens_inside_the_open_one() {
    let (mut ed, s) = setup();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        e8.defineCommand({ name: "zz-insert", params: [{ name: "text", kind: "string", prompt: "Text: " }], run: (text: string) => e8.insert(text) });
        e8.bindKey("C-c i", "zz-insert");
        "#
        .to_string(),
    )
    .unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("forw");
    // Not unless enable-recursive-minibuffers is on.
    ed.press("C-c i").unwrap();
    assert_eq!(ed.echo(), Some("Command attempted to use minibuffer while in minibuffer"));
    assert_eq!(ed.minibuffer_depth(), 1);
    ed.set_default("enable-recursive-minibuffers", Value::Bool(true));
    ed.press("C-c i").unwrap();
    assert_eq!(ed.prompt(), Some("Text: "));
    assert_eq!(ed.minibuffer_depth(), 2);
    assert_eq!(ed.buffer().name, " *Minibuf-2*");
    ed.type_text("ard-word");
    ed.press("RET").unwrap();
    // The answer went into the outer minibuffer, whose prompt is back.
    assert_eq!(ed.prompt(), Some("M-x "));
    assert_eq!(ed.minibuffer_depth(), 1);
    assert_eq!(input(&ed), "forward-word");
    // C-g in an inner one quits only it.
    ed.press("C-c i").unwrap();
    ed.press("C-g").unwrap();
    assert_eq!(ed.prompt(), Some("M-x "));
    assert_eq!(input(&ed), "forward-word");
    assert_eq!(s.eval_expression(&mut ed, "e8.minibufferDepth()").unwrap(), "1");
    ed.press("RET").unwrap();
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.minibuffer_depth(), 0);
}

#[test]
fn transposing_into_the_prompt_changes_nothing() {
    let (mut ed, s) = setup();
    ed.press("M-:").unwrap();
    ed.type_text("ab cd");
    ed.press("C-a C-t").unwrap();
    assert_eq!(input(&ed), "ab cd");
    assert!(s.eval_expression(&mut ed, "e8.bufferText()").unwrap().ends_with(r#": ab cd""#));
    ed.press("C-g").unwrap();
}

/// The minibuffer grows past a quarter of the frame for the lines an
/// overlay shows below the input, when the minibuffer's own
/// max-mini-window-height lets it, as vertico sets it to 1.0 for
/// vertico-count lines, and the window's own buffer keeps the quarter once
/// the prompt is gone.
#[test]
fn the_minibuffer_grows_for_lines_an_overlay_shows_when_its_height_lets_it() {
    let d = Driven::new("");
    d.with(|ed| ed.set_frame_size(80, 28));
    d.eval(
        r#"e8.addHook("minibuffer-setup-hook", () => {
          e8.makeLocalVariable("max-mini-window-height"); e8.setVariable("max-mini-window-height", 1.0);
          e8.makeLocalVariable("resize-mini-windows"); e8.setVariable("resize-mini-windows", "grow-only");
          const lines = Array.from({ length: 12 }, (_, i) => `c${i + 1}`).join("\n");
          e8.overlayPut(e8.makeOverlay(e8.pointMax(), e8.pointMax()), "after-string", "\n" + lines);
        });
        e8.defineCommand({ name: "cr-read", run: () => e8.readString("Pick: ") });
        e8.bindKey("<f5>", "cr-read");"#,
    );
    d.press("<f5>");
    // A quarter of the 30 lines would be 7: the prompt and twelve lines are 13.
    let (lines, after) = d.with(|ed| (ed.mini_window_height(30), ed.minibuffer_strings().1));
    assert_eq!(lines, 13, "{after:?}");
    assert!(after.contains("c12"), "{after:?}");
    d.press("C-g");
    assert_eq!(d.with(|ed| ed.max_mini_window_lines(30)), 7);
}
