//! Compiling and grepping in the background, and visiting the messages
//! found with next-error, as compile.el and grep.el do. `M-x compile`
//! reads its command partway through, which waits in the command loop, so
//! these run the editor on its own thread (ADR 0053).

use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::driven::Driven;
use e8_core::{Arg, Editor, Value};

fn setup(dir: &Path) -> Driven {
    let d = Driven::new("");
    let dir = format!("{}/", dir.display());
    d.with(move |ed| {
        ed.make_local_variable("default-directory");
        ed.set_variable("default-directory", Value::Str(dir));
        ed.set_variable("compilation-ask-about-save", Value::Bool(false));
    });
    d
}

fn text_of(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap_or_else(|| panic!("no buffer {name}"))];
    b.slice(0..b.len())
}

/// The text of a buffer, by name.
fn buffer_text(d: &Driven, name: &'static str) -> String {
    d.with(move |ed| text_of(ed, name))
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/a.rs"), "fn a() {\n    let x = 1;\n}\n").unwrap();
    fs::write(dir.path().join("src/b.rs"), "one\ntwo\nthree x\n").unwrap();
    dir
}

/// Starts a command as M-x compile does.
fn start(d: &Driven, command: &str) {
    d.mx("compile");
    let command = command.to_string();
    d.with(move |ed| ed.set_minibuffer_input(&command));
    d.press("RET");
}

/// Runs a command as M-x compile does, waiting for it to end.
fn compile(d: &Driven, command: &str) {
    start(d, command);
    wait_for_output(d);
}

fn wait_for_output(d: &Driven) {
    d.with(|ed| ed.accept_process_output(Duration::from_secs(10)));
}

fn last_message(d: &Driven) -> Option<String> {
    d.with(|ed| ed.messages().last().cloned())
}

#[test]
fn compile_shows_output_and_how_it_ended() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "echo building; exit 2");
    let text = buffer_text(&d, "*compilation*");
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].starts_with("-*- mode: compilation; default-directory: \""), "{text}");
    assert!(lines[1].starts_with("Compilation started at "), "{text}");
    assert_eq!(lines[3], "echo building; exit 2");
    assert_eq!(lines[4], "building");
    assert!(lines[6].starts_with("Compilation exited abnormally with code 2 at "), "{text}");
    assert!(lines[6].contains(", duration "), "{text}");
    assert_eq!(last_message(&d).as_deref(), Some("Compilation exited abnormally with code 2"));
    assert!(d.with(|ed| ed.windows().iter().any(|w| w.buffer.name == "*compilation*")), "the buffer is shown");
}

#[test]
fn next_error_visits_each_message_in_turn() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf 'src/a.rs:2:9: error: unused\\nsrc/b.rs:3: warning: odd\\nnot a message\\n'");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "a.rs");
    assert_eq!(d.point(), 9 + 8, "line 2, column 9");
    assert_eq!(last_message(&d).as_deref(), Some("Next locus from *compilation*"));
    // The overlay arrow marks the message in *compilation*: as a triangle
    // in the fringe on a graphical frame, as nothing on a terminal, its
    // overlay-arrow-string being empty there, as compile.el sets it.
    d.with(|ed| {
        let comp = &ed.buffers()[ed.find_buffer("*compilation*").unwrap()];
        let Some(Value::Marker(arrow)) = ed.variable_in(comp, "overlay-arrow-position") else { panic!("no arrow") };
        let first = comp.slice(0..comp.len()).find("\nsrc/a.rs").unwrap() + 1;
        assert_eq!(ed.marker_position(arrow), Some(("*compilation*", first)));
        assert_eq!(ed.variable("overlay-arrow-position"), Some(Value::Null), "only *compilation* has it");
        ed.press("M-g n").unwrap();
        assert_eq!(ed.window_buffer().name, "b.rs");
        assert_eq!(ed.buffer().point(), 8, "the start of line 3");
        let comp = &ed.buffers()[ed.find_buffer("*compilation*").unwrap()];
        assert_eq!(ed.variable_in(comp, "overlay-arrow-position"), Some(Value::Marker(arrow)), "the same marker, moved");
        assert_eq!(ed.marker_position(arrow), Some(("*compilation*", comp.slice(0..comp.len()).find("\nsrc/b.rs").unwrap() + 1)));
        ed.press("M-g n").unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Past last error"));
        ed.press("M-g p").unwrap();
        assert_eq!(ed.window_buffer().name, "a.rs");
        // Only errors, with the threshold raised.
        ed.set_variable("compilation-skip-threshold", Value::Number(2.0));
        ed.press("C-u M-g n").unwrap();
        assert_eq!(ed.window_buffer().name, "a.rs");
    });
}

#[test]
fn messages_in_the_buffer_are_visited_with_ret() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf 'error[E0425]: cannot find value\\n  --> src/a.rs:2:5\\n'");
    d.with(|ed| {
        let w = ed.windows().into_iter().find(|w| w.buffer.name == "*compilation*").unwrap().id;
        ed.call("select-window", vec![Arg::Str(w.to_string())]).ok();
    });
    d.press("M-x");
    d.type_text("switch-to-buffer\n*compilation*\n");
    d.press("M-< M-n");
    assert!(d.with(|ed| ed.buffer().slice(ed.buffer().point()..ed.buffer().len()).starts_with("  --> src/a.rs")), "cargo's arrow");
    d.press("RET");
    assert_eq!(d.buffer_name(), "a.rs");
    assert_eq!(d.point(), 13);
}

#[test]
fn grep_finds_hits_and_counts_them() {
    let dir = project();
    let d = setup(dir.path());
    d.press("M-x");
    d.type_text("grep\n");
    assert_eq!(d.minibuffer_input(), "grep --color=auto -nH --null -e ");
    d.type_text("x src/a.rs src/b.rs\n");
    wait_for_output(&d);
    let text = buffer_text(&d, "*grep*");
    assert!(text.contains("src/a.rs:2:    let x = 1;"), "the NUL shows as a colon: {text}");
    assert!(text.contains("\nGrep finished with 2 matches found at "), "{text}");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "a.rs");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "b.rs");
    assert_eq!(d.point(), 8);
}

#[test]
fn recompile_runs_it_again_and_a_running_one_can_be_killed() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "echo once");
    d.press("M-x");
    d.type_text("switch-to-buffer\n*compilation*\n");
    d.press("g");
    wait_for_output(&d);
    assert_eq!(buffer_text(&d, "*compilation*").matches("once\n").count(), 2, "the command and its output, once");
    start(&d, "sleep 30");
    d.press("M-x");
    d.type_text("switch-to-buffer\n*compilation*\n");
    d.press("C-c C-k");
    wait_for_output(&d);
    let text = buffer_text(&d, "*compilation*");
    assert!(text.contains("\nCompilation interrupt at "), "{text}");
}

#[test]
fn messages_keep_their_places_through_edits() {
    let dir = project();
    let d = setup(dir.path());
    fs::write(dir.path().join("src/c.rs"), "one\ntwo\nthree\nfour\n").unwrap();
    compile(&d, "printf 'src/c.rs:2: error: a\\nsrc/c.rs:4: error: b\\n'");
    d.press("M-g n");
    assert_eq!(d.point(), 4);
    // Lines added above the next error, which still goes to "four".
    d.press("M-< C-o C-o");
    d.press("M-g n");
    assert_eq!(d.with(|ed| ed.buffer().slice(ed.buffer().point()..ed.buffer().point() + 4)), "four");
}

#[test]
fn compiling_again_asks_about_the_running_one() {
    let dir = project();
    let d = setup(dir.path());
    start(&d, "sleep 5");
    start(&d, "echo again");
    assert_eq!(d.prompt().as_deref(), Some("A compilation process is running; kill it? (yes or no) "));
    d.type_text("no\n");
    let err = d.with(|ed| ed.take_error().map(|e| e.to_string()));
    assert_eq!(err.as_deref(), Some("Cannot have two processes in ‘*compilation*’ at once"));
    // Saying yes kills the old one and starts the new one.
    start(&d, "echo again");
    d.type_text("yes\n");
    wait_for_output(&d);
    let text = buffer_text(&d, "*compilation*");
    assert!(text.contains("\necho again\nagain\n"), "{text}");
    assert!(text.contains("Compilation finished at "), "{text}");
}

#[test]
fn next_error_keeps_to_its_buffer_when_it_is_renamed() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf 'src/a.rs:2:9: error: unused\\nsrc/b.rs:3: warning: odd\\n'");
    d.press("M-g n");
    d.with(|ed| {
        let i = ed.find_buffer("*compilation*").unwrap();
        ed.with_current_buffer(i, |ed| ed.call("rename-buffer", vec![Arg::Str("*build*".into())])).unwrap();
        // A *compilation* buffer of another run, which next-error must not take.
        ed.get_buffer_create("*compilation*");
    });
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "b.rs");
    assert_eq!(last_message(&d).as_deref(), Some("Next locus from *build*"));
}

#[test]
fn output_while_a_prompt_is_open_goes_to_its_buffer() {
    let dir = project();
    let d = setup(dir.path());
    start(&d, "sleep 0.3; echo late");
    d.press("M-x");
    d.type_text("fo");
    wait_for_output(&d);
    assert_eq!(d.minibuffer_input(), "fo");
    let text = buffer_text(&d, "*compilation*");
    assert!(text.contains("\nlate\n"), "{text}");
}

/// A command compile runs has no pager, as compilation-start sets PAGER=
/// so git does not wait in one, and grep elsewhere leaves recompile running
/// where compile last did, as only compile sets compilation-directory's default.
#[test]
fn commands_run_without_a_pager_and_grep_leaves_recompile_s_directory() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "echo \"pager=[$PAGER]\"");
    assert!(buffer_text(&d, "*compilation*").contains("pager=[]\n"), "{}", buffer_text(&d, "*compilation*"));
    let src = format!("{}/src/", dir.path().display());
    d.with(move |ed| ed.set_variable("default-directory", Value::Str(src)));
    d.mx("grep");
    d.with(|ed| ed.set_minibuffer_input("grep -n x *.rs"));
    d.press("RET");
    wait_for_output(&d);
    let default = d.with(|ed| ed.default_value("compilation-directory").and_then(|v| v.as_str().map(str::to_string)));
    assert_eq!(default, Some(format!("{}/", dir.path().display())));
}

/// GNU make's "*** [FILE:LINE: target] Error 1" and clang's "In file
/// included from FILE:LINE:" are info, as Emacs's gmake and clang-include
/// rules take them before gnu, so next-error passes over them to the error.
#[test]
fn make_and_clang_context_lines_are_info_that_next_error_passes() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf 'In file included from src/b.rs:1:\\nsrc/a.rs:2:9: error: bad\\nmake: *** [src/b.rs:3: all] Error 1\\n'");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "a.rs");
    assert_eq!(d.point(), 9 + 8);
    d.press("M-g n");
    assert_eq!(d.with(|ed| ed.take_error().map(|e| e.to_string())).as_deref(), Some("Past last error"));
}

/// A message after make's "Entering directory" names its file relative to
/// that directory, as compilation-directory-matcher has it, until make
/// leaves it.
#[test]
fn messages_follow_the_directories_make_enters() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf \"make: Entering directory '%s/src'\\na.rs:2:5: error: x\\nmake: Leaving directory '%s/src'\\nsrc/b.rs:3: error: y\\n\" \"$PWD\" \"$PWD\"");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "a.rs");
    assert_eq!(d.point(), 9 + 4, "line 2, column 5");
    d.press("M-g n");
    assert_eq!(d.buffer_name(), "b.rs");
}

/// A colour code the program writes in two pieces is taken out whole, as
/// a terminal reads it, not left in the buffer.
#[test]
fn colour_codes_split_between_writes_are_taken_out() {
    let dir = project();
    let d = setup(dir.path());
    compile(&d, "printf 'a\\033[3'; sleep 0.3; printf '5mred\\033[0m b\\n'");
    let text = buffer_text(&d, "*compilation*");
    assert!(text.contains("\nared b\n"), "{text:?}");
    assert!(!text.contains('\u{1b}'), "{text:?}");
}
