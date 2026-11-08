//! Ediff (packages/ediff.ts), which ediff-hook.ts's entry commands load:
//! the windows it lays out, the faces it puts on the differences, the
//! control panel's keys, quitting and its hooks, three-way comparison and
//! merging, and what a package such as magit-ediff calls.
//!
//! The oracle cases in tests/emacs/cases/ediff.json check what batch
//! Emacs can record: the files after copying, restoring and saving, the
//! merge buffer's text, the errors and the restore message. Batch Emacs has
//! no faces, so it never refines a region into fine differences, and its
//! control window is four lines rather than an interactive Emacs's two, so
//! the window sizes, faces and fine differences are tested here instead,
//! against what `emacs -Q -nw` showed at 80 by 25.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    (ed, s, tempfile::tempdir().unwrap())
}

fn eval(ed: &mut Editor, s: &Scripting, js: &str) -> String {
    s.eval_expression(ed, js).unwrap_or_else(|e| panic!("{js}: {e}"))
}

/// What a JSON.stringify expression gives.
fn json(ed: &mut Editor, s: &Scripting, js: &str) -> String {
    serde_json::from_str(&eval(ed, s, js)).unwrap()
}

fn text_of(ed: &mut Editor, s: &Scripting, buffer: &str) -> String {
    serde_json::from_str(&eval(ed, s, &format!("e8.withCurrentBuffer({buffer:?}, () => e8.bufferText())"))).unwrap()
}

/// Each window's buffer, width and total height, in cyclic order.
fn layout(ed: &Editor) -> Vec<(String, usize, usize)> {
    let sizes = ed.window_total_sizes();
    ed.windows()
        .iter()
        .map(|w| {
            let (width, height) = sizes.iter().find(|s| s.0 == w.id).map_or((0, 0), |s| (s.1, s.2));
            (w.buffer.name.clone(), width, height)
        })
        .collect()
}

fn file(dir: &tempfile::TempDir, name: &str, text: &str) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, text).unwrap();
    path.display().to_string()
}

fn ediff_files(ed: &mut Editor, dir: &tempfile::TempDir) {
    let a = file(dir, "a.txt", "one\ntwo\nthree\nfour\nfive\n");
    let b = file(dir, "b.txt", "one\nTWO 2\nthree\nfive\nsix\n");
    ed.call("ediff-files", vec![Arg::Str(a), Arg::Str(b)]).unwrap();
}

/// The overlays in a buffer that have a face: start, end and face.
fn faces(ed: &mut Editor, s: &Scripting, buffer: &str) -> Vec<(usize, usize, String)> {
    let js = format!(
        "JSON.stringify(e8.withCurrentBuffer({buffer:?}, () => e8.overlaysIn(0, e8.bufferSize()).map(o => [e8.overlayStart(o), e8.overlayEnd(o), e8.overlayGet(o, 'face')]).filter(o => o[2])))"
    );
    let mut got: Vec<(usize, usize, String)> = serde_json::from_str::<serde_json::Value>(&serde_json::from_str::<String>(&eval(ed, s, &js)).unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o[0].as_u64().unwrap() as usize, o[1].as_u64().unwrap() as usize, o[2].as_str().unwrap().to_string()))
        .collect();
    got.sort();
    got
}

#[test]
fn ediff_loads_when_its_command_is_first_used() {
    let (mut ed, s, dir) = setup();
    assert_eq!(eval(&mut ed, &s, "e8.fboundp('ediff-merge-on-startup')"), "false", "ediff.ts is not preloaded");
    ediff_files(&mut ed, &dir);
    assert_eq!(eval(&mut ed, &s, "e8.fboundp('ediff-merge-on-startup')"), "true");
    assert_eq!(ed.window_buffer().name, "*Ediff Control Panel*");
}

#[test]
fn ediff_files_lays_out_a_over_b_with_the_control_panel_below() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    // As emacs -Q -nw, the variants share the frame and the panel takes two lines.
    assert_eq!(
        layout(&ed),
        vec![("a.txt".into(), 80, 11), ("b.txt".into(), 80, 11), ("*Ediff Control Panel*".into(), 80, 2)]
    );
    assert_eq!(text_of(&mut ed, &s, "*Ediff Control Panel*"), format!("{}Type ? for help", " ".repeat(33)));
    assert_eq!(ed.window_buffer().point(), 33);
    assert_eq!(eval(&mut ed, &s, "e8.formatModeLine()"), r#""-- *Ediff Control Panel*   At start of 3 diffs""#);
    assert_eq!(eval(&mut ed, &s, "e8.variable('ediff-number-of-differences')"), "3");
    assert_eq!(ed.messages().last().map(String::as_str), Some("Processing difference regions ... done"));
    // The differences are shaded, odd and even as the user counts them.
    assert_eq!(
        faces(&mut ed, &s, "a.txt"),
        vec![
            (4, 8, "ediff-odd-diff-A".into()),
            (14, 19, "ediff-even-diff-A".into()),
            // Where the current difference's overlay waits, empty, as in Emacs.
            (24, 24, "ediff-current-diff-A".into()),
            (24, 24, "ediff-odd-diff-A".into())
        ]
    );
}

#[test]
fn n_highlights_the_difference_and_its_changed_words() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    ed.press("n").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.formatModeLine()"), r#""-- *Ediff Control Panel*   diff 1 of 3""#);
    assert_eq!(eval(&mut ed, &s, "e8.variable('ediff-current-difference')"), "0");
    // "two" against "TWO 2": the line is current, and its words differ.
    assert_eq!(
        faces(&mut ed, &s, "a.txt"),
        vec![(4, 7, "ediff-fine-diff-A".into()), (4, 8, "ediff-current-diff-A".into()), (14, 19, "ediff-even-diff-A".into()), (24, 24, "ediff-odd-diff-A".into())]
    );
    assert_eq!(
        faces(&mut ed, &s, "b.txt"),
        vec![(4, 9, "ediff-fine-diff-B".into()), (4, 10, "ediff-current-diff-B".into()), (16, 16, "ediff-even-diff-B".into()), (21, 25, "ediff-odd-diff-B".into())]
    );
    // An empty region is shown a character long.
    ed.press("n").unwrap();
    assert!(faces(&mut ed, &s, "b.txt").contains(&(16, 17, "ediff-current-diff-B".into())), "{:?}", faces(&mut ed, &s, "b.txt"));
    assert_eq!(ed.echo(), Some("Region 2 in buffer B is empty"));
    // Point follows into each variant's window.
    let points: Vec<(String, usize)> = ed.windows().iter().map(|w| (w.buffer.name.clone(), w.point)).collect();
    assert_eq!(points[0], ("a.txt".into(), 14));
    assert_eq!(points[1], ("b.txt".into(), 16));
}

#[test]
fn moving_past_either_end_is_a_user_error() {
    let (mut ed, _s, dir) = setup();
    ediff_files(&mut ed, &dir);
    ed.press("p").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("At beginning of the difference list"));
    ed.press("n n n n").unwrap();
    assert_eq!(ed.take_error(), None);
    ed.press("n").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("At end of the difference list"));
}

#[test]
fn copying_saves_what_it_replaced_for_r_to_restore() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    ed.press("n a").unwrap();
    assert_eq!(text_of(&mut ed, &s, "b.txt"), "one\ntwo\nthree\nfive\nsix\n");
    assert!(ed.messages().iter().any(|m| m == "Saving old diff region #1 of buffer B.  To recover, type ‘rb’"), "{:?}", ed.messages());
    // The copy is the same as A's now, so its words no longer differ.
    assert_eq!(ed.echo(), Some("Only white-space differences in region 1 "));
    ed.press("r b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "b.txt"), "one\nTWO 2\nthree\nfive\nsix\n");
    assert_eq!(ed.echo(), Some("Diff region 1 in buffer B restored"));
    // 3 j then b copies the third difference from B into A.
    ed.press("3 j b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
}

#[test]
fn bar_splits_the_variants_side_by_side_and_question_mark_shows_the_long_help() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    ed.press("|").unwrap();
    assert_eq!(
        layout(&ed),
        vec![("a.txt".into(), 40, 22), ("b.txt".into(), 40, 22), ("*Ediff Control Panel*".into(), 80, 2)]
    );
    ed.press("?").unwrap();
    let help = text_of(&mut ed, &s, "*Ediff Control Panel*");
    assert!(help.contains("p,DEL -previous diff |     | -vert/horiz split   |a/b -copy A/B's region to B/A"), "{help}");
    assert_eq!(help.lines().count(), 17);
    // At most half the frame.
    assert_eq!(layout(&ed)[2], ("*Ediff Control Panel*".into(), 80, 12));
    assert!(eval(&mut ed, &s, "e8.formatModeLine()").ends_with("Quick Help\""));
    ed.press("?").unwrap();
    assert_eq!(layout(&ed)[2], ("*Ediff Control Panel*".into(), 80, 2));
}

#[test]
fn the_variants_mode_lines_show_which_they_are_until_quitting() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    let mode_line = |ed: &mut Editor, b: &str| json(ed, &s, &format!("JSON.stringify(e8.bufferLocalValue('mode-line-format', {b:?}))"));
    assert!(mode_line(&mut ed, "a.txt").starts_with(r#"[" A: ""#), "{}", mode_line(&mut ed, "a.txt"));
    assert!(mode_line(&mut ed, "b.txt").starts_with(r#"[" B: ""#));
    ed.press("q y").unwrap();
    assert_eq!(ed.take_error(), None);
    assert!(!mode_line(&mut ed, "a.txt").starts_with(r#"[" A: ""#));
    assert_eq!(layout(&ed), vec![("a.txt".into(), 80, 12), ("b.txt".into(), 80, 12)]);
    for gone in ["*Ediff Control Panel*", "*ediff-diff*", "*ediff-errors*", "*ediff-fine-diff*"] {
        assert_eq!(ed.find_buffer(gone), None, "{gone}");
    }
}

#[test]
fn quitting_runs_the_cleanup_and_quit_hooks_a_startup_hook_set() {
    // As magit-ediff.el sets ediff-quit-hook in the control buffer from a
    // startup hook, so ediff's own cleanup does not run.
    let (mut ed, s, dir) = setup();
    file(&dir, "a.txt", "x\n");
    eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.require("ediff");
          globalThis.ran = [];
          e8.addHook("ediff-cleanup-hook", () => ran.push("cleanup"));
          const a = e8.getBufferCreate("left"); e8.withCurrentBuffer(a, () => e8.insert("one\ntwo\n"));
          const b = e8.getBufferCreate("right"); e8.withCurrentBuffer(b, () => e8.insert("one\nTWO\n"));
          e8.funcall("ediff-buffers-internal", a, b, null, [() => {
            ran.push("startup in " + e8.bufferName());
            e8.makeLocalVariable("ediff-quit-hook");
            e8.setVariable("ediff-quit-hook", [() => ran.push("quit, C is " + e8.variable("ediff-buffer-C"))]);
          }], e8.intern("ediff-buffers"));
          return true;
        })()"#,
    );
    ed.press("q y").unwrap();
    assert_eq!(ed.take_error(), None);
    assert_eq!(
        json(&mut ed, &s, "JSON.stringify(ran)"),
        r#"["startup in *Ediff Control Panel*","cleanup","quit, C is null"]"#
    );
    // Its own quit hook replaced ediff-cleanup-mess, so the panel is left.
    assert!(ed.find_buffer("*Ediff Control Panel*").is_some());
}

#[test]
fn ediff_buffers_offers_the_other_visible_buffer() {
    let (mut ed, s, _dir) = setup();
    eval(&mut ed, &s, r#"(() => { for (const [n, t] of [["left", "a\nb\n"], ["right", "a\nB\n"]]) e8.withCurrentBuffer(e8.getBufferCreate(n), () => e8.insert(t)); return 1; })()"#);
    ed.call("switch-to-buffer", vec![Arg::Str("left".into())]).unwrap();
    ed.press("C-x 3").unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("right".into())]).unwrap();
    ed.press("C-x o M-x").unwrap();
    ed.type_text("ediff-buffers\n\nright\n");
    assert_eq!(ed.take_error(), None);
    assert_eq!(json(&mut ed, &s, "JSON.stringify([e8.variable('ediff-buffer-A').name, e8.variable('ediff-buffer-B').name])"), r#"["left","right"]"#);
    assert_eq!(eval(&mut ed, &s, "e8.variable('ediff-number-of-differences')"), "1");
}

#[test]
fn bang_compares_again_after_editing() {
    let (mut ed, s, dir) = setup();
    ediff_files(&mut ed, &dir);
    eval(&mut ed, &s, "e8.withCurrentBuffer('b.txt', () => { e8.gotoChar(e8.pointMax()); e8.insert('seven\\n'); })");
    ed.press("!").unwrap();
    assert_eq!(ed.take_error(), None);
    assert_eq!(eval(&mut ed, &s, "e8.variable('ediff-number-of-differences')"), "3");
    assert_eq!(eval(&mut ed, &s, "e8.withCurrentBuffer('b.txt', () => e8.bufferText(21, 31))"), r#""six\nseven\n""#);
    ed.press("n n n b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
}

#[test]
fn three_files_split_three_ways_and_show_which_agree() {
    let (mut ed, s, dir) = setup();
    let base = file(&dir, "base.txt", "one\ntwo\nthree\nfour\nfive\n");
    let mine = file(&dir, "mine.txt", "one\nTWO\nthree\nfour\nfive\n");
    let theirs = file(&dir, "theirs.txt", "one\ntwo\nthree\nFOUR\nfive\nsix\n");
    ed.call("ediff-files3", vec![Arg::Str(base), Arg::Str(mine), Arg::Str(theirs)]).unwrap();
    assert_eq!(
        layout(&ed),
        vec![
            ("base.txt".into(), 80, 7),
            ("mine.txt".into(), 80, 7),
            ("theirs.txt".into(), 80, 8),
            ("*Ediff Control Panel*".into(), 80, 2)
        ]
    );
    let status = |ed: &mut Editor| json(ed, &s, "JSON.stringify(['base.txt','mine.txt','theirs.txt'].map(b => e8.bufferLocalValue('ediff-diff-status', b)))");
    ed.press("n").unwrap();
    assert_eq!(status(&mut ed), r#"["[=diff(C)] ","","[=diff(A)] "]"#);
    ed.press("a b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "mine.txt"), "one\ntwo\nthree\nfour\nfive\n");
    assert_eq!(status(&mut ed), r#"["[=diff(B)] ","[=diff(C)] ","[=diff(A)] "]"#);
    ed.press("r b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "mine.txt"), "one\nTWO\nthree\nfour\nfive\n");
}

#[test]
fn merging_with_an_ancestor_lays_out_four_windows_and_merges_what_does_not_clash() {
    let (mut ed, s, dir) = setup();
    let mine = file(&dir, "mine.txt", "one\nTWO\nthree\nfour\nfive\n");
    let theirs = file(&dir, "theirs.txt", "one\ntwo\nthree\nFOUR\nfive\nsix\n");
    let base = file(&dir, "base.txt", "one\ntwo\nthree\nfour\nfive\n");
    ed.call("ediff-merge-files-with-ancestor", vec![Arg::Str(mine), Arg::Str(theirs), Arg::Str(base)]).unwrap();
    assert_eq!(
        layout(&ed),
        vec![
            ("mine.txt".into(), 40, 12),
            ("theirs.txt".into(), 40, 12),
            ("*ediff-merge*".into(), 40, 10),
            ("base.txt".into(), 40, 10),
            ("*Ediff Control Panel*".into(), 80, 2)
        ]
    );
    assert_eq!(text_of(&mut ed, &s, "*ediff-merge*"), "one\nTWO\nthree\nFOUR\nfive\nsix\n");
    ed.press("n n").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferLocalValue('ediff-diff-status', '*ediff-merge*')"), r#""[=diff(B) prefer-B] ""#);
    // + combines A's and B's with the ancestor's between delimiters.
    ed.press("+").unwrap();
    assert_eq!(
        text_of(&mut ed, &s, "*ediff-merge*"),
        "one\nTWO\nthree\n<<<<<<< variant A\nfour\n>>>>>>> variant B\nFOUR\n####### Ancestor\nfour\n======= end\nfive\nsix\n"
    );
    ed.press("r").unwrap();
    assert_eq!(ed.echo(), Some("Diff region 2 in buffer C restored"));
    assert_eq!(text_of(&mut ed, &s, "*ediff-merge*"), "one\nTWO\nthree\nFOUR\nfive\nsix\n");
    // A and B are read-only while merging.
    assert_eq!(eval(&mut ed, &s, "e8.withCurrentBuffer('mine.txt', () => e8.bufferReadOnly())"), "true");
}

#[test]
fn a_package_merges_with_an_ancestor_as_magit_resolves_conflicts() {
    // magit-ediff-resolve-all: Git's markers set from a startup hook, and the
    // merge saved from the quit hook into the file given.
    let (mut ed, s, dir) = setup();
    let pkgs = tempfile::tempdir().unwrap();
    std::fs::write(
        pkgs.path().join("resolve.ts"),
        r#"
import { ediffMergeBuffersWithAncestor } from "ediff";
export function resolve(file: string) {
  const make = (name: string, text: string) => { const b = e8.getBufferCreate(name); e8.withCurrentBuffer(b, () => e8.insert(text)); return b; };
  ediffMergeBuffersWithAncestor(
    make("ours", "a\nmine\nc\n"), make("theirs", "a\ntheirs\nc\n"), make("base", "a\nb\nc\n"),
    [() => {
      e8.makeLocalVariable("ediff-combination-pattern");
      e8.setVariable("ediff-combination-pattern", ["<<<<<<< HEAD", e8.intern("A"), "||||||| base", e8.intern("Ancestor"), "=======", e8.intern("B"), ">>>>>>> theirs"]);
      e8.makeLocalVariable("ediff-quit-merge-hook");
      e8.setVariable("ediff-quit-merge-hook", null);
      e8.makeLocalVariable("ediff-quit-hook");
      e8.setVariable("ediff-quit-hook", [() => e8.withCurrentBuffer(e8.variable("ediff-buffer-C") as e8.Buffer, () => e8.call("save-buffer"))]);
    }],
    "ediff-merge-buffers-with-ancestor",
    file,
  );
}
e8.defun("resolve-conflicts", resolve);
"#,
    )
    .unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(pkgs.path().display().to_string())]));
    let merged = dir.path().join("merged.txt");
    eval(&mut ed, &s, &format!("(e8.require('resolve'), e8.funcall('resolve-conflicts', {:?}), true)", merged.display().to_string()));
    assert_eq!(ed.take_error(), None);
    // The merge buffer visits the file given, and is named after it. It
    // was merged before the startup hooks ran, as in Emacs, so with
    // ediff's own markers; + combines again with the package's.
    assert_eq!(text_of(&mut ed, &s, "merged.txt"), "a\n<<<<<<< variant A\nmine\n>>>>>>> variant B\ntheirs\n####### Ancestor\nb\n======= end\nc\n");
    ed.press("n +").unwrap();
    assert_eq!(text_of(&mut ed, &s, "merged.txt"), "a\n<<<<<<< HEAD\nmine\n||||||| base\nb\n=======\ntheirs\n>>>>>>> theirs\nc\n");
    ed.press("q y").unwrap();
    assert_eq!(ed.take_error(), None);
    assert_eq!(std::fs::read_to_string(&merged).unwrap(), "a\n<<<<<<< HEAD\nmine\n||||||| base\nb\n=======\ntheirs\n>>>>>>> theirs\nc\n");
}

#[test]
fn a_two_way_merge_combines_every_difference_to_start_with() {
    let (mut ed, s, dir) = setup();
    let x = file(&dir, "x.txt", "a\nb\nc\nd\n");
    let y = file(&dir, "y.txt", "a\nB\nc\nD\n");
    ed.call("ediff-merge-files", vec![Arg::Str(x), Arg::Str(y)]).unwrap();
    assert_eq!(
        layout(&ed),
        vec![("x.txt".into(), 40, 12), ("y.txt".into(), 40, 12), ("*ediff-merge*".into(), 80, 10), ("*Ediff Control Panel*".into(), 80, 2)]
    );
    assert_eq!(
        text_of(&mut ed, &s, "*ediff-merge*"),
        "a\n<<<<<<< variant A\nb\n>>>>>>> variant B\nB\n======= end\nc\n<<<<<<< variant A\nd\n>>>>>>> variant B\nD\n======= end\n"
    );
    ed.press("n a n b").unwrap();
    assert_eq!(text_of(&mut ed, &s, "*ediff-merge*"), "a\nb\nc\nD\n");
}
