//! POSIX searches, as search.c's posix- functions give them (ADR 0091):
//! the longest match at the place one starts, where the ordinary searches
//! take the first. Each expectation is Emacs 30.2's for the same calls,
//! positions from 1 made E8's from 0.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "test.ts", format!("globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"))
        .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn the_longest_match_wins_as_posix_asks() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: (0 1 0 2).
    assert_eq!(r(r#"return [e8.stringMatch("a\\|ab", "abc"), e8.matchEnd(0), e8.posixStringMatch("a\\|ab", "abc"), e8.matchEnd(0)];"#), "[0,1,0,2]");
    // As Emacs: 0, with (0 3 0 2): the first of the longest matches keeps its groups.
    assert_eq!(r(r#"return [e8.posixStringMatch("\\(a*\\)\\(ab\\)*b", "aab"), e8.matchData()!.groups];"#), "[0,[[0,3],[0,2],null]]");
    assert_eq!(r(r#"return e8.posixStringMatch("q", "abc") ?? null;"#), "null");
    // posix-looking-at takes "foob" where looking-at takes "fo".
    assert_eq!(r(r#"e8.insert("foobar foo"); e8.gotoChar(0); const a = [e8.posixLookingAt("fo\\|foob\\|foo"), e8.matchEnd(0)]; e8.lookingAt("fo\\|foob\\|foo"); return [...a, e8.matchEnd(0)];"#), "[true,4,2]");
}

#[test]
fn posix_searches_move_point_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: (7 7) and (9 9), from 1.
    assert_eq!(r(r#"e8.insert("xx abcd ab"); e8.gotoChar(0); return [e8.posixSearchForward("ab\\|abc", null, true), e8.point()];"#), "[6,6]");
    assert_eq!(r(r#"e8.gotoChar(e8.pointMax()); return [e8.posixSearchBackward("ab\\|abc", null, true), e8.point()];"#), "[8,8]");
    // As Emacs: 11, the second match's end.
    assert_eq!(r(r#"e8.gotoChar(0); return [e8.posixSearchForward("ab\\|abcd", null, true, 2), e8.point()];"#), "[10,10]");
    assert_eq!(r(r#"e8.gotoChar(0); return e8.posixSearchForward("zz");"#), "ERR search-failed Search failed: \"zz\"");
    assert_eq!(r(r#"e8.gotoChar(3); return e8.posixSearchForward("ab", 1);"#), "ERR error Invalid search bound (wrong side of point)");
    // As Emacs: (11 12) after moving (1 2) by 10.
    assert_eq!(r(r#"e8.stringMatch("b", "abc"); e8.matchDataTranslate(10); return e8.matchData()!.groups[0];"#), "[11,12]");
    // The other names of the regexp searches.
    assert_eq!(r(r#"e8.gotoChar(0); return [e8.searchForwardRegexp("ab"), e8.searchBackwardRegexp("x")];"#), "[5,1]");
}
