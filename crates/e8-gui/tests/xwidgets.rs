//! xwidgets in the window (ADR 0089): where a window shows an xwidget's
//! glyph, the editor hears of it as the xwidget's view in that window, and
//! of the view's going when the glyph does. A test's window has no native
//! handle to put web views in, so it draws the box Wayland's windows show.

#![cfg(feature = "xwidgets")]

use e8_core::{Editor, Value};
use e8_gui::E8App;
use egui::vec2;
use egui_kittest::Harness;

fn sym(s: &str) -> Value {
    Value::Symbol(s.into())
}

/// Puts a 200x100 xwidget on the first character of "ab", as
/// `xwidget-insert` does, keeping it in `test-xwidget`, as values stay on
/// the editor's thread.
fn insert_xwidget(ed: &mut Editor) {
    assert!(ed.xwidgets_shown(), "the GUI's metrics show web views");
    let xw = ed.make_xwidget("webkit", Value::Str("Example".into()), 200, 100, None, &Value::Null).expect("made");
    ed.type_text("ab");
    let spec = Value::List(vec![sym("xwidget"), sym(":xwidget"), xw.clone()]);
    ed.buffer_mut().put_text_property(0..1, "display", spec);
    ed.set_variable("test-xwidget", xw);
}

/// The size of the test's xwidget's view in the selected window, if it has one.
fn view_size(ed: &mut Editor) -> Option<(f64, f64)> {
    let xw = ed.variable("test-xwidget").expect("made");
    let view = ed.xwidget_view_lookup(&xw, None).expect("an xwidget")?;
    let Ok(Value::List(info)) = ed.xwidget_view_info(&view) else { panic!("view info") };
    let n = |v: &Value| if let Value::Number(n) = v { *n } else { panic!("a number") };
    Some((n(&info[2]), n(&info[3])))
}

#[test]
fn a_shown_xwidget_has_a_view_in_its_window_until_it_goes() {
    let mut h = Harness::builder().with_size(vec2(640.0, 400.0)).build_eframe(|cc| {
        e8_gui::theme::install_fonts(&cc.egui_ctx, false);
        E8App::new(Editor::new()).silent()
    });
    h.run_steps(2);
    h.state_mut().with_editor(insert_xwidget);
    h.run_steps(3);
    assert_eq!(h.state_mut().with_editor(view_size), Some((200.0, 100.0)));
    h.state_mut().with_editor(|ed| {
        let len = ed.buffer().len();
        ed.delete_region(0, len).expect("deleted");
    });
    h.run_steps(3);
    assert_eq!(h.state_mut().with_editor(view_size), None);
}

#[test]
fn the_editor_on_its_own_thread_hears_of_views_too() {
    let mut h = Harness::builder().with_size(vec2(640.0, 400.0)).build_eframe(|cc| {
        e8_gui::theme::install_fonts(&cc.egui_ctx, false);
        E8App::threaded(&cc.egui_ctx, |_| None).silent()
    });
    h.run_steps(2);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    // The editor's metrics come from the window's first frames.
    while !h.state_mut().with_editor(|ed| ed.xwidgets_shown()) {
        assert!(std::time::Instant::now() < until, "timed out");
        h.step();
    }
    h.state_mut().with_editor(insert_xwidget);
    loop {
        h.step();
        if h.state_mut().with_editor(view_size) == Some((200.0, 100.0)) {
            break;
        }
        assert!(std::time::Instant::now() < until, "timed out");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
