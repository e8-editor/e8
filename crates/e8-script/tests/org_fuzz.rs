//! Finds where E8's org-mode differs from Emacs's by trying random cases.
//!
//! It writes random Org documents and key sequences as oracle cases, records
//! what GNU Emacs does with them using record.el, runs them through E8,
//! and shrinks each case that differs to fewer keys and lines, so it can be
//! read and added to `tests/emacs/cases/`. It needs Emacs, so it is ignored
//! unless asked for:
//!
//! ```text
//! cargo test --release -p e8-script --test org_fuzz -- --ignored --nocapture
//! ```
//!
//! `E8_FUZZ_SEED` picks the random cases, so a run can be repeated, and
//! `E8_FUZZ_CASES` says how many to try (300 by default), and
//! `E8_FUZZ_SHRINK_ROUNDS` how many rounds of shrinking (20). The shrunk
//! cases are written to `target/org-fuzz/differences.json`.

mod oracle;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use oracle::{Case, Golden, State, differences, oracle_dir, run};

/// A small random number generator, so the fuzzer needs no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

const WORDS: &[&str] = &["alpha", "beta", "gamma", "notes", "plan", "read", "call", "fix"];

fn heading(rng: &mut Rng, level: usize) -> String {
    let mut line = "*".repeat(level);
    line.push(' ');
    if rng.chance(40) {
        line.push_str(rng.pick(&["TODO ", "DONE "]));
    }
    if rng.chance(20) {
        line.push_str(rng.pick(&["[#A] ", "[#B] ", "[#C] "]));
    }
    line.push_str(rng.pick(WORDS));
    if rng.chance(50) {
        line.push(' ');
        line.push_str(rng.pick(WORDS));
    }
    if rng.chance(15) {
        line.push_str(rng.pick(&[" [/]", " [1/2]", " [%]"]));
    }
    if rng.chance(20) {
        line.push_str(rng.pick(&[" :work:", " :home:x:"]));
    }
    line
}

fn list(rng: &mut Rng, out: &mut Vec<String>) {
    let bullet = rng.pick(&["-", "+", "1.", "1)"]);
    let boxes = rng.chance(40);
    // Lists are often spaced out with a blank line between items.
    let spaced = rng.chance(25);
    let count = 2 + rng.below(3);
    for n in 0..count {
        if spaced && n > 0 {
            out.push(String::new());
        }
        let b = match bullet.strip_prefix('1') {
            Some(style) => format!("{}{style}", n + 1),
            None => bullet.to_string(),
        };
        let mut line = format!("{b} ");
        if boxes {
            line.push_str(rng.pick(&["[ ] ", "[X] "]));
        }
        line.push_str(rng.pick(WORDS));
        out.push(line);
        if rng.chance(25) {
            let indent = " ".repeat(b.len() + 1);
            let child = rng.pick(&["-", "+"]);
            out.push(format!("{indent}{child} {}", rng.pick(WORDS)));
        }
        if rng.chance(10) {
            out.push(format!("{}{}", " ".repeat(b.len() + 1), rng.pick(WORDS)));
        }
    }
}

/// Drawers, blocks, keywords, comments, links and closed planning lines.
fn other(rng: &mut Rng, out: &mut Vec<String>) {
    let lines: &[&str] = match rng.below(7) {
        0 => &[":LOGBOOK:", "- note", ":END:"],
        1 => &["#+BEGIN_SRC", "code here", "#+END_SRC"],
        2 => &["#+begin_quote", "quoted", "#+end_quote"],
        3 => &["#+TITLE: notes"],
        4 => &["# a comment"],
        5 => &["see [[*notes][the notes]] now"],
        _ => &["CLOSED: [2026-10-20 Tue 10:00]"],
    };
    out.extend(lines.iter().map(|l| l.to_string()));
}

fn table(rng: &mut Rng, out: &mut Vec<String>) {
    let rows = 2 + rng.below(2);
    for r in 0..rows {
        if r == 1 && rng.chance(50) {
            out.push(rng.pick(&["|---+---|", "|-"]).to_string());
        }
        let a = rng.pick(&["a", "bb", "12", "ccc", ""]);
        let b = rng.pick(&["x", "yy", "3", ""]);
        out.push(if rng.chance(30) { format!("|{a}|{b}|") } else { format!("| {a} | {b} |") });
    }
}

fn document(rng: &mut Rng) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut level = 1;
    for _ in 0..3 + rng.below(5) {
        match rng.below(10) {
            0..=3 => {
                level = (level + rng.below(3)).saturating_sub(1).clamp(1, 3);
                out.push(heading(rng, level));
                if rng.chance(15) {
                    out.push(rng.pick(&["SCHEDULED: <2026-10-28 Wed>", "DEADLINE: <2026-11-01 Sun +1w>"]).to_string());
                }
                if rng.chance(10) {
                    out.extend([":PROPERTIES:", ":ID: 1", ":END:"].map(String::from));
                }
            }
            4 | 5 => list(rng, &mut out),
            6 => table(rng, &mut out),
            7 => out.push(format!("{} <2026-10-{} Wed>", rng.pick(WORDS), 10 + rng.below(19))),
            8 => out.push(String::new()),
            9 if rng.chance(50) => other(rng, &mut out),
            _ => out.push(format!("{}{} {}", rng.pick(&["", "  "]), rng.pick(WORDS), rng.pick(WORDS))),
        }
    }
    let mut text = out.join("\n");
    // Org loops forever skipping comments in org-toggle-heading when the
    // last line is one, so a comment always ends with a newline.
    if rng.chance(85) || out.last().is_some_and(|l| l.starts_with("# ")) {
        text.push('\n');
    }
    text
}

/// Keys that run Org's commands without prompting, and plain motion and typing.
const ORG_KEYS: &[&str] = &[
    "TAB", "<backtab>", "M-RET", "C-<return>", "M-S-<return>", "M-<left>", "M-<right>", "M-<up>", "M-<down>",
    "M-S-<left>", "M-S-<right>", "M-S-<up>", "M-S-<down>", "S-<left>", "S-<right>", "S-<up>", "S-<down>",
    "C-c C-t", "C-c C-c", "C-c -", "C-c *", "C-c C-x C-b", "C-c C-n", "C-c C-p", "C-c C-f", "C-c C-b", "C-c C-u",
    "C-c @", "RET", "DEL", "C-d", "C-k", "C-c C-x C-w", "C-c C-x M-w", "C-c C-x C-y", "C-u TAB",
    "C-c SPC", "C-x n s", "C-x n e", "C-x n b", "C-x n w",
];
/// Editing keys from outside Org, which Org leaves alone or remaps.
const EDIT_KEYS: &[&str] = &["C-y", "M-y", "C-w", "M-w", "C-SPC", "C-/", "C-o", "M-d", "M-DEL", "C-t", "C-j", "M-<", "M->"];
const MOTION_KEYS: &[&str] = &["C-n", "C-p", "C-f", "C-b", "C-a", "C-e", "M-f", "M-b"];
const TYPING_KEYS: &[&str] = &["x", "SPC", "-", "|", "1"];

fn keys(rng: &mut Rng) -> String {
    let n = 1 + rng.below(5);
    (0..n)
        .map(|_| match rng.below(22) {
            0..=10 => rng.pick(ORG_KEYS),
            11..=16 => rng.pick(MOTION_KEYS),
            17 | 18 => rng.pick(EDIT_KEYS),
            _ => rng.pick(TYPING_KEYS),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn random_case(rng: &mut Rng, name: String) -> Case {
    let text = document(rng);
    let lines: Vec<&str> = text.split('\n').collect();
    let line = rng.below(lines.len());
    let start: usize = lines[..line].iter().map(|l| l.chars().count() + 1).sum();
    let column = rng.below(lines[line].chars().count() + 1);
    Case {
        name,
        point: start + column,
        text,
        keys: keys(rng),
        modes: vec!["org-mode".into()],
        call: Vec::new(),
        platform: None,
        windows: false,
        answers: Vec::new(),
        visit: None,
        today: None,
        agenda_files: false,
        capture_templates: Vec::new(),
        files: Default::default(),
        find: None,
        disk: None,
        message: false,
        vars: Default::default(),
        lockfiles: false,
        capf: Vec::new(),
        completions: false,
    }
}

/// Records what Emacs does with the cases, in a directory of their own.
/// Org can loop forever on some cases, so a run that takes too long is
/// stopped and the cases are recorded in halves, leaving out any case that
/// hangs by itself.
fn record(dir: &Path, cases: &[Case]) -> BTreeMap<String, State> {
    match record_within(dir, cases, Duration::from_secs(10 + cases.len() as u64 / 100)) {
        Some(states) => states,
        None if cases.len() == 1 => {
            eprintln!("Emacs hangs on {}; leaving it out", cases[0].name);
            BTreeMap::new()
        }
        None => {
            let (a, b) = cases.split_at(cases.len() / 2);
            let mut states = record(dir, a);
            states.extend(record(dir, b));
            states
        }
    }
}

/// Records the cases with one run of Emacs, or `None` if it takes longer than `limit`.
fn record_within(dir: &Path, cases: &[Case], limit: Duration) -> Option<BTreeMap<String, State>> {
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir.join("cases")).unwrap();
    fs::write(dir.join("cases/fuzz.json"), serde_json::to_string_pretty(cases).unwrap()).unwrap();
    let mut child = Command::new("emacs")
        .args(["-Q", "--batch", "-l"])
        .arg(oracle_dir().join("record.el"))
        .env("E8_ORACLE_DIR", dir)
        .env("E8_ORACLE_FILES", dir.join("files"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("emacs runs");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    assert!(status.success(), "Emacs failed: {stderr}");
    let golden: Golden = serde_json::from_str(&fs::read_to_string(dir.join("golden/fuzz.json")).unwrap()).unwrap();
    Some(golden.cases.into_iter().map(|r| (r.name, r.state)).collect())
}

/// Which of a case's fields differ between Emacs and E8, or `None` if
/// the case cannot be compared because it made Emacs prompt.
fn compare(case: &Case, emacs: &State) -> Option<String> {
    // Emacs asked more than the answers cover, which Dired catches and shows.
    if [&emacs.error, &emacs.message].iter().any(|t| t.as_deref().is_some_and(|e| e.contains("Minibuffer read"))) {
        return None;
    }
    // Emacs failing on a wrong type is a bug in its Lisp, as
    // org-narrow-to-element on an empty item, not behaviour to match.
    if emacs.error.as_deref().is_some_and(|e| e.starts_with("Wrong type argument")) {
        return None;
    }
    // A case that left its directory, as Dired's ^ does, sees the directories
    // around it, which differ between Emacs's run and E8's.
    if outside_its_directory(emacs) {
        return None;
    }
    // Batch Emacs does not wrap long lines, so C-n and C-p move by whole
    // lines there where E8 moves by the rows a long line wraps into.
    if moves_by_lines(&case.keys) && case.text.lines().any(|l| columns(l) >= 80) {
        return None;
    }
    // Org's parser fails on timestamps that only its loose regexp matches,
    // in nearly any command in their entry; E8 fails only where it parses
    // them (see known-gaps.txt), so these cases are left out too.
    if emacs.error.as_deref().is_some_and(|e| e.starts_with("Not an Org time string")) {
        return None;
    }
    let e8 = std::panic::catch_unwind(|| run(case));
    match e8 {
        Ok(e8) => Some(differences(&without_clock_times(emacs), &without_clock_times(&e8))),
        Err(_) => Some("    E8 panicked".into()),
    }
}

/// Whether keys move point by screen lines, as C-n and C-p do.
fn moves_by_lines(keys: &str) -> bool {
    keys.split(' ').any(|k| matches!(k, "C-n" | "C-p" | "<down>" | "<up>" | "S-<down>" | "S-<up>"))
}

/// How many columns a line takes, with tabs to every eighth.
fn columns(line: &str) -> usize {
    line.chars().fold(0, |col, c| if c == '\t' { col / 8 * 8 + 8 } else { col + 1 })
}

/// Whether a state names a place in the repository outside the case's own
/// directory, which record.el writes as DIR.
fn outside_its_directory(state: &State) -> bool {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = fs::canonicalize(&root).unwrap_or(root);
    let forms = [root.display().to_string(), e8_core::abbreviate_path(&root)];
    let texts = [Some(&state.text), state.error.as_ref(), state.message.as_ref()];
    texts.into_iter().flatten().any(|t| forms.iter().any(|f| t.contains(f.as_str())))
}

/// A state with the times of inactive timestamps blanked out. Org logs the
/// time of a change, and Emacs ran a while before E8, so the minute can
/// differ.
fn without_clock_times(state: &State) -> State {
    let blank = |s: &str| -> String {
        let mut chars: Vec<char> = s.chars().collect();
        for i in 0..chars.len() {
            // "[2026-10-28 Wed 11:46]": the time is the five characters before the bracket.
            if chars[i] == ']' && i >= 21 && chars[i - 21] == '[' && chars[i - 3] == ':' {
                for c in &mut chars[i - 5..i] {
                    if *c != ':' {
                        *c = '0';
                    }
                }
            }
        }
        chars.into_iter().collect()
    };
    // Emacs reports deleting past the buffer's ends with an internal "Args out
    // of range" error; E8 says which end, on purpose (see known-gaps.txt).
    let error = match state.error.as_deref() {
        Some(e) if e.starts_with("Args out of range: #<buffer") || e == "End of buffer" || e == "Beginning of buffer" => {
            Some("out of range".to_string())
        }
        _ => state.error.clone(),
    };
    State {
        text: blank(&state.text),
        visible: blank(&state.visible),
        kill_ring: state.kill_ring.iter().map(|k| blank(k)).collect(),
        error,
        ..state.clone()
    }
}

/// The names of the fields that differ, so shrinking keeps to the same difference.
fn fields(diff: &str) -> BTreeSet<String> {
    diff.lines().filter_map(|l| l.trim().split(':').next()).map(String::from).collect()
}

/// Smaller versions of a case: one key fewer, or one line fewer.
fn shrinks(case: &Case) -> Vec<Case> {
    let mut out = Vec::new();
    let keys: Vec<&str> = case.keys.split(' ').collect();
    // Keys of a sequence such as "C-c C-t" go together.
    let mut groups: Vec<Vec<&str>> = Vec::new();
    for k in keys {
        match groups.last_mut() {
            Some(g) if matches!(*g.last().unwrap(), "C-c" | "C-x" | "C-u") => g.push(k),
            Some(g) if g.len() >= 2 && g[g.len() - 2] == "C-c" && *g.last().unwrap() == "C-x" => g.push(k),
            _ => groups.push(vec![k]),
        }
    }
    for i in 0..groups.len() {
        if groups.len() > 1 {
            let rest: Vec<&str> = groups.iter().enumerate().filter(|(j, _)| *j != i).flat_map(|(_, g)| g.clone()).collect();
            out.push(Case { keys: rest.join(" "), ..case.clone() });
        }
    }
    let lines: Vec<&str> = case.text.split('\n').collect();
    let mut start = 0;
    for (i, line) in lines.iter().enumerate() {
        let len = line.chars().count() + 1;
        if lines.len() > 1 {
            let text = lines.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
            let point = if case.point >= start + len { case.point - len } else { case.point.min(start) };
            if point <= text.chars().count() {
                out.push(Case { text, point, ..case.clone() });
            }
        }
        start += len;
    }
    out
}

#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn org_mode_behaves_like_emacs_on_random_cases() {
    fuzz("org-fuzz", random_case);
}

/// Words, punctuation, indentation and blank lines for plain text.
fn text_document(rng: &mut Rng) -> String {
    let mut lines: Vec<String> = Vec::new();
    for _ in 0..1 + rng.below(5) {
        if rng.chance(15) {
            lines.push(String::new());
            continue;
        }
        let mut line = rng.pick(&["", "", "  ", "\t"]).to_string();
        for w in 0..1 + rng.below(5) {
            if w > 0 {
                line.push_str(rng.pick(&[" ", " ", "  ", ", ", ". ", "-"]));
            }
            line.push_str(rng.pick(&["one", "two", "three", "foo_bar", "x", "Hello", "it's", "42", "a.b"]));
        }
        if rng.chance(20) {
            line.push_str(rng.pick(&[".", "!", " ", "?"]));
        }
        lines.push(line);
    }
    let mut text = lines.join("\n");
    if rng.chance(70) {
        text.push('\n');
    }
    text
}

/// Keys for plain editing, outside any mode: motion, killing, yanking, the
/// mark, undo, transposing and prefix arguments.
const EDIT_ONLY_KEYS: &[&str] = &[
    "C-f", "C-b", "C-n", "C-p", "C-a", "C-e", "M-f", "M-b", "M-<", "M->", "C-d", "DEL", "M-d", "M-DEL", "C-k",
    "C-y", "M-y", "C-w", "M-w", "C-SPC", "C-x C-x", "C-x h", "C-/", "C-?", "C-t", "M-t", "C-x C-t", "C-o", "C-j",
    "RET", "C-u", "M-2", "C--", "S-<right>", "S-<left>", "S-<down>", "C-g",
];

/// Keys for windows, mixed into some cases, whose windows are compared too.
/// C-x - and scrolling down in another window are left out: batch Emacs,
/// which never redisplays, gets them differently from an Emacs on screen.
const WINDOW_KEYS: &[&str] = &[
    "C-x 2", "C-x 3", "C-x o", "C-x 0", "C-x 1", "C-x ^", "C-x }", "C-x {", "C-x +", "C-M-v",
];

fn random_text_case(rng: &mut Rng, name: String) -> Case {
    let text = text_document(rng);
    let point = rng.below(text.chars().count() + 1);
    let windows = rng.chance(25);
    let n = 1 + rng.below(if windows { 8 } else { 6 });
    let keys = (0..n)
        .map(|_| {
            if windows && rng.chance(50) {
                rng.pick(WINDOW_KEYS)
            } else if rng.chance(80) {
                rng.pick(EDIT_ONLY_KEYS)
            } else {
                rng.pick(&["x", "SPC", "1"])
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Case {
        name,
        point,
        text,
        keys,
        modes: Vec::new(),
        call: Vec::new(),
        platform: None,
        windows,
        answers: Vec::new(),
        visit: None,
        today: None,
        agenda_files: false,
        capture_templates: Vec::new(),
        files: Default::default(),
        find: None,
        disk: None,
        message: false,
        vars: Default::default(),
        lockfiles: false,
        capf: Vec::new(),
        completions: false,
    }
}

/// Words for filling, with sentence ends, an abbreviation and punctuation.
const FILL_WORDS: &[&str] = &[
    "a", "the", "notes", "plan", "fixes", "breaking", "considerable", "end.", "Mr.", "done,", "(aside)", "why?", "x",
    "supercalifragilistic",
];
/// Prefixes a paragraph's lines can start with.
const FILL_PREFIXES: &[&str] = &["", "", "", "  ", "    ", "> ", "- ", "# ", ";; ", "\t"];

/// Paragraphs of words between blank lines, their lines starting with a
/// prefix, the first line's sometimes different, as bullets are.
fn fill_document(rng: &mut Rng) -> String {
    let mut paragraphs = Vec::new();
    for _ in 0..1 + rng.below(3) {
        let prefix = rng.pick(FILL_PREFIXES);
        let first = if rng.chance(30) { rng.pick(FILL_PREFIXES) } else { prefix };
        let lines = (0..1 + rng.below(4))
            .map(|i| {
                let words: Vec<&str> = (0..1 + rng.below(9)).map(|_| rng.pick(FILL_WORDS)).collect();
                let mut line = String::from(if i == 0 { first } else { prefix });
                for (j, w) in words.iter().enumerate() {
                    if j > 0 {
                        line.push_str(rng.pick(&[" ", " ", " ", "  ", "\t"]));
                    }
                    line.push_str(w);
                }
                line
            })
            .collect::<Vec<_>>();
        paragraphs.push(lines.join("\n"));
    }
    let mut text = paragraphs.join(rng.pick(&["\n\n", "\n\n", "\n \n"]));
    if rng.chance(70) {
        text.push('\n');
    }
    text
}

const FILL_KEYS: &[&str] = &[
    "M-q", "M-q", "M-q", "C-u M-q", "C-n", "C-p", "M-f", "C-a", "C-e", "M->", "M-<", "C-SPC", "C-x h", "C-/",
];

/// Fills random paragraphs at a random fill column, sometimes typing with
/// Auto Fill mode on.
fn random_fill_case(rng: &mut Rng, name: String) -> Case {
    let text = fill_document(rng);
    let point = rng.below(text.chars().count() + 1);
    let auto = rng.chance(40);
    let n = 1 + rng.below(6);
    let keys = (0..n)
        .map(|_| {
            if auto && rng.chance(60) {
                rng.pick(&["x", "y", "z", "SPC", "SPC", ".", "RET"])
            } else {
                rng.pick(FILL_KEYS)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut vars = BTreeMap::new();
    vars.insert("fill-column".to_string(), serde_json::json!(8 + rng.below(30)));
    Case {
        name,
        point,
        text,
        keys,
        modes: if auto { vec!["auto-fill-mode".to_string()] } else { Vec::new() },
        vars,
        call: Vec::new(),
        platform: None,
        windows: false,
        answers: Vec::new(),
        visit: None,
        today: None,
        agenda_files: false,
        capture_templates: Vec::new(),
        files: Default::default(),
        find: None,
        disk: None,
        message: false,
        lockfiles: false,
        capf: Vec::new(),
        completions: false,
    }
}

/// Keys for Electric Pair mode: parens, quotes, typing, deleting and moving.
const PAIR_KEYS: &[&str] = &[
    "(", ")", "[", "]", "{", "}", "\"", "\"", "(", ")", "a", "SPC", "DEL", "DEL", "RET", "C-f", "C-b", "C-x h",
    "C-SPC", "M-f", "C-/", "\\", "C-M-f", "C-M-b", "C-M-u",
];

/// Random text with parens, brackets and strings, typed into with
/// Electric Pair mode on, sometimes in Text mode.
fn random_pair_case(rng: &mut Rng, name: String) -> Case {
    let pieces = ["(", ")", "[", "]", "{", "}", "\"", "a", "bc", " ", "\n", "\\", "'"];
    let text: String = (0..rng.below(14)).map(|_| rng.pick(&pieces)).collect();
    let point = rng.below(text.chars().count() + 1);
    let keys = (0..1 + rng.below(7)).map(|_| rng.pick(PAIR_KEYS)).collect::<Vec<_>>().join(" ");
    let mut modes = vec!["electric-pair-mode".to_string()];
    if rng.chance(25) {
        modes.insert(0, "text-mode".to_string());
    }
    Case { name, text, point, keys, modes, ..random_fill_case(rng, String::new()) }
}

/// Fuzzes Electric Pair mode and the sexp commands.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn electric_pair_behaves_like_emacs_on_random_cases() {
    fuzz("pair-fuzz", random_pair_case);
}

/// Fuzzes filling, M-q and Auto Fill mode.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn filling_behaves_like_emacs_on_random_cases() {
    fuzz("fill-fuzz", random_fill_case);
}

/// Fuzzes editing outside any mode, as the org fuzzer does org-mode.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn plain_editing_behaves_like_emacs_on_random_cases() {
    fuzz("edit-fuzz", random_text_case);
}

/// Keys that save, revert and change the visited file on disk (<f33>).
const FILE_KEYS: &[&str] = &["C-x C-s", "C-x C-s", "<f33>", "<f33>", "C-x x g", "M-~"];

/// A case visiting a file for real, in Text mode or Fundamental mode,
/// that edits, saves and reverts it while it changes on disk. Questions
/// are answered "yes" or "no", which a question read by a key takes as y
/// or n, so both editors take answers alike.
fn random_file_case(rng: &mut Rng, name: String) -> Case {
    let text = text_document(rng);
    let point = rng.below(text.chars().count() + 1);
    let n = 1 + rng.below(8);
    let keys = (0..n)
        .map(|_| {
            if rng.chance(40) {
                rng.pick(FILE_KEYS)
            } else if rng.chance(80) {
                // Not M-y, which without a yank reads a kill in the
                // minibuffer in Emacs, where the case's answers would go.
                rng.pick(&EDIT_ONLY_KEYS.iter().copied().filter(|k| *k != "M-y").collect::<Vec<_>>())
            } else {
                rng.pick(&["x", "SPC", "1"])
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let disk = if rng.chance(30) { text.clone() } else { text_document(rng) };
    let answers = (0..rng.below(4)).map(|_| rng.pick(&["yes", "no"]).to_string()).collect();
    Case {
        name,
        point,
        text,
        keys,
        modes: Vec::new(),
        call: Vec::new(),
        platform: None,
        windows: false,
        answers,
        visit: None,
        today: None,
        agenda_files: false,
        capture_templates: Vec::new(),
        files: Default::default(),
        find: Some(rng.pick(&["a.txt", "data"]).to_string()),
        disk: Some(disk),
        message: false,
        vars: Default::default(),
        lockfiles: false,
        capf: Vec::new(),
        completions: false,
    }
}

/// Fuzzes visiting, saving and reverting files that change on disk.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn file_editing_behaves_like_emacs_on_random_cases() {
    fuzz("file-fuzz", random_file_case);
}

/// Dired's keys, for the Dired fuzzer. Not s, whose sorting by time is
/// a toss-up for files made at once; not ^, which leaves the case's
/// directory for one that differs; and not M-DEL or * c, which batch Emacs
/// reads a key for from standard input.
const DIRED_KEYS: &[&str] = &[
    "n", "p", "SPC", "S-SPC", "C-n", "C-p", "<down>", "<up>", ">", "<", "M-<", "M->", "m", "u", "d", "t", "U", "DEL",
    "M-2 m", "M-2 d", "C-u m", "* /", "~", "#", "% m", "% d", "* !", "M-}", "M-{", "x", "D", "C", "R", "+", "g", "k",
    "w", "RET", "j", "(", "* t",
];

fn random_dired_case(rng: &mut Rng, name: String) -> Case {
    const FILES: &[&str] = &[
        "b.txt", "c.org", "notes.md", "a.txt~", "#a.txt#", ".hidden", "sub/x.txt", "sub/y.org", "empty/", "data", "z z.txt",
    ];
    let mut files: std::collections::BTreeMap<String, String> = Default::default();
    files.insert("a.txt".into(), "one\n".into());
    for _ in 0..1 + rng.below(6) {
        let f = rng.pick(FILES);
        files.insert(f.to_string(), if f.ends_with('/') { String::new() } else { format!("{f}\n") });
    }
    let n = 1 + rng.below(7);
    let keys = std::iter::once("C-x C-j").chain((0..n).map(|_| rng.pick(DIRED_KEYS))).collect::<Vec<_>>().join(" ");
    const ANSWERS: &[&str] = &["yes", "no", "y", "n", "!", "copy.txt", "sub", "b.txt", "new", "txt$", "*", " "];
    let answers = (0..rng.below(5)).map(|_| rng.pick(ANSWERS).to_string()).collect();
    Case {
        name,
        point: 0,
        text: String::new(),
        keys,
        modes: Vec::new(),
        call: Vec::new(),
        platform: None,
        windows: false,
        answers,
        visit: None,
        today: None,
        agenda_files: false,
        capture_templates: Vec::new(),
        files,
        find: Some("a.txt".to_string()),
        disk: None,
        message: true,
        vars: Default::default(),
        lockfiles: false,
        capf: Vec::new(),
        completions: false,
    }
}

/// Fuzzes Dired: moving, marking, and copying, renaming and deleting files.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn dired_behaves_like_emacs_on_random_cases() {
    fuzz("dired-fuzz", random_dired_case);
}

/// Generates cases with `generate`, compares Emacs and E8 on them, and
/// shrinks those that differ, in a directory of `target` of its own, as the
/// fuzzers can run at once.
fn fuzz(dir: &str, generate: fn(&mut Rng, String) -> Case) {
    let seed: u64 = std::env::var("E8_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let count: usize = std::env::var("E8_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    // Mixed first, so seeds differing in their lowest bit give different cases.
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(0x9e37_79b9_7f4a_7c15) | 1);
    let work = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target").join(dir);
    let cases: Vec<Case> = (0..count).map(|i| generate(&mut rng, format!("f{i:04}"))).collect();
    let recorded = record(&work.join("run"), &cases);

    let mut failing: Vec<(Case, String)> = Vec::new();
    let mut compared = 0;
    for case in &cases {
        if let Some(diff) = recorded.get(&case.name).and_then(|emacs| compare(case, emacs)) {
            compared += 1;
            if !diff.is_empty() {
                failing.push((case.clone(), diff));
            }
        }
    }
    eprintln!("seed {seed}: {compared} cases compared, {} differ", failing.len());

    // Shrink every failing case a step at a time, recording each round's
    // candidates with one run of Emacs. E8_FUZZ_SHRINK_ROUNDS caps the
    // rounds, for runs where Emacs hangs on many candidates.
    let rounds: usize = std::env::var("E8_FUZZ_SHRINK_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
    for round in 0..rounds {
        let mut candidates = Vec::new();
        for (k, (case, _)) in failing.iter().enumerate() {
            for (j, mut smaller) in shrinks(case).into_iter().enumerate() {
                smaller.name = format!("s{k:03}-{j:03}");
                candidates.push((k, smaller));
            }
        }
        if candidates.is_empty() {
            break;
        }
        let all: Vec<Case> = candidates.iter().map(|(_, c)| c.clone()).collect();
        let recorded = record(&work.join("shrink"), &all);
        let mut progress = false;
        let mut taken = BTreeSet::new();
        for (k, smaller) in candidates {
            if taken.contains(&k) {
                continue;
            }
            let Some(diff) = recorded.get(&smaller.name).and_then(|emacs| compare(&smaller, emacs)) else { continue };
            if !diff.is_empty() && fields(&diff) == fields(&failing[k].1) {
                let name = failing[k].0.name.clone();
                failing[k] = (Case { name, ..smaller }, diff);
                taken.insert(k);
                progress = true;
            }
        }
        eprintln!("shrinking, round {round}: {} cases shrunk", taken.len());
        if !progress {
            break;
        }
    }

    // Cases that shrank to the same thing are one difference.
    let mut seen = BTreeSet::new();
    failing.retain(|(c, _)| seen.insert((c.text.clone(), c.keys.clone(), c.point)));
    failing.sort_by_key(|(c, _)| (c.keys.split(' ').count(), c.text.len()));
    for (case, diff) in &failing {
        eprintln!("\n{}: text {:?}, point {}, keys {:?}\n{diff}", case.name, case.text, case.point, case.keys);
    }
    let out: Vec<&Case> = failing.iter().map(|(c, _)| c).collect();
    fs::write(work.join("differences.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    assert!(failing.is_empty(), "{} differences from Emacs; see above", failing.len());
}

/// Compares E8 again with a run Emacs has already recorded, such as
/// `E8_FUZZ_RUN=target/dired-fuzz/run`, printing each difference as it is,
/// to check fixes without recording again.
#[test]
#[ignore = "needs a recorded run; run with --ignored"]
fn compares_a_recorded_run() {
    let Ok(dir) = std::env::var("E8_FUZZ_RUN") else { return };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(dir);
    let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(dir.join("cases/fuzz.json")).unwrap()).unwrap();
    let golden: Golden = serde_json::from_str(&fs::read_to_string(dir.join("golden/fuzz.json")).unwrap()).unwrap();
    let recorded: BTreeMap<String, State> = golden.cases.into_iter().map(|r| (r.name, r.state)).collect();
    let mut failing = 0;
    for case in &cases {
        let Some(diff) = recorded.get(&case.name).and_then(|emacs| compare(case, emacs)) else { continue };
        if !diff.is_empty() {
            failing += 1;
            eprintln!("\n{}: keys {:?}, answers {:?}, files {:?}\n{diff}", case.name, case.keys, case.answers, case.files.keys().collect::<Vec<_>>());
        }
    }
    eprintln!("\n{failing} of {} cases differ", cases.len());
}

/// Runs the cases in `E8_FUZZ_REPLAY` (by default the last run's
/// `differences.json`) again, to check fixes without a new search.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn org_mode_replays_differences() {
    let work = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/org-fuzz");
    let file = std::env::var("E8_FUZZ_REPLAY").map(Into::into).unwrap_or_else(|_| work.join("differences.json"));
    let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
    let recorded = record(&work.join("replay"), &cases);
    let mut failing = 0;
    for case in &cases {
        let Some(diff) = recorded.get(&case.name).and_then(|emacs| compare(case, emacs)) else { continue };
        if !diff.is_empty() {
            failing += 1;
            eprintln!("\n{}: text {:?}, point {}, keys {:?}\n{diff}", case.name, case.text, case.point, case.keys);
        }
    }
    eprintln!("\n{failing} of {} cases differ", cases.len());
    assert_eq!(failing, 0);
}

/// Texts for looking for panics: several scripts, wide and combining
/// characters, right-to-left text, tabs, blank lines and brackets.
const PANIC_PIECES: &[&str] = &[
    "one", "two", "foo_bar", "x", "é", "日本語", "👍🏽", "e\u{301}", "שלום", "مرحبا", "\t", " ", "  ", "\n", "\n\n", "(a b)",
    "\"q\"", "[x]", "{", "}", "'", ";; c", "* H", "- i", "| a | b |", "<2026-11-15 Sun>", "\u{a0}", "\r", "\u{200b}", "Ab.",
];

/// Keys from all over the global map, with prefix arguments of every
/// kind, narrowing, rectangles, the kill ring, case, sexps and filling.
const PANIC_KEYS: &[&str] = &[
    "C-f", "C-b", "C-n", "C-p", "C-a", "C-e", "M-f", "M-b", "M-<", "M->", "C-v", "M-v", "C-l", "M-r", "M-m", "M-g g",
    "C-d", "DEL", "M-d", "M-DEL", "C-k", "C-S-<backspace>", "M-z", "C-y", "M-y", "C-w", "M-w", "C-M-w", "C-SPC", "C-x C-x",
    "C-x h", "C-/", "C-?", "C-_", "C-t", "M-t", "C-x C-t", "C-M-t", "C-o", "C-M-o", "C-j", "RET", "TAB", "M-\\", "M-SPC",
    "M-^", "C-x C-o", "C-M-\\", "C-x TAB", "M-q", "M-u", "M-l", "M-c", "C-x C-u", "C-x C-l", "M-{", "M-}", "M-h", "M-a",
    "M-e", "M-k", "C-x DEL", "C-M-f", "C-M-b", "C-M-k", "C-M-u", "C-M-d", "C-M-n", "C-M-p", "C-M-a", "C-M-e", "C-M-h",
    "C-M-SPC", "C-x n n", "C-x n w", "C-x n p", "C-x r k", "C-x r y", "C-x r o", "C-x r c", "C-x r M-w", "C-x r N",
    "C-x SPC", "M-;", "C-x C-;", "M-/", "C-x z", "C-x u", "C-q", "C-x 8 RET", "M-=", "C-x =", "C-x 2", "C-x 3", "C-x o",
    "C-x 0", "C-x 1", "C-x ^", "C-x }", "C-x {", "C-x <", "C-x >", "C-s", "C-r", "M-%", "C-M-s", "C-x r SPC", "C-x r j",
    "C-x r s", "C-x r i", "C-x C-n", "C-x f", "C-x s", "M-x", "C-u", "C-u C-u", "C--", "M--", "M-0", "M-1", "M-5", "M-9",
    "C-u 0", "C-u -", "C-u 1 0 0", "C-g", "C-g", "x", "SPC", "1", "(", ")", "\"", "é", "S-<right>", "S-<left>", "S-<down>",
    "C-S-<up>", "<end>", "<home>", "C-<right>", "C-<left>", "<prior>", "<next>", "<delete>", "C-<delete>", "M-<up>",
    "C-x C-e", "C-M-x", "M-:", "C-x 4 b", "C-x b", "C-x k", "C-x C-b", "C-h k", "C-h c", "C-x r t", "C-x TAB", "M-s o",
];

const PANIC_MODES: &[&str] = &["", "", "text-mode", "org-mode", "emacs-lisp-mode", "outline-mode", "prog-mode"];

/// Types random keys from all over the editor into random text, in a few
/// modes, sometimes narrowed, and reports each case that panics. Panics
/// are E8's own bugs whatever Emacs does, so no Emacs is needed.
#[test]
#[ignore = "a fuzzer; run with --ignored"]
fn random_keys_never_panic() {
    use e8_core::Editor;
    use e8_script::Scripting;
    let seed: u64 = std::env::var("E8_FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: usize = std::env::var("E8_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(0x9e37_79b9_7f4a_7c15) | 1);
    let panics = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = panics.clone();
    std::panic::set_hook(Box::new(move |info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let what = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        seen.lock().unwrap().push(format!("{place}: {what}"));
    }));
    let sandbox = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let verbose = std::env::var("E8_FUZZ_VERBOSE").is_ok();
    let narrow_percent: usize = std::env::var("E8_FUZZ_NARROW").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
    // Edits reaching past a narrowing are refused with Args out of range,
    // which in practice means a command computed its range from the whole
    // buffer: listed, though not failures, as Emacs signals it too at times.
    let out_of_range = std::cell::RefCell::new(Vec::<String>::new());
    let commands: Vec<String> = if std::env::var("E8_FUZZ_COMMANDS").is_ok() {
        let mut ed = Editor::new();
        let _scripting = Scripting::new(&mut ed).expect("scripting starts");
        let skip = ["kill-emacs", "suspend", "save-buffers-kill", "sleep", "recursive-edit", "server", "profiler", "debug"];
        let mut names: Vec<String> = ed.command_names().filter(|n| !skip.iter().any(|s| n.contains(s))).map(String::from).collect();
        names.sort();
        names
    } else {
        Vec::new()
    };
    let mut failing = Vec::new();
    for i in 0..count {
        let text: String = (0..rng.below(30)).map(|_| rng.pick(PANIC_PIECES)).collect();
        let point = rng.below(text.chars().count() + 1);
        let mode = rng.pick(PANIC_MODES);
        // E8_FUZZ_NARROW sets how often, in percent, a case is narrowed.
        let narrow = rng.chance(narrow_percent).then(|| {
            let n = text.chars().count();
            let a = rng.below(n + 1);
            (a, a + rng.below(n - a + 1))
        });
        // With E8_FUZZ_COMMANDS, M-x runs a random command now and then.
        let n = 1 + rng.below(12);
        let mut keys: Vec<String> = Vec::new();
        for _ in 0..n {
            if !commands.is_empty() && rng.chance(30) {
                keys.push(format!("M-x {}", commands[rng.below(commands.len())]));
            } else {
                keys.push(rng.pick(PANIC_KEYS).to_string());
            }
        }
        keys.push("C-g".into());
        keys.push("C-g".into());
        panics.lock().unwrap().clear();
        if verbose {
            eprintln!("case {i}: {mode:?} {:?}", keys.join(" | "));
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut ed = Editor::new();
            let _scripting = Scripting::new(&mut ed).expect("scripting starts");
            ed.set_frame_size(80, 24);
            // As while an agent acts: nothing written, deleted or run, and no quitting.
            ed.set_agent_acting(true);
            ed.set_variable("default-directory", e8_core::Value::Str(format!("{}/", sandbox.path().display())));
            ed.window_buffer_mut().set_text(&text);
            ed.window_buffer_mut().set_point(point);
            if !mode.is_empty() {
                let _ = ed.call(mode, vec![]);
            }
            if let Some((a, b)) = narrow {
                ed.window_buffer_mut().narrow(a, b);
            }
            for k in &keys {
                if let Some(name) = k.strip_prefix("M-x ") {
                    let _ = ed.press("M-x");
                    ed.type_text(name);
                    let _ = ed.press("RET");
                } else {
                    let _ = ed.press(k);
                }
                if ed.echo().is_some_and(|e| e.contains("Args out of range")) {
                    out_of_range.borrow_mut().push(format!("case {i}: mode {mode:?}, text {text:?}, point {point}, narrow {narrow:?}, at {k:?} of {:?}", keys.join(" | ")));
                }
                ed.redisplay();
            }
        }));
        let caught: Vec<String> = panics.lock().unwrap().clone();
        if result.is_err() || !caught.is_empty() {
            let msg = format!("case {i}: mode {mode:?}, text {text:?}, point {point}, narrow {narrow:?}, keys {:?}\n    {}", keys.join(" "), caught.join("\n    "));
            eprintln!("{msg}");
            failing.push(msg);
        }
    }
    let _ = std::panic::take_hook();
    for line in out_of_range.borrow().iter() {
        eprintln!("out of range: {line}");
    }
    eprintln!("seed {seed}: {count} cases, {} panicked", failing.len());
    assert!(failing.is_empty(), "{} cases panicked; see above", failing.len());
}
