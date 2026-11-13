use std::collections::BTreeMap;
use crate::vfs as fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::buffer::Buffer;
use crate::command::{Arg, Command, ParamKind, PromptFn};
use crate::commands;
use crate::error::{Error, Result};
use crate::files::{abbreviate_dir, expand_file_name};
use crate::key::{Key, KeyCode, MouseKind, format_keys};
use crate::keymap::{KeymapId, Keymaps, Lookup};
use crate::faces::{self, Face};
use crate::modes::MinorMode;
use crate::variables::{self, Value, Variable};
use crate::prefix::{PrefixArg, prefix_numeric_value};

/// A minibuffer prompt waiting for the user to type an argument.
pub(crate) struct Prompt {
    pub(crate) text: String,
    pub(crate) kind: ParamKind,
    /// The variable with earlier answers.
    pub(crate) history: String,
    /// How far back in the history M-p has gone: 0 for the input typed.
    pub(crate) history_pos: usize,
    /// The input typed, kept while M-p shows history.
    pub(crate) typed: String,
    /// The names a `completing-read` completes against, instead of the kind's.
    pub(crate) collection: Option<Vec<String>>,
    /// A function of the input that gives `collection` afresh after each
    /// command, as Emacs's completion-table-dynamic makes a table.
    pub(crate) collection_fn: Option<variables::Function>,
    /// The collection's completion category, as Emacs's metadata names it.
    pub(crate) category: Option<String>,
    /// Whether the answer must be one of the completions.
    pub(crate) require_match: bool,
    /// What empty input stands for.
    pub(crate) default: Option<String>,
    /// The input the prompt opened with.
    pub(crate) initial: String,
    /// Where the answer goes, for a prompt opened partway through a command
    /// that waits for it; a command's arguments have none.
    pub(crate) answer: Option<AnswerSlot>,
    /// The sorted completions and their base, for the input they were made for.
    pub(crate) sorted: Option<(String, String, Vec<String>)>,
    /// Which prompt this is, of all opened: see [`Editor::waiting_for_input`].
    pub(crate) serial: u64,
}

/// What a command waiting for input waits for, as an answer having come.
pub type WaitDone = Rc<dyn Fn(&Editor) -> bool>;

/// Where a prompt, question, key read or recursive edit puts its outcome
/// for the command waiting on it: the answer, or the error that ended it,
/// `quit` when it was quit.
pub(crate) type AnswerSlot = Rc<std::cell::RefCell<Option<Result<Value>>>>;

/// What a waiting command reads from where no command loop runs; false
/// when it has nothing more.
pub(crate) type InputSource = Box<dyn FnMut(&mut Editor) -> bool>;

/// What a command had when it asked a question or opened a prompt: the
/// current buffer, its prefix argument and its name, which are its again
/// once the wait is over, as an Emacs command carries on after
/// `read-from-minibuffer` returns, its `current-prefix-arg` and
/// `this-command` still bound.
#[derive(Clone)]
pub struct Resume {
    buffer: u64,
    prefix: Option<PrefixArg>,
    command: Option<String>,
    /// The command before it, which it still sees as last-command, as an
    /// Emacs command that waits for an answer does.
    last_command: Option<String>,
}

/// A message as *Messages* logs it.
#[derive(Clone, Debug, PartialEq)]
pub struct LoggedMessage {
    pub text: String,
    /// How many times it was shown in a row.
    pub count: usize,
    /// Whether it was a command's error.
    pub error: bool,
}

impl LoggedMessage {
    /// The line *Messages* shows for it.
    pub fn shown(&self) -> String {
        if self.count == 1 { self.text.clone() } else { format!("{} [{} times]", self.text, self.count) }
    }
}

/// A command as it last ran, so it can be repeated (Emacs's
/// `last-repeatable-command`, with the arguments and key it ran with).
#[derive(Clone)]
struct Repeatable {
    command: Rc<Command>,
    args: Vec<Arg>,
    prefix: Option<PrefixArg>,
    key: Option<Key>,
}

/// Commands that Emacs groups into one undo step when repeated (those that
/// call `undo-auto-amalgamate`).
/// Commands whose runs share an undo step, as Emacs's undo-auto-amalgamate
/// gives them: typing and deleting, and the commands that insert newlines
/// through self-insert-command, which amalgamates when it is called.
const AMALGAMATING: &[&str] = &[
    "self-insert-command",
    "delete-char",
    "delete-backward-char",
    "newline",
    "open-line",
    "electric-newline-and-maybe-indent",
];

/// How many times a keyboard macro run "until an error" may repeat before
/// it is stopped, in case nothing ever fails.
const MACRO_REPEAT_LIMIT: usize = 100_000;

/// What a cached style is kept by: its faces, whether the background is
/// dark, and the number of the `face-remapping-alist` in force, 0 for none.
pub(crate) type StyleKey = (Vec<String>, bool, usize);

/// How many prompts and recursive edits may wait inside each other.
const MAX_WAITS: usize = 1_000;

/// A command whose arguments are still being read.
pub(crate) struct PendingCall {
    command: Rc<Command>,
    args: Vec<Arg>,
    /// The prefix argument the command was started with, kept for when it runs.
    prefix: Option<PrefixArg>,
    /// The command before it, which it sees as last-command when it runs,
    /// whatever ran while its arguments were typed, as in Emacs.
    last_command: Option<String>,
}

/// What [`Editor::loop_state`] notes.
pub struct LoopState {
    running: usize,
    in_change_hooks: bool,
    specpdl: usize,
    prefix: Option<PrefixArg>,
    interactive: bool,
}

/// All editor state. A front end feeds it keys with [`Editor::handle_key`]
/// and draws from the frame description it publishes.
pub struct Editor {
    pub(crate) buffers: Vec<Buffer>,
    pub(crate) current: usize,
    /// The syntax tables, by name, as Emacs's syntax-table objects.
    pub syntax_tables: crate::syntax_table::SyntaxTables,
    /// Programs running alongside, as Emacs's processes.
    pub(crate) processes: crate::process::Processes,
    /// Markers that point nowhere, kept so they can be pointed again, as an
    /// Emacs marker object outlives where it points.
    detached_markers: Vec<crate::buffer::Marker>,
    /// Whether any buffer has shared its text, so changes must be passed on.
    pub(crate) has_indirect_buffers: bool,
    /// How many commands have started, so code waiting for one it called
    /// interactively knows whether it ran or its arguments were quit.
    executed: u64,
    /// How many commands are running, one inside another.
    pub(crate) running: usize,
    /// The command keys named, while the command it is remapped to runs.
    remapped_from: Option<String>,
    /// Buffers by id, the most recently selected first, as Emacs's buffer
    /// list orders them; see [`Editor::buffer_list`].
    buffer_order: Vec<u64>,
    /// Char-tables, by id, as scripts hold them.
    pub(crate) char_tables: std::collections::HashMap<crate::chartab::CharTableId, crate::chartab::CharTable>,
    pub(crate) next_char_table: crate::chartab::CharTableId,
    /// The standard case and category tables, made when code first asks
    /// for them; till then, and while unchanged, the generated tables stand in.
    pub(crate) standard_case_table: Option<crate::chartab::CharTableId>,
    pub(crate) standard_category_table: Option<crate::chartab::CharTableId>,
    /// The last case and category tables worked out for lookups, with what identified them.
    pub(crate) case_maps_cache: std::cell::RefCell<Option<crate::casetab::CaseMapsCache>>,
    pub(crate) category_maps_cache: std::cell::RefCell<Option<crate::category::CategoryMapsCache>>,
    /// What the command loop keeps of the keyboard: keys being read, recursive edits, recent keys.
    pub(crate) keyboard: crate::keyboard::Keyboard,
    /// Kills, the yank pointer and the system clipboard.
    pub(crate) kill_ring: crate::kill_ring::KillRing,
    /// How big characters and lines are in the front end's fonts.
    pub(crate) metrics: std::sync::Arc<dyn crate::layout::TextMetrics>,
    /// Buffers put at the end of the buffer list, the last buried last.
    buried: Vec<u64>,
    /// The minibuffer, as ` *Minibuf-1*` in the buffer list, by its id;
    /// in a recursive minibuffer, the innermost, ` *Minibuf-2*` and on.
    pub(crate) minibuffer_id: u64,
    /// Whether the minibuffer's window is selected while a prompt is open,
    /// as it is when one opens, until `C-x o` selects another.
    pub(crate) minibuffer_window_selected: bool,
    /// The prompts a recursive minibuffer is open inside, outermost first.
    pub(crate) outer_prompts: Vec<crate::minibuffer::OuterPrompt>,
    pub(crate) prompt: Option<Prompt>,
    /// The messages shown, as *Messages* keeps them.
    pub(crate) message_log: Vec<LoggedMessage>,
    /// How many lines the echo area has grown to while the prompt is open.
    pub(crate) mini_window_lines: usize,
    /// How many lines the echo area last took for a message.
    pub(crate) echo_area_lines: usize,
    /// The frame's height with the echo area, as the front end last said.
    pub(crate) frame_lines: Option<usize>,
    /// How many columns the minibuffer's window is wide, as the front end
    /// last laid the echo area out.
    pub(crate) minibuffer_width: Option<usize>,
    pub(crate) pending_call: Option<PendingCall>,
    /// How many commands that read their arguments in the minibuffer have
    /// gone on to run, for `call_interactively` to tell one run from one quit.
    pending_calls_run: u64,
    pub(crate) global_map: KeymapId,
    pub(crate) minibuffer_map: KeymapId,
    /// Bindings for the next key sequence only, ahead of every other keymap.
    pub(crate) transient_map: Option<KeymapId>,
    /// A named keymap ahead of all but the transient map, while set.
    pub(crate) overriding_map: Option<KeymapId>,
    /// Every keymap; names for them are variables holding them.
    pub(crate) keymaps: Keymaps,
    /// Most recently registered first, which is the order keys are looked up in.
    pub(crate) minor_modes: Vec<MinorMode>,
    /// Every symbol's value, function, properties and advice.
    pub(crate) symbols: BTreeMap<String, crate::symbols::Symbol>,
    pub(crate) faces: BTreeMap<String, Face>,
    /// Whether the system the front end runs on looks dark, for choosing
    /// faces' colours where no theme gives the default face a background
    /// and `frame-background-mode` is unset; dark until a front end says.
    pub(crate) system_dark: bool,
    /// Whether quitting was asked for, which other threads may set.
    pub(crate) quitting: std::sync::Arc<crate::quit::QuitState>,
    /// The command loop the editor runs in, which a primitive waiting for
    /// input runs again, as Emacs's read-from-minibuffer runs a recursive
    /// edit, if a driver runs one; see [`Editor::wait_until`].
    pub(crate) command_loop: Option<std::rc::Rc<dyn crate::driver::NestedLoop>>,
    /// What scripts have bound, to restore as their forms end.
    pub(crate) specpdl: crate::specbind::Specpdl,
    /// Styles worked out for lists of faces, on each background and under
    /// each remapping, until a face changes.
    pub(crate) style_cache: std::cell::RefCell<std::collections::HashMap<StyleKey, crate::faces::Style>>,
    /// The `face-remapping-alist` values styles were cached for, by the
    /// number the cache keys them with, one more than their index.
    pub(crate) style_remaps: std::cell::RefCell<Vec<Vec<Value>>>,
    /// The images display specs have loaded, as a frame's image cache.
    pub(crate) images: std::cell::RefCell<crate::image::ImageCache>,
    pub(crate) grammars: BTreeMap<&'static str, crate::syntax::Grammar>,
    /// Tree-sitter queries compiled so far, by language and source.
    pub(crate) treesit_queries: std::collections::HashMap<(String, String), std::rc::Rc<tree_sitter::Query>>,
    pub(crate) next_hook_id: u64,
    /// Whether the running command was started by keys or M-x rather than
    /// called from code (Emacs's `called-interactively-p`).
    interactive: bool,
    /// The prefix argument for the next command, as prefix commands leave it
    /// (Emacs's `prefix-arg`).
    pub(crate) prefix_arg: Option<PrefixArg>,
    /// The prefix argument of the command that is running (Emacs's
    /// `current-prefix-arg`).
    current_prefix_arg: Option<PrefixArg>,
    pub(crate) message: Option<String>,
    /// The error from the last interactive command that failed, until taken.
    last_error: Option<Error>,
    /// Whether the command the command loop is running failed.
    command_failed: bool,
    /// Whether code set this-command explicitly, so a call from code keeps it.
    this_command_set: bool,
    /// Whether `after-change-functions` are running.
    pub(crate) in_change_hooks: bool,
    last_repeatable: Option<Repeatable>,
    /// Counts recorded repeatable commands, so that when one command runs
    /// another, as M-x does, the innermost is the one repeated.
    repeatable_count: u64,
    /// The keys typed so far while defining a keyboard macro.
    defining_macro: Option<Vec<Key>>,
    /// Where in the macro the key sequence being typed began, so ending the
    /// macro can leave out the keys that ended it.
    macro_sequence_start: usize,
    last_macro: Option<Vec<Key>>,
    /// How many keyboard macros are running, one inside another.
    pub(crate) executing_macro: usize,
    /// The global mark ring, newest first: a marker at the mark of each
    /// buffer the mark was last set in, as Emacs's `global-mark-ring`.
    global_mark_ring: Vec<u64>,
    /// Where `input-decode-map` and `key-translation-map` next look in the
    /// keys being read: the keys before have been translated or matched
    /// nothing, as read_key_sequence's indec and keytran starts.
    translation_starts: [usize; 2],
    last_command: Option<String>,
    this_command: Option<String>,
    pub(crate) last_key: Option<Key>,
    /// How many lines the last wheel event scrolls, like the data an Emacs
    /// wheel event carries. Set by [`Editor::wheel`].
    pub(crate) wheel_lines: usize,
    /// Where the last mouse event happened, for the commands bound to it.
    pub(crate) last_mouse: Option<crate::window::MouseEvent>,
    /// The last successful search's match, as Emacs's match data.
    pub(crate) match_data: Option<crate::search::Match>,
    /// Where line moves keep point, in columns of the default font, as
    /// Emacs's temporary-goal-column: fractional off the grid, where it
    /// stands for an x position.
    pub(crate) goal_column: Option<f32>,
    self_insert_run: usize,
    /// The run of amalgamating commands before the one now running, and
    /// whether that one was amalgamating, for undo_auto_amalgamate.
    previous_run: usize,
    previous_amalgamating: bool,
    /// Whether the command now running amalgamates its undo step.
    amalgamating_now: bool,
    pub(crate) windows: Vec<crate::window::Window>,
    pub(crate) window_tree: crate::window::WindowTree,
    pub(crate) selected_window: crate::window::WindowId,
    pub(crate) next_window_id: crate::window::WindowId,
    /// Counts window selections, to find the most recently used window.
    pub(crate) window_use: u64,
    /// The frame's size in columns and lines, mode lines included and the
    /// echo area not, once a front end has said; windows are laid out in it.
    pub(crate) frame_size: Option<(usize, usize)>,
    /// Whether `frame_size` was only worked out from the windows when one
    /// was first split, no front end having given it, so a lone window's
    /// new size can still change it.
    pub(crate) frame_size_implied: bool,
    /// Each window's new pixel size, new total size and new normal size,
    /// as window.el sets them before `window-resize-apply`: window.c's
    /// new_pixel, new_total and new_normal.
    pub(crate) window_new: std::collections::HashMap<crate::window::WindowId, crate::window::WindowNew>,
    /// Internal windows' parameters, as `window-parameter` keeps them;
    /// the window tree goes to front ends, so they are kept here.
    pub(crate) internal_window_parameters: std::collections::HashMap<crate::window::WindowId, std::collections::BTreeMap<String, crate::variables::Value>>,
    /// The tooltip `x-show-tip` is showing, if one is.
    pub(crate) tip: Option<crate::menu::Tip>,
    /// The menu `x-popup-menu` has open, while it waits for an answer.
    pub(crate) menu: Option<crate::menu::OpenMenu>,
    /// The frames that are not selected, and every frame's id, newest first.
    pub(crate) other_frames: Vec<crate::window::Frame>,
    pub(crate) frame_order: Vec<crate::window::FrameId>,
    pub(crate) selected_frame: crate::window::FrameId,
    pub(crate) next_frame_id: crate::window::FrameId,
    pub(crate) quit: bool,
    /// How many times `suspend-emacs` asked the front end to stop the
    /// process, for a terminal to see each request once.
    pub(crate) suspend_requests: u64,
    /// Where a front end last saw the pointer, which it writes itself.
    pub(crate) pointer: crate::mouse::PointerCell,
    /// Pointer moves code asked for, for the front end.
    pub(crate) warps: Vec<crate::mouse::Warp>,
    /// The status the program exits with once `quit` is set, as `kill-emacs`'s argument.
    pub(crate) exit_status: i32,
    /// Running without a frame, as `emacs --batch`: messages go to standard error.
    noninteractive: bool,
    /// A question a command asked, waiting for its answer.
    pub(crate) question: Option<crate::questions::Question>,
    pub(crate) timers: crate::timers::Timers,
    pub(crate) permissions: crate::permissions::Permissions,
    /// Each window's mode line, as the last redisplay formatted it.
    pub(crate) mode_lines: std::collections::HashMap<crate::window::WindowId, Vec<crate::modeline::ModeLineSegment>>,
    /// Each window's header line as the last redisplay formatted it, for windows whose format has one.
    pub(crate) header_lines: std::collections::HashMap<crate::window::WindowId, Vec<crate::modeline::ModeLineSegment>>,
    /// The fringe bitmaps `define-fringe-bitmap` defined.
    pub(crate) fringe_bitmaps: crate::fringe::FringeBitmaps,
    /// Whether `ding` rang the bell since a front end last looked.
    bell: bool,
    /// Each frame's parameters, as Emacs's `frame-parameter` reads them.
    pub(crate) frame_parameters: std::collections::HashMap<crate::window::FrameId, std::collections::BTreeMap<String, Value>>,
    /// Each frame's tab bar, as the last redisplay formatted it, for frames that show one.
    pub(crate) tab_bars: std::collections::HashMap<crate::window::FrameId, Vec<crate::modeline::ModeLineSegment>>,
    /// Whether a menu bar is being laid out, so that a hook that
    /// redisplays does not start another, as `inhibit-menubar-update`.
    pub(crate) updating_menu_bar: bool,
    /// Each frame's menu bar as the last redisplay laid it out.
    pub(crate) menu_bars: std::collections::HashMap<crate::window::FrameId, Vec<crate::menu::MenuBarItem>>,
    /// How many times each frame has been raised, which front ends follow.
    pub(crate) frame_raises: std::collections::HashMap<crate::window::FrameId, u64>,
    /// Each frame's title, from `frame-title-format`, as redisplay last formatted it.
    pub(crate) frame_titles: std::collections::HashMap<crate::window::FrameId, String>,
    /// The column of the tab bar the last mouse event was on, if it was on the tab bar.
    pub(crate) tab_bar_column: Option<usize>,
    /// Window configurations kept for code to put back, by id.
    pub(crate) window_configurations: std::collections::HashMap<u64, crate::window::WindowConfiguration>,
    pub(crate) next_window_configuration: u64,
}

impl Default for Editor {
    fn default() -> Editor {
        Editor::new()
    }
}

impl Editor {
    /// Rings the bell, as Emacs's `ding`: calls `ring-bell-function` if it
    /// is set, else leaves the bell for the front end to sound or, with
    /// `visible-bell`, flash.
    pub fn ding(&mut self) -> crate::error::Result<()> {
        match self.variable("ring-bell-function") {
            Some(f) if f.is_true() => self.funcall(&f, &[]).map(drop),
            _ => {
                self.bell = true;
                Ok(())
            }
        }
    }

    /// Whether the bell rang since the last call, for a front end to sound it.
    pub fn take_bell(&mut self) -> bool {
        std::mem::take(&mut self.bell)
    }
}

impl Editor {
    /// An editor with a `*scratch*` buffer and the built-in commands and bindings.
    pub fn new() -> Editor {
        let minibuffer = Buffer::new(" *Minibuf-1*");
        let minibuffer_id = minibuffer.id;
        let mut editor = Editor {
            buffers: vec![Buffer::new("*scratch*"), minibuffer],
            current: 0,
            syntax_tables: Default::default(),
            processes: Default::default(),
            executed: 0,
            detached_markers: Vec::new(),
            has_indirect_buffers: false,
            running: 0,
            remapped_from: None,
            buffer_order: Vec::new(),
            keyboard: Default::default(),
            kill_ring: Default::default(),
            char_tables: Default::default(),
            next_char_table: 0,
            standard_case_table: None,
            standard_category_table: None,
            case_maps_cache: Default::default(),
            category_maps_cache: Default::default(),
            metrics: std::sync::Arc::new(crate::layout::CellMetrics),
            buried: Vec::new(),
            minibuffer_id,
            minibuffer_window_selected: false,
            outer_prompts: Vec::new(),
            message_log: Vec::new(),
            mini_window_lines: 1,
            echo_area_lines: 1,
            frame_lines: None,
            minibuffer_width: None,
            prompt: None,
            pending_call: None,
            pending_calls_run: 0,
            global_map: 0,
            minibuffer_map: 1,
            transient_map: None,
            keymaps: {
                let mut maps = Keymaps::default();
                maps.make(None);
                maps.make(None);
                maps
            },
            minor_modes: Vec::new(),
            symbols: BTreeMap::new(),
            faces: BTreeMap::new(),
            system_dark: true,
            quitting: Default::default(),
            command_loop: None,
            specpdl: Default::default(),
            style_cache: Default::default(),
            style_remaps: Default::default(),
            images: Default::default(),
            grammars: crate::syntax::builtin_grammars().into_iter().collect(),
            treesit_queries: Default::default(),
            next_hook_id: 0,
            interactive: false,
            prefix_arg: None,
            current_prefix_arg: None,
            message: None,
            last_error: None,
            command_failed: false,
            this_command_set: false,
            in_change_hooks: false,
            last_repeatable: None,
            repeatable_count: 0,
            defining_macro: None,
            macro_sequence_start: 0,
            last_macro: None,
            executing_macro: 0,
            translation_starts: [0; 2],
            global_mark_ring: Vec::new(),
            last_command: None,
            this_command: None,
            last_key: None,
            wheel_lines: 1,
            last_mouse: None,
            match_data: None,
            overriding_map: None,
            goal_column: None,
            self_insert_run: 0,
            previous_run: 0,
            previous_amalgamating: false,
            amalgamating_now: false,
            windows: Vec::new(),
            window_tree: crate::window::WindowTree::Leaf(1),
            selected_window: 1,
            next_window_id: 1,
            frame_size: None,
            frame_size_implied: false,
            internal_window_parameters: Default::default(),
            window_new: Default::default(),
            tip: None,
            menu: None,
            other_frames: Vec::new(),
            frame_order: vec![crate::window::FIRST_FRAME],
            selected_frame: crate::window::FIRST_FRAME,
            next_frame_id: crate::window::FIRST_FRAME,
            window_use: 0,
            quit: false,
            suspend_requests: 0,
            pointer: Default::default(),
            warps: Vec::new(),
            exit_status: 0,
            noninteractive: false,
            question: None,
            timers: Default::default(),
            permissions: Default::default(),
            mode_lines: Default::default(),
            header_lines: Default::default(),
            fringe_bitmaps: Default::default(),
            bell: false,
            frame_parameters: Default::default(),
            tab_bars: Default::default(),
            updating_menu_bar: false,
            menu_bars: Default::default(),
            frame_raises: Default::default(),
            frame_titles: Default::default(),
            tab_bar_column: None,
            window_configurations: Default::default(),
            next_window_configuration: 0,
        };
        let first = crate::window::Window::new(1, editor.buffers[0].id, 80, 24);
        editor.windows.push(first);
        variables::install(&mut editor);
        crate::modeline::install(&mut editor);
        crate::bidi_display::install(&mut editor);
        faces::install(&mut editor);
        commands::install(&mut editor);
        editor
    }

    // Commands

    /// The command that ran before the one running now.
    pub fn last_command(&self) -> Option<&str> {
        self.last_command.as_deref()
    }

    /// Makes the next kill or command see `name` as the last command, as
    /// Lisp sets `last-command`: kill-whole-line sets it to kill-region so
    /// its two kills join.
    pub fn set_last_command(&mut self, name: Option<&str>) {
        self.last_command = name.map(str::to_string);
    }

    /// Runs a command with its arguments supplied directly instead of
    /// prompting for them. This is how code, scripts and tool calls invoke
    /// commands; errors are returned rather than shown.
    pub fn call(&mut self, name: &str, args: Vec<Arg>) -> Result<()> {
        self.call_with_prefix(name, args, None)
    }

    /// Like [`Editor::call`], with a prefix argument, as if typed after C-u or M-5.
    pub fn call_with_prefix(&mut self, name: &str, args: Vec<Arg>, prefix: Option<PrefixArg>) -> Result<()> {
        let command = self
            .command(name)
            .ok_or_else(|| Error::new(format!("No such command: {name}")))?;
        // A count or prefix argument left out comes from the call's prefix
        // argument, as an &optional one is nil and the command counts 1.
        let mut args = args;
        if args.len() < command.params.len() && command.params[args.len()..].iter().all(|p| p.kind.optional()) {
            for p in &command.params[args.len()..] {
                args.push(self.state_arg(p.kind, prefix)?);
            }
        }
        if args.len() != command.params.len() {
            return Err(Error::new(format!(
                "{name} takes {} arguments, got {}",
                command.params.len(),
                args.len()
            )));
        }
        // A call from outside is an undo step of its own; one from a running
        // command is part of that command's, as a Lisp function call is.
        if self.running == 0 {
            self.buffer_mut().undo_boundary();
        }
        let saved = std::mem::replace(&mut self.current_prefix_arg, prefix);
        let interactive = std::mem::replace(&mut self.interactive, false);
        // Unlike a command that keys run, a call from code does not become
        // this-command or last-command, as calling a function from Lisp does
        // not, unless it sets this-command itself, as kill-region does.
        let this = self.this_command.clone();
        let set = std::mem::replace(&mut self.this_command_set, false);
        self.running += 1;
        let result = self.run_command_body(&command, &args);
        self.running -= 1;
        let result = result.and(self.run_after_change_functions());
        self.deactivate_changed_regions(result.is_ok());
        if !self.this_command_set {
            self.this_command = this;
        }
        self.this_command_set |= set;
        self.interactive = interactive;
        self.current_prefix_arg = saved;
        // A call from code does not stop to ask about a file changed on
        // disk; it fails, as Emacs's file-supersession error does.
        if self.running == 0 {
            self.take_supersession();
        }
        result
    }

    /// Whether the running command was started by keys or M-x rather than
    /// called from code. Commands use it to decide whether to show a message.
    pub fn called_interactively(&self) -> bool {
        self.interactive
    }

    /// The command that is running, or about to run while `pre-command-hook` runs.
    pub fn this_command(&self) -> Option<&str> {
        self.this_command.as_deref()
    }

    // Prefix arguments

    /// The prefix argument of the running command, if it was given one.
    pub fn current_prefix_arg(&self) -> Option<PrefixArg> {
        self.current_prefix_arg
    }

    /// The running command's prefix argument as a count: 1 when there is none.
    pub fn prefix_numeric(&self) -> i64 {
        prefix_numeric_value(self.current_prefix_arg)
    }

    /// Gives the next command a prefix argument, as prefix commands such as
    /// C-u do. A command that leaves one is transparent: it does not become
    /// the last command, so C-k C-u 2 C-k still joins the kills.
    pub fn set_prefix_arg(&mut self, arg: Option<PrefixArg>) {
        self.prefix_arg = arg;
    }

    /// Binds keys for the next key sequence only, ahead of every other
    /// keymap, as Emacs's `set-transient-map` does. Prefix commands use it
    /// so that digits continue the argument.
    pub fn set_transient_map(&mut self, map: KeymapId) {
        self.transient_map = Some(map);
    }

    /// Names the running command, for commands that should count as another
    /// one afterwards. Deleting with a prefix argument kills, so it counts
    /// as `kill-region` and the next kill joins onto it.
    pub fn set_this_command(&mut self, name: &str) {
        self.this_command = Some(name.to_string());
        self.this_command_set = true;
    }

    /// The last key typed: the one that ran the current command.
    pub fn last_key(&self) -> Option<Key> {
        self.last_key
    }

    /// Runs a command the way a key binding does: prompting in the minibuffer
    /// for any parameters, and showing errors in the echo area.
    pub fn run_interactive(&mut self, name: &str) {
        let shifted = std::mem::take(&mut self.keyboard.shift_translated);
        let prefix = self.prefix_arg.take();
        let Some(command) = self.command(name) else {
            self.message(format!("No such command: {name}"));
            return;
        };
        let prompts = command.params.iter().any(|p| !p.kind.from_state());
        if prompts && self.keyboard.reading_keys.is_some() {
            self.message("Command attempted to use minibuffer while in minibuffer");
            return;
        }
        if prompts && let Err(e) = self.enter_recursive_minibuffer() {
            self.message(e.to_string());
            return;
        }
        // Called from a running command, as call-interactively from Lisp, it
        // is part of that command's undo step.
        if self.running == 0 {
            // Runs of typing, or of C-d or DEL, share an undo step, as in Emacs:
            // the first and up to 20 more (amalgamating-undo-limit).
            // A remapped command, such as org's for typing, amalgamates as the
            // command it stands in for.
            let base = self.remapped_from.take();
            // self-insert-command and delete-char amalgamate only for a count
            // below 2, so `M-2 SPC` is a step of its own.
            let listed = AMALGAMATING.contains(&base.as_deref().unwrap_or(name))
                && crate::prefix::prefix_numeric_value(prefix).abs() < 2;
            let amalgamate = listed
                && self.last_command() == Some(name)
                && self.previous_amalgamating
                && self.self_insert_run <= 20;
            self.previous_run = self.self_insert_run;
            self.self_insert_run = if amalgamate { self.self_insert_run + 1 } else { 1 };
            self.amalgamating_now = listed;
            self.claim_undo(self.current);
            self.buffer_mut().command_boundary(amalgamate);
        }
        if command.shift_select {
            self.shift_select(shifted);
        }
        if !prompts {
            // All its arguments come from the editor, so it runs now, and
            // a prompt open meanwhile keeps the command waiting for it.
            let args = command.params.iter().map(|p| self.state_arg(p.kind, prefix)).collect::<Result<Vec<_>>>();
            match args {
                Ok(args) => self.execute(command, args, prefix),
                Err(e) => self.fail(e),
            }
        } else {
            self.pending_call = Some(PendingCall { command, args: Vec::new(), prefix, last_command: self.last_command.clone() });
            self.read_next_arg();
        }
    }

    /// Emacs's shift selection: a movement with Shift starts a region at
    /// point, or keeps extending one Shift started; a movement without Shift
    /// ends a region Shift started.
    fn shift_select(&mut self, shifted: bool) {
        let b = self.buffer_mut();
        if shifted {
            if !b.is_shift_selected() {
                b.start_shift_selection();
            }
        } else if b.is_shift_selected() {
            b.deactivate_mark();
        }
    }

    fn read_next_arg(&mut self) {
        // What the editor supplies, the prefix argument, point and the
        // region, is taken without asking, as interactive "p", "d" and "r".
        while let Some(call) = &self.pending_call
            && let Some(param) = call.command.params.get(call.args.len())
            && param.kind.from_state()
        {
            match self.state_arg(param.kind, call.prefix) {
                Ok(arg) => self.pending_call.as_mut().expect("checked above").args.push(arg),
                Err(e) => {
                    self.pending_call = None;
                    self.fail(e);
                    return;
                }
            }
        }
        let Some(call) = &self.pending_call else { return };
        if let Some(param) = call.command.params.get(call.args.len()) {
            if param.kind == ParamKind::Keys {
                self.keyboard.reading_keys = Some(Vec::new());
                self.message = Some(param.prompt.clone());
            } else {
                let mut initial = self.initial_input(param.kind);
                let history = param.history.clone().unwrap_or_else(|| param.kind.history().to_string());
                let (kind, mut text, args) = (param.kind, param.prompt.clone(), call.args.clone());
                let (prompt_fn, initial_fn) = (param.prompt_fn.clone(), param.initial_fn.clone());
                let (collection_fn, require_match) = (param.collection_fn.clone(), param.require_match);
                for (f, out) in [(prompt_fn, &mut text), (initial_fn, &mut initial)] {
                    let Some(PromptFn(f)) = f else { continue };
                    match f(self, &args) {
                        Ok(t) => *out = t,
                        Err(e) => {
                            self.pending_call = None;
                            self.fail(e);
                            return;
                        }
                    }
                }
                let mut prompt = Prompt::new(&text, kind, &history);
                if let Some(crate::command::CollectionFn(f)) = collection_fn {
                    match f(self, &args) {
                        Ok(names) => prompt.collection = Some(names),
                        Err(e) => {
                            self.pending_call = None;
                            self.fail(e);
                            return;
                        }
                    }
                    prompt.require_match |= require_match;
                }
                self.open_prompt(prompt, &initial);
            }
            return;
        }
        let call = self.pending_call.take().expect("checked above");
        self.last_command = call.last_command;
        self.pending_calls_run += 1;
        self.execute(call.command, call.args, call.prefix);
    }

    /// Hands the next argument to the command waiting for it, or answers
    /// the question asked.
    pub(crate) fn supply_arg(&mut self, arg: Arg) {
        if self.question.is_some() {
            self.answer_typed(&arg.to_string());
            return;
        }
        let Some(call) = &mut self.pending_call else { return };
        // A number is read again until it is one, as read-number does.
        let arg = match (call.command.params.get(call.args.len()).map(|p| p.kind), arg) {
            (Some(ParamKind::Number), Arg::Str(text)) => match Arg::from_text(ParamKind::Number, &text) {
                Ok(n) => n,
                Err(_) => {
                    self.message("Please enter a number.");
                    self.read_next_arg();
                    return;
                }
            },
            (_, arg) => arg,
        };
        call.args.push(arg);
        self.read_next_arg();
    }

    /// The argument the editor supplies for a parameter of a kind it
    /// fills: the prefix argument as a count or as it is, point, the mark,
    /// or an end of the region, as interactive "p", "P", "d", "m" and "r".
    pub(crate) fn state_arg(&self, kind: ParamKind, prefix: Option<PrefixArg>) -> Result<Arg> {
        let b = self.buffer();
        let no_mark = || Error::new("The mark is not set now, so there is no region");
        Ok(match kind {
            ParamKind::Count => Arg::Int(prefix_numeric_value(prefix)),
            ParamKind::Prefix => Arg::Prefix(prefix),
            ParamKind::Point => Arg::Int(b.point() as i64),
            ParamKind::Mark => Arg::Int(b.mark().ok_or_else(|| Error::new("The mark is not set now"))? as i64),
            ParamKind::RegionBeginning => Arg::Int(b.mark().ok_or_else(no_mark)?.min(b.point()) as i64),
            ParamKind::RegionEnd => Arg::Int(b.mark().ok_or_else(no_mark)?.max(b.point()) as i64),
            kind => return Err(Error::new(format!("The editor does not supply a {}", kind.describe()))),
        })
    }

    /// Cancels any prompt and pending command, as `C-g` does. Code waiting
    /// for the prompt's answer is told it was quit, as are those sleeping.
    pub(crate) fn abort(&mut self) {
        let prompt = self.close_prompt().and_then(|p| p.answer);
        let question = self.drop_question().map(|q| q.answer);
        self.pending_call = None;
        self.keyboard.reading_keys = None;
        self.keyboard.pending_keys.clear();
        self.transient_map = None;
        self.prefix_arg = None;
        let sleeping = std::mem::take(&mut self.keyboard.sleeping);
        for slot in prompt.into_iter().chain(question).chain(sleeping) {
            slot.borrow_mut().get_or_insert(Err(crate::quit::quit_error()));
        }
    }

    /// Waits for what a prompt, question, key read or recursive edit puts in
    /// `slot`, as Emacs's `read-from-minibuffer` returns it, with the
    /// current buffer and prefix argument the asker's again, as at `asker`.
    pub(crate) fn wait_for_answer(&mut self, asker: &Resume, slot: &AnswerSlot) -> Result<Value> {
        self.wait_for_answer_reading(asker, slot, true)
    }

    /// As [`Editor::wait_for_answer`], saying whether the wait reads keys,
    /// as a prompt does, or only lets them run while it waits, as
    /// sleep-for, for waiting-for-user-input-p.
    pub(crate) fn wait_for_answer_reading(&mut self, asker: &Resume, slot: &AnswerSlot, reads_keys: bool) -> Result<Value> {
        self.processes.waits_reading_keys.push(reads_keys);
        let depth = self.processes.waits_reading_keys.len();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.wait_for_answer_inner(asker, slot)));
        self.processes.waits_reading_keys.truncate(depth - 1);
        result.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }

    fn wait_for_answer_inner(&mut self, asker: &Resume, slot: &AnswerSlot) -> Result<Value> {
        let waiting = slot.clone();
        if let Err(e) = self.wait_until(asker, Rc::new(move |_| waiting.borrow().is_some())) {
            self.abandon(slot);
            return Err(e);
        }
        slot.borrow_mut().take().expect("waited for it")
    }

    /// Closes the prompt or question whose answer goes to `slot`, as when
    /// the input ran out or the editor is closing, so nothing is left open
    /// that no one waits on.
    fn abandon(&mut self, slot: &AnswerSlot) {
        let ours = |a: Option<&AnswerSlot>| a.is_some_and(|a| Rc::ptr_eq(a, slot));
        if ours(self.question.as_ref().map(|q| &q.answer)) {
            self.drop_question();
            self.close_prompt();
            self.resume_outer_minibuffer();
        } else if ours(self.prompt.as_ref().and_then(|p| p.answer.as_ref())) {
            self.close_prompt();
            self.resume_outer_minibuffer();
        }
    }

    /// The running command's context, which waiting for input puts back.
    pub fn resume_point(&self) -> Resume {
        Resume {
            buffer: self.buffers[self.current].id,
            prefix: self.current_prefix_arg,
            command: self.this_command.clone(),
            last_command: self.last_command.clone(),
        }
    }

    /// Puts back what [`Editor::resume_point`] took, once a wait is over.
    pub(crate) fn resume(&mut self, resume: &Resume) {
        if let Some(index) = self.buffers.iter().position(|b| b.id == resume.buffer) {
            self.current = index;
        }
        self.current_prefix_arg = resume.prefix;
        if resume.command.is_some() {
            self.this_command = resume.command.clone();
            self.last_command = resume.last_command.clone();
        }
    }

    fn execute(&mut self, command: Rc<Command>, args: Vec<Arg>, prefix: Option<PrefixArg>) {
        self.executed += 1;
        // As Emacs's command loop, a command starts with no quit pending.
        if self.running == 0 {
            self.quitting.clear();
        }
        let start = (self.buffers[self.current].id, self.buffers[self.current].point());
        if let Err(e) = self.run_command(command.clone(), args.clone(), prefix) {
            if let Some((buffer, path)) = self.take_supersession() {
                self.ask_about_supersession(buffer, path, command, args, prefix, start);
            } else if let Some((buffer, path, owner)) = self.take_lock_threat() {
                self.ask_about_lock(buffer, path, owner, command, args, prefix, start);
            } else {
                self.fail(e);
            }
        }
        // After the command, as before it, the selected window's buffer is current.
        if self.running == 0 {
            self.current_from_selected_window();
        }
    }

    /// Shows an error as a failed command's, in the echo area.
    pub(crate) fn fail(&mut self, e: Error) {
        self.show_error(e.to_string());
        // As Emacs's command loop rings the bell on an error (bitch_at_user).
        let _ = self.ding();
        self.last_error = Some(e);
        self.command_failed = true;
    }

    /// The buffer whose edit was refused because another process holds its
    /// file's lock, if any, its file and who holds it.
    fn take_lock_threat(&mut self) -> Option<(u64, std::path::PathBuf, String)> {
        let b = self.buffers.iter_mut().find(|b| b.file.lock_threat.is_some())?;
        let owner = b.file.lock_threat.take()?;
        Some((b.id, b.path.clone()?, owner))
    }

    /// Asks what to do about editing a file another process has locked, as
    /// Emacs's `ask-user-about-lock`: s takes the lock and p goes ahead
    /// without it, each running the command again from where it started, as
    /// Emacs carries on with it; q leaves the file alone.
    #[allow(clippy::too_many_arguments)]
    fn ask_about_lock(
        &mut self,
        buffer: u64,
        path: std::path::PathBuf,
        owner: String,
        command: Rc<Command>,
        args: Vec<Arg>,
        prefix: Option<PrefixArg>,
        start: (u64, usize),
    ) {
        let file = path.display().to_string();
        let short = |s: &str, max: usize| if s.chars().count() > max { format!("...{}", s.chars().skip(s.chars().count() - max).collect::<String>()) } else { s.to_string() };
        let short_owner = if owner.chars().count() > 25 {
            let pid = owner.find(" (pid ").map_or("", |i| &owner[i..]);
            format!("{}...{pid}", owner.chars().take(13).collect::<String>())
        } else {
            owner.clone()
        };
        let prompt = format!("{} locked by {short_owner}: (s, q, p, ?)? ", short(&file, 22));
        let answered = move |ed: &mut Editor, answer: Result<String>| -> Result<()> {
            let answer = answer?;
            let Some(index) = ed.buffers.iter().position(|b| b.id == buffer) else { return Ok(()) };
            match answer.as_str() {
                "s" | "p" => {
                    if answer == "s" {
                        ed.steal_lock(buffer);
                    } else {
                        ed.buffers[index].file.lock_ignored = true;
                    }
                    if let Some(b) = ed.buffers.iter_mut().find(|b| b.id == start.0) {
                        b.set_point(start.1);
                    }
                    ed.run_command(command.clone(), args.clone(), prefix)
                }
                _ => Err(Error::signal("file-locked", format!("File is locked: {file}, {owner}"), vec![Value::Str(file.clone()), Value::Str(owner.clone())])),
            }
        };
        let answer = self.read_char_choice(&prompt, &['s', 'q', 'p']);
        if let Err(e) = answered(self, answer) {
            self.fail(e);
        }
    }

    /// The buffer whose edit was refused because its file changed on disk,
    /// if any, and its file.
    fn take_supersession(&mut self) -> Option<(u64, std::path::PathBuf)> {
        let b = self.buffers.iter_mut().find(|b| b.file.threatened)?;
        b.file.threatened = false;
        Some((b.id, b.path.clone()?))
    }

    /// Asks what to do about editing a buffer whose file changed on disk,
    /// as Emacs's `ask-user-about-supersession-threat`: y runs the command
    /// again from where it started and lets it edit, as Emacs carries on
    /// with it, r reverts the buffer, and n gives up.
    fn ask_about_supersession(
        &mut self,
        buffer: u64,
        path: std::path::PathBuf,
        command: Rc<Command>,
        args: Vec<Arg>,
        prefix: Option<PrefixArg>,
        start: (u64, usize),
    ) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let prompt = format!("{name} changed on disk; really edit the buffer? (y, n, r or C-h) ");
        let answered = move |ed: &mut Editor, answer: Result<String>| -> Result<()> {
            let answer = answer?;
            let Some(index) = ed.buffers.iter().position(|b| b.id == buffer) else { return Ok(()) };
            match answer.as_str() {
                "y" => {
                    let b = &mut ed.buffers[index];
                    b.file.allow_supersession = true;
                    b.file.backed_up = false;
                    if let Some(b) = ed.buffers.iter_mut().find(|b| b.id == start.0) {
                        b.set_point(start.1);
                    }
                    let result = ed.run_command(command.clone(), args.clone(), prefix);
                    ed.buffers.iter_mut().for_each(|b| b.file.allow_supersession = false);
                    result?;
                    ed.message("File on disk now will become a backup file if you save these changes.");
                    Ok(())
                }
                "r" => {
                    let old = ed.set_current_buffer(&ed.buffers[index].name.clone())?;
                    let reverted = ed.revert_to_visited_file().and_then(|()| match ed.command("normal-mode") {
                        Some(_) => ed.call("normal-mode", vec![Arg::Prefix(Some(PrefixArg::Number(1)))]),
                        None => Ok(()),
                    });
                    let _ = ed.set_current_buffer(&old);
                    reverted?;
                    Err(Error::new(format!("File reverted: {}", crate::files::abbreviate_path(&path))))
                }
                _ => Err(Error::new(format!("File changed on disk: {}", crate::files::abbreviate_path(&path)))),
            }
        };
        let answer = self.read_char_choice(&prompt, &['y', 'n', 'r']);
        if let Err(e) = answered(self, answer) {
            self.fail(e);
        }
    }

    /// Runs a command interactively with its arguments and prefix argument,
    /// and remembers it for `repeat`.
    fn run_command(&mut self, command: Rc<Command>, args: Vec<Arg>, prefix: Option<PrefixArg>) -> Result<()> {
        let saved = std::mem::replace(&mut self.current_prefix_arg, prefix);
        let interactive = std::mem::replace(&mut self.interactive, true);
        let last = self.last_command.clone();
        let key = self.last_key;
        let count = self.repeatable_count;
        let result = self.invoke(command.clone(), args.clone());
        self.interactive = interactive;
        self.current_prefix_arg = saved;
        if self.prefix_arg.is_some() {
            // A prefix command leaves an argument for the next command and stays
            // out of the way, as Emacs's prefix-command-preserve-state does.
            self.last_command = last;
        } else if self.repeatable_count == count && command.name != "repeat" {
            // Only the innermost command is remembered: after M-x forward-char,
            // repeat runs forward-char, not M-x.
            self.last_repeatable = Some(Repeatable { command, args, prefix, key });
            self.repeatable_count += 1;
        }
        result
    }

    /// Runs the last repeatable command again, with the same arguments and
    /// key, and with `prefix` if given or else its own prefix argument.
    pub fn repeat_last_command(&mut self, prefix: Option<PrefixArg>) -> Result<()> {
        let last = self
            .last_repeatable
            .clone()
            .ok_or_else(|| Error::new("There is nothing to repeat"))?;
        self.last_key = last.key;
        self.buffer_mut().undo_boundary();
        let prefix = prefix.or(last.prefix);
        // What the editor supplied, the count, point or the region, is
        // taken afresh, as repeat calls the command interactively again;
        // what was typed is used again.
        let mut args = last.args;
        for (arg, param) in args.iter_mut().zip(&last.command.params) {
            if param.kind.from_state() {
                *arg = self.state_arg(param.kind, prefix)?;
            }
        }
        self.run_command(last.command, args, prefix)
    }

    // Keyboard macros

    /// Starts recording keys into a keyboard macro.
    pub fn start_kbd_macro(&mut self) -> Result<()> {
        if self.defining_macro.is_some() {
            return Err(Error::new("Already defining keyboard macro"));
        }
        self.defining_macro = Some(Vec::new());
        self.macro_sequence_start = 0;
        self.set_default("defining-kbd-macro", Value::Bool(true));
        Ok(())
    }

    /// Finishes the keyboard macro being defined. The keys that ended it
    /// are left out.
    pub fn end_kbd_macro(&mut self) -> Result<()> {
        let mut keys = self
            .defining_macro
            .take()
            .ok_or_else(|| Error::new("Not defining kbd macro"))?;
        keys.truncate(self.macro_sequence_start);
        self.last_macro = Some(keys);
        self.set_default("defining-kbd-macro", Value::Bool(false));
        Ok(())
    }

    /// Runs a key sequence in Emacs notation as a keyboard macro, `count`
    /// times or until an error if `count` is 0, as Emacs's
    /// `execute-kbd-macro`: each command it runs goes through the command
    /// loop, with its undo boundary and hooks, as if typed. Scripts drive
    /// the editor with it, as packages' tests do in batch mode.
    pub fn execute_kbd_macro(&mut self, seq: &str, count: i64) -> Result<()> {
        let keys = Key::parse_seq(seq).ok_or_else(|| Error::new(format!("Invalid key sequence: {seq}")))?;
        if count < 0 {
            return Err(Error::new("Negative repetition argument"));
        }
        self.executing_macro += 1;
        let result = self.type_keys(&keys, count);
        self.executing_macro -= 1;
        result
    }

    /// Types the last keyboard macro `count` times, or until an error if
    /// `count` is 0. The first error stops it, as it would stop the macro in
    /// Emacs, and becomes this call's error.
    pub fn call_last_kbd_macro(&mut self, count: i64) -> Result<()> {
        let keys = self
            .last_macro
            .clone()
            .ok_or_else(|| Error::new("No kbd macro has been defined"))?;
        if count < 0 {
            return Err(Error::new("Negative repetition argument"));
        }
        self.executing_macro += 1;
        let result = self.type_keys(&keys, count);
        self.executing_macro -= 1;
        result
    }

    fn type_keys(&mut self, keys: &[Key], count: i64) -> Result<()> {
        let mut done = 0;
        while count == 0 || done < count {
            // As typeahead, so a command in the macro that waits for input
            // reads the macro's next keys.
            let before = self.keyboard.typeahead.len();
            for &key in keys.iter().rev() {
                self.keyboard.typeahead.push_front(key);
            }
            while self.keyboard.typeahead.len() > before {
                let Some(key) = self.next_typed_ahead() else { break };
                self.handle_key(key);
                if let Some(e) = self.take_error() {
                    // The rest of the macro goes with it.
                    let left = self.keyboard.typeahead.len().saturating_sub(before);
                    self.keyboard.typeahead.drain(..left);
                    return Err(e);
                }
            }
            done += 1;
            if count == 0 && done as usize >= MACRO_REPEAT_LIMIT {
                return Err(Error::new("Keyboard macro repeated too many times"));
            }
        }
        Ok(())
    }

    pub fn defining_kbd_macro(&self) -> bool {
        self.defining_macro.is_some()
    }

    pub fn executing_kbd_macro(&self) -> bool {
        self.executing_macro > 0
    }

    /// Runs `after-change-functions` for each change to the current buffer
    /// since they last ran, with where the new text starts and ends and how
    /// long the old text was, as Emacs runs them after each change. Changes
    /// the functions make themselves do not run them again, as with Emacs's
    /// `inhibit-modification-hooks`.
    /// An error stops them and is returned, and, as in Emacs, the buffer's
    /// own functions are removed from the hook.
    pub fn run_after_change_functions(&mut self) -> Result<()> {
        if self.in_change_hooks || self.modification_hooks_inhibited() {
            self.buffer_mut().pending_changes.clear();
            return Ok(());
        }
        let changes = std::mem::take(&mut self.buffer_mut().pending_changes);
        if changes.is_empty() || !self.hook_has_functions("after-change-functions") {
            return Ok(());
        }
        self.in_change_hooks = true;
        let mut result = Ok(());
        for (beg, end, old) in changes {
            let args = [Value::Number(beg as f64), Value::Number(end as f64), Value::Number(old as f64)];
            if let Err(e) = self.run_hook_with_args("after-change-functions", &args) {
                self.buffer_mut().local_hooks.remove("after-change-functions");
                result = Err(e);
                break;
            }
        }
        self.buffer_mut().pending_changes.clear();
        self.in_change_hooks = false;
        result
    }

    /// Joins the running command's undo step to the one before, as Emacs's
    /// `undo-auto-amalgamate` does when self-insert-command runs: when the
    /// command before was this one and amalgamated too, up to 20 in a row.
    /// Commands that insert newlines through it, such as org-return, call this.
    pub fn undo_auto_amalgamate(&mut self) {
        if self.amalgamating_now {
            return;
        }
        self.amalgamating_now = true;
        let same = self.this_command.is_some() && self.this_command == self.last_command;
        if same && self.previous_amalgamating && self.previous_run <= 20 {
            self.buffer_mut().amalgamate_undo();
            self.self_insert_run = self.previous_run + 1;
        }
    }

    /// Runs a command interactively from code, as Emacs's call-interactively:
    /// its arguments are read in the minibuffer, waiting for them, and it
    /// has run when this returns. Quitting the reading is `quit`.
    pub fn call_interactively(&mut self, name: &str) -> Result<()> {
        let asker = self.resume_point();
        self.run_interactive(name);
        if self.pending_call.is_none() {
            return Ok(());
        }
        // Whether its arguments were all read and it ran, rather than being
        // quit: commands typed into its prompts run meanwhile, so counting
        // every command executed would not tell.
        let before = self.pending_calls_run;
        self.wait_until(&asker, Rc::new(|ed| ed.pending_call.is_none()))?;
        if self.pending_calls_run == before {
            return Err(crate::quit::quit_error());
        }
        Ok(())
    }

    /// Gives the editor something to read input from when a command waits
    /// for it and no keys are typed ahead, where no command loop runs, as
    /// batch Emacs reads standard input. `source` handles some input, as
    /// by typing an answer, and returns false when it has none.
    pub fn set_input_source(&mut self, source: impl FnMut(&mut Editor) -> bool + 'static) {
        self.keyboard.input_source = Some(Box::new(source));
    }

    /// Runs the command loop inside the command now running until `done`
    /// says, as Emacs's read-from-minibuffer and recursive-edit run one:
    /// keys go to their commands, timers and process output run, and the
    /// window shows what happens. Input comes from keys put back, then keys
    /// typed ahead, then the driver's channel or the input source.
    /// Afterwards the current buffer, prefix argument and command are as
    /// at `asker`, taken with [`Editor::resume_point`] before the prompt
    /// opened. Fails with `quit` if the editor is closing, and with
    /// `end-of-file` if there is no more input, as batch Emacs does.
    pub fn wait_until(&mut self, asker: &Resume, done: WaitDone) -> Result<()> {
        // Each wait is a command loop on the stack: past this many, refuse,
        // as Emacs signals rather than overflow its stack.
        if self.keyboard.waits.len() >= MAX_WAITS {
            let depth = self.keyboard.waits.len() as i64 + 1;
            return Err(Error::signal("excessive-lisp-nesting", format!("Lisp nesting exceeds ‘max-lisp-eval-depth’: {depth}"), vec![Value::Number(depth as f64)]));
        }
        self.keyboard.waits.push(done.clone());
        self.keyboard.input_serial += 1;
        self.keyboard.wait_serials.push(self.keyboard.input_serial);
        let result = self.wait_for_input(&*done);
        self.keyboard.wait_serials.pop();
        self.keyboard.waits.pop();
        self.resume(asker);
        result
    }

    /// The next key typed ahead, unless a command waiting below has its
    /// answer, which it takes first, as Emacs reads typeahead in order.
    pub(crate) fn next_typed_ahead(&mut self) -> Option<Key> {
        let waits = self.keyboard.waits.clone();
        if waits.iter().any(|done| done(self)) {
            return None;
        }
        self.keyboard.typeahead.pop_front()
    }

    fn wait_for_input(&mut self, done: &dyn Fn(&Editor) -> bool) -> Result<()> {
        loop {
            if done(self) {
                return Ok(());
            }
            if let Some(key) = self.keyboard.unread_keys.pop_front() {
                self.dispatch_key(key);
                continue;
            }
            if let Some(key) = self.keyboard.typeahead.pop_front() {
                self.handle_key(key);
                continue;
            }
            if let Some(command_loop) = self.command_loop.clone() {
                return command_loop.wait(self, done);
            }
            if let Some(mut source) = self.keyboard.input_source.take() {
                let more = source(self);
                self.keyboard.input_source.get_or_insert(source);
                if more {
                    continue;
                }
            }
            return Err(Error::signal("end-of-file", "Error reading from stdin", vec![]));
        }
    }

    /// Reads `keys` as typed ahead: a command they start that waits for
    /// input reads the rest of them first, as Emacs reads typeahead.
    fn type_ahead(&mut self, keys: impl IntoIterator<Item = Key>) {
        let before = self.keyboard.typeahead.len();
        let keys: Vec<Key> = keys.into_iter().collect();
        for key in keys.into_iter().rev() {
            self.keyboard.typeahead.push_front(key);
        }
        while self.keyboard.typeahead.len() > before {
            // Keys after an answer wait for the command that asked.
            let Some(key) = self.next_typed_ahead() else { break };
            self.handle_key(key);
        }
    }

    /// Makes the command now running not amalgamating after all, so the next
    /// one starts a new undo step, as Emacs's self-insert-command does by
    /// setting `undo-auto--this-command-amalgamating` to nil once auto-fill
    /// has broken the line.
    pub(crate) fn undo_auto_stop_amalgamating(&mut self) {
        self.amalgamating_now = false;
    }

    /// Point's column as Emacs's `current-column` counts it: tabs to tab
    /// stops, wide characters as two, and text hidden without an ellipsis as none.
    pub fn current_column(&self) -> usize {
        let b = self.buffer();
        crate::commands::current_column(self, b, b.point())
    }

    /// Moves point to a column of its line, as Emacs's `move-to-column` does
    /// without forcing, and returns the column reached.
    pub fn move_to_column(&mut self, column: usize) -> usize {
        // What font-lock hides counts, so the line is fontified first, as
        // redisplay would have done.
        let p = self.buffer().point();
        let _ = self.fontify_region(p..p);
        let b = self.buffer();
        let pos = crate::commands::move_to_column_on(self, b, b.line_of(b.point()), column);
        self.buffer_mut().set_point(pos);
        self.current_column()
    }

    /// Takes the error from the last interactive command that failed. An
    /// undefined key is not an error, as in Emacs: it only shows a message.
    pub fn take_error(&mut self) -> Option<Error> {
        self.last_error.take()
    }

    /// The command loop's own state, which every command puts back as it
    /// returns: noted before code that may panic, and put back if it does,
    /// so one internal error does not leave every later command looking
    /// nested, with no undo boundaries and change hooks off.
    pub fn loop_state(&self) -> LoopState {
        LoopState {
            running: self.running,
            in_change_hooks: self.in_change_hooks,
            specpdl: self.specpdl_depth(),
            prefix: self.current_prefix_arg,
            interactive: self.interactive,
        }
    }

    pub fn restore_loop_state(&mut self, state: LoopState) {
        self.running = state.running;
        self.in_change_hooks = state.in_change_hooks;
        self.unbind_to(state.specpdl);
        self.current_prefix_arg = state.prefix;
        self.interactive = state.interactive;
    }

    fn invoke(&mut self, command: Rc<Command>, args: Vec<Arg>) -> Result<()> {
        self.this_command = Some(command.name.clone());
        self.this_command_set = false;
        self.running += 1;
        let result = self.run_command_body(&command, &args);
        self.running -= 1;
        let result = result.and(self.run_after_change_functions());
        // A command that ran another command (as M-x does) leaves that one as the last command.
        if let Some(name) = self.this_command.take() {
            self.last_command = Some(name);
        }
        self.deactivate_changed_regions(result.is_ok());
        result
    }

    /// Editing deactivates the region, as in Emacs's transient-mark-mode,
    /// unless the command failed: Emacs's command loop skips deactivating
    /// then, and the next command starts afresh. A command called from code
    /// that fails leaves its changes for the command around it.
    fn deactivate_changed_regions(&mut self, succeeded: bool) {
        if !succeeded && self.running > 0 {
            return;
        }
        // A command that set deactivate-mark to nil after its changes keeps
        // the region, as duplicate-dwim does; it is unset again for the next.
        let keep = matches!(self.variable("deactivate-mark"), Some(Value::Bool(false)));
        if self.running == 0 {
            self.set_default("deactivate-mark", Value::Null);
        }
        for b in self.buffers.iter_mut() {
            if b.take_changed() && succeeded && !keep {
                b.deactivate_mark();
            }
        }
    }

    /// Runs a command as the command loop runs one bound to a key, as
    /// Emacs's `command-execute` does: for what a front end gives as a
    /// command rather than a key, such as the Mac's ⌘C, ⌘X and ⌘V.
    pub fn command_execute(&mut self, name: &str) {
        if self.running == 0 {
            self.current_from_selected_window();
        }
        self.note_command_keys(&[]);
        self.command_loop_run(name);
        self.resume_outer_minibuffer();
    }

    /// Runs a command for a key, as Emacs's command loop does: first
    /// `pre-command-hook`, which can change this-command, and that command
    /// runs instead; then `post-command-hook`.
    fn command_loop_run(&mut self, name: &str) {
        self.record_lossage_command(name);
        self.this_command = Some(name.to_string());
        if let Err(e) = self.run_hooks("pre-command-hook") {
            self.message(format!("Error in pre-command-hook: {e}"));
        }
        let mut name = self.this_command.take().unwrap_or_else(|| name.to_string());
        if let Some(to) = self.command_remapping(&name) {
            self.remapped_from = Some(std::mem::replace(&mut name, to));
        }
        let (old_point, old_buffer, old_tick) = (self.buffer().point(), self.buffer().id, self.buffer().modified_tick());
        self.command_failed = false;
        self.run_interactive(&name);
        self.previous_amalgamating = self.amalgamating_now;
        self.this_command = self.last_command.clone();
        self.refresh_dynamic_collection();
        if let Err(e) = self.run_hooks("post-command-hook") {
            self.message(format!("Error in post-command-hook: {e}"));
        }
        self.this_command = None;
        // As in Emacs's command loop, point is adjusted after post-command-hook
        // has run, and not at all after an error.
        let modified = self.buffer().id != old_buffer || self.buffer().modified_tick() != old_tick;
        if !self.command_failed {
            self.adjust_point_for_invisible(old_point, modified);
        }
        self.keep_point_out_of_prompt();
        self.sync_shared_text();
        // Buffers saved, reverted or undone back to their file give up its lock.
        self.release_locks();
    }

    // Keys

    /// Handles one key press: runs the command it completes, waits for more
    /// keys after a prefix, or inserts it if it is a plain unbound character.
    pub fn handle_key(&mut self, key: Key) {
        // Whatever code left current, a key acts on the selected window's buffer.
        if self.running == 0 {
            self.current_from_selected_window();
        }
        // Movement is not kept in macros, as Emacs keeps it out, nor in the
        // lossage, where Emacs keeps a window's first and last.
        let movement = key.code == KeyCode::MouseMovement;
        // While a keyboard macro is being defined, record the keys typed.
        if self.executing_macro == 0
            && !movement
            && let Some(keys) = &mut self.defining_macro
        {
            let starts_sequence =
                self.keyboard.pending_keys.is_empty() && !self.keyboard.esc_prefix && self.keyboard.reading_keys.is_none();
            if starts_sequence {
                self.macro_sequence_start = keys.len();
            }
            keys.push(key);
        }
        let typed = self.executing_macro == 0 && !movement;
        if typed {
            self.note_input();
            self.record_lossage_key(key);
        }
        self.dispatch_raw_key(key);
        if typed {
            self.count_key_for_auto_save();
        }
        self.resume_outer_minibuffer();
        // Keys a command gave back are read next, but not recorded again.
        if !self.keyboard.reading_unread {
            self.keyboard.reading_unread = true;
            while let Some(key) = self.keyboard.unread_keys.pop_front() {
                self.dispatch_raw_key(key);
            }
            self.keyboard.reading_unread = false;
        }
    }

    /// Makes keys the next ones read, after the command running now, as
    /// pushing onto Emacs's `unread-command-events` does.
    pub fn unread_keys(&mut self, keys: &[Key]) {
        for key in keys.iter().rev() {
            self.keyboard.unread_keys.push_front(*key);
        }
    }

    /// Dispatches a key as it came, before any translation, noting it
    /// among the raw keys of the sequence being read, as Emacs's
    /// read_key_sequence keeps raw_keybuf for `this-single-command-raw-keys`.
    fn dispatch_raw_key(&mut self, key: Key) {
        let starts_sequence = self.keyboard.pending_keys.is_empty() && !self.keyboard.esc_prefix && self.keyboard.reading_keys.is_none();
        if !self.reading_single_key() {
            if starts_sequence {
                self.keyboard.raw_keys.clear();
            }
            self.keyboard.raw_keys.push(key);
        }
        self.dispatch_key(key);
    }

    fn dispatch_key(&mut self, mut key: Key) {
        if self.reading_single_key() && !self.keyboard.esc_prefix && self.key_read(key) {
            return;
        }
        if self.keyboard.esc_prefix {
            self.keyboard.esc_prefix = false;
            key.meta = true;
        } else if key == Key::new(KeyCode::Esc) && !self.binds_next(key) {
            self.keyboard.esc_prefix = true;
            self.message = Some("ESC-".into());
            return;
        }

        if self.key_read(key) {
            return;
        }
        if self.answer_key(key) {
            return;
        }

        if let Some(keys) = &mut self.keyboard.reading_keys {
            keys.push(key);
            if self.keymaps.lookup(self.global_map, keys) == Lookup::Prefix {
                self.message = Some(format!("{}-", format_keys(keys)));
                return;
            }
            let keys = self.keyboard.reading_keys.take().expect("checked above");
            self.message = None;
            self.supply_arg(Arg::Keys(keys));
            return;
        }

        self.message = None;
        if self.keyboard.pending_keys.is_empty() {
            self.translation_starts = [0; 2];
        }
        self.keyboard.pending_keys.push(key);
        let translating = self.translate_pending_keys();
        let key = *self.keyboard.pending_keys.last().unwrap_or(&key);
        let found = self.lookup(&self.keyboard.pending_keys);
        // A translation map's prefix keeps reading only keys the keymaps
        // do not bind, as read_key_sequence's loop has it, so C-x C-x runs
        // although C-x starts C-x 8 in key-translation-map.
        if translating && found == Lookup::Unbound {
            self.message = Some(format!("{}-", format_keys(&self.keyboard.pending_keys)));
            return;
        }
        match found {
            Lookup::Prefix => {
                self.keyboard.shift_translated = false;
                self.message = Some(format!("{}-", format_keys(&self.keyboard.pending_keys)));
            }
            Lookup::Command(name) => {
                let keys = std::mem::take(&mut self.keyboard.pending_keys);
                self.transient_map = None;
                self.last_key = Some(key);
                self.note_command_keys(&keys);
                self.command_loop_run(&name);
            }
            // Keys bound to keys are a keyboard macro, as a string or
            // vector binding is in Emacs.
            Lookup::Keys(to) => {
                let keys = std::mem::take(&mut self.keyboard.pending_keys);
                self.transient_map = None;
                self.note_command_keys(&keys);
                self.executing_macro += 1;
                let result = self.type_keys(&to, 1);
                self.executing_macro -= 1;
                if let Err(e) = result {
                    self.fail(e);
                }
            }
            // Shift translation, as in Emacs: a shifted key with no binding of
            // its own acts as the key without Shift, so S-<right> runs
            // forward-char and Shift selection applies.
            Lookup::Unbound if key.shift => {
                self.keyboard.pending_keys.pop();
                self.keyboard.shift_translated = true;
                self.dispatch_key(key.unshifted());
            }
            // Movement nothing binds is dropped, as Emacs's global map
            // binds it to ignore-preserving-kill-region, which E8's mouse
            // package binds it to as well; after a prefix it is undefined.
            Lookup::Unbound if key.code == KeyCode::MouseMovement && self.keyboard.pending_keys.len() == 1 => {
                self.keyboard.pending_keys.clear();
                self.keyboard.raw_keys.clear();
            }
            // As in Emacs, an unbound button press is dropped, and an unbound
            // drag or repeated click acts as a plain click.
            Lookup::Unbound if self.keyboard.pending_keys.len() == 1 && matches!(key.code, KeyCode::Mouse(..)) => {
                self.keyboard.pending_keys.clear();
                match key.code {
                    KeyCode::Mouse(MouseKind::Down | MouseKind::Click, _) => {
                        if matches!(key.code, KeyCode::Mouse(MouseKind::Click, _)) {
                            self.message(format!("{key} is undefined"));
                        }
                    }
                    KeyCode::Mouse(_, n) => self.dispatch_key(Key { code: KeyCode::Mouse(MouseKind::Click, n), ..key }),
                    _ => unreachable!(),
                }
            }
            Lookup::Unbound => {
                self.keyboard.shift_translated = false;
                self.transient_map = None;
                let keys = std::mem::take(&mut self.keyboard.pending_keys);
                self.note_command_keys(&keys);
                if keys.len() == 1 && key.printable().is_some() {
                    self.last_key = Some(key);
                    self.command_loop_run("self-insert-command");
                } else if keys.len() > 1
                    && (key.code == KeyCode::Char('h') && key.ctrl && !key.meta || key.code == KeyCode::F(1))
                    && self.command("describe-prefix-bindings").is_some()
                {
                    // As Emacs's help-char after a prefix key runs
                    // prefix-help-command: the keys under the prefix are
                    // listed, the command reading them as this-command-keys.
                    self.last_key = Some(key);
                    self.command_loop_run("describe-prefix-bindings");
                } else {
                    self.message(format!("{} is undefined", format_keys(&keys)));
                    // Emacs runs the command `undefined` for the keys, so the
                    // next command does not follow the one before them.
                    self.last_command = Some("undefined".into());
                    self.record_lossage_command("undefined");
                }
            }
        }
    }

    /// Whether the keys being read go on with `key` in the keymaps: ESC is
    /// then a key of its own, as in `M-ESC ESC`, rather than Meta for the
    /// key after it.
    fn binds_next(&self, key: Key) -> bool {
        if self.keyboard.pending_keys.is_empty() {
            return false;
        }
        let mut keys = self.keyboard.pending_keys.clone();
        keys.push(key);
        self.lookup(&keys) != Lookup::Unbound
    }

    /// Translates the keys being read by `input-decode-map` and then
    /// `key-translation-map`, as Emacs's read_key_sequence does: keys from
    /// where each map last stopped that it binds to keys become those keys,
    /// or to a function, what it returns for them; keys it binds to nothing
    /// are passed over. Returns whether a map waits for more keys, as for
    /// `C-x 8` before the character it makes, which matters only while the
    /// keymaps bind the keys to nothing.
    fn translate_pending_keys(&mut self) -> bool {
        let mut waiting = false;
        for (i, name) in ["input-decode-map", "key-translation-map"].into_iter().enumerate() {
            let Some(map) = self.keymap_named(name) else { continue };
            while self.translation_starts[i] < self.keyboard.pending_keys.len() {
                let start = self.translation_starts[i];
                let to = match self.keymaps.lookup(map, &self.keyboard.pending_keys[start..]) {
                    Lookup::Prefix => {
                        waiting = true;
                        break;
                    }
                    Lookup::Unbound => {
                        self.translation_starts[i] += 1;
                        continue;
                    }
                    Lookup::Keys(to) => to,
                    // A function is called with the prompt and gives the keys.
                    Lookup::Command(f) => match self.funcall(&Value::Str(f), &[Value::Str(String::new())]) {
                        Ok(Value::Str(keys)) => Key::parse_seq(&keys).unwrap_or_default(),
                        Ok(Value::List(items)) => items.iter().filter_map(|k| k.as_str().and_then(Key::parse_seq)).flatten().collect(),
                        _ => {
                            self.translation_starts[i] += 1;
                            continue;
                        }
                    },
                };
                self.keyboard.pending_keys.truncate(start);
                self.keyboard.pending_keys.extend(to);
                self.translation_starts[i] = self.keyboard.pending_keys.len();
            }
        }
        waiting
    }

    /// Looks a key sequence up in the active keymaps, in Emacs's order: a
    /// transient map, the minibuffer's map while it is active, the maps of
    /// minor modes that are on, the major mode's map, and the global map.
    /// The first that binds the keys wins.
    pub fn lookup(&self, keys: &[Key]) -> Lookup {
        for map in self.current_active_maps() {
            match self.lookup_in(map, keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        Lookup::Unbound
    }

    /// Feeds a mouse wheel or trackpad scroll of `lines` whole lines: positive
    /// towards the end of the buffer. It arrives as `<wheel-down>` or
    /// `<wheel-up>`, bound to `mwheel-scroll`, so it can be rebound and
    /// described like any key.
    pub fn wheel(&mut self, lines: isize) {
        self.wheel_in(None, lines);
    }

    /// Feeds a wheel scroll over a window, which scrolls that window
    /// whether or not it is selected, as Emacs's `mouse-wheel-follow-mouse`.
    pub fn wheel_in(&mut self, window: Option<crate::window::WindowId>, lines: isize) {
        if lines == 0 {
            return;
        }
        self.last_mouse = window.map(|window| crate::window::MouseEvent { window, position: None, start: None });
        self.wheel_lines = lines.unsigned_abs();
        let code = if lines > 0 { KeyCode::WheelDown } else { KeyCode::WheelUp };
        self.handle_key(Key::new(code));
        self.wheel_lines = 1;
    }

    /// Feeds a key sequence in Emacs notation, such as `C-x C-s`, as if typed.
    pub fn press(&mut self, seq: &str) -> Result<()> {
        let keys = Key::parse_seq(seq)
            .ok_or_else(|| Error::new(format!("Invalid key sequence: {seq}")))?;
        self.type_ahead(keys);
        Ok(())
    }

    /// Types text one character at a time; a newline presses RET and a tab presses TAB.
    pub fn type_text(&mut self, text: &str) {
        self.type_ahead(text.chars().map(|c| match c {
            '\n' => Key::new(KeyCode::Enter),
            '\t' => Key::new(KeyCode::Tab),
            c => Key::char(c),
        }));
    }

    // Buffers

    /// The current buffer, which commands act on: the minibuffer while a
    /// prompt is open, otherwise the buffer shown in the selected window,
    /// unless code makes another current, as set-buffer does.
    pub fn buffer(&self) -> &Buffer {
        &self.buffers[self.current]
    }

    pub fn buffer_mut(&mut self) -> &mut Buffer {
        &mut self.buffers[self.current]
    }

    /// Whether the minibuffer is the current buffer while a prompt is open,
    /// as Emacs's `minibufferp` of the current buffer.
    pub fn in_minibuffer(&self) -> bool {
        self.prompt.is_some() && self.buffers[self.current].id == self.minibuffer_id
    }

    /// Where the minibuffer is in the buffer list.
    pub(crate) fn minibuffer_index(&self) -> usize {
        self.buffer_with_id(self.minibuffer_id).expect("the minibuffer is never killed")
    }

    /// The buffer the selected window shows, whichever buffer is current,
    /// as Emacs's (window-buffer): code may make another buffer current
    /// for a while, as with-current-buffer does, without changing what
    /// the window shows.
    pub fn window_buffer(&self) -> &Buffer {
        &self.buffers[self.selected_buffer_index()]
    }

    pub fn window_buffer_mut(&mut self) -> &mut Buffer {
        let i = self.selected_buffer_index();
        &mut self.buffers[i]
    }

    /// Where in `buffers` the selected window's buffer is.
    pub(crate) fn selected_buffer_index(&self) -> usize {
        self.window(self.selected_window)
            .and_then(|w| self.buffers.iter().position(|b| b.id == w.buffer))
            .unwrap_or(self.current)
    }

    /// Makes the selected window's buffer current, as Emacs's command loop
    /// does before each command.
    pub(crate) fn current_from_selected_window(&mut self) {
        self.current = if self.minibuffer_window_selected() { self.minibuffer_index() } else { self.selected_buffer_index() };
    }

    /// A buffer by name, to change it without making it current.
    pub fn buffer_named_mut(&mut self, name: &str) -> Option<&mut Buffer> {
        self.buffers.iter_mut().find(|b| b.name == name)
    }

    pub fn buffers(&self) -> &[Buffer] {
        &self.buffers
    }

    /// The buffer an overlay is in, by its index, as Emacs's `overlay-buffer`:
    /// overlay numbers are unique among every buffer's. The current
    /// buffer is looked in first.
    pub fn overlay_buffer_index(&self, id: u64) -> Option<usize> {
        if self.buffer().overlay(id).is_some() {
            return Some(self.current);
        }
        self.buffers.iter().position(|b| b.overlay(id).is_some())
    }

    /// The buffer an overlay is in, to change the overlay there.
    pub fn overlay_buffer_mut(&mut self, id: u64) -> Result<&mut Buffer> {
        let i = self.overlay_buffer_index(id).ok_or_else(|| Error::new(format!("No such overlay: {id}")))?;
        Ok(&mut self.buffers[i])
    }

    /// Kills the text from `beg` to `end`, as Emacs's kill-region from code.
    pub fn kill_region(&mut self, beg: usize, end: usize) -> Result<()> {
        crate::commands::kill_region(self, beg, end)
    }

    /// What a character is in the current buffer's syntax table.
    pub fn char_syntax(&self, c: char) -> crate::syntax_table::Entry {
        self.syntax_tables.entry(&self.buffer().syntax_table, c)
    }

    /// Runs the buffer's `syntax-propertize-function` over the text before
    /// `pos` it has not run over, as Emacs's syntax-propertize, so scans see
    /// the `syntax-table` properties it puts: in stretches of whole lines,
    /// 500 characters at least, the old properties there taken off first.
    /// Scans from scripts call it first.
    pub fn syntax_propertize(&mut self, pos: usize) -> Result<()> {
        let Some(function) = self.variable("syntax-propertize-function").filter(Value::is_true) else { return Ok(()) };
        let b = self.buffer();
        let (done, pos) = (b.syntax_propertized, pos.min(b.len()));
        if done >= pos {
            return Ok(());
        }
        // From the start of the line, as syntax-propertize-wholelines extends it.
        let done = b.line_start(b.line_of(done));
        let line = b.line_of(pos.max(done + 500).min(b.len()));
        let end = if line + 1 < b.line_count() { b.line_start(line + 1) } else { b.len() };
        let b = self.buffer_mut();
        b.syntax_propertized = end;
        b.remove_text_property(done..end, "syntax-table");
        self.funcall(&function, &[Value::Number(done as f64), Value::Number(end as f64)])?;
        Ok(())
    }

    /// Reads the current buffer's accessible text through its syntax table.
    pub fn scanner(&self) -> crate::syntax_table::Scanner<'_> {
        let b = self.buffer();
        let ignore_comments = self.variable("parse-sexp-ignore-comments").is_some_and(|v| v.is_true());
        let mut scanner = crate::syntax_table::Scanner::new(b, &self.syntax_tables, &b.syntax_table, ignore_comments, b.point_min(), b.point_max());
        scanner.lookup_properties = self.variable("parse-sexp-lookup-properties").is_some_and(|v| v.is_true());
        scanner.quit = Some(&self.quitting);
        scanner
    }

    /// A marker's buffer and position, wherever it is; none once it points
    /// nowhere, as a marker whose buffer was killed.
    /// The places of the global mark ring that still exist, the newest
    /// first, as buffer names and positions.
    pub fn global_mark_ring(&self) -> Vec<(String, usize)> {
        self.global_mark_ring.iter().filter_map(|&m| self.marker_position(m).map(|(b, p)| (b.to_string(), p))).collect()
    }

    /// Whether a marker advances past text inserted where it is, as Emacs's
    /// `marker-insertion-type`, a marker pointing nowhere too; None for no such marker.
    pub fn marker_insertion_type(&self, id: u64) -> Option<bool> {
        self.buffers
            .iter()
            .find_map(|b| b.marker_advances(id))
            .or_else(|| self.detached_markers.iter().find(|m| m.id == id).map(|m| m.advances))
    }

    /// Makes a marker advance past text inserted where it is, or not, as
    /// Emacs's `set-marker-insertion-type`, a marker pointing nowhere too.
    pub fn set_marker_insertion_type(&mut self, id: u64, advances: bool) {
        for b in &mut self.buffers {
            if b.set_marker_advances(id, advances) {
                return;
            }
        }
        if let Some(m) = self.detached_markers.iter_mut().find(|m| m.id == id) {
            m.advances = advances;
        }
    }

    pub fn marker_position(&self, id: u64) -> Option<(&str, usize)> {
        self.buffers.iter().find_map(|b| b.marker(id).map(|p| (b.name.as_str(), p)))
    }

    /// Moves a marker to a position in a buffer, as Emacs's `set-marker`,
    /// or nowhere with no buffer.
    pub fn set_marker(&mut self, id: u64, buffer: Option<&str>, pos: usize) -> Result<()> {
        if let Some(name) = buffer
            && self.find_buffer(name).is_none()
        {
            return Err(Error::new(format!("No such buffer {name}")));
        }
        let taken = self.buffers.iter_mut().find_map(|b| b.remove_marker(id)).or_else(|| {
            let i = self.detached_markers.iter().position(|m| m.id == id)?;
            Some(self.detached_markers.remove(i))
        });
        let Some(mut marker) = taken else { return Ok(()) };
        match buffer.and_then(|name| self.buffer_named_mut(name)) {
            Some(b) => {
                marker.pos = pos;
                b.add_marker(marker);
            }
            None => self.detached_markers.push(marker),
        }
        Ok(())
    }

    /// Forgets a marker altogether, once nothing can refer to it.
    pub fn delete_marker(&mut self, id: u64) {
        let _ = self.set_marker(id, None, 0);
        self.detached_markers.retain(|m| m.id != id);
    }

    /// Sets the mark at `pos`, pushing the old one on the buffer's mark
    /// ring, as Emacs's `push-mark`; the new mark goes on the global mark
    /// ring too, unless the newest entry there is in this buffer.
    pub fn push_mark(&mut self, pos: usize, activate: bool) {
        self.buffer_mut().push_mark(pos, activate);
        let newest_here = self.global_mark_ring.first().and_then(|&m| self.marker_position(m)).is_some_and(|(name, _)| name == self.buffer().name);
        if newest_here {
            return;
        }
        let mark = self.buffer().mark().unwrap_or(pos);
        let marker = self.buffers[self.current].make_marker(mark, false);
        self.global_mark_ring.insert(0, marker);
        let max = self.number_in(self.window_buffer(), "global-mark-ring-max", 16.0).max(1.0) as usize;
        while self.global_mark_ring.len() > max {
            let old = self.global_mark_ring.pop().expect("longer than max");
            self.delete_marker(old);
        }
    }

    /// Goes to the newest place on the global mark ring, in its buffer,
    /// and moves it to the end of the ring, as Emacs's `pop-global-mark`.
    pub fn pop_global_mark(&mut self) -> Result<()> {
        // Entries whose buffers were killed go.
        while let Some(&m) = self.global_mark_ring.first() {
            if self.marker_position(m).is_some() {
                break;
            }
            self.global_mark_ring.remove(0);
            self.delete_marker(m);
        }
        let Some(&marker) = self.global_mark_ring.first() else { return Err(Error::new("No global mark set")) };
        self.global_mark_ring.rotate_left(1);
        let (name, pos) = self.marker_position(marker).map(|(n, p)| (n.to_string(), p)).expect("checked above");
        let index = self.find_buffer(&name).expect("the marker's buffer");
        let b = &self.buffers[index];
        if pos < b.point_min() || pos > b.point_max() {
            if self.variable("widen-automatically").is_none_or(|v| v.is_true()) {
                self.buffers[index].widen();
            } else {
                return Err(Error::new(format!("Global mark position is outside accessible part of buffer {name}")));
            }
        }
        self.buffers[index].set_point(pos);
        self.switch_to_buffer(&name);
        Ok(())
    }

    pub fn find_buffer(&self, name: &str) -> Option<usize> {
        self.buffers.iter().position(|b| b.name == name)
    }

    /// Shows a buffer in the selected window and makes it current, as
    /// switch-to-buffer does.
    pub(crate) fn select(&mut self, index: usize) {
        let shown = self.selected_buffer_index();
        if index != shown {
            let selected = self.selected_window;
            self.record_window_buffer(selected);
            self.unshow_buffer(selected);
            self.selected_window_shows(index);
            // From where the buffer was last shown, as set_window_buffer has it.
            let b = &mut self.buffers[index];
            b.top_line = b.line_of(b.last_window_start.min(b.len()));
        }
        self.record_buffer(self.buffers[index].id);
        self.current = index;
    }

    /// The named buffer, made empty if there is none, as Emacs's
    /// `get-buffer-create`. It is not shown.
    pub fn get_buffer_create(&mut self, name: &str) -> usize {
        self.find_buffer(name).unwrap_or_else(|| {
            let buffer = self.new_buffer(name);
            self.buffers.push(buffer);
            self.buffers.len() - 1
        })
    }

    /// A new buffer, with the current buffer's `default-directory` as its
    /// own, as Emacs's `get-buffer-create` gives a buffer it makes.
    fn new_buffer(&self, name: &str) -> Buffer {
        let mut buffer = Buffer::new(name);
        if let Some(dir @ Value::Str(_)) = self.variable("default-directory") {
            buffer.locals.insert("default-directory".to_string(), dir);
        }
        buffer
    }

    /// The index of the live buffer with an id, as a buffer object refers to it.
    pub fn buffer_with_id(&self, id: u64) -> Option<usize> {
        self.buffers.iter().position(|b| b.id == id)
    }

    /// Makes a buffer current without showing it, as Emacs's `set-buffer`:
    /// the selected window keeps showing what it did. Returns the name of
    /// the buffer that was current, to set back.
    pub fn set_current_buffer(&mut self, name: &str) -> Result<String> {
        let old = self.buffer().name.clone();
        let index = self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?;
        self.sync_shared_text();
        self.current = index;
        Ok(old)
    }

    /// Visits a file in a buffer without showing it, as Emacs's
    /// `find-file-noselect`, and returns the buffer's name.
    pub fn find_file_noselect(&mut self, path: &Path) -> Result<String> {
        let (current, shown) = (self.buffers[self.current].id, self.window_buffer().id);
        // Nor does the window note it, or the buffer list.
        let selected = self.selected_window;
        let history = self.window(selected).map(|w| (w.prev_buffers.clone(), w.next_buffers.clone()));
        let (order, buried) = (self.buffer_order.clone(), self.buried.clone());
        let visited = self.visit_file_showing(path, true);
        if let (Some(w), Some((prev, next))) = (self.windows.iter_mut().find(|w| w.id == selected), history) {
            (w.prev_buffers, w.next_buffers) = (prev, next);
        }
        (self.buffer_order, self.buried) = (order, buried);
        let name = self.buffers[self.current].name.clone();
        if let Some(back) = self.buffer_with_id(shown) {
            self.selected_window_shows(back);
        }
        if let Some(back) = self.buffer_with_id(current) {
            self.current = back;
        }
        visited.map(|()| name)
    }

    /// Shows the named buffer, creating an empty one if there is none, as
    /// switch-to-buffer does: where the window last showed it, with its
    /// point there, as `switch-to-buffer-preserve-window-point` says.
    pub fn switch_to_buffer(&mut self, name: &str) {
        let index = self.find_buffer(name).unwrap_or_else(|| {
            let buffer = self.new_buffer(name);
            self.buffers.push(buffer);
            self.buffers.len() - 1
        });
        let selected = self.selected_window;
        let id = self.buffers[index].id;
        let shown = self.window(selected).is_some_and(|w| w.buffer == id);
        let entry = self.window(selected).filter(|w| w.prev_buffers.contains(&id)).and_then(|_| self.buffers[index].prev_entry(selected));
        let preserve = match self.variable_in(&self.buffers[index], "switch-to-buffer-preserve-window-point") {
            Some(Value::Str(s)) if s == "already-displayed" => self.windows.iter().any(|w| w.buffer == id),
            Some(v) => v.is_true(),
            None => false,
        };
        self.select(index);
        if let (false, true, Some((start, point))) = (shown, preserve, entry) {
            let _ = self.set_window_start(selected, start);
            let _ = self.set_window_point(selected, point);
        }
    }

    /// The buffer to offer when switching buffers, as Emacs's
    /// `(other-buffer (current-buffer))`: see [`Editor::other_buffer_than`].
    pub fn other_buffer(&self) -> Option<&str> {
        self.other_buffer_than(self.buffers[self.current].id).map(|i| self.buffers[i].name.as_str())
    }

    /// The buffer list's first buffer other than `buffer`, as Emacs's
    /// `other-buffer`: one no window shows if there is any, else one shown;
    /// internal buffers, whose names start with a space, as the
    /// minibuffer's does, never.
    pub(crate) fn other_buffer_than(&self, buffer: u64) -> Option<usize> {
        let offered: Vec<usize> = self.buffer_list().into_iter().filter(|&i| self.buffers[i].id != buffer && !self.buffers[i].name.starts_with(' ')).collect();
        let shown = |i: &usize| self.windows.iter().any(|w| w.buffer == self.buffers[*i].id);
        offered.iter().copied().find(|i| !shown(i)).or_else(|| offered.first().copied())
    }

    pub fn kill_buffer(&mut self, name: &str) -> Result<()> {
        let index = self
            .find_buffer(name)
            .ok_or_else(|| Error::new(format!("No such buffer: {name}")))?;
        let buffer = &self.buffers[index];
        if buffer.path.is_some() && buffer.is_modified() {
            return Err(Error::new(format!("Buffer {name} is modified; save it first")));
        }
        self.kill_buffer_unsaved(name)
    }

    /// Kills a buffer even if it has unsaved changes, as answering yes to
    /// kill-buffer's question does. Its auto-save file stays, for recovering.
    pub fn kill_buffer_unsaved(&mut self, name: &str) -> Result<()> {
        let index = self
            .find_buffer(name)
            .ok_or_else(|| Error::new(format!("No such buffer: {name}")))?;
        let b = &self.buffers[index];
        if b.id == self.minibuffer_id {
            return Err(Error::new("Cannot kill the minibuffer"));
        }
        if b.path.is_some() && b.is_modified() {
            self.check_permission(&format!("discard the unsaved changes in {name}"))?;
        }
        for indirect in self.indirect_buffers_of(index) {
            self.kill_buffer_unsaved(&indirect)?;
        }
        // As Emacs runs kill-buffer-hook in the buffer, before it goes.
        if self.hook_has_functions("kill-buffer-hook") || self.buffers[index].local_hooks.contains_key("kill-buffer-hook") {
            // The buffer current before, the minibuffer if it was.
            let old = self.buffer().name.clone();
            if self.set_current_buffer(name).is_ok() {
                if let Err(e) = self.run_hooks("kill-buffer-hook") {
                    self.message(format!("Error in kill-buffer-hook: {e}"));
                }
                let _ = self.set_current_buffer(&old);
            }
        }
        // Its process goes with it, as killing a buffer hangs up on Emacs's.
        while let Some(process) = self.buffer_process(name) {
            let _ = self.delete_process(&process);
        }
        let Some(index) = self.find_buffer(name) else { return Ok(()) };
        let gone = self.buffers[index].id;
        // Each window showing it goes back to the buffer it showed before,
        // or is deleted, while the buffer is still there, as Emacs's
        // kill-buffer runs replace-buffer-in-windows first.
        self.replace_buffer_in_windows(gone);
        let Some(index) = self.buffer_with_id(gone) else { return Ok(()) };
        // What a window that found nothing else shows, and what is current
        // if this buffer was: another buffer but internal ones such as the
        // minibuffer, as other-buffer offers, else a new *scratch*.
        let other = self.other_buffer_than(gone).map(|i| self.buffers[i].id);
        let other = other.unwrap_or_else(|| {
            self.buffers.push(Buffer::new("*scratch*"));
            self.buffers[self.buffers.len() - 1].id
        });
        let current = if self.current == index { other } else { self.buffers[self.current].id };
        self.release_lock_of(index);
        let mut removed = self.buffers.remove(index);
        // Its markers point nowhere now.
        self.detached_markers.extend(removed.take_markers());
        let other_index = self.buffer_with_id(other).expect("live");
        let point = self.buffers[other_index].point();
        let selected = self.selected_window;
        for w in &mut self.windows {
            w.prev_buffers.retain(|b| *b != gone);
            w.next_buffers.retain(|b| *b != gone);
            if w.buffer == gone {
                w.buffer = other;
                if w.id != selected {
                    self.buffers[other_index].set_window_point(w.id, point);
                    self.buffers[other_index].set_window_start(w.id, 0);
                }
            }
        }
        self.buffer_order.retain(|b| *b != gone);
        self.current = self.buffer_with_id(current).unwrap_or(other_index);
        Ok(())
    }

    /// The buffers, most recently selected first, as Emacs's `buffer-list`
    /// orders them: by when each was last shown by `switch-to-buffer` or
    /// had its window selected, then those never shown in the order they
    /// were made, then those buried.
    pub fn buffer_list(&self) -> Vec<usize> {
        let mut list: Vec<usize> = self.buffer_order.iter().filter_map(|&id| self.buffer_with_id(id)).collect();
        list.extend((0..self.buffers.len()).filter(|&i| {
            let id = self.buffers[i].id;
            !self.buffer_order.contains(&id) && !self.buried.contains(&id)
        }));
        list.extend(self.buried.iter().filter_map(|&id| self.buffer_with_id(id)));
        list
    }

    /// Puts a buffer first in the buffer list, as Emacs's record_buffer.
    pub(crate) fn record_buffer(&mut self, id: u64) {
        self.buffer_order.retain(|b| *b != id);
        self.buffer_order.insert(0, id);
        self.buried.retain(|b| *b != id);
    }

    /// Puts a buffer last in the buffer list, as Emacs's `bury-buffer-internal`.
    pub fn bury_buffer_internal(&mut self, name: &str) -> Result<()> {
        let index = self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?;
        let id = self.buffers[index].id;
        self.buffer_order.retain(|b| *b != id);
        self.buried.retain(|b| *b != id);
        self.buried.push(id);
        let live: Vec<u64> = self.buffers.iter().map(|b| b.id).collect();
        self.buried.retain(|b| live.contains(b));
        Ok(())
    }

    /// Whether `switch-to-buffer`, and so `find-file`, shows a buffer as the
    /// display actions say, through window.ts's `pop-to-buffer-same-window`,
    /// as `switch-to-buffer-obey-display-actions` asks.
    pub fn obeys_display_actions(&self) -> bool {
        self.variable("switch-to-buffer-obey-display-actions").is_some_and(|v| !v.is_nil())
            && self.command("pop-to-buffer-same-window").is_some()
    }

    /// Visits a file in a buffer, reusing the buffer if the file is already
    /// open, and shows it in the selected window, or, with
    /// `switch-to-buffer-obey-display-actions`, where the display actions
    /// say, as Emacs's `find-file` shows it with `switch-to-buffer`.
    pub fn visit_file(&mut self, path: &Path) -> Result<()> {
        if !self.obeys_display_actions() {
            return self.visit_file_showing(path, true);
        }
        // As find-file-noselect, then switch-to-buffer: read with the buffer
        // current but not shown, then show it.
        let before = self.buffers[self.current].id;
        let visited = self.visit_file_showing(path, false);
        let id = self.buffers[self.current].id;
        let name = self.buffers[self.current].name.clone();
        if let Some(back) = self.buffer_with_id(before) {
            self.current = back;
        }
        visited?;
        if self.buffer_with_id(id).is_some() {
            self.call("pop-to-buffer-same-window", vec![Arg::Str(name)])?;
        }
        Ok(())
    }

    /// Makes a buffer current for visit_file, shown in the selected window when `show`.
    fn visit_select(&mut self, index: usize, show: bool) {
        if show {
            self.select(index);
        } else {
            self.current = index;
        }
    }

    fn visit_file_showing(&mut self, path: &Path, show: bool) -> Result<()> {
        if let Some(index) = self.buffers.iter().position(|b| b.path.as_deref() == Some(path)) {
            self.visit_select(index, show);
            return Ok(());
        }
        let name = path.display().to_string();
        let handled = self.find_file_name_handler(&name, "insert-file-contents").is_some();
        let is_new = if handled { !self.file_exists_p(&name)? } else { !fs::path_exists(path) };
        if handled {
            // A file a handler serves is read through it, as find-file reads
            // with insert-file-contents.
            let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| name.clone());
            let mut buffer = Buffer::new(self.unique_buffer_name(&base));
            buffer.path = Some(path.to_path_buf());
            crate::files::set_file_default_directory(&mut buffer, path);
            self.buffers.push(buffer);
            self.visit_select(self.buffers.len() - 1, show);
            if !is_new {
                let read = self.insert_file_contents(&name, true, None, None, false);
                let b = self.buffer_mut();
                b.set_point(0);
                b.mark_saved();
                b.clear_undo();
                read?;
            }
        } else {
            if fs::path_is_dir(path) {
                return Err(Error::new(format!("{} is a directory", path.display())));
            }
            let mut buffer = Self::read_visited_file(path, self.coding_for_read())?;
            buffer.name = self.unique_buffer_name(&buffer.name);
            // As Emacs's after-find-file, a backup file, whose name ends in ~
            // as backup-file-name-p says, or one that cannot be written is
            // read-only.
            buffer.read_only = path.to_string_lossy().ends_with('~')
                || fs::metadata(path).is_ok_and(|m| m.permissions().readonly());
            self.buffers.push(buffer);
            self.visit_select(self.buffers.len() - 1, show);
        }
        // As Emacs's after-find-file: auto-saving starts, and a newer
        // auto-save file is pointed out.
        if self.variable("auto-save-default").is_none_or(|v| v.is_true()) {
            self.set_auto_save(true);
        }
        if Self::has_newer_auto_save(path) {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            self.message(format!("{name} has auto save data; consider M-x recover-this-file"));
        } else if is_new {
            self.message("(New file)");
        }
        // As Emacs's after-find-file does: choose the major mode, then run the hook.
        if self.command("normal-mode").is_some()
            // As after-find-file calls (normal-mode t): enable-local-variables is obeyed.
            && let Err(e) = self.call("normal-mode", vec![Arg::Prefix(Some(PrefixArg::Number(1)))])
        {
            self.message(format!("File mode specification error: {e}"));
        }
        if let Err(e) = self.run_hooks("find-file-hook") {
            self.message(format!("Error in find-file-hook: {e}"));
        }
        Ok(())
    }

    /// `base`, or the first of `base<2>`, `base<3>` and on that no buffer
    /// has, as Emacs's `generate-new-buffer-name`.
    pub fn unique_buffer_name(&self, base: &str) -> String {
        if self.find_buffer(base).is_none() {
            return base.to_string();
        }
        (2..)
            .map(|n| format!("{base}<{n}>"))
            .find(|name| self.find_buffer(name).is_none())
            .expect("some name is free")
    }

    /// Shows text in the read-only `*Help*` buffer, in another window as
    /// Emacs's `with-help-window` does through `display-buffer`, or in the
    /// selected one without the window commands.
    pub fn show_help(&mut self, text: &str) {
        let index = self.find_buffer("*Help*").unwrap_or_else(|| {
            let mut help = Buffer::new("*Help*");
            help.read_only = true;
            self.buffers.push(help);
            self.buffers.len() - 1
        });
        self.buffers[index].set_text(text);
        if self.command("help-mode").is_some() {
            self.with_current_buffer(index, |ed| {
                let _ = ed.call("help-mode", Vec::new());
            });
        }
        if self.command("display-buffer").is_some() {
            let _ = self.call("display-buffer", vec![crate::Arg::Str("*Help*".into())]);
        } else {
            self.select(index);
        }
    }

    /// A file name made absolute, with relative names in the default
    /// directory, as Emacs's `expand-file-name`.
    pub fn expand_file_name(&self, input: &str) -> PathBuf {
        crate::files::expand_file_name_in(input, &self.default_directory())
    }

    /// Where relative file names are looked up: the current buffer's own
    /// `default-directory`, the directory of its file, or the working
    /// directory.
    pub fn default_directory(&self) -> PathBuf {
        // A buffer's own default-directory, as Dired's, comes first.
        let b = if self.in_minibuffer() { self.window_buffer() } else { self.buffer() };
        if let Some(Value::Str(dir)) = b.locals.get("default-directory") {
            return expand_file_name(dir);
        }
        b.path
            .as_deref()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .or_else(|| fs::current_dir().ok())
            .unwrap_or_default()
    }

    /// Inserts a kill at point as Emacs's `insert-for-yank` does: without
    /// the properties `yank-excluded-properties` names, all of them if it is t.
    pub fn insert_for_yank(&mut self, mut text: crate::properties::Text) -> Result<()> {
        match self.variable("yank-excluded-properties") {
            Some(Value::List(names)) => {
                for (_, props) in &mut text.props {
                    props.retain(|name, _| !names.iter().any(|n| n.as_str() == Some(name)));
                }
                text.props.retain(|(_, props)| !props.is_empty());
            }
            Some(v) if v.is_true() => text.props.clear(),
            _ => {}
        }
        self.insert_text(&text)?;
        // The last character, if it has properties, is rear-nonsticky, so
        // what is typed after it does not take them on, as insert-for-yank-1 does.
        let end = self.buffer().point();
        if !text.string.is_empty() && end > 0 && self.buffer().text_properties_at(end - 1).is_some_and(|p| !p.is_empty()) {
            self.buffer_mut().put_text_property(end - 1..end, "rear-nonsticky", Value::Bool(true));
        }
        Ok(())
    }

    // Minibuffer

    /// What waits for input now, the innermost of the prompt open and the
    /// commands waiting (for a key, a recursive edit's end), as a number
    /// no other prompt or wait has had, or `None` when nothing waits. Who
    /// types keys for someone else, as an agent does, checks it is not
    /// typing into a question someone else opened.
    pub fn waiting_for_input(&self) -> Option<u64> {
        let prompt = self.prompt.as_ref().map(|p| p.serial);
        prompt.max(self.keyboard.wait_serials.last().copied())
    }

    /// Throws away keys typed ahead that nothing read, giving how many: an
    /// agent's keys must not run later as the user's.
    pub fn discard_typeahead(&mut self) -> usize {
        let n = self.keyboard.typeahead.len();
        self.keyboard.typeahead.clear();
        n
    }

    /// The open prompt's text, such as `Find file: `.
    pub fn prompt(&self) -> Option<&str> {
        self.prompt.as_ref().map(|p| p.text.as_str())
    }

    pub fn minibuffer(&self) -> &Buffer {
        &self.buffers[self.minibuffer_index()]
    }

    pub(crate) fn minibuffer_mut(&mut self) -> &mut Buffer {
        let index = self.minibuffer_index();
        &mut self.buffers[index]
    }

    fn initial_input(&self, kind: ParamKind) -> String {
        match kind {
            ParamKind::File => abbreviate_dir(&self.default_directory()),
            _ => String::new(),
        }
    }

    /// Completion candidates for minibuffer input of a given kind, matched
    /// by the styles in `completion-styles`. File names complete by prefix.
    pub fn completions(&self, kind: ParamKind, input: &str) -> Vec<String> {
        let names: Vec<String> = match kind {
            ParamKind::Command => self.command_names().map(str::to_string).collect(),
            ParamKind::Buffer => self.buffer_list().into_iter().map(|i| self.buffers[i].name.clone()).collect(),
            ParamKind::File => {
                let (base, name) = input.rfind('/').map_or(("", input), |i| (&input[..=i], &input[i + 1..]));
                let dir = if base.is_empty() { self.default_directory() } else { expand_file_name(base) };
                let names = crate::minibuffer::file_name_all_completions(&dir);
                let mut found = crate::completion::complete(&self.completion_styles(), name, &names);
                found.retain(|c| c != "./" && c != "../" || name.starts_with('.'));
                found.sort();
                return found.into_iter().map(|c| format!("{base}{c}")).collect();
            }
            ParamKind::Variable => self.variables().map(|v| v.name.clone()).collect(),
            ParamKind::Face => self.faces.keys().cloned().collect(),
            _ => return Vec::new(),
        };
        crate::completion::complete(&self.completion_styles(), input, &names)
    }

    /// The styles in `completion-styles`, in order.
    pub fn completion_styles(&self) -> Vec<String> {
        let strings = |v: &Value| match v {
            Value::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let mut styles: Vec<String> = match self.variable("completion-styles") {
            Some(v @ Value::List(_)) => strings(&v),
            _ => vec!["basic".to_string()],
        };
        // A category's own styles come first, as Emacs's completion--styles
        // takes them from completion-category-overrides or -defaults.
        let category = self.prompt.as_ref().and_then(|_| self.minibuffer_info()).and_then(|i| i.category);
        if let Some(category) = category {
            for table in ["completion-category-overrides", "completion-category-defaults"] {
                let Some(Value::List(entries)) = self.variable(table) else { continue };
                let found = entries.iter().find_map(|e| match e {
                    Value::List(pair) if pair.first().and_then(Value::as_str) == Some(category.as_str()) => pair.get(1).map(strings),
                    _ => None,
                });
                if let Some(own) = found {
                    let mut all = own;
                    all.append(&mut styles);
                    let mut seen = Vec::new();
                    all.retain(|s| if seen.contains(s) { false } else { seen.push(s.clone()); true });
                    styles = all;
                    break;
                }
            }
        }
        styles
    }

    /// Adds an answer to a history variable, newest first, as the minibuffer
    /// does on RET: not an empty answer or a repeat of the newest, and no
    /// more than `history-length` of them.
    pub(crate) fn add_to_history(&mut self, history: &str, answer: &str) {
        // A history of t keeps no history, as read-passwd asks.
        if answer.is_empty() || history == "t" {
            return;
        }
        let mut items = match self.variable(history) {
            Some(Value::List(items)) => items,
            _ => Vec::new(),
        };
        if items.first().and_then(Value::as_str) == Some(answer) {
            return;
        }
        items.insert(0, Value::Str(answer.to_string()));
        let max = self.number_in(self.window_buffer(), "history-length", 100.0).max(1.0) as usize;
        items.truncate(max);
        if self.var(history).is_some() {
            self.set_variable(history, Value::List(items));
        } else {
            self.define_variable(Variable::new(history, "Earlier answers to minibuffer prompts, newest first.", Value::List(items)));
        }
    }

    /// Shows an earlier or later answer in the minibuffer: `step` back
    /// through the history if positive, forward if negative.
    pub(crate) fn minibuffer_history(&mut self, step: i64) -> Result<()> {
        let prompt = self.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?;
        let items: Vec<String> = match self.variable(&prompt.history) {
            Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let pos = prompt.history_pos as i64 + step;
        if pos > items.len() as i64 {
            return Err(Error::new("Beginning of history; no preceding item"));
        }
        if pos < 0 {
            return Err(Error::new("End of history; no default available"));
        }
        let input = self.minibuffer_input();
        let prompt = self.prompt.as_mut().expect("checked above");
        if prompt.history_pos == 0 {
            prompt.typed = input;
        }
        prompt.history_pos = pos as usize;
        let text = if pos == 0 { prompt.typed.clone() } else { items[pos as usize - 1].clone() };
        self.replace_minibuffer_input(&text, text.chars().count());
        Ok(())
    }

    /// Candidates for the open prompt as they should be listed: file names
    /// without the directory part the user has already typed.
    pub fn minibuffer_completions(&self) -> Vec<String> {
        let Some(prompt) = &self.prompt else { return Vec::new() };
        let input = self.minibuffer_input();
        let candidates = self.prompt_completions(&input);
        if prompt.kind != ParamKind::File || prompt.collection.is_some() {
            return candidates;
        }
        let dir_len = input.rfind('/').map_or(0, |i| i + 1);
        candidates.into_iter().map(|c| c[dir_len..].to_string()).collect()
    }

    // Echo area and display

    /// The message in the echo area, if any. It clears on the next key.
    pub fn echo(&self) -> Option<&str> {
        self.message.as_deref()
    }

    /// Shows a message in the echo area and logs it, as Emacs's `message`
    /// does in *Messages*: once more straight after itself, it is counted
    /// rather than logged again.
    pub fn message(&mut self, text: impl Into<String>) {
        let text = text.into();
        if self.noninteractive {
            eprintln!("{text}");
        }
        self.log_message(&text, false);
        self.message = Some(text);
        if let Some(command_loop) = self.command_loop.clone() {
            command_loop.message_shown(self);
        }
    }

    /// Shows the frames as they are now, in the middle of running code, as
    /// Emacs's `redisplay` function does: at startup, before init.ts runs,
    /// so the window shows the editor rather than nothing while it loads.
    /// Does nothing where no window shows the editor.
    pub fn redisplay_now(&mut self) {
        if let Some(command_loop) = self.command_loop.clone() {
            command_loop.show(self);
        }
    }

    /// Shows text in the echo area without logging it, as Emacs shows the
    /// keys of a prefix argument typed so far.
    pub fn message_unlogged(&mut self, text: impl Into<String>) {
        self.message = Some(text.into());
    }

    /// Shows a command's error, logged as interactive Emacs logs it.
    fn show_error(&mut self, text: String) {
        self.log_message(&text, true);
        self.message = Some(text);
    }

    pub(crate) fn log_message(&mut self, text: &str, error: bool) {
        match self.message_log.last_mut() {
            Some(last) if last.text == text && last.error == error => last.count += 1,
            _ => {
                self.message_log.push(LoggedMessage { text: text.to_string(), count: 1, error });
                // As message-log-max keeps the newest thousand lines.
                if self.message_log.len() > 1000 {
                    self.message_log.remove(0);
                }
            }
        }
    }

    /// The messages logged, oldest first, as *Messages* shows them: a
    /// message repeated straight after itself as "Mark set [2 times]".
    pub fn messages(&self) -> Vec<String> {
        self.message_log.iter().map(LoggedMessage::shown).collect()
    }

    /// Empties the log, as erasing *Messages* does.
    pub fn clear_messages(&mut self) {
        self.message_log.clear();
    }

    /// The log, with whether each entry is a command's error, for code that
    /// leaves those out, as batch Emacs logs none.
    pub fn message_log(&self) -> &[LoggedMessage] {
        &self.message_log
    }

    /// Lines of text in the selected window.
    pub fn viewport_height(&self) -> usize {
        self.selected_window_height()
    }

    /// Tells the editor how many lines the selected window shows. With more
    /// than one window, front ends use [`Editor::set_window_size`] instead.
    pub fn set_viewport_height(&mut self, lines: usize) {
        self.set_selected_window_height(lines);
    }

    /// Scrolls the selected window so point is visible, recentring when it
    /// has moved off screen.
    pub fn ensure_point_visible(&mut self) {
        if !self.metrics.uniform() {
            return self.ensure_point_visible_by_height();
        }
        let height = self.viewport_height();
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let point_row = self.row_line_in(b, b.line_of(b.point()));
        let mut top = self.row_line_in(b, b.top_line.min(b.line_count() - 1));
        // Screen rows from the top of the window down to point's, counting
        // continued lines, up to the window's height.
        let mut visible = point_row >= top;
        if visible {
            let (_, k, _) = self.screen_position(b, b.point(), wrap);
            let (mut line, mut rows) = (top, k);
            while line < point_row && rows < height {
                rows += self.screen_height_in(b, line, wrap);
                line = self.move_rows_in(b, line, 1).0;
            }
            visible = rows < height;
        }
        if !visible {
            let (_, k, _) = self.screen_position(b, b.point(), wrap);
            let back = (height / 2).saturating_sub(k) as i64;
            top = if back == 0 { point_row } else { self.move_screen_rows_in(b, point_row, -back, wrap).0 };
        }
        self.window_buffer_mut().top_line = top;
    }

    /// As [`Editor::ensure_point_visible`], counting rows by their heights:
    /// point's row must show whole, and recentring puts half the window's
    /// height above it.
    fn ensure_point_visible_by_height(&mut self) {
        let height = self.viewport_height() as f32;
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let point = b.point();
        let point_row = self.row_line_in(b, b.line_of(point));
        let top = self.row_line_in(b, b.top_line.min(b.line_count() - 1));
        if point_row >= top {
            let mut y = 0.0;
            for row in self.rows_in(b, top, self.viewport_height() * 2 + 1, true, wrap) {
                let h = self.row_height(b, &row);
                if row.shows_point(point) && !row.in_string {
                    if y + h <= height || y == 0.0 {
                        return;
                    }
                    break;
                }
                y += h;
                if y >= height {
                    break;
                }
            }
        }
        // Rows above point's, back up the window, until they fill half of it.
        let (rows, k, _) = self.screen_position(b, point, wrap);
        let mut above: f32 = rows[..k].iter().map(|r| self.row_height(b, r)).sum();
        let mut new_top = point_row;
        while above < height / 2.0 {
            let (line, moved) = self.move_rows_in(b, new_top, -1);
            if moved == 0 {
                break;
            }
            let rows = self.screen_rows_of(b, line, wrap);
            let h: f32 = rows.iter().map(|r| self.row_height(b, r)).sum();
            if above + h > height / 2.0 && above > 0.0 {
                break;
            }
            above += h;
            new_top = line;
        }
        self.window_buffer_mut().top_line = new_top;
    }

    pub fn should_quit(&self) -> bool {
        self.quit
    }

    /// How many times `suspend-emacs` asked the front end to stop the
    /// process: a terminal stops it each time the count goes up, and runs
    /// `suspend-resume-hook` once the shell continues it.
    pub fn suspend_requests(&self) -> u64 {
        self.suspend_requests
    }

    /// Asks the front end to stop the process, as Emacs's `suspend-emacs`:
    /// runs `suspend-hook` first. A window has no shell to continue it, so
    /// there it is an error.
    pub fn suspend_emacs(&mut self) -> Result<()> {
        // A front end that shows images is a window, as window-system says.
        if self.text_metrics().images() {
            return Err(Error::signal("user-error", "Cannot suspend E8 in a window; C-z iconifies it", Vec::new()));
        }
        // Stopping the editor while an agent acts would stop its requests too.
        self.check_permission("suspend E8")?;
        self.run_hooks("suspend-hook")?;
        self.suspend_requests += 1;
        Ok(())
    }

    /// The status the program should exit with, as `kill-emacs` was given.
    pub fn exit_status(&self) -> i32 {
        self.exit_status
    }

    /// Whether the editor runs without a frame, as Emacs's `noninteractive`.
    pub fn noninteractive(&self) -> bool {
        self.noninteractive
    }

    /// Runs the editor without a frame, as `emacs --batch` does: each
    /// message is printed to standard error as well as logged, and the
    /// `noninteractive` variable says so to scripts.
    pub fn set_noninteractive(&mut self, on: bool) {
        self.noninteractive = on;
        self.set_variable("noninteractive", crate::Value::Bool(on));
    }
}

