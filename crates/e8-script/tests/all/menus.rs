//! Menus as Emacs has them (ADR 0076): menu keymaps, what `x-popup-menu`
//! shows and what it gives back, and the keys that walk it.

use crate::driven::Driven;

/// A menu keymap with three items, the middle one disabled, and a
/// submenu, bound as a script binds one.
const MENU: &str = r#"
const menu = e8.makeSparseKeymap();
e8.defineMenuItem(menu, "<open>", { label: "Open", binding: "find-file" });
e8.defineMenuItem(menu, "<save>", { label: "Save", binding: "save-buffer", enable: () => false });
e8.defineMenuItem(menu, "<more>", { label: "More", binding: e8.makeSparseKeymap() });
const more = e8.lookupKey(menu, "<more>") as e8.Keymap;
e8.defineMenuItem(more, "<quit>", { label: "Quit", binding: "save-buffers-kill-terminal" });
e8.setVariable("test-menu", menu);
"#;

/// The labels of each open panel, outermost first, with the line the
/// cursor is on marked.
fn panels(d: &Driven) -> Vec<Vec<String>> {
    d.with(|ed| {
        ed.describe_frame(ed.selected_frame(), 1.0)
            .menus
            .into_iter()
            .map(|panel| {
                panel
                    .rows
                    .into_iter()
                    .map(|row| {
                        // The label alone: the keys shown to its right are
                        // two spaces or more away.
                        let text = row.text.split("  ").next().unwrap_or_default().trim().to_string();
                        if row.selected { format!(">{text}") } else { text }
                    })
                    .collect()
            })
            .collect()
    })
}

/// Opens the menu from a script, so the answer lands in a variable.
fn open(d: &Driven, menu: &str, position: &str) {
    d.start_eval(&format!("e8.setVariable(\"test-chosen\", e8.xPopupMenu({menu}, {position}) ?? \"none\");"));
}

#[test]
fn a_menu_keymap_shows_its_items_and_gives_back_the_keys_chosen() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    assert_eq!(panels(&d), vec![vec![">Open".to_string(), "Save".into(), "More".into()]]);
    // Each item shows the keys that run its command, and a submenu a `>`.
    assert_eq!(
        d.with(|ed| ed.describe_frame(ed.selected_frame(), 1.0).menus[0].rows.iter().map(|r| r.text.clone()).collect::<Vec<_>>()),
        vec![" Open  C-x C-f ".to_string(), " Save  C-x C-s ".into(), " More        > ".into()]
    );
    assert!(d.with(|ed| ed.menu_active()));
    d.press("RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<open>\""));
    assert!(!d.with(|ed| ed.menu_active()));
    assert!(panels(&d).is_empty());
    // The keys it gives are the keys of the item, to look up in the menu.
    assert_eq!(d.eval_expression("e8.lookupKey(e8.variable(\"test-menu\"), \"<open>\")"), "\"find-file\"");
}

#[test]
fn an_item_that_is_not_enabled_cannot_be_chosen() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    // The cursor moves onto it, as Emacs's menus let it, but RET there
    // chooses nothing.
    d.press("<down>");
    assert_eq!(panels(&d)[0][1], ">Save");
    d.press("RET");
    assert!(d.with(|ed| ed.menu_active()));
    // Down lands on the submenu, which RET opens, and the next RET chooses.
    d.press("<down> RET RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<more> <quit>\""));
}

#[test]
fn a_submenu_opens_beside_its_item_and_its_keys_are_the_whole_path() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    d.press("<down> <down> <right>");
    assert_eq!(panels(&d), vec![vec!["Open".to_string(), "Save".into(), ">More".into()], vec![">Quit".into()]]);
    // The submenu is to the right of the panel that opened it.
    let (first, second) = d.with(|ed| {
        let menus = ed.describe_frame(ed.selected_frame(), 1.0).menus;
        ((menus[0].x, menus[0].y, menus[0].width), (menus[1].x, menus[1].y))
    });
    assert_eq!(second.0, first.0 + first.2);
    assert_eq!(second.1, first.1 + 2);
    // Left closes it again, leaving the cursor where it was.
    d.press("<left>");
    assert_eq!(panels(&d), vec![vec!["Open".to_string(), "Save".into(), ">More".into()]]);
    d.press("<right> RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<more> <quit>\""));
}

#[test]
fn a_menu_of_panes_and_items_gives_the_value_of_the_item() {
    let d = Driven::new("");
    open(&d, r#"["Choose", ["Colours", ["Red", 1], ["Green", 2]], ["Shapes", "Nothing here"]]"#, "\"point\"");
    assert_eq!(
        panels(&d),
        vec![vec!["Choose".to_string(), "Colours".into(), ">Red".into(), "Green".into(), "Shapes".into(), "Nothing here".into()]]
    );
    // A title and a plain string cannot be chosen, so moving down twice
    // from Red lands on nothing further and RET chooses Green.
    d.press("<down> RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("2"));
}

#[test]
fn an_item_that_is_not_visible_is_left_out_and_a_button_shows_its_state() {
    let d = Driven::new(
        r#"
        const menu = e8.makeSparseKeymap();
        e8.defineMenuItem(menu, "<one>", { label: "One", binding: "ignore", visible: () => false });
        e8.defineMenuItem(menu, "<two>", { label: "Two", binding: "ignore", button: ["toggle", true] });
        e8.defineMenuItem(menu, "<three>", { label: "Three", binding: "ignore", button: ["radio", () => false] });
        e8.setVariable("test-menu", menu);
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    assert_eq!(panels(&d), vec![vec![">[X] Two".to_string(), "( ) Three".into()]]);
    d.press("C-g");
}

#[test]
fn leaving_a_menu_a_key_opened_quits() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    d.press("C-g");
    assert!(!d.with(|ed| ed.menu_active()));
    // The script never set the variable, since the quit unwound it.
    assert_eq!(d.variable("test-chosen"), None);
    assert!(d.message().is_some_and(|m| m.ends_with("Quit")), "{:?}", d.message());
}

#[test]
fn a_key_the_navigation_map_does_not_bind_is_ignored() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"mouse\"");
    // As read_menu_input ignores one: the menu stays up.
    d.press("x");
    d.press("C-x");
    assert!(d.with(|ed| ed.menu_active()));
    assert_eq!(panels(&d)[0][0], ">Open");
    // ESC leaves it; opened by the mouse, that is no quit.
    d.press("ESC");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"none\""));
}

#[test]
fn the_cursor_wraps_at_the_ends_of_a_panel() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    d.press("<up>");
    assert_eq!(panels(&d)[0][2], ">More");
    d.press("<down>");
    assert_eq!(panels(&d)[0][0], ">Open");
}

#[test]
fn a_filter_gives_what_an_item_really_runs() {
    let d = Driven::new(
        r#"
        const menu = e8.makeSparseKeymap();
        e8.defineMenuItem(menu, "<recent>", {
          label: "Recent",
          filter: () => {
            const made = e8.makeSparseKeymap();
            e8.defineMenuItem(made, "<one>", { label: "One", binding: "ignore" });
            return made;
          },
        });
        e8.setVariable("test-menu", menu);
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    // The filter turned an item that ran nothing into a submenu.
    d.press("<right>");
    assert_eq!(panels(&d), vec![vec![">Recent".to_string()], vec![">One".into()]]);
    d.press("RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<recent> <one>\""));
}

#[test]
fn an_items_help_shows_in_the_echo_area_and_goes_with_it() {
    let d = Driven::new(
        r#"
        const menu = e8.makeSparseKeymap();
        e8.defineMenuItem(menu, "<one>", { label: "One", binding: "ignore", help: "Does the first thing" });
        e8.defineMenuItem(menu, "<two>", { label: "Two", binding: "ignore" });
        e8.setVariable("test-menu", menu);
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "\"mouse\"");
    d.press("<down>");
    assert_eq!(d.message().as_deref(), None);
    d.press("<up>");
    assert_eq!(d.message().as_deref(), Some("Does the first thing"));
    // It goes away with the item, and with the menu.
    d.press("<down>");
    assert_eq!(d.message().as_deref(), None);
    d.press("<up> ESC");
    assert_eq!(d.message().as_deref(), None);
}

#[test]
fn an_empty_menu_is_an_error() {
    let d = Driven::new("");
    assert!(
        d.eval_expression(
            r#"(() => { try { e8.xPopupMenu(["Nothing"], "point"); return "no error"; } catch (e) { return String(e); } })()"#
        )
        .contains("Empty menu")
    );
}

#[test]
fn the_items_show_in_the_order_they_were_bound_and_a_binding_again_keeps_its_place() {
    let d = Driven::new(
        r#"
        const menu = e8.makeSparseKeymap();
        for (const name of ["zeta", "alpha", "mu"]) {
            e8.defineMenuItem(menu, `<${name}>`, { label: name, binding: "ignore" });
        }
        e8.defineMenuItem(menu, "<zeta>", { label: "zeta again", binding: "ignore" });
        e8.setVariable("test-menu", menu);
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    assert_eq!(panels(&d)[0], vec![">zeta again".to_string(), "alpha".into(), "mu".into()]);
    d.press("C-g");
}

#[test]
fn a_menu_item_says_what_it_is_and_a_lookup_looks_through_it() {
    let d = Driven::new(MENU);
    assert_eq!(
        d.eval_expression("JSON.stringify(e8.menuItem(e8.variable(\"test-menu\"), \"<open>\"))"),
        "\"{\\\"label\\\":\\\"Open\\\",\\\"binding\\\":\\\"find-file\\\"}\""
    );
    assert_eq!(d.eval_expression("e8.menuItem(e8.variable(\"test-menu\"), \"<none>\")"), "undefined");
    // A key sequence through a submenu is looked up through its item.
    assert_eq!(
        d.eval_expression("e8.lookupKey(e8.variable(\"test-menu\"), \"<more> <quit>\")"),
        "\"save-buffers-kill-terminal\""
    );
}

/// Puts the pointer at a cell of the frame, as a front end does.
fn point_at(d: &Driven, x: f32, y: f32) {
    d.with(move |ed| {
        let frame = ed.selected_frame();
        ed.set_pointer(Some(e8_core::mouse::Pointer { frame, x, y, screen: None }));
    });
}

#[test]
fn the_pointer_moves_the_cursor_and_a_click_chooses() {
    let d = Driven::new(MENU);
    open(&d, "e8.variable(\"test-menu\")", "[2, 1]");
    let (x, y) = d.with(|ed| {
        let panel = &ed.describe_frame(ed.selected_frame(), 1.0).menus[0];
        (panel.x as f32, panel.y as f32)
    });
    assert_eq!((x, y), (2.0, 1.0));
    // Moving over the second line puts the cursor there.
    point_at(&d, x + 1.0, y + 1.0);
    d.press("<mouse-movement>");
    assert_eq!(panels(&d)[0][1], ">Save");
    // Clicking the first line chooses it.
    point_at(&d, x + 1.0, y);
    d.press("<mouse-1>");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<open>\""));
}

#[test]
fn a_click_away_from_the_menu_leaves_it() {
    let d = Driven::new(MENU);
    point_at(&d, 2.0, 1.0);
    open(&d, "e8.variable(\"test-menu\")", "\"mouse\"");
    assert_eq!(d.with(|ed| (ed.describe_frame(ed.selected_frame(), 1.0).menus[0].x, ed.describe_frame(ed.selected_frame(), 1.0).menus[0].y)), (2, 1));
    point_at(&d, 40.0, 10.0);
    d.press("<mouse-1>");
    assert!(!d.with(|ed| ed.menu_active()));
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"none\""));
}

#[test]
fn a_menu_opened_while_one_is_open_gives_the_outer_one_back() {
    let d = Driven::new(MENU);
    // A timer that pops a second menu up while the first is waiting, as
    // one a process filter or the agent opens would.
    d.eval(
        r#"
        const other = e8.makeSparseKeymap();
        e8.defineMenuItem(other, "<other>", { label: "Other", binding: "ignore" });
        e8.runWithTimer(0.05, null, () => {
          try { e8.xPopupMenu(other, "point"); } catch { /* it cannot read keys while the first does */ }
          e8.setVariable("test-inner", "ran");
        });
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    d.until(|_| d.variable("test-inner").is_some());
    // The first menu is still the one open, and still choosable.
    assert_eq!(panels(&d), vec![vec![">Open".to_string(), "Save".into(), "More".into()]]);
    d.press("RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"<open>\""));
}
