//! Searching: the search commands, incremental search and its highlighting.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    (ed, scripting)
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

/// The faces shown on the first row, by the text they cover.
fn faces(ed: &Editor) -> Vec<(String, bool)> {
    let isearch = ed.style_for(&["isearch".to_string()], true);
    ed.window_rows(1, true)[0]
        .segments
        .iter()
        .filter(|s| s.style.background.is_some())
        .map(|s| (s.text.clone(), s.style.background == isearch.background))
        .collect()
}

#[test]
fn isearch_prompts_say_how_it_is_going() {
    let (mut ed, _scripting) = setup("hello world hello");
    ed.press("C-s h e l").unwrap();
    assert_eq!(ed.echo(), Some("I-search: hel"));
    ed.press("x").unwrap();
    assert_eq!(ed.echo(), Some("Failing I-search: helx"));
    assert_eq!(point(&ed), 3, "point stays at the last match");
    ed.press("DEL C-s C-s").unwrap();
    assert_eq!(ed.echo(), Some("Failing I-search: hel"));
    ed.press("C-s").unwrap();
    // Past where the search began, as Emacs 30.2 says it.
    assert_eq!(ed.echo(), Some("Overwrapped I-search: hel"));
    assert_eq!(point(&ed), 3);
    ed.press("C-r").unwrap();
    assert_eq!(ed.echo(), Some("Wrapped I-search backward: hel"));
    ed.press("RET").unwrap();
    assert_eq!(ed.overriding_map(), None);
}

#[test]
fn isearch_highlights_the_match_and_the_others() {
    let (mut ed, _scripting) = setup("ab ab ab");
    ed.press("C-s a b C-s").unwrap();
    assert_eq!(faces(&ed), [("ab".into(), false), ("ab".into(), true), ("ab".into(), false)]);
    ed.press("RET").unwrap();
    assert!(faces(&ed).is_empty(), "highlighting goes when the search ends");
}

#[test]
fn quitting_isearch() {
    let (mut ed, _scripting) = setup("hello world");
    ed.press("C-f C-f C-s w o r C-g").unwrap();
    assert_eq!(point(&ed), 2, "back where it started");
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(ed.overriding_map(), None);
    // While failing, C-g takes off what does not match and goes on searching.
    ed.press("C-s w o x y C-g").unwrap();
    assert_eq!(ed.echo(), Some("I-search: wo"));
    assert_eq!(point(&ed), 8);
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().mark(), Some(2));
}

#[test]
fn an_unfinished_regexp_is_not_an_error() {
    let (mut ed, _scripting) = setup("a(b) ab");
    ed.press("C-M-s a \\ (").unwrap();
    assert_eq!(ed.echo(), Some("Regexp I-search: a\\( [incomplete input]"));
    ed.press("b \\ ) RET").unwrap();
    assert_eq!(point(&ed), 7);
}

#[test]
fn search_commands() {
    let (mut ed, _scripting) = setup("one two one two");
    ed.call("search-forward", vec![Arg::Str("two".into())]).unwrap();
    assert_eq!(point(&ed), 7);
    let err = ed.call("search-forward", vec![Arg::Str("three".into())]).unwrap_err();
    assert_eq!(err.to_string(), "Search failed: \"three\"");
    ed.call("re-search-backward", vec![Arg::Str(r"o\(n\)e".into())]).unwrap();
    assert_eq!(point(&ed), 0);
    assert_eq!(ed.match_data().unwrap().groups[1], Some((1, 2)));
    // M-x prompts for the string.
    ed.press("M-x").unwrap();
    ed.type_text("search-forward\nTWO\n");
    assert_eq!(point(&ed), 7, "case is folded");
}

#[test]
fn scripts_search_and_replace() {
    let (mut ed, scripting) = setup("Foo foo");
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            const m = e8.search("foo", { from: 1 })!;
            e8.replaceMatch("bar");
            const first = e8.search("FOO", { caseFold: true, from: 0 })!;
            e8.replaceMatch("bar");
            e8.message(`${m.start} ${first.start} ${e8.bufferText()} ${e8.foldCaseFor("Foo", true)}`);
            "#
            .into(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("4 0 Bar bar false"));
}

/// As Emacs's adjust_markers_for_replace: markers at the end of the match
/// end up after the new text, those inside at its start; what Emacs 30
/// gives for the same, counting from 1.
#[test]
fn replacing_moves_markers_at_the_end_after_the_new_text() {
    let (mut ed, scripting) = setup("a foo b");
    let got = scripting
        .eval_expression(
            &mut ed,
            r#"(() => {
                const ms = [2, 5, 3, 6].map((p) => e8.makeMarker(p));
                e8.search("foo", { from: 0 });
                e8.gotoChar(3);
                e8.replaceMatch("barbaz");
                return `${e8.bufferText()} ${ms.map((m) => e8.markerPosition(m)).join(" ")}`;
            })()"#,
        )
        .unwrap();
    assert_eq!(got, r#""a barbaz b 2 8 2 9""#);
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn query_replace_from_keys() {
    let (mut ed, _scripting) = setup("foo foo foo");
    ed.press("M-%").unwrap();
    assert_eq!(ed.prompt(), Some("Query replace: "));
    ed.type_text("foo\nbar\n");
    assert_eq!(ed.echo(), Some("Query replacing foo with bar: (? for help) "));
    assert_eq!(faces(&ed), [("foo".into(), true), ("foo".into(), false), ("foo".into(), false)]);
    ed.press("y n y").unwrap();
    assert_eq!(text(&ed), "bar foo bar");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
    assert_eq!(ed.overriding_map(), None);
    assert!(faces(&ed).is_empty());
    // Each replacement can be undone.
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "bar foo foo");
}

/// As query-replace-read-args: the second prompt names the string, empty
/// input replaces the last pair again without asking for the replacement,
/// and C-u replaces whole words only.
#[test]
fn query_replace_offers_the_last_pair_and_c_u_takes_words() {
    let (mut ed, _scripting) = setup("foo foobar foo");
    ed.press("C-u M-%").unwrap();
    assert_eq!(ed.prompt(), Some("Query replace word: "));
    ed.type_text("foo\n");
    assert_eq!(ed.prompt(), Some("Query replace word foo with: "));
    ed.type_text("bar\n");
    assert_eq!(ed.echo(), Some("Query replacing word foo with bar: (? for help) "));
    ed.press("!").unwrap();
    assert_eq!(text(&ed), "bar foobar bar");
    ed.press("M-< M-%").unwrap();
    assert_eq!(ed.prompt(), Some("Query replace (default foo → bar): "));
    ed.press("RET").unwrap();
    assert_eq!((ed.prompt(), ed.echo()), (None, Some("Query replacing foo with bar: (? for help) ")));
    ed.press("!").unwrap();
    assert_eq!(text(&ed), "bar barbar bar");
}

/// M-c in isearch toggles case folding, as isearch-toggle-case-fold does,
/// saying so after the prompt, rather than ending the search and
/// capitalising a word.
#[test]
fn m_c_in_isearch_toggles_case_folding() {
    let (mut ed, _scripting) = setup("Foo xFoo foo");
    ed.press("C-s f o o").unwrap();
    assert_eq!(point(&ed), 3);
    ed.press("M-c").unwrap();
    assert_eq!(ed.echo(), Some("I-search: foo [case sensitive]"));
    ed.press("C-s").unwrap();
    assert_eq!(point(&ed), 12, "Foo is passed over");
    ed.press("RET").unwrap();
    assert_eq!(text(&ed), "Foo xFoo foo");
    ed.press("M-< C-s f o o M-c M-c").unwrap();
    assert_eq!(ed.echo(), Some("I-search: foo [case insensitive]"));
}

#[test]
fn query_replace_quits_with_c_g() {
    let (mut ed, _scripting) = setup("foo foo");
    ed.call("query-replace", vec![Arg::Str("foo".into()), Arg::Str("x".into())]).unwrap();
    ed.press("y C-g").unwrap();
    assert_eq!(text(&ed), "x foo");
    assert_eq!(ed.echo(), Some("Quit"));
    assert_eq!(ed.overriding_map(), None);
}

#[test]
fn replacing_in_the_region() {
    let (mut ed, _scripting) = setup("one one one one");
    // Select the middle two from a key, then replace there only.
    ed.press("M-f C-SPC M-f M-f").unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("replace-string\none\n1\n");
    assert_eq!(text(&ed), "one 1 1 one");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
    // Called from code, it works from point to the end.
    ed.press("M-<").unwrap();
    ed.call("replace-string", vec![Arg::Str("one".into()), Arg::Str("1".into())]).unwrap();
    assert_eq!(text(&ed), "1 1 1 1");
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));
}

#[test]
fn replace_regexp_reports_one_occurrence() {
    let (mut ed, _scripting) = setup("x = 10");
    ed.call("replace-regexp", vec![Arg::Str("[0-9]+".into()), Arg::Str("(\\&)".into())]).unwrap();
    assert_eq!(text(&ed), "x = (10)");
    assert_eq!(ed.echo(), Some("Replaced 1 occurrence"));
}

/// What a script expression gives, as JSON.
fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

#[test]
fn regexps_are_emacs_s_with_the_buffer_s_syntax() {
    let (mut ed, s) = setup("foo_bar foo_bar");
    // `_` is a symbol constituent, so \w stops at it and \_< \_> take it in.
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(0), e8.reSearchForward("\\w+"), e8.point())"#), "3");
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(0), e8.reSearchForward("\\_<\\(\\(?:\\sw\\|\\s_\\)+\\)\\_>"), e8.matchString(1))"#), r#""foo_bar""#);
    // Back-references, in the buffer and in strings.
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(0), e8.reSearchForward("\\(foo_bar\\) \\1"), e8.point())"#), "15");
    assert_eq!(eval(&mut ed, &s, r#"[e8.stringMatch("\\(a+\\)b\\1", "xaabaa"), e8.matchString(1, "xaabaa"), e8.matchEnd(0)]"#), r#"[1,"aa",6]"#);
    // \= is point.
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(4), e8.lookingAt("\\=bar"))"#), "true");
    // A syntax-table property is the character's syntax where parse-sexp-lookup-properties is on.
    eval(&mut ed, &s, r#"(e8.putTextProperty(3, 4, "syntax-table", "w"), e8.setVariable("parse-sexp-lookup-properties", true), 0)"#);
    assert_eq!(eval(&mut ed, &s, r#"(e8.gotoChar(0), e8.reSearchForward("\\w+"), e8.point())"#), "7");
    // Errors are Emacs's.
    assert!(s.eval_expression(&mut ed, r#"e8.conditionCase(() => e8.stringMatch("\\(a\\)\\2", "aa"), { "invalid-regexp": (e) => { throw new Error("caught " + e.message); } })"#).unwrap_err().to_string().contains("caught Invalid regexp: \"Invalid back reference\""));
}

/// replace-match refuses a match outside the narrowing without moving point,
/// as Freplace_match checks the match first.
#[test]
fn replace_match_outside_the_narrowing_leaves_point() {
    let (mut ed, s) = setup("foo bar baz");
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.gotoChar(0), e8.reSearchForward("foo"), e8.narrowToRegion(4, 11), e8.gotoChar(8),
            JSON.stringify([e8.conditionCase(() => (e8.replaceMatch("x"), "replaced"), { "args-out-of-range": () => "refused" }), e8.point()]))"#,
    );
    assert_eq!(got, r#""[\"refused\",8]""#);
}

/// With C-- the replace commands work backward, from point, or the
/// region's end, to the start, leaving point at the last match's start, as
/// Emacs's perform-replace does with BACKWARD.
#[test]
fn replacing_backward_with_c_minus() {
    let (mut ed, _s) = setup("one two one two one");
    ed.window_buffer_mut().set_point(11);
    ed.press("M-- M-x").unwrap();
    ed.type_text("replace-string\n");
    assert_eq!(ed.prompt(), Some("Replace string backward: "));
    ed.type_text("one\n");
    assert_eq!(ed.prompt(), Some("Replace string backward one with: "));
    ed.type_text("1\n");
    assert_eq!(text(&ed), "1 two 1 two one", "only the matches before point");
    assert_eq!(point(&ed), 0);
    assert_eq!(ed.echo(), Some("Replaced 2 occurrences"));

    // query-replace asks at each match going back, point at its start.
    let (mut ed, _s) = setup("foo x foo y foo");
    ed.window_buffer_mut().set_point(9);
    ed.press("M-- M-%").unwrap();
    ed.type_text("foo\nbar\n");
    assert_eq!(ed.echo(), Some("Query replacing backward foo with bar: (? for help) "));
    assert_eq!(point(&ed), 6);
    ed.press("y").unwrap();
    assert_eq!(point(&ed), 0, "the match before");
    ed.press("n").unwrap();
    assert_eq!(text(&ed), "foo x bar y foo");
    assert_eq!(ed.echo(), Some("Replaced 1 occurrence"));

    // In the region, from its end back to its start.
    let (mut ed, _s) = setup("ab ab ab ab");
    ed.window_buffer_mut().set_point(3);
    ed.press("C-SPC").unwrap();
    ed.window_buffer_mut().set_point(8);
    ed.press("M-- M-x").unwrap();
    ed.type_text("replace-string\n");
    assert_eq!(ed.prompt(), Some("Replace string backward in region: "));
    ed.type_text("ab\nX\n");
    assert_eq!(text(&ed), "ab X X ab");
    assert_eq!(point(&ed), 3);
    // ! after an empty match replaces it once, then goes on before it.
    let (mut ed, _s) = setup("a\nb");
    ed.window_buffer_mut().set_point(3);
    ed.press("M-- C-M-%").unwrap();
    ed.type_text("^\nX\n");
    ed.press("!").unwrap();
    assert_eq!(text(&ed), "Xa\nXb");

    // An empty active region is none: from point back to the start.
    let (mut ed, _s) = setup("ab ab ab");
    ed.window_buffer_mut().set_point(5);
    ed.press("C-SPC M-- M-x").unwrap();
    ed.type_text("replace-string\n");
    assert_eq!(ed.prompt(), Some("Replace string backward: "));
    ed.type_text("ab\nX\n");
    assert_eq!(text(&ed), "X X ab");
}

/// query-replace-regexp says it replaces a regexp, as perform-replace's message does.
#[test]
fn query_replace_regexp_says_regexp() {
    let (mut ed, _s) = setup("aa b aa");
    ed.press("C-M-%").unwrap();
    ed.type_text("a+\nX\n");
    assert_eq!(ed.echo(), Some("Query replacing regexp a+ with X: (? for help) "));
    ed.press("!").unwrap();
    assert_eq!(text(&ed), "X b X");
}

/// M-e edits the search string in the minibuffer, prompted as the search
/// is, the cursor where the string stops matching; RET resumes the search
/// with the string edited, and C-r there resumes it backward.
#[test]
fn m_e_edits_the_search_string() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("s\n");
    d.type_text("abc abd abx");
    d.press("M-<");
    d.press("C-s a b c M-e");
    assert_eq!(d.prompt().as_deref(), Some("I-search: "));
    d.press("DEL d RET");
    // Searching again, from the start of the old match, to abd.
    assert_eq!(d.point(), 7);
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("I-search: abd"));
    d.press("RET");
    assert_eq!(d.point(), 7);
    // Failing, the cursor goes where the string stops matching.
    d.press("M-< C-s a b q M-e");
    assert_eq!(d.prompt().as_deref(), Some("Failing I-search: "));
    assert_eq!(d.minibuffer_input(), "abq");
    assert_eq!(d.with(|ed| ed.minibuffer_input_point()), 2);
    d.press("C-e DEL x RET");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("I-search: abx"));
    d.press("RET");
    assert_eq!(d.point(), 11);
    // C-r resumes backward, from the end of the old match: abd before it.
    d.press("M-> C-r a b x M-e C-e DEL d C-r");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("I-search backward: abd"));
    assert_eq!(d.point(), 4);
    d.press("RET");
    // C-g while editing cancels the whole search, back where it began.
    d.press("M-< C-s a b d M-e C-g");
    assert_eq!(d.point(), 0);
    assert_eq!(d.prompt(), None);
}

/// M-p and M-n go through the search ring, editing the string brought, as
/// search-ring-update nil has them.
#[test]
fn m_p_brings_back_earlier_searches_to_edit() {
    let d = crate::driven::Driven::new("");
    d.press("C-x b");
    d.type_text("s\n");
    d.type_text("xa xb xc");
    d.press("M-< C-s x a RET M-< C-s x b RET M-<");
    d.press("C-s M-p");
    assert_eq!(d.minibuffer_input(), "xb");
    d.press("RET");
    assert_eq!(d.point(), 5);
    d.press("RET M-< C-s M-p");
    d.press("RET");
    // The ring's pointer starts afresh each search: xb again first.
    assert_eq!(d.point(), 5);
    // Resuming restarts the search, and with it the ring's pointer, as
    // with-isearch-suspended's comment says: xb again.
    d.press("RET M-< C-s M-p RET M-p");
    assert_eq!(d.minibuffer_input(), "xb");
    d.press("RET RET");
    assert_eq!(d.point(), 5);
}

/// The prompt names word and symbol searches, says what M-s SPC did, and
/// with isearch-lazy-count counts the matches.
#[test]
fn prompts_name_the_kind_of_search_and_count_matches() {
    let (mut ed, s) = setup("foo bar foo-bar foo bar");
    ed.press("M-s w f o o").unwrap();
    assert_eq!(ed.echo(), Some("Word I-search: foo"));
    ed.press("M-s w").unwrap();
    assert_eq!(ed.echo(), Some("I-search: foo"));
    ed.press("M-s _").unwrap();
    assert_eq!(ed.echo(), Some("Symbol I-search: foo"));
    ed.press("M-s SPC").unwrap();
    assert_eq!(ed.echo(), Some("Symbol I-search: foo [match spaces literally]"));
    ed.press("M-s SPC RET").unwrap();
    s.eval_expression(&mut ed, "e8.setDefault('isearch-lazy-count', true)").unwrap();
    ed.press("M-< C-s f o o").unwrap();
    assert_eq!(ed.echo(), Some("1/3 I-search: foo"));
    ed.press("C-s").unwrap();
    assert_eq!(ed.echo(), Some("2/3 I-search: foo"));
    ed.press("C-r").unwrap();
    assert_eq!(ed.echo(), Some("2/3 I-search backward: foo"));
    ed.press("RET").unwrap();
}

/// What with-isearch-suspended does around M-e: C-g while the search
/// fails takes off what fails and searches on; RET with the string
/// unchanged pushes no state, so DEL takes off a character; the prompt has
/// no count; and C-r there goes back to the old match's end first.
#[test]
fn m_e_resumes_as_emacs_does() {
    let d = crate::driven::Driven::new("e8.setDefault('isearch-lazy-count', true);");
    d.press("C-x b");
    d.type_text("s\n");
    d.type_text("abc abd abx");
    d.press("M-< C-s a b q M-e C-g");
    assert_eq!(d.prompt(), None);
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("1/3 I-search: ab"));
    d.press("RET M-< C-s a b d M-e");
    assert_eq!(d.prompt().as_deref(), Some("I-search: "));
    // Restarting moves the barrier, so the state is new, as in Emacs, and DEL takes it off first.
    d.press("RET DEL");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("1/1 I-search: abd"));
    d.press("DEL");
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("1/3 I-search: ab"));
    d.press("RET M-< C-s a b d M-e C-r");
    // No match current, out of the one there is.
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("0/1 Failing I-search backward: abd"));
    d.press("C-g C-g");
}

/// Lax spaces leave \s's syntax class alone; a count with
/// isearch-repeat-on-direction-change goes as many matches as it says.
#[test]
fn lax_spaces_and_counts_as_emacs_has_them() {
    let (mut ed, s) = setup("a b axb");
    s.eval_expression(&mut ed, "e8.setDefault('isearch-regexp-lax-whitespace', true)").unwrap();
    ed.press("C-M-s a \\ s SPC b RET").unwrap();
    assert_eq!(point(&ed), 3);
    let (mut ed, s) = setup("foo foo foo foo");
    s.eval_expression(&mut ed, "e8.setDefault('isearch-repeat-on-direction-change', true)").unwrap();
    ed.press("C-s f o o C-s C-s C-s").unwrap();
    assert_eq!(point(&ed), 15);
    // One back, turning round at the match's other end first: the third foo.
    s.eval_expression(&mut ed, "(e8.callWithPrefix(1, 'isearch-repeat-backward'), 0)").unwrap();
    assert_eq!(point(&ed), 8);
}

/// multi-occur lists each buffer's lines under its own header, the total
/// first, the last buffer at the top, as Emacs 30.2's multi-occur does
/// (recorded from it for the same three buffers).
#[test]
fn multi_occur_lists_the_buffers_as_emacs_does() {
    let (mut ed, s) = setup("");
    s.eval_expression(
        &mut ed,
        r#"(e8.withCurrentBuffer(e8.getBufferCreate("alpha"), () => e8.insert("one apple\ntwo pear\napple apple pie\n")),
            e8.withCurrentBuffer(e8.getBufferCreate("beta"), () => e8.insert("no fruit\nan apple a day\n")),
            e8.withCurrentBuffer(e8.getBufferCreate("gamma"), () => e8.insert("nothing\n")), 0)"#,
    )
    .unwrap();
    let d = s.eval_expression(&mut ed, r#"(e8.funcall("occur-1", "apple", null, ["alpha", "beta", "gamma"]), JSON.stringify([e8.withCurrentBuffer("*Occur*", () => e8.bufferText()), e8.currentMessage()]))"#);
    let got: String = serde_json::from_str(&d.unwrap()).unwrap();
    assert_eq!(
        got,
        serde_json::to_string(&[
            "4 matches in 3 lines total for \"apple\":\n1 match in buffer: beta\n      2:an apple a day\n3 matches in 2 lines in buffer: alpha\n      1:one apple\n      3:apple apple pie\n",
            "Searched 3 buffers; 4 matches for \"apple\""
        ])
        .unwrap()
    );
}

/// g in *Occur* after a buffer it listed was killed lists the live one as
/// one buffer and counts the killed one, as Emacs's occur-1 does; *Occur*
/// itself searched keeps its lines under another name.
#[test]
fn occur_again_counts_killed_buffers_and_keeps_a_searched_occur() {
    let (mut ed, s) = setup("");
    let got = s
        .eval_expression(
            &mut ed,
            r#"(() => {
  e8.withCurrentBuffer(e8.getBufferCreate("alpha"), () => e8.insert("one apple\napple apple pie\n"));
  e8.withCurrentBuffer(e8.getBufferCreate("beta"), () => e8.insert("an apple a day\n"));
  e8.funcall("occur-1", "apple", null, ["alpha", "beta"]);
  e8.call("kill-buffer", "beta");
  e8.withCurrentBuffer("*Occur*", () => e8.call("occur-revert-buffer"));
  const again = [e8.withCurrentBuffer("*Occur*", () => e8.bufferText()), e8.currentMessage()];
  e8.funcall("occur-1", "apple", null, ["*Occur*", "alpha"]);
  return JSON.stringify([...again, e8.bufferList().filter((b) => b.startsWith("*Occur*")).sort()]);
})()"#,
        )
        .unwrap();
    let got: String = serde_json::from_str(&got).unwrap();
    assert_eq!(
        got,
        serde_json::to_string(&serde_json::json!([
            "3 matches in 2 lines for \"apple\" in buffer: alpha\n      1:one apple\n      2:apple apple pie\n",
            "Searched 1 buffer (1 killed); 3 matches for \"apple\"",
            ["*Occur*", "*Occur*<2>"]
        ]))
        .unwrap()
    );
}
