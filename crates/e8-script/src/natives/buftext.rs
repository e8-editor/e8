//! Buffer text's odds, as buffer.c, marker.c and editfns.c have them
//! (ADR 0086): the name a buffer had, swapping two buffers' text, a
//! marker's last position, the gap, labeled restrictions, setting the
//! modified tick and translating a region by a table.

use crate::*;
use crate::natives::{Opt, natives};

/// The buffer an argument names: a buffer object, live or killed, a live
/// buffer's name, or the current buffer for none.
fn buffer_id(ed: &Editor, buffer: Option<EditorValue>) -> Result<u64> {
    match buffer {
        None | Some(EditorValue::Null) => Ok(ed.buffer().id()),
        Some(EditorValue::Buffer(id)) => Ok(id),
        Some(EditorValue::Str(name)) => ed.buffers().iter().find(|b| b.name == name).map(|b| b.id()).ok_or_else(|| Error::new(format!("No such buffer {name}"))),
        Some(other) => Err(e8_core::xfaces::wrong_type("bufferp", &other)),
    }
}

natives! {
    /// The current buffer's mark as a marker, as mark-marker: where the mark is, nowhere while there is none, and the same marker each time. Moving it moves the mark, without activating it.
    #[ts = "(): Marker"]
    pub fn markMarker(ed) -> EditorValue {
        Ok(EditorValue::Marker(ed.buffer().mark_marker()))
    }

    /// The name a buffer had before it was last renamed or killed, as buffer-last-name; undefined if it never was.
    #[ts = "(buffer?: Buffer | string | null): string | undefined"]
    pub fn bufferLastName(ed, buffer: Opt<EditorValue>) -> Option<String> {
        let id = buffer_id(ed, buffer.0)?;
        Ok(ed.buffer_last_name(id))
    }

    /// Swap the current buffer's text with another's, as buffer-swap-text: the text with its properties, overlays, markers, point, mark, narrowing, undo history and modified state.
    #[ts = "(buffer: Buffer | string): undefined"]
    pub fn bufferSwapText(ed, buffer: EditorValue) -> Option<bool> {
        let id = match buffer {
            EditorValue::Buffer(id) => id,
            EditorValue::Str(_) => buffer_id(ed, Some(buffer))?,
            other => return Err(e8_core::xfaces::wrong_type("bufferp", &other)),
        };
        ed.buffer_swap_text(id)?;
        Ok(None)
    }

    /// A marker's position, or where it last was once its buffer is killed or it points nowhere, as marker-last-position.
    #[ts = "(marker: Marker | number): number"]
    pub fn markerLastPosition(ed, marker: EditorValue) -> usize {
        let id = match marker {
            EditorValue::Marker(id) => id,
            EditorValue::Number(n) => n as u64,
            other => return Err(e8_core::xfaces::wrong_type("markerp", &other)),
        };
        ed.marker_last_position(id).ok_or_else(|| e8_core::xfaces::wrong_type("markerp", &EditorValue::Marker(id)))
    }

    /// Where the current buffer's gap is, as gap-position: E8's buffers keep their text in a rope with no gap, so its end.
    pub fn gapPosition(ed) -> usize {
        Ok(ed.buffer().len())
    }

    /// How big the current buffer's gap is, as gap-size: 0, as E8's buffers have none.
    pub fn gapSize(_ed) -> usize {
        Ok(0)
    }

    /// Narrow to start and end and label the restriction, as internal--labeled-narrow-to-region, which with-restriction uses.
    #[ts = "(start: number, end: number, label: Value): undefined"]
    pub fn internalLabeledNarrowToRegion(ed, start: usize, end: usize, label: EditorValue) -> Option<bool> {
        let b = ed.buffer();
        let (lo, hi) = (start.min(end), start.max(end));
        if hi > b.len() {
            return Err(Error::signal("args-out-of-range", format!("Args out of range: {start}, {end}"), vec![EditorValue::Number(start as f64), EditorValue::Number(end as f64)]));
        }
        ed.buffer_mut().labeled_narrow(lo, hi, label);
        Ok(None)
    }

    /// Take off the innermost restriction if `label` labels it, and widen, as internal--labeled-widen, which without-restriction uses.
    #[ts = "(label: Value): undefined"]
    pub fn internalLabeledWiden(ed, label: EditorValue) -> Option<bool> {
        ed.buffer_mut().labeled_widen(&label);
        Ok(None)
    }

    /// Make a buffer's buffer-modified-tick give `tick`, as internal--set-buffer-modified-tick.
    #[ts = "(tick: number, buffer?: Buffer | string | null): undefined"]
    pub fn internalSetBufferModifiedTick(ed, tick: f64, buffer: Opt<EditorValue>) -> Option<bool> {
        if tick.fract() != 0.0 {
            return Err(e8_core::xfaces::wrong_type("fixnump", &EditorValue::Number(tick)));
        }
        let id = buffer_id(ed, buffer.0)?;
        let index = ed.buffer_with_id(id).ok_or_else(|| Error::new("Selecting deleted buffer"))?;
        ed.buffers_mut()[index].set_modified_tick(tick.max(0.0) as u64);
        Ok(None)
    }

    /// Translate the characters from start to end by a table, as translate-region-internal: a string whose Nth character is the one for code N, or a char-table of characters. Gives how many changed.
    #[ts = "(start: number, end: number, table: string | CharTable): number"]
    pub fn translateRegionInternal(ed, start: usize, end: usize, table: EditorValue) -> usize {
        match &table {
            EditorValue::Str(_) | EditorValue::Text(_) | EditorValue::CharTable(_) => ed.translate_region(start, end, &table),
            _ => Err(Error::new("Not a translation table")),
        }
    }
}
