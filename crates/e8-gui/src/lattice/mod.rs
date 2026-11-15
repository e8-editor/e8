//! The lattice at startup (ADR 0108): when the window opens, E8's guided
//! field is drawn faintly behind the text, its path drawing in from left to
//! right, and then fades away, or at once at the first key or click.
//!
//! It is drawn from the coordinates in `geometry.rs`, which
//! `make-geometry.py` writes from the brand's drawing, in the page's `ink`
//! and `accent` tokens, so it follows the theme and both appearances.

mod geometry;

use std::sync::{Arc, Mutex};

use e8_core::Editor;
use egui::{Color32, Painter, Pos2, Rect, Shape, Stroke};

use geometry::{DOTS, LINE_WIDTH, LINES, PATH, PATH_WIDTH, SIZE};

/// How long the field takes to come up, in seconds.
const RISE: f64 = 0.5;
/// How long the path takes to draw in, from left to right.
const DRAW: f64 = 1.2;
/// When it starts to fade.
const HOLD: f64 = 2.5;
/// How long it takes to fade, lingering faintly towards the end.
const FADE: f64 = 3.5;
/// How long it takes to fade once a key or button is pressed.
const DISMISS: f64 = 0.4;

/// How strongly the lines and dots are drawn, at full strength, against the
/// `ink` token: faint enough that text over them stays easy to read.
const FIELD_ALPHA: f32 = 0.18;
/// How strongly the path and its dots are drawn, against `accent`.
const PATH_ALPHA: f32 = 0.45;
/// The space left either side, as a share of the window's width.
const MARGIN: f32 = 0.06;
/// How much of the window's height it may take at most.
const MAX_HEIGHT: f32 = 0.8;

/// Whether the editor wants the lattice: `e8-startup-lattice` on, as it is
/// by default, Emacs's `inhibit-startup-screen` (or its older names) not
/// set, and a window to show it in rather than `--batch`.
pub fn wanted(ed: &Editor) -> bool {
    let set = |name: &str| ed.variable(name).is_some_and(|v| v.is_true());
    set("e8-startup-lattice")
        && !["inhibit-startup-screen", "inhibit-splash-screen", "inhibit-startup-message", "noninteractive"].into_iter().any(set)
}

/// The lattice's progress, from the window's first frame until it has gone.
pub struct Lattice {
    /// Whether the editor wants it, once its thread has answered, which it
    /// does after init.ts has run.
    wanted: Arc<Mutex<Option<bool>>>,
    state: State,
}

enum State {
    /// Waiting for the editor's answer and its first frame.
    Waiting,
    /// Showing since `start`, in egui's seconds, and fading from `strength`
    /// since a key or button was pressed at the time given.
    Showing { start: f64, dismissed: Option<(f64, f32)> },
    Gone,
}

/// How to draw the lattice in one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// How strongly, from 0 to 1, everything is drawn.
    pub strength: f32,
    /// How much of the path has drawn in, from 0 to 1.
    pub drawn: f32,
}

impl Lattice {
    /// A lattice waiting to be told whether the editor wants it, through
    /// the slot returned with it.
    pub fn new() -> (Lattice, Arc<Mutex<Option<bool>>>) {
        let wanted = Arc::new(Mutex::new(None));
        (Lattice { wanted: wanted.clone(), state: State::Waiting }, wanted)
    }

    /// Whether it is still to be drawn, so the window draws again.
    pub fn showing(&self) -> bool {
        !matches!(self.state, State::Gone)
    }

    /// Moves it on to `now`, in egui's seconds, `input` saying whether a key
    /// or button was pressed this frame, and gives how to draw it, if at all.
    pub fn frame(&mut self, now: f64, input: bool) -> Option<Look> {
        if let State::Waiting = self.state {
            match *self.wanted.lock().unwrap_or_else(|e| e.into_inner()) {
                // Typing before it has come up, the user is at work already.
                _ if input => self.state = State::Gone,
                Some(true) => self.state = State::Showing { start: now, dismissed: None },
                Some(false) => self.state = State::Gone,
                None => {}
            }
        }
        let State::Showing { start, dismissed } = &mut self.state else { return None };
        let t = now - *start;
        let mut strength = if t < RISE {
            ease_out(t / RISE)
        } else if t < HOLD {
            1.0
        } else {
            1.0 - ease_out((t - HOLD) / FADE)
        };
        if input && dismissed.is_none() {
            *dismissed = Some((now, strength));
        }
        if let Some((at, from)) = *dismissed {
            strength = strength.min(from * (1.0 - ease_out((now - at) / DISMISS)));
        }
        if t >= HOLD + FADE || dismissed.is_some_and(|(at, _)| now - at >= DISMISS) {
            self.state = State::Gone;
            return None;
        }
        Some(Look { strength, drawn: ease_in_out(t / DRAW) })
    }
}

/// A curve from 0 to 1 that starts quickly and slows to a stop.
fn ease_out(p: f64) -> f32 {
    let p = p.clamp(0.0, 1.0);
    (1.0 - (1.0 - p).powi(3)) as f32
}

/// A curve from 0 to 1 that starts and ends slowly.
fn ease_in_out(p: f64) -> f32 {
    let p = p.clamp(0.0, 1.0);
    (if p < 0.5 { 4.0 * p * p * p } else { 1.0 - (-2.0 * p + 2.0).powi(3) / 2.0 }) as f32
}

/// Draws the lattice across `rect`, centred, keeping its proportions, with
/// a margin either side: the field in `ink`, the path in `accent`.
pub fn paint(painter: &Painter, rect: Rect, look: Look, ink: Color32, accent: Color32) {
    let mut scale = rect.width() * (1.0 - 2.0 * MARGIN) / SIZE[0];
    scale = scale.min(rect.height() * MAX_HEIGHT / SIZE[1]);
    if scale <= 0.0 {
        return;
    }
    let origin = rect.center() - egui::vec2(SIZE[0], SIZE[1]) * scale / 2.0;
    let at = |[x, y]: [f32; 2]| origin + egui::vec2(x, y) * scale;
    let field = ink.gamma_multiply(FIELD_ALPHA * look.strength);
    let path = accent.gamma_multiply(PATH_ALPHA * look.strength);

    let line_width = (LINE_WIDTH * scale).max(1.0);
    for &(from, to, opacity) in &LINES {
        painter.line_segment([at(from), at(to)], Stroke::new(line_width, field.gamma_multiply(opacity)));
    }

    // The path as far as it has drawn in, from left to right, with round ends.
    let head = PATH[0][0] + (PATH[PATH.len() - 1][0] - PATH[0][0]) * look.drawn;
    let mut points: Vec<Pos2> = Vec::with_capacity(PATH.len());
    for pair in PATH.windows(2) {
        let ([x0, y0], [x1, y1]) = (pair[0], pair[1]);
        points.push(at(pair[0]));
        if head < x1 {
            let f = ((head - x0) / (x1 - x0)).clamp(0.0, 1.0);
            points.push(at([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]));
            break;
        }
    }
    if head >= PATH[PATH.len() - 1][0] {
        points.push(at(PATH[PATH.len() - 1]));
    }
    let path_width = (PATH_WIDTH * scale).max(2.0);
    if let (Some(&first), Some(&last)) = (points.first(), points.last()) {
        painter.circle_filled(first, path_width / 2.0, path);
        painter.circle_filled(last, path_width / 2.0, path);
    }
    painter.add(Shape::line(points, Stroke::new(path_width, path)));

    // Dots on the path come up as it reaches them.
    for &(centre, radius, on_path) in &DOTS {
        let radius = (radius * scale).max(1.5);
        if on_path {
            let reached = ((head - centre[0]) / (SIZE[0] * 0.02) + 1.0).clamp(0.0, 1.0);
            if reached > 0.0 {
                painter.circle_filled(at(centre), radius, path.gamma_multiply(reached));
            }
        } else {
            painter.circle_filled(at(centre), radius, field);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn showing(answer: bool) -> Lattice {
        let (lattice, wanted) = Lattice::new();
        *wanted.lock().unwrap() = Some(answer);
        lattice
    }

    #[test]
    fn it_draws_in_holds_and_fades() {
        let mut l = showing(true);
        let first = l.frame(10.0, false).unwrap();
        assert_eq!((first.strength, first.drawn), (0.0, 0.0));
        let drawing = l.frame(10.6, false).unwrap();
        assert!(drawing.drawn > 0.3 && drawing.drawn < 0.7, "{drawing:?}");
        assert_eq!(l.frame(12.0, false), Some(Look { strength: 1.0, drawn: 1.0 }));
        let fading = l.frame(13.5, false).unwrap();
        assert!(fading.strength > 0.0 && fading.strength < 0.5, "{fading:?}");
        assert!(l.frame(16.0, false).is_none());
        assert!(!l.showing());
    }

    #[test]
    fn a_key_fades_it_within_its_time() {
        let mut l = showing(true);
        l.frame(0.0, false);
        l.frame(2.0, true).unwrap();
        assert!(l.frame(2.2, false).unwrap().strength < 0.2);
        assert!(l.frame(2.0 + DISMISS + 0.01, false).is_none());
    }

    #[test]
    fn it_waits_for_the_editor_and_stays_away_when_unwanted() {
        let (mut l, wanted) = Lattice::new();
        assert!(l.frame(0.0, false).is_none() && l.showing());
        *wanted.lock().unwrap() = Some(false);
        assert!(l.frame(0.1, false).is_none() && !l.showing());
    }
}
