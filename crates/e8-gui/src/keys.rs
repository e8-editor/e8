//! Translates egui input events into editor keys.
//!
//! - Plain characters arrive as text events, so keyboard layouts and dead keys work.
//! - Keys with Ctrl or Meta arrive as key events. Alt is Meta, as in Emacs; on
//!   macOS that is Option, and the character Option would have typed (Option-x
//!   types ≈) is dropped.
//! - Cmd on macOS is left to the system and egui (Cmd-V pastes, Cmd-Q quits).
//! - Elsewhere egui turns Ctrl-X, Ctrl-C and Ctrl-V into cut, copy and paste
//!   events. Those are C-x, C-c and C-v in Emacs, so they are turned back.

use e8_core::{Key, KeyCode};
use egui::{Event, Key as EguiKey, Modifiers};

/// Something the editor should handle.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Key(Key),
    /// A command the system's own keys stand for, as the Mac's ⌘C, ⌘X and
    /// ⌘V copy, cut and paste through the kill ring in Emacs.
    Command(&'static str),
}

/// Translates one frame's events. `mac` selects the macOS conventions above.
pub fn translate(events: &[Event], mac: bool) -> Vec<Input> {
    let mut out = Vec::new();
    // The text event that follows an Option or Alt chord on macOS.
    let mut skip_text = false;
    // In a browser the text comes before the chord's key event instead:
    // where the text just before began, to take it back.
    let mut text_from: Option<usize> = None;
    for event in events {
        match event {
            Event::Key { key, pressed: true, modifiers, .. } => {
                if let Some(k) = key_event(*key, *modifiers) {
                    if cfg!(target_arch = "wasm32") && modifiers.alt
                        && let Some(from) = text_from
                    {
                        out.truncate(from);
                    }
                    out.push(Input::Key(k));
                    skip_text = modifiers.alt && !cfg!(target_arch = "wasm32");
                }
                text_from = None;
            }
            Event::Text(text) => {
                if std::mem::take(&mut skip_text) {
                    continue;
                }
                text_from = Some(out.len());
                out.extend(text.chars().map(|c| Input::Key(Key::char(c))));
            }
            Event::Cut if !mac => out.push(Input::Key(Key::char('x').ctrl())),
            Event::Copy if !mac => out.push(Input::Key(Key::char('c').ctrl())),
            Event::Paste(_) if !mac => out.push(Input::Key(Key::char('v').ctrl())),
            // As Emacs's ns-win.el binds s-c, s-x and s-v: the kill ring and
            // the system clipboard are one, so yanking pastes what another
            // program copied.
            Event::Copy => out.push(Input::Command("kill-ring-save")),
            Event::Cut => out.push(Input::Command("kill-region")),
            Event::Paste(_) => out.push(Input::Command("yank")),
            _ => {}
        }
    }
    out
}

fn key_event(key: EguiKey, modifiers: Modifiers) -> Option<Key> {
    if modifiers.mac_cmd {
        return None;
    }
    let (ctrl, meta) = (modifiers.ctrl, modifiers.alt);
    let (code, shift) = match special(key) {
        Some(code) => (code, modifiers.shift),
        // Plain characters come as text events instead.
        None if !ctrl && !meta => return None,
        None => {
            let c = character(key, modifiers.shift)?;
            // A letter in a chord keeps Shift as a modifier, as Emacs writes
            // C-S-f; Shift on punctuation is part of the character, as in M-<.
            if c.is_ascii_alphabetic() {
                (KeyCode::Char(c.to_ascii_lowercase()), modifiers.shift)
            } else {
                (KeyCode::Char(c), false)
            }
        }
    };
    Some(Key { code, ctrl, meta, shift })
}

fn special(key: EguiKey) -> Option<KeyCode> {
    Some(match key {
        EguiKey::Enter => KeyCode::Enter,
        EguiKey::Tab => KeyCode::Tab,
        EguiKey::Backspace => KeyCode::Backspace,
        EguiKey::Delete => KeyCode::Delete,
        EguiKey::Insert => KeyCode::Insert,
        EguiKey::Escape => KeyCode::Esc,
        EguiKey::ArrowLeft => KeyCode::Left,
        EguiKey::ArrowRight => KeyCode::Right,
        EguiKey::ArrowUp => KeyCode::Up,
        EguiKey::ArrowDown => KeyCode::Down,
        EguiKey::Home => KeyCode::Home,
        EguiKey::End => KeyCode::End,
        EguiKey::PageUp => KeyCode::PageUp,
        EguiKey::PageDown => KeyCode::PageDown,
        key => return function_key(key).map(KeyCode::F),
    })
}

/// The number of a function key, from F1 to F35.
fn function_key(key: EguiKey) -> Option<u8> {
    let n: u8 = key.name().strip_prefix('F')?.parse().ok()?;
    (1..=35).contains(&n).then_some(n)
}

/// The character a key types, with Shift applied for a US layout. egui
/// reports Shift-comma as comma, so M-< has to be worked out here.
fn character(key: EguiKey, shift: bool) -> Option<char> {
    let name = key.name();
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && c.is_ascii_alphabetic()
    {
        return Some(if shift { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() });
    }
    let (plain, shifted) = match key {
        EguiKey::Space => (' ', ' '),
        EguiKey::Num0 => ('0', ')'),
        EguiKey::Num1 => ('1', '!'),
        EguiKey::Num2 => ('2', '@'),
        EguiKey::Num3 => ('3', '#'),
        EguiKey::Num4 => ('4', '$'),
        EguiKey::Num5 => ('5', '%'),
        EguiKey::Num6 => ('6', '^'),
        EguiKey::Num7 => ('7', '&'),
        EguiKey::Num8 => ('8', '*'),
        EguiKey::Num9 => ('9', '('),
        EguiKey::Comma => (',', '<'),
        EguiKey::Period => ('.', '>'),
        EguiKey::Slash => ('/', '?'),
        EguiKey::Semicolon => (';', ':'),
        EguiKey::Quote => ('\'', '"'),
        EguiKey::OpenBracket => ('[', '{'),
        EguiKey::CloseBracket => (']', '}'),
        EguiKey::Backslash => ('\\', '|'),
        EguiKey::Backtick => ('`', '~'),
        EguiKey::Minus => ('-', '_'),
        EguiKey::Equals => ('=', '+'),
        EguiKey::Plus => ('+', '+'),
        EguiKey::Colon => (':', ':'),
        EguiKey::Pipe => ('|', '|'),
        EguiKey::Questionmark => ('?', '?'),
        EguiKey::Exclamationmark => ('!', '!'),
        EguiKey::OpenCurlyBracket => ('{', '{'),
        EguiKey::CloseCurlyBracket => ('}', '}'),
        _ => return None,
    };
    Some(if shift { shifted } else { plain })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(key: EguiKey, modifiers: Modifiers) -> Event {
        Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers }
    }

    fn keys(events: &[Event], mac: bool) -> String {
        translate(events, mac)
            .iter()
            .map(|i| match i {
                Input::Key(k) => k.to_string(),
                Input::Command(name) => format!("command:{name}"),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    const CTRL: Modifiers = Modifiers::CTRL;
    const ALT: Modifiers = Modifiers::ALT;

    #[test]
    fn plain_text_comes_from_text_events() {
        let events = [press(EguiKey::A, Modifiers::NONE), Event::Text("a".into())];
        assert_eq!(keys(&events, true), "a");
        assert_eq!(keys(&[Event::Text("é ".into())], false), "é SPC");
    }

    #[test]
    fn control_and_meta_chords() {
        assert_eq!(keys(&[press(EguiKey::X, CTRL), press(EguiKey::F, CTRL)], true), "C-x C-f");
        assert_eq!(keys(&[press(EguiKey::Space, CTRL)], true), "C-SPC");
        assert_eq!(keys(&[press(EguiKey::Slash, CTRL)], true), "C-/");
        let shift_alt = Modifiers { alt: true, shift: true, ..Default::default() };
        assert_eq!(keys(&[press(EguiKey::Comma, shift_alt)], true), "M-<");
        assert_eq!(keys(&[press(EguiKey::Enter, Modifiers::NONE)], true), "RET");
        assert_eq!(keys(&[press(EguiKey::Backspace, ALT)], true), "M-DEL");
        assert_eq!(keys(&[press(EguiKey::F3, Modifiers::NONE)], true), "<f3>");
    }

    #[test]
    fn shift_is_kept_for_selection() {
        assert_eq!(keys(&[press(EguiKey::ArrowRight, Modifiers::SHIFT)], true), "S-<right>");
        let ctrl_shift = Modifiers { ctrl: true, shift: true, ..Default::default() };
        assert_eq!(keys(&[press(EguiKey::F, ctrl_shift)], true), "C-S-f");
        assert_eq!(keys(&[press(EguiKey::End, ctrl_shift)], true), "C-S-<end>");
    }

    #[test]
    fn option_drops_the_character_it_would_type() {
        let events = [press(EguiKey::X, ALT), Event::Text("≈".into()), Event::Text("y".into())];
        assert_eq!(keys(&events, true), "M-x y");
    }

    #[test]
    fn cut_copy_paste_events_are_emacs_keys_off_macos_and_commands_on_it() {
        let events = [Event::Cut, Event::Copy, Event::Paste("clip".into())];
        assert_eq!(keys(&events, false), "C-x C-c C-v");
        assert_eq!(keys(&events, true), "command:kill-region command:kill-ring-save command:yank");
    }

    #[test]
    fn cmd_is_left_to_the_system() {
        let cmd = Modifiers { mac_cmd: true, command: true, ..Default::default() };
        assert_eq!(keys(&[press(EguiKey::Q, cmd)], true), "");
    }
}
