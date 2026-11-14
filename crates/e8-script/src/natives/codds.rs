//! The odds of Emacs's C core that are left (ADR 0093): how E8 was
//! started (emacs.c), the time it has run (sysdep.c), the terminal's
//! output (term.c), events as lists (keyboard.c), image maps (xdisp.c)
//! and GnuTLS's fatal errors (gnutls.c).

use crate::*;
use crate::natives::{Opt, Trm, Win, natives};

/// The program E8 runs as, from the executable's path.
fn executable() -> Option<std::path::PathBuf> {
    if cfg!(target_arch = "wasm32") { None } else { std::env::current_exe().ok() }
}

/// GnuTLS's errors that are not fatal, as gnutls_error_is_fatal's table
/// marks them: again, interrupted, a warning alert, a rehandshake, data
/// during a handshake, a large packet and a reauthentication request.
const NOT_FATAL: [i64; 7] = [-28, -52, -16, -37, -38, -7, -424];

/// Whether a point is on an image map's area, as xdisp.c's on_hot_spot_p:
/// `[rect, [[x0, y0], [x1, y1]]]`, `[circle, [[x, y], r]]` or `[poly, [x0, y0, ...]]`.
fn on_hot_spot(area: &EditorValue, x: i64, y: i64) -> bool {
    let EditorValue::List(parts) = area else { return false };
    let int = |v: &EditorValue| v.as_number().filter(|n| n.fract() == 0.0).map(|n| n as i64);
    fn pair(v: &EditorValue) -> Option<(&EditorValue, &EditorValue)> {
        match v {
            EditorValue::List(p) if p.len() == 2 => Some((&p[0], &p[1])),
            _ => None,
        }
    }
    let (Some(kind), Some(spec)) = (parts.first().and_then(EditorValue::as_str), parts.get(1)) else { return false };
    match kind {
        "rect" => (|| {
            let (a, b) = pair(spec)?;
            let ((x0, y0), (x1, y1)) = (pair(a)?, pair(b)?);
            Some(x >= int(x0)? && y >= int(y0)? && x <= int(x1)? && y <= int(y1)?)
        })()
        .unwrap_or(false),
        "circle" => (|| {
            let (centre, r) = pair(spec)?;
            let (cx, cy) = pair(centre)?;
            let (r, dx, dy) = (r.as_number()?, (int(cx)? - x) as f64, (int(cy)? - y) as f64);
            Some(dx * dx + dy * dy <= r * r)
        })()
        .unwrap_or(false),
        "poly" => (|| {
            let EditorValue::List(v) = spec else { return None };
            let n = v.len();
            if n < 6 || n % 2 == 1 {
                return Some(false);
            }
            let coords: Vec<i64> = v.iter().map(int).collect::<Option<_>>()?;
            let (mut x0, mut y0) = (coords[n - 2], coords[n - 1]);
            let mut inside = false;
            for i in (0..n).step_by(2) {
                let (x1, y1) = (x0, y0);
                (x0, y0) = (coords[i], coords[i + 1]);
                if (x0 >= x && x1 >= x) || (x0 < x && x1 < x) || (y > y0 && y > y1) {
                    continue;
                }
                if y < y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) {
                    inside = !inside;
                }
            }
            Some(inside)
        })()
        .unwrap_or(false),
        _ => false,
    }
}


/// Modifier bits, as keyboard.c numbers them.
const UP: u32 = 1;
const DOWN: u32 = 2;
const DRAG: u32 = 4;
const CLICK: u32 = 8;
const DOUBLE: u32 = 16;
const TRIPLE: u32 = 32;
const ALT: u32 = 1 << 22;
const SUPER: u32 = 1 << 23;
const HYPER: u32 = 1 << 24;
const SHIFT: u32 = 1 << 25;
const CTRL: u32 = 1 << 26;
const META: u32 = 1 << 27;
/// Each bit's name, lowest bit first, as keyboard.c's modifier_names.
const MODIFIER_NAMES: [(u32, &str); 12] = [
    (UP, "up"), (DOWN, "down"), (DRAG, "drag"), (CLICK, "click"), (DOUBLE, "double"), (TRIPLE, "triple"),
    (ALT, "alt"), (SUPER, "super"), (HYPER, "hyper"), (SHIFT, "shift"), (CTRL, "control"), (META, "meta"),
];

/// The modifiers an event symbol's name starts with and where its base
/// starts, as keyboard.c's parse_modifiers_uncached.
fn parse_modifiers(name: &str) -> (u32, usize) {
    let b = name.as_bytes();
    let mut modifiers = 0;
    let mut i = 0;
    while i + 1 < b.len() {
        let word = |w: &str| (i + w.len() < b.len() && name[i..].starts_with(w)).then_some(i + w.len());
        let (bit, end) = match b[i] {
            b'A' => (ALT, Some(i + 1)),
            b'C' => (CTRL, Some(i + 1)),
            b'H' => (HYPER, Some(i + 1)),
            b'M' => (META, Some(i + 1)),
            b'S' => (SHIFT, Some(i + 1)),
            b's' => (SUPER, Some(i + 1)),
            b'd' => word("drag").map(|e| (DRAG, Some(e))).or_else(|| word("down").map(|e| (DOWN, Some(e)))).or_else(|| word("double").map(|e| (DOUBLE, Some(e)))).unwrap_or((0, None)),
            b't' => word("triple").map_or((0, None), |e| (TRIPLE, Some(e))),
            b'u' => word("up").map_or((0, None), |e| (UP, Some(e))),
            _ => (0, None),
        };
        let Some(end) = end else { break };
        if end >= b.len() || b[end] != b'-' {
            break;
        }
        modifiers |= bit;
        i = end + 1;
    }
    let rest = &name[i..];
    if modifiers & (DOWN | DRAG | DOUBLE | TRIPLE) == 0 && rest.len() == 7 && rest.starts_with("mouse-") && rest.as_bytes()[6].is_ascii_digit() {
        modifiers |= CLICK;
    }
    if modifiers & (DOUBLE | TRIPLE) == 0 && rest.len() > 6 && rest.starts_with("wheel-") {
        modifiers |= CLICK;
    }
    (modifiers, i)
}

/// The modifier a lone symbol names, as parse_solitary_modifier: a word or its letter.
fn solitary_modifier(name: &str) -> u32 {
    match name {
        "A" | "alt" => ALT,
        "C" | "control" | "ctrl" => CTRL,
        "H" | "hyper" => HYPER,
        "M" | "meta" => META,
        "S" | "shift" => SHIFT,
        "s" | "super" => SUPER,
        "double" => DOUBLE,
        "triple" => TRIPLE,
        "down" => DOWN,
        "drag" => DRAG,
        "up" => UP,
        "click" => CLICK,
        _ => 0,
    }
}

/// A control character from a character, as keyboard.c's make_ctrl_char:
/// letters and `@` to `_` become control characters, a shifted letter
/// keeping its shift, and other printing characters take the control bit.
fn make_ctrl_char(c: u32) -> u32 {
    if c >= 0x80 {
        return c | CTRL;
    }
    match c {
        0x40..0x60 => (c & !0x60) | if (0x41..=0x5a).contains(&c) { SHIFT } else { 0 },
        0x61..=0x7a => c & !0x60,
        0x20.. => c | CTRL,
        _ => c,
    }
}

/// The prefixes a key description writes for modifiers, as Emacs writes them: A- C- H- M- S- s-.
fn modifier_prefixes(modifiers: u32) -> String {
    [(ALT, "A-"), (CTRL, "C-"), (HYPER, "H-"), (META, "M-"), (SHIFT, "S-"), (SUPER, "s-")].iter().filter(|(bit, _)| modifiers & bit != 0).map(|(_, p)| *p).collect()
}

/// The key a character event with modifier bits is, as key-description writes it.
fn describe_char_event(code: u32) -> String {
    let modifiers = code & !0x3fffff;
    let c = code & 0x3fffff;
    let (extra, base) = match c {
        0x1b => (0, "ESC".to_string()),
        0x09 => (0, "TAB".to_string()),
        0x0d => (0, "RET".to_string()),
        0x20 => (0, "SPC".to_string()),
        0x7f => (0, "DEL".to_string()),
        // As push_key_description: C-a to C-z for 1 to 26, else the character 64 on, C-@ and C-\\.
        1..=26 => (CTRL, char::from_u32(c + 0x60).map_or(String::new(), String::from)),
        0..0x20 => (CTRL, char::from_u32(c + 0x40).map_or(String::new(), String::from)),
        _ => (0, char::from_u32(c).map_or(String::new(), String::from)),
    };
    format!("{}{base}", modifier_prefixes(modifiers | extra))
}

/// The terminal a native was given, the only one by default, or the one a frame is on.
fn terminal(ed: &Editor, terminal: Option<Trm>) -> e8_core::TerminalId {
    let named = terminal.map_or(e8_core::THE_TERMINAL, |t| t.0);
    ed.terminal_named(named).unwrap_or(named)
}

natives! {
    /// The name E8 was run as, as invocation-name: the program's file name without its directory.
    pub fn invocationName(_ed) -> String {
        Ok(executable().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "e8".into()))
    }

    /// The directory E8's program is in, ending in a slash, as invocation-directory.
    pub fn invocationDirectory(_ed) -> String {
        let dir = executable().and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())).unwrap_or_default();
        Ok(if dir.ends_with('/') { dir } else { format!("{dir}/") })
    }

    /// Tell the process that started a daemon that it is ready, as daemon-initialized: E8 is never one, so this signals as Emacs does when not run as a daemon.
    #[ts = "(): never"]
    pub fn daemonInitialized(_ed) {
        Err(Error::signal("error", "This function can only be called if emacs is run as a daemon", Vec::new()))
    }

    /// The processor time E8 has used, in seconds, as get-internal-run-time.
    pub fn getInternalRunTime(_ed) -> f64 {
        Ok(e8_core::clock::run_time())
    }

    /// The first element of an image map whose area has the point x, y on it, as lookup-image-map: each element [area, id, plist], an area a rect, circle or poly as Emacs writes them.
    #[ts = "(map: Value[] | null, x: number, y: number): Value | undefined"]
    pub fn lookupImageMap(_ed, map: EditorValue, x: f64, y: f64) -> Option<EditorValue> {
        let EditorValue::List(elements) = map else { return Ok(None) };
        Ok(elements.into_iter().find(|e| matches!(e, EditorValue::List(p) if p.first().is_some_and(|a| on_hot_spot(a, x as i64, y as i64)))))
    }

    /// Whether a GnuTLS error is fatal, as gnutls-error-fatalp: an error code, or a symbol naming one; true for none but the errors a connection goes on after.
    #[ts = "(error: number | string | boolean): boolean"]
    pub fn gnutlsErrorFatalp(_ed, error: EditorValue) -> bool {
        let code = match &error {
            EditorValue::Bool(true) => return Ok(false),
            EditorValue::Number(n) => *n as i64,
            other => match other.as_str() {
                Some("gnutls-e-again") => -28,
                Some("gnutls-e-interrupted") => -52,
                Some("gnutls-e-invalid-session") => -10,
                Some("gnutls-e-not-ready-for-handshake") => -413,
                _ => return Err(Error::signal("error", "Symbol has no numeric gnutls-code property", Vec::new())),
            },
        };
        Ok(code < 0 && !NOT_FATAL.contains(&code))
    }

    /// An event symbol's base and its modifiers, as internal-event-symbol-parse-modifiers: "C-M-x" is ["x", "meta", "control"], the highest modifier first.
    #[ts = "(symbol: string | symbol): string[]"]
    pub fn internalEventSymbolParseModifiers(_ed, symbol: EditorValue) -> Vec<String> {
        let name = symbol.as_str().ok_or_else(|| e8_core::xfaces::wrong_type("symbolp", &symbol))?.to_string();
        let (modifiers, base) = parse_modifiers(&name);
        let mut list = vec![name[base..].to_string()];
        list.extend(MODIFIER_NAMES.iter().rev().filter(|(bit, _)| modifiers & bit != 0).map(|(_, n)| n.to_string()));
        Ok(list)
    }

    /// The event a list of modifiers and a base names, as event-convert-list, written as a key: ["control", "a"] or ["control", 97] is "C-a", ["down", "mouse-1"] is "<down-mouse-1>"; Emacs gives a number for a character, which E8's keys write as their description.
    #[ts = "(event: (string | symbol | number)[]): string"]
    pub fn eventConvertList(_ed, event: Vec<EditorValue>) -> String {
        let mut modifiers = 0;
        let mut base: Option<EditorValue> = None;
        let n = event.len();
        for (i, element) in event.into_iter().enumerate() {
            let bit = if i + 1 < n { element.as_str().map_or(0, solitary_modifier) } else { 0 };
            if bit != 0 {
                modifiers |= bit;
            } else if base.is_some() {
                return Err(Error::signal("error", "Two bases given in one event", Vec::new()));
            } else {
                base = Some(element);
            }
        }
        let base = base.ok_or_else(|| Error::signal("error", "Invalid base event", Vec::new()))?;
        let as_char = match &base {
            EditorValue::Number(n) => Some(*n as u32),
            other => other.as_str().filter(|s| s.chars().count() == 1).map(|s| s.chars().next().unwrap() as u32),
        };
        if let Some(mut c) = as_char {
            if modifiers & SHIFT != 0 && (u32::from(b'a')..=u32::from(b'z')).contains(&c) {
                c -= 32;
                modifiers &= !SHIFT;
            }
            if modifiers & CTRL != 0 {
                modifiers &= !CTRL;
                c = make_ctrl_char(c);
            }
            return Ok(describe_char_event(c | modifiers));
        }
        let name = base.as_str().ok_or_else(|| Error::signal("error", "Invalid base event", Vec::new()))?;
        let clicks: String = [(DOUBLE, "double-"), (TRIPLE, "triple-"), (DOWN, "down-"), (DRAG, "drag-"), (UP, "up-")].iter().filter(|(bit, _)| modifiers & bit != 0).map(|(_, p)| *p).collect();
        Ok(format!("{}<{clicks}{name}>", modifier_prefixes(modifiers)))
    }

    /// The frame on top of a text terminal, as tty-top-frame: the selected one; undefined in a window.
    #[ts = "(terminal?: Terminal | FrameLike | null): Frame | undefined"]
    pub fn ttyTopFrame(ed, t: Option<Trm>) -> Option<EditorValue> {
        Ok(ed.tty_top_frame(terminal(ed, t))?.map(EditorValue::Frame))
    }

    /// Say a text terminal cannot underline, as tty-no-underline: E8's terminal then draws none.
    #[ts = "(terminal?: Terminal | FrameLike | null): undefined"]
    pub fn ttyNoUnderline(ed, t: Option<Trm>) -> Option<bool> {
        ed.tty_no_underline(terminal(ed, t))?;
        Ok(None)
    }

    /// The text terminal's output buffer size, 0 for the system's, as tty--output-buffer-size.
    #[ts = "(terminal?: Terminal | FrameLike | null): number"]
    pub fn ttyOutputBufferSize(ed, t: Option<Trm>) -> f64 {
        Ok(ed.tty_output_buffer_size(terminal(ed, t))? as f64)
    }

    /// Set the text terminal's output buffer size, as tty--set-output-buffer-size; E8 writes each frame whole, so it is only kept.
    #[ts = "(size: number, terminal?: Terminal | FrameLike | null): undefined"]
    pub fn ttySetOutputBufferSize(ed, size: f64, t: Option<Trm>) -> Option<bool> {
        if size < 0.0 || size.fract() != 0.0 {
            return Err(e8_core::xfaces::wrong_type("natnump", &EditorValue::Number(size)));
        }
        ed.set_tty_output_buffer_size(terminal(ed, t), size as usize)?;
        Ok(None)
    }

    /// Take the keys of the command running out of the keyboard macro being defined, as cancel-kbd-macro-events.
    #[ts = "(): undefined"]
    pub fn cancelKbdMacroEvents(ed) -> Option<bool> {
        ed.cancel_kbd_macro_events();
        Ok(None)
    }

    /// Say which window the minibuffer shows in, as set-minibuffer-window: E8 has one minibuffer window, the only one this takes; gives it.
    #[ts = "(window: WindowLike): Window"]
    pub fn setMinibufferWindow(_ed, window: Win) -> Win {
        if window.0 != e8_core::MINIBUFFER_WINDOW {
            return Err(Error::signal("error", "Window is not a minibuffer window", Vec::new()));
        }
        Ok(window)
    }

    /// The symbol of the menu bar menu at a place on a frame, in its units, as menu-bar-menu-at-x-y; undefined outside the menu bar.
    #[ts = "(x: number, y: number, frame?: FrameLike | null): string | undefined"]
    pub fn menuBarMenuAtXY(ed, x: f64, y: f64, frame: Opt<EditorValue>) -> Option<String> {
        let frame = match frame.0 {
            Some(EditorValue::Frame(id)) => id,
            _ => ed.selected_frame(),
        };
        Ok(ed.menu_bar_menu_at(frame, x, y))
    }

    /// Open a file every byte sent to the terminal also goes to, as open-termscript; on anything but a text terminal it signals as Emacs's does. E8's terminal does not write one yet.
    #[ts = "(file: string | null): undefined"]
    pub fn openTermscript(ed, _file: Opt<EditorValue>) -> Option<bool> {
        if ed.tty_top_frame(e8_core::THE_TERMINAL)?.is_none() {
            return Err(Error::signal("error", "Current frame is not on a tty device", Vec::new()));
        }
        Ok(None)
    }

    /// Whether the newline cache agrees with the buffer, as newline-cache-check: E8 keeps no newline cache, so there is nothing to disagree.
    #[ts = "(buffer?: BufferLike | null): undefined"]
    pub fn newlineCacheCheck(_ed, _buffer: Opt<EditorValue>) -> Option<bool> {
        Ok(None)
    }

    /// The variable watcher Emacs puts on variables that redisplay a buffer when set, as set-buffer-redisplay: E8 redisplays after every command anyway.
    #[ts = "(symbol: string, newval: Value, op: Value, where: Value): undefined"]
    pub fn setBufferRedisplay(_ed, _symbol: EditorValue, _newval: EditorValue, _op: EditorValue, _place: EditorValue) -> Option<bool> {
        Ok(None)
    }
}
