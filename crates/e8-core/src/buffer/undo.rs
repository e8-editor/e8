//! A buffer's undo history, as Emacs's undo.c and simple.el's undo
//! commands keep it: the steps of edits recorded as they are made, the
//! boundaries commands put between them, undoing and redoing them, in the
//! region too, change groups, and `buffer-undo-list` as data. Its types
//! and the fields holding the history are in buffer.rs with the rest of
//! [`Buffer`]; the invariants that tie those fields together are kept here.

use super::*;

impl Buffer {
    /// How many undo steps the buffer has, for [`Buffer::amalgamate_undo`].
    pub fn undo_steps(&mut self) -> usize {
        self.undo_boundary();
        self.undo_groups.len()
    }

    /// Joins the undo steps made since there were `since` into one, as
    /// Emacs's `undo-amalgamate-change-group` does, so one undo takes them
    /// all back.
    pub fn amalgamate_undo_since(&mut self, since: usize) {
        self.undo_boundary();
        if self.undo_groups.len() <= since + 1 {
            return;
        }
        let groups: Vec<Group> = self.undo_groups.drain(since..).collect();
        let merged = Group {
            edits: groups.iter().flat_map(|g| g.edits.iter().cloned()).collect(),
            kind: GroupKind::Change,
            unmodified_at: groups[0].unmodified_at,
            point: groups[0].point,
        };
        self.undo_groups.push(merged);
        self.pending_undo = None;
    }

    /// The undo steps, oldest first, as vundo reads them from
    /// `buffer-undo-list` and `undo-equiv-table`. Closes the step being
    /// made, as a boundary would.
    pub fn undo_history(&mut self) -> Vec<UndoStep> {
        self.undo_boundary();
        self.undo_groups
            .iter()
            .map(|g| UndoStep {
                undid: match g.kind {
                    GroupKind::Undo { undid } => Some(undid),
                    _ => None,
                },
                undo: g.kind != GroupKind::Change,
                saved: g.unmodified_at,
            })
            .collect()
    }

    /// Undoes the step at `index`, as vundo has primitive-undo take back
    /// one modification: the undo is a step of its own, recording which
    /// step it undid.
    pub fn undo_step(&mut self, index: usize) -> Result<()> {
        self.undo_boundary();
        if index >= self.undo_groups.len() {
            return Err(Error::new("No such undo step"));
        }
        self.check_writable()?;
        self.revert(index)?;
        self.close_group(GroupKind::Undo { undid: index });
        self.pending_undo = None;
        Ok(())
    }

    /// Where the changes of the step at `index` start, for the hooks run before it is undone.
    pub(crate) fn undo_step_start(&self, index: usize) -> Option<usize> {
        self.undo_groups.get(index)?.edits.iter().map(|e| e.pos).min()
    }

    /// Forgets the undo steps after the first `keep`, as vundo sets
    /// `buffer-undo-list` back to a tail of itself once they lead nowhere new.
    pub fn truncate_undo(&mut self, keep: usize) {
        self.undo_boundary();
        self.undo_groups.truncate(keep);
        self.pending_undo = self.pending_undo.filter(|&i| i < keep);
    }

    /// Forgets the buffer's undo history, as visiting a file starts it afresh.
    pub(crate) fn clear_undo(&mut self) {
        self.undo_groups.clear();
        self.open_group.clear();
        self.pending_undo = None;
        self.selective_undo = None;
    }

    /// The undo history and what goes with it, to move to another buffer
    /// sharing the text, as Emacs's indirect buffers share one undo list.
    pub(crate) fn take_undo(&mut self) -> UndoState {
        UndoState {
            groups: std::mem::take(&mut self.undo_groups),
            open: std::mem::take(&mut self.open_group),
            open_unmodified_at: self.open_unmodified_at.take(),
            open_point: self.open_point.take(),
            disabled: self.undo_disabled,
            save_generation: self.save_generation,
            pending: self.pending_undo.take(),
            selective: self.selective_undo.take(),
            in_region: std::mem::take(&mut self.undo_in_region),
            edited: std::mem::take(&mut self.edited_since_command),
        }
    }

    pub(crate) fn put_undo(&mut self, state: UndoState) {
        self.undo_groups = state.groups;
        self.open_group = state.open;
        self.open_unmodified_at = state.open_unmodified_at;
        self.open_point = state.open_point;
        self.undo_disabled = state.disabled;
        self.save_generation = state.save_generation;
        self.pending_undo = state.pending;
        self.selective_undo = state.selective;
        self.undo_in_region = state.in_region;
        self.edited_since_command |= state.edited;
    }

    /// The undo history, taken aside while `buffer-undo-list` is bound, as
    /// a `let` keeps the old value, rather than copied out as data and
    /// compared back in: [`Buffer::unbind_undo`] puts it back as it was.
    pub(crate) fn bind_undo(&mut self) -> UndoBinding {
        UndoBinding { state: Box::new(self.take_undo()), stash: self.stashed_undo.take() }
    }

    /// Puts back the history a binding of `buffer-undo-list` took aside,
    /// forgetting what was recorded meanwhile, as the old value's coming
    /// back does in Emacs; saves meanwhile still count.
    pub(crate) fn unbind_undo(&mut self, binding: UndoBinding) {
        let meanwhile = self.take_undo();
        let mut state = *binding.state;
        state.save_generation = meanwhile.save_generation;
        state.edited |= meanwhile.edited;
        self.put_undo(state);
        self.stashed_undo = binding.stash;
    }

    /// Whether edits are recorded for undo, as they are unless Emacs's
    /// `buffer-undo-list` is t.
    pub fn undo_enabled(&self) -> bool {
        !self.undo_disabled
    }

    /// Starts or stops recording edits for undo, as `buffer-enable-undo`
    /// and `buffer-disable-undo`: either forgets what was recorded.
    pub fn set_undo_enabled(&mut self, on: bool) {
        self.clear_undo();
        self.undo_disabled = !on;
    }

    /// The undo history as Emacs's `buffer-undo-list` holds it, newest
    /// first: null for a boundary between commands, a number for where
    /// point was before a command, `[beg, end]` for text inserted there,
    /// `[text, pos]` for text deleted at `pos`, its position negated when
    /// point was after it, and `[true]` where the buffer was unmodified.
    /// Positions count from 0, as everywhere in scripts, so a deletion at
    /// the start with point after it gives -0. `None` if undo is off.
    pub fn undo_list(&self) -> Option<Value> {
        if self.undo_disabled {
            return None;
        }
        let mut list = Vec::new();
        // The changes of the command still going, then each earlier
        // command's after the boundary that ended it.
        let open = (!self.open_group.is_empty()).then_some((&self.open_group, self.open_unmodified_at, self.open_point, false));
        let closed = self.undo_groups.iter().rev().map(|g| (&g.edits, g.unmodified_at, g.point, true));
        for (edits, unmodified_at, point, ended) in open.into_iter().chain(closed) {
            if ended {
                list.push(Value::Null);
            }
            for e in edits.iter().rev() {
                match &e.extra {
                    Extra::Property { name, old } => {
                        for (range, value) in old.iter().rev() {
                            let value = value.clone().unwrap_or(Value::Null);
                            let (beg, end) = (Value::Number(range.start as f64), Value::Number(range.end as f64));
                            list.push(Value::List(vec![Value::Null, Value::Str(name.clone()), value, beg, end]));
                        }
                        continue;
                    }
                    Extra::Apply(args) => {
                        let mut entry = vec![Value::Symbol("apply".into())];
                        entry.extend(args.iter().cloned());
                        list.push(Value::List(entry));
                        continue;
                    }
                    Extra::None => {}
                }
                if !e.inserted.is_empty() {
                    let end = e.pos + e.inserted.chars().count();
                    list.push(Value::List(vec![Value::Number(e.pos as f64), Value::Number(end as f64)]));
                }
                if !e.deleted.is_empty() {
                    let at_end = e.point_before == e.pos + e.deleted.chars().count();
                    let pos = if at_end { -(e.pos as f64) } else { e.pos as f64 };
                    let text = crate::properties::Text { string: e.deleted.clone(), props: e.deleted_props.clone() };
                    list.push(Value::List(vec![Value::Text(text), Value::Number(pos)]));
                }
            }
            // Recorded before the command's first change, so after it here.
            if let Some(p) = point {
                list.push(Value::Number(p as f64));
            }
            if unmodified_at.is_some() {
                list.push(Value::List(vec![Value::Bool(true)]));
            }
        }
        Some(Value::List(list))
    }

    /// Sets the undo history, as setting Emacs's `buffer-undo-list` does:
    /// t stops recording, nil empties it, and a list in the form
    /// [`Buffer::undo_list`] gives becomes the history. Setting t keeps the
    /// history aside, so setting the list it was back, as a `let` binding
    /// t does when it ends, puts it back as it was.
    pub fn set_undo_list(&mut self, value: &Value) {
        let off = matches!(value, Value::Bool(true)) || value.as_str() == Some("t");
        if off {
            // Kept aside as it is, the open step too, so turning recording
            // back on carries on with it: no boundary is made, as in Emacs.
            if !self.undo_disabled {
                self.stashed_undo = Some(Box::new(self.take_undo()));
                self.undo_disabled = true;
            }
            return;
        }
        if let Some(stash) = self.stashed_undo.take() {
            let generation = self.save_generation;
            let mut state = *stash;
            state.disabled = false;
            state.save_generation = generation;
            let pending = std::mem::take(&mut self.edited_since_command);
            self.put_undo(state);
            if self.undo_list().as_ref() == Some(value) {
                self.edited_since_command |= pending;
                return;
            }
            self.take_undo();
            self.edited_since_command |= pending;
        }
        self.undo_disabled = false;
        self.stashed_undo = None;
        self.undo_groups.clear();
        self.open_group.clear();
        self.open_point = None;
        self.open_unmodified_at = None;
        self.pending_undo = None;
        self.selective_undo = None;
        let Value::List(entries) = value else { return };
        // Newest first, a boundary (nil) before each finished command's changes.
        let mut segments: Vec<&[Value]> = entries.split(|e| matches!(e, Value::Null)).collect();
        let open = if segments.is_empty() { &[][..] } else { segments.remove(0) };
        for (i, segment) in std::iter::once(open).chain(segments).enumerate() {
            let group = self.group_from_entries(segment);
            if i == 0 {
                self.open_group = group.edits;
                self.open_point = group.point;
                self.open_unmodified_at = group.unmodified_at;
            } else if !group.edits.is_empty() || group.point.is_some() {
                self.undo_groups.insert(0, group);
            }
        }
    }

    /// One command's changes from undo list entries, newest first.
    pub(super) fn group_from_entries(&self, entries: &[Value]) -> Group {
        let mut group = Group { edits: Vec::new(), kind: GroupKind::Change, unmodified_at: None, point: None };
        let num = |v: &Value| v.as_number();
        for entry in entries.iter().rev() {
            match entry {
                Value::Number(p) => group.point = Some(p.max(0.0) as usize),
                Value::List(items) => match items.as_slice() {
                    [Value::Bool(true), ..] => group.unmodified_at = Some(self.save_generation),
                    [Value::Symbol(s), ..] if s == "t" => group.unmodified_at = Some(self.save_generation),
                    [Value::Symbol(s), args @ ..] if s == "apply" => {
                        group.edits.push(Edit { extra: Extra::Apply(args.to_vec()), ..Edit::property(0, "", Vec::new()) });
                    }
                    [Value::Null, name, value, beg, end] if num(beg).is_some() && num(end).is_some() => {
                        let (beg, end) = (num(beg).unwrap().max(0.0) as usize, num(end).unwrap().max(0.0) as usize);
                        let value = (!matches!(value, Value::Null)).then(|| value.clone());
                        group.edits.push(Edit::property(beg, name.as_str().unwrap_or(""), vec![(beg..end, value)]));
                    }
                    [beg @ Value::Number(_), end @ Value::Number(_)] => {
                        let (beg, end) = (num(beg).unwrap().max(0.0) as usize, num(end).unwrap().max(0.0) as usize);
                        // Undo only takes the inserted text's length out again.
                        let inserted = if end <= self.len() { self.slice(beg.min(end)..end) } else { " ".repeat(end.saturating_sub(beg)) };
                        group.edits.push(Edit {
                            pos: beg,
                            deleted: String::new(),
                            deleted_props: Vec::new(),
                            inserted,
                            point_before: beg,
                            marks: Vec::new(),
                            extra: Extra::None,
                        });
                    }
                    [text @ (Value::Str(_) | Value::Text(_)), pos @ Value::Number(_)] => {
                        let p = num(pos).unwrap();
                        let at = p.abs() as usize;
                        let (string, props) = match text {
                            Value::Text(t) => (t.string.clone(), t.props.clone()),
                            other => (other.as_str().unwrap_or("").to_string(), Vec::new()),
                        };
                        let point_before = if p.is_sign_negative() { at + string.chars().count() } else { at };
                        group.edits.push(Edit {
                            pos: at,
                            deleted: string,
                            deleted_props: props,
                            inserted: String::new(),
                            point_before,
                            marks: Vec::new(),
                            extra: Extra::None,
                        });
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        group
    }

    /// Starts a group of changes that can be taken back as if never made,
    /// as Emacs's prepare-change-group and activate-change-group. Returns
    /// its handle.
    pub fn prepare_change_group(&mut self) -> usize {
        self.change_groups.push(ChangeGroup {
            undo_groups: self.undo_groups.len(),
            modified: self.modified,
            open_group: self.open_group.clone(),
            open_point: self.open_point,
            open_unmodified_at: self.open_unmodified_at,
            log_start: self.change_log.len(),
        });
        self.change_groups.len() - 1
    }

    /// Takes back the changes made since a change group began, leaving no
    /// trace of them in the undo history, as Emacs's cancel-change-group.
    pub fn cancel_change_group(&mut self, handle: usize) {
        if handle >= self.change_groups.len() {
            return;
        }
        let group = self.change_groups.split_off(handle).remove(0);
        let edits = self.change_log.split_off(group.log_start);
        self.cancelling = true;
        for edit in edits.iter().rev() {
            if self.revert_extra(edit) {
                continue;
            }
            let inserted = edit.inserted.chars().count();
            if inserted > 0 {
                self.apply_delete(edit.pos, edit.pos + inserted);
            }
            let back: Vec<(MarkRef, usize)> =
                edit.marks.iter().copied().filter(|&(which, _)| self.mark_ref(which) == Some(edit.pos)).collect();
            self.apply_insert(edit.pos, &edit.deleted, false);
            self.properties.restore(edit.pos, &edit.deleted_props);
            for (which, offset) in back {
                if let Some(m) = self.mark_ref_mut(which) {
                    *m = edit.pos + offset;
                }
            }
        }
        self.cancelling = false;
        self.undo_groups.truncate(group.undo_groups);
        self.modified = group.modified;
        // Unmodified, the buffer is as saved, as Emacs's SAVE_MODIFF says.
        if !self.modified {
            self.file.saved_tick = self.tick;
        }
        self.open_group = group.open_group;
        self.open_point = group.open_point;
        self.open_unmodified_at = group.open_unmodified_at;
        if self.change_groups.is_empty() {
            self.change_log.clear();
        }
    }

    /// Keeps the changes made since a change group began, as Emacs's
    /// accept-change-group.
    pub fn accept_change_group(&mut self, handle: usize) {
        if handle < self.change_groups.len() {
            self.change_groups.truncate(handle);
        }
        if self.change_groups.is_empty() {
            self.change_log.clear();
        }
    }

    /// Takes the boundary before the open undo group away, so its edits and
    /// the group before undo together, as Emacs's undo-auto-amalgamate does.
    pub fn amalgamate_undo(&mut self) {
        if let Some(last) = self.undo_groups.pop_if(|g| g.kind == GroupKind::Change) {
            let mut edits = last.edits;
            edits.append(&mut self.open_group);
            self.open_group = edits;
            self.open_unmodified_at = last.unmodified_at;
            self.open_point = last.point;
        }
    }

    /// Before a command, as Emacs's command loop calls
    /// `undo-auto--add-boundary`: an undo boundary if the text changed
    /// since the last command began. A command that amalgamates takes the
    /// boundary away again, so it gets none, and one that changed nothing,
    /// such as a failed C-d after it, leaves no change to divide off.
    pub fn command_boundary(&mut self, amalgamate: bool) {
        let edited = std::mem::take(&mut self.edited_since_command);
        if edited && !amalgamate {
            self.undo_boundary();
        }
        // Where point was before the command, as Emacs's
        // point_before_last_command_or_undo, amalgamating or not.
        self.boundary_point = self.point;
    }

    /// Ends the current undo group, so the next edit starts a new one.
    /// The editor calls this before each command.
    pub fn undo_boundary(&mut self) {
        self.close_group(GroupKind::Change);
        self.boundary_point = self.point;
    }

    pub(super) fn close_group(&mut self, kind: GroupKind) {
        if !self.open_group.is_empty() {
            let edits = std::mem::take(&mut self.open_group);
            // As Emacs's undo command removes them from its own changes, an
            // undo keeps no point: undoing it goes where the change is.
            let point = if kind == GroupKind::Change { self.open_point } else { None };
            self.undo_groups.push(Group { edits, kind, unmodified_at: self.open_unmodified_at, point });
        }
    }

    /// Undoes one step, the way Emacs's `undo` does.
    ///
    /// Undoing is itself recorded as a change, so it can be undone too. A run
    /// of undos (`continuing`, when the last command was an undo) works back
    /// through history; after any other command, undo starts again from the
    /// most recent change, which may be an earlier undo, so undoing it redoes.
    /// Returns whether this undo redid something.
    pub fn undo(&mut self, continuing: bool) -> Result<bool> {
        self.undo_boundary();
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        let index = if continuing && top_is_undo {
            self.pending_undo
        } else {
            self.undo_groups.len().checked_sub(1)
        };
        let mut index = index.ok_or_else(|| Error::new("No further undo information"))?;
        // Once, and only for the undo on top, as Emacs's undo-equiv-table
        // finds it and what it undid, but not an undo a boundary separates.
        let from_top = index + 1 == self.undo_groups.len();
        if std::mem::take(&mut self.undo_no_redo)
            && from_top
            && let Some(undid) = match self.undo_groups[index].kind {
                GroupKind::Undo { undid } => Some(undid),
                GroupKind::RegionUndo => Some(0),
                GroupKind::Change => None,
            }
        {
            match undid.checked_sub(1) {
                Some(before) => index = before,
                None => {
                    // Nothing before it: only point goes back, to where the
                    // first change was made, as the list's first entry says.
                    if let Some(p) = self.undo_groups[undid].point {
                        self.point = p.min(self.len());
                    }
                    self.pending_undo = None;
                    return Ok(false);
                }
            }
        }
        if let Err(e) = self.check_writable() {
            // Emacs's primitive-undo goes to the change before it makes it,
            // so point has moved when it asks about a file changed on disk.
            if self.file.threatened
                && let Some(edit) = self.undo_groups[index].edits.last()
            {
                self.point = edit.pos.min(self.len());
            }
            return Err(e);
        }
        let redo = self.undo_groups[index].kind != GroupKind::Change;
        self.revert(index)?;
        self.close_group(GroupKind::Undo { undid: index });
        self.pending_undo = index.checked_sub(1);
        self.boundary_point = self.point;
        Ok(redo)
    }

    /// Starts a run of undos in a region, as Emacs's `undo-start` does with
    /// `undo-make-selective-list`: the history keeps only the changes inside
    /// the range, their positions moved for the changes left out, and the
    /// range grows or shrinks with each change it keeps.
    pub fn start_undo_in_region(&mut self, range: Range<usize>) {
        self.undo_boundary();
        let (start, mut end) = (range.start as isize, range.end as isize);
        // The changes left out, oldest last; a position is moved through
        // them oldest first, as undo-adjust-pos does.
        let mut deltas: Vec<(isize, isize)> = Vec::new();
        let adjust = |deltas: &[(isize, isize)], mut pos: isize, before: bool| {
            for &(at, len) in deltas.iter().rev() {
                if if before { at < pos } else { at <= pos } {
                    pos = at.max(pos - len);
                }
            }
            pos
        };
        let mut steps: Vec<Vec<Selective>> = Vec::new();
        let mut step: Vec<Selective> = Vec::new();
        for group in self.undo_groups.iter().rev() {
            // The group's elements as Emacs's list has them, newest first.
            let mut elements = Vec::new();
            for e in group.edits.iter().rev() {
                let pos = e.pos as isize;
                if let Extra::Property { name, old } = &e.extra {
                    elements.push((Selective::Property { name: name.clone(), old: old.clone() }, pos, 0));
                    continue;
                }
                if !e.inserted.is_empty() {
                    elements.push((Selective::Inserted(e.pos, e.pos + e.inserted.chars().count()), pos, -(e.inserted.chars().count() as isize)));
                }
                if !e.deleted.is_empty() {
                    let len = e.deleted.chars().count();
                    let at_end = e.point_before == e.pos + len;
                    let deleted = Selective::Deleted { pos: e.pos, text: e.deleted.clone(), props: e.deleted_props.clone(), at_end, marks: e.marks.clone() };
                    elements.push((deleted, pos, len as isize));
                }
            }
            if let Some(p) = group.point {
                elements.push((Selective::Point(p), 0, 0));
            }
            for (element, at, len) in elements {
                let kept = match element {
                    Selective::Inserted(beg, stop) => {
                        let beg = adjust(&deltas, beg as isize, false);
                        let stop = beg.max(adjust(&deltas, stop as isize, true));
                        (beg >= start && stop <= end).then(|| {
                            end += beg - stop;
                            Selective::Inserted(beg as usize, stop as usize)
                        })
                    }
                    Selective::Deleted { pos, text, props, at_end, marks } => {
                        let pos = adjust(&deltas, pos as isize, false);
                        (pos >= start && pos <= end).then(|| {
                            end += text.chars().count() as isize;
                            // Marks are put back only if they are in the region now.
                            let in_region = |m: Option<usize>| m.is_some_and(|m| start <= m as isize && m as isize <= end);
                            let marks = marks
                                .into_iter()
                                .filter(|&(which, _)| in_region(self.mark_ref(which)))
                                .collect();
                            Selective::Deleted { pos: pos as usize, text, props, at_end, marks }
                        })
                    }
                    Selective::Point(p) => {
                        let p = adjust(&deltas, p as isize, false);
                        (p >= start && p <= end).then_some(Selective::Point(p as usize))
                    }
                    Selective::Unmodified(_) => None,
                    // Kept if it is inside the region and nothing left out came between its ends.
                    Selective::Property { name, old } => {
                        let (beg, stop) = (old.first().map_or(0, |r| r.0.start), old.last().map_or(0, |r| r.0.end));
                        let (b, e) = (adjust(&deltas, beg as isize, false), adjust(&deltas, stop as isize, true));
                        let shift = b - beg as isize;
                        (e - b == (stop - beg) as isize && b >= start && e <= end).then(|| Selective::Property {
                            name,
                            old: old.into_iter().map(|(r, v)| ((r.start as isize + shift) as usize..(r.end as isize + shift) as usize, v)).collect(),
                        })
                    }
                };
                match kept {
                    Some(element) => step.push(element),
                    None if len != 0 => deltas.push((at, len)),
                    None => {}
                }
            }
            // A save is kept only while nothing has been left out.
            if let Some(save) = group.unmodified_at
                && deltas.is_empty()
            {
                step.push(Selective::Unmodified(save));
            }
            if !step.is_empty() {
                steps.push(std::mem::take(&mut step));
            }
        }
        steps.reverse();
        self.selective_undo = Some(steps);
    }

    /// Whether a run of undos in a region is going on, so that an undo
    /// straight after one carries on with it.
    pub fn undoing_in_region(&self) -> bool {
        self.selective_undo.is_some()
    }

    /// Whether there are edits since the last undo boundary, as when Emacs's
    /// `buffer-undo-list` does not start with nil.
    pub fn has_open_undo_group(&self) -> bool {
        !self.open_group.is_empty()
    }

    /// Whether a run of undos in a region has steps left to undo.
    pub fn can_undo_in_region(&self) -> bool {
        self.selective_undo.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// Whether an undo now carries on the run of undos before it, as
    /// Emacs's undo decides: the last change was an undo, or the history
    /// ran out.
    pub fn undo_continues(&self) -> bool {
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        self.open_group.is_empty() && (top_is_undo || self.selective_undo.as_ref().is_some_and(|s| s.is_empty()))
    }

    pub fn undo_in_region_message(&self) -> bool {
        self.undo_in_region
    }

    pub fn set_undo_in_region_message(&mut self, on: bool) {
        self.undo_in_region = on;
    }

    /// Ends a run of undos in a region, so the next undo uses the whole history.
    pub fn stop_undo_in_region(&mut self) {
        self.selective_undo = None;
    }

    /// Undoes `count` more steps of the run started by
    /// [`Buffer::start_undo_in_region`], as Emacs's `primitive-undo` does,
    /// stopping quietly when they run out.
    pub fn undo_in_region(&mut self, count: usize) -> Result<()> {
        // As undo-more, running out fails before anything is checked or changed.
        if self.selective_undo.as_ref().is_none_or(|s| s.is_empty()) {
            return Err(Error::new("No further undo information for region"));
        }
        self.check_writable()?;
        self.undo_boundary();
        let steps = self.selective_undo.as_mut().expect("checked above");
        let n = count.min(steps.len());
        let taken: Vec<_> = steps.drain(steps.len() - n..).rev().collect();
        let outside = || Error::new("Changes to be undone are outside visible portion of buffer");
        let mut result = Ok(());
        'steps: for step in taken {
            for element in step {
                match element {
                    Selective::Inserted(beg, end) => {
                        if end > self.len() {
                            result = Err(outside());
                            break 'steps;
                        }
                        self.point = beg;
                        self.apply_delete(beg, end);
                    }
                    Selective::Deleted { pos, text, props, at_end, marks } => {
                        if pos > self.len() {
                            result = Err(outside());
                            break 'steps;
                        }
                        // Marks still where the text goes are put back, but as
                        // primitive-undo checks them, one that has moved
                        // drops those before it.
                        let mut valid = Vec::new();
                        for (which, offset) in marks {
                            let m = self.mark_ref(which);
                            if m == Some(pos) {
                                valid.push((which, offset));
                            } else {
                                valid.clear();
                            }
                        }
                        self.point = pos;
                        self.apply_insert(pos, &text, false);
                        self.properties.restore(pos, &props);
                        if !at_end {
                            self.point = pos;
                        }
                        for (which, offset) in valid {
                            let slot = self.mark_ref_mut(which);
                            if let Some(m) = slot {
                                *m = pos + offset;
                            }
                        }
                    }
                    Selective::Point(p) => self.point = p.min(self.len()),
                    Selective::Property { name, old } => self.restore_property(&name, &old),
                    Selective::Unmodified(save) => {
                        if save == self.save_generation {
                            self.modified = false;
                            // Unmodified, the buffer is as saved, as Emacs's SAVE_MODIFF says.
                            if !self.modified {
                                self.file.saved_tick = self.tick;
                            }
                        }
                    }
                }
            }
        }
        // Undoing these changes is a redo, which has no history of its own to continue.
        self.close_group(GroupKind::RegionUndo);
        self.pending_undo = None;
        result
    }

    /// Undoes the most recent undo, as Emacs's `undo-redo` does. The undo and
    /// its reversal both leave the history, so the change is simply back.
    pub fn undo_redo(&mut self) -> Result<()> {
        self.undo_boundary();
        let index = match self.undo_groups.last() {
            Some(Group { kind: GroupKind::Undo { .. } | GroupKind::RegionUndo, .. }) => self.undo_groups.len() - 1,
            _ => return Err(Error::new("No undone changes to redo")),
        };
        self.check_writable()?;
        self.revert(index)?;
        self.open_group.clear();
        self.undo_groups.truncate(index);
        // A following undo continues from where the undo below this one stopped.
        self.pending_undo = match self.undo_groups.last() {
            Some(Group { kind: GroupKind::Undo { undid }, .. }) => undid.checked_sub(1),
            _ => None,
        };
        Ok(())
    }

    /// Where the changes the next [`Buffer::undo`] or, with `redo`,
    /// [`Buffer::undo_redo`] takes back start, for the hooks the editor runs
    /// before it. Closes the open undo group, as both do first.
    pub(crate) fn next_undo_start(&mut self, continuing: bool, redo: bool) -> Option<usize> {
        self.undo_boundary();
        let index = if redo {
            matches!(self.undo_groups.last(), Some(Group { kind: GroupKind::Undo { .. } | GroupKind::RegionUndo, .. }))
                .then(|| self.undo_groups.len() - 1)?
        } else {
            let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
            if continuing && top_is_undo { self.pending_undo? } else { self.undo_groups.len().checked_sub(1)? }
        };
        self.undo_groups.get(index)?.edits.iter().map(|e| e.pos).min()
    }

    /// Whether [`Buffer::undo`] would find something to undo.
    pub fn can_undo(&self, continuing: bool) -> bool {
        let top_is_undo = matches!(self.undo_groups.last(), Some(g) if g.kind != GroupKind::Change);
        if continuing && top_is_undo {
            self.pending_undo.is_some()
        } else {
            !self.undo_groups.is_empty() || !self.open_group.is_empty()
        }
    }

    /// Applies the inverse of the group at `index`, recording the edits in
    /// the open group.
    /// Whether a group's edits fit the buffer as it is, taken back in turn,
    /// as one set from code (`buffer-undo-list`) may no longer: undoing it
    /// would otherwise take out text that is not there.
    pub(super) fn group_fits(&self, index: usize) -> bool {
        let mut len = self.len();
        for edit in self.undo_groups[index].edits.iter().rev() {
            if !matches!(edit.extra, Extra::None) {
                continue;
            }
            let inserted = edit.inserted.chars().count();
            if edit.pos + inserted > len {
                return false;
            }
            len = len - inserted + edit.deleted.chars().count();
        }
        true
    }

    pub(super) fn revert(&mut self, index: usize) -> Result<()> {
        if !self.group_fits(index) {
            return Err(Error::new("Changes to be undone are outside visible portion of buffer"));
        }
        let group = self.undo_groups[index].clone();
        for edit in group.edits.iter().rev() {
            if self.revert_extra(edit) {
                continue;
            }
            let inserted = edit.inserted.chars().count();
            if inserted > 0 {
                // Point goes to the start of the text first, as in Emacs, so
                // that undoing this undo leaves point there and not where it is now.
                self.point = edit.pos;
                self.apply_delete(edit.pos, edit.pos + inserted);
            }
            // Marks that were inside the text, and are still where it goes
            // back, go back into it: those there before it goes in, as an
            // advancing marker moves when it does.
            let back: Vec<(MarkRef, usize)> =
                edit.marks.iter().copied().filter(|&(which, _)| self.mark_ref(which) == Some(edit.pos)).collect();
            self.apply_insert(edit.pos, &edit.deleted, false);
            self.properties.restore(edit.pos, &edit.deleted_props);
            for (which, offset) in back {
                if let Some(m) = self.mark_ref_mut(which) {
                    *m = edit.pos + offset;
                }
            }
            // As primitive-undo leaves it: at the start of an insertion it
            // took out, and after text it put back if point was after it
            // when it was deleted, else before.
            let deleted = edit.deleted.chars().count();
            self.point = if deleted > 0 && edit.point_before == edit.pos + deleted { edit.pos + deleted } else { edit.pos };
        }
        if let Some(p) = group.point {
            self.point = p.min(self.len());
        }
        if group.unmodified_at == Some(self.save_generation) {
            self.modified = false;
            // Unmodified, the buffer is as saved, as Emacs's SAVE_MODIFF says.
            if !self.modified {
                self.file.saved_tick = self.tick;
            }
        }
        Ok(())
    }

    pub(super) fn revert_extra(&mut self, edit: &Edit) -> bool {
        match &edit.extra {
            Extra::None => false,
            Extra::Property { name, old } => {
                self.restore_property(name, old);
                true
            }
            Extra::Apply(args) => {
                self.pending_applies.push(args.clone());
                true
            }
        }
    }

    /// Puts a property's old values back, as primitive-undo does with
    /// put-text-property, recording the change so it can be undone again.
    pub(super) fn restore_property(&mut self, name: &str, old: &[(Range<usize>, Option<Value>)]) {
        for (range, value) in old {
            let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
            if !self.record_property_change(start, end, name, |v| v != value.as_ref()) {
                continue;
            }
            match value {
                Some(v) => self.properties.modify(start, end, |p| {
                    p.insert(name.to_string(), v.clone());
                }),
                None => self.properties.modify(start, end, |p| {
                    p.remove(name);
                }),
            }
        }
    }

    /// Records that a text property is about to change between `start`
    /// and `end`, as Emacs's record_property_change does for put-text-property
    /// and the others: its old value on each stretch where `changes` says
    /// the change makes a difference, so undo can put them back. The buffer
    /// is modified, as in Emacs. Returns whether anything is to change.
    pub fn record_property_change(&mut self, start: usize, end: usize, name: &str, changes: impl Fn(Option<&Value>) -> bool) -> bool {
        let end = end.min(self.len());
        if start >= end {
            return false;
        }
        let mut old: Vec<(Range<usize>, Option<Value>)> = Vec::new();
        let mut push = |range: Range<usize>, value: Option<Value>| {
            if !changes(value.as_ref()) {
                return;
            }
            match old.last_mut() {
                Some((last, v)) if last.end == range.start && *v == value => last.end = range.end,
                _ => old.push((range, value)),
            }
        };
        let mut pos = start;
        for (range, props) in self.properties.save(start, end) {
            let (a, b) = (start + range.start, start + range.end);
            if a > pos {
                push(pos..a, None);
            }
            push(a..b, props.get(name).cloned());
            pos = b;
        }
        if pos < end {
            push(pos..end, None);
        }
        if old.is_empty() {
            return false;
        }
        let first = old[0].0.start;
        self.record(Edit::property(first, name, old));
        // buffer-modified-tick counts it, as Emacs's does.
        self.property_ticks += 1;
        true
    }

    pub(super) fn record(&mut self, edit: Edit) {
        // A change another buffer sharing the text made is recorded there.
        if self.cancelling || self.mirroring {
            return;
        }
        if !self.change_groups.is_empty() {
            self.change_log.push(edit.clone());
        }
        if self.open_group.is_empty() {
            self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
            // As Emacs's record_point: where point was before the command,
            // if the change starts elsewhere. A property change records none.
            let text = matches!(edit.extra, Extra::None);
            self.open_point = (text && self.boundary_point != edit.pos).then_some(self.boundary_point);
        }
        self.changed = true;
        self.edited_since_command = true;
        self.modified = true;
        if self.undo_disabled {
            return;
        }
        // Typing joins onto the insertion before it, as Emacs records it: one
        // insertion for a run of characters, not one per character.
        let index = self.open_group.len().wrapping_sub(1);
        let typed_run = self.typed_run;
        if let Some(last) = self.open_group.last_mut()
            && matches!((&edit.extra, &last.extra), (Extra::None, Extra::None))
            && edit.deleted.is_empty()
            && last.deleted.is_empty()
        {
            // Counted once, then as each piece joins.
            let chars = match typed_run {
                (i, pos, bytes, chars) if (i, pos, bytes) == (index, last.pos, last.inserted.len()) => chars,
                _ => last.inserted.chars().count(),
            };
            if last.pos + chars == edit.pos {
                last.inserted.push_str(&edit.inserted);
                self.typed_run = (index, last.pos, last.inserted.len(), chars + edit.inserted.chars().count());
                return;
            }
        }
        if edit.deleted.is_empty() && matches!(edit.extra, Extra::None) {
            self.typed_run = (index.wrapping_add(1), edit.pos, edit.inserted.len(), edit.inserted.chars().count());
        }
        self.open_group.push(edit);
    }
}
