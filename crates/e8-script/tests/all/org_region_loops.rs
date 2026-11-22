//! Org's commands over an active region, called from code.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// A date given in the call is used for every heading of the region, as
/// (org-schedule nil TIME) uses TIME for each, so a tool call asks nothing.
#[test]
fn a_date_from_code_plans_every_heading() {
    let (mut ed, _scripting) = org("* one\n** two\n* three\n");
    ed.set_input_source(|ed| panic!("asked {:?}", ed.prompt()));
    ed.press("C-SPC M->").unwrap();
    ed.call("org-deadline", vec![e8_core::Arg::Str("2026-11-06".into())]).unwrap();
    assert_eq!(
        text(&ed),
        "* one\nDEADLINE: <2026-11-06 Fri>\n** two\nDEADLINE: <2026-11-06 Fri>\n* three\nDEADLINE: <2026-11-06 Fri>\n"
    );
}
