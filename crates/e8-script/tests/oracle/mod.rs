//! What both oracle tests share: the case and golden file formats, and
//! running a case through E8 the way record.el runs it through Emacs.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use e8_core::{Editor, Key, PrefixArg};
use e8_script::Scripting;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct Case {
    pub name: String,
    pub text: String,
    pub keys: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub point: usize,
    /// Modes to turn on before typing the keys.
    #[serde(default)]
    pub modes: Vec<String>,
    /// A command and its arguments to call before the keys, for commands
    /// that read the minibuffer, which batch Emacs reads from stdin.
    #[serde(default)]
    pub call: Vec<String>,
    /// The Emacs `system-type` the case holds on, if only one.
    pub platform: Option<String>,
    /// Whether to compare the windows too: what each shows and its size.
    #[serde(default, skip_serializing_if = "is_false")]
    pub windows: bool,
    /// Answers to the prompts the keys open, in order, each typed and
    /// confirmed with RET.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<String>,
    /// A file name the buffer seems to visit in Emacs, for commands that
    /// need one there; E8's do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visit: Option<String>,
    /// The day Org's agenda takes as today, as YYYY-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub today: Option<String>,
    /// Whether the visited file is the agenda's only file.
    #[serde(default, skip_serializing_if = "is_false")]
    pub agenda_files: bool,
    /// Capture templates, as org-capture-templates lists them, with "FILE"
    /// for the visited file.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capture_templates: Vec<serde_json::Value>,
    /// Files to write into a fresh directory for the case, by name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// A file to visit for real as the case's buffer: one of `files`, or a
    /// new one holding `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub find: Option<String>,
    /// The text the visited file is given on disk when the keys reach <f33>.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk: Option<String>,
    /// Whether to compare the last message.
    #[serde(default, skip_serializing_if = "is_false")]
    pub message: bool,
    /// Variables set in the buffer after the modes are on, as setq-local:
    /// numbers, strings, and true or false for t and nil.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, serde_json::Value>,
    /// Whether editing makes lock files, `create-lockfiles`, off otherwise.
    #[serde(default, skip_serializing_if = "is_false")]
    pub lockfiles: bool,
}

#[derive(Deserialize)]
pub struct Golden {
    pub emacs_version: String,
    /// The Emacs `system-type` the golden file was recorded on.
    pub system_type: String,
    pub cases: Vec<Recorded>,
}

#[derive(Deserialize)]
pub struct Recorded {
    pub name: String,
    pub input: Input,
    #[serde(flatten)]
    pub state: State,
}

#[derive(Deserialize, PartialEq)]
pub struct Input {
    pub text: String,
    pub point: usize,
    pub keys: String,
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub call: Vec<String>,
    pub platform: Option<String>,
    #[serde(default)]
    pub windows: bool,
    #[serde(default)]
    pub answers: Vec<String>,
    #[serde(default)]
    pub visit: Option<String>,
    #[serde(default)]
    pub today: Option<String>,
    #[serde(default)]
    pub agenda_files: bool,
    #[serde(default)]
    pub capture_templates: Vec<serde_json::Value>,
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub find: Option<String>,
    #[serde(default)]
    pub disk: Option<String>,
    #[serde(default)]
    pub message: bool,
    #[serde(default)]
    pub vars: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub lockfiles: bool,
}

impl Input {
    /// What the case asks, as record.el writes it back.
    pub fn of(case: &Case) -> Input {
        Input {
            text: case.text.clone(),
            point: case.point,
            keys: case.keys.clone(),
            modes: case.modes.clone(),
            call: case.call.clone(),
            platform: case.platform.clone(),
            windows: case.windows,
            answers: case.answers.clone(),
            visit: case.visit.clone(),
            today: case.today.clone(),
            agenda_files: case.agenda_files,
            capture_templates: case.capture_templates.clone(),
            files: case.files.clone(),
            find: case.find.clone(),
            disk: case.disk.clone(),
            message: case.message,
            vars: case.vars.clone(),
            lockfiles: case.lockfiles,
        }
    }
}

/// One window, as `record.el` reports it: the buffer it shows, its point,
/// and its total size in columns and lines, mode line and divider included.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct WindowState {
    pub buffer: String,
    pub point: usize,
    pub width: usize,
    pub height: usize,
    pub selected: bool,
}

/// What a case leaves behind, as both editors report it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct State {
    pub text: String,
    /// The text without what is invisible, once fontified.
    pub visible: String,
    pub point: usize,
    pub mark: Option<usize>,
    pub mark_active: bool,
    /// Newest first, as Emacs lists it.
    pub kill_ring: Vec<String>,
    pub modified: bool,
    pub error: Option<String>,
    /// The frame's windows in cyclic order, for cases that ask.
    #[serde(default)]
    pub windows: Option<Vec<WindowState>>,
    /// The files in the case's directory afterwards, for cases with files:
    /// their text, or `latin-1:` and their text for files not in UTF-8.
    #[serde(default)]
    pub files: Option<BTreeMap<String, String>>,
    /// The last message, with the case's directory as DIR, for cases that ask.
    #[serde(default)]
    pub message: Option<String>,
}

/// Writes a case's file: UTF-8, or Latin-1 for text marked `latin-1:`.
fn write_case_file(path: &Path, text: &str) {
    let bytes = match text.strip_prefix("latin-1:") {
        Some(latin) => latin.chars().map(|c| c as u8).collect(),
        None => text.as_bytes().to_vec(),
    };
    std::fs::write(path, bytes).expect("a case's file can be written");
}

/// What a case's directory holds, as record.el lists it: each file's text,
/// and each directory as its name with a slash, then what it holds.
fn listing(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).expect("the case's directory can be read") {
            let entry = entry.expect("a directory entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let relative = path.strip_prefix(root).expect("inside the case's directory").display().to_string();
            // A lock file names the process that made it, so only that it is there compares.
            if name.starts_with(".#") {
                files.insert(relative, "lock".into());
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                files.insert(format!("{relative}/"), String::new());
                walk(root, &path, files);
                continue;
            }
            let bytes = std::fs::read(&path).expect("a case's file can be read");
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(e) => format!("latin-1:{}", e.into_bytes().iter().map(|&b| b as char).collect::<String>()),
            };
            files.insert(relative, text);
        }
    }
    let mut files = BTreeMap::new();
    walk(dir, dir, &mut files);
    files
}

/// A Dired buffer as each line's mark and file name, as record.el compares
/// them, leaving out sizes and dates, with a map from positions in it.
fn dired_normalize(text: &str, dir: Option<&tempfile::TempDir>) -> (String, Box<dyn Fn(usize) -> usize>) {
    let line_re = regex::Regex::new(r"^(.)\s([-dlbcps][-rwxsStT]{9}[@+.]?\s*\d+ .*? (?:[A-Z][a-z]{2} [ \d]\d (?:\d\d:\d\d| \d{4}))) (.*)$").unwrap();
    let mut out = String::new();
    // Each line's start and end, where its name starts, and its start and length in `out`.
    let mut lines: Vec<(usize, usize, Option<usize>, usize, usize)> = Vec::new();
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let len = body.chars().count();
        let name = line_re.captures(body).map(|c| len - c[3].chars().count());
        let shown = match name {
            // A link's target, absolute, is in the case's directory too.
            Some(n) => without_dir(&format!("{}{}", body.chars().take(2.min(n)).collect::<String>(), body.chars().skip(n).collect::<String>()), dir),
            None => without_dir(body, dir),
        };
        let start = out.chars().count();
        let shown_len = shown.chars().count();
        out.push_str(&shown);
        out.push('\n');
        lines.push((at, at + len, name.map(|n| at + n), start, shown_len));
        at += line.chars().count();
    }
    let total = out.chars().count();
    let map = move |pos: usize| {
        lines
            .iter()
            .find(|(bol, eol, ..)| *bol <= pos && pos <= *eol)
            .map(|&(bol, _, name, start, len)| {
                start
                    + match name {
                        None => (pos - bol).min(len),
                        Some(n) if pos >= n => (n - bol).min(2) + (pos - n),
                        Some(_) => (pos - bol).min(2),
                    }
            })
            .unwrap_or(total)
    };
    (out, Box::new(map))
}

/// The answers a case gives its prompts, and what answering them did.
struct Answering {
    /// The case's keys not yet typed, which a command reading a key reads.
    keys: std::collections::VecDeque<Key>,
    answers: std::collections::VecDeque<String>,
    error: Option<String>,
    quit_for_answers: bool,
}

/// Answers the open prompt, or a key read partway through a command, with
/// the case's next answer, as record.el does; with none left, reading the
/// minibuffer is an error, as batch Emacs would read it from standard
/// input. Returns whether there was something to answer.
fn answer_once(ed: &mut Editor, answering: &std::rc::Rc<std::cell::RefCell<Answering>>) -> bool {
    let left = answering.borrow().answers.len();
    // A key read partway through a command, as zap-to-char's character,
    // takes an answer too while there are any, as record.el gives
    // read-char-from-minibuffer one; otherwise the case's next key, as
    // C-q reads it.
    if ed.prompt().is_none() && !(ed.reading_single_key() && left > 0) {
        if !ed.reading_key() {
            return false;
        }
        let Some(key) = answering.borrow_mut().keys.pop_front() else { return false };
        ed.handle_key(key);
        if let Some(e) = ed.take_error() {
            answering.borrow_mut().error.get_or_insert(e.to_string());
        }
        return true;
    }
    let note = |ed: &mut Editor| {
        if let Some(e) = ed.take_error() {
            answering.borrow_mut().error.get_or_insert(e.to_string());
        }
    };
    if ed.prompt().is_none() {
        let answer = answering.borrow_mut().answers.pop_front().expect("checked above");
        ed.type_text(&answer.chars().take(1).collect::<String>());
        note(ed);
        return true;
    }
    let Some(answer) = answering.borrow_mut().answers.pop_front() else {
        {
            let mut a = answering.borrow_mut();
            a.error.get_or_insert("Minibuffer read in batch".into());
            // Batch Emacs errors there, with no Quit.
            a.quit_for_answers = true;
        }
        ed.handle_key(Key::parse("C-g").expect("C-g parses"));
        ed.take_error();
        return true;
    };
    // A question read by a key takes the answer's first character, as
    // record.el's read-char does; others take it typed and RET.
    if ed.prompt_reads_char() {
        ed.type_text(&answer.chars().take(1).collect::<String>());
    } else {
        // record.el's answers replace what a prompt starts with; a
        // relative file name stays in the directory it shows.
        let input = ed.minibuffer_input();
        if !input.is_empty() && !input.ends_with('/') && input.contains('/') {
            let dir = &input[..input.rfind('/').map_or(0, |i| i + 1)];
            let absolute = answer.starts_with('/') || answer.starts_with('~');
            ed.set_minibuffer_input(if absolute { "" } else { dir });
        } else if !input.is_empty() && !input.contains('/') {
            ed.set_minibuffer_input("");
        }
        ed.type_text(&answer);
        ed.handle_key(Key::parse("RET").expect("RET parses"));
    }
    note(ed);
    true
}

/// Text with the case's directory written as DIR, as record.el writes it.
fn without_dir(text: &str, dir: Option<&tempfile::TempDir>) -> String {
    match dir {
        Some(dir) => text
            .replace(&dir.path().display().to_string(), "DIR")
            .replace(&e8_core::abbreviate_path(dir.path()), "DIR"),
        None => text.to_string(),
    }
}

/// Whether an echo only shows a prefix key typed so far, such as `C-x-`,
/// which Emacs does not log as a message.
fn is_prefix_echo(echo: &str) -> bool {
    echo.strip_suffix('-').is_some_and(|keys| Key::parse_seq(keys).is_some())
}

/// This platform as Emacs's `system-type` names it.
pub fn system_type() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows-nt"
    } else {
        "gnu/linux"
    }
}

pub fn oracle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs")
}

/// Runs a case through E8 the way record.el runs it through Emacs.
pub fn run(case: &Case) -> State {
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).expect("scripting starts");
    // As in Emacs, deleting deletes, which also keeps cases out of the trash.
    ed.set_variable("delete-by-moving-to-trash", e8_core::Value::Bool(false));
    // Lock files only where a case asks for them, as record.el has it.
    ed.set_variable("create-lockfiles", e8_core::Value::Bool(case.lockfiles));
    // Batch Emacs's frame: 80 columns, and 24 lines above the echo area.
    ed.set_frame_size(80, 24);
    // A directory of the case's own, outside the temporary one, where
    // backups are made: target/tmp, as record.el uses target/oracle-files.
    let dir = (!case.files.is_empty() || case.find.is_some())
        .then(|| tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("a directory for the case's files"));
    if let Some(dir) = &dir {
        // Auto-save files last, so they are newer than what they save, as
        // record.el writes them.
        let mut files: Vec<_> = case.files.iter().collect();
        files.sort_by_key(|(name, _)| (name.starts_with('#'), name.as_str()));
        for (name, text) in files {
            let path = dir.path().join(name);
            if name.ends_with('/') {
                std::fs::create_dir_all(&path).expect("a case's directory can be made");
                continue;
            }
            std::fs::create_dir_all(path.parent().expect("inside the case's directory")).expect("a case's directory can be made");
            write_case_file(&path, text);
        }
    }
    let found = case.find.as_ref().map(|name| {
        let dir = dir.as_ref().expect("find makes a directory");
        let path = dir.path().join(name);
        if !case.files.contains_key(name) {
            write_case_file(&path, &case.text);
        }
        ed.call("find-file", vec![e8_core::Arg::Str(path.display().to_string())])
            .unwrap_or_else(|e| panic!("{}: visiting {name}: {e}", case.name));
        path
    });
    let b = ed.window_buffer_mut();
    if found.is_some() {
        b.set_point(case.point);
    } else {
        // record.el's buffer, which some messages name.
        b.name = "*e8-oracle*".into();
        b.set_text(&case.text);
        b.set_point(case.point);
    }
    // As record.el has it: the buffer visits a file in the temporary
    // directory, which may be the agenda's, and the agenda's day is fixed.
    let file = case.visit.as_ref().filter(|_| found.is_none()).map(|name| std::env::temp_dir().join(name));
    if let Some(file) = &file {
        std::fs::write(file, &case.text).expect("the visited file can be written");
        b.path = Some(file.clone());
    }
    // Emacs's own buffers, which buffer lists in record.el's Emacs have
    // after the case's: the message log, then *scratch*.
    ed.get_buffer_create("*Messages*");
    ed.get_buffer_create("*scratch*");
    // Last in the buffer list, in this order, as record.el buries them.
    let _ = ed.bury_buffer_internal("*Messages*");
    let _ = ed.bury_buffer_internal("*scratch*");
    if case.agenda_files {
        let file = file.as_ref().expect("agenda_files needs visit");
        ed.set_variable("org-agenda-files", e8_core::Value::List(vec![e8_core::Value::Str(file.display().to_string())]));
    }
    if !case.capture_templates.is_empty() {
        let file = file.as_ref().map(|f| f.display().to_string()).unwrap_or_default();
        let value = |v: &serde_json::Value| -> e8_core::Value {
            fn convert(v: &serde_json::Value, file: &str) -> e8_core::Value {
                match v {
                    serde_json::Value::String(s) if s == "FILE" => e8_core::Value::Str(file.to_string()),
                    serde_json::Value::String(s) => e8_core::Value::Str(s.clone()),
                    serde_json::Value::Array(items) => e8_core::Value::List(items.iter().map(|i| convert(i, file)).collect()),
                    _ => e8_core::Value::Null,
                }
            }
            convert(v, &file)
        };
        ed.set_variable("org-capture-templates", e8_core::Value::List(case.capture_templates.iter().map(value).collect()));
    }
    if let Some(day) = &case.today {
        ed.set_variable("e8--today", e8_core::Value::Str(day.clone()));
    }
    for mode in &case.modes {
        ed.call_with_prefix(mode, Vec::new(), Some(PrefixArg::Number(1)))
            .unwrap_or_else(|e| panic!("{}: turning on {mode}: {e}", case.name));
    }
    for (name, value) in &case.vars {
        let value = match value {
            serde_json::Value::Bool(b) => e8_core::Value::Bool(*b),
            serde_json::Value::Number(n) => e8_core::Value::Number(n.as_f64().expect("a number")),
            serde_json::Value::String(s) => e8_core::Value::Str(s.clone()),
            _ => panic!("{}: {name} must be a number, string or boolean", case.name),
        };
        ed.make_local_variable(name);
        ed.set_variable(name, value);
    }
    // Fontified as redisplay would before the keys; record.el does the same.
    ed.font_lock_ensure().unwrap_or_else(|e| panic!("{}: fontifying: {e}", case.name));
    // A case may be only a call, with no keys after it.
    let keys = if case.keys.is_empty() {
        Vec::new()
    } else {
        Key::parse_seq(&case.keys).unwrap_or_else(|| panic!("{}: keys {:?} are not valid Emacs notation", case.name, case.keys))
    };
    // The messages shown, in order, as *Messages* logs them, with how many
    // times each was shown in a row.
    let mut log: Vec<(String, usize)> = Vec::new();
    // Prompts take the case's answers in order, as record.el gives them:
    // those for a command's arguments after each key, and those a command
    // opens while it runs as its input, as batch Emacs reads them.
    let answering = std::rc::Rc::new(std::cell::RefCell::new(Answering {
        keys: keys.into_iter().collect(),
        answers: case.answers.iter().cloned().collect(),
        error: None,
        quit_for_answers: false,
    }));
    let source = answering.clone();
    ed.set_input_source(move |ed| answer_once(ed, &source));
    let answer_prompts = |ed: &mut Editor| while answer_once(ed, &answering) {};
    // The messages from here on, as record.el starts each case's.
    ed.clear_messages();
    if let Some((name, args)) = case.call.split_first() {
        let args = args.iter().map(|a| e8_core::Arg::Str(a.clone())).collect();
        if let Err(e) = ed.call(name, args) {
            answering.borrow_mut().error = Some(e.to_string());
        }
        answer_prompts(&mut ed);
    }
    // <f33> changes the visited file on disk, as another program would: a
    // command, as in record.el, so it takes a prefix argument and becomes
    // the last command.
    if let (Some(path), Some(disk)) = (found.clone(), case.disk.clone()) {
        ed.define_command(e8_core::Command::new("e8-oracle--change-disk", "Change the visited file on disk.", move |_, _| {
            write_case_file(&path, &disk);
            let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
            std::fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(later))?;
            Ok(())
        }));
        let map = ed.global_map();
        ed.keymaps_mut().bind(map, &[Key::parse("<f33>").expect("<f33> parses")], e8_core::Binding::Command("e8-oracle--change-disk".into()));
    }
    loop {
        let Some(key) = answering.borrow_mut().keys.pop_front() else { break };
        ed.handle_key(key);
        if let Some(e) = ed.take_error() {
            answering.borrow_mut().error.get_or_insert(e.to_string());
        }
        answer_prompts(&mut ed);
    }
    // Batch Emacs logs no command's error, and quitting for want of answers
    // is an error there; a message shown again straight after itself, with
    // only errors between, is counted, as "Mark set [2 times]".
    for entry in ed.message_log() {
        if entry.error || (answering.borrow().quit_for_answers && entry.text == "Quit") {
            continue;
        }
        match log.last_mut() {
            Some((text, count)) if *text == entry.text => *count += entry.count,
            _ => log.push((entry.text.clone(), entry.count)),
        }
    }
    // record.el reads *Messages* a line at a time, so a message of several
    // lines counts as its last.
    let message = log.last().map(|(m, n)| {
        let m = m.split('\n').rfind(|l| !l.is_empty()).unwrap_or_default();
        if *n == 1 { m.to_string() } else { format!("{m} [{n} times]") }
    });
    ed.font_lock_ensure().unwrap_or_else(|e| panic!("{}: fontifying: {e}", case.name));
    let windows = case.windows.then(|| {
        let sizes = ed.window_total_sizes();
        ed.windows()
            .iter()
            .map(|w| {
                let (width, height) = sizes.iter().find(|s| s.0 == w.id).map_or((0, 0), |s| (s.1, s.2));
                WindowState { buffer: w.buffer.name.clone(), point: w.point, width, height, selected: w.selected }
            })
            .collect()
    });
    let b = ed.window_buffer();
    let visible = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    let dired = ed.mode_name_in(b).starts_with("Dired").then(|| dired_normalize(&b.slice(0..b.len()), dir.as_ref()));
    let (text, visible, point, mark) = match &dired {
        Some((text, map)) => (text.clone(), text.clone(), map(b.point()), b.mark().map(map)),
        None => (b.slice(0..b.len()), visible, b.point(), b.mark()),
    };
    State {
        text,
        visible,
        point,
        mark,
        mark_active: b.is_mark_active(),
        kill_ring: ed.kill_ring().iter().rev().map(|k| without_dir(k, dir.as_ref())).collect(),
        modified: b.is_modified(),
        windows,
        files: dir.as_ref().map(|d| listing(d.path())),
        message: message.filter(|_| case.message).map(|m| without_dir(&m, dir.as_ref())),
        error: answering.borrow().error.clone().map(|e| without_dir(&e, dir.as_ref())),
    }
}

/// The fields where E8 differs from Emacs, one per line.
pub fn differences(emacs: &State, e8: &State) -> String {
    let mut out = Vec::new();
    macro_rules! compare {
        ($($field:ident),*) => {$(
            if emacs.$field != e8.$field {
                out.push(format!(
                    "    {}: Emacs {:?}, E8 {:?}",
                    stringify!($field), emacs.$field, e8.$field
                ));
            }
        )*};
    }
    // *Messages* logs different messages in each, so a case that ends
    // there compares only which windows show it, not what it holds.
    let in_messages = |s: &State| s.windows.as_ref().is_some_and(|ws| ws.iter().any(|w| w.selected && w.buffer == "*Messages*"));
    if in_messages(emacs) && in_messages(e8) {
        compare!(kill_ring, error);
    } else {
        compare!(text, visible, point, mark, mark_active, kill_ring, modified, error);
    }
    let without_messages_points = |s: &State| {
        s.windows.clone().map(|ws| ws.into_iter().map(|w| WindowState { point: if w.buffer == "*Messages*" { 0 } else { w.point }, ..w }).collect::<Vec<_>>())
    };
    if emacs.windows.is_some() && without_messages_points(emacs) != without_messages_points(e8) {
        out.push(format!("    windows: Emacs {:?}, E8 {:?}", emacs.windows, e8.windows));
    }
    if emacs.files != e8.files {
        out.push(format!("    files: Emacs {:?}, E8 {:?}", emacs.files, e8.files));
    }
    if emacs.message != e8.message {
        out.push(format!("    message: Emacs {:?}, E8 {:?}", emacs.message, e8.message));
    }
    out.join("\n")
}


fn is_false(b: &bool) -> bool {
    !b
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}
