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

/// The primary button's state, with presses at places of the front end's
/// own kind `P`: cells in a terminal, points in a window.
pub struct Clicks<P> {
    /// Where the button went down, while it is down.
    pressed: Option<Target>,
    dragged: bool,
    /// Whether the drag came as `<mouse-movement>` events, `track-mouse`
    /// being on, so its `<drag-mouse-1>` comes once, at the release.
    tracked: bool,
    /// When and where the last press was, and how many clicks it made.
    last_press: Option<(f64, P, u8)>,
    clicks: u8,
}

impl<P> Default for Clicks<P> {
    fn default() -> Clicks<P> {
        Clicks { pressed: None, dragged: false, tracked: false, last_press: None, clicks: 0 }
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
    pub fn press(&mut self, ed: &mut Editor, time: f64, at: P, near: impl Fn(P, P) -> bool, target: Target, shift: bool) {
        self.clicks = match self.last_press {
            Some((t, p, n)) if time - t < DOUBLE_CLICK && near(p, at) => n % 3 + 1,
            _ => 1,
        };
        self.last_press = Some((time, at, self.clicks));
        self.pressed = Some(target);
        self.dragged = false;
        self.tracked = false;
        if self.clicks == 1 {
            let (window, position) = target;
            ed.mouse(key(MouseKind::Down, shift), MouseEvent { window, position, start: None });
        }
    }

    /// The pointer moved, with the button down or not, over `target`.
    /// While `track-mouse` is on, a move is a `<mouse-movement>` event, and
    /// a drag's `<drag-mouse-1>` waits for the release, as in Emacs; else
    /// E8 sends `<drag-mouse-1>` as the drag goes, for the region to follow.
    pub fn moved(&mut self, ed: &mut Editor, target: Option<Target>, shift: bool) {
        let Some((window, position)) = target else { return };
        let Some(start) = self.pressed else {
            ed.mouse_moved(MouseEvent { window, position, start: None });
            return;
        };
        if self.dragged || start != (window, position) {
            self.dragged = true;
            if ed.tracking_mouse() {
                self.tracked = true;
                ed.mouse_moved(MouseEvent { window, position, start: None });
            } else {
                ed.mouse(key(MouseKind::Drag, shift), MouseEvent { window, position, start: Some(start) });
            }
        }
    }

    /// The button came up over `target`, or over nothing, where it is
    /// where it went down.
    pub fn release(&mut self, ed: &mut Editor, target: Option<Target>, shift: bool) {
        let Some(start) = self.pressed.take() else { return };
        if self.dragged {
            if std::mem::take(&mut self.tracked) {
                let (window, position) = target.unwrap_or(start);
                ed.mouse(key(MouseKind::Drag, shift), MouseEvent { window, position, start: Some(start) });
            }
            return;
        }
        let kind = match self.clicks {
            2 => MouseKind::Double,
            3 => MouseKind::Triple,
            _ => MouseKind::Click,
        };
        let (window, position) = target.unwrap_or(start);
        ed.mouse(key(kind, shift), MouseEvent { window, position, start: None });
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
            clicks.press(&mut ed, time, x, near, (window, Some(2)), false);
            clicks.release(&mut ed, at(2), false);
        }
        // A fourth press starts again at one; one far off, or too late, too.
        clicks.press(&mut ed, 0.35, 50, near, (window, Some(2)), false);
        clicks.release(&mut ed, at(2), false);
        clicks.press(&mut ed, 2.0, 50, near, (window, Some(2)), false);
        clicks.release(&mut ed, None, false);
        assert_eq!(
            keys(&ed),
            ["<down-mouse-1>", "<mouse-1>", "<double-mouse-1>", "<triple-mouse-1>", "<down-mouse-1>", "<mouse-1>", "<down-mouse-1>", "<mouse-1>", "<down-mouse-1>", "<mouse-1>"]
        );
        // Moving away with the button down drags, and no click follows.
        clicks.press(&mut ed, 5.0, 0, near, (window, Some(2)), false);
        clicks.moved(&mut ed, at(2), false);
        clicks.moved(&mut ed, at(6), false);
        clicks.release(&mut ed, at(6), false);
        assert_eq!(keys(&ed)[10..], ["<down-mouse-1>", "<drag-mouse-1>"]);
        assert!(!clicks.is_down());
    }
}
