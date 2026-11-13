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

    /// The size of the frame's text area, which its windows and echo area
    /// divide, in the front end's units, as `frame-text-width` and
    /// `frame-text-height`.
    pub fn frame_text_size(&self, frame: FrameId) -> (usize, usize) {
        self.frame_units_of(frame)
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
        self.frame_requests.push(FrameRequest::Position { frame, x, y });
        Ok(())
    }

    /// Asks the front end to make a frame's text area that big, as
    /// `set-frame-size`: in the front end's units, or in characters, which
    /// are turned into them, as Emacs's PIXELWISE does.
    pub fn request_frame_size(&mut self, frame: FrameId, width: f64, height: f64, pixelwise: bool) -> Result<()> {
        self.live_frame(frame)?;
        let (cw, ch) = self.cell();
        let (width, height) = if pixelwise { (width, height) } else { (width * cw as f64, height * ch as f64) };
        self.frame_requests.push(FrameRequest::Size { frame, width, height });
        Ok(())
    }

    /// Puts a frame behind the others, as `lower-frame`: the front end
    /// carries it out, and the frame goes to the end of the frame list, as
    /// frame.c's `Flower_frame` moves it.
    pub fn lower_frame(&mut self, frame: FrameId) -> Result<()> {
        self.live_frame(frame)?;
        self.frame_order.retain(|f| *f != frame);
        self.frame_order.push(frame);
        self.frame_requests.push(FrameRequest::Lower { frame });
        Ok(())
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
    /// `frame-bottom-divider-width`, which is none.
    pub fn frame_divider_width(&self, bottom: bool) -> usize {
        if bottom { 0 } else { self.text_metrics().window_chrome().divider as usize }
    }

    /// Where a frame's keys go, as `frame-focus`: the frame
    /// `redirect-frame-focus` named, or none.
    pub fn frame_focus(&self, frame: FrameId) -> Option<FrameId> {
        self.frame_focus.get(&frame).copied()
    }

    /// Sends a frame's keys to another, as `redirect-frame-focus`; with
    /// none, the frame has its own keys again.
    pub fn redirect_frame_focus(&mut self, frame: FrameId, to: Option<FrameId>) -> Result<()> {
        self.live_frame(frame)?;
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

    /// The frame that was selected before this one, as
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
        // What was set on the frame wins, as its own value.
        if let Some(set) = self.frame_parameters.get(&frame) {
            for (name, value) in set {
                match out.iter_mut().find(|(n, _)| n == name) {
                    Some(slot) => slot.1 = value.clone(),
                    None => out.push((name.clone(), value.clone())),
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
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
/// `80x24+10-20` gives a width, a height and a place, a negative one
/// counted from the other edge as `(- N)`.
pub fn parse_geometry(spec: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let bytes: Vec<char> = spec.chars().collect();
    let mut i = 0;
    let number = |chars: &[char], at: &mut usize| -> Option<i64> {
        let start = *at;
        while *at < chars.len() && chars[*at].is_ascii_digit() {
            *at += 1;
        }
        chars[start..*at].iter().collect::<String>().parse().ok()
    };
    // The size, `WIDTHxHEIGHT`, if it comes first.
    if i < bytes.len() && bytes[i].is_ascii_digit() {
        let width = number(&bytes, &mut i);
        if let (Some(width), Some('x' | 'X')) = (width, bytes.get(i).copied()) {
            i += 1;
            if let Some(height) = number(&bytes, &mut i) {
                out.push(("width".to_string(), Value::Number(width as f64)));
                out.push(("height".to_string(), Value::Number(height as f64)));
            }
        }
    }
    // Then `+X+Y`, `-X-Y` and their mixtures.
    for name in ["left", "top"] {
        let Some(sign) = bytes.get(i).copied().filter(|c| *c == '+' || *c == '-') else { break };
        i += 1;
        // `--10` is ten from the other edge, as X's geometry has it.
        let negative = bytes.get(i).copied() == Some('-');
        if negative {
            i += 1;
        }
        let Some(n) = number(&bytes, &mut i) else { break };
        let value = if sign == '-' {
            // From the right or bottom edge, as Emacs's `(- N)`, whose
            // symbol is a string here so the place can be read as data.
            Value::List(vec![Value::Str("-".into()), Value::Number(n as f64)])
        } else if negative {
            Value::Number(-n as f64)
        } else {
            Value::Number(n as f64)
        };
        out.push((name.to_string(), value));
    }
    out
}
