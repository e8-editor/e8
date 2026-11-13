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

    /// The terminal a number names: the terminal itself, or a frame on
    /// it, as Emacs's `decode_terminal` takes a terminal or a frame. A
    /// frame that has been deleted is on no terminal, as its own is gone.
    pub fn terminal_named(&self, id: TerminalId) -> Option<TerminalId> {
        let live = if id >= crate::window::FIRST_FRAME { self.frame_list().contains(&id) } else { id == THE_TERMINAL };
        (live && !self.terminal.deleted).then_some(THE_TERMINAL)
    }

    /// What kind of display a terminal is, as `terminal-live-p` gives it:
    /// the same answer `framep` gives for a frame on it, and none for a
    /// terminal that has been deleted or a number that is no terminal.
    pub fn terminal_live_p(&self, terminal: TerminalId) -> Option<Value> {
        self.terminal_named(terminal)?;
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
        // Nil is stored like any value, as store_terminal_param stores
        // it: a parameter set to nil is not a parameter never set.
        Ok(self.terminal.parameters.insert(name.to_string(), value))
    }

    /// Deletes a terminal, as `delete-terminal`: E8 has one, so deleting
    /// it is refused unless `force` says otherwise, as Emacs refuses to
    /// delete the sole active display terminal. Forced, its frames go
    /// with it, which leaves the editor with nothing to draw on, so the
    /// editor is asked to quit, as deleting Emacs's last terminal ends it.
    pub fn delete_terminal(&mut self, terminal: TerminalId, force: bool) -> Result<()> {
        // A terminal already deleted is nothing to do, as
        // `Fdelete_terminal` gives nil for one it cannot decode.
        let Some(terminal) = self.terminal_named(terminal) else { return Ok(()) };
        if !force {
            return Err(Error::new("Attempt to delete the sole active display terminal"));
        }
        let _ = self.run_hook_with_args("delete-terminal-functions", &[Value::Terminal(terminal)]);
        // Its frames go with it, as delete_terminal deletes every frame
        // on it; the last goes as the editor exits, which it now will.
        for frame in self.frame_list() {
            if self.frame_list().len() > 1 {
                let _ = self.delete_frame(Some(frame));
            }
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
        // A terminal to be the controlling one, as decode_tty_terminal
        // asks for: a headless editor and a window have none.
        Ok(self.window_system().is_none() && self.terminal.name.is_some())
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
        // The hook runs first, as term.c's does, since it may want the
        // tty as it still is; an error in it stops the suspend.
        self.run_hook_with_args("suspend-tty-functions", &[Value::Terminal(THE_TERMINAL)])?;
        self.suspend_emacs()?;
        self.terminal.suspended = true;
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
        self.run_hook_with_args("resume-tty-functions", &[Value::Terminal(THE_TERMINAL)])?;
        Ok(true)
    }

    /// The editor is drawing again after being stopped, which a front end
    /// says when the shell continues it: the terminal is the editor's
    /// again, and `suspend-resume-hook` runs.
    pub fn resumed_from_suspend(&mut self) -> Result<()> {
        if self.terminal.suspended {
            self.terminal.suspended = false;
            let _ = self.run_hook_with_args("resume-tty-functions", &[Value::Terminal(THE_TERMINAL)]);
        }
        self.run_hooks("suspend-resume-hook")
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

    /// The one terminal, checked live, as `decode_live_terminal` does.
    fn live_terminal(&self, terminal: TerminalId) -> Result<()> {
        if self.terminal_live_p(terminal).is_some() {
            return Ok(());
        }
        Err(Error::signal("wrong-type-argument", "Not a live terminal", vec![Value::Symbol("terminal-live-p".into())]))
    }
}
