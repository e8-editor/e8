//! Windows and frames.

use crate::EditorValue;
use crate::natives::{Fields, Frm, Opt, Record, Trm, Win, natives};

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

    /// Splits a window of the selected frame, live or internal, as
    /// window.c's split-window-internal, once window.el's split-window has
    /// worked out the sizes: the new window `pixelSize` units along the
    /// split, on `side` of `window`, with `normalSize` as its normal size.
    /// `window`, or with window-combination-resize its siblings, take the
    /// new pixel sizes set before; a new internal window holds the two
    /// unless `window`'s parent combines windows that way and
    /// window-combination-limit is not t. The new window shows `window`'s
    /// buffer, or the selected window's for an internal one.
    #[ts = "(window: WindowLike, pixelSize: number, side?: \"below\" | \"right\" | \"above\" | \"left\", normalSize?: number): Window"]
    pub fn splitWindowInternal(ed, window: Win, pixel_size: i64, side: Option<String>, normal_size: Option<f64>) -> Win {
        ed.split_window_internal(window.0, pixel_size, side.as_deref().unwrap_or("below"), normal_size).map(Win)
    }

    /// Deletes a window of the selected frame, live or internal, as
    /// window.c's delete-window-internal, once window.el's delete-window
    /// has given its siblings their new pixel sizes; fails if they do not
    /// fill their parent. If the selected window goes, the frame's first
    /// window is selected.
    #[ts = "(window: WindowLike): void"]
    pub fn deleteWindowInternal(ed, window: Win) -> () {
        ed.delete_window_internal(window.0)
    }

    /// Makes `window`, the selected one by default, fill `root`, the
    /// frame's root window by default, deleting the other windows in it,
    /// as delete-other-windows-internal.
    #[ts = "(window?: WindowLike, root?: WindowLike): void"]
    pub fn deleteOtherWindowsInternal(ed, window: Option<Win>, root: Option<Win>) -> () {
        ed.delete_other_windows_internal(window.map(|w| w.0), root.map(|w| w.0))
    }

    /// The buffer-local minor modes on in the current buffer, as local-minor-modes.
    pub fn localMinorModes(ed) -> Vec<String> {
        let global: Vec<&str> = ed.minor_modes().iter().filter(|m| m.global).map(|m| m.name.as_str()).collect();
        Ok(ed.enabled_minor_modes().into_iter().filter(|m| !global.contains(&m.as_str())).collect())
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

    /// The keys of the last key sequence read, by the command loop or
    /// readKeySequence, as they came before input-decode-map,
    /// key-translation-map and Shift translation, as
    /// this-single-command-raw-keys.
    pub fn thisSingleCommandRawKeys(ed) -> Vec<String> {
        Ok(ed.this_single_command_raw_keys().iter().map(|k| k.to_string()).collect())
    }

    /// The frame the pointer is over and the column and line it is at:
    /// what mousePosition gives before mouse-position-function.
    fn mousePosition(ed) -> EditorValue {
        let (frame, at) = ed.mouse_position();
        Ok(position_value(frame, at))
    }

    /// The frame the pointer is over and where on it in the front end's
    /// units: what mousePixelPosition gives before mouse-position-function.
    fn mousePixelPosition(ed) -> EditorValue {
        let (frame, at) = ed.mouse_pixel_position();
        Ok(position_value(frame, at))
    }

    /// Move the pointer to the middle of the character at column `x` and
    /// line `y` of a frame, from the top left of its windows, as
    /// set-mouse-position. A terminal cannot move it, and selects the frame.
    #[ts = "(frame: FrameLike, x: number, y: number): void"]
    pub fn setMousePosition(ed, frame: Frm, x: i64, y: i64) {
        ed.set_mouse_position(frame.0, x, y)
    }

    /// Move the pointer to `x` and `y` in the front end's units on a frame,
    /// from the top left of its windows, as set-mouse-pixel-position. A
    /// terminal cannot move it, and selects the frame.
    #[ts = "(frame: FrameLike, x: number, y: number): void"]
    pub fn setMousePixelPosition(ed, frame: Frm, x: i64, y: i64) {
        ed.set_mouse_pixel_position(frame.0, x, y)
    }

    /// Where the pointer is on the screen, in the front end's units, as
    /// mouse-absolute-pixel-position, or undefined if it is not known.
    #[ts = "(): [x: number, y: number] | undefined"]
    pub fn mouseAbsolutePixelPosition(ed) -> Option<Vec<i64>> {
        Ok(ed.mouse_absolute_pixel_position().map(|(x, y)| vec![x, y]))
    }

    /// Move the pointer to `x` and `y` on the screen, as
    /// set-mouse-absolute-pixel-position: only a graphical E8 can.
    pub fn setMouseAbsolutePixelPosition(ed, x: i64, y: i64) {
        ed.set_mouse_absolute_pixel_position(x, y);
        Ok(())
    }

    /// Whether the pointer shows over a frame, as frame-pointer-visible-p:
    /// always, as E8 never hides it.
    #[ts = "(frame?: FrameLike): boolean"]
    pub fn framePointerVisibleP(ed, frame: Option<Frm>) -> bool {
        let frame = frame.map_or(ed.selected_frame(), |f| f.0);
        if !ed.frame_list().contains(&frame) {
            return Err(wrong_type("frame-live-p", EditorValue::Frame(frame)));
        }
        Ok(true)
    }

    /// The window at column `x` and line `y` of a frame, the selected one
    /// by default, counted from the top left of its windows as windowEdges
    /// counts, its mode line and the minibuffer's window included, as
    /// window-at.
    #[ts = "(x: number, y: number, frame?: FrameLike): Window | undefined"]
    pub fn windowAt(ed, x: f64, y: f64, frame: Option<Frm>) -> Option<Win> {
        let frame = frame.map_or(ed.selected_frame(), |f| f.0);
        if !ed.frame_list().contains(&frame) {
            return Err(wrong_type("frame-live-p", EditorValue::Frame(frame)));
        }
        Ok(ed.window_at(x, y, frame).map(|(w, _)| Win(w)))
    }

    /// Which part of a window, the selected one by default, column `x` and
    /// line `y` of its frame are on, as coordinates-in-window-p: over its
    /// text, how far from the window's top left in columns and lines, its
    /// header line counted; else the part, or undefined if outside it.
    #[ts = "(coordinates: [x: number, y: number], window?: WindowLike): [x: number, y: number] | \"mode-line\" | \"header-line\" | \"vertical-line\" | \"left-fringe\" | \"right-fringe\" | \"left-margin\" | \"right-margin\" | undefined"]
    pub fn coordinatesInWindowP(ed, coordinates: Vec<f64>, window: Option<Win>) -> Option<EditorValue> {
        let window = live_window(ed, window)?;
        let [x, y] = coordinates[..] else {
            return Err(wrong_type("consp", EditorValue::List(coordinates.into_iter().map(EditorValue::Number).collect())));
        };
        Ok(ed.coordinates_in_window(x, y, window).map(|part| match part {
            e8_core::mouse::WindowPart::Text(x, y) => EditorValue::List(vec![EditorValue::Number(x), EditorValue::Number(y)]),
            part => EditorValue::Str(part.name().unwrap_or_default().into()),
        }))
    }

    /// Update what the mouse highlights for the pointer at `x` and `y`, as
    /// display--update-for-mouse-movement: nothing to do, as E8's front
    /// ends follow the pointer themselves.
    #[ts = "(x: number, y: number): void"]
    pub fn displayUpdateForMouseMovement(ed, x: f64, y: f64) {
        let _ = (ed, x, y);
        Ok(())
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

    /// How far a window's left edge is from its frame's, in the front
    /// end's units, as window-pixel-left.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowPixelLeft(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_pixel_left(window).unwrap_or(0))
    }

    /// How far a window's top edge is from its frame's, as window-pixel-top.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowPixelTop(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_pixel_top(window).unwrap_or(0))
    }

    /// Which column of the frame a window starts at, as window-left-column.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowLeftColumn(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_left_column(window).unwrap_or(0))
    }

    /// Which line of the frame a window starts at, as window-top-line.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowTopLine(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_top_line(window).unwrap_or(0))
    }

    /// How tall a window's tab line is, as window-tab-line-height: none,
    /// E8 having no tab lines.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowTabLineHeight(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_tab_line_height(window))
    }

    /// The width of the divider at a window's right, as
    /// window-right-divider-width: its frame's, 0 unless a parameter says
    /// otherwise.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowRightDividerWidth(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_divider_width(window, false))
    }

    /// The height of the divider at a window's foot, as
    /// window-bottom-divider-width.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowBottomDividerWidth(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_divider_width(window, true))
    }

    /// A window's fringes, as window-fringes: their widths in the front
    /// end's units, whether they go outside its margins, and whether they
    /// stay whatever buffer it shows.
    #[ts = "(window?: WindowLike | null): [left: number, right: number, outsideMargins: boolean, persistent: boolean]"]
    pub fn windowFringeWidths(ed, window: Option<Win>) -> Vec<EditorValue> {
        let window = live_window(ed, window)?;
        let (left, right, outside, persistent) = ed.window_fringe_widths(window);
        Ok(vec![
            EditorValue::Number(left as f64),
            EditorValue::Number(right as f64),
            EditorValue::Bool(outside),
            EditorValue::Bool(persistent),
        ])
    }

    /// Give a window fringes of its own, as set-window-fringes: widths in
    /// the front end's units, null for its frame's own. With `persistent`
    /// they stay whatever buffer it shows. True if they changed.
    #[ts = "(window?: WindowLike | null, left?: number | null, right?: number | null, outsideMargins?: boolean, persistent?: boolean): boolean"]
    pub fn setWindowFringes(ed, window: Option<Win>, left: Option<f64>, right: Option<f64>, outside_margins: Option<bool>, persistent: Option<bool>) -> bool {
        let window = live_window(ed, window)?;
        Ok(ed.set_window_fringes(
            window,
            left.map(|n| n.max(0.0) as f32),
            right.map(|n| n.max(0.0) as f32),
            outside_margins.unwrap_or(false),
            persistent.unwrap_or(false),
        ))
    }

    /// A window's scroll bars, as window-scroll-bars: E8 draws none, so
    /// the widths are 0 and the kinds are what setWindowScrollBars was
    /// told, as a terminal's window answers.
    #[ts = "(window?: WindowLike | null): [width: number, vertical: Value, verticalPersistent: boolean, height: number, horizontal: Value, horizontalPersistent: boolean]"]
    pub fn windowScrollBars(ed, window: Option<Win>) -> Vec<EditorValue> {
        let window = live_window(ed, window)?;
        let (width, vertical, vp, height, horizontal, hp) = ed.window_scroll_bars(window);
        Ok(vec![
            EditorValue::Number(width as f64),
            vertical.unwrap_or(EditorValue::Null),
            EditorValue::Bool(vp),
            EditorValue::Number(height as f64),
            horizontal.unwrap_or(EditorValue::Null),
            EditorValue::Bool(hp),
        ])
    }

    /// Say what a window's scroll bars should be, as
    /// set-window-scroll-bars. E8 draws none, so this is remembered and
    /// given back; true if what was remembered changed.
    #[ts = "(window?: WindowLike | null, width?: number | null, vertical?: Value, height?: number | null, horizontal?: Value): boolean"]
    pub fn setWindowScrollBars(ed, window: Option<Win>, width: Option<f64>, vertical: EditorValue, height: Option<f64>, horizontal: EditorValue) -> bool {
        let window = live_window(ed, window)?;
        let (_, _) = (width, height);
        Ok(ed.set_window_scroll_bars(window, vertical, horizontal))
    }

    /// The buffer a window showed at the last redisplay, as
    /// window-old-buffer; undefined before the first.
    #[ts = "(window?: WindowLike | null): string | undefined"]
    pub fn windowOldBuffer(ed, window: Option<Win>) -> Option<String> {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_buffer(window))
    }

    /// Where point was in a window at the last redisplay, as window-old-point.
    #[ts = "(window?: WindowLike | null): number | undefined"]
    pub fn windowOldPoint(ed, window: Option<Win>) -> Option<usize> {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_point(window))
    }

    /// How wide a window was at the last redisplay, in the front end's
    /// units, as window-old-pixel-width.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowOldPixelWidth(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_sizes(window).map_or(0, |(pixel, _)| pixel.0))
    }

    /// How tall it was, as window-old-pixel-height.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowOldPixelHeight(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_sizes(window).map_or(0, |(pixel, _)| pixel.1))
    }

    /// How wide its text area was, as window-old-body-pixel-width.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowOldBodyPixelWidth(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_sizes(window).map_or(0, |(_, body)| body.0))
    }

    /// How tall its text area was, as window-old-body-pixel-height.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowOldBodyPixelHeight(ed, window: Option<Win>) -> usize {
        let window = live_window(ed, window)?;
        Ok(ed.window_old_sizes(window).map_or(0, |(_, body)| body.1))
    }

    /// The window selected at the last redisplay, as old-selected-window.
    pub fn oldSelectedWindow(ed) -> Option<Win> {
        Ok(ed.old_selected_window().map(Win))
    }

    /// A frame's selected window at the last redisplay, as
    /// frame-old-selected-window.
    #[ts = "(frame?: FrameLike | null): Window | undefined"]
    pub fn frameOldSelectedWindow(ed, frame: Option<Frm>) -> Option<Win> {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_old_selected_window(frame).map(Win))
    }

    /// Every terminal there is, as terminal-list: E8 draws through one
    /// front end, so there is one.
    pub fn terminalList(ed) -> Vec<Trm> {
        Ok(ed.terminal_list().into_iter().map(Trm).collect())
    }

    /// What kind of display a terminal is, as terminal-live-p: "ns", "x"
    /// or "w32" in a window, true on a terminal, undefined once it has
    /// been deleted or for anything that is no terminal.
    #[ts = "(terminal?: Terminal | FrameLike | null): true | \"ns\" | \"x\" | \"w32\" | undefined"]
    pub fn terminalLiveP(ed, terminal: EditorValue) -> Option<EditorValue> {
        let Some(terminal) = terminal_of(ed, &terminal) else { return Ok(None) };
        Ok(ed.terminal_live_p(terminal))
    }

    /// The terminal a frame is shown on, as frame-terminal.
    #[ts = "(frame?: FrameLike | null): Terminal"]
    pub fn frameTerminal(ed, frame: Option<Frm>) -> Trm {
        let frame = live_frame(ed, frame)?;
        Ok(Trm(ed.frame_terminal(frame)))
    }

    /// The device a terminal draws on, as terminal-name: a tty's name
    /// where the front end knows one.
    #[ts = "(terminal?: Terminal | FrameLike | null): string | undefined"]
    pub fn terminalName(ed, terminal: Option<Trm>) -> Option<String> {
        ed.terminal_name(terminal_arg(ed, terminal))
    }

    /// Every parameter of a terminal, as terminal-parameters.
    #[ts = "(terminal?: Terminal | FrameLike | null): { [name: string]: Value }"]
    pub fn terminalParameters(ed, terminal: Option<Trm>) -> Record {
        let mut record = Record::new();
        for (name, value) in ed.terminal_parameters(terminal_arg(ed, terminal))? {
            record = record.with(name, value);
        }
        Ok(record)
    }

    /// One parameter of a terminal, as terminal-parameter.
    #[ts = "(terminal: Terminal | FrameLike | undefined | null, name: string): Value | undefined"]
    pub fn terminalParameter(ed, terminal: Option<Trm>, name: String) -> Option<EditorValue> {
        ed.terminal_parameter(terminal_arg(ed, terminal), &name)
    }

    /// Set one, as set-terminal-parameter, and give back what it was.
    #[ts = "(terminal: Terminal | FrameLike | undefined | null, name: string, value: Value): Value | undefined"]
    pub fn setTerminalParameter(ed, terminal: Option<Trm>, name: String, value: EditorValue) -> Option<EditorValue> {
        {
        let terminal = terminal_arg(ed, terminal);
        ed.set_terminal_parameter(terminal, &name, value)
    }
    }

    /// Delete a terminal, as delete-terminal. E8 has one, so this is
    /// refused unless `force` says otherwise, as Emacs refuses to delete
    /// the sole active display terminal; forced, the editor has nothing
    /// to draw on and asks to exit.
    #[ts = "(terminal?: Terminal | FrameLike | null, force?: boolean): void"]
    pub fn deleteTerminal(ed, terminal: Option<Trm>, force: Option<bool>) {
        {
        let terminal = terminal_arg(ed, terminal);
        ed.delete_terminal(terminal, force.unwrap_or(false))
    }
    }

    /// What TERM says a terminal is, as tty-type; undefined in a window.
    #[ts = "(terminal?: Terminal | FrameLike | null): string | undefined"]
    pub fn ttyType(ed, terminal: Option<Trm>) -> Option<String> {
        ed.tty_type(terminal_arg(ed, terminal))
    }

    /// Whether a terminal shows colours, as tty-display-color-p; false in
    /// a window, which is no text terminal.
    #[ts = "(terminal?: Terminal | FrameLike | null): boolean"]
    pub fn ttyDisplayColorP(ed, terminal: Option<Trm>) -> bool {
        ed.tty_display_color_p(terminal_arg(ed, terminal))
    }

    /// How many colours a terminal shows, as tty-display-color-cells; 0
    /// in a window.
    #[ts = "(terminal?: Terminal | FrameLike | null): number"]
    pub fn ttyDisplayColorCells(ed, terminal: Option<Trm>) -> usize {
        ed.tty_display_color_cells(terminal_arg(ed, terminal))
    }

    /// Whether a terminal is the one the editor was started from, as
    /// controlling-tty-p; false in a window.
    #[ts = "(terminal?: Terminal | FrameLike | null): boolean"]
    pub fn controllingTtyP(ed, terminal: Option<Trm>) -> bool {
        ed.controlling_tty_p(terminal_arg(ed, terminal))
    }

    /// Let go of a terminal, as suspend-tty: the editor stops, as
    /// suspend-emacs stops it, and its frames are left as they are. True
    /// if it was not let go of already.
    #[ts = "(terminal?: Terminal | FrameLike | null): boolean"]
    pub fn suspendTty(ed, terminal: Option<Trm>) -> bool {
        {
        let terminal = terminal_arg(ed, terminal);
        ed.suspend_tty(terminal)
    }
    }

    /// Take a terminal back, as resume-tty. True if it had been let go of.
    #[ts = "(terminal?: Terminal | FrameLike | null): boolean"]
    pub fn resumeTty(ed, terminal: Option<Trm>) -> bool {
        {
        let terminal = terminal_arg(ed, terminal);
        ed.resume_tty(terminal)
    }
    }

    /// Make a frame on a terminal, as make-terminal-frame: E8 has one
    /// terminal, so this is makeFrame with its parameters.
    #[ts = "(parameters?: { [name: string]: Value } | null): Frame"]
    pub fn makeTerminalFrame(ed, parameters: Option<Fields>) -> Frm {
        let was = ed.selected_frame();
        let frame = ed.make_frame(None)?;
        let mut named: Vec<(String, EditorValue)> = parameters.map(|p| p.0.into_iter().collect()).unwrap_or_default();
        // The terminal's own parameters, as Fmake_terminal_frame stores
        // them, under what the caller gave.
        for (name, value) in [
            ("tty".to_string(), ed.terminal_name(e8_core::THE_TERMINAL)?.map_or(EditorValue::Null, EditorValue::Str)),
            ("tty-type".to_string(), ed.tty_type(e8_core::THE_TERMINAL)?.map_or(EditorValue::Null, EditorValue::Str)),
            ("minibuffer".to_string(), EditorValue::Bool(true)),
        ] {
            if !named.iter().any(|(n, _)| *n == name) {
                named.push((name, value));
            }
        }
        ed.modify_frame_parameters(frame, &named)?;
        // Made, not selected, as Fmake_terminal_frame leaves it.
        ed.select_frame(was)?;
        Ok(Frm(frame))
    }

    /// Every parameter of a frame, the selected frame's by default, as
    /// frame-parameters: those set on it and those the editor works out,
    /// as an object by name.
    #[ts = "(frame?: FrameLike | null): { [name: string]: Value }"]
    pub fn frameParameters(ed, frame: Option<Frm>) -> Record {
        let frame = live_frame(ed, frame)?;
        let mut record = Record::new();
        for (name, value) in ed.frame_parameters(frame) {
            record = record.with(name, value);
        }
        Ok(record)
    }

    /// Set several of a frame's parameters at once, as
    /// modify-frame-parameters.
    #[ts = "(frame: FrameLike | undefined | null, parameters: { [name: string]: Value }): void"]
    pub fn modifyFrameParameters(ed, frame: Option<Frm>, parameters: Fields) {
        let frame = live_frame(ed, frame)?;
        let named: Vec<(String, EditorValue)> = parameters.0.into_iter().collect();
        ed.modify_frame_parameters(frame, &named)
    }

    /// The width of a frame's text area, the part its windows divide, in
    /// the front end's units, as frame-text-width.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameTextWidth(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_text_size(frame).0)
    }

    /// The height of a frame's text area, in the front end's units, as
    /// frame-text-height.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameTextHeight(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_text_size(frame).1)
    }

    /// The width of the whole frame, its border and bars included, in the
    /// front end's units, as frame-native-width; a terminal's is its columns.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameNativeWidth(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_native_size(frame).0)
    }

    /// The height of the whole frame, in the front end's units, as
    /// frame-native-height.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameNativeHeight(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_native_size(frame).1)
    }

    /// How many columns a frame has, as frame-total-cols.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameTotalCols(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_width(frame))
    }

    /// How many lines a frame has, its echo area left out, as frame-total-lines.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameTotalLines(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.units_to_cells(ed.frame_text_size(frame).1 as f32, false))
    }

    /// Where a frame's top left corner is on the screen, in the front
    /// end's units, as frame-position; [0, 0] on a terminal.
    #[ts = "(frame?: FrameLike | null): [left: number, top: number]"]
    pub fn framePosition(ed, frame: Option<Frm>) -> Vec<f64> {
        let frame = live_frame(ed, frame)?;
        let (x, y) = ed.frame_position(frame);
        Ok(vec![x as f64, y as f64])
    }

    /// Ask the front end to put a frame's top left corner there, as
    /// set-frame-position. A terminal cannot move itself and does nothing.
    #[ts = "(frame: FrameLike | undefined | null, x: number, y: number): void"]
    pub fn setFramePosition(ed, frame: Option<Frm>, x: f64, y: f64) {
        let frame = live_frame(ed, frame)?;
        ed.request_frame_position(frame, x, y)
    }

    /// Ask the front end to make a frame's text area this many columns
    /// and lines, as set-frame-size; with `pixelwise`, in the front end's
    /// units. A terminal cannot resize itself and does nothing.
    #[ts = "(frame: FrameLike | undefined | null, width: number, height: number, pixelwise?: boolean): void"]
    pub fn setFrameSize(ed, frame: Option<Frm>, width: f64, height: f64, pixelwise: Option<bool>) {
        let frame = live_frame(ed, frame)?;
        ed.request_frame_size(frame, width, height, pixelwise.unwrap_or(false))
    }

    /// Ask the front end to make a frame this many columns wide, as
    /// set-frame-width; `pretend` is taken and set aside, as it is for a
    /// terminal Emacs is not drawing on.
    #[ts = "(frame: FrameLike | undefined | null, width: number, pretend?: boolean | null, pixelwise?: boolean): void"]
    pub fn setFrameWidth(ed, frame: Option<Frm>, width: f64, pretend: Option<bool>, pixelwise: Option<bool>) {
        let (frame, _) = (live_frame(ed, frame)?, pretend);
        let pixelwise = pixelwise.unwrap_or(false);
        let height = if pixelwise { ed.frame_text_size(frame).1 as f64 } else { ed.units_to_cells(ed.frame_text_size(frame).1 as f32, false) as f64 };
        ed.request_frame_size(frame, width, height, pixelwise)
    }

    /// Ask the front end to make a frame this many lines tall, as set-frame-height.
    #[ts = "(frame: FrameLike | undefined | null, height: number, pretend?: boolean | null, pixelwise?: boolean): void"]
    pub fn setFrameHeight(ed, frame: Option<Frm>, height: f64, pretend: Option<bool>, pixelwise: Option<bool>) {
        let (frame, _) = (live_frame(ed, frame)?, pretend);
        let pixelwise = pixelwise.unwrap_or(false);
        let width = if pixelwise { ed.frame_text_size(frame).0 as f64 } else { ed.frame_width(frame) as f64 };
        ed.request_frame_size(frame, width, height, pixelwise)
    }

    /// How many of the screen's own pixels one of the front end's units
    /// is, as frame-scale-factor.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameScaleFactor(ed, frame: Option<Frm>) -> f64 {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_scale_factor(frame))
    }

    /// The width of the border a frame draws around its windows, as
    /// frame-internal-border-width; none in E8.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameInternalBorderWidth(ed, frame: Option<Frm>) -> usize {
        let _ = live_frame(ed, frame)?;
        Ok(ed.frame_internal_border_width())
    }

    /// The width of a window's two fringes together, as frame-fringe-width:
    /// none on a terminal.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameFringeWidth(ed, frame: Option<Frm>) -> usize {
        let _ = live_frame(ed, frame)?;
        Ok(ed.frame_fringe_width())
    }

    /// The width of a frame's scroll bars, as frame-scroll-bar-width: none,
    /// E8 drawing no scroll bars.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameScrollBarWidth(ed, frame: Option<Frm>) -> usize {
        let _ = live_frame(ed, frame)?;
        Ok(ed.frame_scroll_bar_width())
    }

    /// The height of a frame's horizontal scroll bars, as
    /// frame-scroll-bar-height: none.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameScrollBarHeight(ed, frame: Option<Frm>) -> usize {
        let _ = live_frame(ed, frame)?;
        Ok(ed.frame_scroll_bar_height())
    }

    /// The width of the divider between windows side by side, as
    /// frame-right-divider-width: a column on a terminal, none in a window.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameRightDividerWidth(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_divider_width(frame, false))
    }

    /// The height of the divider below a window, as
    /// frame-bottom-divider-width: none, a mode line standing between them.
    #[ts = "(frame?: FrameLike | null): number"]
    pub fn frameBottomDividerWidth(ed, frame: Option<Frm>) -> usize {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_divider_width(frame, true))
    }

    /// The width of a child frame's border, as
    /// frame-child-frame-border-width: none, E8 having no child frames.
    #[ts = "(frame?: FrameLike | null): number | undefined"]
    pub fn frameChildFrameBorderWidth(ed, frame: Option<Frm>) -> Option<usize> {
        let _ = live_frame(ed, frame)?;
        Ok(None)
    }

    /// Send a frame's keys to another, as redirect-frame-focus; with no
    /// second frame, it has its own keys again.
    #[ts = "(frame?: FrameLike | null, to?: FrameLike | null): void"]
    pub fn redirectFrameFocus(ed, frame: Option<Frm>, to: Option<Frm>) {
        let frame = frame.map_or(ed.selected_frame(), |f| f.0);
        ed.redirect_frame_focus(frame, to.map(|f| f.0))
    }

    /// Where a frame's keys go, as frame-focus, or undefined where they
    /// are its own.
    #[ts = "(frame?: FrameLike | null): Frame | undefined"]
    pub fn frameFocus(ed, frame: Option<Frm>) -> Option<Frm> {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_focus(frame).map(Frm))
    }

    /// Put a frame behind the others, as lower-frame.
    #[ts = "(frame?: FrameLike | null): void"]
    pub fn lowerFrame(ed, frame: Option<Frm>) {
        let frame = live_frame(ed, frame)?;
        ed.lower_frame(frame)
    }

    /// The frame that was selected before this one, as old-selected-frame.
    pub fn oldSelectedFrame(ed) -> Option<Frm> {
        Ok(ed.old_selected_frame().map(Frm))
    }

    /// Whether a frame's window state change flag is set, as
    /// frame-window-state-change.
    #[ts = "(frame?: FrameLike | null): boolean"]
    pub fn frameWindowStateChange(ed, frame: Option<Frm>) -> bool {
        let frame = live_frame(ed, frame)?;
        Ok(ed.frame_window_state_change(frame))
    }

    /// Set or clear that flag, as set-frame-window-state-change.
    #[ts = "(frame?: FrameLike | null, changed?: boolean): boolean"]
    pub fn setFrameWindowStateChange(ed, frame: Option<Frm>, changed: Option<bool>) -> bool {
        let frame = live_frame(ed, frame)?;
        let changed = changed.unwrap_or(false);
        ed.set_frame_window_state_change(frame, changed)?;
        Ok(changed)
    }

    /// Whether a frame is an ancestor of another, as frame-ancestor-p:
    /// never, E8 having no child frames.
    #[ts = "(ancestor?: FrameLike | null, descendant?: FrameLike | null): boolean"]
    pub fn frameAncestorP(ed, ancestor: Option<Frm>, descendant: Option<Frm>) -> bool {
        let (ancestor, descendant) = (live_frame(ed, ancestor)?, live_frame(ed, descendant)?);
        Ok(ed.frame_ancestor_p(ancestor, descendant))
    }

    /// What a geometry string says, as x-parse-geometry: "80x24+10-20"
    /// gives its width, height and place, one counted from the other edge
    /// as ["-", N].
    #[ts = "(spec: string): { [name: string]: Value }"]
    pub fn xParseGeometry(ed, spec: String) -> Record {
        let _ = ed;
        let mut record = Record::new();
        for (name, value) in e8_core::parse_geometry(&spec) {
            record = record.with(name, value);
        }
        Ok(record)
    }

    /// What the display's resource database says, as x-get-resource:
    /// nothing, E8 reading none.
    #[ts = "(attribute: string, klass: string): string | undefined"]
    pub fn xGetResource(ed, attribute: String, klass: String) -> Option<String> {
        let (_, _, _) = (ed, attribute, klass);
        Ok(None)
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

    /// How many columns a window, the selected one by default, is scrolled
    /// to the left, as window-hscroll.
    #[ts = "(window?: WindowLike | null): number"]
    pub fn windowHscroll(ed, window: Option<Win>) -> usize {
        Ok(ed.window_hscroll(live_window(ed, window)?))
    }

    /// Scrolls a window, the selected one by default, `columns` to the
    /// left, as set-window-hscroll: a negative number is 0. Redisplay
    /// leaves it until point moves, then scrolls to keep point in sight as
    /// auto-hscroll-mode says. Gives the scroll.
    #[ts = "(window: WindowLike | null | undefined, columns: number): number"]
    pub fn setWindowHscroll(ed, window: Option<Win>, columns: i64) -> usize {
        let id = live_window(ed, window)?;
        Ok(ed.set_window_hscroll(id, columns))
    }

    /// How far a window, the selected one by default, is scrolled up past
    /// the top of its first row, as window-vscroll: in the frame's lines, or with `pixelsP` in the front end's units. Always 0
    /// on a terminal.
    #[ts = "(window?: WindowLike | null, pixelsP?: boolean | null): number"]
    pub fn windowVscroll(ed, window: Option<Win>, pixels: Option<bool>) -> f64 {
        let window = live_window(ed, window)?;
        let units = ed.window_vscroll(window) as f64;
        Ok(if pixels == Some(true) { units } else { units / ed.text_metrics().char_height() as f64 })
    }

    /// Scrolls a window, the selected one by default, up past the top of
    /// its first row, as set-window-vscroll: by `vscroll` of the frame's
    /// lines, or with `pixelsP` the front end's units. A
    /// negative amount is 0, and on a terminal it does nothing. Lasts until
    /// the window starts elsewhere. Gives the scroll, as windowVscroll.
    /// `preserveVscrollP` is accepted as in Emacs; E8's minibuffer never
    /// freezes a window's start.
    #[ts = "(window: WindowLike | null | undefined, vscroll: number, pixelsP?: boolean | null, preserveVscrollP?: boolean | null): number"]
    pub fn setWindowVscroll(ed, window: Option<Win>, vscroll: f64, pixels: Option<bool>, preserve: Option<bool>) -> f64 {
        let _ = preserve;
        let window = live_window(ed, window)?;
        let height = ed.text_metrics().char_height() as f64;
        let units = if pixels == Some(true) { vscroll } else { vscroll * height };
        let set = ed.set_window_vscroll(window, units as f32) as f64;
        Ok(if pixels == Some(true) { set } else { set / height })
    }

    /// Moves point `lines` screen lines down, or up if negative, to the
    /// start of the screen line, as vertical-motion, as `window` (the
    /// selected one by default) lays out the current buffer. Given as
    /// `[cols, lines]`, it stops at that column of the line instead,
    /// counted from what shows at the window's left edge. Past the end of
    /// the buffer point goes to the end. Gives how many lines it moved.
    /// `curCol`, Emacs's hint of point's column, is not needed.
    #[ts = "(lines: number | [cols: number, lines: number], window?: WindowLike | null, curCol?: number | null): number"]
    pub fn verticalMotion(ed, lines: EditorValue, window: Option<Win>, cur_col: Option<f64>) -> i64 {
        let _ = cur_col;
        let window = live_window(ed, window)?;
        let (cols, lines) = match &lines {
            EditorValue::Number(n) if n.fract() == 0.0 => (None, *n),
            EditorValue::List(pair) if pair.len() == 2 => match (pair[0].as_number(), pair[1].as_number()) {
                (Some(cols), Some(lines)) if lines.fract() == 0.0 => (Some(cols), lines),
                _ => return Err(wrong_type("numberp", lines.clone())),
            },
            _ => return Err(wrong_type("fixnump", lines.clone())),
        };
        Ok(ed.vertical_motion(lines as i64, cols, window))
    }

    /// compute-motion, wrapped by the prelude, which passes the two places
    /// as one array, as natives take at most six arguments.
    fn computeMotion(ed, from: usize, places: Vec<f64>, to: usize, width: Option<f64>, offsets: Option<Vec<f64>>, window: Option<Win>) -> EditorValue {
        let window = live_window(ed, window)?;
        let pair = |v: &[f64]| (v.first().copied().unwrap_or(0.0) as i64, v.get(1).copied().unwrap_or(0.0) as i64);
        let offsets = offsets.as_deref().map_or((0, 0), pair);
        if offsets.0 < 0 || offsets.1 < 0 {
            return Err(e8_core::Error::signal("args-out-of-range", "Args out of range", vec![EditorValue::Number(offsets.0 as f64), EditorValue::Number(offsets.1 as f64)]));
        }
        let from_pos = pair(places.get(..2).unwrap_or(&[]));
        let to_pos = (places.len() >= 4).then(|| pair(&places[2..]));
        let m = ed.compute_motion(from, from_pos, to, to_pos, width.map(|w| w as i64), offsets, window)?;
        Ok(EditorValue::List(vec![
            EditorValue::Number(m.pos as f64),
            EditorValue::Number(m.hpos as f64),
            EditorValue::Number(m.vpos as f64),
            EditorValue::Number(m.prev_hpos as f64),
            EditorValue::Bool(m.continued),
        ]))
    }

    /// How wide the selected window's line numbers are, as
    /// line-number-display-width: in digits; with "columns", in columns with
    /// the space either side; with any other true value, in the front
    /// end's units.
    #[ts = "(pixelwise?: \"columns\" | boolean | null): number"]
    pub fn lineNumberDisplayWidth(ed, pixelwise: EditorValue) -> f64 {
        let (digits, columns, pixels) = ed.line_number_display_width();
        Ok(match &pixelwise {
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "columns" => columns,
            v if v.is_true() => pixels,
            _ => digits as f64,
        })
    }

    /// The height of a line of a window, the selected one by default, as
    /// window-line-height: [height, row, top, cut off at the bottom], in the
    /// front end's units below the first text row. `line` is point's row
    /// by default, a text row from 0 (from the bottom if negative),
    /// "header-line" or "mode-line". Undefined if there is no such line.
    #[ts = "(line?: number | \"header-line\" | \"mode-line\" | null, window?: WindowLike | null): [number, number, number, number] | undefined"]
    pub fn windowLineHeight(ed, line: EditorValue, window: Option<Win>) -> Option<Vec<f64>> {
        let window = live_window(ed, window)?;
        let line = match &line {
            EditorValue::Null | EditorValue::Bool(false) => e8_core::WindowLine::Point,
            EditorValue::Number(n) => e8_core::WindowLine::Text(*n as i64),
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "header-line" => e8_core::WindowLine::HeaderLine,
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "mode-line" => e8_core::WindowLine::ModeLine,
            // E8 has no tab lines.
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "tab-line" => return Ok(None),
            _ => return Err(wrong_type("fixnump", line.clone())),
        };
        Ok(ed.window_line_height(window, line).map(|v| v.to_vec()))
    }

    /// Where each line of a window, the selected one by default, ends, as
    /// window-lines-pixel-dimensions: for each row from `first` to `last`,
    /// [the right edge of its last character from the window's left, its
    /// bottom], in the front end's units, or with `inverse` the space right
    /// of the character, or with `left` its first character's left edge.
    /// With `body`, bottoms are from the top of the text and rows the text's
    /// bottom cuts off are left out; without, from the window's top, and
    /// rows the window's bottom cuts off. Rows past the end of the text
    /// are empty. A header line is not one of the rows.
    #[ts = "(window?: WindowLike | null, first?: number | null, last?: number | null, body?: boolean | null, inverse?: boolean | null, left?: boolean | null): [number, number][] | undefined"]
    pub fn windowLinesPixelDimensions(ed, window: Option<Win>, first: Option<usize>, last: Option<usize>, body: Option<bool>, inverse: Option<bool>, left: Option<bool>) -> Option<EditorValue> {
        let window = live_window(ed, window)?;
        Ok(ed.window_lines_pixel_dimensions(window, first, last, body == Some(true), inverse == Some(true), left == Some(true)).map(|rows| {
            EditorValue::List(rows.into_iter().map(|(x, y)| EditorValue::List(vec![EditorValue::Number(x), EditorValue::Number(y)])).collect())
        }))
    }

    /// Makes the next redisplay draw a window, a frame or every frame
    /// afresh, as force-window-update. E8 draws every window afresh each
    /// time, so it has nothing to do.
    #[ts = "(object?: WindowLike | Frame | BufferLike | null): void"]
    pub fn forceWindowUpdate(ed, object: EditorValue) {
        let _ = (ed, object);
        Ok(())
    }

    /// Runs window-scroll-functions for a window, the selected one by
    /// default, with its start, as run-window-scroll-functions.
    #[ts = "(window?: WindowLike | null): void"]
    pub fn runWindowScrollFunctions(ed, window: Option<Win>) {
        let window = live_window(ed, window)?;
        ed.run_window_scroll_functions(window);
        Ok(())
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
        let _ = frame;
        Ok(ed.window_system().map(str::to_string))
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

    /// A window's new pixel size, as window.el sets it before
    /// window-resize-apply: window-new-pixel; its height until one is set.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowNewPixel(ed, window: Option<Win>) -> i64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        ed.window_new_pixel(id).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// Sets a window's new pixel size, or with `add` adds to it, as set-window-new-pixel; gives the new size.
    #[ts = "(window: WindowLike, size: number, add?: boolean): number"]
    pub fn setWindowNewPixel(ed, window: Win, size: i64, add: Option<bool>) -> i64 {
        ed.set_window_new_pixel(window.0, size, add.unwrap_or(false))
    }

    /// A window's new total size in lines or columns, as window-new-total.
    #[ts = "(window?: WindowLike): number"]
    pub fn windowNewTotal(ed, window: Option<Win>) -> i64 {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        ed.window_new_total(id).ok_or_else(|| e8_core::Error::new("No such window"))
    }

    /// Sets a window's new total size, or with `add` adds to it, as set-window-new-total; gives the new size.
    #[ts = "(window: WindowLike, size: number, add?: boolean): number"]
    pub fn setWindowNewTotal(ed, window: Win, size: i64, add: Option<bool>) -> i64 {
        ed.set_window_new_total(window.0, size, add.unwrap_or(false))
    }

    /// A window's new normal size, as window-new-normal: undefined once cleared.
    #[ts = "(window?: WindowLike): number | undefined"]
    pub fn windowNewNormal(ed, window: Option<Win>) -> Option<f64> {
        let id = window.map_or(ed.selected_window(), |w| w.0);
        Ok(ed.window_new_normal(id))
    }

    /// Sets a window's new normal size, or clears it with none, as set-window-new-normal.
    #[ts = "(window: WindowLike, size?: number): void"]
    pub fn setWindowNewNormal(ed, window: Win, size: Option<f64>) -> () {
        ed.set_window_new_normal(window.0, size)
    }

    /// Gives a frame's windows their new pixel sizes, heights or with
    /// `horizontal` widths, and their new normal sizes, as
    /// window-resize-apply, if each combination's children add up to it;
    /// says whether they did.
    #[ts = "(frame?: FrameLike, horizontal?: boolean): boolean"]
    pub fn windowResizeApply(ed, frame: Option<Frm>, horizontal: Option<bool>) -> bool {
        let frame = frame.map_or(ed.selected_frame(), |f| f.0);
        Ok(ed.window_resize_apply(frame, horizontal.unwrap_or(false)))
    }

    /// Applies new total sizes, as window-resize-apply-total. E8 works out
    /// total sizes from pixel sizes, which window-resize-apply has given,
    /// so this has nothing left to do and says so with true.
    #[ts = "(frame?: FrameLike, horizontal?: boolean): boolean"]
    pub fn windowResizeApplyTotal(ed, frame: Option<Frm>, horizontal: Option<bool>) -> bool {
        let _ = (frame, horizontal);
        Ok(true)
    }

    /// A column's width and a line's height in the front end's units, the
    /// default font's, as frame-char-width and frame-char-height.
    #[ts = "(): [width: number, height: number]"]
    pub fn frameCharSize(ed) -> Vec<f64> {
        let (w, h) = ed.cell();
        Ok(vec![w as f64, h as f64])
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

/// A window given, or the selected one, if it is live; else the error
/// Emacs's decode_live_window signals.
/// The terminal a value names, or none where it names no live terminal:
/// a terminal, a frame on it, or nothing for the one there is.
fn terminal_of(ed: &e8_core::Editor, value: &EditorValue) -> Option<e8_core::TerminalId> {
    match value {
        EditorValue::Null => Some(e8_core::THE_TERMINAL),
        other => Trm::from_value(other).and_then(|t| ed.terminal_named(t.0)),
    }
}

/// The terminal a native was given, the one there is by default, which
/// may be named by a frame on it.
fn terminal_arg(ed: &e8_core::Editor, terminal: Option<Trm>) -> e8_core::TerminalId {
    let named = terminal.map_or(e8_core::THE_TERMINAL, |t| t.0);
    // A frame's number stands for the terminal it is on; one that is on
    // none keeps its number, which the editor then refuses.
    ed.terminal_named(named).unwrap_or(named)
}

/// A frame given to a native, the selected one by default, checked live.
fn live_frame(ed: &e8_core::Editor, frame: Option<Frm>) -> Result<e8_core::FrameId, e8_core::Error> {
    let id = frame.map_or(ed.selected_frame(), |f| f.0);
    if !ed.frame_list().contains(&id) {
        return Err(e8_core::Error::signal("wrong-type-argument", "Not a live frame", vec![EditorValue::Symbol("frame-live-p".into()), EditorValue::Frame(id)]));
    }
    Ok(id)
}

fn live_window(ed: &e8_core::Editor, window: Option<Win>) -> Result<e8_core::WindowId, e8_core::Error> {
    let id = window.map_or(ed.selected_window(), |w| w.0);
    if ed.window_frame(id).is_none() || ed.window_internal_p(id) {
        return Err(e8_core::Error::signal("wrong-type-argument", "Not a live window", vec![EditorValue::Symbol("window-live-p".into()), EditorValue::Window(id)]));
    }
    Ok(id)
}

/// The error Emacs signals for an argument of the wrong type.
fn wrong_type(predicate: &str, value: EditorValue) -> e8_core::Error {
    e8_core::Error::signal("wrong-type-argument", "Wrong type argument", vec![EditorValue::Symbol(predicate.into()), value])
}

/// A frame and a place on it, or nothing known, as mouse-position gives
/// them: `[frame, x, y]`.
fn position_value(frame: e8_core::FrameId, at: Option<(i64, i64)>) -> EditorValue {
    let (x, y) = match at {
        Some((x, y)) => (EditorValue::Number(x as f64), EditorValue::Number(y as f64)),
        None => (EditorValue::Null, EditorValue::Null),
    };
    EditorValue::List(vec![EditorValue::Frame(frame), x, y])
}
