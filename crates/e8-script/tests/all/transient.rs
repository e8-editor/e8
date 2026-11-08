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
    let (mut ed, _s, _pkgs) = setup();
    ed.set_frame_size(80, 20);
    ed.call("tm-tall", vec![]).unwrap();
    assert!(menu(&ed).unwrap().contains("Item 29"));
    ed.press("b").unwrap();
    assert_eq!(ed.echo(), Some("Hello"));
}

#[test]
fn without_a_popup_the_menu_shows_on_c_h_and_c_h_describes_a_suffix() {
    let (mut ed, s, _pkgs) = setup();
    s.eval_expression(&mut ed, r#"e8.setVariable("transient-show-popup", false)"#).unwrap();
    ed.call("tm-main", vec![]).unwrap();
    assert_eq!(menu(&ed), None);
    ed.press("C-h").unwrap();
    assert!(menu(&ed).is_some());
    s.eval_expression(&mut ed, r#"e8.setVariable("transient-show-popup", true)"#).unwrap();
    ed.press("C-h h").unwrap();
    assert_eq!(menu(&ed), None);
    assert!(ed.find_buffer("*Help*").is_some());
}
