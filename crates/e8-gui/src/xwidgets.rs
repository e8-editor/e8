//! xwidgets' web views ([ADR 0089]): the GUI's half of Emacs's xwidget.c.
//!
//! The core queues what Lisp asked of each xwidget (`XwidgetRequest`); the
//! window carries the requests out between frames, on its own thread, with
//! native web views through `wry`: a WKWebView child view of the window on
//! macOS, a WebKitGTK view in a child X11 window on Linux under X11, and on
//! Wayland, whose surfaces cannot hold another's, a view in a GTK window
//! of its own, with a box of the xwidget's size and title drawn in its place.
//!
//! Each frame, the drawing records where each xwidget's glyph is
//! ([`Sink`]); after it, each native view is moved and sized to the part of
//! its glyph its window shows, or hidden when no window shows it, and the
//! editor is told where each window shows each xwidget (`Placed`,
//! `Unplaced`), as Emacs's redisplay makes and deletes xwidget views. What
//! the pages report comes back as `XwidgetEvent`s.
//!
//! The platform is behind [`WebViews`], so the request mapping, the script
//! results' conversion and the placement work without a real web view.
//!
//! [ADR 0089]: ../../../docs/adr/0089-xwidgets-as-emacs-has-them.md

// Without web views to make, what makes and feeds them goes unused.
#![cfg_attr(not(all(feature = "xwidgets", any(target_os = "macos", target_os = "linux"))), allow(dead_code))]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use e8_core::xwidget::{XwidgetEvent, XwidgetRequest};
use e8_core::{Value, WindowId};
use egui::{Align2, FontFamily, FontId, Painter, Pos2, Rect, Stroke, StrokeKind, pos2, vec2};

use crate::theme::Tokens;

/// Whether this build shows web views: with the `xwidgets` feature, on
/// macOS and Linux, where wry has them.
pub const SUPPORTED: bool = cfg!(all(feature = "xwidgets", any(target_os = "macos", target_os = "linux")));

/// What a web view reports, from wry's handlers.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Report {
    /// A page started loading.
    Started { id: u64, uri: String },
    /// A page finished loading.
    Finished { id: u64, uri: String },
    Title { id: u64, title: String },
    /// The page asked to go somewhere, as WebKit's decide-policy.
    Navigation { id: u64, uri: String },
    /// The page asked for a new window, which opens in the same view.
    NewWindow { id: u64, uri: String },
    Download { id: u64, url: String, file_name: String },
    /// A script's result as JSON, empty for `undefined`.
    Script { callback: u64, json: String },
}

/// What the editor is told, as `XwidgetEvent`, which cannot go to the
/// editor's thread as it is: a script's result is a `Value` there, made
/// from its JSON on that thread.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Event {
    LoadChanged { id: u64, status: String, uri: String, title: String },
    TitleChanged { id: u64, title: String },
    Progress { id: u64, progress: f64 },
    ScriptResult { callback: u64, json: String },
    DecidePolicy { id: u64, uri: String },
    Download { id: u64, url: String, mime_type: String, file_name: String },
    Placed { xwidget: u64, window: WindowId, rect: [f32; 4], clip: [f32; 4] },
    Unplaced { xwidget: u64, window: WindowId },
}

impl Event {
    /// The core's event, on the editor's thread.
    pub fn into_core(self) -> XwidgetEvent {
        match self {
            Event::LoadChanged { id, status, uri, title } => XwidgetEvent::LoadChanged { id, status, uri, title },
            Event::TitleChanged { id, title } => XwidgetEvent::TitleChanged { id, title },
            Event::Progress { id, progress } => XwidgetEvent::Progress { id, progress },
            Event::ScriptResult { callback, json } => XwidgetEvent::ScriptResult { callback, value: json_to_value(&json) },
            Event::DecidePolicy { id, uri } => XwidgetEvent::DecidePolicy { id, uri },
            Event::Download { id, url, mime_type, file_name } => XwidgetEvent::Download { id, url, mime_type, file_name },
            Event::Placed { xwidget, window, rect, clip } => XwidgetEvent::Placed { xwidget, window, rect, clip },
            Event::Unplaced { xwidget, window } => XwidgetEvent::Unplaced { xwidget, window },
        }
    }
}

/// Where wry's handlers send what they report, from whichever thread they run on.
pub(crate) type Reporter = Arc<dyn Fn(Report) + Send + Sync>;

/// Native web views, as a platform has them: each made, loaded, run
/// scripts in and placed by the xwidget's id.
pub(crate) trait WebViews {
    /// Makes a view of a size, in points, hidden until placed.
    fn create(&mut self, id: u64, width: u32, height: u32) -> Result<(), String>;
    fn load_url(&mut self, id: u64, uri: &str);
    fn load_html(&mut self, id: u64, html: &str);
    /// Runs a script, reporting its result as JSON with `callback` if given.
    fn eval(&mut self, id: u64, script: &str, callback: Option<u64>);
    fn reload(&mut self, id: u64);
    fn zoom(&mut self, id: u64, level: f64);
    /// Sizes a view that is not placed in the window but beside it.
    fn resize(&mut self, id: u64, width: u32, height: u32) {
        let _ = (id, width, height);
    }
    /// Shows a view at a rectangle of the window, in physical pixels as
    /// x, y, width and height, or hides it.
    fn place(&mut self, id: u64, rect: Option<[i32; 4]>);
    fn destroy(&mut self, id: u64);
    /// Whether views sit in the window, rather than in windows of their own.
    fn embedded(&self) -> bool;
    /// Runs the platform's event loop for a moment, where the window's own
    /// does not run it; whether it wants to run again soon.
    fn pump(&mut self) -> bool {
        false
    }
    /// Gives the keyboard back to the editor's window, after a click there.
    fn focus_editor(&mut self) {}
}

/// Where a window shows an xwidget this frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Placement {
    pub xwidget: u64,
    pub window: WindowId,
    /// x, y, width and height in the window's text area, in points.
    pub rect: [f32; 4],
    /// How much is clipped off the right, bottom, top and left.
    pub clip: [f32; 4],
    /// The part the window shows, on the screen.
    pub visible: Rect,
    /// Whether the native view goes here, rather than a box.
    pub native: bool,
}

/// What a frame's drawing records of the xwidgets it shows.
pub(crate) struct Sink<'a> {
    labels: &'a HashMap<u64, String>,
    /// Whether native views can go in this frame's window.
    native: bool,
    pub placements: Vec<Placement>,
}

impl<'a> Sink<'a> {
    pub fn new(labels: &'a HashMap<u64, String>, native: bool) -> Sink<'a> {
        Sink { labels, native, placements: Vec::new() }
    }

    /// Records an xwidget's glyph at `rect` on the screen, in a window
    /// whose text area starts at `origin`, clipped as `painter` is; draws
    /// a box with its title where its native view does not go: the second
    /// window showing it, a frame of its own window, or on Wayland.
    pub fn glyph(&mut self, painter: &Painter, window: WindowId, origin: Pos2, xwidget: u64, rect: Rect, t: Tokens) {
        let clip = painter.clip_rect();
        let visible = rect.intersect(clip);
        let native = self.native && !self.placements.iter().any(|p| p.xwidget == xwidget && p.native);
        let cut = [
            (rect.right() - clip.right()).max(0.0),
            (rect.bottom() - clip.bottom()).max(0.0),
            (clip.top() - rect.top()).max(0.0),
            (clip.left() - rect.left()).max(0.0),
        ];
        self.placements.push(Placement {
            xwidget,
            window,
            rect: [rect.left() - origin.x, rect.top() - origin.y, rect.width(), rect.height()],
            clip: cut.map(|c| c.min(rect.width().max(rect.height()))),
            visible,
            native,
        });
        if native || !visible.is_positive() {
            return;
        }
        let boxed = painter.with_clip_rect(visible);
        boxed.rect_filled(rect, 0.0, t.sunken);
        boxed.rect_stroke(rect, 0.0, Stroke::new(1.0, t.line), StrokeKind::Inside);
        let label = self.labels.get(&xwidget).map_or("xwidget", String::as_str);
        boxed.text(rect.min + vec2(8.0, 6.0), Align2::LEFT_TOP, label, FontId::new(crate::theme::TEXT_SIZE, FontFamily::Proportional), t.muted);
    }
}

/// What the window keeps of each view it made.
#[derive(Default)]
struct View {
    /// Whether a page has finished loading, before which scripts whose
    /// results are wanted wait, as wry would run them without giving back
    /// their results.
    ready: bool,
    held: Vec<XwidgetRequest>,
    /// The last search, for the next and previous results: the query,
    /// whether case matters and whether it wraps.
    search: Option<(String, bool, bool)>,
    title: String,
    /// The URI last reported committed, to report a new page once.
    committed: String,
    /// Where the native view was last put, in physical pixels, if shown.
    shown: Option<[i32; 4]>,
}

/// The window's web views and what the editor knows of them.
pub(crate) struct XwidgetHost {
    backend: Option<Box<dyn WebViews>>,
    /// Whether making a platform's views was tried, and failed.
    failed: bool,
    /// Requests waiting for a platform's views, made once a window is there.
    pending: Vec<XwidgetRequest>,
    views: HashMap<u64, View>,
    /// Where the editor was last told each window shows each xwidget.
    placed: HashMap<(u64, WindowId), ([f32; 4], [f32; 4])>,
    /// What this frame's drawing recorded, every frame of the editor's.
    frame: Vec<Placement>,
    sender: Sender<Report>,
    reports: Receiver<Report>,
    /// Messages for the echo area, as when a view could not be made.
    pub messages: Vec<String>,
}

impl Default for XwidgetHost {
    fn default() -> XwidgetHost {
        let (sender, reports) = channel();
        XwidgetHost {
            backend: None,
            failed: false,
            pending: Vec::new(),
            views: HashMap::new(),
            placed: HashMap::new(),
            frame: Vec::new(),
            sender,
            reports,
            messages: Vec::new(),
        }
    }
}

/// A script wrapped so its result always serializes, as WebKit's own
/// conversion would fail on a DOM node or a cycle: such values are nil, as
/// `webkit_js_to_lisp` makes what it cannot convert. A single expression
/// is wrapped as it is, so pages whose Content Security Policy forbids
/// `eval` still give its value; several statements go through `eval` for
/// the last one's value, and where the page forbids that, run as a
/// function's body, giving what it returns.
fn wrapped(script: &str) -> String {
    let trimmed = script.trim().trim_end_matches(';').trim_end();
    let value = if !trimmed.is_empty() && !trimmed.contains(';') && !trimmed.contains('\n') {
        format!("try {{ v = ({trimmed}\n); }} catch (e) {{ return null; }}")
    } else {
        let source = serde_json::to_string(script).unwrap_or_else(|_| "\"\"".into());
        format!(
            "try {{ v = (0, eval)({source}); }} catch (e) {{ if (!(e instanceof EvalError)) return null; \
             try {{ v = (function () {{ {script}\n }})(); }} catch (e2) {{ return null; }} }}"
        )
    };
    format!(
        "(() => {{ let v; {value} \
         if (v === undefined) return null; \
         try {{ return JSON.parse(JSON.stringify(v)) ?? null; }} catch (e) {{ return null; }} }})()"
    )
}

/// The script that finds a query in a page, as WebKit's find controller would.
fn find(query: &str, case_sensitive: bool, backwards: bool, wrap: bool) -> String {
    let query = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
    format!("window.find({query}, {case_sensitive}, {backwards}, {wrap})")
}

impl XwidgetHost {
    /// Whether the window should make a platform's views: requests wait
    /// for them and none were tried yet.
    pub fn wants_backend(&self) -> bool {
        self.backend.is_none() && !self.failed && self.pending.iter().any(|r| matches!(r, XwidgetRequest::Create { .. }))
    }

    /// Where wry's handlers report to, waking the window with `wake`.
    pub fn reporter(&self, wake: impl Fn() + Send + Sync + 'static) -> Reporter {
        let sender = self.sender.clone();
        Arc::new(move |report| {
            let _ = sender.send(report);
            wake();
        })
    }

    /// Uses a platform's views, or notes that there are none to be had.
    pub fn attach(&mut self, backend: Result<Box<dyn WebViews>, String>) {
        match backend {
            Ok(backend) => self.backend = Some(backend),
            Err(e) => {
                self.failed = true;
                self.pending.clear();
                self.messages.push(format!("xwidgets: no web views: {e}"));
            }
        }
    }

    /// Whether any web view exists.
    pub fn has_views(&self) -> bool {
        !self.views.is_empty()
    }

    /// Whether native views go in the window: there are views, embedded in it.
    pub fn embeds(&self) -> bool {
        self.backend.as_ref().is_some_and(|b| b.embedded())
    }

    /// Carries out what the editor asked, or keeps it for when there are views.
    pub fn request(&mut self, requests: Vec<XwidgetRequest>) {
        // With no web views to be had, nothing waits for them.
        if self.failed {
            return;
        }
        self.pending.extend(requests);
        if self.backend.is_some() {
            for request in std::mem::take(&mut self.pending) {
                self.apply(request);
            }
        }
    }

    /// The start of a frame: runs the platform's loop, carries out waiting
    /// requests, and gives what the views reported since the last frame.
    pub fn begin(&mut self) -> (Vec<Event>, bool) {
        let again = self.backend.as_mut().is_some_and(|b| b.pump());
        self.request(Vec::new());
        self.frame.clear();
        (self.take_reports(), again)
    }

    /// Notes what a frame's drawing recorded.
    pub fn drawn(&mut self, placements: Vec<Placement>) {
        self.frame.extend(placements);
    }

    /// The end of a frame: moves each native view where its glyph is, hides
    /// the rest, and gives the editor's views that changed.
    pub fn end(&mut self, pixels_per_point: f32) -> Vec<Event> {
        let mut events = Vec::new();
        let mut now: HashMap<(u64, WindowId), ([f32; 4], [f32; 4])> = HashMap::new();
        for p in &self.frame {
            let key = (p.xwidget, p.window);
            if now.contains_key(&key) {
                continue;
            }
            let place = (p.rect, p.clip);
            if self.placed.get(&key) != Some(&place) {
                events.push(Event::Placed { xwidget: p.xwidget, window: p.window, rect: p.rect, clip: p.clip });
            }
            now.insert(key, place);
        }
        let mut gone: Vec<_> = self.placed.keys().filter(|k| !now.contains_key(k)).copied().collect();
        gone.sort_unstable();
        events.extend(gone.into_iter().map(|(xwidget, window)| Event::Unplaced { xwidget, window }));
        self.placed = now;
        let Some(backend) = self.backend.as_mut() else { return events };
        let mut ids: Vec<u64> = self.views.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let target = self.frame.iter().find(|p| p.xwidget == id && p.native).filter(|p| p.visible.is_positive()).map(|p| {
                let r = p.visible;
                let s = pixels_per_point;
                [(r.left() * s).round() as i32, (r.top() * s).round() as i32, (r.width() * s).round() as i32, (r.height() * s).round() as i32]
            });
            // Beside the window, a view shows while some window shows its xwidget.
            let target = if backend.embedded() { target } else { self.frame.iter().any(|p| p.xwidget == id).then_some([0, 0, 0, 0]) };
            let view = self.views.get_mut(&id).expect("listed");
            if view.shown != target {
                view.shown = target;
                backend.place(id, target);
            }
        }
        events
    }

    /// A click in the editor's window, which takes the keyboard back.
    pub fn clicked_editor(&mut self) {
        if !self.views.is_empty()
            && let Some(backend) = self.backend.as_mut()
        {
            backend.focus_editor();
        }
    }

    /// Carries out one request, with the views there are.
    fn apply(&mut self, request: XwidgetRequest) {
        let Some(backend) = self.backend.as_mut() else { return };
        if let XwidgetRequest::Create { id, width, height, .. } = request {
            match backend.create(id, width, height) {
                Ok(()) => {
                    self.views.insert(id, View::default());
                }
                Err(e) => self.messages.push(format!("xwidgets: could not make a web view: {e}")),
            }
            return;
        }
        let id = match &request {
            XwidgetRequest::GotoUri { id, .. }
            | XwidgetRequest::LoadHtml { id, .. }
            | XwidgetRequest::ExecuteScript { id, .. }
            | XwidgetRequest::Resize { id, .. }
            | XwidgetRequest::Zoom { id, .. }
            | XwidgetRequest::GotoHistory { id, .. }
            | XwidgetRequest::Stop { id }
            | XwidgetRequest::Search { id, .. }
            | XwidgetRequest::NextResult { id }
            | XwidgetRequest::PreviousResult { id }
            | XwidgetRequest::FinishSearch { id }
            | XwidgetRequest::SetCookieStorage { id, .. }
            | XwidgetRequest::DeleteView { id, .. }
            | XwidgetRequest::Kill { id } => *id,
            XwidgetRequest::Create { .. } => unreachable!("made above"),
        };
        let Some(view) = self.views.get_mut(&id) else { return };
        match request {
            XwidgetRequest::Create { .. } => {}
            XwidgetRequest::GotoUri { uri, .. } => backend.load_url(id, &uri),
            // wry loads HTML without a base URI.
            XwidgetRequest::LoadHtml { html, .. } => backend.load_html(id, &html),
            // wry drops a callback for a script run before the first page
            // has loaded, so those wait; others it queues itself.
            XwidgetRequest::ExecuteScript { callback: Some(_), .. } if !view.ready => view.held.push(request),
            XwidgetRequest::ExecuteScript { script, callback, .. } => match callback {
                Some(callback) => backend.eval(id, &wrapped(&script), Some(callback)),
                None => backend.eval(id, &script, None),
            },
            // The glyph takes the new size, and the view with it, next frame.
            XwidgetRequest::Resize { width, height, .. } => backend.resize(id, width, height),
            XwidgetRequest::Zoom { level, .. } => backend.zoom(id, level),
            XwidgetRequest::GotoHistory { offset: 0, .. } => backend.reload(id),
            XwidgetRequest::GotoHistory { offset, .. } => backend.eval(id, &format!("history.go({offset})"), None),
            XwidgetRequest::Stop { .. } => backend.eval(id, "window.stop()", None),
            XwidgetRequest::Search { query, case_insensitive, backwards, wrap_around, .. } => {
                // Emacs's search starts afresh from the top.
                backend.eval(id, "window.getSelection().removeAllRanges()", None);
                backend.eval(id, &find(&query, !case_insensitive, backwards, wrap_around), None);
                view.search = Some((query, !case_insensitive, wrap_around));
            }
            XwidgetRequest::NextResult { .. } | XwidgetRequest::PreviousResult { .. } => {
                if let Some((query, case, wrap)) = &view.search {
                    let backwards = matches!(request, XwidgetRequest::PreviousResult { .. });
                    backend.eval(id, &find(query, *case, backwards, *wrap), None);
                }
            }
            XwidgetRequest::FinishSearch { .. } => {
                view.search = None;
                backend.eval(id, "window.getSelection().removeAllRanges()", None);
            }
            // WKWebView and WebKitGTK keep cookies their own way, in wry's
            // data directory; a file of Emacs's choosing is not used.
            XwidgetRequest::SetCookieStorage { .. } => {}
            // Hidden until the next frame places it again, as Emacs's
            // redisplay makes a view again where the xwidget still shows.
            XwidgetRequest::DeleteView { window, .. } => {
                self.placed.remove(&(id, window));
                if view.shown.is_some() {
                    view.shown = None;
                    backend.place(id, None);
                }
            }
            XwidgetRequest::Kill { .. } => {
                backend.destroy(id);
                self.views.remove(&id);
                self.placed.retain(|(x, _), _| *x != id);
            }
        }
    }

    /// What the views reported, as the editor's events.
    fn take_reports(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        while let Ok(report) = self.reports.try_recv() {
            match report {
                Report::Started { id, uri } => {
                    let Some(view) = self.views.get(&id) else { continue };
                    events.push(Event::LoadChanged { id, status: "load-started".into(), uri, title: view.title.clone() });
                }
                Report::Finished { id, uri } => {
                    let Some(view) = self.views.get_mut(&id) else { continue };
                    let title = view.title.clone();
                    if view.committed != uri {
                        view.committed = uri.clone();
                        events.push(Event::LoadChanged { id, status: "load-committed".into(), uri: uri.clone(), title: title.clone() });
                    }
                    events.push(Event::LoadChanged { id, status: "load-finished".into(), uri, title });
                    events.push(Event::Progress { id, progress: 1.0 });
                    if !view.ready {
                        view.ready = true;
                        for request in std::mem::take(&mut view.held) {
                            self.apply(request);
                        }
                    }
                }
                Report::Title { id, title } => {
                    let Some(view) = self.views.get_mut(&id) else { continue };
                    view.title = title.clone();
                    events.push(Event::TitleChanged { id, title });
                }
                Report::Navigation { id, uri } => events.push(Event::DecidePolicy { id, uri }),
                Report::NewWindow { id, uri } => {
                    if let (true, Some(backend)) = (self.views.contains_key(&id), self.backend.as_mut()) {
                        backend.load_url(id, &uri);
                    }
                }
                Report::Download { id, url, file_name } => events.push(Event::Download { id, url, mime_type: String::new(), file_name }),
                Report::Script { callback, json } => events.push(Event::ScriptResult { callback, json }),
            }
        }
        events
    }
}

/// A script's result as JSON, as Lisp gets it, as `webkit_js_to_lisp`
/// converts it: strings, numbers and booleans as themselves, null and
/// `undefined` (no JSON) as nil, arrays as lists, and objects as lists
/// of `[key, value]` pairs.
pub fn json_to_value(json: &str) -> Value {
    if json.trim().is_empty() {
        return Value::Null;
    }
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) => convert(&v),
        Err(_) => Value::Str(json.to_string()),
    }
}

fn convert(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(items) => Value::List(items.iter().map(convert).collect()),
        serde_json::Value::Object(map) => Value::List(map.iter().map(|(k, v)| Value::List(vec![Value::Str(k.clone()), convert(v)])).collect()),
    }
}

/// The screen rectangle of an xwidget's glyph whose box starts at `top_left`.
pub(crate) fn glyph_rect(width: f32, height: f32, top_left: Pos2) -> Rect {
    Rect::from_min_size(pos2(top_left.x, top_left.y), vec2(width, height))
}

#[cfg(all(feature = "xwidgets", any(target_os = "macos", target_os = "linux")))]
pub(crate) mod platform {
    //! wry's web views: WKWebView on macOS, WebKitGTK on Linux.

    use std::collections::HashMap;

    use wry::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};
    use wry::raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};
    use wry::{NewWindowResponse, PageLoadEvent, WebView, WebViewBuilder};

    use super::{Report, Reporter, WebViews};

    /// The editor's window, as wry is given it to put views in.
    struct Parent(RawWindowHandle);

    impl HasWindowHandle for Parent {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            // SAFETY: the handle is the main window's, which lives as long
            // as the app, and with it every view made in it.
            Ok(unsafe { WindowHandle::borrow_raw(self.0) })
        }
    }

    /// How views sit: in the window, or each in a GTK window of its own,
    /// as on Wayland.
    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Child,
        #[cfg(target_os = "linux")]
        OwnWindow,
    }

    pub(crate) struct Wry {
        parent: Parent,
        mode: Mode,
        report: Reporter,
        views: HashMap<u64, WebView>,
        #[cfg(target_os = "linux")]
        windows: HashMap<u64, gtk::Window>,
    }

    /// The views for the window `window` is, reporting to `report`.
    pub(crate) fn web_views(window: &impl HasWindowHandle, report: Reporter) -> Result<Box<dyn WebViews>, String> {
        let raw = window.window_handle().map_err(|e| e.to_string())?.as_raw();
        let mode = match raw {
            #[cfg(target_os = "macos")]
            RawWindowHandle::AppKit(_) => Mode::Child,
            #[cfg(target_os = "linux")]
            RawWindowHandle::Xlib(_) => {
                // GTK must speak X11 too, to put its windows in E8's.
                gtk::gdk::set_allowed_backends("x11");
                gtk::init().map_err(|e| e.to_string())?;
                Mode::Child
            }
            #[cfg(target_os = "linux")]
            RawWindowHandle::Wayland(_) | RawWindowHandle::Xcb(_) => {
                gtk::init().map_err(|e| e.to_string())?;
                Mode::OwnWindow
            }
            other => return Err(format!("no web views in a window of this kind ({other:?})")),
        };
        Ok(Box::new(Wry {
            parent: Parent(raw),
            mode,
            report,
            views: HashMap::new(),
            #[cfg(target_os = "linux")]
            windows: HashMap::new(),
        }))
    }

    impl Wry {
        fn builder(&self, id: u64, width: u32, height: u32) -> WebViewBuilder<'static> {
            let (load, title, navigation, new_window, download) =
                (self.report.clone(), self.report.clone(), self.report.clone(), self.report.clone(), self.report.clone());
            WebViewBuilder::new()
                .with_bounds(wry::Rect { position: LogicalPosition::new(0, 0).into(), size: LogicalSize::new(width, height).into() })
                .with_visible(false)
                .with_accept_first_mouse(true)
                .with_on_page_load_handler(move |event, uri| {
                    load(match event {
                        PageLoadEvent::Started => Report::Started { id, uri },
                        PageLoadEvent::Finished => Report::Finished { id, uri },
                    })
                })
                .with_document_title_changed_handler(move |t| title(Report::Title { id, title: t }))
                .with_navigation_handler(move |uri| {
                    navigation(Report::Navigation { id, uri });
                    true
                })
                .with_new_window_req_handler(move |uri, _| {
                    new_window(Report::NewWindow { id, uri });
                    NewWindowResponse::Deny
                })
                // The view saves a download in ~/Downloads, the default
                // xwidget-webkit-download-dir, and Lisp hears where.
                .with_download_started_handler(move |url, path| {
                    let name = path.file_name().map(|f| f.to_os_string()).unwrap_or_else(|| "download".into());
                    if let Some(home) = std::env::var_os("HOME") {
                        *path = std::path::Path::new(&home).join("Downloads").join(name);
                    }
                    download(Report::Download { id, url, file_name: path.to_string_lossy().into_owned() });
                    true
                })
        }
    }

    impl WebViews for Wry {
        fn create(&mut self, id: u64, width: u32, height: u32) -> Result<(), String> {
            let builder = self.builder(id, width, height);
            let view = match self.mode {
                Mode::Child => builder.build_as_child(&self.parent).map_err(|e| e.to_string())?,
                #[cfg(target_os = "linux")]
                Mode::OwnWindow => {
                    use gtk::prelude::*;
                    use wry::WebViewBuilderExtUnix;
                    let window = gtk::Window::new(gtk::WindowType::Toplevel);
                    window.set_title("E8 xwidget");
                    window.set_default_size(width as i32, height as i32);
                    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
                    window.add(&container);
                    let view = builder.build_gtk(&container).map_err(|e| e.to_string())?;
                    let _ = view.set_visible(true);
                    // Closing it hides it; killing the xwidget destroys it.
                    window.connect_delete_event(|w, _| {
                        w.hide();
                        gtk::glib::Propagation::Stop
                    });
                    self.windows.insert(id, window);
                    view
                }
            };
            self.views.insert(id, view);
            Ok(())
        }

        fn load_url(&mut self, id: u64, uri: &str) {
            if let Some(v) = self.views.get(&id) {
                let _ = v.load_url(uri);
            }
        }

        fn load_html(&mut self, id: u64, html: &str) {
            if let Some(v) = self.views.get(&id) {
                let _ = v.load_html(html);
            }
        }

        fn eval(&mut self, id: u64, script: &str, callback: Option<u64>) {
            let Some(v) = self.views.get(&id) else { return };
            let _ = match callback {
                Some(callback) => {
                    let report = self.report.clone();
                    v.evaluate_script_with_callback(script, move |json| report(Report::Script { callback, json }))
                }
                None => v.evaluate_script(script),
            };
        }

        fn reload(&mut self, id: u64) {
            if let Some(v) = self.views.get(&id) {
                let _ = v.reload();
            }
        }

        fn zoom(&mut self, id: u64, level: f64) {
            if let Some(v) = self.views.get(&id) {
                let _ = v.zoom(level);
            }
        }

        fn resize(&mut self, id: u64, width: u32, height: u32) {
            #[cfg(target_os = "linux")]
            if let Some(w) = self.windows.get(&id) {
                use gtk::prelude::*;
                w.resize(width as i32, height as i32);
            }
            let _ = (id, width, height);
        }

        fn place(&mut self, id: u64, rect: Option<[i32; 4]>) {
            #[cfg(target_os = "linux")]
            if let Some(w) = self.windows.get(&id) {
                use gtk::prelude::*;
                if rect.is_some() { w.show_all() } else { w.hide() }
                return;
            }
            let Some(v) = self.views.get(&id) else { return };
            match rect {
                Some([x, y, width, height]) => {
                    let bounds = wry::Rect {
                        position: PhysicalPosition::new(x, y).into(),
                        size: PhysicalSize::new(width.max(1) as u32, height.max(1) as u32).into(),
                    };
                    let _ = v.set_bounds(bounds);
                    let _ = v.set_visible(true);
                }
                None => {
                    let _ = v.set_visible(false);
                }
            }
        }

        fn destroy(&mut self, id: u64) {
            self.views.remove(&id);
            #[cfg(target_os = "linux")]
            if let Some(w) = self.windows.remove(&id) {
                use gtk::prelude::*;
                // SAFETY: the window and the view in it are no longer used.
                unsafe { w.destroy() };
            }
        }

        fn embedded(&self) -> bool {
            self.mode == Mode::Child
        }

        fn pump(&mut self) -> bool {
            // AppKit's loop, which the window runs, runs WKWebView's too;
            // GTK's runs only when asked.
            #[cfg(target_os = "linux")]
            let busy = {
                let mut busy = false;
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                    busy = true;
                }
                busy
            };
            #[cfg(not(target_os = "linux"))]
            let busy = false;
            busy
        }

        fn focus_editor(&mut self) {
            // On macOS a click makes E8's view first responder itself.
            #[cfg(target_os = "linux")]
            if let Some(v) = self.views.values().next() {
                let _ = v.focus_parent();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Views that write down what they were asked, for the tests.
    #[derive(Default, Clone)]
    struct Fake {
        log: Arc<std::sync::Mutex<Vec<String>>>,
        embedded: bool,
    }

    impl Fake {
        fn new(embedded: bool) -> Fake {
            Fake { embedded, ..Fake::default() }
        }

        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.log.lock().unwrap())
        }

        fn note(&self, s: String) {
            self.log.lock().unwrap().push(s);
        }
    }

    impl WebViews for Fake {
        fn create(&mut self, id: u64, width: u32, height: u32) -> Result<(), String> {
            self.note(format!("create {id} {width}x{height}"));
            Ok(())
        }
        fn load_url(&mut self, id: u64, uri: &str) {
            self.note(format!("load {id} {uri}"));
        }
        fn load_html(&mut self, id: u64, html: &str) {
            self.note(format!("html {id} {html}"));
        }
        fn eval(&mut self, id: u64, script: &str, callback: Option<u64>) {
            match callback {
                Some(c) => self.note(format!("eval {id} cb{c} {script}")),
                None => self.note(format!("eval {id} {script}")),
            }
        }
        fn reload(&mut self, id: u64) {
            self.note(format!("reload {id}"));
        }
        fn zoom(&mut self, id: u64, level: f64) {
            self.note(format!("zoom {id} {level}"));
        }
        fn place(&mut self, id: u64, rect: Option<[i32; 4]>) {
            self.note(format!("place {id} {rect:?}"));
        }
        fn destroy(&mut self, id: u64) {
            self.note(format!("destroy {id}"));
        }
        fn embedded(&self) -> bool {
            self.embedded
        }
    }

    fn core(events: Vec<Event>) -> Vec<XwidgetEvent> {
        events.into_iter().map(Event::into_core).collect()
    }

    fn host(embedded: bool) -> (XwidgetHost, Fake, Reporter) {
        let mut host = XwidgetHost::default();
        let fake = Fake::new(embedded);
        host.attach(Ok(Box::new(fake.clone())));
        let report = host.reporter(|| {});
        (host, fake, report)
    }

    fn made(host: &mut XwidgetHost, fake: &Fake, id: u64) {
        host.request(vec![XwidgetRequest::Create { id, width: 300, height: 200, related: None }]);
        assert_eq!(fake.take(), vec![format!("create {id} 300x200")]);
    }

    fn placement(xwidget: u64, window: WindowId, visible: Rect, native: bool) -> Placement {
        Placement { xwidget, window, rect: [10.0, 20.0, 300.0, 200.0], clip: [0.0; 4], visible, native }
    }

    #[test]
    fn requests_wait_for_a_window_to_put_views_in() {
        let mut host = XwidgetHost::default();
        host.request(vec![
            XwidgetRequest::Create { id: 1, width: 300, height: 200, related: None },
            XwidgetRequest::GotoUri { id: 1, uri: "about:blank".into() },
        ]);
        assert!(host.wants_backend());
        let fake = Fake::new(true);
        host.attach(Ok(Box::new(fake.clone())));
        assert!(!host.wants_backend());
        host.begin();
        assert_eq!(fake.take(), vec!["create 1 300x200", "load 1 about:blank"]);
    }

    #[test]
    fn without_views_to_be_had_the_echo_area_says_so_once() {
        let mut host = XwidgetHost::default();
        host.request(vec![XwidgetRequest::Create { id: 1, width: 3, height: 2, related: None }]);
        host.attach(Err("no window".into()));
        assert!(!host.wants_backend());
        assert_eq!(host.messages.len(), 1);
        assert!(!host.embeds());
    }

    #[test]
    fn requests_become_the_platforms_calls() {
        let (mut host, fake, report) = host(true);
        made(&mut host, &fake, 1);
        host.request(vec![
            XwidgetRequest::GotoUri { id: 1, uri: "https://example.com".into() },
            XwidgetRequest::LoadHtml { id: 1, html: "<p>hi</p>".into(), base_uri: None },
            XwidgetRequest::Zoom { id: 1, level: 1.5 },
            XwidgetRequest::GotoHistory { id: 1, offset: 0 },
            XwidgetRequest::GotoHistory { id: 1, offset: -1 },
            XwidgetRequest::Stop { id: 1 },
            XwidgetRequest::SetCookieStorage { id: 1, file: "/tmp/c".into() },
            // Not made: nothing to do.
            XwidgetRequest::GotoUri { id: 9, uri: "x".into() },
        ]);
        assert_eq!(
            fake.take(),
            vec!["load 1 https://example.com", "html 1 <p>hi</p>", "zoom 1 1.5", "reload 1", "eval 1 history.go(-1)", "eval 1 window.stop()"]
        );
        // A script whose result is wanted waits for a page to finish
        // loading; others wry queues itself.
        host.request(vec![
            XwidgetRequest::ExecuteScript { id: 1, script: "a()".into(), callback: None },
            XwidgetRequest::ExecuteScript { id: 1, script: "1 + 1".into(), callback: Some(7) },
        ]);
        assert_eq!(fake.take(), vec!["eval 1 a()"]);
        report(Report::Finished { id: 1, uri: "https://example.com/".into() });
        host.begin();
        let log = fake.take();
        // A single expression is wrapped as it is, with no eval, which a
        // page's Content Security Policy may forbid.
        assert!(log[0].starts_with("eval 1 cb7 (() =>") && log[0].contains("v = (1 + 1") && !log[0].contains("eval)("), "{log:?}");
        host.request(vec![XwidgetRequest::ExecuteScript { id: 1, script: "b()".into(), callback: None }]);
        assert_eq!(fake.take(), vec!["eval 1 b()"]);
        host.request(vec![XwidgetRequest::Kill { id: 1 }, XwidgetRequest::Stop { id: 1 }]);
        assert_eq!(fake.take(), vec!["destroy 1"]);
    }

    #[test]
    fn statements_go_through_eval_with_a_fallback() {
        let script = wrapped("var a = 1; a + 1;");
        assert!(script.contains("(0, eval)(\"var a = 1; a + 1;\")") && script.contains("EvalError") && script.contains("(function () { var a = 1; a + 1;"), "{script}");
        assert!(wrapped("document.title;").contains("v = (document.title\n)"));
    }

    #[test]
    fn searching_repeats_the_query_either_way() {
        let (mut host, fake, _) = host(true);
        made(&mut host, &fake, 1);
        host.request(vec![
            XwidgetRequest::Search { id: 1, query: "a\"b".into(), case_insensitive: true, backwards: false, wrap_around: true },
            XwidgetRequest::NextResult { id: 1 },
            XwidgetRequest::PreviousResult { id: 1 },
            XwidgetRequest::FinishSearch { id: 1 },
            XwidgetRequest::NextResult { id: 1 },
        ]);
        assert_eq!(
            fake.take(),
            vec![
                "eval 1 window.getSelection().removeAllRanges()",
                "eval 1 window.find(\"a\\\"b\", false, false, true)",
                "eval 1 window.find(\"a\\\"b\", false, false, true)",
                "eval 1 window.find(\"a\\\"b\", false, true, true)",
                "eval 1 window.getSelection().removeAllRanges()",
            ]
        );
    }

    #[test]
    fn what_pages_report_becomes_the_editors_events() {
        let (mut host, fake, report) = host(true);
        made(&mut host, &fake, 1);
        report(Report::Started { id: 1, uri: "https://a.example/".into() });
        report(Report::Title { id: 1, title: "A".into() });
        report(Report::Finished { id: 1, uri: "https://a.example/".into() });
        // The same page again: finished, not committed again.
        report(Report::Finished { id: 1, uri: "https://a.example/".into() });
        report(Report::Navigation { id: 1, uri: "https://a.example/#x".into() });
        report(Report::Download { id: 1, url: "https://a.example/f.zip".into(), file_name: "f.zip".into() });
        report(Report::Script { callback: 3, json: "{\"a\":[1,true,null]}".into() });
        // A view since killed reports nothing.
        report(Report::Title { id: 5, title: "gone".into() });
        let events = core(host.begin().0);
        let load = |status: &str, title: &str| XwidgetEvent::LoadChanged { id: 1, status: status.into(), uri: "https://a.example/".into(), title: title.into() };
        assert_eq!(
            events,
            vec![
                load("load-started", ""),
                XwidgetEvent::TitleChanged { id: 1, title: "A".into() },
                load("load-committed", "A"),
                load("load-finished", "A"),
                XwidgetEvent::Progress { id: 1, progress: 1.0 },
                load("load-finished", "A"),
                XwidgetEvent::Progress { id: 1, progress: 1.0 },
                XwidgetEvent::DecidePolicy { id: 1, uri: "https://a.example/#x".into() },
                XwidgetEvent::Download { id: 1, url: "https://a.example/f.zip".into(), mime_type: String::new(), file_name: "f.zip".into() },
                XwidgetEvent::ScriptResult {
                    callback: 3,
                    value: Value::List(vec![Value::List(vec![
                        Value::Str("a".into()),
                        Value::List(vec![Value::Number(1.0), Value::Bool(true), Value::Null])
                    ])])
                },
            ]
        );
        // A page asking for a new window loads in the same view.
        report(Report::NewWindow { id: 1, uri: "https://b.example/".into() });
        assert!(host.begin().0.is_empty());
        assert_eq!(fake.take(), vec!["load 1 https://b.example/"]);
    }

    #[test]
    fn script_results_convert_as_webkit_js_to_lisp() {
        assert_eq!(json_to_value(""), Value::Null);
        assert_eq!(json_to_value("null"), Value::Null);
        assert_eq!(json_to_value("\"hi\""), Value::Str("hi".into()));
        assert_eq!(json_to_value("2.5"), Value::Number(2.5));
        assert_eq!(json_to_value("false"), Value::Bool(false));
        assert_eq!(json_to_value("[]"), Value::List(vec![]));
        assert_eq!(json_to_value("{}"), Value::List(vec![]));
        assert_eq!(
            json_to_value("[\"a\", {\"k\": \"v\"}]"),
            Value::List(vec![Value::Str("a".into()), Value::List(vec![Value::List(vec![Value::Str("k".into()), Value::Str("v".into())])])])
        );
    }

    #[test]
    fn views_follow_their_glyphs_and_the_editor_hears_where() {
        let (mut host, fake, _) = host(true);
        made(&mut host, &fake, 1);
        let visible = Rect::from_min_size(pos2(50.0, 60.0), vec2(300.0, 100.0));
        host.begin();
        host.drawn(vec![placement(1, 4, visible, true)]);
        let events = core(host.end(2.0));
        assert_eq!(events, vec![XwidgetEvent::Placed { xwidget: 1, window: 4, rect: [10.0, 20.0, 300.0, 200.0], clip: [0.0; 4] }]);
        assert_eq!(fake.take(), vec!["place 1 Some([100, 120, 600, 200])"]);
        // The same place again: nothing to say or do.
        host.begin();
        host.drawn(vec![placement(1, 4, visible, true)]);
        assert!(host.end(2.0).is_empty());
        assert!(fake.take().is_empty());
        // Shown in a second window too: reported, the view staying in the first.
        host.begin();
        host.drawn(vec![placement(1, 4, visible, true), placement(1, 6, visible.translate(vec2(400.0, 0.0)), false)]);
        assert_eq!(core(host.end(2.0)), vec![XwidgetEvent::Placed { xwidget: 1, window: 6, rect: [10.0, 20.0, 300.0, 200.0], clip: [0.0; 4] }]);
        assert!(fake.take().is_empty());
        // Scrolled out of both: unplaced, and hidden.
        host.begin();
        host.drawn(vec![]);
        assert_eq!(core(host.end(2.0)), vec![XwidgetEvent::Unplaced { xwidget: 1, window: 4 }, XwidgetEvent::Unplaced { xwidget: 1, window: 6 }]);
        assert_eq!(fake.take(), vec!["place 1 None"]);
    }

    #[test]
    fn a_deleted_view_is_hidden_and_placed_again_while_shown() {
        let (mut host, fake, _) = host(true);
        made(&mut host, &fake, 1);
        let visible = Rect::from_min_size(pos2(0.0, 0.0), vec2(30.0, 20.0));
        host.begin();
        host.drawn(vec![placement(1, 4, visible, true)]);
        host.end(1.0);
        fake.take();
        host.request(vec![XwidgetRequest::DeleteView { id: 1, window: 4 }]);
        assert_eq!(fake.take(), vec!["place 1 None"]);
        host.begin();
        host.drawn(vec![placement(1, 4, visible, true)]);
        assert_eq!(host.end(1.0).len(), 1);
        assert_eq!(fake.take(), vec!["place 1 Some([0, 0, 30, 20])"]);
    }

    #[test]
    fn views_in_windows_of_their_own_show_while_their_xwidget_does() {
        let (mut host, fake, _) = host(false);
        made(&mut host, &fake, 1);
        assert!(!host.embeds());
        let visible = Rect::from_min_size(pos2(0.0, 0.0), vec2(30.0, 20.0));
        host.begin();
        host.drawn(vec![placement(1, 4, visible, false)]);
        assert_eq!(host.end(1.0).len(), 1);
        assert_eq!(fake.take(), vec!["place 1 Some([0, 0, 0, 0])"]);
        host.begin();
        host.drawn(vec![]);
        host.end(1.0);
        assert_eq!(fake.take(), vec!["place 1 None"]);
    }

    #[test]
    fn the_sink_puts_the_view_in_the_first_window_and_boxes_elsewhere() {
        let ctx = egui::Context::default();
        let labels = HashMap::from([(1, "Example".to_string())]);
        let mut placements = Vec::new();
        let mut output = ctx.run_ui(Default::default(), |ui| {
            let clip = Rect::from_min_max(pos2(0.0, 0.0), pos2(200.0, 100.0));
            let painter = ui.painter().with_clip_rect(clip);
            let t = Tokens::new(false);
            let mut sink = Sink::new(&labels, true);
            // Hanging off the right and bottom of the text area.
            sink.glyph(&painter, 4, pos2(10.0, 10.0), 1, glyph_rect(300.0, 200.0, pos2(50.0, -20.0)), t);
            sink.glyph(&painter, 6, pos2(0.0, 0.0), 1, glyph_rect(30.0, 20.0, pos2(0.0, 0.0)), t);
            placements = std::mem::take(&mut sink.placements);
        });
        output.textures_delta.clear();
        assert_eq!(placements.len(), 2);
        let first = &placements[0];
        assert!(first.native);
        assert_eq!(first.rect, [40.0, -30.0, 300.0, 200.0]);
        assert_eq!(first.clip, [150.0, 80.0, 20.0, 0.0]);
        assert_eq!(first.visible, Rect::from_min_max(pos2(50.0, 0.0), pos2(200.0, 100.0)));
        assert!(!placements[1].native);
    }
}
