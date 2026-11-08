//! Dired, where the oracle cannot look: faces, hidden details, the trash,
//! the agent, and the listing's columns.

use std::fs;
use std::path::Path;

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(false));
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn sample() -> tempfile::TempDir {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    fs::write(dir.path().join("longer-name.org"), "* two\n").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    dir
}

fn dired(ed: &mut Editor, dir: &Path) {
    ed.call("dired", vec![Arg::Str(format!("{}/", dir.display()))]).unwrap();
}

fn line_of(ed: &Editor, name: &str) -> String {
    text(ed).lines().find(|l| l.ends_with(name)).unwrap_or_else(|| panic!("no line for {name}")).to_string()
}

#[test]
fn lines_line_up_as_ls_writes_them() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    let header = text(&ed).lines().next().unwrap().to_string();
    assert_eq!(header, format!("  {}:", dir.path().display()));
    let a = line_of(&ed, " a.txt");
    let org = line_of(&ed, " longer-name.org");
    assert!(a.starts_with("  -rw"), "{a}");
    // The names start in one column, after sizes right-aligned in theirs.
    assert_eq!(a.find("a.txt"), org.find("longer-name.org"));
    assert_eq!(ed.window_buffer().name, dir.path().file_name().unwrap().to_string_lossy());
    assert_eq!(ed.mode_name(), "Dired by name");
    assert!(ed.window_buffer().read_only);
}

#[test]
fn marks_and_kinds_of_file_have_faces() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("m").unwrap();
    ed.redisplay();
    let face_at = |ed: &Editor, name: &str| {
        let t = text(ed);
        let at = t.find(&format!(" {name}\n")).unwrap() + 1;
        let pos = t[..at].chars().count();
        ed.window_buffer().text_property(pos, "face").and_then(|v| v.as_str().map(str::to_string))
    };
    assert_eq!(face_at(&ed, "a.txt").as_deref(), Some("dired-marked"));
    assert_eq!(face_at(&ed, "sub").as_deref(), Some("dired-directory"));
    ed.press("d").unwrap();
    ed.redisplay();
    assert_eq!(face_at(&ed, "longer-name.org").as_deref(), Some("dired-flagged"));
}

#[test]
fn a_new_listing_shows_its_details() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.redisplay();
    let b = ed.window_buffer();
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    assert!(visible.contains("-rw"), "{visible}");
    // As Emacs 30.2's, less its dired-filename-hide.
    assert_eq!(ed.variable("buffer-invisibility-spec"), Some(Value::List(vec![Value::Bool(true), Value::List(vec![Value::Str("dired".into()), Value::Bool(true)])])));
}

#[test]
fn hiding_details_leaves_the_names() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("(").unwrap();
    ed.redisplay();
    let b = ed.window_buffer();
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    assert!(visible.contains("\n  a.txt\n"), "{visible}");
    ed.press("(").unwrap();
    ed.redisplay();
    let b = ed.window_buffer();
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    assert!(visible.contains("-rw"), "the details are back");
}

#[test]
fn deleting_says_it_trashes() {
    let (mut ed, _scripting) = setup();
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(true));
    let dir = sample();
    dired(&mut ed, dir.path());
    // The question waits: say what it asks, and quit it.
    let asked = std::rc::Rc::new(std::cell::RefCell::new(None));
    let seen = asked.clone();
    ed.set_input_source(move |ed| match ed.prompt().map(str::to_string) {
        Some(prompt) if seen.borrow().is_none() => {
            *seen.borrow_mut() = Some(prompt);
            ed.handle_key(e8_core::Key::parse("C-g").unwrap());
            true
        }
        _ => false,
    });
    ed.press("D").unwrap();
    assert_eq!(asked.borrow().as_deref(), Some("Trash a.txt (yes or no) "));
    assert!(dir.path().join("a.txt").exists());
}

#[test]
fn an_agent_needs_approval_to_delete_from_dired() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.set_agent_acting(true);
    // D and its answer at once: the question waits for the keys typed ahead.
    ed.press("D y e s RET").unwrap();
    assert!(dir.path().join("a.txt").exists(), "refused without approval");
    assert!(ed.permission_requested());
}

#[test]
fn find_file_on_a_directory_lists_it() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    ed.call("find-file", vec![Arg::Str(dir.path().join("sub").display().to_string())]).unwrap();
    assert_eq!(ed.window_buffer().name, "sub");
    assert_eq!(ed.mode_name(), "Dired by name");
    // The listing's directory is where relative names go.
    ed.press("+").unwrap();
    ed.type_text("inner\n");
    assert!(dir.path().join("sub/inner").is_dir());
}

#[test]
fn going_back_to_a_listing_reuses_its_buffer() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    let name = ed.window_buffer().name.clone();
    ed.press("m").unwrap();
    dired(&mut ed, dir.path());
    assert_eq!(ed.window_buffer().name, name);
    assert!(text(&ed).contains("* -rw"), "the mark is still there");
}



fn goto(ed: &mut Editor, dir: &Path, name: &str) {
    ed.call("dired-goto-file", vec![Arg::Str(dir.join(name).display().to_string())]).unwrap();
}

#[test]
fn changing_modes_takes_octal_and_symbolic_modes() {
    use std::os::unix::fs::PermissionsExt;
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    goto(&mut ed, dir.path(), "a.txt");
    ed.press("M 6 0 0 RET").unwrap();
    let mode = |_: &Editor| fs::metadata(dir.path().join("a.txt")).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode(&ed), 0o600);
    assert!(line_of(&ed, " a.txt").starts_with("  -rw-------"), "{}", line_of(&ed, " a.txt"));
    ed.press("M g + r , o = g RET").unwrap();
    assert_eq!(mode(&ed), 0o644);
    ed.press("M u - w RET").unwrap();
    assert_eq!(mode(&ed), 0o444);
}

#[test]
fn touching_sets_the_time_touch_takes() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    goto(&mut ed, dir.path(), "a.txt");
    ed.press("T 2 0 2 0 0 1 0 2 1 2 0 0 RET").unwrap();
    let modified = fs::metadata(dir.path().join("a.txt")).unwrap().modified().unwrap();
    let year = 1970 + modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() / 31_556_952;
    assert_eq!(year, 2020);
    assert!(line_of(&ed, " a.txt").contains("2020"), "{}", line_of(&ed, " a.txt"));
}

#[test]
fn compressing_gzips_and_uncompressing_unpacks() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    goto(&mut ed, dir.path(), "a.txt");
    ed.press("Z").unwrap();
    assert!(dir.path().join("a.txt.gz").exists());
    assert!(!dir.path().join("a.txt").exists());
    line_of(&ed, " a.txt.gz");
    assert_eq!(ed.echo(), Some("Compress or uncompress: 1 file"));
    goto(&mut ed, dir.path(), "a.txt.gz");
    ed.press("Z").unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\n");
    // A directory becomes a .tar.gz beside it.
    fs::write(dir.path().join("sub/x.txt"), "x\n").unwrap();
    goto(&mut ed, dir.path(), "sub");
    ed.press("Z").unwrap();
    assert!(dir.path().join("sub.tar.gz").exists());
    line_of(&ed, " sub.tar.gz");
}

#[test]
fn shell_commands_take_the_files_as_star_and_question_mark_say() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    fs::write(dir.path().join("b.txt"), "two\n").unwrap();
    dired(&mut ed, dir.path());
    // Each file's name at the end, a run for each.
    goto(&mut ed, dir.path(), "a.txt");
    ed.press("m m").unwrap();
    ed.press("! c a t RET").unwrap();
    assert_eq!(ed.echo(), Some("one\ntwo"));
    // * runs it once on them all; ? on each, in its place.
    ed.press("! e c h o SPC * SPC e n d RET").unwrap();
    assert_eq!(ed.echo(), Some("a.txt b.txt end"));
    ed.press("! e c h o SPC x SPC ? SPC y RET").unwrap();
    assert_eq!(ed.echo(), Some("x a.txt y\nx b.txt y"));
}

#[test]
fn omitting_leaves_out_auto_saves_and_compiled_files_until_turned_off() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    fs::write(dir.path().join("#a.txt#"), "").unwrap();
    fs::write(dir.path().join("x.elc"), "").unwrap();
    dired(&mut ed, dir.path());
    ed.press("C-x M-o").unwrap();
    let names = |ed: &Editor| text(ed).lines().skip(1).map(|l| l.rsplit(' ').next().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(names(&ed), ["a.txt", "longer-name.org", "sub"]);
    // Listing again leaves them out again.
    ed.press("g").unwrap();
    assert_eq!(names(&ed), ["a.txt", "longer-name.org", "sub"]);
    ed.press("C-x M-o").unwrap();
    assert_eq!(names(&ed), ["#a.txt#", ".", "..", "a.txt", "longer-name.org", "sub", "x.elc"]);
}

#[test]
fn finding_marked_files_shows_each_in_a_window() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("% m \\ . RET").unwrap();
    ed.press("F").unwrap();
    let mut shown: Vec<String> = ed.window_list().into_iter().map(|w| ed.window_buffer_name(w).unwrap().to_string()).collect();
    shown.sort();
    assert_eq!(shown, ["a.txt", "longer-name.org"]);
}

#[test]
fn searching_marked_files_lists_matches_in_xref() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    ed.press("% m \\ . RET").unwrap();
    ed.press("A t w o RET").unwrap();
    assert_eq!(ed.window_buffer().name, "*xref*");
    assert_eq!(text(&ed), "longer-name.org\n1:* two\n");
}

#[test]
fn wdired_lets_only_names_be_edited() {
    let (mut ed, _scripting) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    goto(&mut ed, dir.path(), "a.txt");
    ed.press("C-x C-q").unwrap();
    assert_eq!(ed.mode_name(), "Editable Dired");
    assert!(!ed.window_buffer().read_only);
    // The details, the newline and the header refuse; the name does not.
    let before = text(&ed);
    assert!(ed.press("C-a x").is_err() || text(&ed) == before);
    assert_eq!(text(&ed), before);
    ed.press("C-e C-d").ok();
    assert_eq!(text(&ed), before);
    ed.press("M-< x").ok();
    assert_eq!(text(&ed), before);
    ed.press("C-s a . t x t RET C-b C-b C-b C-b C-b").unwrap();
    ed.press("b - C-c C-c").unwrap();
    assert!(dir.path().join("b-a.txt").exists());
    assert_eq!(ed.mode_name(), "Dired by name");
    assert!(ed.window_buffer().read_only);
    assert!(text(&ed).contains(" b-a.txt\n"), "{}", text(&ed));
}
