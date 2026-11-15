//! Headless tests: drive the editor with key sequences, as a user would, and check the result.

use std::fs;

use e8_core::{Arg, Editor};

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn press(ed: &mut Editor, keys: &str) {
    ed.press(keys).unwrap();
}

#[test]
fn typing_and_undo_in_steps() {
    let mut ed = Editor::new();
    ed.type_text("hello\nworld");
    assert_eq!(text(&ed), "hello\nworld");
    press(&mut ed, "C-/");
    assert_eq!(text(&ed), "hello\n");
    press(&mut ed, "C-x u");
    assert_eq!(text(&ed), "hello");
    press(&mut ed, "C-_");
    assert_eq!(text(&ed), "");
    press(&mut ed, "C-/");
    assert_eq!(ed.echo(), Some("No further undo information"));
}

#[test]
fn undo_run_from_m_x_again_keeps_going_back() {
    // As in Emacs, M-x undo after M-x undo continues the run: the
    // commands typed in the minibuffer between them do not break it.
    // With a RET that calls exit-minibuffer from code, as vertico's, see
    // e8-script's minibuffer tests.
    let mut ed = Editor::new();
    press(&mut ed, "a C-a b C-a c C-a d C-a");
    assert_eq!(text(&ed), "dcba");
    for (i, want) in ["cba", "ba", "a"].into_iter().enumerate() {
        press(&mut ed, "M-x u n d o RET");
        assert_eq!(text(&ed), want, "after M-x undo {}", i + 1);
        assert_eq!(ed.echo(), Some("Undo"));
    }
}

#[test]
fn undo_in_a_region_undoes_only_the_changes_inside_it() {
    let mut ed = Editor::new();
    ed.type_text("abc def ghi");
    press(&mut ed, "C-a x C-e y C-a C-SPC C-f C-f C-/");
    // The x at the start is undone; the y at the end, outside the region, stays.
    assert_eq!(text(&ed), "abc def ghiy");
    assert_eq!(ed.echo(), Some("Undo in region"));
    press(&mut ed, "C-/");
    assert_eq!(ed.echo(), Some("No further undo information for region"));
}

#[test]
fn line_moves_keep_the_goal_column() {
    let mut ed = Editor::new();
    ed.type_text("long line here\nab\nanother long line");
    press(&mut ed, "M-< C-n C-n C-a");
    for _ in 0..10 {
        press(&mut ed, "C-f");
    }
    press(&mut ed, "C-p");
    assert_eq!(ed.window_buffer().column(ed.window_buffer().point()), 2);
    press(&mut ed, "C-p");
    assert_eq!(ed.window_buffer().column(ed.window_buffer().point()), 10);
}

#[test]
fn consecutive_kills_join_and_yank_back() {
    let mut ed = Editor::new();
    ed.type_text("one\ntwo\nthree");
    press(&mut ed, "M-< C-k C-k C-k");
    assert_eq!(text(&ed), "\nthree");
    assert_eq!(ed.kill_ring(), ["one\ntwo"]);
    press(&mut ed, "C-y");
    assert_eq!(text(&ed), "one\ntwo\nthree");
}

#[test]
fn region_kill_and_copy() {
    let mut ed = Editor::new();
    ed.type_text("alpha beta gamma");
    press(&mut ed, "M-< M-f C-SPC M-f C-w");
    assert_eq!(text(&ed), "alpha gamma");
    assert_eq!(ed.kill_ring(), [" beta"]);
    press(&mut ed, "C-x h M-w");
    assert_eq!(ed.kill_ring().last().unwrap(), "alpha gamma");
}

#[test]
fn m_x_completes_command_names() {
    let mut ed = Editor::new();
    ed.type_text("abc");
    press(&mut ed, "M-<");
    press(&mut ed, "M-x");
    assert_eq!(ed.prompt(), Some("M-x "));
    ed.type_text("end-of-b");
    press(&mut ed, "TAB");
    assert_eq!(ed.minibuffer_input(), "end-of-buffer");
    press(&mut ed, "RET");
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.window_buffer().point(), 3);
}

#[test]
fn m_x_rejects_unknown_commands_and_c_g_quits() {
    let mut ed = Editor::new();
    press(&mut ed, "M-x");
    ed.type_text("no-such-thing");
    press(&mut ed, "RET");
    assert_eq!(ed.prompt(), Some("M-x "));
    assert_eq!(ed.echo(), Some("[No match]"));
    press(&mut ed, "C-g");
    assert_eq!(ed.prompt(), None);
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(text(&ed), "");
}

#[test]
fn edits_in_the_minibuffer_stay_there() {
    let mut ed = Editor::new();
    ed.type_text("buffer text");
    press(&mut ed, "M-x");
    ed.type_text("undox");
    press(&mut ed, "DEL C-a C-k");
    ed.type_text("undo");
    press(&mut ed, "RET");
    assert_eq!(text(&ed), "");
}

#[test]
fn file_name_completion() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("alpha.txt"), "").unwrap();
    fs::create_dir(dir.path().join("albums")).unwrap();
    let mut ed = Editor::new();
    press(&mut ed, "C-x C-f");
    ed.type_text(&format!("/{}/al", dir.path().display()));
    assert_eq!(ed.minibuffer_completions(), ["albums/", "alpha.txt"]);
    ed.type_text("p");
    press(&mut ed, "TAB");
    assert!(ed.minibuffer_input().ends_with("/alpha.txt"));
}

#[test]
fn switching_and_killing_buffers() {
    let mut ed = Editor::new();
    press(&mut ed, "C-x b");
    ed.type_text("notes");
    press(&mut ed, "RET");
    assert_eq!(ed.window_buffer().name, "notes");
    // Empty input goes back to the previous buffer.
    press(&mut ed, "C-x b RET");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    press(&mut ed, "C-x b");
    ed.type_text("no");
    press(&mut ed, "TAB RET");
    assert_eq!(ed.window_buffer().name, "notes");
    press(&mut ed, "C-x k RET");
    assert_eq!(ed.window_buffer().name, "*scratch*");
    assert!(ed.find_buffer("notes").is_none());
}

#[test]
fn undefined_keys_and_esc_as_meta() {
    let mut ed = Editor::new();
    press(&mut ed, "C-x C-z");
    assert_eq!(ed.echo(), Some("C-x C-z is undefined"));
    ed.type_text("abc");
    // ESC followed by a key acts as Meta, for terminals that do not send Meta.
    press(&mut ed, "ESC <");
    assert_eq!(ed.window_buffer().point(), 0);
}

#[test]
fn commands_can_be_called_from_code() {
    let mut ed = Editor::new();
    ed.call("insert", vec![Arg::Str("from a tool call".into())]).unwrap();
    assert_eq!(text(&ed), "from a tool call");
    assert!(ed.call("insert", vec![]).is_err());
    assert!(ed.call("no-such-command", vec![]).is_err());
    // A call made from code is one undo step.
    press(&mut ed, "C-/");
    assert_eq!(text(&ed), "");
}

#[test]
fn rename_buffer_asks_for_a_name_and_makes_it_unique_with_a_prefix() {
    let mut ed = Editor::new();
    ed.get_buffer_create("notes");
    press(&mut ed, "C-x x r");
    assert_eq!(ed.prompt(), Some("Rename buffer (to new name): "));
    ed.type_text("notes");
    press(&mut ed, "RET");
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Buffer name \u{2018}notes\u{2019} is in use".into()));
    // As C-u, which simple.ts defines, does.
    ed.set_prefix_arg(Some(e8_core::PrefixArg::Universal(4)));
    press(&mut ed, "C-x x r");
    ed.type_text("notes");
    press(&mut ed, "RET");
    assert_eq!(ed.window_buffer().name, "notes<2>");
    // Empty input keeps the name, and so does making unique a name it has.
    press(&mut ed, "C-x x r RET");
    assert_eq!(ed.window_buffer().name, "notes<2>");
    ed.set_prefix_arg(Some(e8_core::PrefixArg::Universal(4)));
    press(&mut ed, "C-x x r");
    ed.type_text("notes");
    press(&mut ed, "RET");
    assert_eq!(ed.window_buffer().name, "notes<2>");
}

#[test]
fn a_count_is_a_parameter_code_can_pass_or_leave_out() {
    let mut ed = Editor::new();
    ed.type_text("abcdefgh");
    press(&mut ed, "C-a");
    ed.call("forward-char", vec![Arg::Int(3)]).unwrap();
    assert_eq!(ed.window_buffer().point(), 3);
    // Left out, it is the call's prefix argument, 1 without one.
    ed.call("forward-char", vec![]).unwrap();
    ed.call_with_prefix("forward-char", vec![], Some(e8_core::PrefixArg::Number(2))).unwrap();
    assert_eq!(ed.window_buffer().point(), 6);
    ed.call("delete-backward-char", vec![Arg::Int(2)]).unwrap();
    assert_eq!(text(&ed), "abcdgh");
    // A search's count is its second.
    press(&mut ed, "C-a");
    ed.call("search-forward", vec![Arg::Str("g".into()), Arg::Int(1)]).unwrap();
    assert_eq!(ed.window_buffer().point(), 5);
}

/// `subst-char-in-region` is one change for the hooks, from the first
/// character it replaces to the last, however many it replaces.
#[test]
fn subst_char_in_region_is_one_change() {
    let mut ed = Editor::new();
    ed.insert("a-b-c-d").unwrap();
    let f = e8_core::Function::new(None, |ed, args| {
        let mut seen = match ed.variable("seen") {
            Some(e8_core::Value::List(v)) => v,
            _ => Vec::new(),
        };
        seen.push(e8_core::Value::List(args.to_vec()));
        ed.set_variable("seen", e8_core::Value::List(seen));
        Ok(e8_core::Value::Null)
    });
    ed.add_hook_function("after-change-functions", f, 0.0, false);
    ed.subst_char_in_region(0, 7, '-', '+').unwrap();
    assert_eq!(ed.buffer().slice(0..7), "a+b+c+d");
    let n = |x: f64| e8_core::Value::Number(x);
    assert_eq!(ed.variable("seen"), Some(e8_core::Value::List(vec![e8_core::Value::List(vec![n(1.0), n(6.0), n(5.0)])])));
}

/// With 100,000 overlays none of which has a hook, an edit looks at none
/// of them for modification hooks, and a backward search for a property
/// change finds the overlay edge before it by the overlay index: typing
/// 1,000 characters and 20,000 searches back are quick. (Each insertion
/// still moves every overlay after it.)
#[test]
fn edits_and_searches_among_many_overlays_are_quick() {
    let mut ed = Editor::new();
    ed.buffer_mut().set_text(&"word ".repeat(100_000));
    for i in 0..100_000 {
        ed.buffer_mut().make_overlay(i * 5..i * 5 + 4);
    }
    let started = std::time::Instant::now();
    ed.buffer_mut().set_point(250_000);
    for _ in 0..1_000 {
        ed.insert("x").unwrap();
    }
    let mut pos = ed.buffer().len();
    for _ in 0..20_000 {
        let previous = ed.buffer().previous_char_property_change(pos, None);
        assert!(previous < pos);
        pos = previous;
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    assert_eq!(ed.buffer().previous_overlay_change(14), 10);
    assert_eq!(ed.buffer().next_overlay_change(14), 15);
}

/// Emacs's validate_region: text outside a narrowing can be neither deleted
/// nor killed nor copied, and nothing reaches the kill ring.
#[test]
fn edits_outside_the_narrowing_are_refused() {
    let mut ed = Editor::new();
    ed.type_text("AAA\nBBB\n");
    press(&mut ed, "M-< C-SPC C-n");
    ed.window_buffer_mut().narrow(4, 7);
    for keys in ["C-w", "M-w"] {
        press(&mut ed, keys);
        assert!(ed.echo().is_some_and(|e| e.starts_with("Args out of range")), "{keys}: {:?}", ed.echo());
    }
    assert!(ed.delete_region(0, 5).unwrap_err().is("args-out-of-range"));
    assert!(ed.replace_range(6, 8, "x").unwrap_err().is("args-out-of-range"));
    assert_eq!(text(&ed), "AAA\nBBB\n");
    assert_eq!(ed.delete_region(4, 7).unwrap(), "BBB");
    assert_eq!(text(&ed), "AAA\n\n");
    press(&mut ed, "C-y");
    assert_eq!(text(&ed), "AAA\n\n", "nothing was killed");
}
