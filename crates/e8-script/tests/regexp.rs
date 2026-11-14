//! Emacs's regular expressions in E8's engine, compared with Emacs's
//! own `string-match` and match data: recorded cases each run, and a
//! fuzzer that makes random regexps and strings and records what Emacs
//! does with them. It needs Emacs, so it only runs when asked:
//!
//!     E8_FUZZ_SEED=1 E8_FUZZ_CASES=5000 cargo test --release -p e8-script --test regexp -- --ignored --nocapture
//!
//! Differences it finds are printed and written to
//! `target/regexp-fuzz/differences.json`, in the form of
//! `tests/emacs/regexps.json`, where those worth keeping go.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use e8_core::Editor;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Case {
    re: String,
    s: String,
    fold: bool,
    /// re-search-backward from the end of a buffer holding the string, rather than string-match.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    backward: bool,
    /// What Emacs gave, as regexp.el writes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    emacs: Option<Value>,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// What E8 gives for a case, as regexp.el writes Emacs's: the match data
/// without trailing groups that did not match, "none", or "error SYMBOL".
fn e8(case: &Case) -> Value {
    let mut ed = Editor::new();
    let found = if case.backward {
        ed.buffer_mut().set_text(&case.s);
        let end = ed.buffer().len();
        ed.search(&case.re, end, &e8_core::SearchOptions { regexp: true, backward: true, case_fold: case.fold, bound: None, posix: false })
    } else {
        ed.string_match(&case.re, &case.s, 0, case.fold)
    };
    match found {
        Ok(Some(m)) => {
            let mut groups = m.groups.clone();
            while groups.len() > 1 && groups.last() == Some(&None) {
                groups.pop();
            }
            Value::Array(
                groups
                    .iter()
                    .flat_map(|g| match g {
                        Some((s, e)) => [Value::from(*s), Value::from(*e)],
                        None => [Value::Null, Value::Null],
                    })
                    .collect(),
            )
        }
        Ok(None) => Value::from("none"),
        Err(e) => Value::from(format!("error {}", e.symbol())),
    }
}

#[test]
fn recorded_cases_match_emacs() {
    let text = fs::read_to_string(root().join("tests/emacs/regexps.json")).unwrap();
    let cases: Vec<Case> = serde_json::from_str(&text).unwrap();
    let wrong: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = e8(c);
            (Some(&got) != c.emacs.as_ref()).then(|| format!("{:?} on {:?}{}{}: Emacs {}, E8 {got}", c.re, c.s, if c.fold { " folding" } else { "" }, if c.backward { " backward" } else { "" }, c.emacs.as_ref().unwrap()))
        })
        .collect();
    assert!(wrong.is_empty(), "{} of {} differ:\n{}", wrong.len(), cases.len(), wrong.join("\n"));
}

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

/// The characters strings are made of: words, a symbol constituent,
/// spaces, a newline, parens and a capital, so classes and boundaries matter.
const CHARS: &[&str] = &["a", "b", "a", "b", "_", " ", "\n", "(", ")", "A", "-", "é"];

/// Characters past ASCII, for classes, categories and case folding.
const WIDE: &[&str] = &["é", "α", "ς", "σ", "Σ", "µ", "μ", "²", "½", "\u{301}", "漢", "か", "カ", "한", "ǅ", "ª", "\u{212a}", "k", "Я", "ß", "€", "\u{378}", "ﬁ"];

/// A random regexp, as Emacs writes them, `groups` counting the groups
/// closed so far, which back-references may name.
fn regexp(rng: &mut Rng, depth: usize, groups: &mut usize) -> String {
    let mut out = String::new();
    if depth == 0 && rng.chance(15) {
        out.push('^');
    }
    for _ in 0..1 + rng.below(4) {
        out.push_str(&piece(rng, depth, groups));
    }
    if rng.chance(15) && depth < 2 {
        out.push_str("\\|");
        out.push_str(&regexp(rng, depth + 1, groups));
    }
    if depth == 0 && rng.chance(15) {
        out.push('$');
    }
    out
}

fn piece(rng: &mut Rng, depth: usize, groups: &mut usize) -> String {
    let atom = match rng.below(12) {
        0..=3 => rng.pick(&["a", "b", "_", " ", "A", "(", "é", "\\.", "\\*", "σ", "Σ", "k", "µ"]).to_string(),
        4 => ".".to_string(),
        5 => rng.pick(&["[ab]", "[^a]", "[a-b]", "[]a]", "[^]\n]", "[[:space:]]", "[[:word:]]", "[[:upper:]]", "[[:alpha:]_]", "[[:punct:]]", "[a-]", "[z-a]", "[[:alpha:]]", "[[:alnum:]]", "[[:graph:]]", "[[:print:]]", "[[:lower:]]", "[[:blank:]]", "[^[:alpha:]]", "[α-ω]", "[σΣ]"]).to_string(),
        6 => rng.pick(&["\\w", "\\W", "\\s-", "\\s_", "\\sw", "\\s.", "\\s(", "\\S-", "\\Sw", "\\cl", "\\cg", "\\cj", "\\cL", "\\c|", "\\C^", "\\ca", "\\cC", "\\ch", "\\ck", "\\c.", "\\Cl"]).to_string(),
        7 => rng.pick(&["\\b", "\\B", "\\<", "\\>", "\\_<", "\\_>", "\\`", "\\'"]).to_string(),
        8 if *groups > 0 => format!("\\{}", 1 + rng.below((*groups).min(9))),
        8..=10 if depth < 3 => {
            let shy = rng.chance(25);
            let inner = regexp(rng, depth + 1, groups);
            if shy {
                format!("\\(?:{inner}\\)")
            } else {
                *groups += 1;
                format!("\\({inner}\\)")
            }
        }
        _ => "a".to_string(),
    };
    let zero_width = atom.starts_with("\\b") || atom.starts_with("\\B") || atom.starts_with("\\<") || atom.starts_with("\\>") || atom.starts_with("\\_") || atom == "\\`" || atom == "\\'";
    if zero_width || !rng.chance(40) {
        return atom;
    }
    let op = match rng.below(9) {
        0..=1 => "*".to_string(),
        2 => "+".to_string(),
        3 => "?".to_string(),
        4 => "*?".to_string(),
        5 => "+?".to_string(),
        6 => "??".to_string(),
        _ => {
            let n = rng.below(3);
            match rng.below(4) {
                0 => format!("\\{{{n}\\}}"),
                1 => format!("\\{{{n},\\}}"),
                2 => format!("\\{{,{}\\}}", n + 1),
                _ => format!("\\{{{n},{}\\}}", n + rng.below(3)),
            }
        }
    };
    atom + &op
}

fn string(rng: &mut Rng) -> String {
    (0..rng.below(9)).map(|_| if rng.chance(30) { rng.pick(WIDE) } else { rng.pick(CHARS) }).collect()
}

/// What Emacs gives for each case, through regexp.el.
fn record(cases: &[Case], dir: &Path) -> Vec<Value> {
    fs::create_dir_all(dir).unwrap();
    let lines: Vec<String> = cases.iter().map(|c| serde_json::to_string(&Case { emacs: None, ..c.clone() }).unwrap()).collect();
    fs::write(dir.join("cases.jsonl"), lines.join("\n") + "\n").unwrap();
    let status = Command::new("emacs")
        .args(["-Q", "--batch", "-l"])
        .arg(root().join("tests/emacs/regexp.el"))
        .env("E8_REGEXP_CASES", dir.join("cases.jsonl"))
        .env("E8_REGEXP_RESULTS", dir.join("results.jsonl"))
        .status()
        .expect("emacs runs");
    assert!(status.success(), "regexp.el failed");
    fs::read_to_string(dir.join("results.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
#[ignore]
fn regexps_behave_like_emacs_on_random_cases() {
    let seed: u64 = std::env::var("E8_FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: usize = std::env::var("E8_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let cases: Vec<Case> = (0..count)
        .map(|_| {
            let mut groups = 0;
            Case { re: regexp(&mut rng, 0, &mut groups), s: string(&mut rng), fold: rng.chance(20), backward: rng.chance(30), emacs: None }
        })
        .collect();
    let dir = root().join("target/regexp-fuzz");
    let results = record(&cases, &dir);
    let differ: Vec<Case> = cases
        .into_iter()
        .zip(results)
        .filter(|(c, emacs)| e8(c) != *emacs)
        .map(|(c, emacs)| Case { emacs: Some(emacs), ..c })
        .collect();
    for c in differ.iter().take(40) {
        println!("{:?} on {:?}{}{}: Emacs {}, E8 {}", c.re, c.s, if c.fold { " folding" } else { "" }, if c.backward { " backward" } else { "" }, c.emacs.as_ref().unwrap(), e8(c));
    }
    fs::write(dir.join("differences.json"), serde_json::to_string_pretty(&differ).unwrap()).unwrap();
    println!("seed {seed}: {count} cases compared, {} differ", differ.len());
    assert!(differ.is_empty(), "{} differences from Emacs; see above", differ.len());
}

/// How long failing regexp searches take over 10 MB of text, to keep the
/// engine near Emacs's speed: about 30 to 600 ms for these there.
#[test]
#[ignore]
fn regexp_searches_over_a_large_buffer_are_fast() {
    let mut ed = Editor::new();
    let line = "* Heading with some words 12345 and_more text here (parens) end\n";
    ed.buffer_mut().set_text(&line.repeat(10_000_000 / line.len()));
    for pattern in [r"\<zzz\>", r"^\* q", "[0-9]+x", r"\w+qq", "^.*zz$", r"\_<foo_bar\_>"] {
        let started = std::time::Instant::now();
        let found = ed.search(pattern, 0, &e8_core::SearchOptions { regexp: true, ..Default::default() }).unwrap();
        println!("{pattern:16} {:>8.1} ms {}", started.elapsed().as_secs_f64() * 1000.0, if found.is_some() { "found" } else { "" });
    }
}
