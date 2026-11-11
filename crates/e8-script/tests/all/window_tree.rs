//! The window tree as window.c keeps it (ADR 0069, stage 3): combinations
//! of any number of windows, internal windows as objects with parents,
//! children and siblings, and how splitting and deleting change it. Each
//! expectation is what Emacs 30 gives on an 80 by 24 root window.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    eval(
        &mut ed,
        &s,
        r#"(globalThis.desc = (w) => {
            if (e8.windowLiveP(w)) return ["live", e8.windowTotalHeight(w), e8.windowTotalWidth(w)];
            const kids = []; for (let c = e8.windowTopChild(w) ?? e8.windowLeftChild(w); c; c = e8.windowNextSibling(c)) kids.push(desc(c));
            return [e8.windowLeftChild(w) ? "h" : "v", e8.windowTotalHeight(w), e8.windowTotalWidth(w), kids];
          }, globalThis.show = () => JSON.stringify(desc(e8.frameRootWindow())), "")"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn splits_of_one_kind_share_one_internal_window() {
    let (mut ed, s) = setup();
    ed.press("C-x 2 C-x 2").unwrap();
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["v",24,80,[["live",6,80],["live",6,80],["live",12,80]]]"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.windowNormalSize(), e8.windowNormalSize(undefined, true)])"), "[0.25,1]");
    ed.press("C-x 3").unwrap();
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"["v",24,80,[["h",6,80,[["live",6,40],["live",6,40]]],["live",6,80],["live",12,80]]]"#
    );
    assert_eq!(eval(&mut ed, &s, "String(e8.windowParent(e8.windowParent()) === e8.frameRootWindow())"), "true");
    // Deleting the window on the right leaves its sibling in the combination of its kind.
    eval(&mut ed, &s, r#"(e8.deleteWindow(e8.windowList()[1]), "")"#);
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["v",24,80,[["live",6,80],["live",6,80],["live",12,80]]]"#);
}

#[test]
fn deleting_a_window_joins_its_siblings_children_to_their_grandparent() {
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x 2 C-x 3").unwrap();
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"["h",24,80,[["v",24,40,[["h",12,40,[["live",12,20],["live",12,20]]],["live",12,40]]],["live",24,40]]]"#
    );
    ed.press("C-x 0").unwrap();
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["h",24,80,[["v",24,40,[["live",12,40],["live",12,40]]],["live",24,40]]]"#);
}

#[test]
fn internal_windows_are_valid_windows_but_not_live() {
    let (mut ed, s) = setup();
    ed.press("C-x 2").unwrap();
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"((r) => JSON.stringify([e8.windowValidP(r), e8.windowLiveP(r), e8.windowp(r), e8.windowParent(r) ?? null,
              e8.windowEdges(r), (e8.setWindowParameter(r, "p", 1), e8.windowParameter(r, "p")), e8.windowCombinationLimit(r)]))(e8.frameRootWindow())"#
        ),
        "[true,false,true,null,[0,0,80,24],1,false]"
    );
}

#[test]
fn enlarging_a_window_takes_from_the_one_after_it_or_the_last_from_the_one_before() {
    let (mut ed, s) = setup();
    let heights = |ed: &mut Editor| eval(ed, &s, "JSON.stringify(e8.windowList().map((w) => e8.windowTotalHeight(w)))");
    ed.press("C-x 2 C-x 2 C-x o C-u 2 C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,8,10]");
    ed.press("C-u 5 C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,13,5]");
    ed.press("C-x o C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,12,6]");
}
