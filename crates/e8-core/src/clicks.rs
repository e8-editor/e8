//! A front end's presses, moves and releases of the primary button as
//! Emacs's mouse keys, as both front ends turn them: `down-mouse-1` on a
//! first press, `mouse-1`, `double-mouse-1` or `triple-mouse-1` on the
//! release, counting presses close in time and place, and `drag-mouse-1`
//! as it moves away from where it went down.

use crate::editor::Editor;
use crate::key::{Key, KeyCode, MouseKind};
use crate::window::{MouseEvent, WindowId};

/// How long a press may follow the last to count as another click of it, in seconds.
pub const DOUBLE_CLICK: f64 = 0.4;

/// Where a press was over the text: the window, and the buffer position
/// if it was over text.
pub type Target = (WindowId, Option<usize>);

/// A mouse key to send and where it happened.
pub type Event = (Key, MouseEvent);

/// The primary button's state, with presses at places of the front end's
/// own kind `P`: cells in a terminal, points in a window.
pub struct Clicks<P> {
    /// Where the button went down, while it is down.
    pressed: Option<Target>,
    dragged: bool,
    /// Where the pointer last was over the text during a drag.
    last: Option<Target>,
    /// Whether the drag came as `<mouse-movement>` events, `track-mouse`
    /// being on, so its `<drag-mouse-1>` comes once, at the release.
    tracked: bool,
    /// When and where the last press was, and how many clicks it made.
    last_press: Option<(f64, P, u8)>,
    clicks: u8,
}

impl<P> Default for Clicks<P> {
    fn default() -> Clicks<P> {
        Clicks { pressed: None, dragged: false, last: None, tracked: false, last_press: None, clicks: 0 }
    }
}

fn key(kind: MouseKind, shift: bool) -> Key {
    Key { code: KeyCode::Mouse(kind, 1), ctrl: false, meta: false, shift }
}

impl<P: Copy> Clicks<P> {
    /// Whether the button is down after a press over the text.
    pub fn is_down(&self) -> bool {
        self.pressed.is_some()
    }

    /// The button went down at `at`, `time` seconds into the front end's
    /// clock, over `target`; `near` says whether two places are close
    /// enough for a press at one to be another click of one at the other.
    /// Gives the event to send, which the front end sends with
    /// [`Editor::mouse`] once it has let go of whatever holds this state:
    /// the command it runs may wait for more events, which come through here.
    pub fn press(&mut self, time: f64, at: P, near: impl Fn(P, P) -> bool, target: Target, shift: bool) -> Option<Event> {
        self.clicks = match self.last_press {
            Some((t, p, n)) if time - t < DOUBLE_CLICK && near(p, at) => n % 3 + 1,
            _ => 1,
        };
        self.last_press = Some((time, at, self.clicks));
        self.pressed = Some(target);
        self.last = None;
        self.dragged = false;
        self.tracked = false;
        let (window, position) = target;
        (self.clicks == 1).then(|| (key(MouseKind::Down, shift), MouseEvent { window, position, start: None }))
    }

    /// The pointer moved, with the button down or not, over `target`;
    /// `tracking` says whether `track-mouse` is on ([`Editor::tracking_mouse`]).
    /// While it is, a move is a `<mouse-movement>` event, and a drag's
    /// `<drag-mouse-1>` waits for the release, as in Emacs; else E8 sends
    /// `<drag-mouse-1>` as the drag goes, for the region to follow it.
    pub fn moved(&mut self, target: Option<Target>, shift: bool, tracking: bool) -> Option<Event> {
        let (window, position) = target?;
        let movement = (Key::new(KeyCode::MouseMovement), MouseEvent { window, position, start: None });
        let Some(start) = self.pressed else { return tracking.then_some(movement) };
        if !self.dragged && start == (window, position) {
            return None;
        }
        self.dragged = true;
        self.last = Some((window, position));
        if tracking {
            self.tracked = true;
            Some(movement)
        } else if self.tracked {
            // Tracking ended with the button still down: the drag ends at the release.
            None
        } else {
            Some((key(MouseKind::Drag, shift), MouseEvent { window, position, start: Some(start) }))
        }
    }

    /// The button came up over `target`, or over nothing, where it is
    /// where the pointer last was over the text.
    pub fn release(&mut self, target: Option<Target>, shift: bool) -> Option<Event> {
        let start = self.pressed.take()?;
        let (window, position) = target.or(self.last).unwrap_or(start);
        if self.dragged {
            return std::mem::take(&mut self.tracked).then(|| (key(MouseKind::Drag, shift), MouseEvent { window, position, start: Some(start) }));
        }
        let kind = match self.clicks {
            2 => MouseKind::Double,
            3 => MouseKind::Triple,
            _ => MouseKind::Click,
        };
        Some((key(kind, shift), MouseEvent { window, position, start: None }))
    }
}

/// Sends what [`Clicks`] gave, if anything.
pub fn send(ed: &mut Editor, event: Option<Event>) {
    if let Some((key, event)) = event {
        ed.mouse(key, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mouse keys an editor got, as `recent-keys` shows them.
    fn keys(ed: &Editor) -> Vec<String> {
        ed.recent_keys(false)
            .iter()
            .filter_map(|l| match l {
                crate::keyboard::Lossage::Key(key) => Some(key.to_string()),
                crate::keyboard::Lossage::Command(_) => None,
            })
            .filter(|k| k.contains("mouse"))
            .collect()
    }

    #[test]
    fn presses_close_in_time_and_place_count_as_clicks_of_one() {
        let mut ed = Editor::new();
        ed.type_text("some words here");
        let window = ed.selected_window();
        let mut clicks: Clicks<i32> = Clicks::default();
        let near = |a: i32, b: i32| (a - b).abs() < 2;
        let at = |p| Some((window, Some(p)));
        for (time, x) in [(0.0, 0), (0.1, 1), (0.2, 0), (0.3, 0)] {
            send(&mut ed, clicks.press(time, x, near, (window, Some(2)), false));
            send(&mut ed, clicks.release(at(2), false));
        }
        // A fourth press starts again at one; one far off, or too late, too.
        send(&mut ed, clicks.press(0.35, 50, near, (window, Some(2)), false));
        send(&mut ed, clicks.release(at(2), false));
        send(&mut ed, clicks.press(2.0, 50, near, (window, Some(2)), false));
        send(&mut ed, clicks.release(None, false));
        assert_eq!(
            keys(&ed),
            ["<down-mouse-1>", "<mouse-1>", "<double-mouse-1>", "<triple-mouse-1>", "<down-mouse-1>", "<mouse-1>", "<down-mouse-1>", "<mouse-1>", "<down-mouse-1>", "<mouse-1>"]
        );
        // Moving away with the button down drags, and no click follows.
        send(&mut ed, clicks.press(5.0, 0, near, (window, Some(2)), false));
        send(&mut ed, clicks.moved(at(2), false, false));
        send(&mut ed, clicks.moved(at(6), false, false));
        send(&mut ed, clicks.release(at(6), false));
        assert_eq!(keys(&ed)[10..], ["<down-mouse-1>", "<drag-mouse-1>"]);
        assert!(!clicks.is_down());
    }
}
