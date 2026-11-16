//! M-/ looking in other buffers, which the Emacs comparison cannot check
//! reliably, as batch Emacs's own buffers hold words of their own.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

#[test]
fn m_slash_finds_words_in_other_buffers() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("other".into())]).unwrap();
    ed.type_text("zebrafish");
    ed.call("switch-to-buffer", vec![Arg::Str("here".into())]).unwrap();
    ed.type_text("zeb");
    ed.press("M-/").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "zebrafish");
    assert_eq!(ed.echo(), Some("Expansion found in \u{2018}other\u{2019}"));
    ed.press("M-/").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("No further dynamic expansion for \u{2018}zeb\u{2019} found".into()));
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "zeb");
}

/// Each M-/ that starts an expansion frees the marker the last one kept,
/// so expanding many times leaves no markers piling up in the buffer.
#[test]
fn expanding_again_and_again_leaves_no_markers_behind() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.type_text("alpha beta ");
    ed.type_text("al");
    ed.press("M-/").unwrap();
    let after_one = ed.window_buffer().marker_count();
    for _ in 0..5 {
        ed.type_text(" be");
        ed.press("M-/").unwrap();
        ed.type_text(" al");
        ed.press("M-/").unwrap();
    }
    assert_eq!(ed.window_buffer().marker_count(), after_one);
}
