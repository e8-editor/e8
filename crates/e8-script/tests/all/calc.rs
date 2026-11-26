//! The part of Calc that Org's table formulas use (`packages/calc.ts`),
//! against what Emacs 30.2's `calc-eval` gave for the same formulas in
//! Org's modes, as `tests/emacs/calc/record.el` recorded them. Where E8
//! differs on purpose or not yet, `tests/emacs/calc/known-gaps.txt` names
//! the formula and says why.

use e8_core::Editor;
use e8_script::Scripting;
use serde_json::Value;

#[test]
fn formulas_give_what_calc_gives() {
    let golden: Vec<Value> = serde_json::from_str(include_str!("../../../../tests/emacs/calc/golden.json")).unwrap();
    let gaps: Vec<&str> = include_str!("../../../../tests/emacs/calc/known-gaps.txt")
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| l.split(" # ").next().unwrap().trim_end())
        .collect();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let cases = serde_json::to_string(&golden).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        format!(
            r#"
            const defaults: e8.Value[] = ["calc-internal-prec", 12, "calc-float-format", ["float", 8], "calc-angle-mode", "deg", "calc-prefer-frac", null, "calc-symbolic-mode", null];
            const out: string[] = [];
            for (const c of {cases} as any[]) {{
              const modes = [...defaults];
              for (let i = 0; i < c.modes.length; i += 2) {{
                const at = modes.indexOf(c.modes[i]);
                if (at >= 0) modes[at + 1] = c.modes[i + 1]; else modes.push(c.modes[i], c.modes[i + 1]);
              }}
              let r: any;
              try {{ r = e8.funcall("calc-eval", [c.formula, ...modes], c.num ? "num" : null); }} catch (e: any) {{ r = `ERR ${{e.message}}`; }}
              out.push(typeof r === "string" ? r : `ERROR ${{r[1]}}`);
            }}
            globalThis.result = JSON.stringify(out);
            "#
        ),
    )
    .unwrap();
    let results: Vec<String> = serde_json::from_str(&serde_json::from_str::<String>(&s.eval_expression(&mut ed, "globalThis.result").unwrap()).unwrap()).unwrap();
    let mut failures = vec![];
    let mut matched_gaps = vec![];
    for (case, got) in golden.iter().zip(&results) {
        let modes = case["modes"].as_array().unwrap();
        let name = if modes.is_empty() {
            case["formula"].as_str().unwrap().to_string()
        } else {
            format!("{} {}", serde_json::to_string(modes).unwrap(), case["formula"].as_str().unwrap())
        };
        let name = if case["num"].as_bool() == Some(true) { format!("{name} num") } else { name };
        let want = match &case["result"] {
            Value::String(s) => s.clone(),
            other => format!("ERROR {}", other["error"].as_str().unwrap()),
        };
        // Org writes #ERROR for any error, so only that there was one counts.
        let same = if want.starts_with("ERROR ") { got.starts_with("ERROR ") } else { *got == want };
        let gap = gaps.contains(&name.as_str());
        if same && gap {
            matched_gaps.push(name);
        } else if !same && !gap {
            failures.push(format!("{name}\n    Calc: {want}\n    E8:   {got}"));
        }
    }
    assert!(failures.is_empty(), "{} formulas differ from Calc:\n{}", failures.len(), failures.join("\n"));
    assert!(matched_gaps.is_empty(), "these now match Calc, so take them out of known-gaps.txt:\n{}", matched_gaps.join("\n"));
}
