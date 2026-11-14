//! Help (ADR 0064): describing keys, commands, variables, modes and
//! symbols, listing the keys, apropos, help on help, and the *Help*
//! buffer's links and history.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(100, 40);
    (ed, scripting)
}

fn buffer_text(ed: &Editor, name: &str) -> String {
    let i = ed.find_buffer(name).unwrap_or_else(|| panic!("no buffer {name}"));
    let b = &ed.buffers()[i];
    b.slice(0..b.len())
}

fn help(ed: &Editor) -> String {
    buffer_text(ed, "*Help*")
}

#[test]
fn describe_key_and_command() {
    let (mut ed, _s) = setup();
    ed.press("C-h k C-x C-f").unwrap();
    let shown = ed.windows().into_iter().any(|w| w.buffer.name == "*Help*");
    assert!(shown, "*Help* is shown in a window");
    assert!(help(&ed).starts_with("C-x C-f runs the command find-file.\n\nfind-file is a command"), "{}", help(&ed));
    assert!(help(&ed).contains("It is bound to C-x C-f"), "{}", help(&ed));
    assert!(help(&ed).contains("file (file name)"), "{}", help(&ed));
    // Help is read-only.
    ed.press("C-x o").unwrap();
    ed.type_text("x");
    assert_eq!(ed.echo(), Some("Buffer is read-only: #<buffer *Help*>"));

    ed.press("C-h f").unwrap();
    ed.type_text("kill-line");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("kill-line is a command.\n\nIt is bound to C-k."), "{}", help(&ed));
    assert!(help(&ed).contains("It is bound to C-k."), "{}", help(&ed));

    ed.press("C-h x").unwrap();
    ed.type_text("forward-char");
    ed.press("RET").unwrap();
    assert!(help(&ed).contains("With Shift held, it selects text"), "{}", help(&ed));

    ed.press("C-h k a").unwrap();
    assert!(help(&ed).starts_with("a runs the command self-insert-command."), "{}", help(&ed));
}

#[test]
fn a_function_that_is_not_a_command_and_an_undefined_key() {
    let (mut ed, s) = setup();
    s.eval_typescript(&mut ed, "test.ts", r#"e8.defun("my-helper", () => 1);"#.to_string()).unwrap();
    ed.press("C-h f").unwrap();
    ed.type_text("my-helper");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("my-helper is a function defined with e8.defun"), "{}", help(&ed));
    ed.press("C-h k C-x C-y").unwrap();
    assert_eq!(ed.echo(), Some("C-x C-y is undefined"));
}

#[test]
fn describe_key_briefly_and_where_is() {
    let (mut ed, _s) = setup();
    ed.press("C-h c C-x C-f").unwrap();
    assert_eq!(ed.echo(), Some("C-x C-f runs the command find-file"));
    ed.press("C-h c C-x C-y").unwrap();
    assert_eq!(ed.echo(), Some("C-x C-y is undefined"));
    ed.press("C-h w").unwrap();
    ed.type_text("find-file");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("find-file is on C-x C-f"));
    ed.press("C-h w").unwrap();
    ed.type_text("describe-symbol");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("describe-symbol is on C-h o, <f1> o"));
    ed.press("C-h w").unwrap();
    ed.type_text("apropos");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("apropos is not on any key"));
}

#[test]
fn describe_bindings_lists_the_modes_and_global_keys() {
    let (mut ed, _s) = setup();
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-h b").unwrap();
    let text = help(&ed);
    // As Emacs's describe-buffer-bindings lays it out: each section after
    // a page break, the key column padded with tabs.
    let major = text.find("\x0C\n`org-mode' Major Mode Bindings:\n").expect("the major mode's section");
    let global = text.find("\x0C\nGlobal Bindings:\n").expect("the global section");
    assert!(major < global, "{text}");
    assert!(text[major..global].contains("\nC-c C-c\t"), "{text}");
    assert!(text[major..global].contains("\torg-ctrl-c-ctrl-c\n"), "{text}");
    assert!(text[global..].contains("\nC-x C-f\t"), "{text}");
    // A line of dashes the window's width less one, as make-separator-line draws it.
    let rule = text.split("Key             Binding\n").nth(1).and_then(|rest| rest.lines().next()).unwrap_or_default();
    assert!(rule.len() > 20 && rule.chars().all(|c| c == '-'), "{text}");
}

#[test]
fn c_h_after_a_prefix_lists_the_keys_under_it() {
    let (mut ed, _s) = setup();
    ed.press("C-x C-h").unwrap();
    let text = help(&ed);
    // As Emacs's describe-prefix-bindings, the buffer's bindings under the prefix.
    assert!(text.contains("Global Bindings Starting With C-x:\n\nKey             Binding\n"), "{text}");
    assert!(text.contains("\nC-x C-f\t"), "{text}");
    assert!(text.contains("\nC-x 4 f\t"), "{text}");
    assert!(!text.contains("C-h k"), "only the keys under the prefix: {text}");
    // <f1> is help too, and a prefix that binds C-h itself keeps its binding.
    ed.press("C-x 4 <f1>").unwrap();
    assert!(help(&ed).contains("Global Bindings Starting With C-x 4:\n"), "{}", help(&ed));
    ed.press("C-c @ C-h").unwrap();
    assert_ne!(ed.echo(), Some("C-c @ C-h is undefined"));
}

#[test]
fn apropos_finds_commands_variables_and_faces() {
    let (mut ed, _s) = setup();
    ed.press("C-h a").unwrap();
    ed.type_text("kill-line");
    ed.press("RET").unwrap();
    let text = buffer_text(&ed, "*Apropos*");
    assert!(text.contains("\nkill-line                     C-k\n  Command: Kill the rest of the line"), "{text}");
    assert!(text.starts_with("dired-do-kill-lines           M-x dired-do-kill-lines\n  Command: "), "a regexp, matching anywhere: {text}");
    // Words separated by spaces: a name containing any of them.
    ed.press("M-x").unwrap();
    ed.type_text("apropos-variable\n");
    ed.type_text("fill-column tab-width");
    ed.press("RET").unwrap();
    let text = buffer_text(&ed, "*Apropos*");
    assert!(text.starts_with("fill-column\n  Variable: "), "{text}");
    assert!(text.contains("\ntab-width\n  Variable: "), "{text}");
    ed.press("M-x").unwrap();
    ed.type_text("apropos\n");
    ed.type_text("^link$");
    ed.press("RET").unwrap();
    let text = buffer_text(&ed, "*Apropos*");
    assert!(text.starts_with("link\n  Face: Links."), "{text}");
    ed.press("C-h a").unwrap();
    ed.type_text("no-such-command-anywhere");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("No matches for \"no-such-command-anywhere\""));
}

#[test]
fn help_for_help_lists_the_help_keys() {
    let (mut ed, _s) = setup();
    ed.press("C-h ?").unwrap();
    let text = help(&ed);
    assert!(text.contains("C-h k     describe-key: Show which command a key sequence runs"), "{text}");
    assert!(text.contains("C-h a     apropos-command: "), "{text}");
    ed.press("C-h C-h").unwrap();
    assert_eq!(help(&ed), text);
}

#[test]
fn links_tab_moves_between_and_ret_follows_and_l_goes_back() {
    let (mut ed, _s) = setup();
    ed.press("C-h k C-x C-f").unwrap();
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "*Help*");
    // TAB goes to the first name, the command the key runs.
    ed.press("TAB").unwrap();
    assert_eq!(ed.window_buffer().point(), "C-x C-f runs the command ".len());
    ed.press("TAB").unwrap();
    assert_eq!(ed.window_buffer().point(), "C-x C-f runs the command find-file.\n\n".len());
    ed.press("<backtab>").unwrap();
    assert_eq!(ed.window_buffer().point(), "C-x C-f runs the command ".len());
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("find-file is a command"), "{}", help(&ed));
    assert_eq!(ed.window_buffer().point(), 0);
    ed.press("l").unwrap();
    assert!(help(&ed).starts_with("C-x C-f runs the command find-file."), "{}", help(&ed));
    ed.press("l").unwrap();
    assert_eq!(ed.echo(), Some("No previous help buffer"));
    ed.press("r").unwrap();
    assert!(help(&ed).starts_with("find-file is a command"), "{}", help(&ed));
    ed.press("r").unwrap();
    assert_eq!(ed.echo(), Some("No next help buffer"));
    // RET on a name that is not a button describes it too, as help-follow-symbol.
    ed.press("C-h v").unwrap();
    ed.type_text("fill-column");
    ed.press("RET").unwrap();
    ed.press("M->").unwrap();
    ed.press("C-s").unwrap();
    ed.type_text("fill-column");
    ed.press("RET").unwrap();
    assert!(ed.window_buffer().point() > 0, "found a later mention");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("fill-column is a variable"), "{}", help(&ed));
    ed.press("q").unwrap();
    assert_ne!(ed.window_buffer().name, "*Help*");
}

#[test]
fn describe_symbol_takes_the_name_at_point() {
    let (mut ed, _s) = setup();
    ed.type_text("see kill-line here");
    ed.press("M-b M-b").unwrap();
    ed.press("C-h o RET").unwrap();
    assert!(help(&ed).starts_with("kill-line is a command"), "{}", help(&ed));
    // A name that is a command and a variable shows both.
    ed.press("C-h o").unwrap();
    ed.type_text("fill-column");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("fill-column is a variable"), "{}", help(&ed));
    ed.press("C-h o").unwrap();
    ed.type_text("no-such-thing");
    ed.press("RET").unwrap();
    assert_eq!(ed.echo(), Some("no-such-thing is not a command, a variable or a face"));
}

#[test]
fn describe_mode_shows_the_doc_and_the_keys() {
    let (mut ed, _s) = setup();
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-h m").unwrap();
    let text = help(&ed);
    assert!(text.starts_with("The major mode is Org mode (org-mode), defined in packages/org.ts:\n\n"), "{text}");
    assert!(text.contains("\nKey bindings:\nKey             Binding\n"), "{text}");
    assert!(text.contains("C-c C-c         org-ctrl-c-ctrl-c\n"), "{text}");
}

#[test]
fn describe_key_follows_shift_translation_and_names_the_wheel() {
    let (mut ed, _s) = setup();
    ed.type_text("abc");
    ed.press("C-h k S-<right>").unwrap();
    assert!(help(&ed).starts_with("S-<right> runs the command right-char."), "{}", help(&ed));
    assert!(help(&ed).contains("shift selection"), "{}", help(&ed));
    ed.press("C-h k <wheel-down>").unwrap();
    assert!(help(&ed).starts_with("<wheel-down> runs the command mwheel-scroll."), "{}", help(&ed));
}
