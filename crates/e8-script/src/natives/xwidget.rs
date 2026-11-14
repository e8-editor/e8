//! xwidgets, web views shown in buffers, as Emacs's xwidget.c gives them
//! (ADR 0089). The primitives ask the front end, which carries them out
//! between frames; what it reports comes back as `xwidget-event`s.

use crate::*;
use crate::natives::{Opt, Rest, natives};

fn natural(value: &EditorValue) -> Result<u32> {
    match value {
        EditorValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(u32::MAX) => Ok(*n as u32),
        other => Err(e8_core::xfaces::wrong_type("wholenump", other)),
    }
}

fn text(value: &EditorValue) -> Result<String> {
    match value {
        EditorValue::Str(s) => Ok(s.clone()),
        EditorValue::Text(t) => Ok(t.string.clone()),
        other => Err(e8_core::xfaces::wrong_type("stringp", other)),
    }
}

fn buffer_id(ed: &Editor, value: &EditorValue) -> Result<u64> {
    match value {
        EditorValue::Buffer(id) if ed.buffer_with_id(*id).is_some() => Ok(*id),
        EditorValue::Str(name) => ed.buffers().iter().find(|b| &b.name == name).map(|b| b.id()).ok_or_else(|| Error::new(format!("No such buffer {name}"))),
        other => Err(e8_core::xfaces::wrong_type("bufferp", other)),
    }
}

natives! {
    /// Make an xwidget of a type, `webkit`, a web view, in a buffer (the current one by default, made if a name names none), as make-xwidget. An error where the display shows no web views.
    #[ts = "(type: string | symbol, title: string, width: number, height: number, arguments?: Value, buffer?: string | Buffer | null, related?: Xwidget | null): Xwidget"]
    pub fn makeXwidget(ed, kind: EditorValue, title: EditorValue, width: EditorValue, height: EditorValue, rest: Rest<EditorValue>) -> EditorValue {
        // ARGUMENTS, BUFFER and RELATED, optional, as one rest list, as
        // QuickJS's bindings take at most seven.
        let mut rest = rest.0.into_iter().skip(1);
        let (buffer, related) = (rest.next(), rest.next());
        let kind = match &kind {
            EditorValue::Symbol(s) | EditorValue::Str(s) => s.clone(),
            other => return Err(e8_core::xfaces::wrong_type("symbolp", other)),
        };
        let (width, height) = (natural(&width)?, natural(&height)?);
        let buffer = match buffer {
            None | Some(EditorValue::Null) => None,
            Some(EditorValue::Buffer(id)) => ed.buffer_with_id(id).map(|i| ed.buffers()[i].name.clone()),
            Some(b) => Some(text(&b)?),
        };
        ed.make_xwidget(&kind, title, width, height, buffer.as_deref(), &related.unwrap_or(EditorValue::Null))
    }

    /// Whether an object is an xwidget, as xwidgetp.
    #[ts = "(object: unknown): object is Xwidget"]
    pub fn xwidgetp(ed, object: EditorValue) -> bool {
        Ok(ed.xwidgetp(&object))
    }

    /// Whether an object is an xwidget not yet killed, as xwidget-live-p.
    #[ts = "(object: unknown): boolean"]
    pub fn xwidgetLiveP(ed, object: EditorValue) -> bool {
        Ok(ed.xwidget_live_p(&object))
    }

    /// Whether an object is an xwidget's view in a window, as xwidget-view-p.
    #[ts = "(object: unknown): object is XwidgetView"]
    pub fn xwidgetViewP(ed, object: EditorValue) -> bool {
        Ok(ed.xwidget_view_p(&object))
    }

    /// The live xwidgets in a buffer, as get-buffer-xwidgets.
    #[ts = "(buffer: Buffer | string): Xwidget[]"]
    pub fn getBufferXwidgets(ed, buffer: EditorValue) -> Vec<EditorValue> {
        let id = buffer_id(ed, &buffer)?;
        Ok(ed.get_buffer_xwidgets(id))
    }

    /// The URI a web view shows, as xwidget-webkit-uri.
    #[ts = "(xwidget: Xwidget): string"]
    pub fn xwidgetWebkitUri(ed, xw: EditorValue) -> String {
        ed.xwidget_webkit_uri(&xw)
    }

    /// The title of the page a web view shows, as xwidget-webkit-title.
    #[ts = "(xwidget: Xwidget): string"]
    pub fn xwidgetWebkitTitle(ed, xw: EditorValue) -> String {
        ed.xwidget_webkit_title(&xw)
    }

    /// How far a page has loaded, from 0 to 1, as xwidget-webkit-estimated-load-progress.
    #[ts = "(xwidget: Xwidget): number"]
    pub fn xwidgetWebkitEstimatedLoadProgress(ed, xw: EditorValue) -> f64 {
        ed.xwidget_webkit_estimated_load_progress(&xw)
    }

    /// Load a URI in a web view, as xwidget-webkit-goto-uri.
    #[ts = "(xwidget: Xwidget, uri: string): undefined"]
    pub fn xwidgetWebkitGotoUri(ed, xw: EditorValue, uri: EditorValue) -> Option<bool> {
        let uri = text(&uri)?;
        ed.xwidget_webkit_goto_uri(&xw, &uri)?;
        Ok(None)
    }

    /// Show HTML in a web view, as xwidget-webkit-load-html.
    #[ts = "(xwidget: Xwidget, text: string, baseUri?: string | null): undefined"]
    pub fn xwidgetWebkitLoadHtml(ed, xw: EditorValue, html: EditorValue, base: Opt<EditorValue>) -> Option<bool> {
        let html = text(&html)?;
        let base = match base.0 {
            None | Some(EditorValue::Null) => None,
            Some(b) => Some(text(&b)?),
        };
        ed.xwidget_webkit_load_html(&xw, &html, base.as_deref())?;
        Ok(None)
    }

    /// Go back (-1), forward (1) or reload (0) in a web view's history, as xwidget-webkit-goto-history.
    #[ts = "(xwidget: Xwidget, relPos: number): undefined"]
    pub fn xwidgetWebkitGotoHistory(ed, xw: EditorValue, offset: f64) -> Option<bool> {
        ed.xwidget_webkit_goto_history(&xw, offset as i64)?;
        Ok(None)
    }

    /// Change a page's zoom by an amount added to its zoom level, as xwidget-webkit-zoom.
    #[ts = "(xwidget: Xwidget, factor: number): undefined"]
    pub fn xwidgetWebkitZoom(ed, xw: EditorValue, factor: f64) -> Option<bool> {
        ed.xwidget_webkit_zoom(&xw, factor)?;
        Ok(None)
    }

    /// Run JavaScript in a page, as xwidget-webkit-execute-script; its result comes to `fun`, if given, through a javascript-callback xwidget event.
    #[ts = "(xwidget: Xwidget, script: string, fun?: ((result: Value) => void) | string | null): undefined"]
    pub fn xwidgetWebkitExecuteScript(ed, xw: EditorValue, script: EditorValue, function: Opt<EditorValue>) -> Option<bool> {
        let script = text(&script)?;
        ed.xwidget_webkit_execute_script(&xw, &script, function.0.filter(|f| !matches!(f, EditorValue::Null)))?;
        Ok(None)
    }

    /// Resize an xwidget, as xwidget-resize.
    #[ts = "(xwidget: Xwidget, newWidth: number, newHeight: number): undefined"]
    pub fn xwidgetResize(ed, xw: EditorValue, width: EditorValue, height: EditorValue) -> Option<bool> {
        ed.xwidget_resize(&xw, natural(&width)?, natural(&height)?)?;
        Ok(None)
    }

    /// The size an xwidget asks for, as xwidget-size-request: [width, height].
    #[ts = "(xwidget: Xwidget): [number, number]"]
    pub fn xwidgetSizeRequest(ed, xw: EditorValue) -> Vec<f64> {
        let (w, h) = ed.xwidget_size_request(&xw)?;
        Ok(vec![f64::from(w), f64::from(h)])
    }

    /// An xwidget's type, title, width and height, as xwidget-info.
    #[ts = "(xwidget: Xwidget): [symbol, Value, number, number]"]
    pub fn xwidgetInfo(ed, xw: EditorValue) -> EditorValue {
        ed.xwidget_info(&xw)
    }

    /// Where a view is in its window, as xwidget-view-info: [x, y, clipRight, clipBottom, clipTop, clipLeft], right and bottom as how far its visible part reaches, top and left as how much is cut off.
    #[ts = "(view: XwidgetView): number[]"]
    pub fn xwidgetViewInfo(ed, view: EditorValue) -> EditorValue {
        ed.xwidget_view_info(&view)
    }

    /// A view's xwidget, as xwidget-view-model.
    #[ts = "(view: XwidgetView): Xwidget"]
    pub fn xwidgetViewModel(ed, view: EditorValue) -> EditorValue {
        ed.xwidget_view_model(&view)
    }

    /// A view's window, as xwidget-view-window.
    #[ts = "(view: XwidgetView): Window"]
    pub fn xwidgetViewWindow(ed, view: EditorValue) -> EditorValue {
        ed.xwidget_view_window(&view)
    }

    /// Take a view off the screen, as delete-xwidget-view.
    #[ts = "(view: XwidgetView): undefined"]
    pub fn deleteXwidgetView(ed, view: EditorValue) -> Option<bool> {
        ed.delete_xwidget_view(&view)?;
        Ok(None)
    }

    /// An xwidget's view in a window, the selected one by default, as xwidget-view-lookup.
    #[ts = "(xwidget: Xwidget, window?: Window | null): XwidgetView | undefined"]
    pub fn xwidgetViewLookup(ed, xw: EditorValue, window: Opt<EditorValue>) -> Option<EditorValue> {
        let window = match window.0 {
            None | Some(EditorValue::Null) => None,
            Some(EditorValue::Window(id)) => Some(id),
            Some(other) => return Err(e8_core::xfaces::wrong_type("window-live-p", &other)),
        };
        ed.xwidget_view_lookup(&xw, window)
    }

    /// An xwidget's property list, as xwidget-plist.
    #[ts = "(xwidget: Xwidget): Value[]"]
    pub fn xwidgetPlist(ed, xw: EditorValue) -> EditorValue {
        ed.xwidget_plist(&xw)
    }

    /// Set an xwidget's property list, as set-xwidget-plist.
    #[ts = "(xwidget: Xwidget, plist: Value[] | null): Value[]"]
    pub fn setXwidgetPlist(ed, xw: EditorValue, plist: EditorValue) -> EditorValue {
        ed.set_xwidget_plist(&xw, plist)
    }

    /// An xwidget's buffer, as xwidget-buffer.
    #[ts = "(xwidget: Xwidget): Buffer"]
    pub fn xwidgetBuffer(ed, xw: EditorValue) -> EditorValue {
        ed.xwidget_buffer(&xw)
    }

    /// Move an xwidget to another buffer, as set-xwidget-buffer.
    #[ts = "(xwidget: Xwidget, buffer: Buffer | string): undefined"]
    pub fn setXwidgetBuffer(ed, xw: EditorValue, buffer: EditorValue) -> Option<bool> {
        let id = buffer_id(ed, &buffer)?;
        ed.set_xwidget_buffer(&xw, id)?;
        Ok(None)
    }

    /// Whether exiting asks about an xwidget, as xwidget-query-on-exit-flag.
    #[ts = "(xwidget: Xwidget): boolean"]
    pub fn xwidgetQueryOnExitFlag(ed, xw: EditorValue) -> bool {
        ed.xwidget_query_on_exit_flag(&xw)
    }

    /// Set whether exiting asks about an xwidget, as set-xwidget-query-on-exit-flag; gives the flag.
    #[ts = "(xwidget: Xwidget, flag: Value): Value"]
    pub fn setXwidgetQueryOnExitFlag(ed, xw: EditorValue, flag: EditorValue) -> EditorValue {
        ed.set_xwidget_query_on_exit_flag(&xw, flag.is_true())?;
        Ok(flag)
    }

    /// Search a page for text, as xwidget-webkit-search.
    #[ts = "(query: string, xwidget: Xwidget, caseInsensitive?: boolean, backwards?: boolean, wrapAround?: boolean): undefined"]
    pub fn xwidgetWebkitSearch(ed, query: EditorValue, xw: EditorValue, case_insensitive: Opt<EditorValue>, backwards: Opt<EditorValue>, wrap: Opt<EditorValue>) -> Option<bool> {
        let query = text(&query)?;
        let flag = |v: Opt<EditorValue>| v.0.is_some_and(|v| v.is_true());
        ed.xwidget_webkit_search(&query, &xw, flag(case_insensitive), flag(backwards), flag(wrap))?;
        Ok(None)
    }

    /// Go to the next match of a search, as xwidget-webkit-next-result.
    #[ts = "(xwidget: Xwidget): undefined"]
    pub fn xwidgetWebkitNextResult(ed, xw: EditorValue) -> Option<bool> {
        ed.xwidget_webkit_search_step(&xw, "next")?;
        Ok(None)
    }

    /// Go to the previous match of a search, as xwidget-webkit-previous-result.
    #[ts = "(xwidget: Xwidget): undefined"]
    pub fn xwidgetWebkitPreviousResult(ed, xw: EditorValue) -> Option<bool> {
        ed.xwidget_webkit_search_step(&xw, "previous")?;
        Ok(None)
    }

    /// End a search, as xwidget-webkit-finish-search.
    #[ts = "(xwidget: Xwidget): undefined"]
    pub fn xwidgetWebkitFinishSearch(ed, xw: EditorValue) -> Option<bool> {
        ed.xwidget_webkit_search_step(&xw, "finish")?;
        Ok(None)
    }

    /// Stop loading a page, as xwidget-webkit-stop-loading.
    #[ts = "(xwidget: Xwidget): undefined"]
    pub fn xwidgetWebkitStopLoading(ed, xw: EditorValue) -> Option<bool> {
        ed.xwidget_webkit_stop_loading(&xw)?;
        Ok(None)
    }

    /// Keep a web view's cookies in a file, as xwidget-webkit-set-cookie-storage-file.
    #[ts = "(xwidget: Xwidget, file: string): undefined"]
    pub fn xwidgetWebkitSetCookieStorageFile(ed, xw: EditorValue, file: EditorValue) -> Option<bool> {
        let file = text(&file)?;
        ed.xwidget_webkit_set_cookie_storage_file(&xw, &file)?;
        Ok(None)
    }

    /// A web view's history around the page shown, as xwidget-webkit-back-forward-list: the current item, those back and those forward, each [index, title, uri].
    #[ts = "(xwidget: Xwidget, limit?: number | null): Value[]"]
    pub fn xwidgetWebkitBackForwardList(ed, xw: EditorValue, limit: Opt<f64>) -> EditorValue {
        ed.xwidget_webkit_back_forward_list(&xw, limit.0.map(|n| n.max(0.0) as usize))
    }

    /// Kill an xwidget, as kill-xwidget.
    #[ts = "(xwidget: Xwidget): undefined"]
    pub fn killXwidget(ed, xw: EditorValue) -> Option<bool> {
        ed.kill_xwidget(&xw)?;
        Ok(None)
    }

    /// Send an input event to an xwidget, as xwidget-perform-lispy-event: E8's web views take input natively, so this only checks the xwidget.
    #[ts = "(xwidget: Xwidget, event: Value, frame?: Frame | null): undefined"]
    pub fn xwidgetPerformLispyEvent(ed, xw: EditorValue, _event: EditorValue, _frame: Opt<EditorValue>) -> Option<bool> {
        if !ed.xwidget_live_p(&xw) {
            return Err(e8_core::xfaces::wrong_type("xwidget-live-p", &xw));
        }
        Ok(None)
    }
}
