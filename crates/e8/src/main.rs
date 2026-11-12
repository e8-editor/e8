//! The E8 terminal editor.
//!
//! Usage: `e8 [-q] [--print-types [DIR]] [FILE...]`, or
//! `e8 --batch [-L DIR | -l FILE | -f FUNCTION | --eval EXPRESSION]...`
//!
//! - `-q`, `--no-init`: do not load `init.ts`.
//! - `--print-types`: print the TypeScript declarations for the `e8` API
//!   (after loading `init.ts`, so its commands are included) and exit. With
//!   a directory, write them there instead, with the packages that ship with
//!   E8 in its `shipped/`, for a package's repository to check against.
//! - `--batch`: run without a terminal, as `emacs --batch`, doing what the
//!   arguments after it say in order ([`e8_script::batch`]).

mod ui;

use std::io::Write;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{env, io};

use e8_core::clicks::Clicks;
use e8_core::driver::{Driver, Input};
use e8_core::{Arg, Editor, Key, KeyCode, expand_file_name};
use e8_script::{config, type_definitions};
use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode as TermKey, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--batch") {
        let mut editor = Editor::new();
        std::process::exit(e8_script::batch::run(&mut editor, &args[1..]));
    }
    let (mut no_init, mut print_types, mut types_dir, mut files) = (false, false, None, Vec::new());
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-q" | "--no-init" => no_init = true,
            "--print-types" => {
                print_types = true;
                types_dir = args.next();
            }
            _ => files.push(arg),
        }
    }

    if print_types {
        let mut editor = Editor::new();
        let _scripting = config::setup_with(&mut editor, !no_init, e8_agent::install);
        match types_dir {
            Some(dir) => config::write_declarations(&editor, std::path::Path::new(&dir))?,
            None => print!("{}", type_definitions(&editor)),
        }
        return Ok(());
    }

    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;
    // The editor runs on a thread of its own; this one reads the terminal
    // and draws what the editor last published, so a long command never
    // stops the screen updating, and C-g reaches it.
    let size = terminal.size()?;
    let size = Arc::new(Mutex::new((size.width, size.height)));
    let laid_out = size.clone();
    // One channel brings this thread what it waits for: the terminal's
    // input, a new frame, and an agent's request, so it waits without polling.
    let (wake, woken) = channel();
    let published = wake.clone();
    let driver = Driver::spawn(
        move |editor| {
            let scripting = config::setup_with(editor, !no_init, e8_agent::install);
            for file in files {
                if let Err(e) = editor.call("find-file", vec![Arg::Str(expand_file_name(&file).display().to_string())]) {
                    editor.message(e.to_string());
                }
            }
            Box::new(scripting)
        },
        move |editor| {
            let (width, height) = *laid_out.lock().unwrap_or_else(|e| e.into_inner());
            ui::layout_windows(editor, width, height);
            editor.redisplay();
            vec![ui::describe(editor)]
        },
        move || {
            let _ = published.send(Wake::Frame);
        },
    );
    let input = wake.clone();
    std::thread::spawn(move || {
        while let Ok(event) = event::read() {
            if input.send(Wake::Terminal(event)).is_err() {
                return;
            }
        }
    });
    // An agent reaches this editor through e8-mcp, by a socket only this
    // user can open, as it reaches the GUI's.
    let requests = {
        let wake = wake.clone();
        e8_mcp::socket::listen(&e8_mcp::socket::default_path(), move || {
            let _ = wake.send(Wake::Request);
        })
    };
    let requests = match requests {
        Ok(requests) => {
            // So agent-shell can give its agents this editor (e8-mcp --socket).
            let path = e8_mcp::socket::default_path().display().to_string();
            driver.run(move |editor| editor.set_variable("e8-mcp-socket", e8_core::Value::Str(path)));
            Some(requests)
        }
        Err(e) => {
            driver.run(move |editor| editor.message(format!("No agent socket: {e}")));
            None
        }
    };
    let result = run(&mut terminal, &driver, &size, &woken, requests.as_ref());
    drop(driver);
    execute!(io::stdout(), DisableMouseCapture)?;
    ratatui::restore();
    result
}

/// What the terminal's thread waits for.
enum Wake {
    Terminal(Event),
    /// The editor published a frame.
    Frame,
    /// An agent's request waits on the socket.
    Request,
}

fn run(
    terminal: &mut DefaultTerminal,
    driver: &Driver,
    size: &Mutex<(u16, u16)>,
    woken: &Receiver<Wake>,
    requests: Option<&Receiver<e8_mcp::socket::Request>>,
) -> io::Result<()> {
    let mouse = Arc::new(Mutex::new(Mouse::default()));
    let client = Arc::new(Mutex::new(e8_mcp::Client::default()));
    let mut drawn = 0;
    let mut suspended = 0;
    loop {
        // What the editor last published, whatever it is doing now.
        let (description, bell, suspend) = {
            let mut published = driver.published();
            if published.exit {
                return Ok(());
            }
            let suspend = published.suspends != suspended;
            suspended = published.suspends;
            // Drawn again in full once the shell continues E8.
            let fresh = published.generation != drawn || suspend;
            drawn = published.generation;
            let bell = std::mem::take(&mut published.bell).then_some(published.visible_bell);
            (published.frames.first().filter(|_| fresh).cloned(), bell, suspend)
        };
        if suspend {
            // As Emacs's suspend-emacs: the terminal as the shell left it,
            // stopped until fg, then E8's screen again.
            // The same terminal kept: making it again would ask the
            // terminal where its cursor is, which the input thread reads.
            // Failures here are not fatal: losing unsaved work to one
            // would be worse than a screen to redraw.
            let _ = execute!(io::stdout(), DisableMouseCapture, ratatui::crossterm::terminal::LeaveAlternateScreen);
            let _ = ratatui::crossterm::terminal::disable_raw_mode();
            e8_core::users::stop_self();
            let _ = ratatui::crossterm::terminal::enable_raw_mode();
            let _ = execute!(
                io::stdout(),
                ratatui::crossterm::terminal::EnterAlternateScreen,
                EnableMouseCapture,
                ratatui::crossterm::terminal::Clear(ratatui::crossterm::terminal::ClearType::All)
            );
            // The terminal may have been resized meanwhile, which no
            // signal says while stopped, as Emacs reads its size again.
            if let Ok((width, height)) = ratatui::crossterm::terminal::size() {
                *size.lock().unwrap_or_else(|e| e.into_inner()) = (width, height);
                driver.send(Input::Wake);
            }
            // A blank frame, so the next is drawn whole: ratatui's own
            // clear asks the terminal where its cursor is too.
            let _ = terminal.draw(|frame| frame.render_widget(ratatui::widgets::Clear, frame.area()));
            driver.run(|editor| {
                if let Err(e) = editor.run_hooks("suspend-resume-hook") {
                    editor.message(format!("Error in suspend-resume-hook: {e}"));
                }
            });
        }
        if let Some(description) = description {
            terminal.draw(|frame| ui::draw(frame, &description))?;
        }
        if let Some(visible) = bell {
            ring_bell(visible)?;
        }
        let Ok(wake) = woken.recv() else { return Ok(()) };
        let event = match wake {
            Wake::Terminal(event) => event,
            Wake::Frame => continue,
            Wake::Request => {
                // Each answered on the editor's thread, with its scripts.
                for request in requests.into_iter().flat_map(|r| r.try_iter()) {
                    let client = client.clone();
                    driver.send(Input::Run(Box::new(move |editor, keep| {
                        let scripting = keep.downcast_ref::<Option<e8_script::Scripting>>().and_then(Option::as_ref);
                        let mut client = client.lock().unwrap_or_else(|e| e.into_inner());
                        let reply = e8_mcp::handle_client_message(editor, scripting, &request.line, &mut client);
                        let _ = request.reply.send(reply);
                    })));
                }
                continue;
            }
        };
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if let Some(key) = convert_key(key) {
                    driver.key(key);
                }
            }
            Event::Mouse(event) => {
                let (width, height) = *size.lock().unwrap_or_else(|e| e.into_inner());
                let mouse = mouse.clone();
                driver.run(move |editor| {
                    mouse.lock().unwrap_or_else(|e| e.into_inner()).handle(editor, event, width, height);
                });
            }
            Event::Resize(width, height) => {
                *size.lock().unwrap_or_else(|e| e.into_inner()) = (width, height);
                driver.send(Input::Wake);
            }
            _ => {}
        }
    }
}

/// The bell: the terminal's own, or with visible-bell its flash, as Emacs
/// on a terminal rings it.
fn ring_bell(visible: bool) -> io::Result<()> {
    let mut out = io::stdout();
    out.write_all(if visible { b"\x1b[?5h" } else { b"\x07" })?;
    out.flush()?;
    if visible {
        std::thread::sleep(std::time::Duration::from_millis(50));
        out.write_all(b"\x1b[?5l")?;
        out.flush()?;
    }
    Ok(())
}

/// Lines a wheel notch scrolls in a terminal.
const WHEEL_LINES: isize = 3;

/// Turns the terminal's mouse reports into Emacs's mouse keys.
struct Mouse {
    /// Clicks over the text, as both front ends count them, by cell.
    clicks: Clicks<(u16, u16)>,
    /// What the clicks' times count from.
    started: Instant,
}

impl Default for Mouse {
    fn default() -> Mouse {
        Mouse { clicks: Clicks::default(), started: Instant::now() }
    }
}

impl Mouse {
    fn handle(&mut self, ed: &mut Editor, event: ratatui::crossterm::event::MouseEvent, width: u16, height: u16) {
        // A press on the tab bar is a click on it, at its column.
        if event.row < ed.tab_bar_lines(ed.selected_frame()) as u16 && !self.clicks.is_down() {
            if event.kind == MouseEventKind::Down(MouseButton::Left) {
                let frame = ed.selected_frame();
                ed.tab_bar_mouse(frame, event.column as usize, Key::new(e8_core::KeyCode::Mouse(e8_core::MouseKind::Click, 1)));
            }
            return;
        }
        let target = ui::mouse_target(ed, width, height, event.column, event.row);
        let shift = event.modifiers.contains(KeyModifiers::SHIFT);
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(target) = target else { return };
                let time = self.started.elapsed().as_secs_f64();
                self.clicks.press(ed, time, (event.column, event.row), |a, b| a == b, target, shift);
            }
            MouseEventKind::Drag(MouseButton::Left) => self.clicks.moved(ed, target, shift),
            MouseEventKind::Up(MouseButton::Left) => self.clicks.release(ed, target, shift),
            MouseEventKind::ScrollDown => ed.wheel_in(target.map(|t| t.0), WHEEL_LINES),
            MouseEventKind::ScrollUp => ed.wheel_in(target.map(|t| t.0), -WHEEL_LINES),
            _ => {}
        }
    }
}

/// Translates a terminal key event into the core's key type.
fn convert_key(event: KeyEvent) -> Option<Key> {
    let ctrl = event.modifiers.contains(KeyModifiers::CONTROL);
    let meta = event.modifiers.contains(KeyModifiers::ALT);
    let shift = event.modifiers.contains(KeyModifiers::SHIFT);
    let (code, shift) = match event.code {
        TermKey::Char(c) if ctrl => {
            let c = match c {
                // Terminals send C-/ and C-_ as 0x1f, which crossterm reports as C-7;
                // 0x1c to 0x1e arrive as C-4 to C-6 the same way.
                '7' => '/',
                '4' => '\\',
                '5' => ']',
                '6' => '^',
                c => c,
            };
            // A shifted letter in a chord is written C-S-f, as in Emacs.
            (KeyCode::Char(c.to_ascii_lowercase()), c.is_ascii_uppercase() || (shift && c.is_ascii_alphabetic()))
        }
        TermKey::Char(c) if meta && c.is_ascii_uppercase() => (KeyCode::Char(c.to_ascii_lowercase()), true),
        // Shift on a plain character is part of the character.
        TermKey::Char(c) => (KeyCode::Char(c), false),
        TermKey::BackTab => (KeyCode::Tab, true),
        code => (special_key(code)?, shift),
    };
    Some(Key { code, ctrl, meta, shift })
}

fn special_key(code: TermKey) -> Option<KeyCode> {
    Some(match code {
        TermKey::Enter => KeyCode::Enter,
        TermKey::Tab => KeyCode::Tab,
        TermKey::Backspace => KeyCode::Backspace,
        TermKey::Delete => KeyCode::Delete,
        TermKey::Insert => KeyCode::Insert,
        TermKey::Esc => KeyCode::Esc,
        TermKey::Left => KeyCode::Left,
        TermKey::Right => KeyCode::Right,
        TermKey::Up => KeyCode::Up,
        TermKey::Down => KeyCode::Down,
        TermKey::Home => KeyCode::Home,
        TermKey::End => KeyCode::End,
        TermKey::PageUp => KeyCode::PageUp,
        TermKey::PageDown => KeyCode::PageDown,
        TermKey::F(n) => KeyCode::F(n),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: TermKey, modifiers: KeyModifiers) -> String {
        convert_key(KeyEvent::new(code, modifiers)).map(|k| k.to_string()).unwrap_or_default()
    }

    #[test]
    fn converts_terminal_keys() {
        assert_eq!(key(TermKey::Char('x'), KeyModifiers::CONTROL), "C-x");
        assert_eq!(key(TermKey::Char('7'), KeyModifiers::CONTROL), "C-/");
        assert_eq!(key(TermKey::Char('A'), KeyModifiers::SHIFT), "A");
        assert_eq!(key(TermKey::Char('<'), KeyModifiers::ALT), "M-<");
        assert_eq!(key(TermKey::Right, KeyModifiers::SHIFT), "S-<right>");
        assert_eq!(key(TermKey::Char('F'), KeyModifiers::CONTROL | KeyModifiers::SHIFT), "C-S-f");
        assert_eq!(key(TermKey::Char('F'), KeyModifiers::ALT), "M-S-f");
    }
}
