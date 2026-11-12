//! Windows and frames.

use crate::EditorValue;
use crate::natives::{Frm, Opt, Record, Win, natives};

natives! {
    fn splitWindow(ed, window: Option<Win>, side_by_side: bool, size: Option<i64>, before: Opt<bool>) -> Win {
        let window = window.map(|x| x.0);
        ed.split_window_toward(window, side_by_side, before.0 == Some(true), size).map(Win)
    }

    /// Split the frame's root window, as split-root-window-below and -right:
    /// the new window takes the whole bottom of the frame, or its right side.
    /// `size` is as splitWindow's. Returns the new window.
    #[ts = "(side?: \"below\" | \"right\" | \"above\" | \"left\", size?: number): Window"]
    pub fn splitRootWindow(ed, side: Option<String>, size: Option<i64>) -> Win {
        let side = side.as_deref().unwrap_or("below");
        ed.split_root_window_toward(matches!(side, "right" | "left"), matches!(side, "left" | "above"), size).map(Win)
    }

    /// Splits the smallest part of the selected frame's windows that holds
    /// all of `windows`, as Emacs splits an internal window, such as the
    /// main window beside side windows: the new window takes the part's
    /// whole bottom, right, top or left. `size` is as splitWindow's.
    #[ts = "(windows: WindowLike[], side?: \"below\" | \"right\" | \"above\" | \"left\", size?: number): Window"]
    pub fn splitWindowsEnclosing(ed, windows: Vec<Win>, side: Option<String>, size: Option<i64>) -> Win {
        let side = side.as_deref().unwrap_or("below");
        let ids: Vec<u64> = windows.iter().map(|w| w.0).collect();
        ed.split_windows_toward(&ids, matches!(side, "right" | "left"), matches!(side, "left" | "above"), size).map(Win)
    }

    /// Marks a window the second most recently used, after the selected
    /// one, as window-bump-use-time; gives its use time, or undefined for
    /// the selected window.
    pub fn windowBumpUseTime(ed, window: Option<Win>) -> Option<u64> {
        Ok(window.and_then(|w| ed.window_bump_use_time(w.0)))
    }

    /// The keys that can follow a prefix, such as "C-x", in the keymaps active
    /// now, in key order: each with the command it runs, or undefined for
    /// another prefix. What which-key lists.
    #[ts = "(prefix: string): [string, string | undefined][]"]
    pub fn prefixBindings(ed, prefix: String) -> Vec<Vec<Option<String>>> {
        let keys = e8_core::Key::parse_seq(&prefix).ok_or_else(|| e8_core::Error::new(format!("Invalid key sequence: {prefix}")))?;
        Ok(ed.prefix_bindings(&keys).into_iter().map(|(k, c)| vec![Some(k.to_string()), c]).collect())
    }

    /// How the selected frame's windows divide it: a window, or for a split
    /// [sideBySide, firstSize, first, second], firstSize the first part's
    /// total lines or columns. A combination of more than two windows is
    /// nested from its first: [h, a, A, [h, b, B, C]]. Emacs's windows, with
    /// frameRootWindow, windowParent and the children, describe it as it is.
    #[ts = "(): WindowTreeNode"]
    pub fn windowTree(ed) -> EditorValue {
        fn node(t: &e8_core::WindowTree) -> EditorValue {
            match t {
                e8_core::WindowTree::Leaf(id) => EditorValue::Window(*id),
                e8_core::WindowTree::Combination(c) => parts(c.horizontal, &c.children),
            }
        }
        fn parts(horizontal: bool, children: &[e8_core::Part]) -> EditorValue {
            match children {
                [only] => node(&only.tree),
                [first, rest @ ..] => EditorValue::List(vec![
                    EditorValue::Bool(horizontal),
                    EditorValue::Number(first.size as f64),
                    node(&first.tree),
                    parts(horizontal, rest),
                ]),
                [] => EditorValue::Null,
            }
        }
        Ok(node(ed.window_tree()))
    }

    /// A frame's root window, the selected frame's by default: its only
    /// window, or the internal window holding the others, as frame-root-window.
    #[ts = "(frame?: FrameLike): Window"]
    pub fn frameRootWindow(ed, frame: Option<Frm>) -> Win {
        let frame = frame.map_or(ed.selected_frame(), |f| f.0);
        ed.frame_root_window(frame).map(Win).ok_or_else(|| e8_core::Error::new("No such frame"))
    }

    /// A window's parent, the internal window it is a child of, as
    /// window-parent; undefined for a frame's root window.
    #[ts = "(window?: WindowLike): Window | undefined"]
    pub fn windowParent(ed, window: Option<Win>) -> Option<Win> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_parent(id).map(Win))
    }

    /// An internal window's first child if its children are one above
    /// another, as window-top-child; undefined otherwise.
    #[ts = "(window?: WindowLike): Window | undefined"]
    pub fn windowTopChild(ed, window: Option<Win>) -> Option<Win> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_children(id).and_then(|(h, c)| (!h).then(|| c.first().copied()).flatten()).map(Win))
    }

    /// An internal window's first child if its children are side by side,
    /// as window-left-child; undefined otherwise.
    #[ts = "(window?: WindowLike): Window | undefined"]
    pub fn windowLeftChild(ed, window: Option<Win>) -> Option<Win> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_children(id).and_then(|(h, c)| h.then(|| c.first().copied()).flatten()).map(Win))
    }

    /// The window after one in its parent, as window-next-sibling.
    #[ts = "(window?: WindowLike): Window | undefined"]
    pub fn windowNextSibling(ed, window: Option<Win>) -> Option<Win> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_sibling(id, true).map(Win))
    }

    /// The window before one in its parent, as window-prev-sibling.
    #[ts = "(window?: WindowLike): Window | undefined"]
    pub fn windowPrevSibling(ed, window: Option<Win>) -> Option<Win> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_sibling(id, false).map(Win))
    }

    /// A window's share of its parent's height, or width with `horizontal`,
    /// as window-normal-size: 1.0 across its parent's combination and for
    /// the root.
    #[ts = "(window?: WindowLike, horizontal?: boolean): number"]
    pub fn windowNormalSize(ed, window: Option<Win>, horizontal: Option<bool>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        ed.window_normal_size(id, horizontal.unwrap_or(false)).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// An internal window's combination limit, as window-combination-limit:
    /// whether splitting a child makes a new internal window.
    #[ts = "(window: WindowLike): boolean"]
    pub fn windowCombinationLimit(ed, window: Win) -> bool {
        ed.window_combination_limit(window.0).ok_or_else(|| e8_core::Error::signal("wrong-type-argument", "Not an internal window", Vec::new()))
    }

    /// Sets an internal window's combination limit, as set-window-combination-limit.
    #[ts = "(window: WindowLike, limit: boolean): void"]
    pub fn setWindowCombinationLimit(ed, window: Win, limit: bool) -> () {
        ed.set_window_combination_limit(window.0, limit)
    }

    /// Splits a window, live or internal, as split-window-internal: the new
    /// window below, to the right, above or to the left of it, sharing its
    /// size, which `size` gives as splitWindow's does. A new window beside
    /// an internal window shows the selected window's buffer.
    #[ts = "(window: WindowLike, side?: \"below\" | \"right\" | \"above\" | \"left\", size?: number): Window"]
    pub fn splitWindowInternal(ed, window: Win, side: Option<String>, size: Option<i64>) -> Win {
        let side = side.as_deref().unwrap_or("below");
        ed.split_window_internal(window.0, matches!(side, "right" | "left"), matches!(side, "left" | "above"), size).map(Win)
    }

    /// The buffer-local minor modes on in the current buffer, as local-minor-modes.
    pub fn localMinorModes(ed) -> Vec<String> {
        let global: Vec<&str> = ed.minor_modes().iter().filter(|m| m.global).map(|m| m.name.as_str()).collect();
        Ok(ed.enabled_minor_modes().into_iter().filter(|m| !global.contains(&m.as_str())).collect())
    }

    /// Wait for output from a process, or any with none named, for up to
    /// `seconds`, or until some comes, as accept-process-output: it goes to
    /// the filters meanwhile, and timers run, but keys wait. Whether output came.
    #[ts = "(process?: string, seconds?: number): boolean"]
    pub fn acceptProcessOutput(ed, process: Option<String>, seconds: Option<f64>) -> bool {
        ed.wait_for_process_output(process.as_deref(), seconds)
    }

    /// E8's process id, as emacs-pid.
    pub fn emacsPid(ed) -> u32 {
        Ok(e8_core::clock::process_id())
    }

    /// Whether a process of this machine is running, as process-attributes finds it.
    pub fn processAliveP(ed, pid: i64) -> bool {
        Ok(e8_core::filelock::alive(pid))
    }

    /// The keys read so far while a prefix key waits for more, as
    /// this-single-command-keys gives them to a timer then, such as "C-x 4";
    /// else the keys of the command running.
    pub fn thisSingleCommandKeys(ed) -> String {
        Ok(e8_core::format_keys(ed.this_single_command_keys()))
    }

    /// Delete a window, the selected one by default, giving its space to its neighbour.
    #[ts = "(window?: WindowLike): void"]
    pub fn deleteWindow(ed, window: Option<Win>) {
        let window = window.map(|x| x.0);
        ed.delete_window(window)
    }

    /// Make a window the selected one, whose buffer commands act on; with
    /// `norecord`, leaving the buffer list as it is, as select-window's NORECORD.
    #[ts = "(window: WindowLike, norecord?: boolean): void"]
    pub fn selectWindow(ed, window: Win, norecord: Option<bool>) {
        let window = window.0;
        if norecord == Some(true) { ed.select_window_norecord(window) } else { ed.select_window(window) }
    }

    pub fn selectedWindow(ed) -> Win {
        Ok(Win(if ed.minibuffer_window_selected() { e8_core::MINIBUFFER_WINDOW } else { ed.selected_window() }))
    }

    /// The window that was selected when the minibuffer was entered, while the minibuffer's window is selected, as minibuffer-selected-window.
    pub fn minibufferSelectedWindow(ed) -> Option<Win> {
        Ok(ed.minibuffer_window_selected().then(|| Win(ed.selected_window())))
    }

    /// How many minibuffers are open, one inside another, as minibuffer-depth.
    pub fn minibufferDepth(ed) -> usize {
        Ok(ed.minibuffer_depth())
    }

    /// What waits for the user's input now, a prompt or a command reading a
    /// key, as a number no other has had, or undefined when nothing waits.
    /// Code that asks the user from a timer, as agent-shell asks for an
    /// agent's permission, waits until it is undefined, so its question
    /// never takes the keys meant for another.
    pub fn waitingForInput(ed) -> Option<u64> {
        Ok(ed.waiting_for_input())
    }

    fn windowBuffer(ed, window: Win) -> Option<String> {
        let window = window.0;
        if window == e8_core::MINIBUFFER_WINDOW {
            return Ok(Some(ed.minibuffer().name.clone()));
        }
        Ok(ed.window_buffer_name(window).map(str::to_string))
    }

    /// Make the current buffer read-only, or writable again, as setting buffer-read-only does.
    pub fn setReadOnly(ed, on: bool) {
        ed.buffer_mut().read_only = on;
        Ok(())
    }

    /// Whether the current buffer is read-only, as Emacs's buffer-read-only.
    pub fn bufferReadOnly(ed) -> bool {
        Ok(ed.buffer().read_only)
    }

    fn setCurrentBuffer(ed, name: String) -> String {
        ed.set_current_buffer(&name)
    }

    fn getBufferCreate(ed, name: String) {
        ed.get_buffer_create(&name);
        Ok(())
    }

    /// Visit a file without showing it, as find-file-noselect, and return its buffer's name.
    pub fn findFileNoselect(ed, file: String) -> String {
        ed.find_file_noselect(&ed.expand_file_name(&file))
    }

    fn makeFrame(ed, buffer: Option<String>) -> Frm {
        ed.make_frame(buffer.as_deref()).map(Frm)
    }

    /// Delete a frame, the selected one by default, and its windows, as delete-frame does.
    #[ts = "(frame?: FrameLike): void"]
    pub fn deleteFrame(ed, frame: Option<Frm>) {
        let frame = frame.map(|x| x.0);
        ed.delete_frame(frame)
    }

    /// Make a frame the selected one, as select-frame does.
    pub fn selectFrame(ed, frame: Frm) {
        let frame = frame.0;
        ed.select_frame(frame)
    }

    pub fn selectedFrame(ed) -> Frm {
        Ok(Frm(ed.selected_frame()))
    }

    /// A frame's parameter, the selected frame's by default, as frame-parameter:
    /// one set with setFrameParameter, or tab-bar-lines.
    #[ts = "(frame: FrameLike | undefined, name: string): Value | undefined"]
    pub fn frameParameter(ed, frame: Option<Frm>, name: String) -> Option<EditorValue> {
        let frame = frame.map(|x| x.0);
        Ok(ed.frame_parameter(frame.unwrap_or(ed.selected_frame()), &name))
    }

    /// Set a frame's parameter, the selected frame's by default, as
    /// set-frame-parameter. tab-bar-lines, 0 or 1, hides or shows its tab bar,
    /// which shows tab-bar-line, a mode line construct.
    #[ts = "(frame: FrameLike | undefined, name: string, value: Value): void"]
    pub fn setFrameParameter(ed, frame: Option<Frm>, name: String, value: EditorValue) {
        let frame = frame.map(|x| x.0);
        ed.set_frame_parameter(frame.unwrap_or(ed.selected_frame()), &name, value)
    }

    /// The frame a window is on, the selected window by default, as window-frame.
    #[ts = "(window?: WindowLike): Frame | undefined"]
    pub fn windowFrame(ed, window: Option<Win>) -> Option<Frm> {
        let window = window.map(|x| x.0);
        Ok(ed.window_frame(window.unwrap_or(ed.selected_window())).map(Frm))
    }

    /// A frame's first window, its top left one, the selected frame's by default, as frame-first-window.
    #[ts = "(frame?: FrameLike): Window | undefined"]
    pub fn frameFirstWindow(ed, frame: Option<Frm>) -> Option<Win> {
        let frame = frame.map(|x| x.0);
        Ok(ed.frame_first_window(frame.unwrap_or(ed.selected_frame())).map(Win))
    }

    /// The frame after one, the selected frame by default, round the end of frame-list, as next-frame.
    #[ts = "(frame?: FrameLike): Frame | undefined"]
    pub fn nextFrame(ed, frame: Option<Frm>) -> Option<Frm> {
        let frame = frame.map(|x| x.0);
        Ok(ed.next_frame(frame.unwrap_or(ed.selected_frame()), true).map(Frm))
    }

    /// The frame before one, the selected frame by default, as previous-frame.
    #[ts = "(frame?: FrameLike): Frame | undefined"]
    pub fn previousFrame(ed, frame: Option<Frm>) -> Option<Frm> {
        let frame = frame.map(|x| x.0);
        Ok(ed.next_frame(frame.unwrap_or(ed.selected_frame()), false).map(Frm))
    }

    /// Windows in cyclic order starting with one, the selected window by
    /// default, as window-list-1: its frame's, or every frame's with
    /// `allFrames`, with the minibuffer's window last if `minibuffer`.
    #[ts = "(window?: WindowLike, minibuffer?: boolean, allFrames?: boolean): Window[]"]
    pub fn windowList1(ed, window: Option<Win>, minibuffer: Option<bool>, all_frames: Option<bool>) -> Vec<Win> {
        let window = window.map(|x| x.0);
        Ok(ed.window_list_1(window, minibuffer.unwrap_or(false), all_frames.unwrap_or(false)).into_iter().map(Win).collect())
    }

    /// A window's edges in its frame, in columns and lines from the frame's
    /// top left, the selected window's by default, as window-edges: left,
    /// top, right and bottom, its mode line and divider included, or with
    /// `body` its text area only.
    #[ts = "(window?: WindowLike, body?: boolean): [left: number, top: number, right: number, bottom: number]"]
    pub fn windowEdges(ed, window: Option<Win>, body: Option<bool>) -> Vec<usize> {
        let window = window.map_or(ed.selected_window(), |w| w.0);
        let (l, t, r, b) = ed.window_edges(window, body.unwrap_or(false)).ok_or_else(|| e8_core::Error::new("No such window"))?;
        Ok(vec![l, t, r, b])
    }

    /// Whether a value is a window that is live or internal, as
    /// window-valid-p.
    #[ts = "(window: unknown): boolean"]
    pub fn windowValidP(ed, window: EditorValue) -> bool {
        Ok(Win::from_value(&window).is_some_and(|w| ed.window_frame(w.0).is_some()))
    }

    /// Whether a value is a window showing a buffer, as window-live-p.
    #[ts = "(window: unknown): boolean"]
    pub fn windowLiveP(ed, window: EditorValue) -> bool {
        Ok(Win::from_value(&window).is_some_and(|w| ed.window_frame(w.0).is_some() && !ed.window_internal_p(w.0)))
    }

    /// Whether a value is a window, live or deleted, as windowp.
    #[ts = "(value: unknown): value is Window"]
    pub fn windowp(ed, value: EditorValue) -> bool {
        Ok(matches!(value, EditorValue::Window(_)))
    }

    /// Whether a value is a frame that is live, as frame-live-p.
    #[ts = "(frame: unknown): boolean"]
    pub fn frameLiveP(ed, frame: EditorValue) -> bool {
        Ok(Frm::from_value(&frame).is_some_and(|f| ed.frame_list().contains(&f.0)))
    }

    /// Whether a value is a frame, live or deleted, as framep: the kind of
    /// display it is on, as window-system names it, or true on a terminal;
    /// false for anything else.
    #[ts = "(value: unknown): false | true | \"ns\" | \"x\" | \"w32\""]
    pub fn framep(ed, value: EditorValue) -> EditorValue {
        if !matches!(value, EditorValue::Frame(_)) {
            return Ok(EditorValue::Bool(false));
        }
        if !ed.text_metrics().images() {
            return Ok(EditorValue::Bool(true));
        }
        Ok(EditorValue::Str(if cfg!(target_os = "macos") { "ns" } else if cfg!(windows) { "w32" } else { "x" }.to_string()))
    }

    /// Whether a frame is shown: true, false when made invisible, or "icon"
    /// when iconified, as frame-visible-p.
    #[ts = "(frame?: FrameLike): boolean | \"icon\""]
    pub fn frameVisibleP(ed, frame: Option<Frm>) -> EditorValue {
        let frame = frame.map(|x| x.0);
        let frame = frame.unwrap_or(ed.selected_frame());
        if !ed.frame_list().contains(&frame) {
            return Err(e8_core::Error::signal("wrong-type-argument", "Not a live frame", vec![EditorValue::Symbol("frame-live-p".into()), EditorValue::Frame(frame)]));
        }
        Ok(match ed.frame_visibility(frame) {
            EditorValue::Null => EditorValue::Bool(false),
            v => v,
        })
    }

    /// The frames that are shown, as visible-frame-list.
    pub fn visibleFrameList(ed) -> Vec<Frm> {
        Ok(ed.frame_list().into_iter().filter(|f| ed.frame_visibility(*f) == EditorValue::Bool(true)).map(Frm).collect())
    }

    /// Show a frame, the selected one by default, as make-frame-visible.
    #[ts = "(frame?: FrameLike): void"]
    pub fn makeFrameVisible(ed, frame: Option<Frm>) {
        let frame = frame.map(|x| x.0);
        ed.set_frame_visibility(frame.unwrap_or(ed.selected_frame()), EditorValue::Bool(true))
    }

    /// Hide a frame, the selected one by default, as make-frame-invisible.
    #[ts = "(frame?: FrameLike): void"]
    pub fn makeFrameInvisible(ed, frame: Option<Frm>) {
        let frame = frame.map(|x| x.0);
        ed.set_frame_visibility(frame.unwrap_or(ed.selected_frame()), EditorValue::Bool(false))
    }

    /// Iconify a frame, the selected one by default, as iconify-frame.
    #[ts = "(frame?: FrameLike): void"]
    pub fn iconifyFrame(ed, frame: Option<Frm>) {
        let frame = frame.map(|x| x.0);
        ed.set_frame_visibility(frame.unwrap_or(ed.selected_frame()), EditorValue::Str("icon".into()))
    }

    /// Bring a frame, the selected one by default, in front of the others,
    /// showing it if hidden or iconified, as raise-frame.
    #[ts = "(frame?: FrameLike): void"]
    pub fn raiseFrame(ed, frame: Option<Frm>) {
        let frame = frame.map(|x| x.0);
        ed.raise_frame(frame.unwrap_or(ed.selected_frame()))
    }

    /// The height of a line of the frame's default font, in the front end's
    /// units: pixels, or 1 on a terminal, as frame-char-height.
    #[ts = "(frame?: FrameLike): number"]
    pub fn frameCharHeight(ed, frame: Option<Frm>) -> f64 {
        let frame = frame.map(|x| x.0);
        let _ = frame;
        Ok(ed.text_metrics().char_height() as f64)
    }

    /// The kind of display a frame is on, as window-system: "ns" for the
    /// window on macOS, "x" elsewhere, "w32" on Windows, undefined on a terminal.
    #[ts = "(frame?: FrameLike): \"ns\" | \"x\" | \"w32\" | undefined"]
    pub fn windowSystem(ed, frame: Option<Frm>) -> Option<String> {
        let frame = frame.map(|x| x.0);
        let _ = frame;
        if !ed.text_metrics().images() {
            return Ok(None);
        }
        Ok(Some(if cfg!(target_os = "macos") { "ns" } else if cfg!(windows) { "w32" } else { "x" }.to_string()))
    }

    /// A window's total size, its mode line, header line and divider
    /// included, in the front end's units, the selected window's by
    /// default, as window-pixel-width.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowPixelWidth(ed, window: Option<Win>) -> f64 {
        let window = window.map(|x| x.0);
        let w = window.unwrap_or(ed.selected_window());
        Ok(ed.window_pixel_size(w).ok_or_else(|| e8_core::Error::new("No such window"))?.0 as f64)
    }

    /// A window's total height in the front end's units, as window-pixel-height.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowPixelHeight(ed, window: Option<Win>) -> f64 {
        let window = window.map(|x| x.0);
        let w = window.unwrap_or(ed.selected_window());
        Ok(ed.window_pixel_size(w).ok_or_else(|| e8_core::Error::new("No such window"))?.1 as f64)
    }

    /// How tall a window's mode line is, 0 without one, as window-mode-line-height.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowModeLineHeight(ed, window: Option<Win>) -> f64 {
        let window = window.map(|x| x.0);
        let w = window.unwrap_or(ed.selected_window());
        Ok(if ed.window_shows_mode_line(w) { ed.text_metrics().window_chrome().mode_line as f64 } else { 0.0 })
    }

    /// A window's total height in lines, its mode line and header line
    /// included, as window-total-height; an internal window's is its
    /// children's together.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowTotalHeight(ed, window: Option<Win>) -> usize {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        if id == e8_core::MINIBUFFER_WINDOW {
            return Ok(ed.mini_window_lines());
        }
        ed.window_total_size(id).map(|s| s.1).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// A window's total width in columns, its divider and margins included,
    /// as window-total-width.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowTotalWidth(ed, window: Option<Win>) -> usize {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        if id == e8_core::MINIBUFFER_WINDOW {
            return Ok(ed.frame_cells().0);
        }
        ed.window_total_size(id).map(|s| s.0).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// How tall a window's header line is, 0 without one, as window-header-line-height.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowHeaderLineHeight(ed, window: Option<Win>) -> f64 {
        let window = window.map(|x| x.0);
        let w = window.unwrap_or(ed.selected_window());
        let lines = ed.window_total_size(w).map_or(0, |s| s.1);
        Ok(if ed.window_wants_header_line(w, lines) { ed.text_metrics().window_chrome().header_line as f64 } else { 0.0 })
    }

    /// A frame's selected window, the selected frame's by default, as frame-selected-window.
    #[ts = "(frame?: FrameLike): Window | undefined"]
    pub fn frameSelectedWindow(ed, frame: Option<Frm>) -> Option<Win> {
        let frame = frame.map(|x| x.0);
        Ok(ed.frame_selected_window(frame.unwrap_or(ed.selected_frame())).map(Win))
    }

    /// Whether the display shows images and fonts of many sizes, as a graphical
    /// one does, rather than a terminal's cells, as display-graphic-p.
    pub fn displayGraphicP(ed) -> bool {
        Ok(ed.text_metrics().images())
    }

    /// The width of a character of the frame's default font, in the front
    /// end's units: pixels, or 1 on a terminal, as frame-char-width.
    pub fn frameCharWidth(ed) -> f64 {
        Ok(ed.text_metrics().char_width() as f64)
    }

    /// The selected frame's height in lines, its windows' with their mode
    /// lines but not the echo area, as frame-height.
    pub fn frameHeight(ed) -> usize {
        Ok(ed.frame_cells().1)
    }

    /// A frame's width in columns, the selected frame's by default, as frame-width.
    #[ts = "(frame?: FrameLike): number"]
    pub fn frameWidth(ed, frame: Option<Frm>) -> usize {
        let frame = frame.map(|x| x.0);
        Ok(ed.frame_width(frame.unwrap_or(ed.selected_frame())))
    }

    /// The frames, newest first, as frame-list orders them.
    pub fn frameList(ed) -> Vec<Frm> {
        Ok(ed.frame_list().into_iter().map(Frm).collect())
    }

    fn setWindowBuffer(ed, window: Win, buffer: String) {
        let window = window.0;
        ed.set_window_buffer(window, &buffer)
    }

    fn windowSize(ed, window: Win) -> Option<Vec<usize>> {
        let window = window.0;
        // The minibuffer's window spans the frame, as many lines as it shows.
        if window == e8_core::MINIBUFFER_WINDOW {
            let (width, lines) = (ed.frame_cells().0, ed.mini_window_lines());
            return Ok(Some(vec![width, lines, width, lines, 1]));
        }
        let total = ed.window_total_sizes().into_iter().find(|s| s.0 == window);
        let full = usize::from(ed.window_full_width(window));
        Ok(ed.window_size(window).zip(total).map(|((w, h), (_, tw, th))| vec![w, h, tw, th, full]))
    }

    fn windowUseTime(ed, window: Win) -> Option<u64> {
        let window = window.0;
        Ok(ed.window_use_time(window))
    }

    fn resizeWindow(ed, window: Option<Win>, delta: i64, horizontal: bool, apply: bool, pixelwise: bool) -> i64 {
        let window = window.map(|x| x.0);
        ed.resize_window_by(window, delta, horizontal, apply, pixelwise)
    }

    /// The height of a window's text area in the front end's units, points
    /// in the GUI and lines on a terminal, beside its mode line, header line
    /// and the room its front end leaves, as window-body-height with PIXELWISE.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowBodyPixelHeight(ed, window: Option<Win>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        ed.window_body_pixel_size(id).map(|s| s.1 as f64).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// The width of a window's text area in the front end's units, beside
    /// its fringes and divider, as window-body-width with PIXELWISE.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowBodyPixelWidth(ed, window: Option<Win>) -> f64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        ed.window_body_pixel_size(id).map(|s| s.0 as f64).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// A window's edges in the front end's units from the frame's windows'
    /// top left, as window-pixel-edges: left, top, right and bottom, its
    /// mode line and divider included, or with `body` its text area only.
    #[ts = "(window?: WindowLike, body?: boolean): [left: number, top: number, right: number, bottom: number]"]
    pub fn windowPixelEdges(ed, window: Option<Win>, body: Option<bool>) -> Vec<f64> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        let r = ed.window_pixel_rect(id).ok_or_else(|| e8_core::Error::new("No such window"))?;
        let (mut x0, mut y0, mut x1, mut y1) = (r.x, r.y, r.x + r.width, r.y + r.height);
        if body.unwrap_or(false) && ed.window_frame(id).is_some() && !ed.window_internal_p(id) {
            let (above, below, across) = ed.window_chrome_units(id, &r);
            let fringes = ed.text_metrics().window_chrome().fringes;
            x0 += fringes / 2.0;
            x1 = (x1 - (across - fringes / 2.0)).max(x0);
            y0 += above;
            y1 = (y1 - below).max(y0);
        }
        Ok(vec![x0 as f64, y0 as f64, x1 as f64, y1 as f64])
    }

    /// A column's width and a line's height in the front end's units, the
    /// default font's, as frame-char-width and frame-char-height.
    #[ts = "(): [width: number, height: number]"]
    pub fn frameCharSize(ed) -> Vec<f64> {
        let (w, h) = ed.cell();
        Ok(vec![w as f64, h as f64])
    }

    /// Make windows the same size as their neighbours, as balance-windows does.
    pub fn balanceWindows(ed) {
        ed.balance_windows();
        Ok(())
    }

    /// The windows in cyclic order, left to right and top to bottom, as other-window visits them.
    pub fn windowList(ed) -> Vec<Win> {
        // The minibuffer's window comes last while a prompt is open, as in Emacs's window-list.
        let mut windows = ed.window_list();
        if ed.prompt().is_some() {
            windows.push(e8_core::MINIBUFFER_WINDOW);
        }
        Ok(windows.into_iter().map(Win).collect())
    }

    /// `{ window, position }`, with `start` for a drag's start.
    fn lastMouseEvent(ed) -> Option<Record> {
        Ok(ed.last_mouse_event().map(|event| {
            let record = Record::new()
                .with("window", EditorValue::Window(event.window))
                .with("position", event.position)
                .with("tabBar", ed.last_mouse_tab_bar_column());
            match event.start {
                Some((window, position)) => record.with("start", Record::new().with("window", EditorValue::Window(window)).with("position", position)),
                None => record,
            }
        }))
    }

    /// The screen line a position shows on in the selected window, where long
    /// lines are continued: where it starts and ends, and whether its line of
    /// text goes on in the next screen line. Where lines are not continued,
    /// the line of text itself.
    #[ts = "(position: number): { start: number; end: number; continued: boolean }"]
    pub fn screenLine(ed, pos: usize) -> Record {
        let (start, end, continued) = ed.screen_line(pos);
        Ok(Record::new().with("start", start).with("end", end).with("continued", continued))
    }
}
