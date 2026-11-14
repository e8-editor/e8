//! The C core's primitives E8 had under other names or not at all, by
//! Emacs's own names (ADR 0090): editfns.c's characters, `format` and
//! `format-message`; buffer.c's modified flag, current buffer and buffer
//! by file; window.c's body and text sizes and a frame's selected window;
//! character.c's characters and strings; keymap.c's key descriptions;
//! undo.c's boundary, fileio.c's temporary names and process.c's buffer.

use crate::*;
use crate::natives::{Opt, Rest, Win, natives};

fn wrong(predicate: &str, value: &EditorValue) -> Error {
    e8_core::xfaces::wrong_type(predicate, value)
}

/// A character from a number, as CHECK_CHARACTER.
fn character(value: &EditorValue) -> Result<char> {
    match value {
        EditorValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= 4194303.0 => {
            let n = *n as u32;
            Ok(if n >= 0x3FFF80 { e8_core::coding::raw_byte_char((n - 0x3FFF00) as u8) } else { char::from_u32(n).unwrap_or('\u{FFFD}') })
        }
        other => Err(wrong("characterp", other)),
    }
}

fn text(value: &EditorValue) -> Result<String> {
    match value {
        EditorValue::Str(s) => Ok(s.clone()),
        EditorValue::Text(t) => Ok(t.string.clone()),
        other => Err(wrong("stringp", other)),
    }
}

/// A key from an event, as Lisp writes one: a character with its modifier
/// bits, a symbol naming a function key, or a key's description.
fn key_of_event(event: &EditorValue) -> Option<e8_core::Key> {
    use e8_core::Key;
    match event {
        EditorValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 => {
            let n = *n as u32;
            let (meta, ctrl, shift) = (n & (1 << 27) != 0, n & (1 << 26) != 0, n & (1 << 25) != 0);
            let base = n & 0x3FFFFF;
            let mut key = match base {
                0 => Key::parse("C-@")?,
                9 => Key::parse("TAB")?,
                13 => Key::parse("RET")?,
                27 => Key::parse("ESC")?,
                32 => Key::parse("SPC")?,
                127 => Key::parse("DEL")?,
                1..=31 => Key::char(char::from_u32(base + 96)?).ctrl(),
                _ => Key::char(char::from_u32(base)?),
            };
            if meta {
                key = key.meta();
            }
            if ctrl {
                key = key.ctrl();
            }
            if shift {
                key = key.shift();
            }
            Some(key)
        }
        EditorValue::Symbol(s) => Key::parse(s).or_else(|| Key::parse(&format!("<{s}>"))),
        EditorValue::Str(s) => Key::parse(s),
        _ => None,
    }
}

/// The keys of a key sequence: a list of events, or a string — E8's
/// description of keys where it reads as one, else Lisp's string of
/// characters.
fn keys_of(value: &EditorValue) -> Result<Vec<e8_core::Key>> {
    match value {
        EditorValue::Null => Ok(Vec::new()),
        EditorValue::List(items) => items.iter().map(|e| key_of_event(e).ok_or_else(|| wrong("eventp", e))).collect(),
        EditorValue::Str(s) => Ok(e8_core::Key::parse_seq(s).unwrap_or_else(|| s.chars().filter_map(|c| key_of_event(&EditorValue::Number(f64::from(c as u32)))).collect())),
        other => Err(wrong("arrayp", other)),
    }
}

fn buffer_index(ed: &Editor, buffer: Option<EditorValue>) -> Result<usize> {
    match buffer {
        None | Some(EditorValue::Null) => Ok(ed.buffers().iter().position(|b| b.id() == ed.buffer().id()).unwrap_or(0)),
        Some(EditorValue::Buffer(id)) => ed.buffer_with_id(id).ok_or_else(|| Error::new("Selecting deleted buffer")),
        Some(EditorValue::Str(name)) => ed.buffers().iter().position(|b| b.name == name).ok_or_else(|| Error::new(format!("No such buffer {name}"))),
        Some(other) => Err(wrong("bufferp", &other)),
    }
}

natives! {
    /// A string of one character, as char-to-string.
    #[ts = "(char: number): string"]
    pub fn charToString(_ed, c: EditorValue) -> String {
        Ok(character(&c)?.to_string())
    }

    /// A string's first character, 0 for an empty string, as string-to-char.
    #[ts = "(string: string): number"]
    pub fn stringToChar(_ed, s: EditorValue) -> f64 {
        Ok(text(&s)?.chars().next().map_or(0.0, |c| f64::from(c as u32)))
    }

    /// A unibyte string of one byte, as byte-to-string.
    #[ts = "(byte: number): string"]
    pub fn byteToString(_ed, byte: EditorValue) -> String {
        match byte {
            EditorValue::Number(n) if (0.0..=255.0).contains(&n) && n.fract() == 0.0 => Ok(e8_core::coding::string_of_bytes(&[n as u8])),
            _ => Err(Error::new("Invalid byte")),
        }
    }

    /// Whether two characters are the same, ignoring case where case-fold-search is set, as char-equal.
    #[ts = "(c1: number, c2: number): boolean"]
    pub fn charEqual(ed, c1: EditorValue, c2: EditorValue) -> bool {
        let (a, b) = (character(&c1)?, character(&c2)?);
        if a == b {
            return Ok(true);
        }
        let fold = ed.variable("case-fold-search").is_some_and(|v| v.is_true());
        Ok(fold && a.to_lowercase().eq(b.to_lowercase()))
    }

    /// The character after point, 0 at the end of the accessible text, as following-char.
    pub fn followingChar(ed) -> f64 {
        let b = ed.buffer();
        Ok(if b.point() >= b.point_max() { 0.0 } else { b.char_at(b.point()).map_or(0.0, |c| f64::from(c as u32)) })
    }

    /// The character before point, 0 at the start of the accessible text, as preceding-char.
    pub fn precedingChar(ed) -> f64 {
        let b = ed.buffer();
        Ok(if b.point() <= b.point_min() { 0.0 } else { b.char_at(b.point() - 1).map_or(0.0, |c| f64::from(c as u32)) })
    }

    /// Format values as Lisp's format: %s as princ, %S as prin1, %d %o %x %X %c %e %f %g, with field numbers, flags, width and precision.
    #[ts = "(format: string, ...args: Value[]): string"]
    pub fn format(ed, fmt: EditorValue, args: Rest<EditorValue>) -> String {
        let fmt = text(&fmt)?;
        e8_core::format::format(&fmt, &args.0, &|v, escape| ed.prin1_to_string(v, !escape))
    }

    /// Format as format, with the format string's grave accents and apostrophes curved as text-quoting-style says, as format-message.
    #[ts = "(format: string, ...args: Value[]): string"]
    pub fn formatMessage(ed, fmt: EditorValue, args: Rest<EditorValue>) -> String {
        let fmt = text(&fmt)?;
        let style = ed.variable("text-quoting-style").and_then(|v| v.as_str().map(str::to_string));
        let fmt = e8_core::format::quote_message(&fmt, style.as_deref());
        e8_core::format::format(&fmt, &args.0, &|v, escape| ed.prin1_to_string(v, !escape))
    }

    /// The message for a count, as ngettext: E8 translates none, so the first for 1 and the plural otherwise.
    #[ts = "(msgid: string, msgidPlural: string, n: number): string"]
    pub fn ngettext(_ed, singular: String, plural: String, n: f64) -> String {
        Ok(if n == 1.0 { singular } else { plural })
    }

    /// Whether a buffer, the current one by default, is modified, as buffer-modified-p.
    #[ts = "(buffer?: Buffer | string | null): boolean"]
    pub fn bufferModifiedP(ed, buffer: Opt<EditorValue>) -> bool {
        let i = buffer_index(ed, buffer.0)?;
        Ok(ed.buffers()[i].is_modified())
    }

    /// Mark the current buffer modified or not, without locking its file, as restore-buffer-modified-p; gives the flag.
    #[ts = "(flag: Value): Value"]
    pub fn restoreBufferModifiedP(ed, flag: EditorValue) -> EditorValue {
        ed.buffer_mut().set_modified(flag.is_true());
        Ok(flag)
    }

    /// Make a buffer current without showing it, as set-buffer; gives the buffer.
    #[ts = "(buffer: Buffer | string): Buffer"]
    pub fn setBuffer(ed, buffer: EditorValue) -> EditorValue {
        let i = buffer_index(ed, Some(buffer))?;
        let name = ed.buffers()[i].name.clone();
        ed.set_current_buffer(&name)?;
        Ok(EditorValue::Buffer(ed.buffer().id()))
    }

    /// The buffer visiting exactly a file name, expanded, as get-file-buffer; undefined if none.
    #[ts = "(filename: string): Buffer | undefined"]
    pub fn getFileBuffer(ed, filename: EditorValue) -> Option<EditorValue> {
        let path = ed.expand_file_name(&text(&filename)?);
        Ok(ed.buffers().iter().find(|b| b.path.as_deref() == Some(path.as_path())).map(|b| EditorValue::Buffer(b.id())))
    }

    /// Ask for the mode lines to be shown again, as force-mode-line-update: E8 shows them again at every redisplay.
    #[ts = "(all?: Value): Value"]
    pub fn forceModeLineUpdate(_ed, all: Opt<EditorValue>) -> EditorValue {
        Ok(all.0.unwrap_or(EditorValue::Null))
    }

    /// Set whether the current buffer is multibyte, as set-buffer-multibyte: E8's buffers always hold characters, so this only sets enable-multibyte-characters. Gives the flag.
    #[ts = "(flag: Value): Value"]
    pub fn setBufferMultibyte(ed, flag: EditorValue) -> EditorValue {
        ed.make_local_variable("enable-multibyte-characters");
        ed.set_variable("enable-multibyte-characters", EditorValue::Bool(flag.is_true()));
        Ok(flag)
    }

    /// Whether a buffer, the current one by default, is a minibuffer, as minibufferp; with `live`, an active one.
    #[ts = "(buffer?: Buffer | string | null, live?: boolean): boolean"]
    pub fn minibufferp(ed, buffer: Opt<EditorValue>, live: Opt<bool>) -> bool {
        let i = buffer_index(ed, buffer.0)?;
        let name = &ed.buffers()[i].name;
        let is_mini = name.starts_with(" *Minibuf-");
        Ok(is_mini && (!live.0.unwrap_or(false) || ed.minibuffer_depth() > 0))
    }

    /// The prompt of the innermost minibuffer, as minibuffer-prompt; undefined when none is open.
    pub fn minibufferPrompt(ed) -> Option<String> {
        Ok((ed.minibuffer_depth() > 0).then(|| {
            let end = ed.minibuffer_prompt_end();
            ed.mini_window_buffer().slice(0..end)
        }))
    }

    /// The minibuffer's text after its prompt, without properties, as minibuffer-contents-no-properties.
    pub fn minibufferContentsNoProperties(ed) -> String {
        let b = ed.mini_window_buffer();
        let start = if ed.minibuffer_depth() > 0 { ed.minibuffer_prompt_end() } else { 0 };
        Ok(b.slice(start.min(b.len())..b.len()))
    }

    /// The first element of a list whose car (or which itself) is a string equal to a key, ignoring case with `caseFold`, as assoc-string.
    #[ts = "(key: string | symbol, list: Value[], caseFold?: boolean): Value | undefined"]
    pub fn assocString(_ed, key: EditorValue, list: EditorValue, case_fold: Opt<bool>) -> Option<EditorValue> {
        let Some(key) = key.as_str().map(str::to_string) else { return Err(wrong("stringp", &key)) };
        let fold = case_fold.0.unwrap_or(false);
        let same = |s: &str| if fold { s.to_lowercase() == key.to_lowercase() } else { s == key };
        let EditorValue::List(items) = list else { return Ok(None) };
        Ok(items.into_iter().find(|item| {
            let name = match item {
                EditorValue::List(pair) => pair.first().and_then(EditorValue::as_str).map(str::to_string),
                other => other.as_str().map(str::to_string),
            };
            name.is_some_and(|n| same(&n))
        }))
    }

    /// The lines a window's text area holds, as window-body-height; with `pixelwise`, its height in the front end's units.
    #[ts = "(window?: WindowLike | null, pixelwise?: boolean): number"]
    pub fn windowBodyHeight(ed, window: Option<Win>, pixelwise: Opt<bool>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        let (_, h) = ed.window_body_pixel_size(id).ok_or_else(|| Error::new("No such window"))?;
        let unit = f64::from(ed.text_metrics().char_height()).max(1.0);
        Ok(if pixelwise.0.unwrap_or(false) { f64::from(h) } else { (f64::from(h) / unit).floor() })
    }

    /// The columns a window's text area holds, as window-body-width; with `pixelwise`, its width in the front end's units.
    #[ts = "(window?: WindowLike | null, pixelwise?: boolean): number"]
    pub fn windowBodyWidth(ed, window: Option<Win>, pixelwise: Opt<bool>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        let (w, _) = ed.window_body_pixel_size(id).ok_or_else(|| Error::new("No such window"))?;
        let unit = f64::from(ed.text_metrics().char_width()).max(1.0);
        Ok(if pixelwise.0.unwrap_or(false) { f64::from(w) } else { (f64::from(w) / unit).floor() })
    }

    /// The lines of text a window shows, as window-text-height; with `pixelwise`, in the front end's units.
    #[ts = "(window?: WindowLike | null, pixelwise?: boolean): number"]
    pub fn windowTextHeight(ed, window: Option<Win>, pixelwise: Opt<bool>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        let (_, h) = ed.window_body_pixel_size(id).ok_or_else(|| Error::new("No such window"))?;
        let unit = f64::from(ed.text_metrics().char_height()).max(1.0);
        Ok(if pixelwise.0.unwrap_or(false) { f64::from(h) } else { (f64::from(h) / unit).floor() })
    }

    /// The columns of text a window shows, as window-text-width; with `pixelwise`, in the front end's units.
    #[ts = "(window?: WindowLike | null, pixelwise?: boolean): number"]
    pub fn windowTextWidth(ed, window: Option<Win>, pixelwise: Opt<bool>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        let (w, _) = ed.window_body_pixel_size(id).ok_or_else(|| Error::new("No such window"))?;
        let unit = f64::from(ed.text_metrics().char_width()).max(1.0);
        Ok(if pixelwise.0.unwrap_or(false) { f64::from(w) } else { (f64::from(w) / unit).floor() })
    }

    /// Make a window its frame's selected one, as set-frame-selected-window; gives the window.
    #[ts = "(frame: Frame | null, window: WindowLike, norecord?: boolean): Window"]
    pub fn setFrameSelectedWindow(ed, frame: EditorValue, window: Win, norecord: Opt<bool>) -> Win {
        let frame = match frame {
            EditorValue::Null => ed.selected_frame(),
            EditorValue::Frame(id) => id,
            other => return Err(wrong("frame-live-p", &other)),
        };
        ed.set_frame_selected_window(frame, window.0, norecord.0.unwrap_or(false))?;
        Ok(window)
    }

    /// How many columns a character takes, as char-width.
    #[ts = "(char: number): number"]
    pub fn charWidth(_ed, c: EditorValue) -> f64 {
        let c = character(&c)?;
        Ok(e8_core::display::render_char(c, 0, 8, &mut String::new()) as f64)
    }

    /// Whether an object is a character code, as characterp.
    #[ts = "(object: unknown): boolean"]
    pub fn characterp(_ed, object: EditorValue) -> bool {
        Ok(matches!(object, EditorValue::Number(n) if n.fract() == 0.0 && (0.0..=4194303.0).contains(&n)))
    }

    /// The largest character code, as max-char: Unicode's with `unicode`.
    #[ts = "(unicode?: boolean): number"]
    pub fn maxChar(_ed, unicode: Opt<bool>) -> f64 {
        Ok(if unicode.0.unwrap_or(false) { 1114111.0 } else { 4194303.0 })
    }

    /// A string of characters, as string.
    #[ts = "(...characters: number[]): string"]
    pub fn string(_ed, chars: Rest<EditorValue>) -> String {
        chars.0.iter().map(character).collect()
    }

    /// A unibyte string of bytes, as unibyte-string.
    #[ts = "(...bytes: number[]): string"]
    pub fn unibyteString(_ed, bytes: Rest<EditorValue>) -> String {
        let bytes = bytes
            .0
            .iter()
            .map(|b| match b {
                EditorValue::Number(n) if (0.0..=255.0).contains(n) && n.fract() == 0.0 => Ok(*n as u8),
                other => Err(Error::signal("args-out-of-range", format!("Args out of range: {other}, 0, 255"), vec![other.clone(), EditorValue::Number(0.0), EditorValue::Number(255.0)])),
            })
            .collect::<Result<Vec<u8>>>()?;
        Ok(e8_core::coding::string_of_bytes(&bytes))
    }

    /// A key sequence in Emacs's notation, after a prefix's, as key-description: events as characters with modifier bits, symbols, or a string.
    #[ts = "(keys: string | Value[], prefix?: string | Value[] | null): string"]
    pub fn keyDescription(_ed, keys: EditorValue, prefix: Opt<EditorValue>) -> String {
        let mut all = match prefix.0 {
            None | Some(EditorValue::Null) => Vec::new(),
            Some(p) => keys_of(&p)?,
        };
        all.extend(keys_of(&keys)?);
        Ok(e8_core::format_keys(&all))
    }

    /// One event in Emacs's notation, as single-key-description; with `noAngles`, a function key without its angle brackets.
    #[ts = "(key: Value, noAngles?: boolean): string"]
    pub fn singleKeyDescription(_ed, key: EditorValue, no_angles: Opt<bool>) -> String {
        let k = key_of_event(&key).ok_or_else(|| wrong("eventp", &key))?;
        let text = k.to_string();
        Ok(if no_angles.0.unwrap_or(false) { text.replace(['<', '>'], "") } else { text })
    }

    /// Give a process another buffer, or none with null, as set-process-buffer; gives the buffer.
    #[ts = "(process: ProcessLike, buffer: Buffer | string | null): Buffer | undefined"]
    pub fn setProcessBuffer(ed, process: EditorValue, buffer: EditorValue) -> Option<EditorValue> {
        let id = ed.get_process(&process)?;
        let name = ed.process_info(id).map(|p| p.name).ok_or_else(|| Error::new("Process is gone"))?;
        let buffer = match buffer {
            EditorValue::Null => None,
            other => Some(ed.buffers()[buffer_index(ed, Some(other))?].id()),
        };
        ed.set_process_buffer(&name, buffer)?;
        Ok(buffer.map(EditorValue::Buffer))
    }

    /// Mark the end of a change for undo, as undo-boundary.
    pub fn undoBoundary(ed) -> Option<bool> {
        ed.buffer_mut().undo_boundary();
        Ok(None)
    }

    /// A file name, a prefix and characters making it one no file has, as make-temp-name.
    #[ts = "(prefix: string): string"]
    pub fn makeTempName(_ed, prefix: String) -> String {
        const LETTERS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let nanos = e8_core::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let mut seed = nanos ^ u128::from(e8_core::clock::process_id());
        loop {
            let mut name = prefix.clone();
            for _ in 0..6 {
                name.push(LETTERS[(seed % LETTERS.len() as u128) as usize] as char);
                seed = seed / LETTERS.len() as u128 + seed.wrapping_mul(6364136223846793005);
            }
            if !e8_core::vfs::path_exists(std::path::Path::new(&name)) {
                return Ok(name);
            }
        }
    }

    /// Run a function as a command keys would, so called-interactively-p is true in it, as funcall-interactively.
    #[ts = "(fn: string | ((...args: any[]) => any), ...args: Value[]): Value"]
    pub fn funcallInteractively(ed, function: EditorValue, args: Rest<EditorValue>) -> EditorValue {
        ed.funcall_interactively(&function, &args.0)
    }

    /// Pack a char-table's ranges, as optimize-char-table: E8's are kept packed.
    #[ts = "(table: CharTable, test?: Value): undefined"]
    pub fn optimizeCharTable(_ed, table: EditorValue, _test: Opt<EditorValue>) -> Option<bool> {
        if !matches!(table, EditorValue::CharTable(_)) {
            return Err(wrong("char-table-p", &table));
        }
        Ok(None)
    }
}
