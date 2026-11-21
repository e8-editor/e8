//! Clock tables over several files, which the Emacs oracle does not
//! visit, and dynamic blocks written by functions of one's own.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const CLOCKED: &str = "* Task\nCLOCK: [2026-11-02 Mon 09:00]--[2026-11-02 Mon 10:30] =>  1:30\n";

/// The files in a fresh directory, and an editor visiting the first, with today fixed.
fn visiting(files: &[(&str, &str)]) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    let first = dir.path().join(files[0].0);
    ed.call("find-file", vec![e8_core::Arg::Str(first.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-21".into()));
    (ed, scripting, dir)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The table's lines, between #+BEGIN: and #+END:.
fn table(ed: &Editor) -> Vec<String> {
    let t = text(ed);
    let start = t.find("#+BEGIN:").unwrap();
    let end = t.find("#+END:").unwrap();
    t[start..end].lines().skip(1).map(str::to_string).collect()
}

/// A list of files is a table of each, with a line for each file's time.
#[test]
fn a_table_of_several_files() {
    let (mut ed, _s, dir) = visiting(&[("report.org", ""), ("a.org", CLOCKED), ("b.org", "* Other\nCLOCK: [2026-11-03 Tue 09:00]--[2026-11-03 Tue 09:15] =>  0:15\n")]);
    let (a, b) = (dir.path().join("a.org"), dir.path().join("b.org"));
    ed.type_text(&format!("#+BEGIN: clocktable :scope (\"{}\" \"{}\")\n#+END:\n", a.display(), b.display()));
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(
        table(&ed),
        [
            "#+CAPTION: Clock summary at [2026-11-21 Sat 12:00]",
            "| File  | Headline         | Time   |",
            "|-------+------------------+--------|",
            "|       | ALL *Total time* | *1:45* |",
            "|-------+------------------+--------|",
            "| a.org | *File time*      | *1:30* |",
            "|       | Task             | 1:30   |",
            "|-------+------------------+--------|",
            "| b.org | *File time*      | *0:15* |",
            "|       | Other            | 0:15   |",
        ]
    );
}

/// With levels and percentages, a file with no time left out, as Org writes them.
#[test]
fn several_files_with_levels_and_percentages() {
    let (mut ed, _s, dir) = visiting(&[("report.org", ""), ("a.org", CLOCKED), ("b.org", "* Other\nCLOCK: [2026-11-03 Tue 09:00]--[2026-11-03 Tue 09:15] =>  0:15\n"), ("c.org", "* Nothing\n")]);
    let [a, b, c] = ["a.org", "b.org", "c.org"].map(|f| dir.path().join(f).display().to_string());
    ed.type_text(&format!("#+BEGIN: clocktable :scope (\"{a}\" \"{b}\" \"{c}\") :fileskip0 t :header \"\" :level t :formula %\n#+END:\n"));
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(
        table(&ed),
        [
            "| File  |   L | Headline     | Time   |     % |",
            "|-------+-----+--------------+--------+-------|",
            "|       | ALL | *Total time* | *1:45* | 100.0 |",
            "|-------+-----+--------------+--------+-------|",
            "| a.org |     | *File time*  | *1:30* |  85.7 |",
            "|       |   1 | Task         | 1:30   |  85.7 |",
            "|-------+-----+--------------+--------+-------|",
            "| b.org |     | *File time*  | *0:15* |  14.3 |",
            "|       |   1 | Other        | 0:15   |  14.3 |",
        ]
    );
}

/// :hidefiles leaves the files out, and :fileskip0 a file with no time.
#[test]
fn hiding_files_and_skipping_empty_ones() {
    let (mut ed, _s, dir) = visiting(&[("report.org", ""), ("a.org", CLOCKED), ("b.org", "* Nothing\n")]);
    let (a, b) = (dir.path().join("a.org"), dir.path().join("b.org"));
    ed.type_text(&format!("#+BEGIN: clocktable :scope (\"{}\" \"{}\") :hidefiles t :fileskip0 t :header \"\"\n#+END:\n", a.display(), b.display()));
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(table(&ed), ["| Headline     | Time   |", "|--------------+--------|", "| *Total time* | *1:30* |", "|--------------+--------|", "| Task         | 1:30   |"]);
}

/// :scope agenda reads org-agenda-files, and :filetitle names each by its #+TITLE:.
#[test]
fn the_agenda_files_by_title() {
    let (mut ed, s, dir) = visiting(&[("report.org", ""), ("a.org", &format!("#+TITLE: Work log\n{CLOCKED}"))]);
    let a = dir.path().join("a.org");
    s.eval_typescript(&mut ed, "test.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]);", a.display().to_string())).unwrap();
    ed.type_text("#+BEGIN: clocktable :scope agenda :filetitle t :header \"\"\n#+END:\n");
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(
        table(&ed),
        ["| File     | Headline         | Time   |", "|----------+------------------+--------|", "|          | ALL *Total time* | *1:30* |", "|----------+------------------+--------|", "| Work log | *File time*      | *1:30* |", "|          | Task             | 1:30   |"]
    );
}

/// file-with-archives counts the archive file's clocks as the file's own.
#[test]
fn the_file_with_its_archive() {
    let (mut ed, _s, _dir) = visiting(&[
        ("tasks.org", "#+BEGIN: clocktable :scope file-with-archives :header \"\"\n#+END:\n\n* Open\nCLOCK: [2026-11-04 Wed 09:00]--[2026-11-04 Wed 09:20] =>  0:20\n"),
        ("tasks.org_archive", CLOCKED),
    ]);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(
        table(&ed),
        ["| Headline     |   Time |", "|--------------+--------|", "| *Total time* | *1:50* |", "|--------------+--------|", "| Open         |   0:20 |", "|--------------+--------|", "| Task         |   1:30 |"]
    );
}

/// A formula the old table had is kept below the new one.
#[test]
fn an_old_formula_stays_with_the_table() {
    let (mut ed, _s, _dir) = visiting(&[("t.org", &format!("#+BEGIN: clocktable :header \"\"\n| old |\n#+TBLFM: $2=1\n#+END:\n{CLOCKED}"))]);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert!(text(&ed).contains("| Task         | 1:30   |\n#+TBLFM: $2=1\n#+END:"), "{}", text(&ed));
}

/// :formula writes its formula below the table.
#[test]
fn a_formula_is_written_below() {
    let (mut ed, _s, _dir) = visiting(&[("t.org", &format!("#+BEGIN: clocktable :header \"\" :formula \"$3=2\"\n#+END:\n{CLOCKED}"))]);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert!(text(&ed).contains("| Task         | 1:30   |\n#+TBLFM: $3=2\n#+END:"), "{}", text(&ed));
}

/// Updating says which block, and where.
#[test]
fn updating_says_so() {
    let (mut ed, _s, _dir) = visiting(&[("t.org", &format!("Notes.\n#+BEGIN: clocktable\n#+END:\n{CLOCKED}"))]);
    ed.window_buffer_mut().set_point(10);
    ed.press("C-c C-x C-u").unwrap();
    assert_eq!(ed.echo(), Some("Updating dynamic block ‘clocktable’ at line 2...done"));
}

/// A dynamic block of one's own: org-dblock-write:NAME writes it, with the
/// parameters of its #+BEGIN: line, and C-c C-x x offers what
/// org-dynamic-block-define names.
#[test]
fn dynamic_blocks_of_ones_own() {
    let (mut ed, s, _dir) = visiting(&[("t.org", "  #+BEGIN: hello :who \"world\" :times 2\n  old\n  #+END:\n")]);
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r##"
        e8.defun("org-dblock-write:hello", (params: e8.Value[]) => {
          const get = (k: string) => params[params.findIndex((p) => typeof p === "symbol" && e8.symbolName(p) === k) + 1];
          for (let i = 0; i < (get(":times") as number); i++) e8.insert(`Hello, ${get(":who")}!\n`);
          e8.deleteRegion(e8.point() - 1, e8.point());
        });
        e8.funcall("org-dynamic-block-define", "hello", () => e8.insert("#+BEGIN: hello :name \"you\" :times 1\n#+END:\n"));
        "##
        .to_string(),
    )
    .unwrap();
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "  #+BEGIN: hello :who \"world\" :times 2\n  Hello, world!\n  Hello, world!\n  #+END:\n");
}

/// A directory among org-agenda-files stands for its Org files, as Org lists them.
#[test]
fn an_agenda_directory() {
    let (mut ed, s, dir) = visiting(&[("report.txt", ""), ("a.org", CLOCKED), (".hidden.org", CLOCKED), ("notes.txt", CLOCKED)]);
    s.eval_typescript(&mut ed, "test.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]);", dir.path().display().to_string())).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    ed.type_text("#+BEGIN: clocktable :scope agenda :header \"\"\n#+END:\n");
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(table(&ed)[2], "|       | ALL *Total time* | *1:30* |");
}
