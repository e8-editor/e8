//! Bidirectional text compared with GNU Emacs 30.2's display, on the cases
//! in `tests/emacs/bidi/cases.json`, recorded by its `record.el` into
//! `golden.json` from an interactive Emacs on a terminal 40 columns wide,
//! whose screen tmux reads. After changing the cases, record them again:
//!
//! ```text
//! cd tests/emacs/bidi && tmux new-session -d -x 40 -y 16 "emacs -Q -nw -l $PWD/record.el"
//! ```
//!
//! Each case compares what the window shows, line by line, where each
//! position shows, the levels of each screen line (`bidi-resolved-levels`),
//! the paragraph direction at each position, `move-point-visually` from
//! each position both ways, and `bidi-find-overridden-directionality`.

use std::fs;
use std::path::{Path, PathBuf};

use e8_core::bidi::Direction;
use e8_core::{Editor, Value};
use serde::Deserialize;
use serde_json::Value as Json;

#[derive(Deserialize)]
struct Case {
    name: String,
    text: String,
    #[serde(default)]
    vars: serde_json::Map<String, Json>,
    #[serde(default)]
    props: Vec<(usize, usize, String, Json)>,
}

#[derive(Deserialize)]
struct Recorded {
    name: String,
    screen: Vec<String>,
    levels: Vec<Option<Vec<u8>>>,
    cols: Vec<Option<(i64, i64)>>,
    right: Vec<Json>,
    left: Vec<Json>,
    directions: Vec<String>,
    overridden: (Option<usize>, Option<usize>),
}

#[derive(Deserialize)]
struct Golden {
    cases: Vec<Recorded>,
}

const WIDTH: usize = 40;
const HEIGHT: usize = 14;

fn oracle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/bidi")
}

fn load() -> Vec<(Case, Recorded)> {
    let dir = oracle_dir();
    let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();
    let golden: Golden = serde_json::from_str(&fs::read_to_string(dir.join("golden.json")).unwrap()).unwrap();
    assert_eq!(cases.len(), golden.cases.len(), "record the cases again");
    cases.into_iter().zip(golden.cases).inspect(|(c, r)| assert_eq!(c.name, r.name)).collect()
}

fn json_value(v: &Json) -> Value {
    match v {
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::Str(s.clone()),
        Json::Number(n) => Value::Number(n.as_f64().unwrap()),
        _ => Value::Null,
    }
}

/// An editor showing a case's text from its start, in a window as big as Emacs's.
fn editor(case: &Case) -> Editor {
    let mut ed = Editor::new();
    let window = ed.selected_window();
    ed.set_window_size(window, WIDTH, HEIGHT);
    ed.window_buffer_mut().set_text(&case.text);
    for (name, value) in &case.vars {
        let value = json_value(value);
        if name == "bidi-inhibit-bpa" { ed.set_default(name, value) } else { ed.set_variable(name, value) }
    }
    for (from, to, name, value) in &case.props {
        ed.window_buffer_mut().put_text_property(*from..*to, name, json_value(value));
    }
    ed.window_buffer_mut().set_point(0);
    ed
}

/// The window's lines as a terminal shows them: each row's glyphs, a
/// right-to-left row from the right edge, and a continued line's mark, `\`
/// at the right of a left-to-right row and `/` at the left of a
/// right-to-left one, as the terminal front end draws them.
fn screen(ed: &Editor) -> Vec<String> {
    let window = ed.selected_window();
    let rows = ed.rows_of_window(window, HEIGHT, true);
    // Lines broken between words have no mark.
    let marks = !ed.variable("word-wrap").is_some_and(|v| v.is_true());
    rows.iter()
        .map(|row| {
            let mut cells = vec![' '; WIDTH];
            let glyphs = e8_core::display::row_glyphs(row, 8);
            let offset = ed.row_offset_in(window, row).round() as i64;
            let mut x = offset;
            for g in &glyphs {
                for c in g.text.chars() {
                    if (0..WIDTH as i64).contains(&x) {
                        cells[x as usize] = c;
                    }
                    x += 1;
                }
            }
            // Broken between words, a row is short of the edge, and has no mark.
            let (edge, near) = if row.right_to_left { (offset <= 1, glyphs.first()) } else { (x >= WIDTH as i64 - 1, glyphs.last()) };
            let full = edge && near.is_some_and(|g| !matches!(g.c, ' ' | '\t'));
            if row.right_to_left && offset < 0 {
                cells[0] = '$';
            } else if row.continued && !row.broken && (marks || full) {
                if row.right_to_left { cells[0] = '/' } else { cells[WIDTH - 1] = '\\' }
            }
            cells.into_iter().collect::<String>().trim_end().to_string()
        })
        .collect()
}

/// A line of the terminal, its tabs expanded, as tmux gives back cells it
/// skipped over with them.
fn expand(line: &str) -> String {
    let mut out = String::new();
    for c in line.chars() {
        if c == '\t' {
            let n = 8 - out.chars().count() % 8;
            out.extend(std::iter::repeat_n(' ', n));
        } else {
            out.push(c);
        }
    }
    out.trim_end().to_string()
}

fn moved(ed: &mut Editor, pos: usize, dir: i64) -> Json {
    ed.window_buffer_mut().set_point(pos);
    match ed.move_point_visually(dir) {
        Ok(p) => Json::from(p + 1),
        Err(e) => Json::from(e.symbol().to_string()),
    }
}

/// Where E8 differs from Emacs on a case, one line per difference.
fn differences(case: &Case, recorded: &Recorded) -> Vec<String> {
    let mut out = Vec::new();
    let mut ed = editor(case);
    let window = ed.selected_window();
    let theirs: Vec<String> = recorded.screen.iter().map(|l| expand(l)).collect();
    let ours = screen(&ed);
    for (k, line) in theirs.iter().enumerate() {
        let mine = ours.get(k).cloned().unwrap_or_default();
        if &mine != line {
            out.push(format!("screen line {k}:\n    emacs |{line}|\n    e8 |{mine}|"));
        }
    }
    let len = ed.window_buffer().len();
    for pos in 0..=len {
        let theirs = recorded.cols[pos];
        let ours = ed.posn_at_point(pos, window).map(|p| (p.col.round() as i64, p.row as i64));
        let ours = ours.map(|(c, r)| (c.max(-1), r));
        if theirs != ours {
            out.push(format!("position {pos}: emacs shows it at {theirs:?}, e8 at {ours:?}"));
        }
    }
    for (vpos, theirs) in recorded.levels.iter().enumerate() {
        let ours = ed.bidi_resolved_levels(Some(vpos)).filter(|l| !l.is_empty());
        let theirs = theirs.clone().filter(|l| !l.is_empty());
        if theirs != ours && !(theirs.is_none() && ours.is_none()) {
            out.push(format!("levels of line {vpos}: emacs {theirs:?}, e8 {ours:?}"));
        }
    }
    for pos in 0..=len {
        ed.window_buffer_mut().set_point(pos);
        let ours = ed.current_bidi_paragraph_direction(None).map(Direction::name).unwrap_or_default();
        if ours != recorded.directions[pos] {
            out.push(format!("direction at {pos}: emacs {}, e8 {ours}", recorded.directions[pos]));
        }
    }
    for (dir, theirs) in [(1, &recorded.right), (-1, &recorded.left)] {
        for (pos, theirs) in theirs.iter().enumerate().take(len + 1) {
            let ours = moved(&mut ed, pos, dir);
            if &ours != theirs {
                out.push(format!("move-point-visually {dir} from {pos}: emacs {theirs}, e8 {ours}"));
            }
        }
    }
    let b = ed.window_buffer();
    let found = |base| ed.bidi_find_overridden_directionality(b, 0, len, base).map(|p| p + 1);
    let ours = (found(Direction::LeftToRight), found(Direction::RightToLeft));
    if ours != recorded.overridden {
        out.push(format!("overridden: emacs {:?}, e8 {ours:?}", recorded.overridden));
    }
    out
}

/// Where E8 is known to differ, by case and the start of the difference,
/// with why. docs/differences.md lists them too.
const KNOWN: &[(&str, &str, &str)] = &[
    // Emacs lays a truncated right-to-left line out afresh for these, and
    // its answers there do not follow what it shows.
    ("rtl-truncated", "move-point-visually", "moving on a truncated right-to-left line"),
    ("rtl-truncated", "position 56", "posn-at-point on a line after a truncated right-to-left one"),
    ("rtl-truncated", "position 57", "posn-at-point on a line after a truncated right-to-left one"),
    // Point inside text a display string covers, where no command leaves it.
    ("display-string", "move-point-visually", "moving from inside text a display string covers"),
    ("control-chars", "position 9", "posn-at-point on ^? at the end of a left-to-right run"),
    // tmux shows an Arabic digit, or the Arabic letter mark itself, in cells
    // Emacs says hold other characters: the screen as captured, not as Emacs
    // laid it out, as the positions there agree.
    ("random-108", "screen", "capture"),
    ("random-149", "screen", "capture"),
    ("wrapped-9", "screen", "capture"),
    ("wrapped-35", "screen", "capture"),
    ("wrapped-50", "screen", "capture"),
    ("wrapped-84", "", "the Arabic letter mark, which Emacs on a terminal shows as itself"),
    // At the end of the buffer on a wrapped line, Emacs signals where E8 stays.
    ("wrapped-9", "move-point-visually -1", "moving left from the end of the buffer"),
    ("wrapped-47", "move-point-visually -1", "moving left from the end of the buffer"),
    // A PDF ending an embedding inside an isolate, which bidi.c resolves
    // at the embedding's level and E8 at the one outside it.
    ("wrapped-65", "", "a PDF at the end of an embedding in an isolate"),
];

#[test]
fn bidirectional_text_shows_as_in_emacs() {
    let mut failures = Vec::new();
    for (case, recorded) in load() {
        let diffs: Vec<String> = differences(&case, &recorded)
            .into_iter()
            .filter(|d| !KNOWN.iter().any(|(name, start, _)| *name == case.name && d.starts_with(start)))
            .collect();
        if !diffs.is_empty() {
            failures.push(format!("{} {:?}:\n  {}", case.name, case.text, diffs.join("\n  ")));
        }
    }
    assert!(failures.is_empty(), "{} cases differ:\n{}", failures.len(), failures.join("\n"));
}

fn scripted(text: &str) -> (Editor, e8_script::Scripting) {
    let mut ed = Editor::new();
    let s = e8_script::Scripting::new(&mut ed).unwrap();
    let window = ed.selected_window();
    ed.set_window_size(window, WIDTH, HEIGHT);
    ed.window_buffer_mut().set_text(text);
    ed.window_buffer_mut().set_point(0);
    (ed, s)
}

fn eval(ed: &mut Editor, s: &e8_script::Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

#[test]
fn the_primitives_answer_as_emacs_does() {
    let (mut ed, s) = scripted("abc אבג\n\nשלום");
    // As get-char-code-property gives them in Emacs 30.2.
    assert_eq!(
        eval(&mut ed, &s, r"JSON.stringify(['a', 'א', 'ع', '1', '\u0663', '\u202b'].map((c) => e8.getCharCodeProperty(c, 'bidi-class')))"),
        r#""[\"L\",\"R\",\"AL\",\"EN\",\"AN\",\"RLE\"]""#
    );
    assert_eq!(
        eval(
            &mut ed,
            &s,
            "JSON.stringify([e8.getCharCodeProperty(']', 'paired-bracket'), e8.getCharCodeProperty('(', 'bracket-type'), e8.getCharCodeProperty('<', 'mirroring'), e8.getCharCodeProperty('a', 'mirroring') ?? null, e8.getCharCodeProperty('<', 'mirrored')])"
        ),
        r#""[91,\"o\",62,null,\"Y\"]""#
    );
    // The first paragraph reads left to right, the second right to left.
    assert_eq!(eval(&mut ed, &s, "e8.currentBidiParagraphDirection()"), "\"left-to-right\"");
    eval(&mut ed, &s, "e8.gotoChar(e8.pointMax())");
    assert_eq!(eval(&mut ed, &s, "e8.currentBidiParagraphDirection()"), "\"right-to-left\"");
    eval(&mut ed, &s, "e8.setVariable('bidi-paragraph-direction', Symbol.for('left-to-right'))");
    assert_eq!(eval(&mut ed, &s, "e8.currentBidiParagraphDirection()"), "\"left-to-right\"");
    eval(&mut ed, &s, "e8.setVariable('bidi-paragraph-direction', null)");
    // bidi-resolved-levels of the first line, as Emacs reports them.
    eval(&mut ed, &s, "e8.gotoChar(0)");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.bidiResolvedLevels())"), "\"[0,0,0,0,1,1,1]\"");
    // bidi-find-overridden-directionality on strings, as Emacs answers.
    assert_eq!(eval(&mut ed, &s, r"e8.bidiFindOverriddenDirectionality(0, 8, 'abc\u202ejkl\u202c')"), "4");
    assert_eq!(eval(&mut ed, &s, r"e8.bidiFindOverriddenDirectionality(0, 8, 'abc\u202bdef\u202c', Symbol.for('right-to-left'))"), "4");
    assert_eq!(eval(&mut ed, &s, "e8.bidiFindOverriddenDirectionality(0, 6, 'abcdef') === undefined"), "true");
}

#[test]
fn moving_on_display_and_by_the_paragraph_s_direction() {
    let (mut ed, s) = scripted("שלום abc");
    // In a right-to-left paragraph, <left> goes forward in the buffer and
    // <right> back, as right-char and left-char do.
    ed.buffer_mut().set_point(1);
    ed.press("<left>").unwrap();
    assert_eq!(ed.buffer().point(), 2);
    ed.press("<right> <right>").unwrap();
    assert_eq!(ed.buffer().point(), 0);
    // With visual-order-cursor-movement, to the character left on display:
    // from ם, past the space, to c at the right end of abc.
    ed.set_variable("visual-order-cursor-movement", Value::Bool(true));
    ed.buffer_mut().set_point(3);
    ed.press("<left>").unwrap();
    assert_eq!(ed.buffer().point(), 4);
    ed.press("<left>").unwrap();
    assert_eq!(ed.buffer().point(), 7);
    assert_eq!(eval(&mut ed, &s, "e8.movePointVisually(-1)"), "6");
    // subr.el's bidi-string-mark-left-to-right: an LRM after right-to-left text.
    eval(&mut ed, &s, "import('subr').then(({ bidiStringMarkLeftToRight: m }) => e8.setDefault('marked', [String(m('abc')), String(m('אבג')).length]))");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.variable('marked'))"), r#""[\"abc\",4]""#);
}
