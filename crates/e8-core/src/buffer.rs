use std::collections::BTreeMap;
use std::ops::Range;
use std::path::PathBuf;

use ropey::Rope;

use crate::error::{Error, Result};
use crate::properties::{Overlay, Props, SavedProps, TextProperties};
use crate::syntax::{SyntaxTree, input_edit, point_at};
use crate::variables::{HookEntry, Value};

mod undo;

/// One change to the text, recorded so it can be undone.
#[derive(Clone, Debug)]
struct Edit {
    pos: usize,
    deleted: String,
    /// The text properties the deleted text had, for undo to restore.
    deleted_props: SavedProps,
    inserted: String,
    point_before: usize,
    /// How far into the deleted text the mark, the mark ring's entries and
    /// other windows' points were, as Emacs's record_marker_adjustments
    /// keeps them, so undoing the deletion puts them back.
    marks: Vec<(MarkRef, usize)>,
    /// What else the change was, when it is not text inserted or deleted.
    extra: Extra,
}

/// A change undo records besides text inserted and deleted.
#[derive(Clone, Debug, Default)]
enum Extra {
    #[default]
    None,
    /// A text property changed, as Emacs's record_property_change records
    /// it: the property's value before, on each stretch it was the same,
    /// none where the text had no such property.
    Property { name: String, old: Vec<(Range<usize>, Option<Value>)> },
    /// `(apply FUN . ARGS)`, a function undo calls, which code put in the
    /// history: its arguments as the list has them, the function first, or
    /// DELTA, BEG and END first when it says what it changes.
    Apply(Vec<Value>),
}

impl Edit {
    fn property(pos: usize, name: &str, old: Vec<(Range<usize>, Option<Value>)>) -> Edit {
        Edit {
            pos,
            deleted: String::new(),
            deleted_props: Vec::new(),
            inserted: String::new(),
            point_before: pos,
            marks: Vec::new(),
            extra: Extra::Property { name: name.to_string(), old },
        }
    }
}

/// A marker that undo puts back into text it reinserts.
#[derive(Clone, Copy, Debug, PartialEq)]
enum MarkRef {
    Mark,
    Ring(usize),
    /// Another window's point, by the window.
    Window(u64),
    /// A marker made by code, by its id.
    Marker(u64),
}

/// The undo state when a change group began.
#[derive(Clone, Debug)]
struct ChangeGroup {
    /// How many undo steps there were, so steps closed since are taken back too.
    undo_groups: usize,
    modified: bool,
    open_group: Vec<Edit>,
    open_point: Option<usize>,
    open_unmodified_at: Option<u64>,
    log_start: usize,
}

/// A position that moves with the text, as Emacs's markers do. Text
/// inserted where it is goes after it, unless it advances, as a marker
/// whose insertion type is t.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marker {
    pub id: u64,
    pub pos: usize,
    pub advances: bool,
}

/// Marker ids, unique among all buffers so a marker can move between them.
static NEXT_MARKER_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq)]
enum GroupKind {
    /// Ordinary editing.
    Change,
    /// The changes an undo made, reverting the group at index `undid`.
    Undo { undid: usize },
    /// The changes an undo in the region made: an undo, but to a state of
    /// the buffer that may not have been before, as Emacs's undo-equiv-table
    /// marks it `undo-in-region`.
    RegionUndo,
}

/// One undo step as [`Buffer::undo_history`] tells it, for code that
/// follows the history as a tree, as vundo does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UndoStep {
    /// For an undo, the step it took back: the buffer is then as it was
    /// before that step.
    pub undid: Option<usize>,
    /// Whether the step was an undo, in the region too.
    pub undo: bool,
    /// If the buffer was unmodified when the step began, which save that
    /// was, counting up: the state before the step was saved.
    pub saved: Option<u64>,
}

/// One undo step: the edits of one command.
#[derive(Clone, Debug)]
struct Group {
    edits: Vec<Edit>,
    kind: GroupKind,
    /// If the buffer was unmodified when the group began, which save it
    /// matched. Reverting the group returns to that state, so if it is still
    /// the latest save the buffer is unmodified again. Emacs records the
    /// file's modification time for the same purpose.
    unmodified_at: Option<u64>,
    /// Where point was before the command, if its first change was
    /// elsewhere, as Emacs's record_point keeps it: undoing returns there.
    point: Option<usize>,
}

/// One element of an undo list made for undoing in a region, as Emacs's
/// `undo-make-selective-list` makes it: positions adjusted for the changes
/// left out, newest first within a step.
#[derive(Clone, Debug)]
enum Selective {
    /// Text inserted between two positions, which undoing deletes.
    Inserted(usize, usize),
    /// Text deleted at a position, which undoing puts back; `at_end` if point
    /// was after it, as a negative position in Emacs's list says.
    Deleted { pos: usize, text: String, props: SavedProps, at_end: bool, marks: Vec<(MarkRef, usize)> },
    /// Where point was before the command.
    Point(usize),
    /// The buffer was unmodified, as of this save.
    Unmodified(u64),
    /// A text property's old values, which undoing puts back.
    Property { name: String, old: Vec<(Range<usize>, Option<Value>)> },
}

/// How many positions the mark ring keeps, as Emacs's `mark-ring-max`.
const MARK_RING_MAX: usize = 16;

/// Set in a window's id where the buffer keeps the window's start rather than its point.
const WINDOW_START: u64 = 1 << 62;

/// Set in a window's id where the buffer keeps where the window started and
/// its point when it last showed the buffer, its entry in the window's
/// previous buffers, which are markers in Emacs.
const PREV_START: u64 = 1 << 61;
const PREV_POINT: u64 = 1 << 60;

/// Text plus the state that goes with it: point, mark, the visited file and
/// undo history. All positions are character indices.
pub struct Buffer {
    /// Unique among buffers, so windows can refer to a buffer that is renamed.
    pub(crate) id: u64,
    pub name: String,
    pub path: Option<PathBuf>,
    pub read_only: bool,
    /// First line shown in the selected window, when it shows this buffer.
    /// Other windows keep their own. It moves with edits above it, as the
    /// selected window's start is a marker in Emacs.
    pub top_line: usize,
    /// Where the last window to stop showing the buffer started, where the
    /// next window to show it starts, as Emacs's `last_window_start`; a
    /// plain position there too, which edits do not move.
    pub(crate) last_window_start: usize,
    /// The points of windows showing the buffer, other than the selected
    /// one, under their ids, and their starts under their ids with
    /// [`WINDOW_START`] set, which move with edits as Emacs's window-point
    /// and window-start markers do; and the windows' entries for the buffer
    /// in their previous buffers, with [`PREV_START`] and [`PREV_POINT`].
    window_points: Vec<(u64, usize)>,
    text: Rope,
    /// Whether text that may need reordering for display, right-to-left
    /// letters, Arabic digits or directional controls, was ever put in the
    /// buffer since its text was last set, so redisplay can skip bidi for
    /// buffers without any ([ADR 0047](../../../docs/adr/0047-bidirectional-text.md)).
    pub(crate) has_rtl: bool,
    point: usize,
    mark: Option<usize>,
    /// Earlier marks, most recent first, as Emacs's `mark-ring`.
    mark_ring: Vec<usize>,
    /// Whether the region between mark and point is active and shown, as in
    /// Emacs's transient-mark-mode.
    mark_active: bool,
    /// Whether Shift with a movement key activated the region. Such a region
    /// ends when point moves without Shift.
    shift_selected: bool,
    /// Whether the text changed since [`Buffer::take_changed`] was last called.
    changed: bool,
    modified: bool,
    /// Counts saves, so undo can tell whether it returned to the saved text.
    save_generation: u64,
    undo_groups: Vec<Group>,
    open_group: Vec<Edit>,
    /// How many characters the open group's last insertion is, by its
    /// index, position and length in bytes, so typing that joins onto it
    /// does not count them all again: `(index, pos, bytes, chars)`.
    typed_run: (usize, usize, usize, usize),
    open_unmodified_at: Option<u64>,
    /// Whether edits go unrecorded, as when Emacs's `buffer-undo-list` is t.
    undo_disabled: bool,
    /// Change groups being made, innermost last, as Emacs's
    /// prepare-change-group: the undo state when each began, and where
    /// its changes start in `change_log`.
    change_groups: Vec<ChangeGroup>,
    /// Every change while a change group is open, to take back if it is cancelled.
    change_log: Vec<Edit>,
    /// Whether changes are being taken back, so not recorded for undo.
    cancelling: bool,
    /// The `(apply ...)` entries an undo came to, for the editor to call
    /// once it is done, as primitive-undo calls them.
    pub(crate) pending_applies: Vec<Vec<Value>>,
    /// The history while `buffer-undo-list` is t, so setting it back to
    /// the list it was, as a `let` does, puts the history back exactly.
    stashed_undo: Option<Box<UndoState>>,
    /// Point at the last undo boundary, before the command now running.
    boundary_point: usize,
    /// The accessible portion when the buffer is narrowed, as Emacs's BEGV
    /// and ZV: commands, display and search keep inside it.
    restriction: Option<(usize, usize)>,
    /// Whether the text changed since the last command began, as Emacs's
    /// `undo-auto--undoably-changed-buffers` tracks for its boundaries.
    edited_since_command: bool,
    /// The point the open group returns to when undone, if any.
    open_point: Option<usize>,
    /// Where a run of consecutive undos continues: the group to undo next,
    /// or `None` once the history is used up.
    pending_undo: Option<usize>,
    /// Whether the next undo passes over an undo and the change it undid,
    /// as Emacs's `undo-no-redo` makes `undo-only` do.
    pub(crate) undo_no_redo: bool,
    /// The steps left to undo in a region, newest first, while a run of
    /// undos in a region goes on: Emacs's `pending-undo-list` when
    /// `undo-in-region` is set.
    selective_undo: Option<Vec<Vec<Selective>>>,
    /// Whether the run of undos going on started in a region, as Emacs's
    /// `undo-in-region`, which its messages report.
    undo_in_region: bool,
    /// The buffer's own values of variables, as Emacs's buffer-local variables.
    pub(crate) locals: BTreeMap<String, Value>,
    pub(crate) local_hooks: BTreeMap<String, Vec<HookEntry>>,
    /// How far `syntax-propertize-function` has run, as syntax-propertize--done.
    pub(crate) syntax_propertized: usize,
    /// The major mode's keymap.
    /// The local keymap and any composed over it, first looked up first.
    pub(crate) local_map: Vec<crate::keymap::KeymapId>,
    properties: TextProperties,
    overlays: crate::properties::OverlayList,
    markers: Vec<Marker>,
    /// The name of the syntax table the buffer uses, as its major mode sets it.
    pub syntax_table: String,
    /// Its case table and category table, if it has its own rather than
    /// the standard ones, as Emacs's buffers each have theirs.
    pub(crate) case_table: Option<crate::chartab::CharTableId>,
    pub(crate) category_table: Option<crate::chartab::CharTableId>,
    /// Parse states from the start of the buffer at points along it, as
    /// syntax-ppss keeps them, for the syntax table named first. Changes
    /// drop those after them.
    pub(crate) ppss_cache: std::cell::RefCell<Vec<(usize, crate::syntax_table::ParseState)>>,
    pub(crate) ppss_table: std::cell::RefCell<String>,
    /// The tree-sitter tree, if a major mode gave the buffer a language.
    /// Its tree-sitter parsers, newest first, as Emacs's `treesit-parser-list`.
    pub(crate) parsers: Vec<SyntaxTree>,
    /// The stretches already fontified by `jit-lock-functions`, in order.
    pub(crate) fontified: Vec<Range<usize>>,
    /// Counts changes to the text, as Emacs's `buffer-modified-tick`.
    tick: u64,
    /// Changes not yet passed to `after-change-functions`: where the new
    /// text starts and ends, and how long the old text was.
    pub(crate) pending_changes: Vec<(usize, usize, usize)>,
    /// The visited file's state: modification time, backup and auto-save.
    pub(crate) file: crate::fileio::FileState,
    /// The buffer whose text this one shares, if it is an indirect buffer.
    pub(crate) base: Option<u64>,
    /// While the buffer shares its text, as a base or an indirect buffer:
    /// what changed since the editor last passed it on to the others.
    pub(crate) shared: Option<Shared>,
    /// Whether changes from another buffer sharing the text are being made,
    /// which are not recorded again.
    pub(crate) mirroring: bool,
}

/// A buffer's undo history, moving between the buffers sharing its text.
/// A buffer's undo history while `buffer-undo-list` is bound: the history
/// and what it kept aside while undo was off.
pub(crate) struct UndoBinding {
    state: Box<UndoState>,
    stash: Option<Box<UndoState>>,
}

impl std::fmt::Debug for UndoBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "UndoBinding({} steps)", self.state.groups.len())
    }
}

pub(crate) struct UndoState {
    groups: Vec<Group>,
    open: Vec<Edit>,
    open_unmodified_at: Option<u64>,
    open_point: Option<usize>,
    disabled: bool,
    save_generation: u64,
    pending: Option<usize>,
    selective: Option<Vec<Vec<Selective>>>,
    in_region: bool,
    edited: bool,
}

/// What [`Buffer::begin_silent`] changed, for [`Buffer::end_silent`] to put back.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Silenced {
    pub(crate) modified: bool,
    pub(crate) recording: bool,
    pub(crate) changed: bool,
}

/// What a buffer sharing its text has changed since the editor last made
/// the same changes in the others, as Emacs's indirect buffers share one
/// buffer_text.
#[derive(Debug, Default)]
pub(crate) struct Shared {
    pub(crate) changes: Vec<TextChange>,
    /// The text properties' generation when last shared.
    pub(crate) props: u64,
    /// The modified flag when last shared.
    pub(crate) modified: bool,
    /// Whether this buffer holds the undo history its family shares.
    pub(crate) holds_undo: bool,
}

/// A change to text a buffer shares, to make in the others.
#[derive(Clone, Debug)]
pub(crate) enum TextChange {
    Insert(usize, String),
    Delete(usize, usize),
    /// All of it replaced, as `set_text` does.
    Reset,
}

impl Buffer {
    pub fn new(name: impl Into<String>) -> Buffer {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Buffer {
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            name: name.into(),
            path: None,
            read_only: false,
            top_line: 0,
            last_window_start: 0,
            window_points: Vec::new(),
            text: Rope::new(),
            has_rtl: false,
            point: 0,
            mark: None,
            mark_ring: Vec::new(),
            mark_active: false,
            shift_selected: false,
            changed: false,
            modified: false,
            save_generation: 0,
            undo_groups: Vec::new(),
            open_group: Vec::new(),
            typed_run: Default::default(),
            undo_disabled: false,
            open_unmodified_at: None,
            change_groups: Vec::new(),
            change_log: Vec::new(),
            cancelling: false,
            pending_applies: Vec::new(),
            stashed_undo: None,
            boundary_point: 0,
            edited_since_command: false,
            restriction: None,
            open_point: None,
            pending_undo: None,
            undo_no_redo: false,
            selective_undo: None,
            undo_in_region: false,
            locals: BTreeMap::new(),
            local_hooks: BTreeMap::new(),
            syntax_propertized: 0,
            local_map: Vec::new(),
            properties: TextProperties::default(),
            overlays: Default::default(),
            markers: Vec::new(),
            syntax_table: crate::syntax_table::STANDARD.to_string(),
            case_table: None,
            category_table: None,
            ppss_cache: Default::default(),
            ppss_table: Default::default(),
            parsers: Vec::new(),
            fontified: Vec::new(),
            tick: 0,
            pending_changes: Vec::new(),
            file: Default::default(),
            base: None,
            shared: None,
            mirroring: false,
        }
    }

    /// Makes a region Shift started an ordinary one, as changing the major
    /// mode does in Emacs by killing the buffer-local transient-mark-mode
    /// that shift selection sets.
    pub(crate) fn forget_shift_selection(&mut self) {
        self.shift_selected = false;
    }

    /// A buffer sharing this one's text, as Emacs's `make-indirect-buffer`
    /// makes one: with its point and narrowing, and, with `clone`, its
    /// local variables and hooks, keymaps, tables, mark and overlays too.
    /// This buffer is the base, and holds the undo history they share.
    pub(crate) fn indirect(&mut self, name: &str, clone: bool) -> Buffer {
        let (generation, modified) = (self.properties.generation, self.modified);
        self.shared.get_or_insert_with(|| Shared { changes: Vec::new(), props: generation, modified, holds_undo: true });
        let mut b = Buffer::new(name);
        b.text = self.text.clone();
        b.properties = self.properties.clone();
        b.point = self.point;
        b.restriction = self.restriction;
        b.modified = modified;
        b.tick = self.tick;
        b.base = Some(self.id);
        b.shared = Some(Shared { changes: Vec::new(), props: generation, modified, holds_undo: false });
        if clone {
            b.locals = self.locals.clone();
            b.local_hooks = self.local_hooks.clone();
            b.local_map = self.local_map.clone();
            b.syntax_table = self.syntax_table.clone();
            b.case_table = self.case_table;
            b.category_table = self.category_table;
            b.read_only = self.read_only;
            b.mark = self.mark;
            // Copies of the overlays, numbered afresh, as clone-indirect-buffer copies them.
            for o in self.overlays.iter() {
                let mut copy = o.clone();
                copy.id = next_overlay_id();
                b.overlays.push(copy);
            }
            b.overlays.hooks = self.overlays.hooks;
        }
        b
    }

    /// The parser that highlights the buffer, which its major mode made.
    pub(crate) fn primary_syntax(&self) -> Option<&SyntaxTree> {
        self.parsers.iter().find(|p| p.primary)
    }

    /// Counts changes to the text properties.
    pub(crate) fn properties_generation(&self) -> u64 {
        self.properties.generation
    }

    /// The id of the buffer whose text this one shares, as Emacs's
    /// `buffer-base-buffer`, if it is an indirect buffer.
    pub fn base_buffer(&self) -> Option<u64> {
        self.base
    }

    /// Notes a change to the text for the buffers sharing it, if any do.
    fn share(&mut self, change: impl FnOnce() -> TextChange) {
        if let Some(shared) = &mut self.shared
            && !self.mirroring
        {
            shared.changes.push(change());
        }
    }

    /// Makes a change another buffer sharing the text made, as if made here
    /// too: markers, point and overlays move as they would, but it is not
    /// recorded for undo, which that buffer did, nor announced to change hooks.
    pub(crate) fn mirror(&mut self, change: &TextChange, from: &Buffer) {
        let pending = self.pending_changes.len();
        self.mirroring = true;
        match change {
            TextChange::Insert(pos, s) => self.apply_insert(*pos, s, false),
            TextChange::Delete(start, end) => {
                self.apply_delete(*start, *end);
            }
            TextChange::Reset => {
                let (point, restriction) = (self.point, self.restriction);
                self.text = from.text.clone();
                self.has_rtl = from.has_rtl;
                for parser in &self.parsers {
                    parser.reset();
                }
                self.fontified.clear();
                self.tick += 1;
                self.point = point.min(self.len());
                self.restriction = restriction.filter(|&(_, end)| end <= self.len());
            }
        }
        self.mirroring = false;
        self.pending_changes.truncate(pending);
    }

    /// Takes the text properties of another buffer sharing the text, as
    /// they are one in Emacs.
    pub(crate) fn mirror_properties(&mut self, from: &Buffer) {
        self.properties = from.properties.clone();
        self.ppss_cache.get_mut().clear();
    }

    /// Stops recording changes for undo and keeps whether the buffer was
    /// modified, for [`Buffer::end_silent`] to put back, as Emacs's
    /// with-silent-modifications binds `buffer-undo-list` to t around
    /// changes to text properties that are not edits, such as fontifying.
    pub(crate) fn begin_silent(&mut self) -> Silenced {
        let silenced = Silenced { modified: self.modified, recording: !self.undo_disabled, changed: self.changed };
        if silenced.recording {
            self.set_undo_list(&Value::Bool(true));
        }
        silenced
    }

    pub(crate) fn end_silent(&mut self, silenced: Silenced) {
        if silenced.recording && self.undo_disabled {
            match self.stashed_undo.take() {
                Some(stash) => {
                    let mut state = *stash;
                    state.disabled = false;
                    state.save_generation = self.save_generation;
                    self.put_undo(state);
                }
                None => self.undo_disabled = false,
            }
        }
        self.modified = silenced.modified;
        // Nor do they deactivate the region, as fontifying in redisplay does not.
        self.changed = silenced.changed;
    }

    pub(crate) fn mark_saved(&mut self) {
        self.undo_boundary();
        self.save_generation += 1;
        self.modified = false;
        // Saved or reverted, the buffer gives up its file's lock, as unlock_file.
        if std::mem::take(&mut self.file.locked)
            && let Some(path) = &self.path
        {
            crate::filelock::unlock(path);
        }
    }

    pub fn text(&self) -> &Rope {
        &self.text
    }

    pub fn len(&self) -> usize {
        self.text.len_chars()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the text changed since it was visited or last saved.
    pub fn is_modified(&self) -> bool {
        self.modified
    }

    /// Marks the buffer modified or not, as Emacs's `set-buffer-modified-p`.
    /// The file is as it was, so undoing back to a change made to the
    /// unmodified buffer, before or after this, leaves it unmodified, as
    /// primitive-undo compares the visited file's time.
    pub fn set_modified(&mut self, modified: bool) {
        self.modified = modified;
    }

    pub fn point(&self) -> usize {
        self.point
    }

    /// Moves point, kept inside the accessible portion as Emacs's `goto-char` keeps it.
    pub fn set_point(&mut self, pos: usize) {
        self.point = pos.clamp(self.point_min(), self.point_max());
    }

    /// Where the accessible portion starts: 0 unless the buffer is narrowed,
    /// as Emacs's `point-min`.
    pub fn point_min(&self) -> usize {
        self.restriction.map_or(0, |(start, _)| start)
    }

    /// Where the accessible portion ends: the buffer's end unless it is
    /// narrowed, as Emacs's `point-max`.
    pub fn point_max(&self) -> usize {
        self.restriction.map_or(self.len(), |(_, end)| end.min(self.len()))
    }

    pub fn is_narrowed(&self) -> bool {
        self.restriction.is_some()
    }

    /// Restricts editing and display to a range, as Emacs's
    /// `narrow-to-region`; point moves inside it.
    pub fn narrow(&mut self, start: usize, end: usize) {
        let (start, end) = (start.min(end).min(self.len()), start.max(end).min(self.len()));
        self.restriction = (start != 0 || end != self.len()).then_some((start, end));
        self.point = self.point.clamp(start, end);
    }

    /// Makes the whole buffer accessible again, as Emacs's `widen`.
    pub fn widen(&mut self) {
        self.restriction = None;
    }

    pub fn mark(&self) -> Option<usize> {
        self.mark
    }

    pub fn set_mark(&mut self, pos: Option<usize>) {
        self.mark = pos.map(|p| p.min(self.len()));
    }

    /// Sets the mark at `pos`, first saving the old mark on the mark ring, as
    /// Emacs's `push-mark` does. With `activate`, the region becomes active.
    pub fn push_mark(&mut self, pos: usize, activate: bool) {
        if let Some(old) = self.mark {
            self.mark_ring.insert(0, old);
            self.mark_ring.truncate(MARK_RING_MAX);
        }
        self.mark = Some(pos.min(self.len()));
        // Activating leaves a region Shift started temporary, as Emacs's
        // activate-mark leaves transient-mark-mode's `only' state alone.
        if activate {
            self.mark_active = true;
        }
    }

    /// Replaces the mark with the most recent entry of the mark ring, which
    /// moves the current mark to the end of the ring, and deactivates the
    /// region, as Emacs's `pop-mark` does.
    pub fn pop_mark(&mut self) {
        if !self.mark_ring.is_empty() {
            if let Some(mark) = self.mark {
                self.mark_ring.push(mark);
            }
            self.mark = Some(self.mark_ring.remove(0));
        }
        self.deactivate_mark();
    }

    /// Earlier marks, most recent first.
    pub fn mark_ring(&self) -> &[usize] {
        &self.mark_ring
    }

    /// Activates the region between the mark and point, if there is a mark.
    /// A region Shift made stays temporary, as Emacs's activate-mark
    /// leaves transient-mark-mode's `only' state alone.
    pub fn activate_region(&mut self) {
        self.mark_active = self.mark.is_some();
    }

    /// Hides the region. The mark stays where it is.
    pub fn deactivate_mark(&mut self) {
        self.mark_active = false;
        self.shift_selected = false;
    }

    pub fn is_mark_active(&self) -> bool {
        self.mark_active && self.mark.is_some()
    }

    pub fn is_shift_selected(&self) -> bool {
        self.is_mark_active() && self.shift_selected
    }

    /// Starts a region at point that Shift selection owns.
    pub fn start_shift_selection(&mut self) {
        self.push_mark(self.point, true);
        self.shift_selected = true;
    }

    /// The region if it is active: what the front ends highlight.
    pub fn active_region(&self) -> Option<Range<usize>> {
        self.region().filter(|_| self.mark_active)
    }

    /// Whether the text changed since the last call. The editor uses this to
    /// deactivate the region after a command edits the buffer.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Restores the flag [`Buffer::take_changed`] reads, so code can make
    /// edits that leave the region active, as binding Emacs's
    /// `deactivate-mark` to nil does.
    pub fn set_changed(&mut self, changed: bool) {
        self.changed = changed;
    }

    /// The text between mark and point, if the mark is set.
    pub fn region(&self) -> Option<Range<usize>> {
        self.mark
            .map(|m| m.min(self.point)..m.max(self.point))
    }

    pub fn char_at(&self, pos: usize) -> Option<char> {
        (pos < self.len()).then(|| self.text.char(pos))
    }

    /// The characters from `start` to `end`, for code that reads many in turn.
    pub(crate) fn chars_between(&self, start: usize, end: usize) -> Vec<char> {
        self.text.slice(start..end).chars().collect()
    }

    pub fn slice(&self, range: Range<usize>) -> String {
        self.text.slice(range).to_string()
    }

    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    pub fn line_of(&self, pos: usize) -> usize {
        self.text.char_to_line(pos)
    }

    pub fn line_start(&self, line: usize) -> usize {
        self.text.line_to_char(line)
    }

    /// The position of the end of a line, before its newline.
    pub fn line_end(&self, line: usize) -> usize {
        if line + 1 < self.line_count() {
            self.text.line_to_char(line + 1) - 1
        } else {
            self.len()
        }
    }

    /// A line's text without its newline.
    pub fn line_text(&self, line: usize) -> String {
        self.slice(self.line_start(line)..self.line_end(line))
    }

    /// The column of a position: characters since the start of its line.
    pub fn column(&self, pos: usize) -> usize {
        pos - self.line_start(self.line_of(pos))
    }

    /// How many times the text has changed, as Emacs's `buffer-modified-tick`.
    pub fn modified_tick(&self) -> u64 {
        self.tick
    }

    /// Inserts text at point, leaving point after it.
    pub(crate) fn insert(&mut self, s: &str) -> Result<()> {
        self.insert_at(self.point, s)
    }

    /// Inserts text at a position as insert-before-markers does there, the
    /// narrowing aside: markers, point and the mark at it move past the text.
    pub(crate) fn insert_before_markers_at(&mut self, pos: usize, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s, true);
        Ok(())
    }

    pub(crate) fn insert_at(&mut self, pos: usize, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(pos.min(self.len()), s, false);
        Ok(())
    }

    /// Inserts text at point as Emacs's `insert-before-markers` does: the
    /// mark and overlay ends at point move past it too.
    pub(crate) fn insert_before_markers(&mut self, s: &str) -> Result<()> {
        if s.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        self.apply_insert(self.point, s, true);
        Ok(())
    }

    /// Deletes a range and returns the deleted text.
    pub(crate) fn delete(&mut self, range: Range<usize>) -> Result<String> {
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        // Deleting nothing changes nothing, so it is allowed anywhere, as in Emacs.
        if start >= end {
            return Ok(String::new());
        }
        self.check_writable()?;
        Ok(self.apply_delete(start, end))
    }

    /// Replaces each `from` between `start` and `end` with `to` in place, as
    /// Emacs's `subst-char-in-region`: point, markers and overlays stay
    /// where they are, and the characters keep their properties. Undoing it
    /// in a buffer that was unmodified leaves point at the change.
    pub(crate) fn subst_char(&mut self, start: usize, end: usize, from: char, to: char) -> Result<()> {
        let end = end.min(self.len());
        let positions: Vec<usize> = (start..end).filter(|&p| self.char_at(p) == Some(from)).collect();
        if positions.is_empty() {
            return Ok(());
        }
        self.check_writable()?;
        for p in positions {
            let props = self.properties.save(p, p + 1);
            let edit_start = (!self.parsers.is_empty()).then(|| (point_at(&self.text, p), point_at(&self.text, p + 1)));
            self.text.remove(p..p + 1);
            self.text.insert(p, to.encode_utf8(&mut [0; 4]));
            self.has_rtl |= crate::bidi::reorders(to);
            self.share(|| TextChange::Delete(p, p + 1));
            self.share(|| TextChange::Insert(p, to.to_string()));
            if let Some((s, old_end)) = edit_start {
                let edit = input_edit(s, old_end, point_at(&self.text, p + 1));
                self.parsers.iter().for_each(|parser| parser.edit(&edit));
            }
            self.unfontify_from(p);
            self.tick += 1;
            self.pending_changes.push((p, p + 1, 1));
            if self.open_group.is_empty() {
                self.open_unmodified_at = (!self.modified).then_some(self.save_generation);
                // Emacs's modify_text records the buffer's first change
                // before record_point looks for a boundary, so point is
                // recorded only in a buffer already modified.
                self.open_point = (self.modified && self.boundary_point != p).then_some(self.boundary_point);
            }
            self.changed = true;
            self.edited_since_command = true;
            self.modified = true;
            let edit = Edit {
                pos: p,
                deleted: from.to_string(),
                deleted_props: props,
                inserted: to.to_string(),
                point_before: self.point,
                marks: Vec::new(),
                extra: Extra::None,
            };
            if !self.change_groups.is_empty() {
                self.change_log.push(edit.clone());
            }
            if !self.undo_disabled {
                self.open_group.push(edit);
            }
        }
        Ok(())
    }

    /// Changes the character at `pos` into `text`, as casing does: one
    /// character in place, as `subst_char`; several in its place, each with
    /// its text properties, point and markers after it moving past them.
    pub(crate) fn replace_char(&mut self, pos: usize, text: &str) -> Result<()> {
        let Some(old) = self.char_at(pos) else { return Ok(()) };
        let mut chars = text.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            return self.subst_char(pos, pos + 1, old, c);
        }
        self.check_writable()?;
        let props = self.properties.save(pos, pos + 1);
        let point = self.point;
        let n = text.chars().count();
        self.apply_insert(pos, text, false);
        self.apply_delete(pos + n, pos + n + 1);
        for (_, props) in props {
            self.properties.modify(pos, pos + n, |p| p.extend(props.clone()));
        }
        self.point = if point <= pos { point } else { point + n - 1 };
        Ok(())
    }

    /// Cases the text from `start` to `end`, each `(position, text)`
    /// replacing the character there, as Emacs's casify_region does: undo
    /// sees one replacement of the whole stretch, and markers keep their
    /// positions, as replace_range_2 leaves them, though point stays with
    /// the text.
    pub(crate) fn case_region(&mut self, start: usize, end: usize, changes: &[(usize, String)]) -> Result<()> {
        self.check_writable()?;
        let (old, old_props, point) = (self.slice(start..end), self.properties.save(start, end), self.point);
        let (open, log) = (self.open_group.len(), self.change_log.len());
        // A trial edit can join onto the edit before it, as typing does,
        // which truncating the group would not take back: it is put back.
        let last = self.open_group.last().cloned();
        let unmodified = (!self.modified).then_some(self.save_generation);
        let (mark, ring, window_points) = (self.mark, self.mark_ring.clone(), self.window_points.clone());
        let markers: Vec<usize> = self.markers.iter().map(|m| m.pos).collect();
        let mut added = 0isize;
        for (p, text) in changes.iter().rev() {
            self.replace_char(*p, text)?;
            added += text.chars().count() as isize - 1;
        }
        if added != 0 {
            let len = self.len();
            (self.mark, self.mark_ring, self.window_points) = (mark.map(|m| m.min(len)), ring, window_points);
            for (_, p) in &mut self.window_points {
                *p = (*p).min(len);
            }
            for (m, pos) in self.markers.iter_mut().zip(markers) {
                m.pos = pos.min(len);
            }
        }
        self.open_group.truncate(open);
        if let (Some(last), Some(slot)) = (last, self.open_group.last_mut()) {
            *slot = last;
        }
        self.change_log.truncate(log);
        let new_end = (end as isize + added) as usize;
        let inserted = self.slice(start..new_end);
        self.record(Edit { pos: start, deleted: old, deleted_props: old_props, inserted, point_before: point, marks: Vec::new(), extra: Extra::None });
        // Undoing it all leaves the buffer unmodified if it was before.
        if open == 0 {
            self.open_unmodified_at = unmodified;
        }
        Ok(())
    }

    /// Inserts text, moving point, the mark and the mark ring as Emacs moves
    /// its markers: point and positions after `pos` move with the text.
    fn apply_insert(&mut self, pos: usize, s: &str, before_markers: bool) {
        if s.is_empty() {
            return;
        }
        let point_before = self.point;
        let start = (!self.parsers.is_empty()).then(|| point_at(&self.text, pos));
        // Lines added above the selected window's start push it down, as
        // text inserted before a marker does.
        if self.top_line > 0 && self.top_line < self.line_count() && pos < self.line_start(self.top_line) {
            self.top_line += s.matches('\n').count();
        }
        self.text.insert(pos, s);
        self.has_rtl |= crate::bidi::needs_reordering(s);
        self.share(|| TextChange::Insert(pos, s.to_string()));
        let n = s.chars().count();
        if let Some(start) = start {
            let edit = input_edit(start, start, point_at(&self.text, pos + n));
            self.parsers.iter().for_each(|parser| parser.edit(&edit));
        }
        if self.point >= pos {
            self.point += n;
        }
        let window_points = self.window_points.iter_mut().map(|(_, p)| p);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()).chain(window_points) {
            if *m > pos || (*m == pos && before_markers) {
                *m += n;
            }
        }
        for m in &mut self.markers {
            if m.pos > pos || (m.pos == pos && (before_markers || m.advances)) {
                m.pos += n;
            }
        }
        self.properties.insert(pos, n);
        for overlay in self.overlays.iter_mut() {
            overlay.insert(pos, n, before_markers);
        }
        self.unfontify_from(pos);
        self.tick += 1;
        self.pending_changes.push((pos, pos + n, 0));
        // Text inserted in the accessible portion widens it; at its start,
        // it goes inside, as the start is no marker in Emacs either.
        if let Some((start, end)) = &mut self.restriction {
            if pos < *start {
                *start += n;
            }
            if pos <= *end {
                *end += n;
            }
        }
        self.record(Edit {
            pos,
            deleted: String::new(),
            deleted_props: Vec::new(),
            inserted: s.to_string(),
            point_before,
            marks: Vec::new(),
            extra: Extra::None,
        });
    }

    fn apply_delete(&mut self, start: usize, end: usize) -> String {
        if start >= end {
            return String::new();
        }
        let deleted = self.slice(start..end);
        let point_before = self.point;
        let inside = |m: usize| (start < m && m <= end).then(|| m - start);
        let mut marks: Vec<(MarkRef, usize)> = self.mark.and_then(inside).map(|o| (MarkRef::Mark, o)).into_iter().collect();
        marks.extend(self.mark_ring.iter().enumerate().filter_map(|(i, &m)| inside(m).map(|o| (MarkRef::Ring(i), o))));
        marks.extend(self.window_points.iter().filter_map(|&(w, m)| inside(m).map(|o| (MarkRef::Window(w), o))));
        // An advancing marker at the start goes back there too, as Emacs's
        // record_marker_adjustments records any marker the deletion moves.
        marks.extend(self.markers.iter().filter_map(|m| {
            let at_start = m.advances && m.pos == start && start < end;
            if at_start { Some((MarkRef::Marker(m.id), 0)) } else { inside(m.pos).map(|o| (MarkRef::Marker(m.id), o)) }
        }));
        let edit_range = (!self.parsers.is_empty()).then(|| (point_at(&self.text, start), point_at(&self.text, end)));
        // The selected window's start moves with the text, to the start of
        // the deletion if it was inside it; a window starts at a line's start.
        let top = (self.top_line > 0 && self.top_line < self.line_count()).then(|| self.line_start(self.top_line));
        self.text.remove(start..end);
        self.share(|| TextChange::Delete(start, end));
        if let Some(top) = top {
            if end <= top {
                self.top_line -= deleted.matches('\n').count();
            } else if start < top {
                self.top_line = self.line_of(start);
            }
        }
        if let Some((from, to)) = edit_range {
            let edit = input_edit(from, to, from);
            self.parsers.iter().for_each(|parser| parser.edit(&edit));
        }
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        if let Some((a, b)) = &mut self.restriction {
            (*a, *b) = (shift(*a), shift(*b));
        }
        self.point = shift(self.point);
        let window_points = self.window_points.iter_mut().map(|(_, p)| p);
        for m in self.mark.iter_mut().chain(self.mark_ring.iter_mut()).chain(window_points) {
            *m = shift(*m);
        }
        for m in &mut self.markers {
            m.pos = shift(m.pos);
        }
        let deleted_props = self.properties.delete(start, end);
        for overlay in self.overlays.iter_mut() {
            overlay.delete(start, end);
        }
        self.overlays.retain(|o| !o.evaporates());
        self.unfontify_from(start);
        self.tick += 1;
        self.pending_changes.push((start, start, end - start));
        self.record(Edit {
            pos: start,
            deleted: deleted.clone(),
            deleted_props,
            inserted: String::new(),
            point_before,
            marks,
            extra: Extra::None,
        });
        deleted
    }

    /// Inserts a propertized string at a position, its properties with it,
    /// moving point past it if point was there, as `insert` does at point.
    pub(crate) fn insert_text_at(&mut self, pos: usize, text: &crate::properties::Text, move_point: bool) -> Result<()> {
        // At point, where it is now, as hooks before may have moved it.
        let pos = if move_point { self.point } else { pos };
        if move_point {
            self.insert(&text.string)?;
        } else {
            self.insert_at(pos, &text.string)?;
        }
        self.restore_properties(pos, text);
        Ok(())
    }

    /// Puts a propertized string's properties on text inserted at `pos`,
    /// leaving out runs past the string's end.
    pub(crate) fn restore_properties(&mut self, pos: usize, text: &crate::properties::Text) {
        let n = text.string.chars().count();
        let props: Vec<_> = text.props.iter().filter(|(r, _)| r.start < n).map(|(r, p)| (r.start..r.end.min(n), p.clone())).collect();
        self.properties.restore(pos, &props);
    }

    /// The text of a stretch with its properties, as Emacs's `buffer-substring`.
    pub fn substring(&self, range: Range<usize>) -> crate::properties::Text {
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        let (start, end) = (start.min(end), end);
        crate::properties::Text { string: self.slice(start..end), props: self.properties.save(start, end) }
    }

    /// Inserts text at point that takes on the text properties around it,
    /// as Emacs's `insert-and-inherit` does for typing: those of the
    /// character before, which stick to its end unless its `rear-nonsticky`
    /// names them, and those of the character after that its
    /// `front-sticky` names. Properties in Emacs's default
    /// `text-property-default-nonsticky` are not inherited.
    pub(crate) fn insert_and_inherit(&mut self, s: &str) -> Result<()> {
        const NONSTICKY: [&str; 4] = ["syntax-table", "display", "composition", "cursor"];
        let names = |list: Option<&Value>, name: &str| match list {
            Some(Value::Bool(true)) => true,
            Some(Value::Str(one)) => one == name,
            Some(Value::List(items)) => items.iter().any(|v| matches!(v, Value::Str(x) if x == name)),
            _ => false,
        };
        let pos = self.point;
        let mut inherited: Vec<(String, Value)> = Vec::new();
        if pos > 0
            && let Some(before) = self.text_properties_at(pos - 1)
        {
            let nonsticky = before.get("rear-nonsticky");
            for (name, value) in before {
                if !NONSTICKY.contains(&name.as_str()) && !names(nonsticky, name) {
                    inherited.push((name.clone(), value.clone()));
                }
            }
        }
        if let Some(after) = self.text_properties_at(pos) {
            let front = after.get("front-sticky");
            for (name, value) in after {
                if names(front, name) && !inherited.iter().any(|(n, _)| n == name) {
                    inherited.push((name.clone(), value.clone()));
                }
            }
        }
        self.insert(s)?;
        let n = s.chars().count();
        for (name, value) in inherited {
            self.put_text_property(pos..pos + n, &name, value);
        }
        Ok(())
    }

    // Text properties

    /// Sets a property on every character in a range (Emacs's `put-text-property`).
    /// Like Emacs's font-lock, property changes do not mark the buffer modified.
    pub fn put_text_property(&mut self, range: Range<usize>, name: &str, value: Value) {
        let end = range.end.min(self.len());
        if name == "syntax-table" {
            // Parse states after it are wrong now, as after an edit.
            self.ppss_cache.get_mut().retain(|(p, _)| *p <= range.start);
        }
        self.properties.modify(range.start, end, |p| {
            p.insert(name.to_string(), value.clone());
        });
    }

    /// Sets a property on a range, or with `None` takes it off, as Lisp's
    /// `put-text-property` and `remove-text-properties` do: recorded for
    /// undo, and the buffer modified where anything changes, unlike
    /// [`Buffer::put_text_property`], which the editor uses for its own marks.
    pub fn change_text_property(&mut self, range: Range<usize>, name: &str, value: Option<Value>) {
        if !self.record_property_change(range.start, range.end, name, |old| old != value.as_ref()) {
            return;
        }
        match value {
            Some(v) => self.put_text_property(range, name, v),
            None => self.remove_text_property(range, name),
        }
    }

    /// Adds a face to the `face` property of every character in a range,
    /// keeping the faces already there, as Emacs's `add-face-text-property`.
    /// The new face wins over them unless `append` is set.
    pub fn add_face_text_property(&mut self, range: Range<usize>, face: &str, append: bool) {
        let end = range.end.min(self.len());
        self.properties.modify(range.start, end, |p| {
            let mut faces = p.get("face").map(crate::faces::face_names).unwrap_or_default();
            if faces.iter().any(|f| f == face) {
                return;
            }
            if append {
                faces.push(face.to_string());
            } else {
                faces.insert(0, face.to_string());
            }
            let value = match faces.as_slice() {
                [one] => Value::Str(one.clone()),
                _ => Value::List(faces.into_iter().map(Value::Str).collect()),
            };
            p.insert("face".to_string(), value);
        });
    }

    pub fn remove_text_property(&mut self, range: Range<usize>, name: &str) {
        if name == "syntax-table" {
            self.ppss_cache.get_mut().retain(|(p, _)| *p <= range.start);
        }
        let end = range.end.min(self.len());
        self.properties.modify(range.start, end, |p| {
            p.remove(name);
        });
    }

    /// The properties of the character at `pos`.
    /// The id the buffer keeps for its life, renamed or not, as a buffer
    /// object refers to it.
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn text_properties_at(&self, pos: usize) -> Option<&Props> {
        self.properties.at(pos)
    }

    pub fn text_property(&self, pos: usize, name: &str) -> Option<&Value> {
        self.properties.at(pos)?.get(name)
    }

    /// The next position after `pos` where text properties change.
    pub fn next_property_change(&self, pos: usize) -> Option<usize> {
        self.properties.next_change(pos).filter(|&p| p <= self.len())
    }

    /// The last position before `pos` where text properties change.
    pub fn previous_property_change(&self, pos: usize) -> Option<usize> {
        self.properties.previous_change(pos)
    }

    /// Where a mark undo keeps track of is now.
    fn mark_ref(&self, which: MarkRef) -> Option<usize> {
        match which {
            MarkRef::Mark => self.mark,
            MarkRef::Ring(i) => self.mark_ring.get(i).copied(),
            MarkRef::Window(w) => self.window_point(w),
            MarkRef::Marker(id) => self.marker(id),
        }
    }

    fn mark_ref_mut(&mut self, which: MarkRef) -> Option<&mut usize> {
        match which {
            MarkRef::Mark => self.mark.as_mut(),
            MarkRef::Ring(i) => self.mark_ring.get_mut(i),
            MarkRef::Window(w) => self.window_points.iter_mut().find(|e| e.0 == w).map(|e| &mut e.1),
            MarkRef::Marker(id) => self.markers.iter_mut().find(|m| m.id == id).map(|m| &mut m.pos),
        }
    }

    // Change groups

    // Markers

    /// Makes a marker at a position, as Emacs's `copy-marker`; one that
    /// advances moves past text inserted where it is. Returns its id.
    pub fn make_marker(&mut self, pos: usize, advances: bool) -> u64 {
        let id = NEXT_MARKER_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.markers.push(Marker { id, pos: pos.min(self.len()), advances });
        id
    }

    /// Where a marker of this buffer is.
    pub fn marker(&self, id: u64) -> Option<usize> {
        self.markers.iter().find(|m| m.id == id).map(|m| m.pos)
    }

    /// The buffer's own variables and their values, as Emacs's `buffer-local-variables`.
    pub fn local_variables(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.locals.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Whether a marker of this buffer advances past text inserted where it
    /// is, as Emacs's `marker-insertion-type`.
    pub fn marker_advances(&self, id: u64) -> Option<bool> {
        self.markers.iter().find(|m| m.id == id).map(|m| m.advances)
    }

    /// Makes a marker of this buffer advance past text inserted where it
    /// is, or stay before it, as Emacs's `set-marker-insertion-type`.
    /// Whether it is this buffer's.
    pub fn set_marker_advances(&mut self, id: u64, advances: bool) -> bool {
        self.markers.iter_mut().find(|m| m.id == id).map(|m| m.advances = advances).is_some()
    }

    /// How many bytes come before a position, as Emacs's `position-bytes`
    /// counts them from 0: UTF-8's, a raw byte counting 2, as in Emacs's
    /// own encoding of text. None past the end.
    pub fn position_bytes(&self, pos: usize) -> Option<usize> {
        if pos > self.len() {
            return None;
        }
        Some(self.text.char_to_byte(pos) - 2 * self.raw_bytes_before(self.text.char_to_byte(pos)))
    }

    /// The position of the character a byte offset falls in, as Emacs's
    /// `byte-to-position`, the inverse of [`Buffer::position_bytes`]. None
    /// past the end.
    pub fn byte_to_position(&self, byte: usize) -> Option<usize> {
        if self.raw_bytes_before(self.text.len_bytes()) == 0 {
            return (byte <= self.text.len_bytes()).then(|| self.text.byte_to_char(byte));
        }
        // Raw bytes are 2 in Emacs's count, 4 in UTF-8: count along.
        let mut at = 0;
        for (i, c) in self.text.chars().enumerate() {
            let n = if crate::coding::char_raw_byte(c).is_some() { 2 } else { c.len_utf8() };
            if byte < at + n {
                return Some(i);
            }
            at += n;
        }
        (byte == at).then(|| self.len())
    }

    /// How many raw bytes, U+10FF80 to U+10FFFF, the text holds before a byte offset.
    fn raw_bytes_before(&self, byte: usize) -> usize {
        let mut n = 0;
        let mut seen = 0;
        for chunk in self.text.chunks() {
            if seen >= byte {
                break;
            }
            let part = &chunk[..chunk.len().min(byte - seen)];
            // Every raw byte's UTF-8 starts with 0xF4.
            if part.as_bytes().contains(&0xF4) {
                n += part.chars().filter(|c| crate::coding::char_raw_byte(*c).is_some()).count();
            }
            seen += chunk.len();
        }
        n
    }

    /// Moves a marker of this buffer.
    pub fn set_marker(&mut self, id: u64, pos: usize) {
        let len = self.len();
        if let Some(m) = self.markers.iter_mut().find(|m| m.id == id) {
            m.pos = pos.min(len);
        }
    }

    /// Takes a marker out of this buffer, as `(set-marker m nil)`, to delete
    /// it or put it in another.
    pub fn remove_marker(&mut self, id: u64) -> Option<Marker> {
        let i = self.markers.iter().position(|m| m.id == id)?;
        Some(self.markers.remove(i))
    }

    /// Takes all the buffer's markers out, as killing it does.
    pub(crate) fn take_markers(&mut self) -> Vec<Marker> {
        std::mem::take(&mut self.markers)
    }

    /// Puts a marker taken from another buffer into this one.
    pub fn add_marker(&mut self, mut marker: Marker) {
        marker.pos = marker.pos.min(self.len());
        self.markers.push(marker);
    }

    // Overlays

    /// Lays a new overlay over a range and returns its id.
    pub fn make_overlay(&mut self, range: Range<usize>) -> u64 {
        self.make_overlay_advancing(range, false, false)
    }

    /// Makes an overlay whose ends advance past text inserted at them as
    /// Emacs's `make-overlay` FRONT-ADVANCE and REAR-ADVANCE say.
    pub fn make_overlay_advancing(&mut self, range: Range<usize>, front_advance: bool, rear_advance: bool) -> u64 {
        let id = next_overlay_id();
        let (start, end) = (range.start.min(self.len()), range.end.min(self.len()));
        let mut overlay = Overlay::new(id, start, end);
        overlay.front_advance = front_advance;
        overlay.rear_advance = rear_advance;
        self.overlays.push(overlay);
        id
    }

    /// Every live overlay, in the order made, as Emacs's `overlay-lists` gives them.
    pub fn overlay_ids(&self) -> Vec<u64> {
        self.overlays.iter().map(|o| o.id).collect()
    }

    /// Deletes every overlay, as Emacs's `delete-all-overlays`.
    pub fn delete_all_overlays(&mut self) {
        self.overlays.clear();
    }

    pub fn overlay(&self, id: u64) -> Option<&Overlay> {
        self.overlays.get(id)
    }

    fn overlay_mut(&mut self, id: u64) -> Result<&mut Overlay> {
        self.overlays
            .get_mut(id)
            .ok_or_else(|| Error::new(format!("No such overlay: {id}")))
    }

    pub fn overlay_put(&mut self, id: u64, name: &str, value: Value) -> Result<()> {
        self.overlays.hooks |= ["modification-hooks", "insert-in-front-hooks", "insert-behind-hooks"].contains(&name);
        self.overlays.props_mut(id).ok_or_else(|| Error::new(format!("No such overlay: {id}")))?.insert(name.to_string(), value);
        Ok(())
    }

    pub fn move_overlay(&mut self, id: u64, range: Range<usize>) -> Result<()> {
        let len = self.len();
        let overlay = self.overlay_mut(id)?;
        overlay.start = range.start.min(len);
        overlay.end = range.end.min(len).max(overlay.start);
        Ok(())
    }

    pub fn delete_overlay(&mut self, id: u64) {
        self.overlays.remove(id);
    }

    /// The overlays overlapping `start..end`, and empty ones at or inside
    /// it, in the order made, as Emacs's `overlays-in`.
    pub fn overlays_in(&self, start: usize, end: usize) -> Vec<&Overlay> {
        self.overlays.overlapping(start, end)
    }

    /// The overlays starting or ending at `pos`, in the order made.
    pub fn overlays_at_edge(&self, pos: usize) -> Vec<&Overlay> {
        self.overlays.at_edge(pos)
    }

    /// Every overlay, in the order they were made.
    pub fn overlays(&self) -> impl DoubleEndedIterator<Item = &Overlay> + Clone {
        self.overlays.iter()
    }

    /// Overlays covering the character at `pos`, highest priority first,
    /// and the most recently made first among equals.
    pub fn overlays_at(&self, pos: usize) -> Vec<&Overlay> {
        let mut found: Vec<&Overlay> = self.overlays.covering(pos);
        found.sort_by(|a, b| b.priority().total_cmp(&a.priority()).then(b.id.cmp(&a.id)));
        found
    }

    /// A property at `pos`, from the highest priority overlay that has it,
    /// otherwise from the text, as Emacs's `get-char-property` gives it.
    pub fn char_property(&self, pos: usize, name: &str) -> Option<&Value> {
        self.overlays_at(pos)
            .into_iter()
            .find_map(|o| o.props.get(name))
            .or_else(|| self.text_property(pos, name))
    }

    /// Whether an overlay may have hooks an edit calls, as
    /// `modification-hooks`: none has had one put since the overlays
    /// were last cleared.
    pub(crate) fn overlays_may_have_hooks(&self) -> bool {
        self.overlays.hooks
    }

    /// The next position after `pos` where an overlay starts or ends.
    pub fn next_overlay_edge(&self, pos: usize) -> Option<usize> {
        self.overlays.next_edge(pos)
    }

    /// The last position before `pos` where an overlay starts or ends.
    pub fn previous_overlay_edge(&self, pos: usize) -> Option<usize> {
        self.overlays.previous_edge(pos)
    }

    /// The next position after `pos` where text properties or overlays change.
    pub fn next_char_property_change(&self, pos: usize) -> usize {
        let next = self.next_property_change(pos).unwrap_or(self.len());
        self.overlays.next_edge(pos).map_or(next, |edge| edge.min(next))
    }

    /// Replaces all text without recording undo and ignoring read-only.
    /// For buffers the editor generates, such as `*Help*`.
    pub fn set_text(&mut self, s: &str) {
        self.text = Rope::from_str(s);
        self.has_rtl = crate::bidi::needs_reordering(s);
        self.share(|| TextChange::Reset);
        for parser in &self.parsers {
            parser.reset();
        }
        self.properties.clear();
        self.overlays.clear();
        self.fontified.clear();
        self.point = 0;
        self.mark = None;
        self.mark_ring.clear();
        self.mark_active = false;
        self.shift_selected = false;
        self.top_line = 0;
        self.last_window_start = 0;
        for (_, p) in &mut self.window_points {
            *p = 0;
        }
        self.restriction = None;
        self.undo_groups.clear();
        self.open_group.clear();
        self.pending_undo = None;
        self.selective_undo = None;
        self.boundary_point = 0;
        self.open_point = None;
        self.modified = false;
        self.save_generation += 1;
        // New text, so whatever was worked out from the old is out of date.
        self.tick += 1;
    }

    /// The point of a window, other than the selected one, showing this buffer.
    pub(crate) fn window_point(&self, window: u64) -> Option<usize> {
        self.window_points.iter().find(|(w, _)| *w == window).map(|(_, p)| *p)
    }

    pub(crate) fn set_window_point(&mut self, window: u64, pos: usize) {
        let pos = pos.min(self.len());
        match self.window_points.iter_mut().find(|(w, _)| *w == window) {
            Some(entry) => entry.1 = pos,
            None => self.window_points.push((window, pos)),
        }
    }

    pub(crate) fn remove_window_point(&mut self, window: u64) -> Option<usize> {
        let i = self.window_points.iter().position(|(w, _)| *w == window)?;
        Some(self.window_points.remove(i).1)
    }

    /// Where a window, other than the selected one, showing this buffer
    /// starts. Starts are kept with the window points, so they move with
    /// edits as Emacs's window-start markers do.
    pub(crate) fn window_start(&self, window: u64) -> Option<usize> {
        self.window_point(window | WINDOW_START)
    }

    pub(crate) fn set_window_start(&mut self, window: u64, pos: usize) {
        self.set_window_point(window | WINDOW_START, pos);
    }

    pub(crate) fn remove_window_start(&mut self, window: u64) -> Option<usize> {
        self.remove_window_point(window | WINDOW_START)
    }

    /// Where a window started and its point when it last showed this
    /// buffer, its entry in the window's previous buffers.
    pub(crate) fn prev_entry(&self, window: u64) -> Option<(usize, usize)> {
        Some((self.window_point(window | PREV_START)?, self.window_point(window | PREV_POINT)?))
    }

    pub(crate) fn set_prev_entry(&mut self, window: u64, start: usize, point: usize) {
        self.set_window_point(window | PREV_START, start);
        self.set_window_point(window | PREV_POINT, point);
    }

    pub(crate) fn remove_prev_entry(&mut self, window: u64) {
        self.remove_window_point(window | PREV_START);
        self.remove_window_point(window | PREV_POINT);
    }

    /// Forgets everything kept for a window that is going.
    pub(crate) fn forget_window(&mut self, window: u64) {
        self.window_points.retain(|(w, _)| w & !(WINDOW_START | PREV_START | PREV_POINT) != window);
    }

    fn check_writable(&mut self) -> Result<()> {
        if self.read_only {
            return Err(Error::signal(
                "buffer-read-only",
                format!("Buffer is read-only: #<buffer {}>", self.name),
                vec![crate::Value::Str(self.name.clone())],
            ));
        }
        self.check_supersession()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer(text: &str) -> Buffer {
        let mut b = Buffer::new("test");
        b.insert(text).unwrap();
        b.undo_boundary();
        b
    }

    #[test]
    fn lines_without_newlines() {
        let b = buffer("one\ntwo\n");
        assert_eq!(b.line_count(), 3);
        assert_eq!(b.line_text(1), "two");
        assert_eq!(b.line_end(0), 3);
        assert_eq!(b.line_text(2), "");
    }

    #[test]
    fn delete_moves_point_and_mark() {
        let mut b = buffer("hello world");
        b.set_mark(Some(2));
        b.set_point(9);
        b.delete(0..6).unwrap();
        assert_eq!(b.slice(0..b.len()), "world");
        assert_eq!(b.point(), 3);
        assert_eq!(b.mark(), Some(0));
    }

    #[test]
    fn undo_restores_text_and_point() {
        let mut b = buffer("abc");
        b.set_point(1);
        // The command loop puts a boundary before each command.
        b.undo_boundary();
        b.delete(1..2).unwrap();
        b.undo_boundary();
        b.insert("XY").unwrap();
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "ac");
        b.undo(true).unwrap();
        assert_eq!(b.slice(0..b.len()), "abc");
        assert_eq!(b.point(), 1);
    }

    #[test]
    fn undo_can_be_undone() {
        let mut b = buffer("");
        b.insert("hi").unwrap();
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "");
        // A fresh undo after something else undoes the undo.
        assert!(b.undo(false).unwrap());
        assert_eq!(b.slice(0..b.len()), "hi");
    }

    #[test]
    fn undo_redo_reverses_the_last_undo() {
        let mut b = buffer("");
        b.insert("ab").unwrap();
        b.undo(false).unwrap();
        b.undo_redo().unwrap();
        assert_eq!(b.slice(0..b.len()), "ab");
        assert_eq!(b.undo_redo().unwrap_err().to_string(), "No undone changes to redo");
    }

    #[test]
    fn the_mark_ring_follows_edits() {
        let mut b = buffer("hello world");
        b.push_mark(2, false);
        b.push_mark(8, false);
        assert_eq!(b.mark_ring(), [2]);
        b.insert_at(0, ">> ").unwrap();
        assert_eq!((b.mark(), b.mark_ring()), (Some(11), &[5][..]));
        b.pop_mark();
        assert_eq!((b.mark(), b.mark_ring()), (Some(5), &[11][..]));
    }

    #[test]
    fn steps_amalgamate_into_one() {
        let mut b = buffer("x");
        let since = b.undo_steps();
        for word in ["one ", "two "] {
            b.insert_at(0, word).unwrap();
            b.undo_boundary();
        }
        b.amalgamate_undo_since(since);
        b.undo(false).unwrap();
        assert_eq!(b.slice(0..b.len()), "x");
    }

    #[test]
    fn undo_back_to_the_saved_text_is_unmodified() {
        let mut b = Buffer::new("f");
        b.insert("saved").unwrap();
        b.mark_saved();
        assert!(!b.is_modified());
        b.insert("!").unwrap();
        assert!(b.is_modified());
        b.undo(false).unwrap();
        assert!(!b.is_modified());
        // Undoing past the save leaves the text different from the file again.
        b.undo(true).unwrap();
        assert!(b.is_modified());
        // Redoing back to the saved text is unmodified once more.
        b.undo_redo().unwrap();
        assert!(!b.is_modified());
        b.insert("saved").unwrap();
        assert!(b.is_modified());
    }

    #[test]
    fn read_only_refuses_edits() {
        let mut b = buffer("x");
        b.read_only = true;
        assert!(b.insert("y").is_err());
        assert!(b.delete(0..1).is_err());
    }
}

/// The number of a new overlay: unique among every buffer's, so an
/// overlay's number alone says which buffer it is in, as an Emacs overlay
/// knows its buffer, and always larger than the last.
fn next_overlay_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
