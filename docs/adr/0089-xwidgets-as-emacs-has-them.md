# 0089. xwidgets as Emacs has them: web views on macOS and Linux

Status: accepted · 2026-11-14

## Context

After [ADR 0088](0088-the-last-odds-frames-file-notifications-and-descriptions.md), xwidgets are all the corpus still needs ([docs/parity/demand.md](../parity/demand.md)):

- **Who needs them.** lsp-ui's documentation frames and evil-collection among MELPA's packages, eww's and image's web views among Emacs's own.
- **What they are.** An xwidget is a WebKit web view shown in a buffer, as the display property `(xwidget :xwidget XW)` puts it. Lisp loads pages, runs JavaScript and hears back through `xwidget-event`s.
- **Emacs's API.** xwidget.c has 34 primitives. xwidget.el's `xwidget-webkit-browse-url` and `xwidget-webkit-mode` are a small browser built on them.
- **[ADR 0087](0087-sqlite-as-emacs-has-it.md)** left xwidgets out because they need a web view in the GUI's window.

Emacs builds them two ways:

- **On GTK**, an offscreen WebKitGTK view, painted into the frame and fed its input.
- **On macOS**, a WKWebView, a native view placed over the frame wherever the xwidget shows.

E8 must work on both macOS and Linux. Its GUI is egui on winit, not GTK, and its core has no UI.

## Options considered

1. **Offscreen rendering into a texture,** as Emacs's GTK build does. E8 would draw the page like an image and clip it as text is clipped. But no portable library renders WKWebView or WebKitGTK offscreen with its input forwarded. CEF could, and would add a Chromium of its own to E8, hundreds of megabytes.
2. **Native child views over the window,** as Emacs's macOS build does, with `wry`, the web-view library Tauri is built on. On macOS it embeds a WKWebView as a child view of the window, on Linux a WebKitGTK view, and on Windows WebView2 if E8 ever runs there. The view draws itself above egui's drawing, at the rectangle E8 gives it.

## Decision

Option 2.

### The core

The core (`xwidget.rs`) holds the model, with no web engine in it:

- **Xwidgets** are values, `Value::Xwidget` (`XwObject::Widget` and `XwObject::View`), the prelude's `Xwidget` and `XwidgetView`. Each keeps:
  - Emacs's fields: type, title, size, buffer, plist and query-on-exit flag;
  - what the front end last reported: URI, title, load progress and history.
- **Requests and events.** The primitives queue requests (`XwidgetRequest`: create, load a URI or HTML, run a script, resize, zoom, search, go through history, stop, kill) for a front end to carry out.
  - The front end reports back with `Editor::xwidget_event` (`XwidgetEvent`: load changed, title or URI changed, progress, a script's result, a download, a link to follow).
  - Each becomes the event Emacs makes, `(xwidget-event TYPE XW ARG...)`, given to `xwidget-event-handler` as `last-input-event`, as Emacs's `special-event-map` binds it.
  - A script's result is converted as `webkit_js_to_lisp` converts it: strings, numbers, booleans, arrays as vectors, objects as alists of `[key, value]` pairs, null as nil. It comes to the callback through a `javascript-callback` event.
- **Display.** `(xwidget :xwidget XW)` in a `display` property shows as a glyph of the xwidget's size, laid out as an image glyph is (`ImageGlyph::xwidget`).
  - The frame description places each one: window, xwidget and rectangle (`FrameDescription::xwidgets`).
  - Views exist per window showing an xwidget, made and deleted at redisplay, as xwidget.c's are, for `xwidget-view-lookup`, `xwidget-view-window` and `delete-xwidget-view`.
- **Displays without web views.** A terminal, the web build and headless editors show the text under the property, as Emacs shows an image's text where it cannot show images. There, `make-xwidget` signals as Emacs's does without a window system. A front end says it has web views through `TextMetrics::xwidgets`.
- **The agent.** Loading a page (`xwidget-webkit-goto-uri`) asks the agent's permission while an agent acts ([ADR 0062](0062-agents-through-e8-mcp-ask-first.md)), as opening a connection does.

### The GUI

The GUI (`e8-gui/src/xwidgets.rs`, the `xwidgets` feature, on by default) carries out the requests with `wry` on the window's thread, between frames:

- **macOS.** A WKWebView child view of the window's content view, through `wry`'s `build_as_child`.
- **Linux, X11** (XWayland included). A WebKitGTK view in a child X11 window of E8's window, through `build_as_child`. GTK is started once when the first view is made, and its main loop is run for a moment each frame, as `wry` needs it on Linux.
- **Linux, Wayland.** A Wayland surface cannot hold another program's surface, so a view opens in a GTK window of its own beside E8's (`build_gtk`). The buffer shows a box of the xwidget's size with its title, where the view would be.
- **Placement.** Each frame, every view is moved and sized to the rectangle the frame description gives it, clipped to its window, and hidden when no window shows it. Views are native, so they draw above anything egui draws, E8's own menus and tooltips over them included, as Emacs's macOS views do.
- **Input.** A view takes keys and clicks natively once clicked. Clicking E8's text gives them back to E8.
- **Events.** `wry`'s handlers report pages starting and finishing loading, titles, navigation, new-window requests and downloads, and script results through `evaluate_script_with_callback`. Each goes to the editor's thread as `Input::Run` with `xwidget_event`.

### xwidget.el

`xwidget.ts` ports xwidget.el: `xwidget-insert`, `xwidget-at`, `xwidget-webkit-browse-url`, `xwidget-webkit-mode` with its keys, the callback that names the buffer after the page, back, forward, reload, zoom, scrolling by JavaScript, and searching.

## Consequences

- **What it unblocks.** lsp-ui's and eww's web views, and `xwidget-webkit-browse-url`, work in the GUI on macOS and Linux, and every primitive the corpus calls is in E8.
- **Build dependencies on Linux.** The GUI needs WebKitGTK and GTK 3 to build there (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`). CI installs them, and the `xwidgets` feature can be turned off to build without them.
- **Recorded in [differences.md](../differences.md):**
  - views over E8's menus;
  - separate windows on Wayland;
  - native focus;
  - a clipped view showing its page from the top of the visible part;
  - script results' alists as pairs.
- **Not done:**
  - `xwidget-perform-lispy-event`, beyond the keys `wry` can send as JavaScript;
  - cookie storage files where WKWebView keeps its own;
  - the GTK build's offscreen views.

## Dependencies introduced

- **`wry`** (pinned at 0.57.1) in e8-gui, behind the `xwidgets` feature, for native web views: WKWebView on macOS and WebKitGTK on Linux, which it links there.
- **`gtk`**, which `wry` uses on Linux to start GTK and run its loop.
