//! xwidgets, as Emacs's xwidget.c and xwidget.el give them (ADR 0089),
//! with a front end that says it has web views and plays the GUI's part:
//! taking the requests and reporting events back.

use std::sync::Arc;

use e8_core::layout::{FontSpec, TextMetrics};
use e8_core::xwidget::{XwObject, XwidgetEvent, XwidgetRequest};
use e8_core::{Editor, Value};
use e8_script::Scripting;

/// Cells, with images and web views, as the GUI's frames have them.
struct WithWebViews;

impl TextMetrics for WithWebViews {
    fn advance(&self, _font: &FontSpec, _c: char) -> f32 {
        1.0
    }
    fn line_height(&self, _font: &FontSpec) -> f32 {
        1.0
    }
    fn char_width(&self) -> f32 {
        1.0
    }
    fn char_height(&self) -> f32 {
        1.0
    }
    fn images(&self) -> bool {
        true
    }
    fn xwidgets(&self) -> bool {
        true
    }
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_text_metrics(Arc::new(WithWebViews));
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, or `ERR message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "test.ts", format!("globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.message}}`; }} }})();"))
        .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

fn widget(n: u64) -> Value {
    Value::Xwidget(XwObject::Widget(n))
}

#[test]
fn a_terminal_has_no_web_views() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(run(&mut ed, &s, r#"return e8.makeXwidget(Symbol.for("webkit"), "t", 100, 100);"#), "ERR make-xwidget: this display shows no web views");
    assert_eq!(run(&mut ed, &s, "return [e8.xwidgetp(3), e8.xwidgetLiveP(null)];"), "[false,false]");
}

#[test]
fn xwidgets_are_made_and_asked_about_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"globalThis.xw = e8.makeXwidget(Symbol.for("webkit"), "title", 300, 200); return null;"#);
    assert_eq!(r("return [e8.xwidgetp(xw), e8.xwidgetLiveP(xw), String(xw)];"), r##"[true,true,"#<xwidget 1>"]"##);
    assert_eq!(r("const [t, title, w, h] = e8.xwidgetInfo(xw); return [(t as symbol).description, title, w, h];"), r#"["webkit","title",300,200]"#);
    assert_eq!(r("return [e8.xwidgetSizeRequest(xw), e8.xwidgetWebkitUri(xw), e8.xwidgetQueryOnExitFlag(xw)];"), r#"[[300,200],"about:blank",true]"#);
    assert_eq!(r("return [e8.setXwidgetQueryOnExitFlag(xw, null), e8.xwidgetQueryOnExitFlag(xw)];"), "[null,false]");
    assert_eq!(r(r#"return [e8.setXwidgetPlist(xw, ["a", 1]), e8.xwidgetPlist(xw)];"#), r#"[["a",1],["a",1]]"#);
    assert_eq!(r("return e8.setXwidgetPlist(xw, 3 as any);"), "ERR Wrong type argument: listp, 3");
    assert_eq!(r("return [e8.xwidgetBuffer(xw).name, e8.getBufferXwidgets(e8.bufferName()).length];"), r#"["*scratch*",1]"#);
    assert_eq!(r(r#"return e8.makeXwidget(Symbol.for("gtk"), "t", 1, 1);"#), "ERR Bad xwidget type");
    assert_eq!(r(r#"return e8.makeXwidget(Symbol.for("webkit"), "t", -1, 1);"#), "ERR Wrong type argument: wholenump, -1");
    // Making one asks the front end for a web view showing about:blank.
    assert_eq!(
        ed.take_xwidget_requests(),
        vec![XwidgetRequest::Create { id: 1, width: 300, height: 200, related: None }, XwidgetRequest::GotoUri { id: 1, uri: "about:blank".into() }]
    );
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.xwidgetResize(xw, 400, 250); e8.xwidgetWebkitZoom(xw, 0.1); e8.xwidgetWebkitZoom(xw, 0.1); e8.xwidgetWebkitGotoUri(xw, "https://example.com/"); e8.xwidgetWebkitStopLoading(xw); return null;"#);
    let got = ed.take_xwidget_requests();
    assert_eq!(got[0], XwidgetRequest::Resize { id: 1, width: 400, height: 250 });
    // Zooming adds to the zoom level, as WebKit's and WKWebView's do in Emacs.
    assert!(matches!(got[2], XwidgetRequest::Zoom { id: 1, level } if (level - 1.2).abs() < 1e-9));
    assert_eq!(got[3], XwidgetRequest::GotoUri { id: 1, uri: "https://example.com/".into() });
    assert_eq!(got[4], XwidgetRequest::Stop { id: 1 });
    // Searching must have begun before stepping through it.
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return e8.xwidgetWebkitNextResult(xw);"), "ERR Widget has no ongoing search operation");
    assert_eq!(r(r#"e8.xwidgetWebkitSearch("foo", xw, true); e8.xwidgetWebkitNextResult(xw); e8.xwidgetWebkitFinishSearch(xw); return e8.xwidgetWebkitPreviousResult(xw);"#), "ERR Widget has no ongoing search operation");
    // A killed xwidget is no longer live.
    assert_eq!(r("e8.killXwidget(xw); return [e8.xwidgetp(xw), e8.xwidgetLiveP(xw)];"), "[true,false]");
    assert_eq!(r("return e8.xwidgetInfo(xw);"), "ERR Wrong type argument: xwidget-live-p, #<xwidget 1>");
}

#[test]
fn pages_report_back_through_xwidget_events() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"globalThis.xw = e8.makeXwidget(Symbol.for("webkit"), "t", 100, 100); globalThis.seen = []; e8.funcall("xwidget-put", xw, Symbol.for("callback"), (x: any, type: any) => seen.push([type.description, (e8.variable("last-input-event") as any[])[3]])); return null;"#);
    ed.take_xwidget_requests();
    for (status, uri) in [("load-started", "https://a.test/"), ("load-committed", "https://a.test/"), ("load-finished", "https://a.test/")] {
        ed.xwidget_event(XwidgetEvent::LoadChanged { id: 1, status: status.into(), uri: uri.into(), title: "A".into() });
    }
    for (status, uri) in [("load-committed", "https://b.test/"), ("load-finished", "https://b.test/")] {
        ed.xwidget_event(XwidgetEvent::LoadChanged { id: 1, status: status.into(), uri: uri.into(), title: "B".into() });
    }
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return seen;"), r#"[["load-changed","load-started"],["load-changed","load-committed"],["load-changed","load-finished"],["load-changed","load-committed"],["load-changed","load-finished"]]"#);
    assert_eq!(r("return [e8.xwidgetWebkitUri(xw), e8.xwidgetWebkitTitle(xw), e8.xwidgetWebkitEstimatedLoadProgress(xw)];"), r#"["https://b.test/","B",1]"#);
    // The history around the page shown: (0 "B" uri), back to A, nothing forward.
    assert_eq!(r("return e8.xwidgetWebkitBackForwardList(xw);"), r#"[[0,"B","https://b.test/"],[[-1,"A","https://a.test/"]],[]]"#);
    assert_eq!(r("return e8.xwidgetWebkitGotoHistory(xw, 1);"), "ERR There is no item at this index");
    assert_eq!(r("e8.xwidgetWebkitGotoHistory(xw, -1); return null;"), "null");
    // A script's result comes to its function through a javascript-callback event.
    r(r#"globalThis.got = null; e8.funcall("xwidget-put", xw, Symbol.for("callback"), Symbol.for("xwidget-webkit-callback")); e8.xwidgetWebkitExecuteScript(xw, "1 + 1", (v: any) => { got = v; }); return null;"#);
    let requests = ed.take_xwidget_requests();
    let callback = requests.iter().find_map(|q| match q {
        XwidgetRequest::ExecuteScript { script, callback: Some(c), .. } if script == "1 + 1" => Some(*c),
        _ => None,
    });
    let callback = callback.expect("a script with a callback");
    ed.xwidget_event(XwidgetEvent::ScriptResult { callback, value: Value::List(vec![Value::Number(2.0), Value::List(vec![Value::Str("k".into()), Value::Bool(true)])]) });
    assert_eq!(run(&mut ed, &s, "return got;"), r#"[2,["k",true]]"#);
    // A script with no function asks for no result.
    run(&mut ed, &s, r#"e8.xwidgetWebkitExecuteScript(xw, "x()"); return null;"#);
    assert_eq!(ed.take_xwidget_requests(), vec![XwidgetRequest::ExecuteScript { id: 1, script: "x()".into(), callback: None }]);
    let _ = widget(1);
}

#[test]
fn an_xwidget_shows_where_its_display_property_is() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"e8.insert("ab\n"); globalThis.xw = e8.funcall("xwidget-insert", 0, Symbol.for("webkit"), "t", 30, 4); return null;"#);
    ed.redisplay();
    let rows = ed.window_rows(10, true);
    let glyph = rows[0].segments.iter().find_map(|seg| seg.image.as_ref()).expect("a glyph for the xwidget");
    assert_eq!((glyph.xwidget, glyph.width, glyph.height), (Some(1), 30.0, 4.0));
    // The frame description names it, for a front end that draws a box in its place.
    let frame = ed.selected_frame();
    let description = ed.describe_frame(frame, 1.0);
    assert_eq!(description.xwidget_labels.get(&1).map(String::as_str), Some("t"));
    // As Emacs's xwidget-at.
    assert_eq!(run(&mut ed, &s, "return [e8.funcall('xwidget-at', 0) === xw, e8.funcall('xwidget-at', 1) ?? null];"), "[true,null]");
}

#[test]
fn views_come_from_where_the_front_end_places_them() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"globalThis.xw = e8.makeXwidget(Symbol.for("webkit"), "t", 100, 50); return null;"#);
    let window = ed.selected_window();
    assert_eq!(run(&mut ed, &s, "return e8.xwidgetViewLookup(xw) ?? null;"), "null");
    ed.xwidget_event(XwidgetEvent::Placed { xwidget: 1, window, rect: [10.0, 20.0, 100.0, 50.0], clip: [0.0, 5.0, 0.0, 0.0] });
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("const v = e8.xwidgetViewLookup(xw)!; return [e8.xwidgetViewP(v), e8.xwidgetViewInfo(v), e8.xwidgetViewModel(v) === xw, e8.xwidgetViewWindow(v) === e8.selectedWindow()];"), "[true,[10,20,100,50,0,5,0,0],true,true]");
    ed.take_xwidget_requests();
    assert_eq!(run(&mut ed, &s, "e8.deleteXwidgetView(e8.xwidgetViewLookup(xw)!); return e8.xwidgetViewLookup(xw) ?? null;"), "null");
    assert_eq!(ed.take_xwidget_requests(), vec![XwidgetRequest::DeleteView { id: 1, window }]);
    ed.xwidget_event(XwidgetEvent::Placed { xwidget: 1, window, rect: [0.0, 0.0, 100.0, 50.0], clip: [0.0; 4] });
    ed.xwidget_event(XwidgetEvent::Unplaced { xwidget: 1, window });
    assert_eq!(run(&mut ed, &s, "return e8.xwidgetViewLookup(xw) ?? null;"), "null");
}

#[test]
fn killing_a_buffer_kills_its_xwidgets() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"globalThis.b = e8.getBufferCreate("web"); globalThis.xw = e8.makeXwidget(Symbol.for("webkit"), "t", 10, 10, null, "web"); return null;"#);
    ed.take_xwidget_requests();
    assert_eq!(run(&mut ed, &s, r#"e8.call("kill-buffer", "web"); return e8.xwidgetLiveP(xw);"#), "false");
    assert_eq!(ed.take_xwidget_requests(), vec![XwidgetRequest::Kill { id: 1 }]);
}

#[test]
fn xwidget_webkit_browse_url_makes_a_session_named_after_its_page() {
    let (mut ed, s) = setup();
    ed.call("xwidget-webkit-browse-url", vec![e8_core::Arg::Str("example.com".into()), e8_core::Arg::Prefix(None)]).unwrap();
    let requests = ed.take_xwidget_requests();
    assert!(requests.contains(&XwidgetRequest::GotoUri { id: 1, uri: "https://example.com".into() }), "{requests:?}");
    assert_eq!(run(&mut ed, &s, "return [e8.variable('major-mode'), e8.funcall('xwidget-webkit-current-session') !== undefined];"), r#"["xwidget-webkit-mode",true]"#);
    ed.xwidget_event(XwidgetEvent::LoadChanged { id: 1, status: "load-finished".into(), uri: "https://example.com/".into(), title: "Example Domain".into() });
    assert_eq!(ed.buffer().name, "*xwidget-webkit: Example Domain*");
    // Its keys run the page's commands.
    ed.take_xwidget_requests();
    // Back with no page before signals, as Emacs's does.
    ed.press("b").unwrap();
    assert_eq!(ed.echo(), Some("There is no item at this index"));
    ed.press("+").unwrap();
    assert!(matches!(ed.take_xwidget_requests().as_slice(), [XwidgetRequest::Zoom { id: 1, .. }]));
}
