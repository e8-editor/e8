//! Frames as the front end's windows, as Emacs's frame.c has them: how
//! big the whole of one is and where it sits on the screen, the widths of
//! what is drawn around its text, and which frame a frame's keys go to.
//!
//! A frame's size in the front end's units is what the editor lays its
//! windows out in ([ADR 0069](../../../docs/adr/0069-windows-as-emacs-has-them.md)).
//! What is outside that — the whole frame, its place on the screen — only
//! the front end knows, so it writes it in as it draws, as it writes
//! where the pointer is ([ADR 0074](../../../docs/adr/0074-mouse-events-as-emacs-has-them.md)),
//! and asking a frame to move or to change size leaves a request the
//! front end carries out (ADR 0077).

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;
use crate::window::FrameId;

/// What a front end knows about a frame and the editor does not.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameGeometry {
    /// The whole frame, its border and bars included, in the front end's
    /// units, as Emacs's native size. On a terminal, its characters.
    pub native: (f32, f32),
    /// Its top left on the screen, in the front end's units.
    pub position: (f32, f32),
    /// How many of the screen's own pixels one of the front end's units
    /// is, as `frame-scale-factor`.
    pub scale: f32,
}

impl Default for FrameGeometry {
    fn default() -> FrameGeometry {
        FrameGeometry { native: (0.0, 0.0), position: (0.0, 0.0), scale: 1.0 }
    }
}

/// What code has asked a front end to do to a frame, which it does as it
/// draws, as it carries out a pointer warp.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FrameRequest {
    /// Put the frame's top left here on the screen, in the front end's units.
    Position { frame: FrameId, x: f64, y: f64 },
    /// Make the frame's text area this big, in the front end's units.
    Size { frame: FrameId, width: f64, height: f64 },
    /// Put the frame behind the others, as `lower-frame`.
    Lower { frame: FrameId },
}

impl Editor {
    /// What a front end has told the editor about a frame.
    pub fn frame_geometry(&self, frame: FrameId) -> FrameGeometry {
        self.frame_geometries.get(&frame).copied().unwrap_or_default()
    }

    /// Tells the editor how big a frame is as a whole and where it is on
    /// the screen; a front end calls this as it lays the frame out.
    pub fn set_frame_geometry(&mut self, frame: FrameId, geometry: FrameGeometry) {
        self.frame_geometries.insert(frame, geometry);
    }

    /// The size of the frame's text area, in the front end's units, as
    /// `frame-text-width` and `frame-text-height`: everything the frame
    /// holds but the border around it — its windows, the echo area and
    /// its bars, as Emacs's text height holds the minibuffer window.
    pub fn frame_text_size(&self, frame: FrameId) -> (usize, usize) {
        let (width, height) = self.frame_units_of(frame);
        (width, height + self.frame_outside_windows(frame))
    }

    /// How much of a frame, in the front end's units, its text area holds
    /// beside the windows: the echo area and the bars above them.
    fn frame_outside_windows(&self, frame: FrameId) -> usize {
        let lines = self.menu_bar_lines(frame) + self.tab_bar_lines(frame) + self.frame_echo_lines(frame);
        (lines as f32 * self.cell().1) as usize
    }

    /// How many lines a frame's echo area takes.
    fn frame_echo_lines(&self, frame: FrameId) -> usize {
        if frame == self.selected_frame() { self.mini_window_lines().max(1) } else { 1 }
    }

    /// The size of the whole frame, in the front end's units, as
    /// `frame-native-width` and `frame-native-height`. A terminal's is its
    /// characters, as Emacs's is; a front end that has said nothing gives
    /// the text size.
    pub fn frame_native_size(&self, frame: FrameId) -> (usize, usize) {
        let native = self.frame_geometry(frame).native;
        if native.0 > 0.0 && native.1 > 0.0 {
            return (native.0 as usize, native.1 as usize);
        }
        self.frame_text_size(frame)
    }

    /// Where a frame's top left corner is on the screen, in the front
    /// end's units, as `frame-position`.
    pub fn frame_position(&self, frame: FrameId) -> (i64, i64) {
        let at = self.frame_geometry(frame).position;
        (at.0 as i64, at.1 as i64)
    }

    /// How many of the screen's pixels one of the front end's units is, as
    /// `frame-scale-factor`.
    pub fn frame_scale_factor(&self, frame: FrameId) -> f64 {
        self.frame_geometry(frame).scale as f64
    }

    /// Asks the front end to put a frame's top left corner there, as
    /// `set-frame-position`.
    pub fn request_frame_position(&mut self, frame: FrameId, x: f64, y: f64) -> Result<()> {
        self.live_frame(frame)?;
        self.ask_front_end(FrameRequest::Position { frame, x, y });
        Ok(())
    }

    /// Asks the front end to make a frame's text area that big, as
    /// `set-frame-size`: in the front end's units, or in characters, which
    /// are turned into them, as Emacs's PIXELWISE does.
    pub fn request_frame_size(&mut self, frame: FrameId, width: f64, height: f64, pixelwise: bool) -> Result<()> {
        self.live_frame(frame)?;
        let (cw, ch) = self.cell();
        let (width, height) = if pixelwise { (width, height) } else { (width * cw as f64, height * ch as f64) };
        self.ask_front_end(FrameRequest::Size { frame, width, height });
        Ok(())
    }

    /// Asks the front end to put a frame behind the others, as
    /// `lower-frame`. The frames' order is left alone, as `Flower_frame`
    /// leaves `frame-list` alone, so `other-frame` still goes round them
    /// in the order they were made.
    pub fn lower_frame(&mut self, frame: FrameId) -> Result<()> {
        self.live_frame(frame)?;
        self.ask_front_end(FrameRequest::Lower { frame });
        Ok(())
    }

    /// Keeps what a front end has been asked to do, dropping the oldest
    /// where no front end is taking them, as a headless editor's never
    /// does, so a script asking again and again cannot fill memory.
    fn ask_front_end(&mut self, request: FrameRequest) {
        const MOST: usize = 64;
        self.frame_requests.push(request);
        if self.frame_requests.len() > MOST {
            let over = self.frame_requests.len() - MOST;
            self.frame_requests.drain(..over);
        }
    }

    /// What front ends have been asked to do to frames since they last
    /// asked, as `take_warps` gives the pointer's.
    pub fn take_frame_requests(&mut self) -> Vec<FrameRequest> {
        std::mem::take(&mut self.frame_requests)
    }

    fn live_frame(&self, frame: FrameId) -> Result<()> {
        if self.frame_order.contains(&frame) {
            return Ok(());
        }
        Err(Error::new("No such frame"))
    }

    /// The width of the border a frame draws around its windows, as
    /// `frame-internal-border-width`; none in E8.
    pub fn frame_internal_border_width(&self) -> usize {
        0
    }

    /// The width of both of a window's fringes together, as
    /// `frame-fringe-width`: none on a terminal.
    pub fn frame_fringe_width(&self) -> usize {
        self.text_metrics().window_chrome().fringes as usize
    }

    /// The width of a frame's scroll bars, as `frame-scroll-bar-width`:
    /// none, E8 drawing no scroll bars.
    pub fn frame_scroll_bar_width(&self) -> usize {
        0
    }

    /// The height of a frame's horizontal scroll bars, as
    /// `frame-scroll-bar-height`: none.
    pub fn frame_scroll_bar_height(&self) -> usize {
        0
    }

    /// The width of the divider between windows side by side, as
    /// `frame-right-divider-width`, and of the one below a window, as
    /// `frame-bottom-divider-width`: a frame's parameters, 0 unless set,
    /// as Emacs's are. A terminal's vertical border between windows is
    /// not a divider, and is not counted here, as Emacs does not count it.
    pub fn frame_divider_width(&self, frame: FrameId, bottom: bool) -> usize {
        let name = if bottom { "bottom-divider-width" } else { "right-divider-width" };
        match self.frame_parameter(frame, name) {
            Some(Value::Number(n)) if n > 0.0 => n as usize,
            _ => 0,
        }
    }

    /// Where a frame's keys go, as `frame-focus`: the frame
    /// `redirect-frame-focus` named, or none.
    pub fn frame_focus(&self, frame: FrameId) -> Option<FrameId> {
        self.frame_focus.get(&frame).copied()
    }

    /// Moves to `now` every redirection that pointed at `was`, as
    /// `do_switch_frame` does when another frame is selected: a frame
    /// borrowing the selected frame's minibuffer borrows the new one's.
    pub(crate) fn follow_selected_frame(&mut self, was: FrameId, now: FrameId) {
        for (from, to) in self.frame_focus.iter_mut() {
            if *to == was && *from != now {
                *to = now;
            }
        }
        self.frame_focus.retain(|from, to| from != to);
    }

    /// Sends a frame's keys to another, as `redirect-frame-focus`; with
    /// none, the frame has its own keys again. The frame itself need not
    /// be live, as frame.c's does not check: a frame about to be deleted
    /// may give its keys away.
    pub fn redirect_frame_focus(&mut self, frame: FrameId, to: Option<FrameId>) -> Result<()> {
        match to {
            Some(to) => {
                self.live_frame(to)?;
                self.frame_focus.insert(frame, to);
            }
            None => {
                self.frame_focus.remove(&frame);
            }
        }
        Ok(())
    }

    /// The frame selected when the windows last changed, as
    /// `old-selected-frame`.
    pub fn old_selected_frame(&self) -> Option<FrameId> {
        self.old_selected_frame
    }

    /// Whether a frame's window state change flag is set, as
    /// `frame-window-state-change`, so that redisplay runs
    /// `window-state-change-functions` for it however little changed.
    pub fn frame_window_state_change(&self, frame: FrameId) -> bool {
        self.frame_state_changes.contains(&frame)
    }

    /// Sets or clears that flag, as `set-frame-window-state-change`.
    pub fn set_frame_window_state_change(&mut self, frame: FrameId, changed: bool) -> Result<()> {
        self.live_frame(frame)?;
        if changed {
            if !self.frame_state_changes.contains(&frame) {
                self.frame_state_changes.push(frame);
            }
        } else {
            self.frame_state_changes.retain(|f| *f != frame);
        }
        Ok(())
    }

    /// Whether a frame is an ancestor of another, as `frame-ancestor-p`:
    /// never, E8 having no child frames.
    pub fn frame_ancestor_p(&self, _ancestor: FrameId, _descendant: FrameId) -> bool {
        false
    }

    /// Every parameter of a frame, as `frame-parameters`: those set on it,
    /// and those the editor works out, which Emacs keeps among them too.
    pub fn frame_parameters(&self, frame: FrameId) -> Vec<(String, Value)> {
        let (width, height) = self.frame_units_of(frame);
        let (columns, lines) = (self.units_to_cells(width as f32, true), self.units_to_cells(height as f32, false));
        let (left, top) = self.frame_position(frame);
        let mut out: Vec<(String, Value)> = vec![
            ("width".to_string(), Value::Number(columns as f64)),
            ("height".to_string(), Value::Number(lines as f64)),
            ("left".to_string(), Value::Number(left as f64)),
            ("top".to_string(), Value::Number(top as f64)),
            ("name".to_string(), Value::Str(self.frame_title(frame).unwrap_or_default())),
            ("visibility".to_string(), self.frame_visibility(frame)),
            ("menu-bar-lines".to_string(), Value::Number(self.menu_bar_lines(frame) as f64)),
            ("tab-bar-lines".to_string(), Value::Number(self.tab_bar_lines(frame) as f64)),
            ("parent-frame".to_string(), Value::Null),
        ];
        // What the editor works out wins over what was set, as
        // `Fframe_parameters` stores it over the frame's own list.
        let mut all: Vec<(String, Value)> = self
            .frame_parameters
            .get(&frame)
            .map(|set| set.iter().map(|(n, v)| (n.clone(), v.clone())).collect())
            .unwrap_or_default();
        for (name, value) in out {
            match all.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => all.push((name, value)),
            }
        }
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// Sets several of a frame's parameters, as `modify-frame-parameters`.
    pub fn modify_frame_parameters(&mut self, frame: FrameId, parameters: &[(String, Value)]) -> Result<()> {
        for (name, value) in parameters {
            self.set_frame_parameter(frame, name, value.clone())?;
        }
        Ok(())
    }
}

/// What a geometry string says, as `x-parse-geometry` reads one:
/// `=80x24+10-20` gives a width, a height and a place. A place is a
/// number, counted from the right or the bottom when it is negative, and
/// `["-", 0]` for `-0`, which X tells from `+0` and a number cannot, as
/// frame.c gives `(left - 0)` for it.
pub fn parse_geometry(spec: &str) -> Vec<(String, Value)> {
    let chars: Vec<char> = spec.chars().collect();
    let mut i = 0;
    // The leading `=` X's geometry strings may have.
    if chars.first() == Some(&'=') {
        i += 1;
    }
    let number = |chars: &[char], at: &mut usize| -> Option<i64> {
        let start = *at;
        while *at < chars.len() && chars[*at].is_ascii_digit() {
            *at += 1;
        }
        chars[start..*at].iter().collect::<String>().parse().ok()
    };
    let mut out = Vec::new();
    // `WIDTH`, or `WIDTHxHEIGHT`.
    if chars.get(i).is_some_and(char::is_ascii_digit) {
        if let Some(width) = number(&chars, &mut i) {
            out.push(("width".to_string(), Value::Number(width as f64)));
            if matches!(chars.get(i), Some('x' | 'X')) {
                i += 1;
                if let Some(height) = number(&chars, &mut i) {
                    out.push(("height".to_string(), Value::Number(height as f64)));
                }
            }
        }
    }
    // Then `+X+Y`, `-X-Y` and their mixtures.
    for name in ["left", "top"] {
        let Some(sign) = chars.get(i).copied().filter(|c| *c == '+' || *c == '-') else { break };
        i += 1;
        // `--10` is ten from the far edge, as X's geometry has it.
        let negative = chars.get(i) == Some(&'-');
        if negative {
            i += 1;
        }
        let Some(n) = number(&chars, &mut i) else { break };
        let n = if negative { -n } else { n };
        let far = sign == '-';
        let value = if far && n == 0 {
            // `-0` is the far edge itself, which a number cannot say.
            Value::List(vec![Value::Str("-".into()), Value::Number(0.0)])
        } else if far {
            Value::Number(-n as f64)
        } else {
            Value::Number(n as f64)
        };
        out.push((name.to_string(), value));
    }
    out
}
