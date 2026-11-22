//! C-m, C-i and C-[ are RET, TAB and ESC, as Emacs reads them: a binding
//! written either way runs from either key, whichever front end sends it.

use e8_core::{Editor, Key, KeyCode};

/// A key as a front end hands it over, before anything makes it canonical:
/// a GUI's ctrl and a letter.
fn ctrl(c: char) -> Key {
    Key { code: KeyCode::Char(c), ctrl: true, meta: false, shift: false }
}

fn editor_with(text: &str) -> Editor {
    let mut ed = Editor::new();
    ed.type_text(text);
    ed.press("M-<").unwrap();
    ed
}

fn bind(ed: &mut Editor, keys: &str, command: &str) {
    ed.bind_key_in("global-map", &Key::parse_seq(keys).unwrap(), command).unwrap();
}

#[test]
fn a_binding_written_c_m_runs_from_ret_and_from_ctrl_m() {
    let mut ed = editor_with("one two");
    bind(&mut ed, "C-c C-x C-m", "end-of-buffer");
    // A terminal sends RET for ctrl+m and for the Return key alike.
    ed.press("C-c C-x RET").unwrap();
    assert_eq!(ed.window_buffer().point(), 7);
    ed.press("M-<").unwrap();
    for key in [ctrl('c'), ctrl('x'), Key::new(KeyCode::Enter)] {
        ed.handle_key(key);
    }
    assert_eq!(ed.window_buffer().point(), 7);
    ed.press("M-<").unwrap();
    for key in [ctrl('c'), ctrl('x'), ctrl('m')] {
        ed.handle_key(key);
    }
    assert_eq!(ed.window_buffer().point(), 7);
    let keys: Vec<String> = ed.where_is_all("end-of-buffer").iter().map(|k| e8_core::format_keys(k)).collect();
    assert!(keys.contains(&"C-c C-x RET".to_string()), "{keys:?}");
}

#[test]
fn a_binding_written_ret_runs_from_c_m() {
    let mut ed = editor_with("one two");
    bind(&mut ed, "C-c C-x RET", "end-of-buffer");
    ed.press("C-c C-x C-m").unwrap();
    assert_eq!(ed.window_buffer().point(), 7);
    ed.press("M-<").unwrap();
    for key in [ctrl('c'), ctrl('x'), ctrl('m')] {
        ed.handle_key(key);
    }
    assert_eq!(ed.window_buffer().point(), 7);
}

#[test]
fn c_i_and_tab_are_one_key() {
    let mut ed = editor_with("one two");
    bind(&mut ed, "C-c C-i", "end-of-buffer");
    ed.press("C-c TAB").unwrap();
    assert_eq!(ed.window_buffer().point(), 7);
    bind(&mut ed, "C-c TAB", "beginning-of-buffer");
    for key in [ctrl('c'), ctrl('i')] {
        ed.handle_key(key);
    }
    assert_eq!(ed.window_buffer().point(), 0);
    // Meta and TAB is C-M-i, as Emacs writes it.
    bind(&mut ed, "C-M-i", "end-of-buffer");
    ed.press("M-TAB").unwrap();
    assert_eq!(ed.window_buffer().point(), 7);
}

#[test]
fn an_unbound_c_m_is_described_as_ret() {
    let mut ed = editor_with("");
    bind(&mut ed, "C-c C-x C-j", "end-of-buffer");
    ed.press("C-c C-x C-m").unwrap();
    assert_eq!(ed.echo(), Some("C-c C-x RET is undefined"));
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(ed.echo(), Some("C-c C-x TAB is undefined"));
}

#[test]
fn ctrl_bracket_is_esc_and_a_prefix_for_meta() {
    let mut ed = editor_with("abc");
    ed.press("M->").unwrap();
    // C-[ < is ESC <, which is M-<.
    ed.handle_key(ctrl('['));
    ed.handle_key(Key::char('<'));
    assert_eq!(ed.window_buffer().point(), 0);
    ed.press("C-[ >").unwrap();
    assert_eq!(ed.window_buffer().point(), 3);
}
