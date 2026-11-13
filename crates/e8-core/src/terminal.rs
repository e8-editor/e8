//! Terminals as objects, as Emacs's terminal.c has them: what a frame is
//! shown on, with a name, a kind and parameters a package can hang state
//! off. One editor draws through one front end, so E8 has one terminal,
//! where Emacs's daemon has one for each client ([ADR 0073](../../../docs/adr/0073-the-user-and-the-system-as-emacs-has-them.md)
//! says E8 has no daemon); `terminal-list` gives it alone (ADR 0077).

use std::collections::BTreeMap;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;
use crate::window::FrameId;

/// A terminal, by the number that names it, as Emacs's terminal objects
/// are numbered.
pub type TerminalId = u64;

/// The terminal every frame is on.
pub const THE_TERMINAL: TerminalId = 1;

/// What the editor knows about the display it draws on.
#[derive(Debug, Default)]
pub(crate) struct Terminal {
    /// The device it draws on, as `terminal-name` gives it: a tty's name
    /// where a front end said one.
    pub(crate) name: Option<String>,
    /// What `TERM` says, where there is a terminal to say it.
    pub(crate) tty_type: Option<String>,
    pub(crate) parameters: BTreeMap<String, Value>,
    /// Whether it has been deleted, as `terminal-live-p` asks.
    pub(crate) deleted: bool,
    /// Whether `suspend-tty` has let go of it.
    pub(crate) suspended: bool,
}

impl Editor {
    /// Every terminal there is, as `terminal-list`: one, unless it has
    /// been deleted.
    pub fn terminal_list(&self) -> Vec<TerminalId> {
        if self.terminal.deleted { Vec::new() } else { vec![THE_TERMINAL] }
    }

    /// What kind of display a terminal is, as `terminal-live-p` gives it:
    /// the same answer `framep` gives for a frame on it, and none for a
    /// terminal that has been deleted or a number that is no terminal.
    pub fn terminal_live_p(&self, terminal: TerminalId) -> Option<Value> {
        if terminal != THE_TERMINAL || self.terminal.deleted {
            return None;
        }
        Some(match self.window_system() {
            Some(system) => Value::Symbol(system.to_string()),
            None => Value::Bool(true),
        })
    }

    /// The terminal a frame is shown on, as `frame-terminal`.
    pub fn frame_terminal(&self, _frame: FrameId) -> TerminalId {
        THE_TERMINAL
    }

    /// The device a terminal draws on, as `terminal-name`.
    pub fn terminal_name(&self, terminal: TerminalId) -> Result<Option<String>> {
        self.live_terminal(terminal)?;
        Ok(self.terminal.name.clone())
    }

    /// Tells the editor what device it draws on and what `TERM` says,
    /// which a front end knows and it does not.
    pub fn set_terminal_device(&mut self, name: Option<String>, tty_type: Option<String>) {
        self.terminal.name = name;
        self.terminal.tty_type = tty_type;
    }

    /// Every parameter of a terminal, as `terminal-parameters`.
    pub fn terminal_parameters(&self, terminal: TerminalId) -> Result<Vec<(String, Value)>> {
        self.live_terminal(terminal)?;
        Ok(self.terminal.parameters.iter().map(|(n, v)| (n.clone(), v.clone())).collect())
    }

    /// One parameter of a terminal, as `terminal-parameter`.
    pub fn terminal_parameter(&self, terminal: TerminalId, name: &str) -> Result<Option<Value>> {
        self.live_terminal(terminal)?;
        Ok(self.terminal.parameters.get(name).cloned())
    }

    /// Sets one, as `set-terminal-parameter`, and gives back what it was.
    pub fn set_terminal_parameter(&mut self, terminal: TerminalId, name: &str, value: Value) -> Result<Option<Value>> {
        self.live_terminal(terminal)?;
        Ok(match value {
            Value::Null => self.terminal.parameters.remove(name),
            value => self.terminal.parameters.insert(name.to_string(), value),
        })
    }

    /// Deletes a terminal, as `delete-terminal`: E8 has one, so deleting
    /// it is refused unless `force` says otherwise, as Emacs refuses to
    /// delete the sole active display terminal. Forced, its frames go
    /// with it, which leaves the editor with nothing to draw on, so the
    /// editor is asked to quit, as deleting Emacs's last terminal ends it.
    pub fn delete_terminal(&mut self, terminal: TerminalId, force: bool) -> Result<()> {
        self.live_terminal(terminal)?;
        if !force {
            return Err(Error::new("Attempt to delete the sole active display terminal"));
        }
        self.terminal.deleted = true;
        self.quit = true;
        Ok(())
    }

    /// What `TERM` says, as `tty-type`; none in a window.
    pub fn tty_type(&self, terminal: TerminalId) -> Result<Option<String>> {
        self.live_terminal(terminal)?;
        Ok(if self.window_system().is_some() { None } else { self.terminal.tty_type.clone() })
    }

    /// Whether a terminal shows colours, as `tty-display-color-p`; nil in
    /// a window, which is no text terminal.
    pub fn tty_display_color_p(&self, terminal: TerminalId) -> Result<bool> {
        self.live_terminal(terminal)?;
        Ok(self.window_system().is_none() && self.display_color_cells() > 0)
    }

    /// How many colours a terminal shows, as `tty-display-color-cells`; 0
    /// in a window.
    pub fn tty_display_color_cells(&self, terminal: TerminalId) -> Result<usize> {
        self.live_terminal(terminal)?;
        Ok(if self.window_system().is_some() { 0 } else { self.display_color_cells() })
    }

    /// Whether a terminal is the one the editor was started from, as
    /// `controlling-tty-p`; nil in a window.
    pub fn controlling_tty_p(&self, terminal: TerminalId) -> Result<bool> {
        self.live_terminal(terminal)?;
        Ok(self.window_system().is_none() && !self.terminal.deleted)
    }

    /// Whether a terminal has been let go of, as `suspend-tty` leaves it.
    pub fn terminal_suspended(&self, terminal: TerminalId) -> Result<bool> {
        self.live_terminal(terminal)?;
        Ok(self.terminal.suspended)
    }

    /// Lets go of a terminal, as `suspend-tty`: the editor stops, as
    /// `suspend-emacs` stops it, and its frames are left as they are.
    /// Already let go of, nothing happens, as Emacs's does nothing.
    pub fn suspend_tty(&mut self, terminal: TerminalId) -> Result<bool> {
        self.live_terminal(terminal)?;
        if self.terminal.suspended {
            return Ok(false);
        }
        self.suspend_emacs()?;
        self.terminal.suspended = true;
        let _ = self.run_hooks("suspend-tty-functions");
        Ok(true)
    }

    /// Takes a terminal back, as `resume-tty`: the front end has it again
    /// once the editor is continued.
    pub fn resume_tty(&mut self, terminal: TerminalId) -> Result<bool> {
        self.live_terminal(terminal)?;
        if !self.terminal.suspended {
            return Ok(false);
        }
        self.terminal.suspended = false;
        let _ = self.run_hooks("resume-tty-functions");
        Ok(true)
    }

    /// How many colours the display shows, as a terminal's `TERM` says.
    fn display_color_cells(&self) -> usize {
        match self.terminal.tty_type.as_deref() {
            Some(name) if name.contains("truecolor") || name.contains("direct") => 16_777_216,
            Some(name) if name.contains("256") => 256,
            Some("dumb") | None => 0,
            Some(_) => 8,
        }
    }

    fn live_terminal(&self, terminal: TerminalId) -> Result<()> {
        if self.terminal_live_p(terminal).is_some() {
            return Ok(());
        }
        Err(Error::signal("wrong-type-argument", "Not a live terminal", vec![Value::Symbol("terminal-live-p".into())]))
    }
}
