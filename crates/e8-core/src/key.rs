use std::fmt;
use std::sync::Mutex;

/// A key, independent of any terminal library.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KeyCode {
    Char(char),
    Enter,
    Tab,
    Backspace,
    Delete,
    Insert,
    Esc,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    /// A function key, `<f1>` to `<f35>`.
    F(u8),
    /// The mouse wheel or a trackpad scrolling towards the start of the buffer.
    WheelUp,
    /// The mouse wheel or a trackpad scrolling towards the end of the buffer.
    WheelDown,
    /// What a click on the tab bar comes after, as Emacs's `tab-bar`
    /// pseudo-event: `<tab-bar> <mouse-1>`.
    TabBar,
    /// The mouse moving while `track-mouse` is on, as Emacs's
    /// `mouse-movement` event; where it went is in [`crate::MouseEvent`].
    MouseMovement,
    /// A key that is a plain symbol, as most of Emacs's events are: the
    /// menu bar's `<menu-bar> <file> <open-file>` and the pseudo-events a
    /// click on a part of the frame comes after. It cannot be typed.
    Symbol(SymbolKey),
    /// A mouse button, 1 to 5, as Emacs names its events: `<down-mouse-1>`
    /// when pressed, `<mouse-1>` when released where it was pressed,
    /// `<drag-mouse-1>` after moving, and `<double-mouse-1>` and
    /// `<triple-mouse-1>` for repeated clicks. Where the event happened is
    /// in [`crate::MouseEvent`].
    Mouse(MouseKind, u8),
}

/// A symbol used as a key, by the order it was first named. Symbols are
/// few, live as long as the program, and are compared by this number, so
/// looking a key up costs no more than any other.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SymbolKey(u32);

/// Every symbol named as a key so far, in the order they were named.
static SYMBOL_KEYS: Mutex<Vec<String>> = Mutex::new(Vec::new());

impl SymbolKey {
    /// The key for a symbol's name, naming it if it is new.
    pub fn new(name: &str) -> SymbolKey {
        let mut names = SYMBOL_KEYS.lock().unwrap_or_else(|e| e.into_inner());
        match names.iter().position(|n| n == name) {
            Some(i) => SymbolKey(i as u32),
            None => {
                names.push(name.to_string());
                SymbolKey(names.len() as u32 - 1)
            }
        }
    }

    /// Its name, without the angle brackets it is written in.
    pub fn name(self) -> String {
        let names = SYMBOL_KEYS.lock().unwrap_or_else(|e| e.into_inner());
        names.get(self.0 as usize).cloned().unwrap_or_default()
    }
}

/// Whether a name may stand between angle brackets as a symbol key: Emacs
/// writes any symbol that way, but a name with a space in it could not be
/// read back as one key.
fn symbol_name(s: &str) -> Option<&str> {
    let inner = s.strip_prefix('<')?.strip_suffix('>')?;
    (!inner.is_empty() && !inner.contains(['<', '>']) && !inner.chars().any(char::is_whitespace)).then_some(inner)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MouseKind {
    Down,
    Click,
    Drag,
    Double,
    Triple,
}

impl MouseKind {
    fn prefix(self) -> &'static str {
        match self {
            MouseKind::Down => "down-",
            MouseKind::Click => "",
            MouseKind::Drag => "drag-",
            MouseKind::Double => "double-",
            MouseKind::Triple => "triple-",
        }
    }
}

/// A mouse event written as `<drag-mouse-1>`.
fn mouse_event(name: &str) -> Option<KeyCode> {
    let inner = name.strip_prefix('<')?.strip_suffix('>')?;
    let (kind, rest) = [MouseKind::Down, MouseKind::Drag, MouseKind::Double, MouseKind::Triple]
        .into_iter()
        .find_map(|k| inner.strip_prefix(k.prefix()).map(|r| (k, r)))
        .unwrap_or((MouseKind::Click, inner));
    let n: u8 = rest.strip_prefix("mouse-")?.parse().ok()?;
    (1..=5).contains(&n).then_some(KeyCode::Mouse(kind, n))
}

/// A key press with its modifiers, written in Emacs notation such as `C-x`,
/// `M-<` or `S-<right>`.
///
/// `shift` is only set where Shift is not already part of the character: on
/// keys like `<right>`, and on letters in chords such as `C-S-f`. A plain
/// capital letter is just the character `A`, as in Emacs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key {
    pub code: KeyCode,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
}

impl Key {
    pub fn new(code: KeyCode) -> Key {
        Key { code, ctrl: false, meta: false, shift: false }
    }

    pub fn char(c: char) -> Key {
        Key::new(KeyCode::Char(c))
    }

    pub fn ctrl(mut self) -> Key {
        self.ctrl = true;
        self
    }

    pub fn meta(mut self) -> Key {
        self.meta = true;
        self
    }

    pub fn shift(mut self) -> Key {
        self.shift = true;
        self
    }

    /// The same key without Shift.
    pub fn unshifted(mut self) -> Key {
        self.shift = false;
        self
    }

    /// The character this key inserts, if it is a plain printable character.
    pub fn printable(&self) -> Option<char> {
        match self.code {
            KeyCode::Char(c) if !self.ctrl && !self.meta && !self.shift && !c.is_control() => Some(c),
            _ => None,
        }
    }

    /// Parses one key in Emacs notation: `a`, `C-x`, `M-f`, `C-M-f`, `RET`,
    /// `SPC`, `<left>`, `S-<right>`, `C-S-f`.
    pub fn parse(s: &str) -> Option<Key> {
        let mut rest = s;
        let (mut ctrl, mut meta, mut shift) = (false, false, false);
        loop {
            if rest.len() > 2 && rest.starts_with("C-") {
                ctrl = true;
            } else if rest.len() > 2 && rest.starts_with("M-") {
                meta = true;
            } else if rest.len() > 2 && rest.starts_with("S-") {
                shift = true;
            } else {
                break;
            }
            rest = &rest[2..];
        }
        // Emacs's function key names for RET and TAB, which it translates
        // to them when nothing binds the function key itself; E8 has one
        // key for each. `<backtab>` is what Shift and TAB send.
        if rest == "<backtab>" {
            shift = true;
        }
        let code = match rest {
            "RET" | "<return>" => KeyCode::Enter,
            "TAB" | "<tab>" | "<backtab>" => KeyCode::Tab,
            "DEL" => KeyCode::Backspace,
            "ESC" => KeyCode::Esc,
            "SPC" => KeyCode::Char(' '),
            "<delete>" => KeyCode::Delete,
            "<insert>" => KeyCode::Insert,
            "<left>" => KeyCode::Left,
            "<right>" => KeyCode::Right,
            "<up>" => KeyCode::Up,
            "<down>" => KeyCode::Down,
            "<home>" => KeyCode::Home,
            "<end>" => KeyCode::End,
            "<prior>" => KeyCode::PageUp,
            "<next>" => KeyCode::PageDown,
            "<wheel-up>" => KeyCode::WheelUp,
            "<tab-bar>" => KeyCode::TabBar,
            "<mouse-movement>" => KeyCode::MouseMovement,
            "<wheel-down>" => KeyCode::WheelDown,
            _ if function_key(rest).is_some() => KeyCode::F(function_key(rest).unwrap_or_default()),
            _ if mouse_event(rest).is_some() => mouse_event(rest)?,
            // Any other name in angle brackets is a symbol, as Emacs reads
            // one that names no key of its own.
            _ if symbol_name(rest).is_some() => KeyCode::Symbol(SymbolKey::new(symbol_name(rest)?)),
            _ => {
                let mut chars = rest.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                KeyCode::Char(c)
            }
        };
        Some(Key { code, ctrl, meta, shift })
    }

    /// Parses a space separated key sequence such as `C-x C-f`.
    pub fn parse_seq(s: &str) -> Option<Vec<Key>> {
        let keys: Option<Vec<Key>> = s.split_whitespace().map(Key::parse).collect();
        keys.filter(|k| !k.is_empty())
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.ctrl {
            f.write_str("C-")?;
        }
        if self.meta {
            f.write_str("M-")?;
        }
        if self.shift {
            f.write_str("S-")?;
        }
        let name = match self.code {
            KeyCode::Char(' ') => "SPC",
            KeyCode::Char(c) => return write!(f, "{c}"),
            KeyCode::Enter => "RET",
            KeyCode::Tab => "TAB",
            KeyCode::Backspace => "DEL",
            KeyCode::Esc => "ESC",
            KeyCode::Delete => "<delete>",
            KeyCode::Insert => "<insert>",
            KeyCode::Left => "<left>",
            KeyCode::Right => "<right>",
            KeyCode::Up => "<up>",
            KeyCode::Down => "<down>",
            KeyCode::Home => "<home>",
            KeyCode::End => "<end>",
            KeyCode::PageUp => "<prior>",
            KeyCode::PageDown => "<next>",
            KeyCode::F(n) => return write!(f, "<f{n}>"),
            KeyCode::Mouse(kind, n) => return write!(f, "<{}mouse-{n}>", kind.prefix()),
            KeyCode::WheelUp => "<wheel-up>",
            KeyCode::TabBar => "<tab-bar>",
            KeyCode::MouseMovement => "<mouse-movement>",
            KeyCode::WheelDown => "<wheel-down>",
            KeyCode::Symbol(s) => return write!(f, "<{}>", s.name()),
        };
        f.write_str(name)
    }
}

/// The number of a function key written as `<f1>` to `<f35>`.
fn function_key(name: &str) -> Option<u8> {
    let n: u8 = name.strip_prefix("<f")?.strip_suffix('>')?.parse().ok()?;
    (1..=35).contains(&n).then_some(n)
}

/// Writes a key sequence in Emacs notation, for example `C-x C-f`.
pub fn format_keys(keys: &[Key]) -> String {
    keys.iter().map(Key::to_string).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_prints_emacs_notation() {
        for s in ["a", "C-x", "M-f", "C-M-f", "RET", "SPC", "M-<", "M->", "C--", "<left>", "M-DEL", "S-<right>", "C-S-f", "C-M-S-<up>", "<wheel-down>", "C-<wheel-up>", "<f3>", "S-<f12>", "<mouse-1>", "<down-mouse-1>", "<drag-mouse-1>", "S-<mouse-1>", "<double-mouse-3>", "<triple-mouse-1>", "<tab-bar>"] {
            let key = Key::parse(s).unwrap_or_else(|| panic!("failed to parse {s}"));
            assert_eq!(key.to_string(), s);
        }
        assert_eq!(Key::parse("C-x"), Some(Key::char('x').ctrl()));
        assert_eq!(Key::parse("S-<right>"), Some(Key::new(KeyCode::Right).shift()));
        assert_eq!(Key::parse("S"), Some(Key::char('S')));
        assert_eq!(Key::parse("C-<return>"), Key::parse("C-RET"));
        assert_eq!(Key::parse("<backtab>"), Key::parse("S-TAB"));
        assert_eq!(Key::parse("M-"), None);
        assert_eq!(Key::parse("ab"), None);
    }

    #[test]
    fn a_name_that_is_no_key_of_its_own_is_a_symbol() {
        for s in ["<menu-bar>", "<file>", "<f0>", "<f36>", "<mouse-6>", "C-<menu-bar>"] {
            let key = Key::parse(s).unwrap_or_else(|| panic!("failed to parse {s}"));
            assert!(matches!(key.code, KeyCode::Symbol(_)), "{s} is {key:?}");
            assert_eq!(key.to_string(), s);
        }
        assert_eq!(Key::parse("<menu-bar>"), Key::parse("<menu-bar>"));
        assert_ne!(Key::parse("<menu-bar>"), Key::parse("<file>"));
        // A name that could not be read back as one key is not a symbol.
        assert_eq!(Key::parse("<a b>"), None);
        assert_eq!(Key::parse("<>"), None);
        assert_eq!(Key::parse_seq("<menu-bar> <file> o").unwrap().len(), 3);
    }

    #[test]
    fn parses_sequences() {
        let keys = Key::parse_seq("C-x  C-f").unwrap();
        assert_eq!(keys, vec![Key::char('x').ctrl(), Key::char('f').ctrl()]);
        assert_eq!(format_keys(&keys), "C-x C-f");
        assert_eq!(Key::parse_seq(""), None);
    }
}
