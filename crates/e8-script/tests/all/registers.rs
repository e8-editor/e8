//! Registers, typed as keys: batch Emacs cannot answer their prompts, so
//! these are what Emacs 30.2 does interactively.

use e8_core::Editor;
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.press("M-<").unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

#[test]
fn positions_text_and_numbers_go_in_registers() {
    let (mut ed, _s) = setup("abcdef\nghijkl\n");
    // A position, and back to it after moving.
    ed.press("C-n C-f C-f C-x r SPC a M-> C-x r j a").unwrap();
    assert_eq!(point(&ed), 9);
    // Text, inserted with point before it, or after with C-u.
    ed.press("M-< C-SPC C-f C-f C-f C-x r s b M-> C-x r i b").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabc");
    assert_eq!(point(&ed), 14);
    ed.press("M-> C-u C-x r i b").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabcabc");
    assert_eq!(point(&ed), 20);
    // Numbers, incremented and inserted.
    ed.press("C-u 5 C-x r n n C-u 3 C-x r + n C-x r + n M-> C-x r i n").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nabcabc9");
    // An empty register says so.
    ed.press("C-x r j z").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Register doesn\u{2019}t contain a buffer position or configuration".into()));
}

#[test]
fn a_rectangle_goes_in_a_register() {
    let (mut ed, _s) = setup("abcdef\nghijkl\n");
    ed.press("C-f C-SPC C-n C-f C-f C-x r r r M-> C-x r i r").unwrap();
    assert_eq!(text(&ed), "abcdef\nghijkl\nbc\nhi");
}

/// Storing a position again in a register frees the marker the old one
/// held, and so does making *Occur* again for its lines, so the markers
/// every edit has to move do not pile up.
#[test]
fn registers_and_occur_free_the_markers_they_replace() {
    let (mut ed, _s) = setup("foo bar\nfoo baz\nfoo\n");
    let markers = |ed: &Editor| ed.window_buffer().marker_count();
    ed.press("C-x r SPC a").unwrap();
    let once = markers(&ed);
    ed.press("C-n C-x r SPC a C-n C-x r w a C-n C-x r SPC a").unwrap();
    assert_eq!(markers(&ed), once);
    ed.press("M-< C-x r j a").unwrap();
    assert_eq!(point(&ed), 20);
    ed.press("M-s o f o o RET").unwrap();
    let listed = markers(&ed);
    assert!(listed > once, "occur keeps a marker for each match");
    let mut counts = vec![];
    for _ in 0..3 {
        ed.press("M-s o f o o RET").unwrap();
        counts.push(markers(&ed));
    }
    assert_eq!(counts, [listed; 3], "from {once} to {listed}");
}
