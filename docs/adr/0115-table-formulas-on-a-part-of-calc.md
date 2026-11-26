# 0115. Table formulas on a part of Calc, written in TypeScript

Status: accepted · 2026-11-26

## Context

Org's tables are spreadsheets: a `#+TBLFM:` line under a table holds formulas, as `$3=$1*$2` for a column or `@>$1=vsum(@I..@II)` for a field, which `C-c *`, `C-c C-c` and `C-c =` apply. E8 had none of this ([differences.md](../differences.md)): clock tables wrote their `:formula` and capture wrote its table lines without computing anything.

Org does two things with a formula. First it replaces the references in it with the fields' text, so `$1*$2` becomes `(3)*(4)`, and `vsum(@2..@-1)` becomes `vsum([1,2,4])`. That part is Org's own Lisp in `org-table.el`, as the rest of `org-table.ts` already follows. Then it hands the result to Calc, Emacs's calculator, through `calc-eval`, with the modes in `org-calc-default-modes`: twelve digits of precision inside, eight shown. What a table shows is what Calc computes and how it writes the result: `7/2` is `3.5`, `10/2` is the integer `5`, `1.0*3` is `3.` with Calc's trailing point, `0.0001` is `1e-4`, `$1*$2` with a word in a field is the formula `2 abc`, and the difference of two dates is a number of days. Calc is 40,000 lines of Lisp, nearly all of it for its own buffer, algebra, units, matrices and graphs, which table formulas do not reach.

A formula can also be Lisp, `'(concat $1 $2)`, which Org evaluates with `eval`.

## Options considered

1. **Port Calc.** Faithful by construction, but most of it is the calculator's interface and symbolic algebra, which a table never asks for, and it would be the biggest package E8 has.
2. **Evaluate formulas with JavaScript's numbers.** Small, but wrong where tables show it: doubles print `0.1+0.2` as `0.30000000000000004` where Calc prints `0.3`, they have no exact integers beyond 2^53 or fractions, and none of Calc's way of writing results.
3. **Write the part of Calc that `calc-eval` uses for Org**, in `packages/calc.ts`: Calc's algebraic syntax as `math-read-exprs` reads it, its numbers as Calc keeps them (integers of any size, fractions, decimal floats of `calc-internal-prec` digits, rounded as `math-make-float` rounds them, date forms), its arithmetic and the functions tables use (`vsum`, `vmean`, `vmedian`, `vmax`, `vsdev`, `round`, `floor`, `sqrt`, `exp`, `ln`, `if`, comparisons, the date functions, and the rest listed in the file), and its flat display (`math-format-number` in each float format, and formulas with Calc's precedences and spacing). A function Calc has that this part lacks, or one that cannot apply, stays as a formula, as Calc leaves it.

For Lisp formulas, E8 has no Lisp ([ADR 0003](0003-typescript-on-quickjs.md)), and an interpreter for the Lisp a formula might hold is a language of its own.

## Decision

Option 3: `packages/calc.ts`, a TypeScript port of the parts of Calc that table formulas reach, with `calc-eval` for code; and Org's formula machinery ported into `org-table.ts`, calling it. A Lisp formula gives `#ERROR`, as Org gives for a Lisp formula that fails.

## Consequences

- Column and field formulas, ranges, named columns and fields, parameters, constants (`org-table-formula-constants`, `#+CONSTANTS:`, `$PROP_`), `remote()`, the format flags and printf formats, durations and dates work as in Org: `C-c =` (with `C-u` for a field, `C-u C-u` to edit it in the field), `C-c *` and `C-c C-c` (with `C-u` for every row, `C-u C-u` to iterate), `=` and `:=` typed in a field, rows marked `#`, `*` and the rest, `C-#` to mark them, `C-c ?`, and the buffer-wide commands.
- `tests/emacs/calc/` records what Emacs 30.2's `calc-eval` gives for 430 formulas in Org's modes, and `crates/e8-script/tests/all/calc.rs` checks `calc.ts` against them; `tests/emacs/cases/org-table-formulas.json` checks whole tables through Org's keys.
- Not here: complex numbers (`sqrt(-1)` stays as it is, where Calc gives `(0, 1)`), intervals, error and modulo forms, HMS forms, units, matrices beyond a dot product, and Calc's algebra beyond what its arithmetic does as it computes (`math-add-symb-fancy`, `math-mul-symb-fancy` and `math-div-symb-fancy`: `2*a*3` is `6 a`, `x+x` is `2 x`), as its simplifier and rewrite rules. Square roots are computed exactly to any precision, but `exp`, `ln`, the trigonometric functions and powers to a fraction use doubles, so with `p` above 15 their last digits differ from Calc's. These are listed in [differences.md](../differences.md) and `tests/emacs/calc/known-gaps.txt`.
- Lisp formulas give `#ERROR`. If tables are found to need them, a small evaluator for the pure functions formulas use (`concat`, `format`, `string-to-number`, arithmetic) would be the next step, as an ADR of its own.
- Moving or deleting columns and rows does not yet change the formulas' references, as `org-table-fix-formulas` does, and the formula editor (`C-c '`), reference highlighting and coordinates (`C-c }`) and the formula debugger (`C-c {`) are not here yet.

## Dependencies introduced

None.
