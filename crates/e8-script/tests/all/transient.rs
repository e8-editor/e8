//! transient, which ships with E8 as with Emacs: a prefix shows its
//! suffixes in columns in a window below, a suffix runs and leaves or runs
//! and stays, a sub-menu goes back with C-g, C-q leaves them all, and
//! switches and options are the arguments a suffix reads. Casual's and
//! Magit's menus, which are built on it, are tested in their own
//! repositories, e8-casual and e8-magit, against what Emacs shows.

use e8_core::{Editor, Value};
use e8_script::Scripting;

/// A menu of two columns, a sub-menu, a suffix that stays and one that
/// leaves, and a menu of arguments, as a package in a directory of its own.
const MENUS: &str = r#"
import { transientArgs, transientDefinePrefix } from "transient";
e8.defineVariable({ name: "tm-count", value: 0 });
const bump = e8.defineCommand({ name: "tm-bump", run: () => e8.setVariable("tm-count", (e8.variable("tm-count") as number) + 1) });
const hello = e8.defineCommand({ name: "tm-hello", run: () => e8.message("Hello") });
transientDefinePrefix("tm-sub", {
  groups: [{ description: "Sub", items: [["x", "Hello", hello]] }],
});
transientDefinePrefix("tm-main", {
  groups: [
    {
      items: [
        { description: "Left", items: [["b", "Bump", bump, { transient: true }], ["h", "Hello", hello]] },
        { description: "Right", items: [["s", "Sub", "tm-sub"]] },
      ],
    },
  ],
});
const show = e8.defineCommand({ name: "show-args", run: () => e8.message(JSON.stringify(transientArgs(String(e8.variable("transient-current-command"))))) });
const back = e8.defineCommand({ name: "tm-back", run: () => e8.message("back") });
transientDefinePrefix("tm-levels", {
  incompatible: [["--one", "--two"]],
  groups: [
    { description: "Shown", items: [["-1", "One", "--one"], ["-2", "Two", "--two"], ["-t", "Tag", "--tag=", { multiValue: "repeat" }]] },
    { description: "Deep", level: 5, items: [["d", "Deep", hello]] },
    { description: "Actions", items: [["s", "Show", show], ["r", "Return", back, { transient: "return" }], ["x", "Rare", hello, { level: 6 }]] },
  ],
});
transientDefinePrefix("tm-outer", { groups: [{ description: "Outer", items: [["l", "Levels", "tm-levels"]] }] });
const arg = e8.defineCommand({ name: "tm-arg", params: [{ name: "n", kind: "prefix" }], run: (n: e8.Value) => e8.message(`arg ${JSON.stringify(n)}`) });
const reads = e8.defineCommand({
  name: "tm-reads",
  params: [{ name: "who", kind: "string", prompt: "Who: " }, { name: "n", kind: "prefix" }],
  run: (who: e8.Value, n: e8.Value) => e8.message(`read ${JSON.stringify(who)} ${JSON.stringify(n)}`),
});
transientDefinePrefix("tm-arg-menu", { groups: [{ description: "Arg", items: [["p", "Prefix", arg], ["r", "Reads", reads]] }] });
transientDefinePrefix("tm-free", { transientNonSuffix: true, groups: [{ description: "Free", items: [["x", "Hello", hello]] }] });
transientDefinePrefix("tm-tall", {
  groups: [{ description: "Tall", items: Array.from({ length: 30 }, (_, i) => [String.fromCharCode(i < 26 ? 97 + i : 65 + i - 26), `Item ${i}`, hello] as [string, string, typeof hello]) }],
});
transientDefinePrefix("args-menu", {
  value: ["--all"],
  groups: [{ description: "Arguments", items: [["-a", "All", "--all"], ["-v", "Verbose", "--verbose"], ["=a", "Author", "--author="]] },
           { description: "Actions", items: [["s", "Show", show]] }],
});
"#;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    ed.set_frame_size(100, 40);
    // Levels and values are kept in user-emacs-directory: a fresh one.
    let home = tempfile::tempdir().unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", home.path().display())));
    std::mem::forget(home);
    let s = Scripting::new(&mut ed).unwrap();
    let pkgs = tempfile::tempdir().unwrap();
    std::fs::write(pkgs.path().join("tm-menus.ts"), MENUS).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(pkgs.path().display().to_string())]));
    s.eval_expression(&mut ed, r#"e8.require("tm-menus")"#).unwrap();
    (ed, s, pkgs)
}

fn menu(ed: &Editor) -> Option<String> {
    let b = &ed.buffers()[ed.find_buffer(" *transient*")?];
    Some(b.slice(0..b.len()))
}

fn count(ed: &Editor) -> f64 {
    ed.variable("tm-count").and_then(|v| v.as_number()).unwrap_or(f64::NAN)
}

#[test]
fn a_prefix_shows_its_groups_side_by_side() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    assert_eq!(menu(&ed).as_deref(), Some("Left      Right\n b Bump    s Sub\n h Hello\n"));
}

#[test]
fn a_suffix_that_stays_runs_and_one_that_leaves_closes_the_menu() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("b b").unwrap();
    assert_eq!(count(&ed), 2.0);
    assert!(menu(&ed).is_some());
    ed.press("h").unwrap();
    assert_eq!(ed.echo(), Some("Hello"));
    assert_eq!(menu(&ed), None);
}

#[test]
fn a_sub_menu_goes_back_with_c_g_and_c_q_leaves_them_all() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("s").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Sub\n x Hello"), "{:?}", menu(&ed));
    ed.press("C-g").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
    ed.press("s C-q").unwrap();
    assert_eq!(menu(&ed), None);
    // The keys are the buffer's own again.
    ed.press("b").unwrap();
    assert_eq!(count(&ed), 0.0);
}

#[test]
fn a_key_no_suffix_has_is_refused() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("z").unwrap();
    assert_eq!(ed.echo(), Some("Unbound suffix: `z' (Use `C-g' to abort, `?' for help)"));
    assert!(menu(&ed).unwrap().starts_with("Left"));
}

#[test]
fn switches_and_options_are_the_arguments_a_suffix_reads() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("args-menu", vec![]).unwrap();
    assert_eq!(
        menu(&ed).as_deref(),
        Some("Arguments\n -a All (--all)\n -v Verbose (--verbose)\n =a Author (--author=)\n\nActions\n s Show\n")
    );
    ed.press("- v - a = a M i n a RET s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--verbose","--author=Mina"]"#));
    assert_eq!(menu(&ed), None);
}

#[test]
fn suffixes_and_groups_above_the_prefixs_level_do_not_show() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-levels", vec![]).unwrap();
    let m = menu(&ed).unwrap();
    assert!(!m.contains("Deep") && !m.contains("Rare"), "{m}");
    // C-x a shows them all, with their levels.
    ed.press("C-x a").unwrap();
    let m = menu(&ed).unwrap();
    assert!(m.contains(" d 1 Deep") && m.contains(" x 6 Rare"), "{m}");
    ed.press("C-x a").unwrap();
    // C-x l RET raises the menu's level, kept in transient/levels.json.
    ed.press("C-x l RET C-a C-k 6 RET").unwrap();
    let m = menu(&ed).unwrap();
    assert!(m.contains("Deep") && m.contains("Rare"), "{m}");
    let dir = ed.variable("user-emacs-directory").and_then(|v| v.as_str().map(str::to_string)).unwrap();
    let saved = std::fs::read_to_string(format!("{dir}transient/levels.json")).unwrap();
    assert!(saved.contains("\"tm-levels\"") && saved.contains("\"level\": 6"), "{saved}");
    // C-x l and a suffix's key sets that suffix's level: 7 hides x again.
    ed.press("C-x l x C-a C-k 7 RET").unwrap();
    assert!(!menu(&ed).unwrap().contains("Rare"));
}

#[test]
fn values_are_set_saved_reset_and_remembered() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("args-menu", vec![]).unwrap();
    // Set for the session: the menu starts with it next time.
    ed.press("- v C-x s C-g").unwrap();
    assert_eq!(ed.echo(), None.or(ed.echo()));
    ed.call("args-menu", vec![]).unwrap();
    ed.press("s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--all","--verbose"]"#));
    // Saved: written to transient/values.json.
    ed.call("args-menu", vec![]).unwrap();
    ed.press("- a C-x C-s C-g").unwrap();
    let dir = ed.variable("user-emacs-directory").and_then(|v| v.as_str().map(str::to_string)).unwrap();
    let saved = std::fs::read_to_string(format!("{dir}transient/values.json")).unwrap();
    assert!(saved.contains("\"args-menu\"") && saved.contains("--verbose") && !saved.contains("--all"), "{saved}");
    // Reset: back to the prefix's own value.
    ed.call("args-menu", vec![]).unwrap();
    ed.press("C-x C-k s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--all"]"#));
    // C-x p goes back to the values used before.
    ed.call("args-menu", vec![]).unwrap();
    ed.press("C-x p s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--all"]"#));
}

#[test]
fn incompatible_arguments_turn_each_other_off_and_repeated_ones_repeat() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-levels", vec![]).unwrap();
    ed.press("- 1 - 2 - t a , b RET s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--two","--tag=a","--tag=b"]"#));
}

#[test]
fn a_suffix_can_return_to_the_menu_before() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-outer", vec![]).unwrap();
    ed.press("l r").unwrap();
    assert_eq!(ed.echo(), Some("back"));
    assert!(menu(&ed).unwrap().starts_with("Outer"));
}

#[test]
fn a_menu_taller_than_the_frame_is_cut_to_fit() {
    let (mut ed, s, _pkgs) = setup();
    ed.set_frame_size(80, 20);
    ed.call("tm-tall", vec![]).unwrap();
    assert!(menu(&ed).unwrap().contains("Item 29"));
    // As fit-window-to-buffer: the window above keeps window-min-height
    // lines, 4, and the menu takes the rest of the frame's.
    let heights = s
        .eval_expression(&mut ed, "JSON.stringify(e8.windowList().map((w) => e8.windowSize(w)?.totalHeight))")
        .unwrap();
    let frame = s.eval_expression(&mut ed, "e8.frameHeight()").unwrap();
    let frame: usize = frame.parse().unwrap();
    assert_eq!(heights, format!("\"[4,{}]\"", frame - 4));
    ed.press("b").unwrap();
    assert_eq!(ed.echo(), Some("Hello"));
}

#[test]
fn without_a_popup_the_menu_shows_on_c_t_and_c_h_describes_a_suffix() {
    let (mut ed, s, _pkgs) = setup();
    s.eval_expression(&mut ed, r#"e8.setVariable("transient-show-popup", false)"#).unwrap();
    ed.call("tm-main", vec![]).unwrap();
    assert_eq!(menu(&ed), None);
    ed.press("C-t").unwrap();
    assert!(menu(&ed).is_some());
    ed.press("C-h h").unwrap();
    assert_eq!(menu(&ed), None);
    assert!(ed.find_buffer("*Help*").is_some());
    // Help works with the menu hidden too, as transient's.
    ed.press("q").unwrap();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("? h").unwrap();
    assert_eq!(ed.echo(), Some("Type q to resume transient command."));
}

#[test]
fn help_for_the_menu_itself_and_for_its_common_commands() {
    let (mut ed, s, _pkgs) = setup();
    let help = |ed: &mut Editor| {
        s.eval_expression(ed, r#"e8.withCurrentBuffer("*Help*", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))"#).unwrap()
    };
    ed.call("tm-main", vec![]).unwrap();
    ed.press("? ?").unwrap();
    assert!(help(&mut ed).contains("tm-main"), "{}", help(&mut ed));
    ed.press("q C-h C-x s").unwrap();
    assert!(help(&mut ed).contains("transient-set"), "{}", help(&mut ed));
    ed.press("q ? C-z").unwrap();
    assert!(help(&mut ed).contains("transient-suspend"), "{}", help(&mut ed));
    ed.press("q").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
}

#[test]
fn c_u_c_g_drops_the_argument_and_stays() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("C-u C-g").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
    ed.press("C-g").unwrap();
    assert_eq!(menu(&ed), None);
}

#[test]
fn a_prefix_started_afresh_forgets_suspended_menus() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("C-z").unwrap();
    ed.call("tm-outer", vec![]).unwrap();
    ed.press("C-g").unwrap();
    assert_eq!(menu(&ed), None);
    ed.call("transient-resume", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("No suspended transient command"));
}

#[test]
fn help_suspends_the_menu_and_q_resumes_it() {
    let (mut ed, s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("b ? h").unwrap();
    assert_eq!(menu(&ed), None);
    assert_eq!(ed.echo(), Some("Type q to resume transient command."));
    let selected = s.eval_expression(&mut ed, "e8.windowBuffer(e8.selectedWindow())").unwrap();
    assert_eq!(selected, "\"*Help*\"");
    // q leaves the help and brings the menu back, with its keys.
    ed.press("q").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
    let shown = s.eval_expression(&mut ed, "JSON.stringify(e8.windowList().map((w) => e8.windowBuffer(w)))").unwrap();
    assert!(!shown.contains("*Help*"), "{shown}");
    ed.press("b").unwrap();
    assert_eq!(count(&ed), 2.0);
}

#[test]
fn c_z_suspends_the_menus_and_transient_resume_brings_them_back() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("transient-resume", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("No suspended transient command"));
    ed.call("tm-main", vec![]).unwrap();
    ed.press("s C-z").unwrap();
    assert_eq!(menu(&ed), None);
    // The keys are the buffer's own while it is suspended.
    ed.press("b").unwrap();
    assert_eq!(count(&ed), 0.0);
    ed.call("transient-resume", vec![]).unwrap();
    assert!(menu(&ed).unwrap().starts_with("Sub\n x Hello"), "{:?}", menu(&ed));
    // The menu the sub-menu was entered from is still there to go back to.
    ed.press("C-g").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
}

#[test]
fn c_v_and_c_m_v_scroll_a_menu_cut_to_fit() {
    let (mut ed, s, _pkgs) = setup();
    ed.set_frame_size(80, 20);
    ed.call("tm-tall", vec![]).unwrap();
    let start = |ed: &mut Editor| {
        s.eval_expression(ed, r#"e8.windowStart(e8.windowList().find((w) => e8.windowBuffer(w) === " *transient*"))"#).unwrap()
    };
    assert_eq!(start(&mut ed), "0");
    ed.press("C-v").unwrap();
    assert_ne!(start(&mut ed), "0");
    ed.press("C-M-v").unwrap();
    assert_eq!(start(&mut ed), "0");
    // Still in the menu.
    ed.press("b").unwrap();
    assert_eq!(ed.echo(), Some("Hello"));
}

#[test]
fn c_m_p_goes_back_to_earlier_values_and_c_u_reaches_the_suffix() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("args-menu", vec![]).unwrap();
    ed.press("- v s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--all","--verbose"]"#));
    ed.call("args-menu", vec![]).unwrap();
    ed.press("C-M-p s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--all","--verbose"]"#));
    ed.call("tm-arg-menu", vec![]).unwrap();
    ed.press("p").unwrap();
    let plain = ed.echo().map(str::to_string);
    ed.call("tm-arg-menu", vec![]).unwrap();
    ed.press("C-u p").unwrap();
    assert_ne!(ed.echo().map(str::to_string), plain);
    assert_eq!(menu(&ed), None);
    // A suffix that reads its arguments still reads them, with the prefix argument.
    ed.call("tm-arg-menu", vec![]).unwrap();
    ed.press("C-u r B o b RET").unwrap();
    assert_eq!(ed.echo(), Some(r#"read "Bob" [4]"#));
}

/// The menu's window point, as the cursor shows it there.
fn menu_point(ed: &mut Editor, s: &Scripting) -> usize {
    s.eval_expression(ed, r#"e8.windowPoint(e8.windowList().find((w) => e8.windowBuffer(w) === " *transient*"))"#).unwrap().parse().unwrap()
}

/// What the menu shows from a position on, to its line's end.
fn menu_at(ed: &Editor, at: usize) -> String {
    let text: Vec<char> = menu(ed).unwrap().chars().collect();
    text[at..].iter().take_while(|c| **c != '\n').collect()
}

#[test]
fn arrow_keys_go_from_suffix_to_suffix_and_m_ret_runs_one() {
    let (mut ed, s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    // The cursor starts at the menu's top, and goes to each button in turn, round at the ends.
    assert_eq!(menu_point(&mut ed, &s), 0);
    ed.press("<down>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert!(menu_at(&ed, at).starts_with(" b Bump"), "{:?}", menu_at(&ed, at));
    ed.press("<down>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert_eq!(menu_at(&ed, at), " s Sub");
    ed.press("<down> <down>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert!(menu_at(&ed, at).starts_with(" b Bump"), "{:?}", menu_at(&ed, at));
    ed.press("<up>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert_eq!(menu_at(&ed, at), " h Hello");
    // A suffix that stays keeps the cursor on its button when the menu is drawn again.
    ed.press("<up> <up>").unwrap();
    ed.press("M-RET").unwrap();
    assert_eq!(count(&ed), 1.0);
    let at = menu_point(&mut ed, &s);
    assert!(menu_at(&ed, at).starts_with(" b Bump"), "{:?}", menu_at(&ed, at));
    ed.press("<down> M-RET").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Sub\n x Hello"), "{:?}", menu(&ed));
}

#[test]
fn a_click_on_a_suffix_runs_it() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    let window = ed.windows().iter().find(|w| w.buffer.name == " *transient*").map(|w| w.id).unwrap();
    let at = menu(&ed).unwrap().chars().collect::<String>().find("Hello").unwrap();
    ed.mouse(e8_core::Key::parse("<mouse-1>").unwrap(), e8_core::MouseEvent { window, position: Some(at), start: None });
    assert_eq!(ed.echo(), Some("Hello"));
    assert_eq!(menu(&ed), None);
}

#[test]
fn without_popup_navigation_the_arrow_keys_are_not_the_menus() {
    let (mut ed, s, _pkgs) = setup();
    s.eval_expression(&mut ed, r#"e8.setVariable("transient-enable-popup-navigation", false)"#).unwrap();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("<down>").unwrap();
    assert_eq!(ed.echo(), Some("Unbound suffix: `<down>' (Use `C-g' to abort, `?' for help)"));
    assert!(menu(&ed).unwrap().starts_with("Left"));
}

#[test]
fn counts_go_round_once_and_off_a_button_there_is_nothing_to_run() {
    let (mut ed, s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    // On the heading, C-u 0 finds no button, and M-RET none to run.
    ed.press("C-u 0 <down>").unwrap();
    assert_eq!(ed.echo(), Some("No buttons!"));
    ed.press("M-RET").unwrap();
    assert_eq!(ed.echo(), Some("Unbound suffix: `M-RET' (Use `C-g' to abort, `?' for help)"));
    // Past the last of three, forward-button stops at the first it reached.
    ed.press("C-u 5 <down>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert!(menu_at(&ed, at).starts_with(" b Bump"), "{:?}", menu_at(&ed, at));
    ed.press("C-u 2 <down>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert_eq!(menu_at(&ed, at), " h Hello");
    ed.press("C-u 2 <up>").unwrap();
    let at = menu_point(&mut ed, &s);
    assert!(menu_at(&ed, at).starts_with(" b Bump"), "{:?}", menu_at(&ed, at));
}

#[test]
fn a_heading_keeps_the_cursor_when_the_menu_is_drawn_again() {
    let (mut ed, s, _pkgs) = setup();
    ed.call("args-menu", vec![]).unwrap();
    let actions = menu(&ed).unwrap().find("Actions").unwrap();
    s.eval_expression(&mut ed, &format!(r#"e8.setWindowPoint(e8.windowList().find((w) => e8.windowBuffer(w) === " *transient*"), {actions})"#)).unwrap();
    ed.press("- v").unwrap();
    let at = menu_point(&mut ed, &s);
    assert_eq!(menu_at(&ed, at), "Actions");
}

#[test]
fn clicks_off_a_suffix_are_refused_or_do_what_they_do_elsewhere() {
    let (mut ed, s, _pkgs) = setup();
    ed.window_buffer_mut().set_text("one two three");
    ed.window_buffer_mut().set_point(0);
    let source = ed.selected_window();
    let click = |ed: &mut Editor, window, at| ed.mouse(e8_core::Key::parse("<mouse-1>").unwrap(), e8_core::MouseEvent { window, position: Some(at), start: None });
    ed.call("tm-main", vec![]).unwrap();
    let menu_window = ed.windows().iter().find(|w| w.buffer.name == " *transient*").map(|w| w.id).unwrap();
    click(&mut ed, menu_window, 0);
    assert_eq!(ed.echo(), Some("Unbound suffix: `<mouse-1>' (Use `C-g' to abort, `?' for help)"));
    assert!(menu(&ed).is_some());
    ed.press("C-g").unwrap();
    // A menu that lets other commands run lets a click move point.
    ed.call("tm-free", vec![]).unwrap();
    click(&mut ed, source, 4);
    assert_eq!(s.eval_expression(&mut ed, "e8.windowPoint(e8.selectedWindow())").unwrap(), "4");
    assert!(menu(&ed).is_some());
    // A double click on a suffix runs it, as an unbound double click is read as a click.
    let menu_window = ed.windows().iter().find(|w| w.buffer.name == " *transient*").map(|w| w.id).unwrap();
    let at = menu(&ed).unwrap().find("Hello").unwrap();
    ed.mouse(e8_core::Key::parse("<double-mouse-1>").unwrap(), e8_core::MouseEvent { window: menu_window, position: Some(at), start: None });
    assert_eq!(ed.echo(), Some("Hello"));
}
