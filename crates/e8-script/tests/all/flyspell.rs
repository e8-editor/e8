//! Flyspell and M-$ where the oracle cannot look: the underlines, checking
//! only comments in code, and choosing a correction in *Choices*. Checks
//! need a spell checker; without one they pass without checking.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup(text: &str) -> Option<(Editor, Scripting)> {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let program = scripting.eval_expression(&mut ed, r#"String(e8.variable("ispell-program-name"))"#).unwrap().trim_matches('"').to_string();
    if std::process::Command::new(&program).arg("-v").output().is_err() {
        return None;
    }
    ed.window_buffer_mut().set_text(text);
    Some((ed, scripting))
}

/// The words flyspell underlines, and with which face, once the checker's
/// answers have come, as the command loop takes them in while it waits.
fn marked(ed: &mut Editor, scripting: &Scripting) -> String {
    while scripting.eval_expression(ed, "e8.acceptProcessOutput(undefined, 0.3)").unwrap() == "true" {}
    scripting
        .eval_expression(
            ed,
            r#"e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "flyspell-overlay") === true)
                .sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b))
                .map((o) => e8.bufferSubstringNoProperties(e8.overlayStart(o), e8.overlayEnd(o)) + ":" + e8.overlayGet(o, "face")).join(" ")"#,
        )
        .unwrap()
        .trim_matches('"')
        .to_string()
}

#[test]
fn flyspell_buffer_underlines_misspellings_and_doubled_words() {
    let Some((mut ed, s)) = setup("A speling mistake and and a wrod.\n") else { return };
    ed.call("flyspell-buffer", vec![]).unwrap();
    assert_eq!(marked(&mut ed, &s), "speling:flyspell-incorrect and:flyspell-duplicate wrod:flyspell-incorrect");
    assert_eq!(ed.echo(), Some("Spell Checking completed."));
}

#[test]
fn typing_a_misspelling_underlines_it_and_correcting_it_takes_the_line_off() {
    let Some((mut ed, s)) = setup("") else { return };
    ed.press("M-x f l y s p e l l - m o d e RET").unwrap();
    ed.press("t e h SPC").unwrap();
    assert_eq!(marked(&mut ed, &s), "teh:flyspell-incorrect");
    ed.press("C-b C-.").unwrap();
    assert_eq!(marked(&mut ed, &s), "");
}

#[test]
fn flyspell_prog_mode_checks_only_comments() {
    let Some((mut ed, s)) = setup("spelin = 1  # a speling\n") else { return };
    ed.call("python-ts-mode", vec![]).ok();
    if ed.variable("major-mode").and_then(|v| v.as_str().map(str::to_string)).as_deref() != Some("python-ts-mode") {
        return;
    }
    ed.call("flyspell-prog-mode", vec![]).unwrap();
    ed.call("flyspell-buffer", vec![]).unwrap();
    let marks = marked(&mut ed, &s);
    assert_eq!(marks, "speling:flyspell-incorrect", "only the comment's");
    let at: usize = s.eval_expression(&mut ed, r#"String(e8.overlayStart(e8.overlaysIn(0, e8.bufferSize())[0]))"#).unwrap().trim_matches('"').parse().unwrap();
    assert_eq!(at, 16);
}

#[test]
fn ispell_word_offers_corrections_in_choices() {
    let Some((mut ed, _s)) = setup("A speling mistake.\n") else { return };
    ed.call("forward-word", vec![Arg::Int(2)]).unwrap();
    ed.press("M-$ 0").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "A spelling mistake.\n");
    assert!(!ed.buffers().iter().any(|b| b.name == "*Choices*"), "killed afterwards, as ispell-word does");
    assert_eq!(ed.window_list().len(), 1, "the choices window goes");
}

#[test]
fn scrolling_with_the_wheel_checks_no_word_while_it_goes_on() {
    // A misspelling on every line, so wherever point is moved to keep it
    // in the window, it leaves one.
    let text: String = (0..80).map(|n| format!("wrod number {n}\n")).collect();
    let Some((mut ed, s)) = setup(&text) else { return };
    ed.set_viewport_height(10);
    ed.press("M-x f l y s p e l l - m o d e RET").unwrap();
    ed.press("M-<").unwrap();
    // The first step may check the word point leaves, as after any other
    // command; after that the wheel is a movement repeated, as
    // scroll-up and scroll-down are for Emacs's flyspell.
    ed.wheel(1);
    let first = marked(&mut ed, &s).split(' ').filter(|w| !w.is_empty()).count();
    for _ in 0..20 {
        ed.wheel(1);
    }
    let after = marked(&mut ed, &s).split(' ').filter(|w| !w.is_empty()).count();
    assert_eq!(after, first, "words were checked during the scroll: {}", marked(&mut ed, &s));
}

#[test]
fn looking_for_a_word_elsewhere_finds_what_the_regexp_alone_found() {
    // flyspell looks for a misspelling elsewhere with a literal search
    // first, then the regexp around each place: compared here with the
    // regexp alone, as flyspell-word-search-backward and -forward search,
    // over random text whose words overlap and touch the buffer's ends.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "compare.ts",
        r#"import("flyspell").then(({ wordSearches }) => import("subr").then(({ regexpQuote }) => import("ispell").then(({ wordAt }) => {
          let seed = 7;
          const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
          const pieces = ["ab", "ab", "aab", "ba", "Ab", "åb", "a-b", " ", " ", "\n", ".", "1"];
          const words = ["ab", "a", "b", "Ab", "åb"];
          const oldBackward = (word: string, bound: number, ignoreCase: boolean) => e8.saveExcursion(() => {
            const re = `\\(?:[^[:alpha:]]\\|\\\`\\)${regexpQuote(word)}[^[:alpha:]]`;
            const limit = bound > e8.pointMin() ? bound - 1 : undefined;
            for (;;) {
              if (e8.reSearchBackward(re, { bound: limit, noerror: true, caseFold: ignoreCase }) === undefined) return undefined;
              if (e8.point() !== e8.pointMin()) e8.gotoChar(e8.point() + 1);
              const p = e8.point();
              const found = wordAt();
              if (found && (ignoreCase ? found.word.toLowerCase() === word.toLowerCase() : found.word === word)) return p;
              e8.gotoChar(p);
            }
          });
          const oldForward = (word: string, bound: number) => e8.saveExcursion(() => {
            const re = `[^[:alpha:]]${regexpQuote(word)}\\(?:[^[:alpha:]]\\|\\'\\)`;
            const limit = bound < e8.pointMax() ? bound + 1 : undefined;
            for (;;) {
              if (e8.reSearchForward(re, { bound: limit, noerror: true }) === undefined) return undefined;
              if (e8.point() !== e8.pointMax()) e8.gotoChar(e8.point() - 1);
              const p = e8.point();
              if (wordAt()?.word === word) return p;
              e8.gotoChar(p + 1);
            }
          });
          const bad: string[] = [];
          let tried = 0;
          for (let round = 0; round < 300; round++) {
            e8.deleteRegion(e8.pointMin(), e8.pointMax());
            let text = "";
            for (let i = 0, n = 1 + random(14); i < n; i++) text += pieces[random(pieces.length)];
            e8.insert(text);
            const size = e8.pointMax();
            for (let k = 0; k < 6; k++) {
              const word = words[random(words.length)];
              const point = 1 + random(size);
              const bound = 1 + random(size);
              const fold = random(2) === 0;
              e8.gotoChar(point);
              const a = oldBackward(word, Math.min(bound, point), fold);
              const b = wordSearches.backward(word, Math.min(bound, point), fold);
              e8.setVariable("case-fold-search", fold);
              const c = oldForward(word, Math.max(bound, point));
              const d = wordSearches.forward(word, Math.max(bound, point));
              e8.setVariable("case-fold-search", true);
              tried++;
              if (a !== b || c !== d) bad.push(JSON.stringify({ text, word, point, bound, fold, backward: [a, b], forward: [c, d] }));
            }
          }
          e8.setVariable("flyspell-test-result", `${tried} ${bad.slice(0, 3).join("\n")}`);
        })));"#
            .to_string(),
    )
    .unwrap();
    let result = s.eval_expression(&mut ed, "e8.variable('flyspell-test-result')").unwrap();
    assert_eq!(result, "\"1800 \"", "the searches differ:\n{result}");
}
