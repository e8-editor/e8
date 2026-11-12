//! Fontifying text just before it is shown, as Emacs's jit-lock does.
//!
//! A major mode that styles text with properties, such as org-mode, adds a
//! function to the buffer's `jit-lock-functions` hook. Before the front end
//! draws, [`Editor::redisplay`] calls those functions with the start and end
//! of each stretch of whole lines a window shows that is not fontified yet.
//! Editing marks the text from the start of the edited line to the end of the
//! buffer as needing fontifying again, because a change can restyle what
//! follows it, such as opening a block. That is what Emacs's
//! `jit-lock-contextually` does after a delay; here it is done at once, which
//! costs little because only what is shown is fontified.

use std::ops::Range;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::Result;
use crate::variables::Value;

/// How many times redisplay fontifies a window before giving up, in case
/// fontifying keeps hiding text and bringing more lines into view.
const PASSES: usize = 4;

impl Buffer {
    /// Marks everything from the start of the line `pos` is on as needing
    /// fontifying again.
    pub(crate) fn unfontify_from(&mut self, pos: usize) {
        // Parse states after a change are wrong now, as syntax-ppss-flush-cache
        // drops them, and so are the syntax properties after it.
        self.ppss_cache.get_mut().retain(|(p, _)| *p <= pos);
        self.syntax_propertized = self.syntax_propertized.min(pos);
        if self.fontified.is_empty() {
            return;
        }
        let from = self.line_start(self.line_of(pos.min(self.len())));
        self.fontified.retain_mut(|r| {
            r.end = r.end.min(from);
            r.start < r.end
        });
    }

    /// The parts of a range that are not fontified yet.
    pub(crate) fn unfontified_in(&self, range: Range<usize>) -> Vec<Range<usize>> {
        let mut out = Vec::new();
        let mut pos = range.start;
        for r in &self.fontified {
            if r.end <= pos {
                continue;
            }
            if r.start >= range.end {
                break;
            }
            if r.start > pos {
                out.push(pos..r.start);
            }
            pos = pos.max(r.end);
        }
        if pos < range.end {
            out.push(pos..range.end);
        }
        out
    }

    pub(crate) fn mark_fontified(&mut self, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        let mut merged = range;
        let mut out = Vec::with_capacity(self.fontified.len() + 1);
        let mut placed = false;
        for r in self.fontified.drain(..) {
            if r.end < merged.start {
                out.push(r);
            } else if r.start > merged.end {
                if !placed {
                    out.push(merged.clone());
                    placed = true;
                }
                out.push(r);
            } else {
                merged = merged.start.min(r.start)..merged.end.max(r.end);
            }
        }
        if !placed {
            out.push(merged);
        }
        self.fontified = out;
    }
}

impl Editor {
    /// Runs `f` with a buffer current, as if no prompt were open, then puts
    /// back the buffer and prompt that were, as Emacs's `with-current-buffer`.
    pub fn with_current_buffer<T>(&mut self, index: usize, f: impl FnOnce(&mut Editor) -> T) -> T {
        let current = self.buffers[self.current].id;
        self.current = index;
        let result = f(self);
        if let Some(back) = self.buffer_with_id(current) {
            self.current = back;
        }
        result
    }

    fn has_fontifiers(&self, b: &Buffer) -> bool {
        !self.hook_functions_in(b, "jit-lock-functions").is_empty()
    }

    /// Fontifies whatever is not fontified yet in a range of the current
    /// buffer, widened to whole lines, by calling `jit-lock-functions`.
    /// Returns whether anything was fontified.
    pub fn fontify_region(&mut self, range: Range<usize>) -> Result<bool> {
        let b = self.buffer();
        if !self.has_fontifiers(b) {
            return Ok(false);
        }
        let start = b.line_start(b.line_of(range.start.min(b.len())));
        let end_line = b.line_of(range.end.min(b.len()));
        let end = if end_line + 1 < b.line_count() { b.line_start(end_line + 1) } else { b.len() };
        let missing = b.unfontified_in(start..end.max(start));
        let mut result = Ok(());
        for r in &missing {
            // Marked first, so a function that fails is not called again and again.
            self.buffer_mut().mark_fontified(r.clone());
            let args = [Value::Number(r.start as f64), Value::Number(r.end as f64)];
            // As jit-lock-fontify-now, with silent modifications: faces put on
            // the text are neither undone nor a change to save.
            let buffer = self.buffer().id();
            let silenced = self.buffer_mut().begin_silent();
            let ran = self.run_hook_with_args("jit-lock-functions", &args);
            if let Some(index) = self.buffer_with_id(buffer) {
                self.buffers[index].end_silent(silenced);
            }
            if let Err(e) = ran {
                result = Err(e);
            }
        }
        result.map(|()| !missing.is_empty())
    }

    /// Fontifies the whole current buffer, as Emacs's `font-lock-ensure`.
    pub fn font_lock_ensure(&mut self) -> Result<()> {
        let len = self.buffer().len();
        self.fontify_region(0..len).map(drop)
    }

    /// Marks the whole current buffer as needing fontifying again, as
    /// Emacs's `font-lock-flush`.
    pub fn font_lock_flush(&mut self) {
        self.buffer_mut().fontified.clear();
    }

    /// Gets the frame ready to draw, as Emacs's redisplay does before it
    /// draws: fontifies what each window shows, and scrolls the selected
    /// window to keep point visible. Front ends call this before drawing,
    /// once they have told the editor how big the windows are.
    pub fn redisplay(&mut self) {
        let settled = self.fontify_windows(&[]);
        self.ensure_point_visible();
        // Scrolling horizontally truncates lines, or stopping wraps them
        // again, which can move point's row.
        if self.hscroll_windows() {
            self.ensure_point_visible();
        }
        // Again only where keeping point visible scrolled.
        self.fontify_windows(&settled);
        self.update_mode_lines();
        self.flush_image_messages();
    }

    /// Fontifies what every frame's windows show, but those `settled`
    /// says were wholly fontified as they are now. Returns the windows
    /// left wholly fontified: each with its buffer, its start and the
    /// buffer's change count then.
    fn fontify_windows(&mut self, settled: &[(crate::window::WindowId, u64, usize, u64)]) -> Vec<(crate::window::WindowId, u64, usize, u64)> {
        let mut done = Vec::new();
        let windows: Vec<(crate::window::FrameId, crate::window::WindowId)> = self
            .frame_list()
            .into_iter()
            .flat_map(|f| self.frame_windows(f).into_iter().map(move |v| (f, v.id)).collect::<Vec<_>>())
            .collect();
        for (frame, id) in windows {
            for _ in 0..PASSES {
                let Some(view) = self.frame_windows(frame).into_iter().find(|v| v.id == id) else { break };
                if !self.has_fontifiers(view.buffer) {
                    break;
                }
                let now = (id, view.buffer.id, view.top_line, view.buffer.modified_tick());
                if settled.contains(&now) {
                    done.push(now);
                    break;
                }
                let index = self.buffers.iter().position(|b| b.id == view.buffer.id).unwrap_or(0);
                // A row more than fits, which a front end scrolling smoothly shows in part.
                let height = self.window(id).map_or(24, |w| w.height) + 1;
                let wrap = self.wrap_in(id, view.buffer);
                let rows = self.rows_from(view.buffer, view.top_line, height, usize::MAX, None, wrap);
                if rows.is_empty() {
                    break;
                }
                // Only what the rows show, as Emacs's display fontifies what
                // it shows: text hidden in a folded subtree waits until it
                // shows, rather than every edit fontifying the rest of the
                // buffer through it.
                let ranges = shown_ranges(&rows);
                let fontified = self.with_current_buffer(index, |ed| {
                    let mut any = false;
                    for range in ranges {
                        any |= ed.fontify_region(range)?;
                    }
                    Ok::<bool, crate::error::Error>(any)
                });
                // The faces it put are the text's, which other buffers may share.
                self.sync_shared_text();
                match fontified {
                    Ok(true) => continue,
                    Ok(false) => {
                        done.push(now);
                        break;
                    }
                    Err(e) => {
                        self.message(format!("Error during redisplay: {e}"));
                        break;
                    }
                }
            }
        }
        done
    }
}

/// The stretches of text rows show, each row's from its start to the end
/// of the last text it shows, so hidden text after it, behind an ellipsis,
/// is left out; stretches that meet are joined.
fn shown_ranges(rows: &[crate::rows::Row]) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    for row in rows {
        let shown_end = row
            .segments
            .iter()
            .filter(|s| !s.ellipsis && !(s.string && s.covers.is_none()))
            .map(|s| s.covers.unwrap_or(s.start + s.text.chars().count()))
            .max()
            .unwrap_or(row.start)
            .max(row.start);
        match out.last_mut() {
            Some(last) if row.start <= last.end + 1 => last.end = last.end.max(shown_end),
            _ => out.push(row.start..shown_end),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fontified_ranges_merge_and_edits_clear_what_follows() {
        let mut b = Buffer::new("t");
        b.set_text("one\ntwo\nthree\nfour\n");
        b.mark_fontified(0..4);
        b.mark_fontified(8..14);
        assert_eq!(b.unfontified_in(0..19), [4..8, 14..19]);
        b.mark_fontified(4..8);
        assert_eq!(b.fontified, vec![0..14]);
        b.set_point(10);
        b.insert("x").unwrap();
        // Everything from the start of the edited line, "three", is unfontified.
        assert_eq!(b.fontified, vec![0..8]);
    }
}
