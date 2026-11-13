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

/// The menu bar on, with a mode's own menu in a local keymap beside the
/// menus menu-bar.ts puts in the global one.
const BAR: &str = r#"
e8.call("menu-bar-mode");
const map = e8.makeSparseKeymap();
e8.defineMenuItem(map, "<menu-bar> <test>", { label: "Test", binding: e8.makeSparseKeymap() });
const test = e8.lookupKey(map, "<menu-bar> <test>") as e8.Keymap;
e8.defineMenuItem(test, "<one>", { label: "One", binding: "test-one" });
e8.defineMenuItem(test, "<two>", { label: "Two", binding: "test-two" });
e8.defineCommand({ name: "test-one", run: () => e8.setVariable("test-ran", "one") });
e8.defineCommand({ name: "test-two", run: () => e8.setVariable("test-ran", "two") });
e8.useLocalMap(map);
"#;

/// The menu bar as it is laid out: each menu's label, and where the one
/// named starts.
fn bar(d: &Driven) -> Vec<String> {
    d.with(|ed| {
        ed.redisplay();
        ed.menu_bar(ed.selected_frame()).unwrap_or(&[]).iter().map(|i| i.label.clone()).collect()
    })
}

/// Which column a menu of the bar starts at.
fn bar_column(d: &Driven, label: &str) -> usize {
    let label = label.to_string();
    d.with(move |ed| {
        ed.menu_bar(ed.selected_frame()).unwrap_or(&[]).iter().find(|i| i.label == label).map(|i| i.column).expect("a menu of that name")
    })
}

#[test]
fn the_menu_bar_lists_the_menus_of_the_keymaps_in_use() {
    let d = Driven::new(BAR);
    // The global map's menus, as menu-bar.ts puts them, then the local
    // map's, with Help last as menu-bar-final-items says.
    assert_eq!(
        bar(&d),
        vec!["File".to_string(), "Edit".into(), "Options".into(), "Buffers".into(), "Tools".into(), "Test".into(), "Help".into()]
    );
    // Without a menu bar there is nothing to lay out.
    d.eval(r#"e8.callWithPrefix(-1, "menu-bar-mode");"#);
    assert!(bar(&d).is_empty());
}

#[test]
fn the_buffers_menu_is_made_again_as_the_bar_is_laid_out() {
    let d = Driven::new(BAR);
    bar(&d);
    assert!(d.eval_expression(r#"e8.keymapMenuKeys(e8.lookupKey("global-map", "<menu-bar> <buffer>"))"#).contains("buffer-0"));
    d.eval(r#"e8.getBufferCreate("a-new-buffer");"#);
    bar(&d);
    let labels = d.eval_expression(
        r#"e8.keymapMenuKeys(e8.lookupKey("global-map", "<menu-bar> <buffer>")).map((k: string) => e8.menuItem(e8.lookupKey("global-map", "<menu-bar> <buffer>"), k)?.label).join("|")"#,
    );
    assert!(labels.contains("a-new-buffer"), "{labels}");
}

#[test]
fn opening_the_menu_bar_and_choosing_an_item_runs_its_command() {
    let d = Driven::new(BAR);
    bar(&d);
    let column = bar_column(&d, "Test");
    d.start(move |ed| {
        let frame = ed.selected_frame();
        let _ = ed.menu_bar_mouse(frame, column);
    });
    assert_eq!(panels(&d), vec![vec![">One".to_string(), "Two".into()]]);
    // The menu opens right below the bar, at its own column.
    assert_eq!(d.with(|ed| { let m = &ed.describe_frame(ed.selected_frame(), 1.0).menus[0]; (m.x, m.y) }), (column, 0));
    d.press("<down> RET");
    assert_eq!(d.variable("test-ran").as_deref(), Some("\"two\""));
    assert!(!d.with(|ed| ed.menu_active()));
}

#[test]
fn f10_opens_the_first_menu_and_right_and_left_go_to_the_next() {
    let d = Driven::new(BAR);
    let labels = bar(&d);
    d.press("<f10>");
    // F10 opens the first menu, File.
    assert_eq!(panels(&d)[0][0], ">Visit New File...");
    // Right goes along the bar, round to the first past the end.
    for _ in 0..labels.len() - 1 {
        d.press("<right>");
    }
    assert_eq!(panels(&d)[0][0], ">Describe Key...");
    d.press("<right>");
    assert_eq!(panels(&d)[0][0], ">Visit New File...");
    d.press("<left> RET");
    // Describe Key asks for a key, which C-g leaves.
    assert_eq!(d.message().as_deref(), Some("Describe key: "));
    d.press("C-g");
}

#[test]
fn a_menu_taller_than_the_frame_scrolls_to_the_cursor() {
    let d = Driven::new(
        r#"
        const menu = e8.makeSparseKeymap();
        for (let i = 0; i < 40; i += 1) {
          e8.defineMenuItem(menu, `<i${i}>`, { label: `Item ${i}`, binding: "ignore" });
        }
        e8.setVariable("test-menu", menu);
        "#,
    );
    open(&d, "e8.variable(\"test-menu\")", "[0, 0]");
    let lines = d.with(|ed| ed.frame_cells().1);
    let shown = |d: &Driven| panels(d)[0].clone();
    assert_eq!(shown(&d).len(), lines, "the panel fills the frame");
    assert_eq!(shown(&d)[0], ">Item 0");
    // Moving past the last line shown scrolls the panel.
    for _ in 0..lines {
        d.press("<down>");
    }
    assert_eq!(shown(&d).last().unwrap(), &format!(">Item {lines}"));
    assert_eq!(shown(&d).len(), lines);
    // The pointer picks the line it is on and the panel stays where it
    // is, so RET chooses what the pointer was over, not what that line
    // would hold had the panel scrolled under it.
    let fifth = shown(&d)[5].clone();
    point_at(&d, 2.0, 5.0);
    d.press("<mouse-movement>");
    assert_eq!(shown(&d)[5], format!(">{fifth}"));
    d.press("RET");
    let chosen = fifth.trim_start_matches('>').trim_start_matches("Item ").to_string();
    assert_eq!(d.variable("test-chosen").as_deref(), Some(format!("\"<i{chosen}>\"").as_str()));
}

#[test]
fn easymenu_adds_and_takes_items_out_of_a_menu_by_its_path() {
    let d = Driven::new(BAR);
    bar(&d);
    d.eval(r#"import("easymenu").then((m: any) => { (globalThis as any).easymenu = m; });"#);
    d.eval(
        r#"
        const m = (globalThis as any).easymenu;
        m.easyMenuAddItem("global-map", ["File"], { label: "Touch", command: "ignore" });
        e8.setVariable("test-present", m.easyMenuItemPresentP("global-map", ["File"], "Touch") ? "yes" : "no");
        e8.setVariable("test-missing", m.easyMenuItemPresentP("global-map", ["Nowhere"], "Touch") ? "yes" : "no");
        "#,
    );
    assert_eq!(d.variable("test-present").as_deref(), Some("\"yes\""));
    assert_eq!(d.variable("test-missing").as_deref(), Some("\"no\""));
    // It is the last item of the File menu, where it was added.
    let column = bar_column(&d, "File");
    d.start(move |ed| {
        let frame = ed.selected_frame();
        let _ = ed.menu_bar_mouse(frame, column);
    });
    assert_eq!(panels(&d)[0].last().unwrap(), "Touch");
    d.press("C-g");
    d.eval(
        r#"
        const m = (globalThis as any).easymenu;
        m.easyMenuRemoveItem("global-map", ["File"], "Touch");
        e8.setVariable("test-present", m.easyMenuItemPresentP("global-map", ["File"], "Touch") ? "yes" : "no");
        "#,
    );
    assert_eq!(d.variable("test-present").as_deref(), Some("\"no\""));
}

#[test]
fn a_modes_menu_adds_to_the_global_menu_of_the_same_name() {
    let d = Driven::new(BAR);
    d.eval(
        r#"
        const map = e8.makeSparseKeymap();
        e8.defineMenuItem(map, "<menu-bar> <file>", { label: "File", binding: e8.makeSparseKeymap() });
        const file = e8.lookupKey(map, "<menu-bar> <file>") as e8.Keymap;
        e8.defineMenuItem(file, "<mine>", { label: "Mine", binding: "ignore" });
        e8.useLocalMap(map);
        "#,
    );
    bar(&d);
    // One File menu, with the mode's item and the global ones.
    assert_eq!(bar(&d).iter().filter(|l| *l == "File").count(), 1);
    let column = bar_column(&d, "File");
    d.start(move |ed| {
        let frame = ed.selected_frame();
        let _ = ed.menu_bar_mouse(frame, column);
    });
    let items = panels(&d)[0].clone();
    assert_eq!(items[0], ">Mine");
    assert!(items.iter().any(|i| i == "Save"), "{items:?}");
    d.press("C-g");
}

#[test]
fn the_buffers_menu_is_made_again_only_when_the_buffers_change() {
    let d = Driven::new(BAR);
    let menu = r#"e8.lookupKey("global-map", "<menu-bar> <buffer>")"#;
    bar(&d);
    let first = d.eval_expression(&format!("String({menu})"));
    bar(&d);
    assert_eq!(d.eval_expression(&format!("String({menu})")), first, "the same keymap, not a new one");
    let labels = |d: &Driven| {
        d.eval_expression(&format!(
            "e8.keymapMenuKeys({menu}).map((k: string) => e8.menuItem({menu}, k)?.label).join(\"|\")"
        ))
    };
    let before = labels(&d);
    assert!(before.contains("*scratch*"), "{before}");
    d.eval(r#"e8.getBufferCreate("a-new-buffer");"#);
    bar(&d);
    let after = labels(&d);
    assert!(after.contains("a-new-buffer"), "{after}");
    assert_ne!(before, after);
}

// --- Dialogs and tooltips (stage 3) -----------------------------------------

#[test]
fn a_dialog_shows_in_the_middle_of_the_frame_and_gives_the_value_chosen() {
    let d = Driven::new("");
    d.start_eval(
        r#"e8.setVariable("test-chosen", String(e8.xPopupDialog(["Delete this file?", ["Yes", true], ["No", false], null, ["Help", "help"]])));"#,
    );
    assert_eq!(
        panels(&d),
        vec![vec!["Delete this file?".to_string(), ">Yes".into(), "No".into(), "-".repeat(17), "Help".into()]]
    );
    // In the middle of the frame, its text centred.
    let (x, y, cells) = d.with(|ed| {
        let panel = &ed.describe_frame(ed.selected_frame(), 1.0).menus[0];
        (panel.x, panel.y, ed.frame_cells())
    });
    assert_eq!(y, cells.1 / 2);
    assert_eq!(x, (cells.0 - "Delete this file?".len()) / 2);
    d.press("<down> RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"false\""));
}

#[test]
fn message_box_shows_the_message_until_it_is_answered() {
    let d = Driven::new("");
    d.start_eval(r#"e8.setVariable("test-said", e8.messageBox("Compilation finished") ?? "nothing");"#);
    assert_eq!(panels(&d), vec![vec!["Compilation finished".to_string(), ">OK".into()]]);
    d.press("RET");
    assert_eq!(d.variable("test-said").as_deref(), Some("\"Compilation finished\""));
}

#[test]
fn message_or_box_uses_the_echo_area_unless_the_mouse_asked() {
    let d = Driven::new(
        r#"
        e8.defineCommand({ name: "test-say", run: () => e8.messageOrBox("Said") });
        e8.bindKey("<f8>", "test-say");
        e8.bindKey("<mouse-1>", "test-say");
        "#,
    );
    d.press("<f8>");
    assert_eq!(d.message().as_deref(), Some("Said"));
    assert!(!d.with(|ed| ed.menu_active()));
    // Asked with the mouse, it is a dialog.
    d.press("<mouse-1>");
    assert_eq!(panels(&d), vec![vec!["Said".to_string(), ">OK".into()]]);
    d.press("RET");
    // With use-dialog-box off, the echo area again.
    d.eval(r#"e8.setVariable("use-dialog-box", false);"#);
    d.press("<mouse-1>");
    assert!(!d.with(|ed| ed.menu_active()));
}

#[test]
fn a_tooltip_shows_over_the_windows_and_goes_when_it_is_hidden() {
    let d = Driven::new("");
    d.eval(r#"e8.xShowTip("Insert a file's text at point", [3, 2], 0);"#);
    let tip = d.with(|ed| {
        let fd = ed.describe_frame(ed.selected_frame(), 1.0);
        fd.tip.map(|t| (t.x, t.y, t.rows.iter().map(|r| r.text.trim().to_string()).collect::<Vec<_>>()))
    });
    assert_eq!(tip, Some((3, 2, vec!["Insert a file's text at point".to_string()])));
    assert!(d.with(|ed| ed.tip_shown()));
    assert_eq!(d.eval_expression("e8.xHideTip()"), "true");
    assert!(!d.with(|ed| ed.tip_shown()));
    assert!(d.with(|ed| ed.describe_frame(ed.selected_frame(), 1.0).tip.is_none()));
}

#[test]
fn a_tooltip_goes_by_itself_when_its_time_is_up() {
    let d = Driven::new("");
    d.eval(r#"e8.xShowTip("Gone soon", [0, 0], 0.05);"#);
    assert!(d.with(|ed| ed.tip_shown()));
    d.until(|_| !d.with(|ed| ed.tip_shown()));
}

#[test]
fn tooltip_mode_off_says_it_in_the_echo_area() {
    let d = Driven::new(r#"import("tooltip").then((m: any) => { (globalThis as any).tooltip = m; });"#);
    d.eval(r#"(globalThis as any).tooltip.tooltipShow("Over here");"#);
    assert!(d.with(|ed| ed.tip_shown()));
    d.eval(r#"e8.callWithPrefix(-1, "tooltip-mode"); (globalThis as any).tooltip.tooltipShow("Over here");"#);
    assert!(!d.with(|ed| ed.tip_shown()));
    assert_eq!(d.message().as_deref(), Some("Over here"));
}

#[test]
fn a_file_dialog_is_never_used() {
    let d = Driven::new("");
    assert_eq!(d.eval_expression("e8.nextReadFileUsesDialogP()"), "undefined");
}

#[test]
fn a_question_the_mouse_or_a_menu_asked_is_asked_in_a_dialog() {
    let d = Driven::new(
        r#"
        e8.defineCommand({ name: "test-ask", run: () => e8.setVariable("test-said", e8.yOrNP("Really?") ? "yes" : "no") });
        e8.bindKey("<f8>", "test-ask");
        e8.bindKey("<mouse-1>", "test-ask");
        "#,
    );
    // From a key, it is the echo area, as always.
    d.press("<f8>");
    assert!(d.prompt().is_some_and(|p| p.starts_with("Really?")), "{:?}", d.prompt());
    d.press("y");
    // From the mouse, it is a dialog, as subr.el's y-or-n-p asks with one.
    d.press("<mouse-1>");
    assert_eq!(panels(&d), vec![vec!["Really?".to_string(), ">Yes".into(), "No".into()]]);
    d.press("<down> RET");
    assert_eq!(d.variable("test-said").as_deref(), Some("\"no\""));
}

#[test]
fn a_tooltip_shown_again_is_not_cut_short_by_the_first_ones_timer() {
    let d = Driven::new("");
    d.eval(r#"e8.xShowTip("Saved", [5, 5], 0.05);"#);
    // The same text again, to stay: the first timer must not take it.
    d.eval(r#"e8.xShowTip("Saved", [5, 5], 0);"#);
    d.with(|ed| ed.run_timers());
    std::thread::sleep(std::time::Duration::from_millis(120));
    d.with(|ed| ed.run_timers());
    assert!(d.with(|ed| ed.tip_shown()), "the second tooltip stayed");
}

#[test]
fn a_menu_takes_a_tooltip_away_and_typing_hides_it() {
    let d = Driven::new(MENU);
    d.eval(r#"e8.xShowTip("Over here", [1, 1], 0);"#);
    assert!(d.with(|ed| ed.tip_shown()));
    open(&d, "e8.variable(\"test-menu\")", "\"point\"");
    assert!(!d.with(|ed| ed.tip_shown()), "a menu hides a tooltip, as x_popup_menu_1 does");
    d.press("C-g");
    // tooltip.ts takes one away at the next command, as tooltip-mode's
    // pre-command-hook does.
    d.eval(r#"e8.xShowTip("Over here", [1, 1], 0);"#);
    d.press("a");
    assert!(!d.with(|ed| ed.tip_shown()));
}

#[test]
fn a_dialogs_text_is_shown_as_it_is() {
    let d = Driven::new("");
    d.start_eval(r#"e8.setVariable("test-chosen", String(e8.xPopupDialog(["--- nothing to commit ---", ["--force", "force"]])));"#);
    // `--` is a separator among a keymap menu's items, not in a dialog.
    assert_eq!(panels(&d), vec![vec!["--- nothing to commit ---".to_string(), ">--force".into()]]);
    d.press("RET");
    assert_eq!(d.variable("test-chosen").as_deref(), Some("\"force\""));
}

#[test]
fn message_box_with_nothing_takes_the_message_away_without_logging_it() {
    let d = Driven::new("");
    d.eval(r#"e8.message("Something");"#);
    assert_eq!(d.message().as_deref(), Some("Something"));
    assert_eq!(d.eval_expression("e8.messageBox()"), "undefined");
    assert_eq!(d.message(), None);
    let logged = d.with(|ed| ed.messages().len());
    assert_eq!(d.eval_expression("e8.messageBox()"), "undefined");
    assert_eq!(d.with(|ed| ed.messages().len()), logged, "nothing more was logged");
}
