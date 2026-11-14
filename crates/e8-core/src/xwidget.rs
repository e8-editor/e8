//! xwidgets, as Emacs's xwidget.c (ADR 0089): WebKit web views shown in
//! buffers. The core holds the model and no web engine: xwidgets and their
//! views as values (`Value::Xwidget`), what Emacs keeps of each, and what
//! the front end last reported of its page. The primitives queue requests
//! (`XwidgetRequest`) for a front end that has web views to carry out, and
//! the front end reports back (`XwidgetEvent`), which becomes Emacs's
//! `(xwidget-event TYPE XW ARG...)` for `xwidget-event-handler`. A
//! `(xwidget :xwidget XW)` display property shows as a glyph of the
//! xwidget's size (`ImageGlyph::xwidget`), whose place on the screen the
//! front end works out and reports back as the xwidget's view in that
//! window.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;
use crate::window::WindowId;

/// An xwidget or one of its views, as Emacs's xwidget and xwidget-view objects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum XwObject {
    Widget(u64),
    View(u64),
}

/// An xwidget, as xwidget.c's `struct xwidget`, with what the front end
/// last said of its page.
#[derive(Clone, Debug)]
pub struct Xwidget {
    pub id: u64,
    pub kind: String,
    pub title: Value,
    pub width: u32,
    pub height: u32,
    pub buffer: u64,
    pub plist: Value,
    pub query_on_exit: bool,
    pub live: bool,
    pub uri: String,
    pub page_title: String,
    pub progress: f64,
    pub zoom: f64,
    /// The pages visited, oldest first, and which is shown.
    pub history: Vec<(String, String)>,
    pub history_index: usize,
    /// A move through the history asked for and not yet reported, which
    /// the next page committed is.
    pub history_move: Option<i64>,
    pub searching: bool,
    pub cookie_file: Option<String>,
}

/// Where a window shows an xwidget, as the front end reported it: x, y,
/// width and height in the window, and how much is clipped off each side.
#[derive(Clone, Debug, PartialEq)]
pub struct XwidgetView {
    pub id: u64,
    pub xwidget: u64,
    pub window: WindowId,
    pub rect: [f32; 4],
    /// Clipped off right, bottom, top and left, as `xwidget-view-info` gives them.
    pub clip: [f32; 4],
}

/// What a front end with web views is asked to do.
#[derive(Clone, Debug, PartialEq)]
pub enum XwidgetRequest {
    /// Make a web view, sharing its settings with `related`'s if given.
    Create { id: u64, width: u32, height: u32, related: Option<u64> },
    GotoUri { id: u64, uri: String },
    LoadHtml { id: u64, html: String, base_uri: Option<String> },
    /// Run a script, giving its result back with `callback` if there is one.
    ExecuteScript { id: u64, script: String, callback: Option<u64> },
    Resize { id: u64, width: u32, height: u32 },
    Zoom { id: u64, level: f64 },
    GotoHistory { id: u64, offset: i64 },
    Stop { id: u64 },
    Search { id: u64, query: String, case_insensitive: bool, backwards: bool, wrap_around: bool },
    NextResult { id: u64 },
    PreviousResult { id: u64 },
    FinishSearch { id: u64 },
    SetCookieStorage { id: u64, file: String },
    /// Hide the view in this window, as `delete-xwidget-view`.
    DeleteView { id: u64, window: WindowId },
    Kill { id: u64 },
}

/// What a front end reports of its web views.
#[derive(Clone, Debug, PartialEq)]
pub enum XwidgetEvent {
    /// A page's loading moved on: "load-started", "load-redirected",
    /// "load-committed" or "load-finished", as WebKit's load-changed says.
    LoadChanged { id: u64, status: String, uri: String, title: String },
    TitleChanged { id: u64, title: String },
    Progress { id: u64, progress: f64 },
    /// A script's result, converted as `webkit_js_to_lisp` converts it.
    ScriptResult { callback: u64, value: Value },
    /// A navigation the page asked for, as WebKit's decide-policy, with its URI.
    DecidePolicy { id: u64, uri: String },
    Download { id: u64, url: String, mime_type: String, file_name: String },
    /// Where a window now shows an xwidget.
    Placed { xwidget: u64, window: WindowId, rect: [f32; 4], clip: [f32; 4] },
    /// A window shows the xwidget no more.
    Unplaced { xwidget: u64, window: WindowId },
}

#[derive(Default)]
pub struct Xwidgets {
    widgets: Vec<Xwidget>,
    views: Vec<XwidgetView>,
    requests: Vec<XwidgetRequest>,
    callbacks: std::collections::HashMap<u64, (u64, Value)>,
    next: u64,
    next_view: u64,
    next_callback: u64,
}

fn symbol(name: &str) -> Value {
    Value::Symbol(name.to_string())
}

fn not_live(value: Value) -> Error {
    crate::xfaces::wrong_type("xwidget-live-p", &value)
}

impl Editor {
    fn xwidget(&self, id: u64) -> Option<&Xwidget> {
        self.xwidgets.widgets.iter().find(|x| x.id == id)
    }

    fn xwidget_mut(&mut self, id: u64) -> Option<&mut Xwidget> {
        self.xwidgets.widgets.iter_mut().find(|x| x.id == id)
    }

    /// The live xwidget a value is, as `CHECK_LIVE_XWIDGET`.
    fn live_xwidget(&self, value: &Value) -> Result<u64> {
        match value {
            Value::Xwidget(XwObject::Widget(id)) if self.xwidget(*id).is_some_and(|x| x.live) => Ok(*id),
            other => Err(not_live(other.clone())),
        }
    }

    /// The xwidget a value is, live or killed, as `CHECK_XWIDGET`.
    fn any_xwidget(&self, value: &Value) -> Result<u64> {
        match value {
            Value::Xwidget(XwObject::Widget(id)) if self.xwidget(*id).is_some() => Ok(*id),
            other => Err(crate::xfaces::wrong_type("xwidgetp", other)),
        }
    }

    /// A live WebKit xwidget, as xwidget.c's `CHECK_WEBKIT_WIDGET`.
    fn webkit(&self, value: &Value) -> Result<u64> {
        let id = self.live_xwidget(value)?;
        if self.xwidget(id).is_some_and(|x| x.kind == "webkit") { Ok(id) } else { Err(Error::new("Not a WebKit widget")) }
    }

    fn view(&self, value: &Value) -> Result<&XwidgetView> {
        match value {
            Value::Xwidget(XwObject::View(id)) => self.xwidgets.views.iter().find(|v| v.id == *id).ok_or_else(|| crate::xfaces::wrong_type("xwidget-view-p", value)),
            other => Err(crate::xfaces::wrong_type("xwidget-view-p", other)),
        }
    }

    /// Whether the front end shows web views, as a window system does.
    pub fn xwidgets_shown(&self) -> bool {
        self.metrics.xwidgets()
    }

    /// Makes an xwidget, as `make-xwidget`: of TYPE `webkit`, in BUFFER
    /// (the current one by default, made if a name names none), loading
    /// about:blank. An error where the front end shows no web views, as
    /// Emacs's without a window system.
    pub fn make_xwidget(&mut self, kind: &str, title: Value, width: u32, height: u32, buffer: Option<&str>, related: &Value) -> Result<Value> {
        if !self.xwidgets_shown() {
            return Err(Error::new("make-xwidget: this display shows no web views"));
        }
        if kind != "webkit" {
            return Err(Error::new("Bad xwidget type"));
        }
        let buffer = match buffer {
            Some(name) => {
                let index = self.get_buffer_create(name);
                self.buffers()[index].id()
            }
            None => self.buffer().id(),
        };
        self.xwidgets.next += 1;
        let id = self.xwidgets.next;
        let related = match related {
            Value::Xwidget(XwObject::Widget(r)) if self.xwidget(*r).is_some_and(|x| x.kind == "webkit") => Some(*r),
            _ => None,
        };
        self.xwidgets.widgets.push(Xwidget {
            id,
            kind: kind.to_string(),
            title,
            width,
            height,
            buffer,
            plist: Value::Null,
            query_on_exit: true,
            live: true,
            uri: "about:blank".into(),
            page_title: String::new(),
            progress: 0.0,
            zoom: 1.0,
            history: Vec::new(),
            history_index: 0,
            history_move: None,
            searching: false,
            cookie_file: None,
        });
        self.xwidgets.requests.push(XwidgetRequest::Create { id, width, height, related });
        self.xwidgets.requests.push(XwidgetRequest::GotoUri { id, uri: "about:blank".into() });
        Ok(Value::Xwidget(XwObject::Widget(id)))
    }

    /// Whether a value is an xwidget, as `xwidgetp`.
    pub fn xwidgetp(&self, value: &Value) -> bool {
        matches!(value, Value::Xwidget(XwObject::Widget(id)) if self.xwidget(*id).is_some())
    }

    /// Whether a value is an xwidget that has not been killed, as `xwidget-live-p`.
    pub fn xwidget_live_p(&self, value: &Value) -> bool {
        self.live_xwidget(value).is_ok()
    }

    /// Whether a value is an xwidget's view, as `xwidget-view-p`.
    pub fn xwidget_view_p(&self, value: &Value) -> bool {
        self.view(value).is_ok()
    }

    /// The live xwidgets a buffer holds, newest first, as `get-buffer-xwidgets`.
    pub fn get_buffer_xwidgets(&self, buffer: u64) -> Vec<Value> {
        self.xwidgets.widgets.iter().rev().filter(|x| x.live && x.buffer == buffer).map(|x| Value::Xwidget(XwObject::Widget(x.id))).collect()
    }

    /// What the front end last said a page's URI is, as `xwidget-webkit-uri`.
    pub fn xwidget_webkit_uri(&self, xw: &Value) -> Result<String> {
        let id = self.webkit(xw)?;
        Ok(self.xwidget(id).map(|x| x.uri.clone()).unwrap_or_default())
    }

    /// A page's title, as `xwidget-webkit-title`.
    pub fn xwidget_webkit_title(&self, xw: &Value) -> Result<String> {
        let id = self.webkit(xw)?;
        Ok(self.xwidget(id).map(|x| x.page_title.clone()).unwrap_or_default())
    }

    /// How far a page has loaded, from 0 to 1, as `xwidget-webkit-estimated-load-progress`.
    pub fn xwidget_webkit_estimated_load_progress(&self, xw: &Value) -> Result<f64> {
        let id = self.webkit(xw)?;
        Ok(self.xwidget(id).map_or(0.0, |x| x.progress))
    }

    /// Loads a URI, as `xwidget-webkit-goto-uri`, asking the agent's
    /// permission while it acts, as opening a connection does.
    pub fn xwidget_webkit_goto_uri(&mut self, xw: &Value, uri: &str) -> Result<()> {
        let id = self.webkit(xw)?;
        self.check_permission(&format!("open the web page {uri}"))?;
        if let Some(x) = self.xwidget_mut(id) {
            x.uri = uri.to_string();
            x.progress = 0.0;
        }
        self.xwidgets.requests.push(XwidgetRequest::GotoUri { id, uri: uri.to_string() });
        Ok(())
    }

    /// Loads HTML, as `xwidget-webkit-load-html`.
    pub fn xwidget_webkit_load_html(&mut self, xw: &Value, html: &str, base_uri: Option<&str>) -> Result<()> {
        let id = self.webkit(xw)?;
        // A page of its own can load others, so the agent asks as for a URI.
        self.check_permission("show HTML in a web page")?;
        self.xwidgets.requests.push(XwidgetRequest::LoadHtml { id, html: html.to_string(), base_uri: base_uri.map(str::to_string) });
        Ok(())
    }

    /// Goes back or forward in a view's history, as
    /// `xwidget-webkit-goto-history`: -1 back, 1 forward, 0 reloads.
    pub fn xwidget_webkit_goto_history(&mut self, xw: &Value, offset: i64) -> Result<()> {
        let id = self.webkit(xw)?;
        let x = self.xwidget(id).expect("live");
        let target = x.history_index as i64 + offset;
        if offset != 0 && (target < 0 || target >= x.history.len() as i64) {
            return Err(Error::new("There is no item at this index"));
        }
        self.xwidget_mut(id).expect("live").history_move = (offset != 0).then_some(offset);
        self.xwidgets.requests.push(XwidgetRequest::GotoHistory { id, offset });
        Ok(())
    }

    /// Changes a page's zoom by an amount, as `xwidget-webkit-zoom`: added
    /// to its zoom level, as WebKit's zoom level and WKWebView's
    /// magnification take it in Emacs.
    pub fn xwidget_webkit_zoom(&mut self, xw: &Value, change: f64) -> Result<()> {
        let id = self.webkit(xw)?;
        let x = self.xwidget_mut(id).expect("live");
        x.zoom = (x.zoom + change).max(0.1);
        let level = x.zoom;
        self.xwidgets.requests.push(XwidgetRequest::Zoom { id, level });
        Ok(())
    }

    /// Runs a script in a page, as `xwidget-webkit-execute-script`; with a
    /// function, its result comes to it through a `javascript-callback` event.
    pub fn xwidget_webkit_execute_script(&mut self, xw: &Value, script: &str, function: Option<Value>) -> Result<()> {
        let id = self.webkit(xw)?;
        // A page's JavaScript can load any page, so the agent asks first.
        self.check_permission("run JavaScript in a web page")?;
        let callback = function.map(|f| {
            self.xwidgets.next_callback += 1;
            self.xwidgets.callbacks.insert(self.xwidgets.next_callback, (id, f));
            self.xwidgets.next_callback
        });
        self.xwidgets.requests.push(XwidgetRequest::ExecuteScript { id, script: script.to_string(), callback });
        Ok(())
    }

    /// Resizes an xwidget, as `xwidget-resize`.
    pub fn xwidget_resize(&mut self, xw: &Value, width: u32, height: u32) -> Result<()> {
        let id = self.live_xwidget(xw)?;
        let x = self.xwidget_mut(id).expect("live");
        x.width = width;
        x.height = height;
        self.xwidgets.requests.push(XwidgetRequest::Resize { id, width, height });
        self.style_cache.borrow_mut().clear();
        Ok(())
    }

    /// The size an xwidget asks for, as `xwidget-size-request`: its own.
    pub fn xwidget_size_request(&self, xw: &Value) -> Result<(u32, u32)> {
        let id = self.live_xwidget(xw)?;
        let x = self.xwidget(id).expect("live");
        Ok((x.width, x.height))
    }

    /// An xwidget's type, title, width and height, as `xwidget-info`.
    pub fn xwidget_info(&self, xw: &Value) -> Result<Value> {
        let id = self.live_xwidget(xw)?;
        let x = self.xwidget(id).expect("live");
        Ok(Value::List(vec![symbol(&x.kind), x.title.clone(), Value::Number(f64::from(x.width)), Value::Number(f64::from(x.height))]))
    }

    /// A view's place, as `xwidget-view-info`: `[X Y CLIP_RIGHT
    /// CLIP_BOTTOM CLIP_TOP CLIP_LEFT]`, the right and bottom clips as how
    /// far the visible part reaches and the top and left as how much is cut
    /// off, as xwidget.c keeps them: the width and height, and 0 and 0,
    /// when none of it is clipped.
    pub fn xwidget_view_info(&self, view: &Value) -> Result<Value> {
        let v = self.view(view)?;
        let n = |x: f32| Value::Number(f64::from(x.round()));
        let [x, y, w, h] = v.rect;
        let [right, bottom, top, left] = v.clip;
        Ok(Value::List(vec![n(x), n(y), n(w - right), n(h - bottom), n(top), n(left)]))
    }

    /// A view's xwidget, as `xwidget-view-model`.
    pub fn xwidget_view_model(&self, view: &Value) -> Result<Value> {
        Ok(Value::Xwidget(XwObject::Widget(self.view(view)?.xwidget)))
    }

    /// A view's window, as `xwidget-view-window`.
    pub fn xwidget_view_window(&self, view: &Value) -> Result<Value> {
        Ok(Value::Window(self.view(view)?.window))
    }

    /// Takes a view off the screen, as `delete-xwidget-view`.
    pub fn delete_xwidget_view(&mut self, view: &Value) -> Result<()> {
        let v = self.view(view)?.clone();
        self.xwidgets.views.retain(|x| x.id != v.id);
        self.xwidgets.requests.push(XwidgetRequest::DeleteView { id: v.xwidget, window: v.window });
        Ok(())
    }

    /// The view of an xwidget in a window, the selected one by default, as `xwidget-view-lookup`.
    pub fn xwidget_view_lookup(&self, xw: &Value, window: Option<WindowId>) -> Result<Option<Value>> {
        let id = self.any_xwidget(xw)?;
        let window = window.unwrap_or_else(|| self.selected_window());
        Ok(self.xwidgets.views.iter().find(|v| v.xwidget == id && v.window == window).map(|v| Value::Xwidget(XwObject::View(v.id))))
    }

    /// An xwidget's property list, as `xwidget-plist`.
    pub fn xwidget_plist(&self, xw: &Value) -> Result<Value> {
        let id = self.any_xwidget(xw)?;
        Ok(self.xwidget(id).expect("there").plist.clone())
    }

    /// Sets an xwidget's property list, as `set-xwidget-plist`.
    pub fn set_xwidget_plist(&mut self, xw: &Value, plist: Value) -> Result<Value> {
        let id = self.any_xwidget(xw)?;
        if !matches!(plist, Value::Null | Value::List(_)) {
            return Err(crate::xfaces::wrong_type("listp", &plist));
        }
        self.xwidget_mut(id).expect("there").plist = plist.clone();
        Ok(plist)
    }

    /// An xwidget's buffer, as `xwidget-buffer`.
    pub fn xwidget_buffer(&self, xw: &Value) -> Result<Value> {
        let id = self.any_xwidget(xw)?;
        Ok(Value::Buffer(self.xwidget(id).expect("there").buffer))
    }

    /// Moves an xwidget to another buffer, as `set-xwidget-buffer`.
    pub fn set_xwidget_buffer(&mut self, xw: &Value, buffer: u64) -> Result<()> {
        let id = self.any_xwidget(xw)?;
        self.xwidget_mut(id).expect("there").buffer = buffer;
        Ok(())
    }

    /// Whether exiting asks about a live xwidget, as `xwidget-query-on-exit-flag`.
    pub fn xwidget_query_on_exit_flag(&self, xw: &Value) -> Result<bool> {
        let id = self.any_xwidget(xw)?;
        Ok(self.xwidget(id).expect("there").query_on_exit)
    }

    /// Sets it, as `set-xwidget-query-on-exit-flag`.
    pub fn set_xwidget_query_on_exit_flag(&mut self, xw: &Value, flag: bool) -> Result<()> {
        let id = self.any_xwidget(xw)?;
        self.xwidget_mut(id).expect("there").query_on_exit = flag;
        Ok(())
    }

    /// Searches a page, as `xwidget-webkit-search`.
    pub fn xwidget_webkit_search(&mut self, query: &str, xw: &Value, case_insensitive: bool, backwards: bool, wrap_around: bool) -> Result<()> {
        let id = self.webkit(xw)?;
        self.xwidget_mut(id).expect("live").searching = true;
        self.xwidgets.requests.push(XwidgetRequest::Search { id, query: query.to_string(), case_insensitive, backwards, wrap_around });
        Ok(())
    }

    /// Moves to the next or previous match, or ends the search, as
    /// `xwidget-webkit-next-result`, `-previous-result` and `-finish-search`.
    pub fn xwidget_webkit_search_step(&mut self, xw: &Value, step: &str) -> Result<()> {
        let id = self.webkit(xw)?;
        let x = self.xwidget_mut(id).expect("live");
        if !x.searching {
            return Err(Error::new("Widget has no ongoing search operation"));
        }
        let request = match step {
            "next" => XwidgetRequest::NextResult { id },
            "previous" => XwidgetRequest::PreviousResult { id },
            _ => {
                x.searching = false;
                XwidgetRequest::FinishSearch { id }
            }
        };
        self.xwidgets.requests.push(request);
        Ok(())
    }

    /// Stops loading a page, as `xwidget-webkit-stop-loading`.
    pub fn xwidget_webkit_stop_loading(&mut self, xw: &Value) -> Result<()> {
        let id = self.webkit(xw)?;
        self.xwidgets.requests.push(XwidgetRequest::Stop { id });
        Ok(())
    }

    /// Where a view keeps its cookies, as `xwidget-webkit-set-cookie-storage-file`.
    pub fn xwidget_webkit_set_cookie_storage_file(&mut self, xw: &Value, file: &str) -> Result<()> {
        let id = self.webkit(xw)?;
        let file = self.expand_file_name(file).to_string_lossy().into_owned();
        self.xwidget_mut(id).expect("live").cookie_file = Some(file.clone());
        self.xwidgets.requests.push(XwidgetRequest::SetCookieStorage { id, file });
        Ok(())
    }

    /// A view's history around the page shown, as
    /// `xwidget-webkit-back-forward-list`: the current item, the ones back
    /// and the ones forward, each `[index, title, uri]`, at most LIMIT each way.
    pub fn xwidget_webkit_back_forward_list(&self, xw: &Value, limit: Option<usize>) -> Result<Value> {
        let id = self.webkit(xw)?;
        let x = self.xwidget(id).expect("live");
        let item = |i: usize| {
            let (uri, title) = &x.history[i];
            Value::List(vec![Value::Number(i as f64 - x.history_index as f64), Value::Str(title.clone()), Value::Str(uri.clone())])
        };
        let limit = limit.unwrap_or(50);
        let current = if x.history_index < x.history.len() { item(x.history_index) } else { Value::Null };
        let back: Vec<Value> = (0..x.history_index.min(x.history.len())).rev().take(limit).map(item).collect();
        let forward: Vec<Value> = (x.history_index + 1..x.history.len()).take(limit).map(item).collect();
        Ok(Value::List(vec![current, Value::List(back), Value::List(forward)]))
    }

    /// Kills an xwidget, as `kill-xwidget`: its views go, and it is no longer live.
    pub fn kill_xwidget(&mut self, xw: &Value) -> Result<()> {
        let id = self.live_xwidget(xw)?;
        self.xwidget_mut(id).expect("live").live = false;
        self.xwidgets.views.retain(|v| v.xwidget != id);
        self.xwidgets.callbacks.retain(|_, (x, _)| *x != id);
        self.xwidgets.requests.push(XwidgetRequest::Kill { id });
        Ok(())
    }

    /// Kills a buffer's xwidgets, as killing the buffer does.
    pub(crate) fn kill_buffer_xwidgets(&mut self, buffer: u64) {
        for xw in self.get_buffer_xwidgets(buffer) {
            let _ = self.kill_xwidget(&xw);
        }
    }

    /// The size an xwidget shows at, for laying out its glyph.
    pub(crate) fn xwidget_size(&self, id: u64) -> Option<(u32, u32)> {
        self.xwidget(id).filter(|x| x.live).map(|x| (x.width, x.height))
    }

    /// The live xwidgets and their title, for a front end that shows a box
    /// in place of a view it cannot embed.
    pub fn xwidget_label(&self, id: u64) -> Option<String> {
        let x = self.xwidget(id)?;
        Some(if x.page_title.is_empty() { x.title.as_str().unwrap_or("xwidget").to_string() } else { x.page_title.clone() })
    }

    /// What front ends have been asked to do since they last asked.
    pub fn take_xwidget_requests(&mut self) -> Vec<XwidgetRequest> {
        std::mem::take(&mut self.xwidgets.requests)
    }

    /// Takes in what a front end reports of its web views, as Emacs's
    /// xwidget callbacks do: the xwidget's state, its views, and, for what
    /// Emacs makes one of, an `xwidget-event` for `xwidget-event-handler`.
    pub fn xwidget_event(&mut self, event: XwidgetEvent) {
        let posted = match event {
            XwidgetEvent::LoadChanged { id, status, uri, title } => {
                let Some(x) = self.xwidget_mut(id).filter(|x| x.live) else { return };
                x.uri = uri.clone();
                if !title.is_empty() {
                    x.page_title = title.clone();
                }
                if status == "load-committed" {
                    let target = x.history_move.take().map(|offset| x.history_index as i64 + offset);
                    match target {
                        // A move back or forward asked for: the page there.
                        Some(t) if t >= 0 && (t as usize) < x.history.len() => {
                            x.history_index = t as usize;
                            x.history[t as usize].0 = uri;
                        }
                        _ if x.history.get(x.history_index).is_some_and(|(u, _)| *u == uri) => {}
                        // A new page, after the one shown; what was forward goes.
                        _ => {
                            let next = if x.history.is_empty() { 0 } else { x.history_index + 1 };
                            x.history.truncate(next);
                            x.history.push((uri, title));
                            x.history_index = x.history.len() - 1;
                        }
                    }
                }
                if status == "load-finished" {
                    x.progress = 1.0;
                    let index = x.history_index;
                    let page_title = x.page_title.clone();
                    if let Some(entry) = x.history.get_mut(index) {
                        entry.1 = page_title;
                    }
                }
                Some((id, vec![symbol("load-changed"), Value::Xwidget(XwObject::Widget(id)), Value::Str(status)]))
            }
            XwidgetEvent::TitleChanged { id, title } => {
                if let Some(x) = self.xwidget_mut(id) {
                    x.page_title = title;
                }
                None
            }
            XwidgetEvent::Progress { id, progress } => {
                if let Some(x) = self.xwidget_mut(id) {
                    x.progress = progress;
                }
                None
            }
            XwidgetEvent::ScriptResult { callback, value } => {
                let Some((id, function)) = self.xwidgets.callbacks.remove(&callback) else { return };
                Some((id, vec![symbol("javascript-callback"), Value::Xwidget(XwObject::Widget(id)), function, value]))
            }
            XwidgetEvent::DecidePolicy { id, uri } => Some((id, vec![symbol("decide-policy"), Value::Xwidget(XwObject::Widget(id)), Value::Str(uri)])),
            XwidgetEvent::Download { id, url, mime_type, file_name } => Some((
                id,
                vec![symbol("download-callback"), Value::Xwidget(XwObject::Widget(id)), Value::Str(url), Value::Str(mime_type), Value::Str(file_name)],
            )),
            XwidgetEvent::Placed { xwidget, window, rect, clip } => {
                match self.xwidgets.views.iter_mut().find(|v| v.xwidget == xwidget && v.window == window) {
                    Some(v) => {
                        v.rect = rect;
                        v.clip = clip;
                    }
                    None => {
                        self.xwidgets.next_view += 1;
                        let id = self.xwidgets.next_view;
                        self.xwidgets.views.push(XwidgetView { id, xwidget, window, rect, clip });
                    }
                }
                None
            }
            XwidgetEvent::Unplaced { xwidget, window } => {
                self.xwidgets.views.retain(|v| !(v.xwidget == xwidget && v.window == window));
                None
            }
        };
        let Some((id, args)) = posted else { return };
        if self.xwidget(id).is_none_or(|x| !x.live) {
            return;
        }
        let mut event = vec![symbol("xwidget-event")];
        event.extend(args);
        self.post_xwidget_event(Value::List(event));
    }

    /// Hands an xwidget event to `xwidget-event-handler` as `last-input-event`,
    /// as `special-event-map` binds `xwidget-event` in Emacs.
    fn post_xwidget_event(&mut self, event: Value) {
        self.set_variable("last-input-event", event);
        if self.fboundp("xwidget-event-handler")
            && let Err(e) = self.funcall(&Value::Symbol("xwidget-event-handler".into()), &[])
        {
            self.message(format!("Error in xwidget event handler: {e}"));
        }
    }
}

/// The xwidget a display property shows, `(xwidget :xwidget XW)`.
pub(crate) fn xwidget_display(value: &Value) -> Option<u64> {
    let Value::List(items) = value else { return None };
    if items.first().and_then(Value::as_str) != Some("xwidget") {
        return None;
    }
    items[1..].chunks(2).find_map(|pair| match pair {
        [key, Value::Xwidget(XwObject::Widget(id))] if key.as_str() == Some(":xwidget") => Some(*id),
        _ => None,
    })
}
