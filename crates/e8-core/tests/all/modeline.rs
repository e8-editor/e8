//! The mode line, as Emacs formats `mode-line-format`: the core formats each
//! window's at redisplay, and front ends draw what it gives.

use e8_core::{Editor, Function, Value};

fn line(ed: &mut Editor) -> String {
    ed.redisplay();
    let id = ed.selected_window();
    ed.mode_line(id).iter().map(|s| s.text.as_str()).collect()
}

fn sym(name: &str) -> Value {
    Value::Symbol(name.into())
}

fn s(text: &str) -> Value {
    Value::Str(text.into())
}

fn list(items: Vec<Value>) -> Value {
    Value::List(items)
}

#[test]
fn the_default_shows_the_coding_flags_name_position_and_modes() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.type_text("one\ntwo");
    let shown = line(&mut ed);
    assert_eq!(shown, format!("U:**-  *scratch*          L2     C3    (Fundamental) {}", "-".repeat(7)));
    assert_eq!(shown.chars().count(), 60, "dashes fill the mode line");
    ed.press("C-SPC C-a C-x n n").unwrap();
    ed.start_kbd_macro().unwrap();
    assert!(line(&mut ed).contains("(Fundamental Narrow Def)"), "{}", line(&mut ed));
}

#[test]
fn constructs_are_emacs_s() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.type_text("abc");
    let format = |ed: &mut Editor, v: Value| ed.format_mode_line(&v).unwrap().into_iter().map(|s| s.text).collect::<String>();
    // A symbol's string value shows as it is, its %-specs not read.
    ed.set_variable("my-var", s("100%b"));
    assert_eq!(format(&mut ed, list(vec![s("%b "), sym("my-var")])), "*scratch* 100%b");
    // A list that starts with a symbol is a conditional.
    ed.set_variable("my-flag", Value::Bool(false));
    assert_eq!(format(&mut ed, list(vec![sym("my-flag"), s("yes"), s("no")])), "no");
    // A width pads on the right, or with a minus cuts.
    assert_eq!(format(&mut ed, list(vec![Value::Number(6.0), s("%c")])), "3     ");
    assert_eq!(format(&mut ed, list(vec![Value::Number(-4.0), s("%b")])), "*scr");
    assert_eq!(format(&mut ed, s("[%5l|%3b]")), "[    1|*scratch*]");
    // :eval calls a function and formats what it returns.
    let f = Function::new(None, |ed, _| Ok(Value::Str(format!("{} chars", ed.buffer().len()))));
    assert_eq!(format(&mut ed, list(vec![sym(":eval"), Value::Function(f)])), "3 chars");
    // :propertize gives faces.
    let segments = ed.format_mode_line(&list(vec![s("a"), list(vec![sym(":propertize"), s("b"), s("face"), s("bold")])])).unwrap();
    assert_eq!(segments[1].text, "b");
    assert_eq!(segments[1].faces, ["bold"]);
}

#[test]
fn each_buffer_can_have_its_own_and_minor_modes_show_their_lighters() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    ed.make_local_variable("mode-line-format");
    ed.set_variable("mode-line-format", list(vec![s("only "), s("%b")]));
    assert_eq!(line(&mut ed), "only *scratch*");
    ed.press("C-x b").unwrap();
    ed.type_text("other");
    ed.press("RET").unwrap();
    assert!(line(&mut ed).starts_with("U:---  other"), "{}", line(&mut ed));
    ed.register_minor_mode(e8_core::MinorMode { name: "test-mode".into(), lighter: " Test".into(), keymap: None, global: false });
    ed.make_local_variable("test-mode");
    ed.set_variable("test-mode", Value::Bool(true));
    assert!(line(&mut ed).contains("(Fundamental Test)"), "{}", line(&mut ed));
    // A buffer's process state follows its mode's name, as a shell's :run does.
    ed.set_variable("mode-line-process", s(":run"));
    assert!(line(&mut ed).contains("(Fundamental:run Test)"), "{}", line(&mut ed));
    ed.press("C-x b").unwrap();
    ed.type_text("third");
    ed.press("RET").unwrap();
    assert!(line(&mut ed).contains("(Fundamental)"), "only that buffer's: {}", line(&mut ed));
    ed.set_variable("test-mode", Value::Bool(false));
    assert!(line(&mut ed).contains("(Fundamental)"), "{}", line(&mut ed));
}

#[test]
fn a_field_width_cuts_text_after_other_text_and_errors_leave_one_construct_out() {
    let mut ed = Editor::new();
    let format = |ed: &mut Editor, v: Value| ed.format_mode_line(&v).unwrap().into_iter().map(|s| s.text).collect::<String>();
    assert_eq!(format(&mut ed, list(vec![s("ab"), list(vec![Value::Number(-1.0), s("cd")])])), "abc");
    assert_eq!(format(&mut ed, list(vec![s(" "), list(vec![Value::Number(-3.0), s("%b")])])), " *sc");
    assert_eq!(format(&mut ed, list(vec![Value::Bool(true), s("yes"), s("no")])), "yes");
    assert_eq!(format(&mut ed, list(vec![sym("t"), s("yes"), s("no")])), "yes");
    let boom = Function::new(None, |_, _| Err(e8_core::Error::new("boom")));
    assert_eq!(format(&mut ed, list(vec![s("a"), list(vec![sym(":eval"), Value::Function(boom)]), s("b")])), "ab");
    assert!(ed.messages().iter().any(|m| m.contains("Error during redisplay: boom")));
}

#[test]
fn a_header_line_shows_above_the_text_of_windows_whose_buffer_has_a_format() {
    let mut ed = Editor::new();
    ed.set_frame_size(40, 10);
    let id = ed.selected_window();
    assert_eq!(ed.window_size(id).map(|s| s.1), Some(9), "no header line by default");
    ed.set_variable("header-line-format", list(vec![s("Header %b")]));
    ed.set_frame_size(40, 10);
    ed.redisplay();
    assert!(ed.window_wants_header_line(id, 10));
    assert_eq!(ed.window_size(id).map(|s| s.1), Some(8), "the header line takes a line from the text");
    let header: String = ed.header_line(id).unwrap().iter().map(|s| s.text.as_str()).collect();
    assert_eq!(header, "Header *scratch*");
    // A window two lines high has no room for one, as in Emacs.
    assert!(!ed.window_wants_header_line(id, 2));
    // The window's parameter takes the buffer's place, and none hides it.
    ed.set_window_parameter(id, "header-line-format", s("Mine")).unwrap();
    ed.redisplay();
    assert_eq!(ed.header_line(id).unwrap()[0].text, "Mine");
    ed.set_window_parameter(id, "header-line-format", sym("none")).unwrap();
    ed.redisplay();
    assert!(ed.header_line(id).is_none());
    assert!(!ed.window_wants_header_line(id, 10));
    // Other buffers have none: the variable is buffer-local.
    ed.set_window_parameter(id, "header-line-format", Value::Null).unwrap();
    ed.switch_to_buffer("other");
    ed.redisplay();
    assert!(ed.header_line(id).is_none());
}

#[test]
fn align_to_spaces_line_titles_up_at_columns() {
    use e8_core::{Props, Text};
    let mut ed = Editor::new();
    let space = |column: Value| {
        let mut props = Props::new();
        props.insert("display".into(), list(vec![sym("space"), sym(":align-to"), column]));
        Value::Text(Text::propertize(" ", props))
    };
    let format = list(vec![s("Name"), space(Value::Number(8.0)), s("Size"), space(list(vec![sym("+"), sym("header-line-indent-width"), Value::Number(15.0)])), s("Mode")]);
    let text: String = ed.format_mode_line(&format).unwrap().into_iter().map(|s| s.text).collect();
    assert_eq!(text, "Name    Size   Mode");
    ed.set_variable("header-line-indent-width", Value::Number(3.0));
    let text: String = ed.format_mode_line(&format).unwrap().into_iter().map(|s| s.text).collect();
    assert_eq!(text, "Name    Size      Mode");
}

/// %c is the column on the screen, as current-column counts it: a tab to
/// its stop and a wide character as two, as Emacs shows "C11" after "\tfoo".
#[test]
fn the_column_counts_tabs_and_wide_characters() {
    let mut ed = Editor::new();
    ed.set_frame_size(60, 10);
    let format = |ed: &mut Editor| ed.format_mode_line(&s("%c")).unwrap().into_iter().map(|s| s.text).collect::<String>();
    ed.type_text("\tfoo");
    assert_eq!(format(&mut ed), "11");
    ed.type_text("\n日本");
    assert_eq!(format(&mut ed), "4");
}
