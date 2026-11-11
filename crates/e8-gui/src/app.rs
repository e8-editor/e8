//! The editor window: the buffer, the mode line and the echo area, drawn
//! each frame from the frame description the editor last published, never
//! asking the editor while it draws, as the terminal front end does.

use std::any::Any;
use std::sync::{Arc, Mutex};

use e8_core::display::{Glyph, cursor_glyph};
use e8_core::driver::{Driver, Input as DriverInput};
use e8_core::frame_description::{Chrome, Echo, FrameDescription, RowDescription, WindowDescription};
use e8_core::layout::FontSpec;
use e8_core::{Editor, FrameId, Key, ModeLineSegment, Row, Style, WindowId};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, FontFamily, FontId, Galley, Painter, PointerButton, Pos2, Rect, Stroke, StrokeKind, Ui,
    ViewportCommand, pos2, vec2,
};

use crate::fringe;
use crate::image;
use crate::keys::{Input, translate};
use crate::metrics::{EguiMetrics, font_id};
use crate::theme::{self, LINE_SPACING, TEXT_SIZE, Tokens, color32};

/// Space around the buffer text.
const PAD_X: f32 = 16.0;
const PAD_Y: f32 = 12.0;
/// Space above and below the text of the mode line and echo area.
const BAR_PAD: f32 = 6.0;
/// The height of a macOS window's title bar, which a transparent one
/// leaves the window to draw under.
const TITLE_BAR_HEIGHT: f32 = 28.0;

/// A window whose title bar is transparent, drawn under by the window, as
/// Emacs's frames with `ns-transparent-titlebar`: macOS draws the title and
/// buttons, and dragging the bar still moves the window.
pub fn transparent_title_bar(builder: egui::ViewportBuilder) -> egui::ViewportBuilder {
    builder.with_titlebar_shown(false).with_fullsize_content_view(true)
}

pub struct E8App {
    /// The editor: on a thread of its own, or on this one, for tests.
    backend: Backend,
    /// What each frame shows, as the editor last described it.
    frames: Vec<FrameDescription>,
    /// Which publication `frames` came from, with the editor on its own thread.
    generation: u64,
    /// Whether the editor wants to exit, as `C-x C-c` does.
    exit: bool,
    /// Whether the bell rang, and if so whether it flashes.
    bell: Option<bool>,
    title: String,
    mac: bool,
    /// Smooth scrolling's offset, shared with the editor's thread, which
    /// moves whole lines.
    scroll: Arc<Mutex<Scroll>>,
    mouse: Arc<Mutex<Mouse>>,
    /// Messages from an agent through e8-mcp, answered between frames.
    #[cfg(not(target_arch = "wasm32"))]
    agent: Option<std::sync::mpsc::Receiver<e8_mcp::socket::Request>>,
    /// What the editor remembers of the socket's client, so it cannot answer
    /// a question it did not ask.
    #[cfg(not(target_arch = "wasm32"))]
    agent_client: std::sync::Arc<std::sync::Mutex<e8_mcp::Client>>,
    /// The frame this native window shows; the others get windows of their own.
    main_frame: FrameId,
    /// Each frame's last title, and the frame last selected, to focus its
    /// window when another is selected.
    titles: std::collections::HashMap<FrameId, String>,
    focused_frame: FrameId,
    /// Until when the frame flashes for the bell, with `visible-bell`, in egui's seconds.
    flash_until: Option<f64>,
    /// Whether the bell sounds without `visible-bell`; tests keep it quiet.
    audible_bell: bool,
    /// Whether the primary button is down, so moves are drags.
    button_down: bool,
    /// Whether font families faces named were loaded last frame, for the
    /// editor to measure text in them from this one.
    fonts_loaded: bool,
    /// What each frame's layout last told the editor, so it is told again
    /// only when it changes.
    told: std::collections::HashMap<FrameId, Sizes>,
    /// Whether frames' windows draw under a transparent title bar, in the
    /// theme's background, as Emacs's `ns-transparent-titlebar` has them.
    title_bar: bool,
    /// Whether each frame's window was last told to look dark, as the
    /// editor judges its background, so its title and buttons show against
    /// the background drawn under them.
    appearance: std::collections::HashMap<FrameId, bool>,
    /// Each frame's visibility and raise count as last acted on, to act
    /// again when `make-frame-visible`, `iconify-frame` or `raise-frame` change them.
    frame_states: std::collections::HashMap<FrameId, (e8_core::frame_description::Visibility, u64)>,
}

/// Where the editor runs.
enum Backend {
    /// On this thread: what is sent runs at once, and frames are described
    /// as they are drawn, as tests drive it, deterministically.
    Inline { editor: Box<Editor>, keep: Box<dyn Any> },
    /// On a thread of its own (docs/multithreading.md, step 3): input goes
    /// to it and the window draws what it last published, never waiting.
    Thread { driver: Driver, look: Arc<Mutex<(bool, f32)>> },
}

impl Backend {
    /// Runs `f` with the editor and what its setup kept: now, or in turn
    /// on the editor's thread.
    fn run(&mut self, f: impl FnOnce(&mut Editor, &dyn Any) + Send + 'static) {
        match self {
            Backend::Inline { editor, keep } => f(editor, &**keep),
            Backend::Thread { driver, .. } => driver.send(DriverInput::Run(Box::new(f))),
        }
    }

    fn key(&mut self, key: Key) {
        match self {
            Backend::Inline { editor, .. } => editor.handle_key(key),
            Backend::Thread { driver, .. } => driver.key(key),
        }
    }
}

/// Smooth scrolling: how far the view is scrolled past the window's top
/// line, in points, always less than one line, whole lines being the
/// core's `top_line`; the window it applies to, the one last scrolled; and
/// the window, buffer and top line it belongs to, so that when something
/// else moves the view, such as C-v or switching buffers, it resets.
#[derive(Default)]
struct Scroll {
    offset: f32,
    window: WindowId,
    anchor: (WindowId, String, usize),
}

/// The state of the primary button, for turning presses and moves into
/// Emacs's mouse keys.
#[derive(Default)]
struct Mouse {
    /// Clicks over the text, as both front ends count them.
    clicks: e8_core::clicks::Clicks<Pos2>,
    /// A mode line or divider being dragged: its window, whether it is a
    /// divider, and where along the drag the edge last moved to.
    resizing: Option<(WindowId, bool, f32)>,
}

impl eframe::App for E8App {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        self.show(ui);
    }
}

impl E8App {
    /// A window on an editor on this thread, as tests use.
    pub fn new(mut editor: Editor) -> E8App {
        crate::modeline::install(&mut editor);
        E8App::with_backend(Backend::Inline { editor: Box::new(editor), keep: Box::new(Option::<e8_script::Scripting>::None) })
    }

    /// A window on an editor on a thread of its own, made there by
    /// `setup`, which returns the script runtime the editor keeps. `ctx` is
    /// woken when the editor has something new to draw.
    pub fn threaded(ctx: &egui::Context, setup: impl FnOnce(&mut Editor) -> Option<e8_script::Scripting> + Send + 'static) -> E8App {
        let wake = ctx.clone();
        E8App::threaded_waking(ctx, move || wake.request_repaint(), setup)
    }

    /// As [`E8App::threaded`], the editor's thread calling `wake` when it
    /// has something new to draw. A web build wakes the window by a message
    /// rather than through egui's context, whose lock the browser's main
    /// thread could find taken and may not wait for.
    pub fn threaded_waking(
        ctx: &egui::Context,
        wake: impl Fn() + Send + 'static,
        setup: impl FnOnce(&mut Editor) -> Option<e8_script::Scripting> + Send + 'static,
    ) -> E8App {
        let look = Arc::new(Mutex::new((true, ctx.pixels_per_point())));
        let described = look.clone();
        let driver = Driver::spawn(
            move |editor| {
                crate::modeline::install(editor);
                Box::new(setup(editor))
            },
            move |editor| {
                let (dark, scale) = *described.lock().unwrap_or_else(|e| e.into_inner());
                editor.set_system_dark(dark);
                // The echo area grows for a minibuffer of several lines, as
                // vertico's list makes it, before the frame is described: the
                // window is told sizes only when they change, and the
                // minibuffer's lines change without them.
                let frame_lines = editor.frame_lines();
                editor.mini_window_height(frame_lines);
                editor.redisplay();
                editor.frame_list().into_iter().map(|f| editor.describe_frame(f, scale)).collect()
            },
            wake,
        );
        E8App::with_backend(Backend::Thread { driver, look })
    }

    fn with_backend(backend: Backend) -> E8App {
        E8App {
            backend,
            frames: Vec::new(),
            generation: 0,
            exit: false,
            bell: None,
            title: String::new(),
            mac: cfg!(target_os = "macos"),
            scroll: Default::default(),
            mouse: Default::default(),
            #[cfg(not(target_arch = "wasm32"))]
            agent: None,
            #[cfg(not(target_arch = "wasm32"))]
            agent_client: Default::default(),
            main_frame: 1,
            titles: std::collections::HashMap::new(),
            focused_frame: 1,
            flash_until: None,
            audible_bell: true,
            button_down: false,
            fonts_loaded: false,
            told: std::collections::HashMap::new(),
            title_bar: false,
            appearance: std::collections::HashMap::new(),
            frame_states: std::collections::HashMap::new(),
        }
    }

    /// Runs `f` with the editor and waits for its answer: at once on this
    /// thread, or in turn on the editor's own.
    pub fn with_editor<T: Send + 'static>(&mut self, f: impl FnOnce(&mut Editor) -> T + Send + 'static) -> T {
        match &mut self.backend {
            Backend::Inline { editor, .. } => f(editor),
            Backend::Thread { driver, .. } => driver.with(f),
        }
    }

    /// Runs `f` with the editor without waiting for it.
    pub fn run(&mut self, f: impl FnOnce(&mut Editor) + Send + 'static) {
        self.backend.run(move |editor, _| f(editor));
    }

    /// Types a key, as one from the keyboard is, for keys that come from
    /// elsewhere: the web page's own keys on a touch screen.
    pub fn key(&mut self, key: Key) {
        self.backend.key(key);
    }

    /// Shows a message in the echo area, as the editor's `message` does.
    pub fn message(&mut self, text: String) {
        self.backend.run(move |editor, _| editor.message(text));
    }

    /// The editor, when it runs on this thread, as in tests.
    pub fn editor(&self) -> &Editor {
        match &self.backend {
            Backend::Inline { editor, .. } => editor,
            Backend::Thread { .. } => panic!("the editor runs on a thread of its own"),
        }
    }

    /// The same window with a bell that makes no sound, for tests.
    pub fn silent(mut self) -> E8App {
        self.audible_bell = false;
        self
    }

    /// The same window drawing under a title bar made transparent, as
    /// macOS windows built with [`transparent_title_bar`] have: the bar
    /// takes the theme's background, and the window looks dark or light
    /// as that background is, rather than as egui's theme is.
    pub fn with_title_bar(mut self, ctx: &egui::Context) -> E8App {
        ctx.options_mut(|o| o.sync_window_theme = false);
        self.title_bar = true;
        self
    }

    /// Answers an agent's messages from `requests`, as e8-mcp passes them
    /// on, with the editor this window shows. An editor on this thread
    /// keeps `scripting` too, which commands that scripts define need alive.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_agent(
        mut self,
        requests: Option<std::sync::mpsc::Receiver<e8_mcp::socket::Request>>,
        scripting: Option<e8_script::Scripting>,
    ) -> E8App {
        self.agent = requests;
        if let Backend::Inline { keep, .. } = &mut self.backend {
            *keep = Box::new(scripting);
        }
        self
    }

    /// Rings the bell when a command did: flashes the frame briefly with
    /// `visible-bell` set, else sounds the system's beep, as Emacs's Mac
    /// port calls `NSBeep`. Elsewhere egui has no sound, so it flashes.
    fn flash(&mut self, ui: &Ui) {
        let now = ui.input(|i| i.time);
        if let Some(visible) = self.bell.take() {
            if visible || !cfg!(target_os = "macos") {
                self.flash_until = Some(now + 0.1);
            } else if self.audible_bell {
                #[cfg(target_os = "macos")]
                objc2_app_kit::NSBeep();
            }
        }
        match self.flash_until {
            Some(until) if now < until => {
                let color = if ui.visuals().dark_mode { Color32::from_white_alpha(40) } else { Color32::from_black_alpha(40) };
                let layer = egui::LayerId::new(egui::Order::Foreground, egui::Id::unique("visible-bell"));
                ui.painter().clone().with_layer_id(layer).rect_filled(ui.max_rect(), 0.0, color);
                ui.ctx().request_repaint_after(std::time::Duration::from_secs_f64(until - now));
            }
            _ => self.flash_until = None,
        }
    }

    /// Answers the agent's waiting messages, each as one call of its own,
    /// with the editor and its script runtime.
    #[cfg(not(target_arch = "wasm32"))]
    fn answer_agent(&mut self) {
        let Some(requests) = &self.agent else { return };
        let waiting: Vec<_> = requests.try_iter().collect();
        for request in waiting {
            let client = self.agent_client.clone();
            self.backend.run(move |editor, keep| {
                let scripting = keep.downcast_ref::<Option<e8_script::Scripting>>().and_then(Option::as_ref);
                let mut client = client.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                let reply = e8_mcp::handle_client_message(editor, scripting, &request.line, &mut client);
                let _ = request.reply.send(reply);
            });
        }
    }

    /// Takes in what the editor last published, when it runs on a thread of
    /// its own; on this one, runs its timers and takes its bell.
    fn refresh(&mut self, ctx: &egui::Context, dark: bool) {
        match &mut self.backend {
            Backend::Inline { editor, .. } => {
                // Timers and auto-saving, and a wake-up for the next one due.
                editor.run_timers();
                if let Some(due) = editor.next_timer_in() {
                    ctx.request_repaint_after(due);
                }
                if editor.take_bell() {
                    self.bell = Some(editor.variable("visible-bell").is_some_and(|v| v.is_true()));
                }
                self.exit = editor.should_quit();
            }
            Backend::Thread { driver, look } => {
                // A browser's main thread may not wait for a lock, so there
                // the window only tries, and looks again next frame.
                #[cfg(target_arch = "wasm32")]
                let (look, published) = (look.try_lock().ok(), driver.try_published());
                #[cfg(not(target_arch = "wasm32"))]
                let (look, published) = (Some(look.lock().unwrap_or_else(|e| e.into_inner())), Some(driver.published()));
                if let Some(mut look) = look {
                    *look = (dark, ctx.pixels_per_point());
                }
                let Some(mut published) = published else {
                    ctx.request_repaint();
                    return;
                };
                if published.generation != self.generation {
                    self.generation = published.generation;
                    self.frames = published.frames.clone();
                }
                if std::mem::take(&mut published.bell) {
                    self.bell = Some(published.visible_bell);
                }
                self.exit = published.exit;
            }
        }
    }

    /// A frame's visibility and how many times it has been raised.
    fn frame_state(&self, frame: FrameId) -> (e8_core::frame_description::Visibility, u64) {
        use e8_core::frame_description::Visibility;
        match &self.backend {
            Backend::Inline { editor, .. } => {
                let visibility = match editor.frame_visibility(frame) {
                    e8_core::Value::Null | e8_core::Value::Bool(false) => Visibility::Hidden,
                    v if v.as_str() == Some("icon") => Visibility::Iconified,
                    _ => Visibility::Visible,
                };
                (visibility, editor.frame_raises(frame))
            }
            Backend::Thread { .. } => self.frames.iter().find(|f| f.frame == frame).map_or_else(Default::default, |f| (f.visibility, f.raised)),
        }
    }

    /// Shows, hides, iconifies or raises each frame's native window as its
    /// state changed since last time, as `make-frame-visible`,
    /// `make-frame-invisible`, `iconify-frame` and `raise-frame` ask.
    fn follow_frame_states(&mut self, ctx: &egui::Context, frames: &[FrameId]) {
        use e8_core::frame_description::Visibility;
        for &frame in frames {
            let state = self.frame_state(frame);
            // A frame not seen before, or newly drawn in the main window,
            // gets its visibility whatever it is.
            let old = self.frame_states.insert(frame, state).unwrap_or((Visibility::Hidden, state.1));
            if old == state {
                continue;
            }
            let viewport = if frame == self.main_frame { egui::ViewportId::ROOT } else { frame_viewport(frame) };
            if old.0 != state.0 {
                match state.0 {
                    Visibility::Visible => {
                        ctx.send_viewport_cmd_to(viewport, ViewportCommand::Visible(true));
                        ctx.send_viewport_cmd_to(viewport, ViewportCommand::Minimized(false));
                    }
                    Visibility::Hidden => ctx.send_viewport_cmd_to(viewport, ViewportCommand::Visible(false)),
                    Visibility::Iconified => ctx.send_viewport_cmd_to(viewport, ViewportCommand::Minimized(true)),
                }
            }
            if state.1 > old.1 {
                ctx.send_viewport_cmd_to(viewport, ViewportCommand::Focus);
            }
        }
        self.frame_states.retain(|f, _| frames.contains(f));
    }

    /// The frames there are, and the one selected.
    fn frame_list(&self) -> (Vec<FrameId>, FrameId) {
        match &self.backend {
            Backend::Inline { editor, .. } => (editor.frame_list(), editor.selected_frame()),
            Backend::Thread { .. } => (
                self.frames.iter().map(|f| f.frame).collect(),
                self.frames.iter().find(|f| f.selected).map_or(self.main_frame, |f| f.frame),
            ),
        }
    }

    /// Handles this frame's input and draws the editor into `ui`: the main
    /// frame here, and each other frame in a native window of its own.
    pub fn show(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        // Font families faces named load now, and the editor measures in
        // them from the next frame, once egui has them.
        if std::mem::take(&mut self.fonts_loaded) {
            let m = Metrics::of(ui);
            let (char_width, line_height, fonts) = (m.char_width, m.line_height, ctx.clone());
            self.backend.run(move |editor, _| {
                editor.set_text_metrics(Arc::new(EguiMetrics::new(fonts, char_width, line_height)));
            });
        }
        if theme::load_wanted_families(&ctx) {
            self.fonts_loaded = true;
            ctx.request_repaint();
        }
        self.handle_close(&ctx);
        #[cfg(not(target_arch = "wasm32"))]
        self.answer_agent();
        self.refresh(&ctx, Tokens::get(&ctx).dark);
        self.flash(ui);
        let (frames, selected) = self.frame_list();
        if frames.is_empty() {
            // The editor's thread has not described a frame yet: keys typed
            // meanwhile still go to it, in order.
            ui.painter().rect_filled(ui.max_rect(), 0.0, Tokens::get(&ctx).bg);
            let events = ctx.input(|i| i.events.clone());
            for input in translate(&events, self.mac) {
                match input {
                    Input::Key(key) => self.backend.key(key),
                    Input::Command(name) => self.backend.run(move |editor, _| editor.command_execute(name)),
                }
            }
            return;
        }
        // Where native windows cannot open, embedded in this one instead, as
        // in tests, this window shows the selected frame, as a terminal does.
        if ctx.embed_viewports() {
            self.main_frame = selected;
            let main = self.main_frame;
            self.show_frame(ui, main);
            return;
        }
        if !frames.contains(&self.main_frame) {
            self.main_frame = *frames.last().expect("there is always a frame");
            // The main window may be hidden or minimized from the frame it showed.
            self.frame_states.remove(&self.main_frame);
        }
        let main = self.main_frame;
        self.show_frame(ui, main);
        for frame in frames {
            if frame == main {
                continue;
            }
            let title = self.titles.get(&frame).cloned().unwrap_or_else(|| "E8".into());
            let mut builder = egui::ViewportBuilder::default().with_title(title).with_inner_size([960.0, 680.0]);
            if self.title_bar {
                builder = transparent_title_bar(builder);
            }
            ctx.show_viewport_immediate(frame_viewport(frame), builder, |ctx, _class| {
                // Closing a frame's window deletes the frame.
                if ctx.input(|i| i.viewport().close_requested()) {
                    self.backend.run(move |editor, _| {
                        let _ = editor.delete_frame(Some(frame));
                    });
                    return;
                }
                egui::CentralPanel::default().frame(egui::Frame::NONE).show(ctx, |ui| self.show_frame(ui, frame));
            });
        }
        let (all, _) = self.frame_list();
        self.follow_frame_states(&ctx, &all);
        // A frame newly selected, as by C-x 5 o, gets the focus.
        let (_, selected) = self.frame_list();
        if selected != self.focused_frame {
            self.focused_frame = selected;
            let viewport = if selected == self.main_frame { egui::ViewportId::ROOT } else { frame_viewport(selected) };
            ctx.send_viewport_cmd_to(viewport, ViewportCommand::Focus);
        }
    }

    /// Lays a frame out: from the editor, telling it each window's size,
    /// or from its last description, sending the sizes to its thread.
    fn layout(&mut self, ui: &Ui, frame: FrameId) -> Option<Layout> {
        let m = Metrics::of(ui);
        match &mut self.backend {
            Backend::Inline { editor, .. } => Some(Layout::new(ui, editor, frame, m)),
            Backend::Thread { driver, .. } => {
                let fd = self.frames.iter().find(|f| f.frame == frame)?;
                let layout = Layout::described(ui, fd, m);
                let sizes = layout.sizes(fd.selected);
                // Told again only when they change, as telling the editor
                // anything has it describe its frames again.
                if self.told.get(&frame) != Some(&sizes) {
                    self.told.insert(frame, sizes.clone());
                    let ctx = ui.ctx().clone();
                    driver.run(move |editor| {
                        set_metrics(editor, &ctx, sizes.metrics.0, sizes.metrics.1);
                        apply_sizes(editor, &sizes);
                    });
                }
                Some(layout)
            }
        }
    }

    /// Handles one frame's input, in the native window that shows it, and
    /// draws it. Input there selects the frame first, as clicking or typing
    /// in an Emacs frame selects it.
    fn show_frame(&mut self, ui: &mut Ui, frame: FrameId) {
        let ctx = ui.ctx().clone();
        // Full screen, macOS hides the title bar until the pointer reaches it.
        if !self.title_bar || ctx.input(|i| i.viewport().fullscreen.unwrap_or(false)) {
            self.show_frame_below(ui, frame);
            return;
        }
        let (bar, below) = ui.max_rect().split_top_bottom_at_y(ui.max_rect().top() + TITLE_BAR_HEIGHT);
        let mut inner = ui.new_child(egui::UiBuilder::new().max_rect(below));
        let t = self.show_frame_below(&mut inner, frame).unwrap_or_else(|| Tokens::get(&ctx));
        ui.painter().rect_filled(bar, 0.0, t.bg);
        let dark = t.dark;
        if self.appearance.get(&frame) != Some(&dark) {
            self.appearance.insert(frame, dark);
            ctx.send_viewport_cmd(ViewportCommand::SetTheme(if dark { egui::SystemTheme::Dark } else { egui::SystemTheme::Light }));
        }
    }

    /// Shows a frame in `ui`, below any title bar, and gives the colours
    /// it was drawn in.
    fn show_frame_below(&mut self, ui: &mut Ui, frame: FrameId) -> Option<Tokens> {
        let ctx = ui.ctx().clone();
        let events = ctx.input(|i| i.events.clone());
        let input = events.iter().any(|e| {
            matches!(
                e,
                egui::Event::Key { pressed: true, .. }
                    | egui::Event::Text(_)
                    | egui::Event::Paste(_)
                    | egui::Event::PointerButton { pressed: true, .. }
                    | egui::Event::MouseWheel { .. }
            )
        });
        if input && frame != self.frame_list().1 {
            self.backend.run(move |editor, _| {
                let _ = editor.select_frame(frame);
            });
            self.focused_frame = frame;
        }
        let selected = frame == self.frame_list().1;
        // Window sizes first, for the commands this frame's keys run.
        let Some(before) = self.layout(ui, frame) else { return None };
        if selected {
            let time = ctx.input(|i| i.time);
            for event in &events {
                self.pointer(event, &before, time);
            }
            for input in translate(&events, self.mac) {
                match input {
                    Input::Key(key) => self.backend.key(key),
                    Input::Command(name) => self.backend.run(move |editor, _| editor.command_execute(name)),
                }
            }
        }
        if !self.frame_list().0.contains(&frame) {
            return None;
        }
        let frame_selected = frame == self.frame_list().1;
        // Input may have split or deleted windows.
        let Some(layout) = self.layout(ui, frame) else { return None };
        if frame_selected {
            self.scroll(&ctx, &layout);
        }
        let description = match &mut self.backend {
            Backend::Inline { editor, .. } => {
                editor.set_system_dark(Tokens::get(&ctx).dark);
                editor.redisplay();
                self.exit = editor.should_quit();
                editor.describe_frame(frame, ctx.pixels_per_point())
            }
            Backend::Thread { .. } => match self.frames.iter().find(|f| f.frame == frame) {
                Some(fd) => fd.clone(),
                None => return None,
            },
        };
        // The palette for the background the editor judges the frame has,
        // a theme's rather than the system's, and the theme's colours over
        // it where its faces give them.
        let t = Tokens::new(description.dark).themed(&description);
        // The view moved some other way than by the wheel, as by C-v or
        // switching buffers: no offset.
        if frame_selected {
            let mut scroll = self.scroll.lock().unwrap_or_else(|e| e.into_inner());
            let view = description.windows.iter().find(|w| w.id == scroll.window).map_or((0, String::new(), 0), |w| (w.id, w.buffer.clone(), w.top_line));
            if view != scroll.anchor {
                scroll.offset = 0.0;
                scroll.anchor = view;
            }
        }

        if self.exit {
            ctx.send_viewport_cmd_to(egui::ViewportId::ROOT, ViewportCommand::Close);
        }
        self.update_title(&ctx, frame, &description.title);
        // The selected frame's window types into it, so only it shows filled cursors.
        let focused = ctx.input(|i| i.focused) && frame_selected;
        let scroll = if frame_selected {
            let s = self.scroll.lock().unwrap_or_else(|e| e.into_inner());
            (s.window, s.offset)
        } else {
            (0, 0.0)
        };
        draw(ui, &description, &layout, t, focused, scroll);
        Some(t)
    }

    /// Turns presses, moves and releases of the primary button into
    /// `<down-mouse-1>`, `<drag-mouse-1>`, `<mouse-1>`, `<double-mouse-1>`
    /// and `<triple-mouse-1>`, with Shift as `S-`, and drags of a mode line
    /// or divider into resizing, on the editor's thread.
    fn pointer(&mut self, event: &egui::Event, layout: &Layout, time: f64) {
        let (pos, pressed, shift) = match event {
            egui::Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers } => {
                self.button_down = *pressed;
                (*pos, Some(*pressed), modifiers.shift)
            }
            // Moves matter only while the button is down, for drags.
            egui::Event::PointerMoved(pos) if self.button_down => (*pos, None, false),
            _ => return,
        };
        let (mouse, scroll, layout) = (self.mouse.clone(), self.scroll.clone(), layout.clone());
        self.backend.run(move |ed, _| {
            let mut mouse = mouse.lock().unwrap_or_else(|e| e.into_inner());
            if pressed.is_none() && !mouse.clicks.is_down() && mouse.resizing.is_none() {
                return;
            }
            let offset = {
                let s = scroll.lock().unwrap_or_else(|e| e.into_inner());
                (s.window, s.offset)
            };
            pointer(ed, &mut mouse, pos, pressed, shift, &layout, time, offset);
        });
    }

    /// Smooth scrolling from the mouse wheel or a trackpad. egui smooths
    /// notched wheels over a few frames; trackpads give points directly.
    /// Whole lines go to the editor as wheel events, which run mwheel-scroll
    /// like any key, and the remainder is drawn as an offset.
    fn scroll(&mut self, ctx: &egui::Context, layout: &Layout) {
        let line_height = layout.m.line_height;
        // Positive y moves the content down, revealing earlier lines.
        let dy = ctx.input(|i| i.smooth_scroll_delta.y);
        if dy == 0.0 {
            return;
        }
        // The window under the pointer scrolls, selected or not, as in Emacs.
        let hover = ctx.input(|i| i.pointer.hover_pos());
        let under = hover.and_then(|p| layout.windows.iter().find(|w| w.rect.contains(p))).map(|w| w.id);
        let scroll = self.scroll.clone();
        self.backend.run(move |ed, _| {
            let window = under.unwrap_or(ed.selected_window());
            let mut s = scroll.lock().unwrap_or_else(|e| e.into_inner());
            if window != s.window {
                s.window = window;
                s.offset = 0.0;
            }
            let top_of = |ed: &Editor| ed.windows().into_iter().find(|w| w.id == window).map(|w| (w.top_line, w.buffer.line_count(), w.buffer.name.clone()));
            let Some((top, lines, _)) = top_of(ed) else { return };
            let wanted = (top as f32 * line_height + s.offset - dy).clamp(0.0, (lines - 1) as f32 * line_height);
            let wanted_top = (wanted / line_height).floor() as usize;
            ed.wheel_in(Some(window), wanted_top as isize - top as isize);
            let (top, name) = top_of(ed).map_or((0, String::new()), |(top, _, name)| (top, name));
            // If the wheel is bound to something else, there is nothing to offset.
            s.offset = if top == wanted_top { wanted - top as f32 * line_height } else { 0.0 };
            s.anchor = (window, name, top);
        });
    }

    /// Closing the window runs save-buffers-kill-terminal, as C-x C-c does:
    /// with unsaved files the window stays open while it asks about them,
    /// and closes once answered.
    fn handle_close(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.viewport().close_requested()) && !self.exit {
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.backend.run(|editor, _| editor.run_interactive("save-buffers-kill-terminal"));
        }
    }

    /// The native window's title, as the frame's frame-title-format gives it.
    fn update_title(&mut self, ctx: &egui::Context, frame: FrameId, name: &str) {
        let title = name.to_string();
        if self.titles.get(&frame) != Some(&title) {
            ctx.send_viewport_cmd(ViewportCommand::Title(title.clone()));
            if frame == self.main_frame {
                self.title = title.clone();
            }
            self.titles.insert(frame, title);
        }
    }
}

/// A press, move or release of the primary button, as Emacs's mouse keys,
/// with the editor: see [`E8App::pointer`].
#[allow(clippy::too_many_arguments)]
fn pointer(ed: &mut Editor, mouse: &mut Mouse, pos: Pos2, pressed: Option<bool>, shift: bool, layout: &Layout, time: f64, offset: (WindowId, f32)) {
    // A press on the tab bar is a click on it, at the column under it.
    if let Some(rect) = layout.tab_rect.filter(|r| r.contains(pos))
        && !mouse.clicks.is_down()
    {
        if pressed == Some(true) {
            let column = ((pos.x - rect.left() - PAD_X) / layout.m.char_width).max(0.0) as usize;
            ed.tab_bar_mouse(layout.frame, column, e8_core::Key::new(e8_core::KeyCode::Mouse(e8_core::MouseKind::Click, 1)));
        }
        return;
    }
    if resize_drag(ed, mouse, pos, pressed, layout) {
        return;
    }
    let target = hit(ed, layout, pos, offset);
    match pressed {
        Some(true) => {
            let Some(target) = target else { return };
            mouse.clicks.press(ed, time, pos, |a, b| a.distance(b) < 4.0, target, shift);
        }
        Some(false) => mouse.clicks.release(ed, target, shift),
        None => mouse.clicks.moved(ed, target, shift),
    }
}

/// Dragging a window's mode line or the divider on its right moves that
/// edge, a whole line or column at a time, as Emacs's
/// mouse-drag-mode-line and mouse-drag-vertical-line do. Returns whether
/// the event was part of such a drag.
fn resize_drag(ed: &mut Editor, mouse: &mut Mouse, pos: Pos2, pressed: Option<bool>, layout: &Layout) -> bool {
    let m = &layout.m;
    match (pressed, mouse.resizing) {
        (Some(true), _) => {
            let bottom = layout.echo_rect.top();
            let grip = layout.windows.iter().find_map(|w| {
                let on_divider = w.divider && (pos.x - w.rect.right()).abs() <= 3.0 && w.rect.y_range().contains(pos.y);
                let on_mode_line = w.mode_rect.contains(pos) && w.rect.bottom() < bottom - 1.0;
                (on_divider || on_mode_line).then_some((w.id, on_divider))
            });
            let Some((window, divider)) = grip else { return false };
            mouse.resizing = Some((window, divider, if divider { pos.x } else { pos.y }));
            true
        }
        (Some(false), Some(_)) => {
            mouse.resizing = None;
            true
        }
        (None, Some((window, divider, from))) => {
            let (along, unit) = if divider { (pos.x, m.char_width) } else { (pos.y, m.line_height) };
            let delta = ((along - from) / unit).trunc() as i64;
            if delta != 0 {
                let moved = ed.move_window_edge(window, delta, divider);
                mouse.resizing = Some((window, divider, from + moved as f32 * unit));
            }
            true
        }
        _ => false,
    }
}

/// The native window that shows a frame other than the main one.
fn frame_viewport(frame: FrameId) -> egui::ViewportId {
    egui::ViewportId::from_hash_of(("e8-frame", frame))
}

/// How the cursor is drawn. Emacs shows a hollow box when the window is not
/// the one being typed into.
#[derive(Clone, Copy, PartialEq)]
enum CursorStyle {
    Filled,
    Hollow,
}

/// Fonts and sizes shared by the parts of the window.
#[derive(Clone)]
struct Metrics {
    font: FontId,
    line_height: f32,
    char_width: f32,
}

impl Metrics {
    fn of(ui: &Ui) -> Metrics {
        let font = FontId::new(TEXT_SIZE, FontFamily::Monospace);
        let em = ui.painter().layout_no_wrap("M".to_string(), font.clone(), Color32::PLACEHOLDER);
        Metrics { line_height: (em.size().y * LINE_SPACING).round(), char_width: em.size().x, font }
    }
}

/// How many columns of text the echo area has, inside its padding.
fn echo_columns(rect: Rect, m: &Metrics) -> usize {
    ((rect.width() - 2.0 * PAD_X) / m.char_width).floor().max(1.0) as usize
}

/// Gives the editor the GUI's fonts' measures, if it lacks them.
fn set_metrics(ed: &mut Editor, ctx: &egui::Context, char_width: f32, line_height: f32) {
    let known = ed.text_metrics();
    if known.uniform() || known.char_width() != char_width || known.char_height() != line_height {
        ed.set_text_metrics(Arc::new(EguiMetrics::new(ctx.clone(), char_width, line_height)));
    }
}

/// What a layout tells the editor: the fonts' measures, and for the
/// selected frame its size in cells and its height in lines, and each
/// window's text area in columns and lines.
#[derive(Clone, PartialEq)]
struct Sizes {
    metrics: (f32, f32),
    /// How many columns the echo area has for the minibuffer's text.
    echo_columns: usize,
    frame: Option<((usize, usize), usize)>,
    windows: Vec<(WindowId, usize, usize)>,
}

/// Tells the editor its windows' sizes, as a layout gives them.
fn apply_sizes(ed: &mut Editor, sizes: &Sizes) {
    if let Some(((cols, lines), frame_lines)) = sizes.frame {
        ed.set_minibuffer_width(sizes.echo_columns);
        ed.mini_window_height(frame_lines);
        ed.set_frame_size(cols, lines);
    }
    for &(id, cols, rows) in &sizes.windows {
        ed.set_window_size(id, cols, rows);
    }
}

/// Where the parts of the frame go this frame: the editor's windows, each
/// with its mode line, and the echo area across the bottom.
#[derive(Clone)]
struct Layout {
    frame: FrameId,
    rect: Rect,
    /// The tab bar across the top, when the frame shows one.
    tab_rect: Option<Rect>,
    windows: Vec<WindowLayout>,
    echo_rect: Rect,
    m: Metrics,
    /// The frame's size in cells and its height in lines with the echo area.
    frame_cells: (usize, usize),
    frame_lines: usize,
}

/// Where one editor window goes.
#[derive(Clone)]
struct WindowLayout {
    id: WindowId,
    rect: Rect,
    text_rect: Rect,
    mode_rect: Rect,
    /// The bar above the text, when the window's buffer has a `header-line-format`.
    header_rect: Option<Rect>,
    /// The margins left and right of the text, as `window-margins` gives them.
    margins: [Rect; 2],
    /// The fringes outside them, where bitmaps such as continuation arrows go.
    fringes: [Rect; 2],
    /// Whether another window lies to the right, past a hairline.
    divider: bool,
}

impl WindowLayout {
    /// Whole lines that fit in the text area.
    fn rows(&self, m: &Metrics) -> usize {
        ((self.text_rect.height() / m.line_height).floor() as usize).max(1)
    }
}

impl Layout {
    /// Lays a frame out and tells the editor how big each of its windows is.
    fn new(ui: &Ui, ed: &mut Editor, frame: FrameId, m: Metrics) -> Layout {
        set_metrics(ed, ui.ctx(), m.char_width, m.line_height);
        let rect = ui.max_rect();
        if frame == ed.selected_frame() {
            ed.set_minibuffer_width(echo_columns(rect, &m));
        }
        let frame_lines = ((rect.height() - 2.0 * BAR_PAD) / m.line_height).floor().max(1.0) as usize;
        // The selected frame's echo area grows for a minibuffer of several
        // lines, such as a vertical list of completions.
        let echo_lines = if frame == ed.selected_frame() { ed.mini_window_height(frame_lines) } else { 1 };
        let tree = ed.frame_tree(frame).cloned().unwrap_or(e8_core::WindowTree::Leaf(0));
        let tab_bar = ed.tab_bar_lines(frame) > 0;
        let layout = Layout::compute(frame, rect, m, &tree, tab_bar, echo_lines, frame_lines, &|id, lines| ed.window_wants_header_line(id, lines), &|id| ed.window_margins(id));
        // The frame in cells, which resized windows' sizes count in.
        if frame == ed.selected_frame() {
            ed.set_frame_size(layout.frame_cells.0, layout.frame_cells.1);
        }
        for (id, cols, rows) in layout.sizes(false).windows {
            ed.set_window_size(id, cols, rows);
        }
        layout
    }

    /// Lays a frame out as its last description says.
    fn described(ui: &Ui, fd: &FrameDescription, m: Metrics) -> Layout {
        let rect = ui.max_rect();
        let frame_lines = ((rect.height() - 2.0 * BAR_PAD) / m.line_height).floor().max(1.0) as usize;
        let window = |id: WindowId| fd.windows.iter().find(|w| w.id == id);
        let echo_lines = if fd.selected { fd.echo_lines.min(frame_lines.saturating_sub(2).max(1)) } else { 1 };
        Layout::compute(
            fd.frame,
            rect,
            m,
            &fd.tree,
            fd.tab_bar.is_some(),
            echo_lines,
            frame_lines,
            &|id, lines| lines > 2 && window(id).is_some_and(|w| w.header_line.is_some()),
            &|id| window(id).map_or((0, 0), |w| w.margins),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn compute(
        frame: FrameId,
        rect: Rect,
        m: Metrics,
        tree: &e8_core::WindowTree,
        tab_bar: bool,
        echo_lines: usize,
        frame_lines: usize,
        wants_header: &dyn Fn(WindowId, usize) -> bool,
        margins_of: &dyn Fn(WindowId) -> (usize, usize),
    ) -> Layout {
        let bar_height = m.line_height + 2.0 * BAR_PAD;
        let echo_height = bar_height + (echo_lines - 1) as f32 * m.line_height;
        let echo_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - echo_height), rect.max);
        // The tab bar takes a bar's height from the top, as the mode line does at a window's foot.
        let tab_rect = tab_bar.then(|| Rect::from_min_size(rect.min, vec2(rect.width(), bar_height)));
        let windows_top = tab_rect.map_or(rect.top(), |r| r.bottom());
        let frame_height = echo_rect.top() - windows_top;
        let windows: Vec<WindowLayout> = tree
            .rects(rect.left(), windows_top, rect.width(), frame_height, (m.char_width, m.line_height))
            .into_iter()
            .map(|r| {
                let rect = Rect::from_min_size(pos2(r.x, r.y), vec2(r.width, r.height));
                let mode_rect = Rect::from_min_max(pos2(rect.left(), rect.bottom() - bar_height), rect.max);
                let total_lines = (rect.height() / m.line_height).round() as usize;
                let header_rect = wants_header(r.id, total_lines).then(|| Rect::from_min_size(rect.min, vec2(rect.width(), bar_height)));
                let text_top = header_rect.map_or(rect.top(), |h| h.bottom());
                // [fringe][margin][text][margin][fringe], as Emacs lays a window out.
                let (left, right) = margins_of(r.id);
                let (top, bottom) = (text_top + PAD_Y, mode_rect.top());
                let inner = (rect.left() + PAD_X, rect.right() - PAD_X);
                let left_margin = (inner.0 + left as f32 * m.char_width).min(inner.1 - m.char_width);
                let right_margin = (inner.1 - right as f32 * m.char_width).max(left_margin + m.char_width);
                let text_rect = Rect::from_min_max(pos2(left_margin, top), pos2(right_margin, bottom));
                let margins = [
                    Rect::from_min_max(pos2(inner.0, top), pos2(left_margin, bottom)),
                    Rect::from_min_max(pos2(right_margin, top), pos2(inner.1, bottom)),
                ];
                let fringes = [
                    Rect::from_min_max(pos2(rect.left(), top), pos2(inner.0, bottom)),
                    Rect::from_min_max(pos2(inner.1, top), pos2(rect.right(), bottom)),
                ];
                WindowLayout { id: r.id, rect, text_rect, mode_rect, header_rect, margins, fringes, divider: r.divider }
            })
            .collect();
        let frame_cells = ((rect.width() / m.char_width) as usize, (frame_height / m.line_height) as usize);
        Layout { frame, rect, tab_rect, windows, echo_rect, m, frame_cells, frame_lines }
    }

    /// What it tells the editor, the frame's size too if it is selected.
    fn sizes(&self, selected: bool) -> Sizes {
        Sizes {
            metrics: (self.m.char_width, self.m.line_height),
            echo_columns: echo_columns(self.rect, &self.m),
            frame: selected.then_some((self.frame_cells, self.frame_lines)),
            windows: self.windows.iter().map(|w| (w.id, ((w.text_rect.width() / self.m.char_width).floor() as usize).max(1), w.rows(&self.m))).collect(),
        }
    }
}

/// Draws a frame as the core described it, asking the editor nothing.
fn draw(ui: &Ui, fd: &FrameDescription, layout: &Layout, t: Tokens, focused: bool, scroll: (WindowId, f32)) {
    let painter = ui.painter().clone();
    painter.rect_filled(layout.rect, 0.0, t.bg);
    let m = &layout.m;
    let in_minibuffer = fd.minibuffer_selected;
    if let (Some(rect), Some(tab_bar)) = (layout.tab_rect, &fd.tab_bar) {
        draw_tab_bar(&painter, tab_bar, rect, m, t, &fd.chrome);
    }
    for window in &fd.windows {
        let Some(w) = layout.windows.iter().find(|w| w.id == window.id) else { continue };
        // Other windows show a hollow cursor, as Emacs's do.
        let cursor = if window.selected && focused && !in_minibuffer {
            CursorStyle::Filled
        } else {
            CursorStyle::Hollow
        };
        // A line scrolled partly out of view slides under the top edge of the window.
        let top = w.header_rect.map_or(w.rect.top(), |h| h.bottom());
        // Text stops at the text area's edge, leaving the margins and fringes beside it.
        let clip = Rect::from_min_max(pos2(w.text_rect.left(), top), pos2(w.text_rect.right(), w.mode_rect.top()));
        let offset = if window.id == scroll.0 { scroll.1 } else { 0.0 };
        let view = View { area: w.text_rect, clip, scroll_offset: offset, margins: w.margins, fringes: w.fringes };
        draw_buffer(&painter, fd, window, &view, m, t, cursor);
        draw_mode_line(&painter, window, w.mode_rect, m, t, &fd.chrome);
        if let Some(header) = w.header_rect {
            draw_header_line(&painter, window, header, m, t, &fd.chrome);
        }
        if w.divider {
            painter.vline(w.rect.right() - 0.5, w.rect.y_range(), Stroke::new(1.0, t.line));
        }
    }
    // Each frame has an echo area; the prompt shows in the selected frame's.
    if fd.selected {
        let echo_cursor = if focused && fd.minibuffer_selected { CursorStyle::Filled } else { CursorStyle::Hollow };
        draw_echo_area(&painter, fd, layout.echo_rect, m, t, echo_cursor);
    }
}

/// What is under a point of the window, for a mouse event: an editor
/// window, and the buffer position there if the point is over its text.
/// Below the last line of text is the end of the buffer, as in Emacs.
fn hit(ed: &Editor, layout: &Layout, pos: Pos2, scroll: (WindowId, f32)) -> Option<(WindowId, Option<usize>)> {
    let m = &layout.m;
    let w = layout.windows.iter().find(|w| w.rect.contains(pos))?;
    if pos.y >= w.mode_rect.top() || w.header_rect.is_some_and(|h| pos.y < h.bottom()) {
        return Some((w.id, None));
    }
    let view = ed.windows().into_iter().find(|v| v.id == w.id)?;
    let offset = if scroll.0 == w.id { scroll.1 } else { 0.0 };
    let rows = ed.rows_to_draw(w.id, true);
    // Text starts right of the line numbers.
    let gutter = ed.line_numbers(w.id, &rows).map_or(0.0, |n| n.width as f32 * m.char_width);
    // The same horizontal scroll as drawing uses.
    let cursor_x = ed.posn_at_point(view.point, w.id).map_or(0.0, |p| p.x);
    let width = w.text_rect.width() - gutter;
    let hscroll = if cursor_x + m.char_width <= width { 0.0 } else { (cursor_x - width / 2.0).max(0.0) };
    let (x, y) = (pos.x - w.text_rect.left() - gutter + hscroll, pos.y - w.text_rect.top() + offset);
    let position = ed.posn_at_x_y(x.max(0.0), y.max(0.0), w.id).map_or(view.buffer.len(), |p| p.point);
    Some((w.id, Some(position)))
}

/// Where buffer text goes and how far it is scrolled, and the margins and
/// fringes beside it.
struct View {
    area: Rect,
    clip: Rect,
    scroll_offset: f32,
    margins: [Rect; 2],
    fringes: [Rect; 2],
}

#[allow(clippy::too_many_arguments)]
fn draw_buffer(
    painter: &Painter,
    fd: &FrameDescription,
    window: &WindowDescription,
    view: &View,
    m: &Metrics,
    t: Tokens,
    style: CursorStyle,
) {
    // As many rows as fill the window, one partly shown when scrolled between lines.
    let described = &window.rows;
    let rows: Vec<&Row> = described.iter().map(|r| &r.row).collect();
    let heights: Vec<f32> = described.iter().map(|r| r.height * m.line_height).collect();
    let tops: Vec<f32> = heights.iter().scan(0.0, |y, h| {
        let top = *y;
        *y += h;
        Some(top)
    }).collect();
    let default_style = &fd.default_style;
    // Line numbers, in their faces, left of the text, which starts after them.
    let numbers = &window.line_numbers;
    let gutter = numbers.as_ref().map_or(0.0, |n| n.width as f32 * m.char_width);
    if let Some(numbers) = numbers {
        let clipped = painter.with_clip_rect(view.clip);
        for (i, (label, current)) in numbers.labels.iter().enumerate() {
            let style = &window.line_number_styles[usize::from(*current)];
            let mut job = LayoutJob::default();
            job.append(label, 0.0, face_format(style, default_style, m, t));
            let galley = painter.layout_job(job);
            let (Some(top), Some(height)) = (tops.get(i), heights.get(i)) else { break };
            let top = view.area.top() + top - view.scroll_offset;
            clipped.galley(pos2(view.area.left(), top + (height - galley.size().y) / 2.0), galley, t.ink);
        }
    }
    let area = Rect::from_min_max(pos2(view.area.left() + gutter, view.area.top()), view.area.max);
    let selection = window.region_style.background.map(color32).unwrap_or(t.selection);
    // Only the selected window shows the region, as in Emacs.
    let region = &window.region;
    let point = window.point;
    // Bidirectional text broken into rows spreads a line over them.
    let point_row = window.point_row;

    let laid_out: Vec<(Arc<Galley>, &[Glyph])> = described
        .iter()
        .map(|r| {
            let advance = |font: &FontId, c: char| painter.ctx().fonts_mut(|f| f.glyph_width(font, c));
            let columns = (!r.on_grid).then_some(r.columns.as_slice());
            let height = image_text_height(r, m).unwrap_or(r.height * m.line_height);
            let job = row_job(&r.row, &r.glyphs, columns, height, default_style, m, t, &advance);
            (painter.layout_job(job), r.glyphs.as_slice())
        })
        .collect();
    // Without a bold face, bold text is drawn a second time just to the right.
    let emboldened: Vec<Option<Arc<Galley>>> = described
        .iter()
        .map(|r| {
            let bold = theme::faux_bold() && r.row.segments.iter().any(|s| s.style.bold);
            bold.then(|| painter.layout_job(bold_only_job(&r.row, &r.glyphs, r.height * m.line_height, default_style, m, t)))
        })
        .collect();

    // A right-to-left row is laid out from the window's right edge.
    let offsets: Vec<f32> = described.iter().map(|r| r.offset * m.char_width).collect();
    // Scroll horizontally, as Emacs does, when point would be off the right edge.
    let cursor = point_row.map(|i| {
        let (galley, glyphs) = &laid_out[i];
        let index = cursor_glyph(rows[i], glyphs, point);
        let char_index: usize = glyphs[..index].iter().map(|g| g.text.chars().count()).sum();
        let under = glyphs.get(index).filter(|g| g.pos == Some(point)).and_then(|g| g.text.chars().next());
        (i, galley.clone(), char_index, under)
    });
    let cursor_x = cursor
        .as_ref()
        .map_or(0.0, |(i, galley, index, _)| galley.pos_from_cursor(CCursor::new(*index)).min.x + offsets[*i]);
    let hscroll = if cursor_x + m.char_width <= area.width() {
        0.0
    } else {
        (cursor_x - area.width() / 2.0).max(0.0)
    };

    // What the fringes show: a row cut off at either side shows the
    // truncation arrow there, unless a display spec put a bitmap there.
    let fringes = &window.fringes;
    let fringe_at = |i: usize| {
        let (row, galley) = (rows[i], &laid_out[i].0);
        let truncated = [hscroll > 0.0 || offsets[i] < -0.5, !row.continued && galley.size().x - hscroll > area.width() + 0.5];
        let here = &fringes.rows[i];
        let pick = |side: usize, computed: &Option<e8_core::FringeSpec>| {
            if truncated[side] && row.fringes[side].is_none() { window.truncation[side].clone() } else { computed.clone() }
        };
        [pick(0, &here.left), pick(1, &here.right), here.arrow.clone()]
    };
    let draw_fringe = |side: usize, spec: &e8_core::FringeSpec, top: f32, height: f32| {
        let color = window.fringe_styles.get(&(spec.bitmap.clone(), spec.face.clone())).and_then(|s| s.foreground).map(color32).unwrap_or(t.faint);
        let rect = Rect::from_min_max(pos2(view.fringes[side].left(), top), pos2(view.fringes[side].right(), top + height));
        fringe::draw_bitmap(painter, fd.fringe_bitmaps.get(&spec.bitmap), &spec.bitmap, rect, color);
    };

    // Text scrolled sideways stays out of the line numbers.
    let clipped = painter.with_clip_rect(Rect::from_min_max(pos2(view.clip.left().max(area.left()), view.clip.top()), view.clip.max));
    let row_top = |row: usize| area.top() + tops[row] - view.scroll_offset;
    for (i, (galley, _)) in laid_out.iter().enumerate() {
        // A face that extends fills the rest of the row with its background,
        // and its overline and underline go on there too, as in Emacs.
        if let Some(style) = rows[i].extend.as_ref().filter(|_| !rows[i].continued) {
            // As high as the text's own background, which egui draws over
            // each glyph's logical rectangle; the row's for an empty line.
            let y = row_top(i) + (heights[i] - galley.size().y) / 2.0;
            let glyph = galley.rows.first().and_then(|r| r.row.glyphs.last().map(|g| g.logical_rect().translate(r.pos.to_vec2())));
            let (top, bottom) = glyph.map_or((row_top(i), row_top(i) + heights[i]), |g| (y + g.top(), y + g.bottom()));
            // From the last glyph's right edge, where the text's own
            // background stops, so no seam shows between them.
            let x = area.left() - hscroll + glyph.map_or(galley.size().x, |g| g.right().min(galley.size().x));
            // Left of a right-to-left row's text.
            let (from, to) = if rows[i].right_to_left { (area.left(), area.left() + offsets[i]) } else { (x, area.right()) };
            if let Some(bg) = style.background {
                clipped.rect_filled(Rect::from_min_max(pos2(from, top), pos2(to, bottom)), 0.0, color32(bg));
            }
            let ink = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
            if style.overline {
                clipped.hline(from..=to, top + 0.5, Stroke::new(1.0, style.overline_color.map(color32).unwrap_or(ink)));
            }
            if style.underline && !style.underline_wave {
                // Where the text's own is drawn, below the last glyph's baseline.
                let baseline = galley.rows.first().and_then(|r| r.row.glyphs.last().map(|g| y + r.pos.y + g.pos.y)).unwrap_or(bottom);
                let (centre, thickness) = underline_line(style, baseline, row_top(i) + heights[i], clipped.pixels_per_point());
                clipped.hline(from..=to, centre, Stroke::new(thickness, style.underline_color.map(color32).unwrap_or(ink)));
            }
        }
        if let Some(r) = &region
            && (rows[i].right_to_left || e8_core::display::reordered(laid_out[i].1))
        {
            // Bidirectional text can show the region in pieces.
            let left = area.left() - hscroll + offsets[i];
            let top = row_top(i);
            for (from, to) in region_pieces(rows[i], laid_out[i].1, galley, r) {
                let (from, to) = (from.map_or(area.left(), |x| left + x), to.map_or(area.right(), |x| left + x));
                clipped.rect_filled(Rect::from_min_max(pos2(from, top), pos2(to, top + heights[i])), 0.0, selection);
            }
        } else if let Some(r) = &region
            && let Some((from, to)) = region_span(rows[i], laid_out[i].1, galley, r)
        {
            let left = area.left() - hscroll;
            let right = to.map_or(area.right(), |x| left + x);
            let top = row_top(i);
            clipped.rect_filled(Rect::from_min_max(pos2(left + from, top), pos2(right, top + heights[i])), 0.0, selection);
        }
        let y = match described[i].ascent {
            // A row with images sits its text on the row's baseline.
            Some(ascent) => row_top(i) + ascent - galley_baseline(galley),
            None => row_top(i) + (heights[i] - galley.size().y) / 2.0,
        };
        let x = area.left() - hscroll + offsets[i];
        clipped.galley(pos2(x, y), galley.clone(), t.ink);
        draw_row_images(&clipped, fd, &described[i], pos2(x, row_top(i)), m, t);
        draw_apart(&clipped, rows[i], laid_out[i].1, galley, pos2(x, y), default_style, m, t);
        // Where the text's background starts, egui drawing it over each glyph's logical rectangle.
        let text_top = y + galley.rows.first().and_then(|r| r.row.glyphs.first().map(|g| g.logical_rect().top() + r.pos.y)).unwrap_or(0.0);
        draw_decorations(&clipped, rows[i], laid_out[i].1, galley, x, row_top(i), text_top, y, heights[i], default_style, t);
        if let Some(bold) = &emboldened[i] {
            clipped.galley(pos2(area.left() - hscroll + offsets[i] + FAUX_BOLD_OFFSET, y), bold.clone(), t.ink);
        }
        let top = row_top(i);
        // What the margins show beside the row.
        for (side, margin) in view.margins.iter().enumerate() {
            if rows[i].margins[side].is_empty() || margin.width() <= 0.0 {
                continue;
            }
            if rows[i].margins[side].iter().any(|s| s.image.is_some()) {
                draw_margin_with_images(&painter.with_clip_rect(*margin), fd, &described[i], side, pos2(margin.left(), top), heights[i], default_style, m, t);
                continue;
            }
            let mut job = LayoutJob::default();
            for seg in &rows[i].margins[side] {
                job.append(&seg.text, 0.0, face_format(&seg.style, default_style, m, t));
            }
            let galley = painter.layout_job(job);
            painter.with_clip_rect(*margin).galley(pos2(margin.left(), top + (heights[i] - galley.size().y) / 2.0), galley, t.ink);
        }
        // The fringes: what display specs put there, the arrows of a
        // continued or truncated line, the buffer's boundaries and empty
        // lines, and the overlay arrow over the left one.
        let [left, right, arrow] = fringe_at(i);
        for (side, spec) in [(0, &left), (1, &right), (0, &arrow)] {
            if let Some(spec) = spec {
                draw_fringe(side, spec, top, heights[i]);
            }
        }
    }
    // Below the end of the buffer, the marks indicate-empty-lines puts there.
    if fringes.empty.iter().any(Option::is_some) {
        let mut top = row_top(rows.len().saturating_sub(1)) + heights.last().copied().unwrap_or(0.0);
        if rows.is_empty() {
            top = area.top();
        }
        while top < view.clip.bottom() {
            for (side, spec) in fringes.empty.iter().enumerate() {
                if let Some(spec) = spec {
                    draw_fringe(side, spec, top, m.line_height);
                }
            }
            top += m.line_height;
        }
    }
    // A window whose cursor internal-show-cursor hid shows none.
    if let Some((i, galley, index, under)) = cursor.filter(|_| window.cursor_shown) {
        let pos = pos2(area.left() - hscroll + cursor_x, row_top(i));
        let font = rows[i].segments.iter().find(|s| s.start <= point).map(|s| FontSpec::of(&s.style)).unwrap_or_else(FontSpec::default_font);
        // At the end of a line that fills the row, the cursor goes in the
        // right fringe, as Emacs's overflow-newline-into-fringe puts it.
        let cursor_clip = Rect::from_min_max(clipped.clip_rect().min, pos2(view.fringes[1].right(), clipped.clip_rect().bottom()));
        if let Some(rect) = cursor_on_image(&described[i], point, pos2(area.left() - hscroll + offsets[i], row_top(i)), m) {
            painter.with_clip_rect(cursor_clip).rect_stroke(rect, 0.0, Stroke::new(1.0, t.ink), StrokeKind::Outside);
            return;
        }
        draw_cursor(&painter.with_clip_rect(cursor_clip), &galley, index, under, pos, heights[i], &font, m, t, style);
    }
}

/// Where the region covers a row, as x offsets into its galley: from the
/// first selected glyph to the end of the last, or to the window's edge
/// (`None`) when the row's newline is selected too, as Emacs's region face
/// extends.
fn region_span(row: &Row, glyphs: &[Glyph], galley: &Galley, region: &std::ops::Range<usize>) -> Option<(f32, Option<f32>)> {
    let selected = |g: &Glyph| g.pos.is_some_and(|p| region.contains(&p));
    let chars = |gs: &[Glyph]| gs.iter().map(|g| g.text.chars().count()).sum::<usize>();
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(index)).min.x;
    let extends = !row.continued && region.contains(&row.end);
    match glyphs.iter().position(selected) {
        Some(first) => {
            let last = glyphs.iter().rposition(selected).expect("one is selected");
            Some((x(chars(&glyphs[..first])), (!extends).then(|| x(chars(&glyphs[..=last])))))
        }
        None => extends.then(|| (galley.size().x, None)),
    }
}

/// Where the region covers a row reordered for bidirectional text, as
/// pieces from one x offset into its galley to another, `None` for the
/// window's edge: each run of selected glyphs, and the window's edge past
/// the end of the line when its newline is selected, which a right-to-left
/// row shows at its left.
fn region_pieces(row: &Row, glyphs: &[Glyph], galley: &Galley, region: &std::ops::Range<usize>) -> Vec<(Option<f32>, Option<f32>)> {
    let selected = |g: &Glyph| g.pos.is_some_and(|p| region.contains(&p));
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(glyphs[..index].iter().map(|g| g.text.chars().count()).sum::<usize>())).min.x;
    let mut pieces = Vec::new();
    let mut k = 0;
    while k < glyphs.len() {
        if !selected(&glyphs[k]) {
            k += 1;
            continue;
        }
        let start = k;
        while k < glyphs.len() && selected(&glyphs[k]) {
            k += 1;
        }
        pieces.push((Some(x(start)), Some(x(k))));
    }
    if !row.continued && region.contains(&row.end) {
        if row.right_to_left {
            pieces.push((None, Some(0.0)));
        } else {
            pieces.push((Some(galley.size().x), None));
        }
    }
    pieces
}

/// Whether a glyph is one character drawn wider than a column, such as CJK
/// text or an emoji, which gets a section of its own to fit the grid.
fn is_wide(glyph: &Glyph) -> bool {
    glyph.width > 1 && glyph.text.chars().count() == 1
}

/// Whether a character is of a right-to-left script: Hebrew, Arabic and
/// the others from U+0590 to U+08FF, their presentation forms, and those
/// beyond the Basic Multilingual Plane.
fn rtl_script(c: char) -> bool {
    matches!(c as u32, 0x590..=0x8FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// Whether a glyph is drawn on its own, over a space the row's galley keeps
/// for it: a character of a right-to-left script. The core has put the
/// row in visual order already, and egui's shaper would turn a run of such
/// characters around again, as it shapes them right to left.
fn apart(glyph: &Glyph) -> bool {
    glyph.text.chars().count() == 1 && rtl_script(glyph.c)
}

/// Draws the glyphs of a row's galley that are drawn on their own, each
/// over the space kept for it, in the face of its segment.
#[allow(clippy::too_many_arguments)]
fn draw_apart(painter: &Painter, row: &Row, glyphs: &[Glyph], galley: &Galley, origin: egui::Pos2, default_style: &Style, m: &Metrics, t: Tokens) {
    let mut index = 0;
    for g in glyphs {
        if apart(g) {
            let x = galley.pos_from_cursor(CCursor::new(index)).min.x;
            let seg = &row.segments[g.segment];
            let mut format = face_format(&seg.style, default_style, m, t);
            format.background = Color32::TRANSPARENT;
            format.line_height = galley.rows.first().map(|r| r.height());
            let mut job = LayoutJob::default();
            job.append(&g.text, 0.0, format);
            let glyph = painter.layout_job(job);
            painter.galley(pos2(origin.x + x, origin.y), glyph, t.ink);
        }
        index += g.text.chars().count().max(1);
    }
}

/// A row as one layout job: a section for each run of glyphs with the same
/// face. A wide character is spaced to take exactly its columns, as a
/// fallback font draws it at its own width. The region is painted under it
/// by `draw_buffer`.
/// A row as one layout job: a section for each run of glyphs with the same
/// face. On the grid, a wide character is spaced to take exactly its
/// columns, as a fallback font draws it at its own width; off it, `columns`
/// are each glyph's width as the core measured it, and a tab is spaced to
/// reach its tab stop. The region is painted under it by `draw_buffer`.
#[allow(clippy::too_many_arguments)]
fn row_job(
    row: &Row,
    glyphs: &[Glyph],
    columns: Option<&[f32]>,
    height: f32,
    default_style: &Style,
    m: &Metrics,
    t: Tokens,
    advance: &dyn Fn(&FontId, char) -> f32,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    // Glyphs spaced to a width of their own rather than the font's.
    let spaced = |g: &Glyph| apart(g) || if columns.is_some() { g.c == '\t' || row.segments[g.segment].image.is_some() } else { is_wide(g) };
    let mut i = 0;
    while i < glyphs.len() {
        let segment = glyphs[i].segment;
        let alone = spaced(&glyphs[i]);
        let mut text = String::new();
        while i < glyphs.len() && glyphs[i].segment == segment && !spaced(&glyphs[i]) {
            text.push_str(&glyphs[i].text);
            i += 1;
        }
        if alone {
            // A space keeps the place of a glyph drawn on its own.
            text.push_str(if apart(&glyphs[i]) { " " } else { &glyphs[i].text });
            i += 1;
        }
        let seg = &row.segments[segment];
        let mut format = face_format(&seg.style, default_style, m, t);
        if seg.ellipsis {
            format.color = t.faint;
        }
        if seg.image.is_some() {
            // Room for the image, which draw_row_images draws over it.
            text = " ".repeat(text.chars().count());
            format.color = Color32::TRANSPARENT;
        }
        if alone {
            let g = &glyphs[i - 1];
            let n = g.text.chars().count().max(1) as f32;
            let want = columns.map_or(g.width as f32, |c| c[i - 1]) * m.char_width;
            let natural: f32 = text.chars().map(|c| advance(&format.font_id, c)).sum();
            // A character no font has, drawn as a box, keeps the box's width.
            if natural > 0.0 {
                format.extra_letter_spacing = (want - natural) / n;
            }
        }
        // The row's full height, so backgrounds such as the region's meet
        // the rows above and below.
        format.line_height = Some(height);
        job.append(&text, 0.0, format);
    }
    job
}

/// How far apart the two copies of faux bold text are drawn, in points.
const FAUX_BOLD_OFFSET: f32 = 0.6;

/// A row's bold text alone, everything else transparent and without
/// backgrounds, laid out exactly as the row is so it can be drawn over it.
fn bold_only_job(row: &Row, glyphs: &[Glyph], height: f32, default_style: &Style, m: &Metrics, t: Tokens) -> LayoutJob {
    let mut job = LayoutJob::default();
    for glyph in glyphs {
        let style = &row.segments[glyph.segment].style;
        let mut format = face_format(style, default_style, m, t);
        format.background = Color32::TRANSPARENT;
        format.underline = Stroke::NONE;
        format.strikethrough = Stroke::NONE;
        if !style.bold {
            format.color = Color32::TRANSPARENT;
        }
        format.line_height = Some(height);
        // Right-to-left letters are drawn on their own, without the second copy.
        job.append(if apart(glyph) { " " } else { &glyph.text }, 0.0, format);
    }
    job
}

/// How a face style draws: its colours over the default face's, bold in the
/// bold monospace family, and egui's italics, underline and strike-through.
fn face_format(style: &Style, default_style: &Style, m: &Metrics, t: Tokens) -> TextFormat {
    let color = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
    let mut format = text_format(m, color);
    if style.bold || style.scale != 1.0 || style.family.is_some() {
        format.font_id = font_id(&FontSpec::of(style));
    }
    if let Some(bg) = style.background {
        format.background = color32(bg);
    }
    format.italics = style.italic;
    // Underlines and strike-throughs are drawn after the row, by
    // `draw_decorations`, where Emacs draws them: egui's go at the bottom
    // and the middle of the row, which line spacing makes the wrong places.
    format
}

/// Where each run of a row's glyphs from one segment lies in its galley:
/// the segment, and its left and right x.
fn segment_spans(glyphs: &[Glyph], galley: &Galley) -> Vec<(usize, f32, f32)> {
    let x = |index: usize| galley.pos_from_cursor(CCursor::new(index)).min.x;
    let mut spans: Vec<(usize, f32, f32)> = Vec::new();
    let mut index = 0;
    for glyph in glyphs {
        let n = glyph.text.chars().count();
        let (from, to) = (x(index), x(index + n));
        match spans.last_mut() {
            Some(last) if last.0 == glyph.segment => last.2 = to,
            _ => spans.push((glyph.segment, from, to)),
        }
        index += n;
    }
    spans
}

/// Where Emacs's xterm.c draws an underline under text in `style` whose
/// baseline is at `baseline`: the font's own underline position below it,
/// at least `underline-minimum-offset`'s one pixel, its top on a pixel and
/// no lower than the row's bottom allows. Gives the line's centre and
/// thickness, in points.
fn underline_line(style: &Style, baseline: f32, row_bottom: f32, pixels_per_point: f32) -> (f32, f32) {
    let font = font_id(&FontSpec::of(style));
    let (position, thickness) = theme::underline_metrics(&font.family, font.size);
    let pixel = 1.0 / pixels_per_point;
    let thickness = (thickness * pixels_per_point).round().max(1.0) * pixel;
    let top = (baseline + position.max(pixel)).min(row_bottom - thickness);
    let top = (top * pixels_per_point).round() * pixel;
    (top + thickness / 2.0, thickness)
}

/// Draws what egui's text formats cannot, as Emacs draws its faces: an
/// underline, an overline, a wavy underline, a strike-through and a box, each in its
/// colour or the text's, over a row laid out at `left`, `top`, `height`
/// high, its text at `text_top`, where the text's background starts and the
/// overline goes, its galley at `galley_y`.
#[allow(clippy::too_many_arguments)]
fn draw_decorations(
    painter: &Painter,
    row: &Row,
    glyphs: &[Glyph],
    galley: &Galley,
    left: f32,
    top: f32,
    text_top: f32,
    galley_y: f32,
    height: f32,
    default_style: &Style,
    t: Tokens,
) {
    for (segment, x0, x1) in segment_spans(glyphs, galley) {
        let style = &row.segments[segment].style;
        let underline = style.underline && !style.underline_wave;
        if !(underline || style.overline || style.underline_wave || style.strike || style.box_line.is_some()) || x1 <= x0 {
            continue;
        }
        let ink = style.foreground.or(default_style.foreground).map(color32).unwrap_or(t.ink);
        // The baseline, ascent and height of the segment's own font.
        let glyph = galley.rows.iter().find_map(|r| {
            r.row.glyphs.iter().find(|g| g.pos.x >= x0 - 0.5 && g.pos.x < x1).map(|g| (galley_y + r.pos.y + g.pos.y, g.font_ascent, g.font_height))
        });
        if style.strike
            && let Some((baseline, ascent, font_height)) = glyph
        {
            // As Emacs's xterm.c: through the middle of the glyphs' own
            // font, ascent and descent, not of the row, which a taller
            // face or the line spacing can make higher.
            let stroke = Stroke::new(1.0, style.strike_color.map(color32).unwrap_or(ink));
            let mut y = baseline - ascent + font_height / 2.0;
            stroke.round_center_to_pixel(painter.pixels_per_point(), &mut y);
            painter.hline((left + x0)..=(left + x1), y, stroke);
        }
        if underline && let Some((baseline, _, _)) = glyph {
            let (centre, thickness) = underline_line(style, baseline, top + height, painter.pixels_per_point());
            painter.hline((left + x0)..=(left + x1), centre, Stroke::new(thickness, style.underline_color.map(color32).unwrap_or(ink)));
        }
        let (x0, x1) = (left + x0, left + x1);
        if style.overline {
            painter.hline(x0..=x1, text_top + 0.5, Stroke::new(1.0, style.overline_color.map(color32).unwrap_or(ink)));
        }
        if style.underline_wave {
            let color = style.underline_color.map(color32).unwrap_or(ink);
            let y = top + height - 2.5;
            let step = 2.0;
            let points: Vec<egui::Pos2> =
                (0..=((x1 - x0) / step).ceil() as usize).map(|k| pos2((x0 + k as f32 * step).min(x1), if k % 2 == 0 { y } else { y + 1.5 })).collect();
            painter.add(egui::Shape::line(points, Stroke::new(1.0, color)));
        }
        if let Some((width, color)) = style.box_line {
            let color = color.map(color32).unwrap_or(ink);
            let rect = Rect::from_min_max(pos2(x0, top), pos2(x1, top + height));
            painter.rect_stroke(rect, 0.0, Stroke::new(width.unsigned_abs().max(1) as f32, color), StrokeKind::Inside);
        }
    }
}

/// Draws a box cursor at `pos`, as wide as the character under it.
#[allow(clippy::too_many_arguments)]
fn draw_cursor(
    painter: &Painter,
    galley: &Galley,
    index: usize,
    under: Option<char>,
    pos: egui::Pos2,
    height: f32,
    font: &FontSpec,
    m: &Metrics,
    t: Tokens,
    style: CursorStyle,
) {
    let width = match under {
        Some(_) => {
            let start = galley.pos_from_cursor(CCursor::new(index)).min.x;
            let end = galley.pos_from_cursor(CCursor::new(index + 1)).min.x;
            (end - start).max(m.char_width / 2.0)
        }
        None => m.char_width,
    };
    let rect = Rect::from_min_size(pos, vec2(width, height));
    match style {
        CursorStyle::Filled => {
            painter.rect_filled(rect, 0.0, t.cursor);
            if let Some(c) = under {
                let id = if font.scale == 1.0 && !font.proportional() { m.font.clone() } else { font_id(font) };
                let glyph = painter.layout_no_wrap(c.to_string(), id, t.bg);
                let y = pos.y + (height - glyph.size().y) / 2.0;
                painter.galley(pos2(pos.x, y), glyph, t.bg);
            }
        }
        CursorStyle::Hollow => {
            painter.rect_stroke(rect, 0.0, Stroke::new(1.0, t.cursor), StrokeKind::Inside);
        }
    }
}

fn text_format(m: &Metrics, color: Color32) -> TextFormat {
    // Backgrounds exactly the glyphs' size: egui grows them by a point by
    // default, which makes the region's rows overlap.
    TextFormat { font_id: m.font.clone(), color, expand_bg: 0.0, ..Default::default() }
}

fn draw_mode_line(painter: &Painter, window: &WindowDescription, rect: Rect, m: &Metrics, t: Tokens, chrome: &Chrome) {
    // A theme's mode-line faces, where it gives them colours.
    let themed = if window.selected { chrome.mode_line.as_ref() } else { chrome.mode_line_inactive.as_ref() };
    if let Some(style) = themed {
        painter.rect_filled(rect, 0.0, style.background.map_or(t.sunken, color32));
        draw_bar_text(painter, &window.mode_line, rect, m, t, style);
        return;
    }
    // The selected window's mode line is a well; the others' sit on the page,
    // as Emacs's mode-line-inactive face is plainer.
    painter.rect_filled(rect, 0.0, if window.selected { t.sunken } else { t.bg });
    painter.hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, t.line));
    // What mode-line-format shows, which the core formatted at redisplay,
    // in the mode line's own inks: muted text, the buffer's name strong
    // in the selected window, shadow faint, and what stands out in the accent.
    let default_style = Style::default();
    let mut job = LayoutJob::default();
    for (segment, style) in &window.mode_line {
        let format = match segment.faces.last().map(String::as_str) {
            None => text_format(m, t.muted),
            Some("mode-line-buffer-id") => text_format(m, if window.selected { t.ink_strong } else { t.muted }),
            Some("mode-line-emphasis") => text_format(m, t.accent_ink),
            Some("shadow") => text_format(m, t.faint),
            Some(_) => face_format(style, &default_style, m, t),
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

/// Draws a bar's segments, a mode line's or a header line's, in a theme's
/// face for it: segments in no face of their own in its foreground.
fn draw_bar_text(painter: &Painter, segments: &[(ModeLineSegment, Style)], rect: Rect, m: &Metrics, t: Tokens, bar: &Style) {
    let mut job = LayoutJob::default();
    let (fg, bg) = (bar.foreground.map_or(t.ink, color32), bar.background.map_or(t.bg, color32));
    for (segment, style) in segments {
        let format = if segment.faces.is_empty() {
            text_format(m, fg)
        } else if segment.faces.last().map(String::as_str) == Some("shadow") {
            // Quieter than the bar's text, but never the bar's own colour, as
            // a theme's shadow face can be.
            text_format(m, fg.lerp_to_gamma(bg, 0.45))
        } else {
            let mut f = face_format(style, bar, m, t);
            // The bar's own background shows through.
            if style.background == bar.background {
                f.background = Color32::TRANSPARENT;
            }
            f
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

/// Draws a frame's tab bar, as the core formatted its `tab-bar-line`: a bar
/// like the header line's, the current tab a well in strong ink, the others
/// in muted ink, as tab-bar-tab and tab-bar-tab-inactive set them apart.
fn draw_tab_bar(painter: &Painter, tab_bar: &[(ModeLineSegment, Style)], rect: Rect, m: &Metrics, t: Tokens, chrome: &Chrome) {
    if let Some(style) = &chrome.tab_bar {
        painter.rect_filled(rect, 0.0, style.background.map_or(t.bg, color32));
        draw_bar_text(painter, tab_bar, rect, m, t, style);
        return;
    }
    painter.rect_filled(rect, 0.0, t.bg);
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, t.line));
    let default_style = Style::default();
    let mut job = LayoutJob::default();
    for (segment, style) in tab_bar {
        let faces: Vec<&str> = segment.faces.iter().map(String::as_str).collect();
        let format = if faces.contains(&"shadow") {
            text_format(m, t.faint)
        } else if faces.contains(&"tab-bar-tab") {
            TextFormat { background: t.sunken, ..text_format(m, t.ink_strong) }
        } else if faces.contains(&"tab-bar-tab-inactive") || faces.is_empty() || faces == ["tab-bar"] {
            text_format(m, t.muted)
        } else {
            face_format(style, &default_style, m, t)
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

/// Draws a window's header line, as the core formatted `header-line-format`:
/// a bar like the mode line's, with a hairline under it, its text in the
/// mode line's muted ink and bold faces strong.
fn draw_header_line(painter: &Painter, window: &WindowDescription, rect: Rect, m: &Metrics, t: Tokens, chrome: &Chrome) {
    if let Some(style) = &chrome.header_line {
        painter.rect_filled(rect, 0.0, style.background.map_or(t.sunken, color32));
        draw_bar_text(painter, window.header_line.as_deref().unwrap_or(&[]), rect, m, t, style);
        return;
    }
    painter.rect_filled(rect, 0.0, t.sunken);
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, t.line));
    let default_style = Style::default();
    let mut job = LayoutJob::default();
    for (segment, style) in window.header_line.iter().flatten() {
        let format = match segment.faces.last().map(String::as_str) {
            None => text_format(m, t.muted),
            Some("bold") => text_format(m, t.ink_strong),
            Some("shadow") => text_format(m, t.faint),
            Some(_) => face_format(style, &default_style, m, t),
        };
        job.append(&segment.text, 0.0, format);
    }
    let galley = painter.layout_job(job);
    let y = rect.center().y - galley.size().y / 2.0;
    painter.with_clip_rect(rect).galley(pos2(rect.left() + PAD_X, y), galley, t.ink);
}

fn draw_echo_area(painter: &Painter, fd: &FrameDescription, rect: Rect, m: &Metrics, t: Tokens, cursor: CursorStyle) {
    let painter = painter.with_clip_rect(rect);
    let origin_x = rect.left() + PAD_X;
    let (rows, point, point_row) = match &fd.echo {
        Echo::Message(lines) => {
            // One line centred in the bar, as before; more from its top.
            let top = if lines.len() <= 1 { rect.center().y - m.line_height / 2.0 } else { rect.top() + BAR_PAD };
            for (k, line) in lines.iter().enumerate() {
                let galley = painter.layout_no_wrap(line.clone(), m.font.clone(), t.muted);
                painter.galley(pos2(origin_x, top + k as f32 * m.line_height + (m.line_height - galley.size().y) / 2.0), galley, t.muted);
            }
            return;
        }
        Echo::Prompt { rows, point, point_row } => (rows, *point, *point_row),
    };
    // The minibuffer's rows, as a window's: the prompt and input in their
    // faces, and what overlays add, such as icomplete's list, each newline
    // in it starting another row.
    let default_style = &fd.default_style;
    let advance = |font: &FontId, c: char| painter.ctx().fonts_mut(|f| f.glyph_width(font, c));
    let top = rect.top() + BAR_PAD;
    let mut at_point = None;
    for (k, described) in rows.iter().enumerate() {
        let (row, glyphs) = (&described.row, &described.glyphs);
        let y = top + k as f32 * m.line_height;
        if y + m.line_height > rect.bottom() - BAR_PAD + 0.5 {
            break;
        }
        let galley = painter.layout_job(row_job(row, glyphs, None, m.line_height, default_style, m, t, &advance));
        // A right-to-left row from the right edge.
        let width = (rect.width() - 2.0 * PAD_X) / m.char_width;
        let offset = if row.right_to_left { (width - described.width) * m.char_width } else { 0.0 };
        let origin_x = origin_x + offset;
        painter.galley(pos2(origin_x, y + (m.line_height - galley.size().y) / 2.0), galley.clone(), t.ink);
        draw_apart(&painter, row, glyphs, &galley, pos2(origin_x, y + (m.line_height - galley.size().y) / 2.0), default_style, m, t);
        if point_row == Some(k) {
            let index = cursor_glyph(row, glyphs, point);
            let char_index: usize = glyphs[..index].iter().map(|g| g.text.chars().count()).sum();
            let under = glyphs.get(index).and_then(|g| g.text.chars().next());
            at_point = Some((galley, char_index, under, y, origin_x));
        }
    }
    if let Some((galley, index, under, y, origin_x)) = at_point {
        let cursor_x = galley.pos_from_cursor(CCursor::new(index)).min.x;
        draw_cursor(&painter, &galley, index, under, pos2(origin_x + cursor_x, y), m.line_height, &FontSpec::default_font(), m, t, cursor);
    }
}

/// The height a row with images lays its text out at: its tallest text's
/// line; `None` for a row without images.
fn image_text_height(row: &RowDescription, m: &Metrics) -> Option<f32> {
    row.ascent?;
    let scale = row.row.segments.iter().filter(|s| s.image.is_none() && !s.text.is_empty()).map(|s| s.style.scale).fold(1.0f32, f32::max);
    Some(m.line_height * scale)
}

/// How far below a galley's top its first row's baseline is.
fn galley_baseline(galley: &Galley) -> f32 {
    galley.rows.first().and_then(|r| r.row.glyphs.first().map(|g| r.pos.y + g.pos.y)).unwrap_or(0.0)
}

/// Draws the images a row shows over the room its galley left for them,
/// each on the row's baseline as its ascent says.
fn draw_row_images(painter: &Painter, fd: &FrameDescription, row: &RowDescription, origin: Pos2, m: &Metrics, t: Tokens) {
    if !row.row.segments.iter().any(|s| s.image.is_some()) {
        return;
    }
    // Each glyph's x as the core laid the row out, which the galley's spacing follows.
    let mut x = 0.0;
    for (glyph, width) in row.glyphs.iter().zip(&row.columns) {
        let seg = &row.row.segments[glyph.segment];
        if let Some(img) = &seg.image {
            let ink = seg.style.foreground.map(color32).unwrap_or(t.ink);
            let top = row.segment_tops.get(glyph.segment).copied().unwrap_or(0.0);
            image::draw_image(painter, fd, img, pos2(origin.x + x * m.char_width, origin.y + top), ink);
        }
        x += width;
    }
}

/// Where the cursor's box goes when point is on an image: round the
/// image, as Emacs draws it; `None` when point is not on one.
fn cursor_on_image(row: &RowDescription, point: usize, origin: Pos2, m: &Metrics) -> Option<Rect> {
    let index = cursor_glyph(&row.row, &row.glyphs, point);
    let glyph = row.glyphs.get(index).filter(|g| g.pos == Some(point))?;
    let img = row.row.segments[glyph.segment].image.as_ref()?;
    let x: f32 = row.columns[..index].iter().sum();
    let top = row.segment_tops.get(glyph.segment).copied().unwrap_or(0.0);
    Some(image::glyph_rect(img, pos2(origin.x + x * m.char_width, origin.y + top)))
}

/// Draws a margin's segments beside a row when some are images: text and
/// images one after another, each image on the row's baseline.
#[allow(clippy::too_many_arguments)]
fn draw_margin_with_images(painter: &Painter, fd: &FrameDescription, row: &RowDescription, side: usize, top_left: Pos2, height: f32, default_style: &Style, m: &Metrics, t: Tokens) {
    let mut x = top_left.x;
    for (k, seg) in row.row.margins[side].iter().enumerate() {
        match &seg.image {
            Some(img) => {
                let ink = seg.style.foreground.map(color32).unwrap_or(t.ink);
                let top = row.margin_tops[side].get(k).copied().unwrap_or(0.0);
                image::draw_image(painter, fd, img, pos2(x, top_left.y + top), ink);
                x += img.advance();
            }
            None => {
                let mut job = LayoutJob::default();
                job.append(&seg.text, 0.0, face_format(&seg.style, default_style, m, t));
                let galley = painter.layout_job(job);
                let width = galley.size().x;
                painter.galley(pos2(x, top_left.y + (height - galley.size().y) / 2.0), galley, t.ink);
                x += width;
            }
        }
    }
}
