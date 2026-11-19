//! ANSI colours as Emacs 30.2's ansi-color.el makes them: what
//! ansi-color-apply, ansi-color-filter-apply, ansi-color-apply-on-region and
//! ansi-color-filter-region make of output given in chunks, compared with
//! what tests/emacs/ansi-color.el recorded Emacs making of it.

use e8_core::Editor;
use e8_script::Scripting;

/// Prints a face as Emacs's prin1 does, names bare and colours quoted, and
/// gives the runs of text by face, as the recording script does.
const PRINT: &str = r#"
const quote = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const print = (v) => v === null || v === undefined || v === false ? "nil"
  : typeof v === "string" ? v
  : Array.isArray(v) ? (typeof v[0] === "string" && v[0].startsWith(":")
      ? "(" + v.map((x, i) => (i % 2 === 0 ? x : typeof x === "string" ? quote(x) : String(x))).join(" ") + ")"
      : "(" + v.map(print).join(" ") + ")")
  : String(v);
const runs = (text, faceAt) => {
  const chars = [...text];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const face = print(faceAt(i));
    let j = i + 1;
    while (j < chars.length && print(faceAt(j)) === face) j++;
    out.push(quote(chars.slice(i, j).join("")) + " " + face);
    i = j;
  }
  return out.join(" | ");
};
const stringRuns = (s) => {
  if (typeof s === "string") return runs(s, () => null);
  return runs(s.string, (i) => s.properties.find(([a, b]) => a <= i && i < b)?.[2]?.["font-lock-face"]);
};
const bufferRuns = () => runs(e8.bufferText(), (i) => e8.getTextProperty(i, "font-lock-face"));
"#;

fn run_case(ed: &mut Editor, s: &Scripting, chunks: &str, bright: bool) -> Vec<String> {
    let code = format!(
        r#"(() => {{ {PRINT}
  const chunks = {chunks};
  e8.setDefault("ansi-color-bold-is-bright", {bright});
  const out = [];
  const fresh = (name) => {{ e8.call("switch-to-buffer", name); e8.deleteRegion(e8.pointMin(), e8.pointMax()); e8.setVariable("ansi-color-context", null); e8.setVariable("ansi-color-context-region", null); }};
  fresh("s1");
  const applied = chunks.map((c) => e8.funcall("ansi-color-apply", c));
  out.push("ansi-color-apply\t" + runs(applied.map((x) => (typeof x === "string" ? x : x.string)).join(""), (() => {{
    const faces = [];
    for (const x of applied) {{ const s = typeof x === "string" ? x : x.string; [...s].forEach((_, i) => faces.push(typeof x === "string" ? null : x.properties.find(([a, b]) => a <= i && i < b)?.[2]?.["font-lock-face"])); }}
    return (i) => faces[i];
  }})()));
  fresh("s2");
  out.push("ansi-color-filter-apply\t" + stringRuns(chunks.map((c) => e8.funcall("ansi-color-filter-apply", c)).join("")));
  fresh("s3");
  e8.letBind({{ "ansi-color-apply-face-function": "ansi-color-apply-text-property-face" }}, () => {{
    for (const c of chunks) {{ const start = e8.pointMax(); e8.gotoChar(start); e8.insert(c); e8.funcall("ansi-color-apply-on-region", start, e8.pointMax()); }}
  }});
  out.push("ansi-color-apply-on-region\t" + bufferRuns());
  fresh("s4");
  for (const c of chunks) {{ const start = e8.pointMax(); e8.gotoChar(start); e8.insert(c); e8.funcall("ansi-color-filter-region", start, e8.pointMax()); }}
  out.push("ansi-color-filter-region\t" + bufferRuns());
  e8.setDefault("ansi-color-bold-is-bright", false);
  return JSON.stringify(out);
}})()"#,
        bright = if bright { "true" } else { "false" },
    );
    let got = s.eval_expression(ed, &code).unwrap_or_else(|e| panic!("{chunks}: {e}"));
    let json: String = serde_json::from_str(&got).unwrap();
    serde_json::from_str(&json).unwrap()
}

#[test]
fn sgr_sequences_become_the_faces_emacs_makes() {
    let recorded = include_str!("../../../../tests/emacs/ansi-color.txt");
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut failures = Vec::new();
    let mut lines = recorded.lines().peekable();
    let mut cases = 0;
    while let Some(header) = lines.next() {
        let mut fields = header.strip_prefix("case ").expect(header).split('\t');
        let (name, bright, chunks) = (fields.next().unwrap(), fields.next().unwrap() == "t", fields.next().unwrap());
        let want: Vec<&str> = (0..4).map(|_| lines.next().unwrap()).collect();
        let got = run_case(&mut ed, &s, chunks, bright);
        for (w, g) in want.iter().zip(&got) {
            if w != g {
                failures.push(format!("{name}:\n  emacs: {w:?}\n  e8:    {g:?}"));
            }
        }
        cases += 1;
    }
    assert!(cases >= 20, "{cases}");
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}

/// Colours on overlays, Emacs's default for comint buffers other than
/// shell's: they do not grow over text inserted after them.
#[test]
fn overlay_faces_do_not_grow() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let got = s
        .eval_expression(
            &mut ed,
            r#"(() => {
  e8.call("switch-to-buffer", "o");
  e8.insert("\x1b[31mred");
  e8.funcall("ansi-color-apply-on-region", 0, e8.pointMax());
  e8.insert(" after");
  const o = e8.overlaysAt(0)[0];
  return JSON.stringify([e8.bufferText(), e8.overlayStart(o), e8.overlayEnd(o), e8.overlayGet(o, "face"), e8.overlaysAt(4).length]);
})()"#,
        )
        .unwrap();
    assert_eq!(got, r#""[\"red after\",0,3,[\":foreground\",\"red3\"],0]""#);
}
