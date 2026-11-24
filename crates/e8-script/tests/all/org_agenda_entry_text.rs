//! The agenda's entry text mode (E), compared with what Emacs shows:
//! the text goes in overlays' after-strings, which the key oracle does not
//! record, so `tests/emacs/entry-text/dump.el` records each agenda line and
//! the text Org puts under it, for `tasks.org`, in the .jsonl files here.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/entry-text")
}

/// Each agenda line and what entry text mode shows under it, as dump.el prints them.
fn agenda_with_entry_text(maxlines: i64, leader: Option<&str>, exclude: Option<&str>) -> Vec<(String, String)> {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let file = dir().join("tasks.org");
    ed.set_default("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    ed.set_default("org-agenda-span", Value::Symbol("week".into()));
    ed.set_default("org-agenda-start-day", Value::Str("2026-10-26".into()));
    ed.set_default("org-agenda-start-on-weekday", Value::Number(1.0));
    ed.set_default("org-agenda-use-time-grid", Value::Null);
    ed.set_default("org-agenda-window-setup", Value::Symbol("current-window".into()));
    ed.set_default("org-agenda-entry-text-maxlines", Value::Number(maxlines as f64));
    if let Some(l) = leader {
        ed.set_default("org-agenda-entry-text-leaders", Value::Str(l.into()));
    }
    if let Some(x) = exclude {
        ed.set_default("org-agenda-entry-text-exclude-regexps", Value::List(vec![Value::Str(x.into())]));
    }
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.call("org-agenda-entry-text-mode", vec![Arg::Prefix(None)]).unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let dump = s
        .eval_expression(
            &mut ed,
            r#"JSON.stringify(e8.withCurrentBuffer("*Org Agenda*", () => {
              const out = [];
              for (let l = 0; l < e8.lineCount() - 1; l++) {
                const after = e8.overlaysIn(e8.lineStart(l), e8.lineEnd(l)).map((o) => e8.overlayGet(o, "after-string")).find((a) => typeof a === "string");
                out.push([e8.lineText(l), after ?? null]);
              }
              return out;
            }))"#,
        )
        .unwrap();
    let json: String = serde_json::from_str(&dump).unwrap();
    let lines: Vec<(String, Option<String>)> = serde_json::from_str(&json).unwrap();
    lines.into_iter().map(|(l, a)| (l, a.unwrap_or_else(|| "null".into()))).collect()
}

/// What Emacs recorded: json-encode wrote no text as the string "null".
fn recorded(name: &str) -> Vec<(String, String)> {
    std::fs::read_to_string(dir().join(name))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<(String, String)>(l).unwrap())
        .collect()
}

#[test]
fn entry_text_is_what_org_shows() {
    assert_eq!(agenda_with_entry_text(5, None, None), recorded("maxlines-5.jsonl"));
}

#[test]
fn entry_text_stops_at_its_maximum_lines() {
    assert_eq!(agenda_with_entry_text(2, None, None), recorded("maxlines-2.jsonl"));
}

#[test]
fn entry_text_takes_its_leader() {
    assert_eq!(agenda_with_entry_text(3, Some("|> "), None), recorded("leader.jsonl"));
}

#[test]
fn entry_text_leaves_out_what_the_exclude_regexps_match() {
    assert_eq!(agenda_with_entry_text(5, None, Some(r"first\|seven\|^.*two$")), recorded("exclude.jsonl"));
}
