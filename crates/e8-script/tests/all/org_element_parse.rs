//! Org's full parse, org-element-parse-buffer, compared with GNU Emacs's:
//! `tests/emacs/org-element/golden.json` holds the tree Emacs's Org gives
//! for each text in its `cases.json`, and the text its
//! org-element-interpret-data writes back, as `dump.el` records them (see
//! the README there). Positions count from 0, nil properties are left out.

use e8_core::Editor;
use e8_script::Scripting;
use serde_json::Value;

const CASES: &str = include_str!("../../../../tests/emacs/org-element/cases.json");
const GOLDEN: &str = include_str!("../../../../tests/emacs/org-element/golden.json");

/// The parse as JSON in the shape dump.el writes, and the text written back.
const SERIALIZE: &str = r#"
const oe = (globalThis as any).orgElement;
function plain(v: any): any {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object" && "type" in v) return tree(v);
  if (typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = data(x);
    return o;
  }
  return v;
}
function data(v: any): any {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((d: any) => (typeof d === "string" ? d : plain(d)));
  return plain(v);
}
function tree(n: any): any {
  const props: any = {};
  for (const [k, v] of Object.entries(n.p)) {
    if (v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "caption") props[k] = (v as any[]).map((e) => ({ value: data(e.value ?? []), secondary: e.secondary === undefined || e.secondary === null ? null : data(e.secondary) }));
    else if (k === "results") props[k] = { value: (v as any).value ?? null, secondary: (v as any).secondary ?? null };
    else props[k] = plain(v);
  }
  return { type: n.type, props, contents: n.contents.map((d: any) => (typeof d === "string" ? d : tree(d))) };
}
"#;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("reach.ts");
    std::fs::write(&module, r#"import * as oe from "org-element"; (globalThis as any).orgElement = oe;"#).unwrap();
    s.load_module(&mut ed, &module).unwrap();
    (ed, s)
}

/// E8's tree and interpreted text for TEXT, parsed in an Org buffer of its own.
fn parse(ed: &mut Editor, s: &Scripting, n: usize, text: &str) -> (Value, String) {
    let code = format!(
        r#"{SERIALIZE}
e8.setBuffer(e8.getBufferCreate("parse-{n}"));
e8.insert({text});
e8.call("org-mode");
const t = oe.parseBuffer();
globalThis.result = JSON.stringify([tree(t), oe.interpretData(t)]);"#,
        text = serde_json::to_string(text).unwrap()
    );
    s.eval_typescript(ed, "parse.ts", code).unwrap();
    let json: String = serde_json::from_str(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap();
    let v: Value = serde_json::from_str(&json).unwrap();
    (v[0].clone(), v[1].as_str().unwrap().to_string())
}

/// Where two trees first differ, as a path and the two values there.
fn first_difference(path: &str, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let (va, vb) = (x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null));
                if let Some(d) = first_difference(&format!("{path}.{k}"), va, vb) {
                    return Some(d);
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().max(y.len()) {
                let (va, vb) = (x.get(i).unwrap_or(&Value::Null), y.get(i).unwrap_or(&Value::Null));
                if let Some(d) = first_difference(&format!("{path}[{i}]"), va, vb) {
                    return Some(d);
                }
            }
            None
        }
        _ if a == b => None,
        _ => Some(format!("{path}: E8 {a}, Emacs {b}")),
    }
}

/// Runs TypeScript with org-element's exports as `oe`, giving what it returns as JSON.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> Value {
    s.eval_typescript(ed, "run.ts", format!("{SERIALIZE}\nglobalThis.result = JSON.stringify((() => {{ {code} }})() ?? null);")).unwrap();
    let json: String = serde_json::from_str(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap();
    serde_json::from_str(&json).unwrap()
}

/// A link written out parsed alone, as ox resolves links with
/// org-element-link-parser in a buffer of its own, and a secondary string,
/// as Org's options are parsed; what Emacs gives for each.
#[test]
fn links_and_secondary_strings_parse_alone() {
    let (mut ed, s) = setup();
    ed.call("org-mode", vec![]).unwrap();
    let link = run(&mut ed, &s, r#"return tree(oe.linkParser("[[https://example.com][An *example*]]"));"#);
    assert_eq!(link["props"]["type"], "https");
    assert_eq!(link["props"]["path"], "//example.com");
    assert_eq!(link["props"]["raw-link"], "https://example.com");
    assert_eq!(link["props"]["begin"], 0);
    assert_eq!(link["props"]["end"], 37);
    assert_eq!(link["props"]["contents-begin"], 23);
    assert_eq!(link["contents"][0], "An ");
    assert_eq!(link["contents"][1]["type"], "bold");
    assert_eq!(run(&mut ed, &s, r#"return oe.linkParser("not a link");"#), Value::Null);
    let title = run(&mut ed, &s, r#"return data(oe.parseSecondaryString("A *bold* \\alpha title", oe.restriction("keyword")));"#);
    assert_eq!(title[0], "A ");
    assert_eq!(title[1]["type"], "bold");
    assert_eq!(title[2]["type"], "entity");
    assert_eq!(title[2]["props"]["utf-8"], "α");
    assert_eq!(title[3], "title");
    // A restriction leaves other objects as text.
    let plain = run(&mut ed, &s, r#"return data(oe.parseSecondaryString("A *bold* title", ["italic"]));"#);
    assert_eq!(plain, serde_json::json!(["A *bold* title"]));
}

/// Coarser granularities stop where Org's do: headlines alone, then
/// elements without their objects.
#[test]
fn granularity_stops_the_parse() {
    let (mut ed, s) = setup();
    let types = |ed: &mut Editor, g: &str| -> Value {
        run(
            ed,
            &s,
            &format!(
                r#"const t = oe.parseBuffer({g}); const out: string[] = []; const walk = (n: any) => {{ out.push(n.type); for (const c of n.contents) if (typeof c !== "string") walk(c); }}; walk(t); return out;"#
            ),
        )
    };
    s.eval_typescript(&mut ed, "t.ts", r#"e8.insert("Intro *b*.\n* H\n- item\n** Sub\npara\n"); e8.call("org-mode");"#.into()).unwrap();
    assert_eq!(types(&mut ed, r#""headline""#), serde_json::json!(["org-data", "headline", "headline"]));
    assert_eq!(
        types(&mut ed, r#""element""#),
        serde_json::json!(["org-data", "section", "paragraph", "headline", "section", "plain-list", "item", "paragraph", "headline", "section", "paragraph"])
    );
    assert_eq!(
        types(&mut ed, r#""greater-element""#),
        serde_json::json!(["org-data", "section", "paragraph", "headline", "section", "plain-list", "headline", "section", "paragraph"])
    );
    let all = types(&mut ed, "");
    assert!(all.as_array().unwrap().iter().any(|t| t == "bold"), "{all}");
}

/// Visible only, folded text is left out, as an export of the visible
/// part leaves out a folded subtree's body.
#[test]
fn visible_only_leaves_out_folded_text() {
    let (mut ed, s) = setup();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.insert("* A\nbody of A\n* B\nbody of B\n"); e8.call("org-mode"); e8.gotoChar(0);"#.into()).unwrap();
    ed.press("TAB").unwrap();
    let texts = |ed: &mut Editor, visible: bool| -> Value {
        run(
            ed,
            &s,
            &format!(
                r#"const t = oe.parseBuffer(undefined, {visible}); const out: string[] = []; const walk = (n: any) => {{ for (const c of n.contents) typeof c === "string" ? out.push(c) : walk(c); }}; walk(t); return out;"#
            ),
        )
    };
    // Headings' titles are not their contents, so only the bodies show.
    assert_eq!(texts(&mut ed, false), serde_json::json!(["body of A\n", "body of B\n"]));
    assert_eq!(texts(&mut ed, true), serde_json::json!(["body of B\n"]));
}

/// A long document parses quickly enough to export, on either engine.
#[test]
fn a_long_document_parses() {
    let (mut ed, s) = setup();
    let mut text = String::new();
    for i in 0..1000 {
        text.push_str(&format!(
            "* TODO Heading {i} :tag:\nSCHEDULED: <2026-11-27 Fri>\nSome *bold* text with a [[https://example.com][link]] and =code=.\n- item one\n- [X] item two\n| a | b |\n"
        ));
    }
    s.eval_typescript(&mut ed, "t.ts", format!("e8.insert({}); e8.call(\"org-mode\");", serde_json::to_string(&text).unwrap())).unwrap();
    let start = std::time::Instant::now();
    let n = run(&mut ed, &s, r#"const t = oe.parseBuffer(); return t.contents.length;"#);
    eprintln!("parsed {} lines in {:?}", text.lines().count(), start.elapsed());
    assert_eq!(n, 1000);
}

#[test]
fn the_parse_matches_emacs() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let golden = golden["cases"].as_array().unwrap();
    let (mut ed, s) = setup();
    let mut failures = Vec::new();
    for (n, case) in cases.as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let want = golden.iter().find(|g| g["name"] == name).unwrap_or_else(|| panic!("{name}: not recorded; run emacs -Q --batch -l tests/emacs/org-element/dump.el"));
        let (tree, interpreted) = parse(&mut ed, &s, n, text);
        if let Some(d) = first_difference("", &tree, &want["tree"]) {
            failures.push(format!("{name}: tree differs at {d}"));
        }
        if interpreted != want["interpreted"].as_str().unwrap() {
            failures.push(format!("{name}: interpreted differs:\nE8:\n{interpreted}\nEmacs:\n{}", want["interpreted"].as_str().unwrap()));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.as_array().unwrap().len(), failures.join("\n\n"));
}

/// The object around a position, as org-element-context gives it: each as
/// Emacs 30's Org 9.7 gives it at the same place (scratch script
/// `org-element-context` at each position), its type, begin, end and the
/// object it is in, or none where Emacs's context is an element.
#[test]
fn the_object_at_a_position_is_org_element_contexts() {
    let (mut ed, s) = setup();
    // The text, the position, and the object: its type, begin, end and parent, if any.
    type Want = Option<(&'static str, i64, i64, Option<&'static str>)>;
    let cases: &[(&str, usize, Want)] = &[
        ("Text with [[https://a.b][a link]] and [fn:1] here.\n", 27, Some(("link", 10, 34, None))),
        ("Text with [[https://a.b][a link]] and [fn:1] here.\n", 38, Some(("footnote-reference", 38, 45, None))),
        ("Text with [[https://a.b][a link]] and [fn:1] here.\n", 46, None),
        ("*bold [fn:2] text*\n", 7, Some(("footnote-reference", 6, 13, Some("bold")))),
        ("*bold [fn:2] text*\n", 14, Some(("bold", 0, 18, None))),
        ("* TODO Title [fn:3] :tag:\n", 14, Some(("footnote-reference", 13, 19, None))),
        // On the tags, the title's last object, as it ends where the title does.
        ("* TODO Title [fn:3] :tag:\n", 22, Some(("footnote-reference", 13, 19, None))),
        ("- tag [fn:4] :: desc\n", 7, Some(("footnote-reference", 6, 12, None))),
        ("- tag [fn:4] :: desc\n", 18, None),
        ("#+CAPTION: cap *b*\n| a |\n", 16, Some(("bold", 15, 18, None))),
        ("#+CAPTION: cap *b*\n| a |\n", 2, None),
        ("| x [fn:5] |\n", 5, Some(("footnote-reference", 4, 10, Some("table-cell")))),
        ("| x [fn:5] |\n", 2, Some(("table-cell", 1, 12, None))),
        ("x =a[fn:6]b= y\n", 5, Some(("verbatim", 2, 13, None))),
        // Right after an object with no space after it.
        ("End *b*\n", 7, Some(("bold", 4, 7, None))),
    ];
    for (n, (text, pos, want)) in cases.iter().enumerate() {
        let got = run(
            &mut ed,
            &s,
            &format!(
                r#"e8.setBuffer(e8.getBufferCreate("ctx-{n}")); e8.insert({}); e8.call("org-mode");
                   const o = oe.objectAt({pos});
                   return o ? [o.type, o.p.begin, o.p.end, o.parent ? o.parent.type : null] : null;"#,
                serde_json::to_string(text).unwrap()
            ),
        );
        let want = match want {
            None => Value::Null,
            Some((t, b, e, p)) => serde_json::json!([t, b, e, p]),
        };
        assert_eq!(got, want, "{text:?} at {pos}");
    }
}
