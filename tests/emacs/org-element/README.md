# The org-element oracle

These files check E8's full Org parse, `parseBuffer` in `packages/org-element.ts`, against Emacs's `org-element-parse-buffer`, which Org's exporter and much else read documents through.

- `cases.json`: the texts, each `{"name", "text"}`.
- `dump.el`: parses each text in an Org mode buffer of batch Emacs and writes `golden.json`.
- `golden.json`: for each case, the tree Emacs's Org gives and the text `org-element-interpret-data` writes back from it. Committed, so the test runs without Emacs.
- `crates/e8-script/tests/all/org_element_parse.rs`: parses each text in E8 and compares, naming the first place each case differs.

A node is `{"type", "props", "contents"}` and plain text a string. Properties are named as Org names them without the colon; positions count from 0, where Emacs counts from 1; symbols are their names and t is `true`; nil properties are left out, as E8 leaves out undefined ones. A caption is a list of `{"value", "secondary"}`, its short form or null, and `results` is `{"value", "secondary"}` too, as E8 keeps both. A list's `structure` is its items as Org keeps them, each `[begin, indentation, bullet, counter, checkbox, tag, end]`.

After adding or changing cases, record them from the repository's root:

```bash
emacs -Q --batch -l tests/emacs/org-element/dump.el
```

and run the test:

```bash
cargo nextest run -p e8-script --test all org_element_parse
```
