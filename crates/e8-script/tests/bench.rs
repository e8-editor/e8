//! A benchmark of large files, run by hand:
//!
//! ```text
//! cargo test --release -p e8-script --test bench -- --ignored --nocapture
//! ```
//!
//! It writes a large Org file and a large text file, opens them as a user
//! would, and times keys as the front ends see them: each key, then the
//! redisplay and the rows a window draws. `E8_BENCH_ORG_LINES` and
//! `E8_BENCH_TEXT_MB` set the sizes (50,000 lines and 100 MB by default).

use std::path::Path;
use std::time::{Duration, Instant};

use e8_core::Editor;
use e8_script::Scripting;

const ROWS: usize = 50;
const COLS: usize = 120;

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// One screenful drawn as a front end draws it.
fn frame(ed: &mut Editor) {
    // A pause after the key, as typing has, so idle timers such as Show
    // Paren mode's run and count.
    ed.advance_clock(std::time::Duration::from_millis(200));
    ed.redisplay();
    let w = ed.selected_window();
    std::hint::black_box(ed.rows_of_window(w, ROWS + 1, true));
}

struct Bench {
    ed: Editor,
    _scripting: Scripting,
    results: Vec<(String, Duration, usize)>,
}

impl Bench {
    fn new() -> Bench {
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        let w = ed.selected_window();
        ed.set_window_size(w, COLS, ROWS);
        Bench { ed, _scripting: scripting, results: Vec::new() }
    }

    /// Times `f` run `n` times, each followed by a frame.
    fn time(&mut self, name: &str, n: usize, mut f: impl FnMut(&mut Editor)) {
        let start = Instant::now();
        for _ in 0..n {
            f(&mut self.ed);
            frame(&mut self.ed);
        }
        let elapsed = start.elapsed();
        if let Some(e) = self.ed.take_error() {
            println!("  ({name}: {e})");
        }
        self.results.push((name.to_string(), elapsed, n));
    }

    fn keys(&mut self, name: &str, n: usize, keys: &str) {
        let keys = keys.to_string();
        self.time(name, n, |ed| {
            ed.press(&keys).ok();
        });
    }

    fn goto_line(&mut self, line: usize) {
        let b = self.ed.window_buffer_mut();
        let pos = b.line_start(line.min(b.line_count() - 1));
        b.set_point(pos);
        frame(&mut self.ed);
    }

    fn report(&self, title: &str) {
        println!("\n{title}");
        for (name, elapsed, n) in &self.results {
            let each = elapsed.as_secs_f64() * 1000.0 / *n as f64;
            println!("  {name:<44} {each:>10.2} ms each  ({n}x, {:.0} ms)", elapsed.as_secs_f64() * 1000.0);
        }
    }
}

/// Org text with the things Org's commands look at: headings at three
/// levels with states, tags, planning and property drawers, lists with
/// checkboxes, a table, a source block, links and emphasis.
fn org_text(lines: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    while out.lines().count() < lines {
        n += 1;
        out.push_str(&format!(
            "* TODO Project {n} [1/2] :work:\n\
             SCHEDULED: <2026-10-28 Wed>\n\
             :PROPERTIES:\n\
             :ID: project-{n}\n\
             :END:\n\
             Some paragraph text about project {n}, with *bold*, /italics/ and a [[https://example.com][link]].\n\
             ** Notes {n}\n\
             - [ ] item one\n\
             - [X] item two\n\
             \x20 - nested item\n\
             | name | hours |\n\
             |------+-------|\n\
             | mon  |     3 |\n\
             *** DONE Step {n}\n\
             #+begin_src rust\n\
             fn main() {{}}\n\
             #+end_src\n\
             \n"
        ));
    }
    out
}

fn text(mb: usize) -> String {
    let line = "The quick brown fox jumps over the lazy dog, and then it does it all again for a while.\n";
    let mut out = String::with_capacity(mb * 1024 * 1024 + 100);
    while out.len() < mb * 1024 * 1024 {
        out.push_str(line);
    }
    out.push_str("needle at the very end\n");
    out
}

fn open(b: &mut Bench, path: &Path) {
    let path = path.to_string_lossy().to_string();
    b.time("find-file and its major mode", 1, |ed| {
        ed.call("find-file", vec![e8_core::Arg::Str(path.clone())]).unwrap();
    });
}

#[test]
#[ignore]
fn large_org_file() {
    let lines = env_usize("E8_BENCH_ORG_LINES", 50_000);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    std::fs::write(&path, org_text(lines)).unwrap();
    let mut b = Bench::new();
    open(&mut b, &path);
    b.keys("C-v (scroll a screen down)", 20, "C-v");
    b.keys("M-> (end of buffer)", 1, "M->");
    b.keys("M-< (start of buffer)", 1, "M-<");
    let middle = b.ed.window_buffer().line_count() / 2;
    // A heading near the middle.
    let heading = (middle..middle + 40)
        .find(|&l| b.ed.window_buffer().line_text(l).starts_with("* TODO"))
        .unwrap();
    b.goto_line(heading + 5);
    b.ed.press("C-e").unwrap();
    b.keys("typing in a paragraph", 20, "x");
    b.keys("DEL", 20, "DEL");
    b.keys("RET in a paragraph", 5, "RET");
    b.ed.call("electric-pair-mode", vec![]).unwrap();
    b.keys("( and ) with electric-pair and show-paren", 10, "( )");
    b.ed.call_with_prefix("electric-pair-mode", vec![], Some(e8_core::PrefixArg::Number(-1))).unwrap();
    b.keys("C-n (next line)", 20, "C-n");
    b.goto_line(heading);
    b.keys("TAB on a heading (cycle)", 3, "TAB");
    b.keys("C-c C-t on a heading (TODO state)", 2, "C-c C-t");
    b.goto_line(heading + 7);
    b.ed.press("C-e").unwrap();
    b.keys("C-c C-c on a checkbox", 2, "C-c C-c");
    b.keys("M-RET on an item", 1, "M-RET");
    b.keys("C-/ (undo)", 1, "C-/");
    b.goto_line(heading + 6);
    b.keys("M-<down> on a heading (move subtree)", 2, "M-<down>");
    b.goto_line(heading + 11);
    b.keys("TAB in a table (next field)", 3, "TAB");
    b.goto_line(0);
    b.keys("S-TAB (cycle the whole buffer)", 3, "S-<tab>");
    b.goto_line(0);
    b.time("C-s for a word near the end", 1, |ed| {
        ed.press("C-s").ok();
        ed.type_text(&format!("Project {}", lines / 18));
        ed.press("RET").ok();
    });
    b.report(&format!("Org file of {} lines", b.ed.window_buffer().line_count()));
}

#[test]
#[ignore]
fn large_text_file() {
    let mb = env_usize("E8_BENCH_TEXT_MB", 100);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    std::fs::write(&path, text(mb)).unwrap();
    let mut b = Bench::new();
    open(&mut b, &path);
    b.keys("C-v (scroll a screen down)", 20, "C-v");
    b.keys("M-> (end of buffer)", 1, "M->");
    b.keys("M-< (start of buffer)", 1, "M-<");
    let middle = b.ed.window_buffer().line_count() / 2;
    b.goto_line(middle);
    b.keys("typing in the middle", 20, "x");
    b.keys("RET in the middle", 5, "RET");
    b.ed.call("electric-pair-mode", vec![]).unwrap();
    b.keys("( and ) with electric-pair and show-paren", 5, "( )");
    b.ed.call_with_prefix("electric-pair-mode", vec![], Some(e8_core::PrefixArg::Number(-1))).unwrap();
    b.keys("C-k (kill line)", 5, "C-k");
    b.keys("C-/ (undo)", 5, "C-/");
    b.goto_line(0);
    b.time("C-s for a word at the end", 1, |ed| {
        ed.press("C-s").ok();
        ed.type_text("needle");
        ed.press("RET").ok();
    });
    b.report(&format!("Text file of {mb} MB, {} lines", b.ed.window_buffer().line_count()));
}

/// Metrics as the GUI's fonts give them: a monospace default font 8.4
/// points wide with 18-point lines, and proportional letters of a few
/// widths, each scaled with the face's height.
struct GuiLike;

impl e8_core::layout::TextMetrics for GuiLike {
    fn advance(&self, font: &e8_core::layout::FontSpec, c: char) -> f32 {
        let base = if !font.proportional() {
            8.4
        } else {
            match c {
                'i' | 'l' | 'j' | '.' | ',' | ' ' => 3.5,
                'm' | 'w' | 'M' | 'W' => 11.0,
                _ => 7.5,
            }
        };
        base * font.scale
    }

    fn line_height(&self, font: &e8_core::layout::FontSpec) -> f32 {
        18.0 * font.scale
    }

    fn char_width(&self) -> f32 {
        8.4
    }

    fn char_height(&self) -> f32 {
        18.0
    }
}

/// A screenful drawn as the GUI draws it: the rows it draws, each glyph
/// measured and each row's height.
fn gui_frame(ed: &mut Editor) {
    ed.advance_clock(std::time::Duration::from_millis(200));
    ed.redisplay();
    let w = ed.selected_window();
    let b = ed.window_buffer();
    let tab_width = ed.tab_width_in(b);
    for row in ed.rows_to_draw(w, true) {
        let glyphs = e8_core::display::row_glyphs(&row, tab_width);
        std::hint::black_box(ed.glyph_columns(&row, &glyphs, tab_width));
        std::hint::black_box(ed.row_height(b, &row));
    }
}

#[test]
#[ignore]
fn gui_layout() {
    let lines = env_usize("E8_BENCH_ORG_LINES", 50_000);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    std::fs::write(&path, org_text(lines)).unwrap();
    for (title, gui, setup) in [
        ("cells, as a terminal", false, ""),
        ("plain", true, ""),
        ("text-scale +2", true, "text-scale-adjust"),
        ("variable-pitch-mode", true, "variable-pitch-mode"),
        ("cells, as a terminal, again", false, ""),
    ] {
        let mut ed = Editor::new();
        let _scripting = Scripting::new(&mut ed).unwrap();
        if gui {
            ed.set_text_metrics(std::sync::Arc::new(GuiLike));
        }
        let w = ed.selected_window();
        ed.set_window_size(w, COLS, ROWS);
        ed.call("find-file", vec![e8_core::Arg::Str(path.to_string_lossy().to_string())]).unwrap();
        if setup == "text-scale-adjust" {
            ed.press("C-x C-+ C-x C-+").unwrap();
        } else if !setup.is_empty() {
            ed.call(setup, vec![]).unwrap();
        }
        let middle = ed.window_buffer().line_count() / 2;
        let pos = ed.window_buffer().line_start(middle);
        ed.window_buffer_mut().set_point(pos);
        gui_frame(&mut ed);
        let mut results = Vec::new();
        for (name, n, keys) in [("C-v", 20, "C-v"), ("C-n", 20, "C-n"), ("typing", 20, "x"), ("RET", 5, "RET")] {
            let start = Instant::now();
            for _ in 0..n {
                ed.press(keys).ok();
                gui_frame(&mut ed);
            }
            results.push((name, start.elapsed().as_secs_f64() * 1000.0 / n as f64));
        }
        let line: Vec<String> = results.iter().map(|(n, ms)| format!("{n} {ms:.2} ms")).collect();
        println!("GUI layout, Org file of {lines} lines, {title}: {}", line.join(", "));
    }
}

/// Repeats one key in the Org file for a while, for a sampling profiler to
/// attach to (`sample`, Instruments, `perf`), as docs/multithreading.md's
/// step 0 profiles the slow keys:
///
/// ```text
/// E8_PROFILE_KEY='S-<tab>' cargo test --release -p e8-script --test bench profile_key -- --ignored --nocapture
/// ```
///
/// `E8_PROFILE_SECONDS` sets how long (20 by default), `E8_PROFILE_SETUP`
/// a command to run first (such as `variable-pitch-mode`, which also gives
/// the GUI's metrics), `E8_PROFILE_MODE` a mode to turn on, `E8_PROFILE_FILE=text`
/// the 100 MB text file instead, and `E8_PROFILE_AT` where point starts: `middle`,
/// `heading` (a heading near the middle), or `start`. The key `find-file`
/// visits the file again each time instead. `E8_PROFILE_EVAL` is an
/// expression to print the value of at the end, such as a count a package
/// kept while it was being measured.
#[test]
#[ignore]
fn profile_key() {
    let key = std::env::var("E8_PROFILE_KEY").unwrap_or_else(|_| "S-<tab>".into());
    let seconds = env_usize("E8_PROFILE_SECONDS", 20) as u64;
    let setup = std::env::var("E8_PROFILE_SETUP").unwrap_or_default();
    let at = std::env::var("E8_PROFILE_AT").unwrap_or_else(|_| "start".into());
    let lines = env_usize("E8_BENCH_ORG_LINES", 50_000);
    let dir = tempfile::tempdir().unwrap();
    // E8_PROFILE_FILE=text profiles the 100 MB text file instead.
    let path = if std::env::var("E8_PROFILE_FILE").as_deref() == Ok("text") {
        let path = dir.path().join("big.txt");
        std::fs::write(&path, text(env_usize("E8_BENCH_TEXT_MB", 100))).unwrap();
        path
    } else {
        let path = dir.path().join("big.org");
        std::fs::write(&path, org_text(lines)).unwrap();
        path
    };
    let path = path.to_string_lossy().to_string();
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).unwrap();
    if !setup.is_empty() {
        ed.set_text_metrics(std::sync::Arc::new(GuiLike));
    }
    let w = ed.selected_window();
    ed.set_window_size(w, COLS, ROWS);
    ed.call("find-file", vec![e8_core::Arg::Str(path.clone())]).unwrap();
    if !setup.is_empty() {
        ed.call(&setup, vec![]).unwrap();
    }
    // E8_PROFILE_MODE turns on a mode first, with the terminal's metrics.
    if let Ok(mode) = std::env::var("E8_PROFILE_MODE") {
        ed.call(&mode, vec![]).unwrap();
    }
    let middle = ed.window_buffer().line_count() / 2;
    let line = match at.as_str() {
        "middle" => middle,
        "heading" => (middle..middle + 40).find(|&l| ed.window_buffer().line_text(l).starts_with("* TODO")).unwrap(),
        _ => 0,
    };
    let pos = ed.window_buffer().line_start(line);
    ed.window_buffer_mut().set_point(pos);
    println!("profiling {key} in pid {}", std::process::id());
    let until = Instant::now() + Duration::from_secs(seconds);
    let mut n = 0;
    while Instant::now() < until {
        if key == "find-file" {
            let name = ed.window_buffer().name.clone();
            ed.kill_buffer_unsaved(&name).ok();
            ed.call("find-file", vec![e8_core::Arg::Str(path.clone())]).unwrap();
        } else {
            ed.press(&key).ok();
            // Back where it started, so each key does the same work.
            if key == "C-c C-t" || key == "RET" {
                ed.press("C-/").ok();
            }
        }
        if !setup.is_empty() { gui_frame(&mut ed) } else { frame(&mut ed) }
        n += 1;
    }
    println!("{key}: {n} times, {:.2} ms each", seconds as f64 * 1000.0 / n as f64);
    if let Ok(expr) = std::env::var("E8_PROFILE_EVAL") {
        println!("{expr}: {:?}", _scripting.eval_expression(&mut ed, &expr));
    }
}

/// How much memory an editor with its packages takes: the process's
/// resident size after one editor, and what each of four more adds, each
/// with an engine of its own (an isolate on V8, a runtime on QuickJS).
#[test]
#[ignore]
fn memory() {
    let resident_mb = || {
        let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap() / 1024.0
    };
    let before = resident_mb();
    let mut editors = Vec::new();
    let mut open = || {
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        editors.push((ed, scripting));
    };
    open();
    let one = resident_mb();
    for _ in 0..4 {
        open();
    }
    let five = resident_mb();
    println!(
        "memory: {before:.0} MB before, {:.0} MB for the first editor, {:.0} MB for each more",
        one - before,
        (five - one) / 4.0
    );
    // V8 enters each isolate as it is made and wants them left newest
    // first, so the editors go in the reverse of the order they came.
    while let Some(editor) = editors.pop() {
        drop(editor);
    }
}

/// How long a new editor takes to load its packages, as at startup.
#[test]
#[ignore]
fn startup() {
    let mut times = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let mut ed = Editor::new();
        let _scripting = Scripting::new(&mut ed).unwrap();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!("startup: {:.1} ms (median of 5; fastest {:.1})", times[2], times[0]);
}

/// From a key to its frame description, which front ends draw from
/// (docs/multithreading.md, step 2), against a key and the editor calls
/// the GUI made to draw before: rows, glyph columns and row heights.
#[test]
#[ignore]
fn key_to_frame() {
    let lines = env_usize("E8_BENCH_ORG_LINES", 50_000);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    std::fs::write(&path, org_text(lines)).unwrap();
    for (title, gui) in [("cells", false), ("GUI metrics", true)] {
        let mut line = Vec::new();
        // Each in an editor of its own, opened the same way, so each moves
        // through the same part of the file.
        for (kind, describe) in [("drawing calls", false), ("description", true)] {
            let mut ed = Editor::new();
            let _scripting = Scripting::new(&mut ed).unwrap();
            if gui {
                ed.set_text_metrics(std::sync::Arc::new(GuiLike));
            }
            let w = ed.selected_window();
            ed.set_window_size(w, COLS, ROWS);
            ed.call("find-file", vec![e8_core::Arg::Str(path.to_string_lossy().to_string())]).unwrap();
            let middle = ed.window_buffer().line_count() / 2;
            let pos = ed.window_buffer().line_start(middle);
            ed.window_buffer_mut().set_point(pos);
            for (name, n, keys) in [("C-v", 20, "C-v"), ("C-n", 20, "C-n"), ("typing", 20, "x")] {
                let start = Instant::now();
                for _ in 0..n {
                    ed.press(keys).ok();
                    if describe {
                        ed.advance_clock(Duration::from_millis(200));
                        ed.redisplay();
                        std::hint::black_box(ed.describe_frame(ed.selected_frame(), 2.0));
                    } else {
                        gui_frame(&mut ed);
                    }
                }
                line.push(format!("{kind} {name} {:.2} ms", start.elapsed().as_secs_f64() * 1000.0 / n as f64));
            }
        }
        println!("key to frame, Org file of {lines} lines, {title}: {}", line.join(", "));
    }
}
