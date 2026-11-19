//! Compares E8 with GNU Emacs on the recorded cases in `tests/emacs/`.
//!
//! It lives here rather than in e8-core because E8 includes the
//! packages that ship with it, such as the prefix argument commands in
//! packages/simple.ts, just as Emacs includes its preloaded Lisp.
//!
//! Each case's keys are typed into a fresh editor, as record.el types them
//! into Emacs: an error shows its message and the next key still runs. The
//! result, including the first error, is compared with what Emacs did. Cases listed in `known-gaps.txt` are expected to differ; the
//! test fails if one of them starts matching, so the list stays accurate.
//!
//! To add cases, edit `tests/emacs/cases/*.json`, then record what Emacs
//! does with `emacs -Q --batch -l tests/emacs/record.el`.

mod oracle;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use oracle::{Case, Golden, Input, Recorded, differences, oracle_dir, run, system_type};

/// `known-gaps.txt`: one `file/case` per line, with an optional `# reason`.
fn known_gaps() -> BTreeMap<String, String> {
    let text = fs::read_to_string(oracle_dir().join("known-gaps.txt")).unwrap_or_default();
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| match line.split_once('#') {
            Some((id, reason)) => (id.trim().to_string(), reason.trim().to_string()),
            None => (line.to_string(), String::new()),
        })
        .collect()
}

/// How many tests the cases are shared among: each a process of its own,
/// so each has nextest's three minutes, which all the cases in one ran past
/// on CI's runners with QuickJS.
const SHARDS: usize = 4;

/// What gathering the cases finds: every case's id, the cases to run with
/// what Emacs did, the problems found, and how many cases there are to run.
type Gathered = (Vec<String>, Vec<(String, Case, Recorded)>, Vec<String>, usize);

/// The cases of every case file, as `file/case` ids, and the problems
/// found gathering them; with `shard`, only every SHARDS-th case is kept to
/// run, starting from it.
fn gather(shard: Option<usize>) -> Gathered {
    let dir = oracle_dir();
    let mut problems = Vec::new();
    let mut total = 0;
    let mut seen = Vec::new();

    let mut files: Vec<PathBuf> = fs::read_dir(dir.join("cases"))
        .expect("tests/emacs/cases exists")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    // E8_ORACLE_ONLY=dired compares only the case files whose names have it.
    if let Ok(only) = std::env::var("E8_ORACLE_ONLY") {
        files.retain(|f| f.file_stem().is_some_and(|s| s.to_string_lossy().contains(&only)));
    }

    let mut jobs: Vec<(String, Case, Recorded)> = Vec::new();
    let mut index = 0;
    for file in files {
        let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
        let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(&file).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        let golden_path = dir.join("golden").join(file.file_name().unwrap());
        let Ok(golden) = fs::read_to_string(&golden_path) else {
            problems.push(format!("{stem}: no golden file; record it with record.el"));
            continue;
        };
        let golden: Golden = serde_json::from_str(&golden)
            .unwrap_or_else(|e| panic!("{}: {e}", golden_path.display()));
        let mut recorded: BTreeMap<String, Recorded> =
            golden.cases.into_iter().map(|r| (r.name.clone(), r)).collect();

        for case in cases {
            let id = format!("{stem}/{}", case.name);
            seen.push(id.clone());
            let mine = shard.is_none_or(|s| index % SHARDS == s);
            index += 1;
            if !mine {
                continue;
            }
            if let Some(platform) = &case.platform {
                if platform != system_type() {
                    continue;
                }
                if *platform != golden.system_type {
                    problems.push(format!("{id}: holds on {platform}; record it there"));
                    continue;
                }
            }
            total += 1;
            let input = Input::of(&case);
            let Some(emacs) = recorded.remove(case.name.as_str()) else {
                problems.push(format!("{id}: not recorded; record it with record.el"));
                continue;
            };
            if emacs.input != input {
                problems.push(format!("{id}: the case changed since Emacs {} recorded it; record it again", golden.emacs_version));
                continue;
            }
            jobs.push((id, case, emacs));
        }
    }
    (seen, jobs, problems, total)
}

/// Runs one shard's cases, in parallel, each with an editor of its own,
/// and compares each with what Emacs did.
fn compare(shard: usize) {
    let gaps = known_gaps();
    let (_, jobs, mut problems, total) = gather(Some(shard));
    let mut matching = 0;
    let next = std::sync::atomic::AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let results: Vec<(usize, String)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((_, case, emacs)) = jobs.get(i) else { break };
                        out.push((i, differences(&emacs.state, &run(case))));
                    }
                    out
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().expect("a case does not panic")).collect()
    });
    let mut results = results;
    results.sort_by_key(|(i, _)| *i);
    for (i, diff) in results {
        let (id, case, _) = &jobs[i];
        match (diff.is_empty(), gaps.contains_key(id)) {
            (true, false) => matching += 1,
            (false, true) => {}
            (true, true) => problems.push(format!("{id}: now matches Emacs; remove it from known-gaps.txt")),
            (false, false) => problems.push(format!("{id}: keys {:?}\n{diff}", case.keys)),
        }
    }
    eprintln!("Emacs oracle, shard {} of {SHARDS}: {total} cases, {matching} match", shard + 1);
    assert!(problems.is_empty(), "\n{}\n", problems.join("\n"));
}

#[test]
fn e8_behaves_like_emacs_1() {
    compare(0);
}

#[test]
fn e8_behaves_like_emacs_2() {
    compare(1);
}

#[test]
fn e8_behaves_like_emacs_3() {
    compare(2);
}

#[test]
fn e8_behaves_like_emacs_4() {
    compare(3);
}

/// Every known gap names a case there is, so the list stays accurate.
#[test]
fn known_gaps_name_cases_there_are() {
    // Only meaningful over every case file.
    if std::env::var("E8_ORACLE_ONLY").is_ok() {
        return;
    }
    let gaps = known_gaps();
    let (seen, _, _, _) = gather(Some(usize::MAX));
    let missing: Vec<String> = gaps.keys().filter(|id| !seen.contains(id)).map(|id| format!("{id}: listed in known-gaps.txt but there is no such case")).collect();
    eprintln!("Emacs oracle: {} cases, {} known gaps", seen.len(), gaps.len());
    assert!(missing.is_empty(), "\n{}\n", missing.join("\n"));
}
