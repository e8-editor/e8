//! Text, buffers, text properties, faces and display.

use crate::*;
use crate::natives::{FaceAttrValues, Field, Opt, PlistOrValue, Posn, Record, Win, natives};

/// The font a value is.
fn font_of(value: EditorValue) -> Result<e8_core::Font> {
    match value {
        EditorValue::Font(font) => Ok(*font),
        other => Err(Error::signal("wrong-type-argument", format!("Not a font: {other}"), Vec::new())),
    }
}

fn font_value(font: e8_core::Font) -> EditorValue {
    EditorValue::Font(Box::new(font))
}

natives! {
    /// `face` is a face's name or an anonymous face, a list of attributes.
    fn addFaceTextProperty(ed, start: usize, end: usize, face: EditorValue, append: bool) {
        // Recorded for undo, as add-face-text-property is.
        let b = ed.buffer_mut();
        b.record_property_change(start, end, "face", |_| true);
        // An anonymous face goes by the name standing for it.
        let names = e8_core::face_names(&face);
        let ordered: Vec<&String> = if append { names.iter().collect() } else { names.iter().rev().collect() };
        for name in ordered {
            b.add_face_text_property(start..end, name, append);
        }
        Ok(())
    }

    pub fn removeTextProperty(ed, start: usize, end: usize, name: String) {
        ed.buffer_mut().change_text_property(start..end, &name, None);
        Ok(())
    }

    /// Where a property changes, as textprop.c's searches: KIND names
    /// which, PROP the property for the -single- ones.
    fn propertyChange(ed, kind: String, pos: usize, prop: Option<String>, limit: Option<usize>) -> Option<usize> {
        let b = ed.buffer();
        let prop = prop.as_deref().unwrap_or("");
        Ok(match kind.as_str() {
            "next" => b.next_property_change(pos).filter(|&p| p < b.len()).map(|p| limit.map_or(p, |l| p.min(l))).or(limit),
            "previous" => b.previous_property_change(pos).filter(|&p| p > 0 && p < pos).map(|p| limit.map_or(p, |l| p.max(l))).or(limit),
            "next-single" => b.next_single_property_change(pos, prop, limit),
            "previous-single" => b.previous_single_property_change(pos, prop, limit),
            "next-single-char" => Some(b.next_single_char_property_change(pos, prop, limit)),
            "previous-single-char" => Some(b.previous_single_char_property_change(pos, prop, limit)),
            "next-char" => Some(b.next_char_property_change(pos).min(limit.unwrap_or(b.point_max()))),
            "previous-char" => Some(b.previous_char_property_change(pos, limit)),
            "next-overlay" => Some(b.next_overlay_change(pos)),
            "previous-overlay" => Some(b.previous_overlay_change(pos)),
            _ => None,
        })
    }

    /// Fields, as editfns.c's: the bounds of the one around POS.
    fn findField(ed, pos: usize, merge: bool, beg_limit: Option<usize>, end_limit: Option<usize>) -> Vec<usize> {
        let (beg, end) = ed.find_field(pos, merge, beg_limit, end_limit);
        Ok(vec![beg, end])
    }

    fn constrainToField(ed, new: usize, old: usize, escape: bool, only_in_line: bool, capture: Option<String>) -> usize {
        Ok(ed.constrain_to_field(new, old, escape, only_in_line, capture.as_deref()))
    }

    fn makeOverlay(ed, start: usize, end: usize, front: bool, rear: bool) -> f64 {
        Ok(ed.buffer_mut().make_overlay_advancing(start..end, front, rear) as f64)
    }

    /// Start a group of changes to the current buffer that can be taken back as
    /// if never made, leaving no trace in the undo history, as Emacs's
    /// prepare-change-group. Returns its handle.
    pub fn prepareChangeGroup(ed) -> usize {
        Ok(ed.buffer_mut().prepare_change_group())
    }

    /// Take back the changes made since the group began, as cancel-change-group.
    pub fn cancelChangeGroup(ed, handle: usize) {
        ed.buffer_mut().cancel_change_group(handle);
        ed.run_undo_applies()
    }

    fn beginSilentModifications(ed) -> Vec<bool> {
        Ok(ed.begin_silent_modifications().to_vec())
    }

    fn endSilentModifications(ed, buffer: u64, state: Vec<bool>) {
        ed.end_silent_modifications(buffer, [state[0], state[1], state[2]]);
        Ok(())
    }

    /// Keep the changes made since the group began, as accept-change-group.
    pub fn acceptChangeGroup(ed, handle: usize) {
        ed.buffer_mut().accept_change_group(handle);
        Ok(())
    }

    fn windowStart(ed, window: Opt<Win>) -> usize {
        let window = Opt(window.0.map(|x| x.0));
        let id = window.0.unwrap_or(ed.selected_window());
        ed.window_start(id).ok_or_else(|| Error::new("No such window"))
    }

    fn setWindowStart(ed, window: Win, pos: usize) {
        let window = window.0;
        ed.set_window_start(window, pos)
    }

    fn windowEnd(ed, window: Win) -> usize {
        let window = window.0;
        ed.window_end(window).ok_or_else(|| Error::new("No such window"))
    }

    fn posVisibleInWindowP(ed, pos: usize, window: Win, partially: bool) -> bool {
        let window = window.0;
        Ok(ed.pos_visible_in_window_p(pos, window, partially))
    }

    fn windowTextPixelSize(ed, window: Win, from: usize, to: usize) -> Vec<f64> {
        let window = window.0;
        let (w, h) = ed.window_text_pixel_size(window, from, to).ok_or_else(|| Error::new("No such window"))?;
        Ok(vec![w as f64, h as f64])
    }

    fn bufferTextPixelSize(ed, buffer: u64) -> Vec<f64> {
        let (w, h) = ed.buffer_text_pixel_size(buffer).ok_or_else(|| Error::new("No such buffer"))?;
        Ok(vec![w as f64, h as f64])
    }

    fn lineIsContinued(ed) -> bool {
        Ok(ed.line_is_continued())
    }

    /// Ring the bell, as ding: ring-bell-function if set, else the front end sounds it or, with visible-bell, flashes.
    pub fn ding(ed) {
        ed.ding()
    }

    /// Redisplay now, as redisplay.
    pub fn redisplay(ed) {
        ed.redisplay();
        Ok(())
    }

    fn windowMargins(ed, window: Win) -> Vec<usize> {
        let window = window.0;
        Ok(<[usize; 2]>::from(ed.window_margins(window)).to_vec())
    }

    fn setWindowMargins(ed, window: Win, left: usize, right: usize) -> bool {
        let window = window.0;
        Ok(ed.set_window_margins(window, left, right))
    }

    fn windowFringes(ed) -> bool {
        Ok(ed.text_metrics().fringes())
    }

    fn showWindowCursor(ed, window: Win, shown: bool) {
        let window = window.0;
        ed.show_window_cursor(window, shown);
        Ok(())
    }

    fn windowCursorShown(ed, window: Win) -> bool {
        let window = window.0;
        Ok(ed.window_cursor_shown(window))
    }

    fn destroyFringeBitmap(ed, name: String) {
        ed.destroy_fringe_bitmap(&name);
        Ok(())
    }

    fn setFringeBitmapFace(ed, name: String, face: Option<String>) {
        ed.set_fringe_bitmap_face(&name, face)
    }

    fn fringeBitmapP(ed, name: String) -> bool {
        Ok(ed.fringe_bitmap_p(&name))
    }

    fn fringeBitmapsAtPos(ed, pos: usize, window: Win) -> Option<Vec<String>> {
        let window = window.0;
        Ok(ed.fringe_bitmaps_at_pos(window, pos).map(|[l, r]| vec![l.unwrap_or_default(), r.unwrap_or_default()]))
    }

    /// How tall the row point is on shows in the selected window, as line-pixel-height.
    pub fn linePixelHeight(ed) -> f64 {
        Ok(ed.line_pixel_height() as f64)
    }

    /// The width of a character of the current buffer's default font, its remapping counted, as default-font-width.
    pub fn defaultFontWidth(ed) -> f64 {
        Ok(ed.default_font_width() as f64)
    }

    /// The height of a line of the current buffer's default font, as default-font-height.
    pub fn defaultFontHeight(ed) -> f64 {
        Ok(ed.default_font_height() as f64)
    }

    fn windowPoint(ed, window: Win) -> usize {
        let window = window.0;
        ed.window_point(window).ok_or_else(|| Error::new("No such window"))
    }

    fn setWindowPoint(ed, window: Win, pos: usize) {
        let window = window.0;
        ed.set_window_point(window, pos)
    }

    fn switchToPrevBuffer(ed, window: Win, how: Opt<String>) -> Option<String> {
        let window = window.0;
        let how = match how.0.as_deref() {
            None => None,
            Some("bury") => Some(e8_core::BuryOrKill::Bury),
            Some("kill") => Some(e8_core::BuryOrKill::Kill),
            Some("append") => Some(e8_core::BuryOrKill::Append),
            Some(other) => return Err(Error::new(format!("switchToPrevBuffer takes bury, kill or append, not {other}"))),
        };
        ed.switch_to_prev_buffer(window, how)
    }

    fn switchToNextBuffer(ed, window: Win) -> Option<String> {
        let window = window.0;
        ed.switch_to_next_buffer(window)
    }

    /// Put a buffer last in the buffer list, as bury-buffer-internal.
    pub fn buryBufferInternal(ed, buffer: String) {
        ed.bury_buffer_internal(&buffer)
    }

    fn windowParameterNames(ed, window: Win) -> Vec<String> {
        let window = window.0;
        Ok(ed.window_parameters(window).into_iter().map(|(k, _)| k).collect::<Vec<_>>())
    }

    fn windowNextBuffers(ed, window: Win) -> Vec<String> {
        let window = window.0;
        Ok(ed.window_next_buffers(window))
    }

    fn setWindowNextBuffers(ed, window: Win, buffers: Vec<String>) {
        let window = window.0;
        ed.set_window_next_buffers(window, buffers)
    }

    fn currentWindowConfiguration(ed) -> u64 {
        Ok(ed.current_window_configuration())
    }

    fn setWindowConfiguration(ed, id: u64) -> bool {
        ed.set_window_configuration(id)
    }

    /// Not a safe point, as collection's cleanup calls it: a quit pending
    /// then must not stop the configuration being freed.
    #[safe_point = false]
    fn freeWindowConfiguration(ed, id: u64) {
        ed.free_window_configuration(id);
        Ok(())
    }

    /// Kill the text from `beg` to `end`, as Emacs's kill-region: after another
    /// kill it joins that one, before it if `end` comes first.
    pub fn killRegion(ed, beg: usize, end: usize) {
        ed.kill_region(beg, end)
    }

    fn makeSyntaxTable(ed, name: String, parent: Option<String>) {
        if let Some(p) = &parent
            && !ed.syntax_tables.exists(p)
        {
            return Err(Error::new(format!("No such syntax table: {p}")));
        }
        ed.syntax_tables.make(&name, parent.as_deref());
        Ok(())
    }

    fn modifySyntaxEntry(ed, chars: String, descriptor: String, table: Option<String>) {
        let entry = e8_core::syntax_table::Entry::parse(&descriptor)?;
        // The standard table can change too, as in Emacs, for every
        // table that inherits from it.
        let table = table.unwrap_or_else(|| ed.buffer().syntax_table.clone());
        for c in chars.chars() {
            ed.syntax_tables.modify(&table, c, entry);
        }
        Ok(())
    }

    /// The current buffer's syntax table.
    pub fn syntaxTable(ed) -> String {
        Ok(ed.buffer().syntax_table.clone())
    }

    pub fn setSyntaxTable(ed, name: String) {
        if !ed.syntax_tables.exists(&name) {
            return Err(Error::new(format!("No such syntax table: {name}")));
        }
        ed.buffer_mut().syntax_table = name;
        Ok(())
    }

    /// The standard syntax table, which every other inherits from in the end, as standard-syntax-table.
    pub fn standardSyntaxTable(ed) -> String {
        Ok(e8_core::syntax_table::STANDARD.to_string())
    }

    /// A new syntax table holding a copy of a table's own entries, the
    /// standard table's by default, with its parent, as copy-syntax-table.
    /// Syntax tables are named: the copy's name is returned.
    #[ts = "(table?: string): string"]
    pub fn copySyntaxTable(ed, table: Opt<String>) -> String {
        let from = table.0.unwrap_or_else(|| e8_core::syntax_table::STANDARD.to_string());
        if !ed.syntax_tables.exists(&from) {
            return Err(Error::signal("wrong-type-argument", format!("Not a syntax table: {from}"), vec![EditorValue::Symbol("syntax-table-p".into()), EditorValue::Str(from)]));
        }
        let base = from.strip_suffix("-syntax-table").unwrap_or(&from).to_string();
        let name = loop {
            ed.syntax_tables.copies += 1;
            let name = format!("{base}-copy-{}-syntax-table", ed.syntax_tables.copies);
            if !ed.syntax_tables.exists(&name) {
                break name;
            }
        };
        ed.syntax_tables.copy(&from, &name);
        Ok(name)
    }

    /// Whether a value names a syntax table, as syntax-table-p.
    #[ts = "(value: unknown): boolean"]
    pub fn syntaxTableP(ed, value: EditorValue) -> bool {
        Ok(matches!(&value, EditorValue::Str(s) | EditorValue::Symbol(s) if ed.syntax_tables.exists(s)))
    }

    /// The raw syntax descriptor a descriptor such as "()" or ". 124b"
    /// stands for, as string-to-syntax: the class's number with the flags
    /// above it, and the matching character; undefined for "@", inherit.
    /// A syntax-table text property may hold it.
    #[ts = "(descriptor: string): [number, string | null] | undefined"]
    pub fn stringToSyntax(ed, descriptor: String) -> Option<EditorValue> {
        let entry = e8_core::syntax_table::Entry::parse(&descriptor)?;
        if entry.class == e8_core::syntax_table::Class::Inherit {
            return Ok(None);
        }
        let matching = entry.matching.map(|c| EditorValue::Str(c.to_string())).unwrap_or(EditorValue::Null);
        Ok(Some(EditorValue::List(vec![EditorValue::Number(f64::from(entry.raw_code())), matching])))
    }

    /// The designator of a syntax class by its number, as syntax-class-to-char.
    pub fn syntaxClassToChar(ed, code: f64) -> String {
        let c = Some(code)
            .filter(|n| *n >= 0.0 && n.fract() == 0.0)
            .and_then(|n| e8_core::syntax_table::Class::ALL.get(n as usize))
            .ok_or_else(|| Error::signal("args-out-of-range", format!("No syntax class {code}"), vec![EditorValue::Number(code)]))?;
        Ok(c.designator().to_string())
    }

    /// A character's entry in the current syntax table, as modify-syntax-entry writes it.
    #[ts = "(char: string): string | undefined"]
    pub fn syntaxEntry(ed, c: String) -> Option<String> {
        Ok(c.chars().next().map(|c| ed.char_syntax(c).descriptor()))
    }

    fn scanLists(ed, from: usize, count: f64, depth: f64, sexp: bool) -> Option<usize> {
        let to = if count > 0.0 { ed.buffer().point_max() } else { from };
        ed.syntax_propertize(to)?;
        ed.scanner().scan_lists(from, count as i64, depth as i64, sexp)
    }

    fn forwardComment(ed, count: f64) -> bool {
        let to = if count > 0.0 { ed.buffer().point_max() } else { ed.buffer().point() };
        ed.syntax_propertize(to)?;
        let (pos, all) = ed.scanner().forward_comment(ed.buffer().point(), count as i64);
        ed.buffer_mut().set_point(pos);
        Ok(all)
    }

    /// Move back over expression prefixes, as Emacs's backward-prefix-chars.
    pub fn backwardPrefixChars(ed) {
        ed.syntax_propertize(ed.buffer().point())?;
        let pos = ed.scanner().backward_prefix_chars(ed.buffer().point());
        ed.buffer_mut().set_point(pos);
        Ok(())
    }

    fn makeMarker(ed, pos: usize, buffer: Option<String>, advances: bool) -> f64 {
        let b = match &buffer {
            Some(name) => ed.buffer_named_mut(name).ok_or_else(|| Error::new(format!("No such buffer: {name}")))?,
            None => ed.buffer_mut(),
        };
        Ok(b.make_marker(pos, advances) as f64)
    }

    /// Forget an editor function a script's function called, once that is
    /// collected. Not a safe point: collection's cleanup must not be quit.
    #[safe_point = false]
    fn forgetFunction(ed, id: f64) {
        crate::engine::forget_function(id as u64);
        Ok(())
    }

    /// Collect garbage now, as Emacs's garbage-collect: markers nothing
    /// refers to any more are freed by the time the code running finishes.
    pub fn garbageCollect(ed) {
        crate::engine::collect_garbage();
        Ok(())
    }

    /// Not a safe point, as collection's cleanup calls it: a quit pending
    /// then must not stop the marker being deleted.
    #[safe_point = false]
    fn deleteMarker(ed, id: f64) {
        ed.delete_marker(id as u64);
        Ok(())
    }

    fn markerPosition(ed, id: f64) -> Option<usize> {
        Ok(ed.marker_position(id as u64).map(|(_, p)| p))
    }

    fn markerBuffer(ed, id: f64) -> Option<String> {
        Ok(ed.marker_position(id as u64).map(|(b, _)| b.to_string()))
    }

    fn setMarker(ed, id: f64, pos: Option<usize>, buffer: Option<String>) {
        let name = match (pos, buffer) {
            (None, _) => None,
            (Some(_), Some(name)) => Some(name),
            // Where it is, or the current buffer if nowhere.
            (Some(_), None) => Some(
                ed.marker_position(id as u64).map(|(b, _)| b.to_string()).unwrap_or_else(|| ed.buffer().name.clone()),
            ),
        };
        ed.set_marker(id as u64, name.as_deref(), pos.unwrap_or(0))
    }

    fn overlayRange(ed, id: f64) -> Option<Vec<usize>> {
        let id = id as u64;
        Ok(ed.overlay_buffer_index(id).and_then(|i| ed.buffers()[i].overlay(id)).map(|o| vec![o.start, o.end]))
    }

    /// The buffer an overlay is in, or undefined once it is deleted, as overlay-buffer.
    #[ts = "(overlay: number): string | undefined"]
    pub fn overlayBuffer(ed, id: f64) -> Option<String> {
        Ok(ed.overlay_buffer_index(id as u64).map(|i| ed.buffers()[i].name.clone()))
    }

    /// An overlay's properties, as overlay-properties; undefined once it is deleted.
    #[ts = "(overlay: number): { [name: string]: Value } | undefined"]
    pub fn overlayProperties(ed, id: f64) -> Option<e8_core::Props> {
        let id = id as u64;
        Ok(ed.overlay_buffer_index(id).and_then(|i| ed.buffers()[i].overlay(id)).map(|o| o.props.clone()))
    }

    /// Whether a value is a live overlay, as overlayp; Emacs's is true of deleted ones too.
    #[ts = "(value: unknown): boolean"]
    pub fn overlayp(ed, value: EditorValue) -> bool {
        Ok(matches!(value, EditorValue::Number(n) if n >= 1.0 && n.fract() == 0.0 && ed.overlay_buffer_index(n as u64).is_some()))
    }

    /// The current buffer's overlays, in the order made, as overlay-lists gives them in one list.
    #[ts = "(): number[]"]
    pub fn overlayLists(ed) -> Vec<f64> {
        Ok(ed.buffer().overlay_ids().into_iter().map(|id| id as f64).collect())
    }

    /// Delete every overlay of a buffer, the current one by default, as delete-all-overlays.
    #[ts = "(buffer?: string): void"]
    pub fn deleteAllOverlays(ed, buffer: Opt<String>) {
        match buffer.0 {
            Some(name) => ed.buffer_named_mut(&name).ok_or_else(|| Error::new(format!("No such buffer: {name}")))?.delete_all_overlays(),
            None => ed.buffer_mut().delete_all_overlays(),
        }
        Ok(())
    }

    #[ts = "(overlay: number, start: number, end: number): void"]
    pub fn moveOverlay(ed, id: f64, start: usize, end: usize) {
        ed.overlay_buffer_mut(id as u64)?.move_overlay(id as u64, start..end)
    }

    #[ts = "(overlay: number): void"]
    pub fn deleteOverlay(ed, id: f64) {
        if let Ok(b) = ed.overlay_buffer_mut(id as u64) {
            b.delete_overlay(id as u64);
        }
        Ok(())
    }

    /// Overlays overlapping the range, and empty ones inside it.
    pub fn overlaysIn(ed, start: usize, end: usize) -> Vec<f64> {
        // Overlays that overlap the range, and empty ones inside it, as Emacs's overlays-in.
        Ok(ed.buffer().overlays_in(start, end).into_iter().map(|o| o.id as f64).collect::<Vec<f64>>())
    }

    /// How many lines the buffer has, counting the empty line after a final newline.
    pub fn lineCount(ed) -> usize {
        Ok(ed.buffer().line_count())
    }

    /// The line, counting from 0, that a position is on.
    #[ts = "(position: number): number"]
    pub fn lineOf(ed, pos: usize) -> usize {
        Ok(ed.buffer().line_of(pos.min(ed.buffer().len())))
    }

    /// The position where a line starts.
    pub fn lineStart(ed, line: usize) -> usize {
        Ok(accessible_line(ed.buffer(), line).0)
    }

    /// The position where a line ends, before its newline.
    pub fn lineEnd(ed, line: usize) -> usize {
        Ok(accessible_line(ed.buffer(), line).1)
    }

    /// A line's text, without its newline.
    pub fn lineText(ed, line: usize) -> String {
        let (start, end) = accessible_line(ed.buffer(), line);
        Ok(ed.buffer().slice(start..end))
    }

    /// How many characters the buffer has. Positions count characters, while
    /// JavaScript string indices count UTF-16 units, which differ for emoji and
    /// other characters outside the Basic Multilingual Plane; work with lines
    /// and positions from these functions rather than indices into bufferText().
    pub fn bufferSize(ed) -> usize {
        Ok(ed.buffer().len())
    }

    /// Where the accessible portion starts: 0 unless the buffer is narrowed, as point-min.
    pub fn pointMin(ed) -> usize {
        Ok(ed.buffer().point_min())
    }

    /// Where the accessible portion ends: the buffer's size unless it is narrowed, as point-max.
    pub fn pointMax(ed) -> usize {
        Ok(ed.buffer().point_max())
    }

    /// Restrict editing and display to a range, as narrow-to-region.
    pub fn narrowToRegion(ed, start: usize, end: usize) {
        ed.buffer_mut().narrow(start, end);
        Ok(())
    }

    /// Make the whole buffer accessible again, as widen.
    pub fn widen(ed) {
        ed.buffer_mut().widen();
        Ok(())
    }

    /// Whether the current buffer changed since it was visited or saved (Emacs's buffer-modified-p).
    pub fn bufferModified(ed) -> bool {
        Ok(ed.buffer().is_modified())
    }

    /// Mark the current buffer modified or not, as Emacs's set-buffer-modified-p.
    pub fn setBufferModified(ed, modified: bool) {
        ed.buffer_mut().set_modified(modified);
        Ok(())
    }

    /// Indirect buffers, as buffer.c's: ids, as buffer objects refer to them.
    fn makeIndirectBuffer(ed, base: String, name: String, clone: bool) -> f64 {
        let index = ed.make_indirect_buffer(&base, &name, clone)?;
        Ok(ed.buffers()[index].id() as f64)
    }

    fn bufferBaseBuffer(ed, name: String) -> Option<f64> {
        let index = ed.find_buffer(&name).ok_or_else(|| e8_core::Error::new(format!("No such buffer {name}")))?;
        Ok(ed.buffers()[index].base_buffer().map(|id| id as f64))
    }

    /// name, or the first of name<2>, name<3> and on that no buffer has, as generate-new-buffer-name.
    pub fn generateNewBufferName(ed, name: String) -> String {
        Ok(ed.unique_buffer_name(&name))
    }

    fn setUndoEnabled(ed, on: bool) {
        ed.buffer_mut().set_undo_enabled(on);
        Ok(())
    }

    /// A count of the changes to the current buffer's text and its
    /// properties, as Emacs's buffer-modified-tick: it is larger after any
    /// edit, and after a text property change that modifies the buffer.
    pub fn bufferModifiedTick(ed) -> f64 {
        Ok(ed.buffer().modified_tick_with_properties() as f64)
    }

    /// A count of the changes to a buffer's text, the current one's by
    /// default, as buffer-chars-modified-tick: larger after any edit to its characters.
    #[ts = "(buffer?: string): number"]
    pub fn bufferCharsModifiedTick(ed, buffer: Opt<String>) -> f64 {
        let b = match buffer.0 {
            Some(name) => ed.buffers().iter().find(|b| b.name == name).ok_or_else(|| Error::new(format!("No such buffer: {name}")))?,
            None => ed.buffer(),
        };
        Ok(b.modified_tick() as f64)
    }

    /// The message the echo area shows, as current-message; undefined if none.
    pub fn currentMessage(ed) -> Option<String> {
        Ok(ed.echo().map(str::to_string))
    }

    fn markerInsertionType(ed, marker: f64) -> Option<bool> {
        Ok(ed.marker_insertion_type(marker as u64))
    }

    fn setMarkerInsertionType(ed, marker: f64, advances: bool) {
        ed.set_marker_insertion_type(marker as u64, advances);
        Ok(())
    }

    /// A buffer's own variables and their values, the current one's by
    /// default, as buffer-local-variables.
    #[ts = "(buffer?: string): [string, Value][]"]
    pub fn bufferLocalVariables(ed, buffer: Opt<String>) -> EditorValue {
        let b = match buffer.0 {
            Some(name) => ed.buffers().iter().find(|b| b.name == name).ok_or_else(|| Error::new(format!("No such buffer: {name}")))?,
            None => ed.buffer(),
        };
        Ok(EditorValue::List(
            b.local_variables().map(|(name, value)| EditorValue::List(vec![EditorValue::Str(name.to_string()), value.clone()])).collect(),
        ))
    }

    /// How many bytes of the current buffer come before a position, as
    /// position-bytes counts them from 0: UTF-8's, a raw byte counting 2.
    #[ts = "(position: number): number | undefined"]
    pub fn positionBytes(ed, pos: usize) -> Option<usize> {
        Ok(ed.buffer().position_bytes(pos))
    }

    /// The position of the character a byte offset of the current buffer
    /// falls in, as byte-to-position, counting from 0.
    #[ts = "(byte: number): number | undefined"]
    pub fn byteToPosition(ed, byte: usize) -> Option<usize> {
        Ok(ed.buffer().byte_to_position(byte))
    }

    fn replaceBufferContents(ed, source: String, max_costs: f64) -> bool {
        ed.replace_buffer_contents(&source, max_costs.max(0.0) as usize)
    }

    fn transposeRegions(ed, start1: usize, end1: usize, start2: usize, end2: usize, leave_markers: bool) {
        ed.transpose_regions((start1, end1), (start2, end2), leave_markers)
    }

    /// Whether the character at a position is hidden.
    #[ts = "(position: number): boolean"]
    pub fn invisibleAt(ed, pos: usize) -> bool {
        Ok(ed.invisible_in(ed.buffer(), pos).is_some())
    }

    /// The names of all faces, sorted, as face-list.
    pub fn faceList(ed) -> Vec<String> {
        let mut names: Vec<String> = ed.faces().map(|f| f.name.clone()).collect();
        names.sort();
        Ok(names)
    }

    fn makeFace(ed, name: String) {
        ed.make_face(&name);
        Ok(())
    }

    fn copyFace(ed, old: String, new: String) {
        ed.copy_face(&old, &new);
        Ok(())
    }

    fn recordCurrentBuffer(ed) -> f64 {
        Ok(ed.record_current_buffer() as f64)
    }

    fn recordExcursion(ed) -> f64 {
        Ok(ed.record_excursion() as f64)
    }

    fn recordRestriction(ed) -> f64 {
        Ok(ed.record_restriction() as f64)
    }

    /// The font families the frame can show, sorted, as font-family-list: none on a terminal.
    pub fn fontFamilyList(ed) -> Vec<String> {
        Ok(ed.font_family_list())
    }

    fn faceFont(ed, face: String) -> Option<String> {
        Ok(ed.face_font(&face))
    }

    /// The XLFD names of the fonts matching a pattern with `*` and `?`, at most `max`, as x-list-fonts.
    #[ts = "(pattern: string, max?: number): string[]"]
    pub fn xListFonts(ed, pattern: String, max: Option<f64>) -> Vec<String> {
        Ok(ed.x_list_fonts(&pattern, max.map(|m| m as usize)))
    }

    /// Set a text property on the characters from start up to end (Emacs's
    /// put-text-property). "face" names a face or a list of faces, earlier ones
    /// winning; "invisible" hides text, as buffer-invisibility-spec says.
    pub fn putTextProperty(ed, start: usize, end: usize, name: String, value: EditorValue) {
        ed.buffer_mut().change_text_property(start..end, &name, Some(value));
        Ok(())
    }

    /// A property from the highest priority overlay that has it, otherwise from the text (Emacs's get-char-property).
    #[ts = "(position: number, name: string): Value | undefined"]
    pub fn charProperty(ed, pos: usize, name: String) -> Option<EditorValue> {
        Ok(ed.buffer().char_property(pos, &name).cloned())
    }

    fn textPropertySearch(ed, matching: bool, start: usize, end: usize, prop: String, value: EditorValue) -> Option<usize> {
        let b = ed.buffer();
        Ok(if matching { b.text_property_any(start, end, &prop, &value) } else { b.text_property_not_all(start, end, &prop, &value) })
    }

    fn getPosProperty(ed, pos: usize, prop: String) -> Option<EditorValue> {
        Ok(ed.get_pos_property(pos, &prop))
    }

    #[ts = "(overlay: number, name: string, value: Value): void"]
    pub fn overlayPut(ed, id: f64, name: String, value: EditorValue) {
        ed.overlay_buffer_mut(id as u64)?.overlay_put(id as u64, &name, value)
    }

    fn invisibleValue(ed, value: EditorValue) -> Option<i32> {
        Ok(ed.invisible_value(&value).map(|ellipsis| if ellipsis { 2 } else { 1 }))
    }

    fn defineFringeBitmap(ed, name: String, bits: Vec<u32>, width: Option<u8>, align: String) {
        let align = match align.as_str() {
            "top" => e8_core::FringeAlign::Top,
            "bottom" => e8_core::FringeAlign::Bottom,
            _ => e8_core::FringeAlign::Center,
        };
        ed.define_fringe_bitmap(&name, bits.into_iter().map(|b| b as u16).collect(), width, align)
    }

    fn setWindowParameter(ed, window: Win, name: String, value: EditorValue) {
        let window = window.0;
        ed.set_window_parameter(window, &name, value)
    }

    fn windowDedicatedP(ed, window: Win) -> EditorValue {
        let window = window.0;
        Ok(ed.window_dedicated(window))
    }

    fn setWindowDedicatedP(ed, window: Win, flag: EditorValue) {
        let window = window.0;
        ed.set_window_dedicated(window, flag)
    }

    fn windowPrevBuffers(ed, window: Win) -> EditorValue {
        let window = window.0;
        let entries = ed.window_prev_buffers(window);
        let list = entries.into_iter().map(|(b, s, p)| EditorValue::List(vec![EditorValue::Str(b), EditorValue::Number(s as f64), EditorValue::Number(p as f64)])).collect();
        Ok(EditorValue::List(list))
    }

    /// Replace each `from` character between start and end with `to`, in place,
    /// as Emacs's subst-char-in-region: point and markers stay where they are,
    /// and undo leaves point at the change.
    pub fn substCharInRegion(ed, start: usize, end: usize, from: String, to: String) {
        let (Some(from), Some(to)) = (from.chars().next(), to.chars().next()) else {
            return Err(Error::signal("wrong-type-argument", "substCharInRegion takes characters", Vec::new()));
        };
        ed.subst_char_in_region(start, end, from, to)
    }

    /// The undo history as data, as buffer-undo-list: true when undo is off.
    fn bufferUndoList(ed) -> EditorValue {
        let list = {
        // An indirect buffer's is its base's.
                        let current = ed.buffer_with_id(ed.buffer().id()).expect("current");
        ed.claim_undo(current);
        ed.buffer().undo_list()
        };
        Ok(list.unwrap_or(EditorValue::Bool(true)))
    }

    /// The current buffer's undo steps, oldest first, as a tree of states:
    /// for an undo, the step it took back, after which the buffer is as it
    /// was before that step; and where the buffer was unmodified before a
    /// step, which save that was, counting up. Emacs's vundo reads these
    /// from buffer-undo-list and undo-equiv-table.
    #[ts = "(): { undid?: number; undo: boolean; saved?: number }[]"]
    pub fn undoHistory(ed) -> Vec<Record> {
        let current = ed.buffer_with_id(ed.buffer().id()).expect("current");
        ed.claim_undo(current);
        Ok(ed.buffer_mut().undo_history().into_iter().map(|s| {
            Record::new().with("undid", s.undid).with("undo", s.undo).with("saved", s.saved.map(|n| n as f64))
        }).collect())
    }

    /// Undoes the step of undoHistory at INDEX, as vundo has primitive-undo
    /// take back one modification: the undo is a step of its own.
    pub fn undoStep(ed, index: usize) {
        ed.undo_step(index)
    }

    /// Forgets the undo steps after the first KEEP, as vundo sets
    /// buffer-undo-list to a tail of itself.
    pub fn truncateUndo(ed, keep: usize) {
        let current = ed.buffer_with_id(ed.buffer().id()).expect("current");
        ed.claim_undo(current);
        ed.buffer_mut().truncate_undo(keep);
        Ok(())
    }

    /// The binding stack, as Emacs's specpdl: letBind, withCurrentBuffer,
    /// saveExcursion and saveRestriction push entries and unbind them.
    fn specbind(ed, name: String, value: EditorValue) -> f64 {
        Ok(ed.specbind(&name, value) as f64)
    }

    fn charDisplayableP(ed, c: String) -> bool {
        let c = c.chars().next().unwrap_or('\0');
        Ok(ed.char_displayable_p(c))
    }

    /// The text properties of the character at a position.
    #[ts = "(position: number): { [name: string]: Value }"]
    pub fn textPropertiesAt(ed, pos: usize) -> e8_core::Props {
        Ok(ed.buffer().text_properties_at(pos).cloned().unwrap_or_default())
    }

    #[ts = "(overlay: number, name: string): Value | undefined"]
    pub fn overlayGet(ed, id: f64, name: String) -> Option<EditorValue> {
        let id = id as u64;
        Ok(ed.overlay_buffer_index(id).and_then(|i| ed.buffers()[i].overlay(id)).and_then(|o| o.props.get(&name).cloned()))
    }

    fn posnAtPoint(ed, pos: usize, window: Win) -> Posn {
        let window = window.0;
        Ok(Posn(ed.posn_at_point(pos, window)))
    }

    fn posnAtXY(ed, x: f64, y: f64, window: Win) -> Posn {
        let window = window.0;
        Ok(Posn(ed.posn_at_x_y(x as f32, y as f32, window)))
    }

    fn windowParameter(ed, window: Win, name: String) -> Option<EditorValue> {
        let window = window.0;
        Ok(ed.window_parameter(window, &name).cloned())
    }

    /// Each entry `[buffer, start, point]`.
    fn setWindowPrevBuffers(ed, window: Win, buffers: EditorValue) {
        let window = window.0;
        let EditorValue::List(items) = buffers else {
            return Err(Error::signal("wrong-type-argument", "setWindowPrevBuffers takes [buffer, start, point] entries", Vec::new()));
        };
        let entries = items
            .into_iter()
            .filter_map(|e| match e {
                EditorValue::List(e) => match e.as_slice() {
                    [b, s, p] => Some((b.as_str()?.to_string(), s.as_number()? as usize, p.as_number()? as usize)),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        ed.set_window_prev_buffers(window, entries)
    }

    fn defineError(ed, symbol: String, parent: String) {
        e8_core::define_error(&symbol, &parent);
        Ok(())
    }

    fn errorConditions(ed, symbol: String) -> Vec<String> {
        Ok(e8_core::error_conditions(&symbol))
    }

    fn parsePartialSexp(ed, from: Option<usize>, to: usize) -> Record {
        ed.syntax_propertize(to)?;
        let scanner = ed.scanner();
        // With no start, from the start of the buffer through its kept states, as syntax-ppss.
        let st = match from {
            None => scanner.ppss(to),
            Some(from) => {
                let (from, to) = (from.clamp(scanner.min, scanner.max), to.clamp(scanner.min, scanner.max));
                scanner.parse(from, to, Default::default())
            }
        };
        Ok(Record::new()
            .with("depth", st.depth as f64)
            .with("innermostStart", st.innermost_start)
            .with("lastComplete", st.last_complete)
            .with("inString", st.in_string.map(|c| c.to_string()))
            .with("inComment", st.in_comment.map(|n| n as f64))
            .with("quoted", st.quoted)
            .with("minDepth", st.min_depth as f64)
            .with("commentStyle", st.comment_style)
            .with("start", st.string_or_comment_start)
            .with("openParens", st.open_parens))
    }

    fn defineFace(ed, name: String, doc: String, attrs: FaceAttrs, dark: FaceAttrs, light: FaceAttrs) {
        let mut face = Face::new(&name, &doc, attrs);
        face.dark = dark;
        face.light = light;
        face.source = LOADING.with_borrow(|files| files.last().cloned());
        ed.define_face(face);
        Ok(())
    }

    fn setFaceAttribute(ed, name: String, attrs: FaceAttrValues, background: String) {
        let background = match background.as_str() {
            "dark" => Background::Dark,
            "light" => Background::Light,
            _ => Background::Both,
        };
        for (key, value) in &attrs.0 {
            ed.set_face_attribute(&name, key, value, background);
        }
        Ok(())
    }

    fn faceAttributes(ed, name: String, dark: bool) -> FaceAttrs {
        Ok(ed.face_attrs(&name, dark))
    }

    /// One of a face's attributes, as Emacs's face-attribute: by its Emacs
    /// name (":weight") or a script's ("weight"), on the frame's background;
    /// with `inherit`, what the face inherits counts too. "unspecified" if
    /// nothing sets it.
    #[ts = "(face: FaceName | (string & {}), attribute: string, inherit?: boolean): Value"]
    pub fn faceAttribute(ed, name: String, key: String, inherit: bool) -> PlistOrValue {
        Ok(PlistOrValue(ed.face_attribute(&name, &face_attribute_key(&key), inherit)))
    }

    /// Restoring is never a place to quit: the cleanup always runs.
    #[safe_point = false]
    fn unbind(ed, id: f64) {
        ed.unbind(id as u64);
        Ok(())
    }

    /// Quitting: the loop checks call this every 1024 iterations.
    fn maybeQuit(ed) {
        Ok(())
    }

    /// Whether C-g was typed and not yet answered, as quit-flag.
    #[safe_point = false]
    pub fn quitFlag(ed) -> bool {
        Ok(ed.quit_state().requested())
    }

    /// Set or clear quit-flag, as setting the variable does.
    #[safe_point = false]
    pub fn setQuitFlag(ed, on: bool) {
        if on {
            ed.request_quit();
        } else {
            ed.quit_state().discard();
        }
        Ok(())
    }

    fn fontSpec(ed, plist: EditorValue) -> EditorValue {
        let plist = match plist {
            EditorValue::List(items) => items,
            _ => Vec::new(),
        };
        Ok(font_value(e8_core::font_spec(&plist)?))
    }

    fn fontGet(ed, font: EditorValue, key: String) -> EditorValue {
        Ok(font_of(font)?.get(&key))
    }

    fn fontPut(ed, font: EditorValue, key: String, value: EditorValue) -> EditorValue {
        let mut font = font_of(font)?;
        font.put(&key, value)?;
        Ok(font_value(font))
    }

    /// A font's XLFD name, runs of wildcards folded into one if `foldWildcards`, as font-xlfd-name.
    #[ts = "(font: Font, foldWildcards?: boolean): string"]
    pub fn fontXlfdName(ed, font: EditorValue, fold: bool) -> String {
        Ok(font_of(font)?.xlfd_name(fold))
    }

    fn fontAt(ed, pos: f64) -> Option<EditorValue> {
        Ok(ed.font_at(pos as usize).map(font_value))
    }

    /// The fonts matching a spec, at most `max`, as list-fonts.
    #[ts = "(spec: Font, max?: number): Font[]"]
    pub fn listFonts(ed, spec: EditorValue, max: Option<f64>) -> EditorValue {
        let spec = font_of(spec)?;
        Ok(EditorValue::List(ed.list_fonts(&spec, max.map(|m| m as usize)).into_iter().map(font_value).collect()))
    }

    fn fontInfo(ed, name: String) -> Option<EditorValue> {
        Ok(ed.font_info(&name).map(EditorValue::List))
    }

    fn queryFont(ed, font: EditorValue) -> Option<EditorValue> {
        let font = font_of(font)?;
        Ok(ed.query_font(&font).map(EditorValue::List))
    }

    fn fontHasCharP(ed, font: EditorValue, c: String) -> bool {
        let font = font_of(font)?;
        Ok(ed.font_has_char_p(&font, c.chars().next().unwrap_or('\0')))
    }

    /// A colour's red, green and blue from 0 to 65535, as color-values, or undefined if it is no colour.
    #[ts = "(color: string): [number, number, number] | undefined"]
    pub fn colorValues(ed, spec: String) -> Option<Vec<u32>> {
        Ok(e8_core::color_values(&spec).map(|v| v.map(u32::from).to_vec()))
    }

    /// The values of a colour spec ("#rgb", "rgb:R/G/B", "rgbi:R/G/B"), not a name, as color-values-from-color-spec.
    #[ts = "(spec: string): [number, number, number] | undefined"]
    pub fn colorValuesFromColorSpec(ed, spec: String) -> Option<Vec<u32>> {
        Ok(e8_core::color_values_from_spec(&spec).map(|v| v.map(u32::from).to_vec()))
    }

    /// The names of the colours Emacs knows, as defined-colors.
    pub fn definedColors(ed) -> Vec<String> {
        Ok(e8_core::color_names().map(str::to_string).collect())
    }

    fn colorDistance(ed, a: String, b: String) -> Option<f64> {
        Ok((|| Some(e8_core::color_distance(e8_core::color_values(&a)?, e8_core::color_values(&b)?) as f64))())
    }

    fn colorGrayP(ed, spec: String) -> Option<bool> {
        Ok(e8_core::color_values(&spec).map(e8_core::color_gray_p))
    }

    /// A face's documentation and own attributes, or undefined if there is no such face.
    #[ts = "(name: FaceName | (string & {})): | { doc: string; source?: string; attributes: FaceAttributes; dark: FaceAttributes; light: FaceAttributes } | undefined"]
    pub fn faceInfo(ed, name: String) -> Option<Record> {
        Ok(ed.face(&name).cloned().map(|face| {
            Record::new()
                .with("doc", face.doc)
                .with("source", face.source)
                .with("attributes", Field::FaceAttrs(Box::new(face.attrs)))
                .with("dark", Field::FaceAttrs(Box::new(face.dark)))
                .with("light", Field::FaceAttrs(Box::new(face.light)))
        }))
    }

    /// A string in upper case, as Emacs's upcase: the case table's upper case
    /// of each character, ß becoming SS and the other characters Unicode
    /// cases into several doing so.
    pub fn upcase(ed, s: String) -> String {
        Ok(ed.casify_string(e8_core::casefiddle::Case::Up, &s))
    }

    /// A string in lower case, as downcase: a capital sigma ending a word becomes final sigma.
    pub fn downcase(ed, s: String) -> String {
        Ok(ed.casify_string(e8_core::casefiddle::Case::Down, &s))
    }

    /// A string capitalized, as capitalize: each word's first character in
    /// title case and the rest in lower case, words being runs of word
    /// constituents in the current buffer's syntax table.
    pub fn capitalize(ed, s: String) -> String {
        Ok(ed.casify_string(e8_core::casefiddle::Case::Capitalize, &s))
    }

    /// A string with each word's first character in title case and the rest as it is, as upcase-initials.
    pub fn upcaseInitials(ed, s: String) -> String {
        Ok(ed.casify_string(e8_core::casefiddle::Case::UpcaseInitials, &s))
    }

    /// Read one Lisp datum from a string, from index `start`, as Emacs's
    /// read-from-string: the value, with nil as null, t as true, symbols as
    /// symbols and lists as arrays (a dotted end joining the list), and the
    /// index after it. Indexes count as JavaScript's do, so `string.slice`
    /// takes them. Signals end-of-file or invalid-read-syntax.
    #[ts = "(string: string, start?: number): [Value, number]"]
    pub fn readFromString(ed, string: String, start: Opt<usize>) -> (e8_core::Value, usize) {
        // JavaScript counts UTF-16 units; the reader counts characters.
        let start = start.0.unwrap_or(0);
        let mut units = 0;
        let from = string.chars().take_while(|c| {
            let before = units;
            units += c.len_utf16();
            before < start
        }).count();
        let (value, end) = e8_core::lread::read_from_string(&string, from)?;
        Ok((value, string.chars().take(end).map(char::len_utf16).sum()))
    }

    /// A value written as Lisp would read it back, as prin1-to-string; with
    /// `noescape`, strings and symbols as their text, as princ writes them.
    pub fn prin1ToString(ed, value: e8_core::Value, noescape: Opt<bool>) -> String {
        Ok(ed.prin1_to_string(&value, noescape.0.unwrap_or(false)))
    }
}
