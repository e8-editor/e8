// xwidgets in buffers, after Emacs's xwidget.el (ADR 0089): putting one
// in a buffer, the event handler that calls each xwidget's callback, and
// xwidget-webkit-mode, a small web browser: browsing a URL, back, forward
// and reload, zooming, scrolling by JavaScript, copying the selection, and
// the buffer named after the page. The web views are the GUI's; elsewhere
// make-xwidget signals.

import { truthy } from "subr";

/** Puts an xwidget at a position, as xwidget-insert: made, and shown by a display property on the character there. */
export function xwidgetInsert(pos: number, type: string | symbol, title: string, width: number, height: number, args?: e8.Value, related?: e8.Xwidget | null): e8.Xwidget {
  e8.gotoChar(pos);
  const xw = e8.makeXwidget(type, title, width, height, args ?? null, null, related ?? null);
  e8.putTextProperty(e8.point(), e8.point() + 1, "display", [Symbol.for("xwidget"), Symbol.for(":xwidget"), xw]);
  return xw;
}
e8.defun("xwidget-insert", xwidgetInsert);

/** The live xwidget a position's display property shows, as xwidget-at. */
export function xwidgetAt(pos: number): e8.Xwidget | undefined {
  const display = e8.getTextProperty(pos, "display");
  const xw = Array.isArray(display) ? display[2] : undefined;
  return e8.xwidgetLiveP(xw) ? (xw as unknown as e8.Xwidget) : undefined;
}
e8.defun("xwidget-at", xwidgetAt);

/** A property of an xwidget, as xwidget-get. */
export function xwidgetGet(xw: e8.Xwidget, name: string): e8.Value | undefined {
  const plist = (e8.xwidgetPlist(xw) ?? []) as e8.Value[];
  for (let i = 0; i + 1 < plist.length; i += 2) if (keyName(plist[i]) === name) return plist[i + 1];
  return undefined;
}
e8.defun("xwidget-get", (xw: e8.Xwidget, name: e8.Value) => xwidgetGet(xw, keyName(name)));

/** Sets a property of an xwidget, as xwidget-put. */
export function xwidgetPut(xw: e8.Xwidget, name: string, value: e8.Value): void {
  const plist = [...((e8.xwidgetPlist(xw) ?? []) as e8.Value[])];
  for (let i = 0; i + 1 < plist.length; i += 2) {
    if (keyName(plist[i]) === name) {
      plist[i + 1] = value;
      e8.setXwidgetPlist(xw, plist);
      return;
    }
  }
  e8.setXwidgetPlist(xw, [...plist, Symbol.for(name), value]);
}
e8.defun("xwidget-put", (xw: e8.Xwidget, name: e8.Value, value: e8.Value) => xwidgetPut(xw, keyName(name), value));

function keyName(key: e8.Value): string {
  return typeof key === "symbol" ? (key.description ?? "") : String(key);
}

const eventName = (v: e8.Value) => (typeof v === "symbol" ? (v.description ?? "") : String(v));

/** Logs to a buffer of its own, as xwidget-log. */
function xwidgetLog(text: string): void {
  e8.withCurrentBuffer(e8.getBufferCreate(" *xwidget-log*"), () => {
    e8.gotoChar(e8.pointMax());
    e8.insert(`${text}\n`);
  });
}

/**
 * Takes an xwidget event, (xwidget-event TYPE XW ARG...), from
 * last-input-event and calls the xwidget's `callback` property with the
 * xwidget and the type, as xwidget-event-handler does.
 */
export function xwidgetEventHandler(): void {
  const event = e8.variable("last-input-event") as e8.Value[];
  xwidgetLog(`stuff happened to xwidget ${e8.prin1ToString(event)}`);
  const type = event[1];
  const xw = event[2] as unknown as e8.Xwidget;
  const callback = xwidgetGet(xw, "callback");
  if (truthy(callback)) e8.funcall(callback as any, xw, type);
}
e8.defun("xwidget-event-handler", xwidgetEventHandler);

export const options = {
  bufferNameFormat: "*xwidget-webkit: %T*",
};
e8.defineVariable({
  name: "xwidget-webkit-buffer-name-format",
  value: options.bufferNameFormat,
  doc: "How xwidget-webkit buffers are named: %T is the page's title, %U its URI.",
});
e8.defineVariable({ name: "xwidget-webkit-cookie-file", value: null, doc: "The file xwidget-webkit-browse-url keeps cookies in, or nil to keep none." });

let lastSessionBuffer: e8.Buffer | undefined;

/** The xwidget the last xwidget-webkit buffer shows, as xwidget-webkit-last-session. */
export function xwidgetWebkitLastSession(): e8.Xwidget | undefined {
  if (lastSessionBuffer === undefined || !e8.bufferLiveP(lastSessionBuffer)) return undefined;
  return e8.withCurrentBuffer(lastSessionBuffer, () => xwidgetAt(e8.pointMin()));
}
e8.defun("xwidget-webkit-last-session", xwidgetWebkitLastSession);

/** The current buffer's xwidget, or the last session's, as xwidget-webkit-current-session. */
export function xwidgetWebkitCurrentSession(): e8.Xwidget | undefined {
  return xwidgetAt(e8.pointMin()) ?? xwidgetWebkitLastSession();
}
e8.defun("xwidget-webkit-current-session", xwidgetWebkitCurrentSession);

function session(): e8.Xwidget {
  const xw = xwidgetWebkitCurrentSession();
  if (xw === undefined) e8.userError("No xwidget-webkit session");
  return xw;
}

const insideWidth = (window?: e8.Window) => e8.windowBodyPixelWidth(window);
const insideHeight = (window?: e8.Window) => e8.windowBodyPixelHeight(window);

/** Names a buffer as xwidget-webkit-buffer-name-format says, %T the title and %U the URI. */
function bufferName(title: string, uri: string): string {
  const format = String(e8.variable("xwidget-webkit-buffer-name-format") ?? options.bufferNameFormat);
  return format.replace(/%([TU%])/g, (_, c: string) => (c === "T" ? title : c === "U" ? uri : "%"));
}

/**
 * What xwidget-webkit-mode's xwidgets do with their events, as
 * xwidget-webkit-callback: on a load the buffer is named after the page,
 * a script's result goes to its function, and a download is saved.
 */
export function xwidgetWebkitCallback(xw: e8.Xwidget, type: e8.Value): void {
  const buffer = e8.xwidgetBuffer(xw);
  if (!e8.bufferLiveP(buffer)) {
    xwidgetLog("error: callback called for xwidget with dead buffer");
    return;
  }
  const event = e8.variable("last-input-event") as e8.Value[];
  switch (eventName(type)) {
    case "load-changed": {
      const title = e8.xwidgetWebkitTitle(xw);
      const uri = e8.xwidgetWebkitUri(xw);
      const finished = event[3] === "load-finished";
      e8.withCurrentBuffer(buffer, () => {
        e8.makeLocalVariable("xwidget-webkit--loading-p");
        e8.setVariable("xwidget-webkit--loading-p", !finished);
        if (finished || title.length > 0) {
          xwidgetLog(`webkit finished loading: ${title}`);
          e8.call("rename-buffer", bufferName(title, uri), true);
        }
      });
      break;
    }
    case "decide-policy": {
      const target = String(event[3] ?? "");
      const anchor = target.match(/#(.*)$/);
      if (anchor) showIdOrNamedElement(xw, anchor[1]);
      break;
    }
    case "download-callback":
      saveAsFile(String(event[3]), String(event[4]), String(event[5]));
      break;
    case "javascript-callback":
      e8.funcall(event[3] as any, event[4]);
      break;
    default:
      xwidgetLog(`unhandled event:${eventName(type)}`);
  }
}
e8.defun("xwidget-webkit-callback", xwidgetWebkitCallback);

/** Scrolls a page to the element with an id or name, as xwidget-webkit-show-id-or-named-element. */
function showIdOrNamedElement(xw: e8.Xwidget, name: string): void {
  const id = JSON.stringify(name);
  e8.xwidgetWebkitExecuteScript(
    xw,
    `(function(){var e=document.getElementById(${id})||document.getElementsByName(${id})[0];if(e){e.scrollIntoView();}})();`,
  );
}

e8.defineVariable({ name: "xwidget-webkit-download-dir", value: "~/Downloads/", doc: "Where xwidget-webkit saves what it downloads." });

/** Asks where to save a download, as xwidget-webkit-save-as-file. */
function saveAsFile(url: string, _mimeType: string, fileName: string): void {
  const dir = String(e8.variable("xwidget-webkit-download-dir") ?? "~/Downloads/");
  const target = e8.readFileName(`Download ${url} to: `, { dir, initial: fileName });
  e8.message(`Downloading ${url} to ${target} is left to the web view`);
}

/** Makes a buffer for a new session showing URL, as xwidget-webkit--create-new-session-buffer. */
function createNewSessionBuffer(url: string, callback?: e8.Value): e8.Buffer {
  const name = e8.generateNewBufferName(e8.bufferName());
  const current = xwidgetWebkitCurrentSession();
  const [width, height] = [insideWidth(), insideHeight()];
  const buffer = e8.getBufferCreate(name);
  lastSessionBuffer = buffer;
  e8.withCurrentBuffer(buffer, () => {
    const start = e8.point();
    e8.insert(url);
    e8.putTextProperty(start, start + url.length, "invisible", true);
    const xw = xwidgetInsert(start, Symbol.for("webkit"), name, width, height, null, current ?? null);
    const cookies = e8.variable("xwidget-webkit-cookie-file");
    if (typeof cookies === "string") e8.xwidgetWebkitSetCookieStorageFile(xw, cookies);
    xwidgetPut(xw, "callback", callback ?? Symbol.for("xwidget-webkit-callback"));
    e8.call("xwidget-webkit-mode");
  });
  return buffer;
}

/** Shows URL in a new web view, as xwidget-webkit-new-session. */
export function xwidgetWebkitNewSession(url: string): void {
  e8.call("switch-to-buffer", createNewSessionBuffer(url).name ?? "");
  e8.xwidgetWebkitGotoUri(xwidgetWebkitLastSession()!, url);
}
e8.defun("xwidget-webkit-new-session", xwidgetWebkitNewSession);

/** Shows URL in the current session, or a new one, as xwidget-webkit-goto-url. */
export function xwidgetWebkitGotoUrl(url: string): void {
  const xw = xwidgetWebkitCurrentSession();
  if (xw === undefined) {
    xwidgetWebkitNewSession(url);
    return;
  }
  e8.xwidgetWebkitGotoUri(xw, url);
  e8.call("switch-to-buffer", e8.xwidgetBuffer(xw).name ?? "");
}
e8.defun("xwidget-webkit-goto-url", xwidgetWebkitGotoUrl);

e8.defineCommand({
  name: "xwidget-webkit-browse-url",
  doc: "Browse URL in a web view, a new session with NEW-SESSION; a URL with no scheme is taken as https.",
  params: [
    { name: "url", kind: "string", prompt: "xwidget-webkit URL: " },
    { name: "new-session", kind: "prefix" },
  ],
  run: (url: string, newSession: e8.Value) => {
    let target = String(url);
    if (!/^[A-Za-z]+:/.test(target)) target = `https://${target}`;
    if (truthy(newSession)) xwidgetWebkitNewSession(target);
    else xwidgetWebkitGotoUrl(target);
  },
});

const script = (js: string, fun?: (result: e8.Value) => void) => e8.xwidgetWebkitExecuteScript(session(), js, fun ?? null);
const prefixPixels = (n: e8.Value, fallback: number) => (n === null || n === undefined ? fallback : e8.prefixNumericValue(n as e8.PrefixArg));
const lineHeight = () => e8.frameCharHeight();
const charWidth = () => e8.frameCharWidth();

const commands: [string, string, (n: e8.Value) => void, "prefix" | "count" | undefined][] = [
  ["xwidget-webkit-back", "Go back in the web view's history.", () => e8.xwidgetWebkitGotoHistory(session(), -1), undefined],
  ["xwidget-webkit-forward", "Go forward in the web view's history.", () => e8.xwidgetWebkitGotoHistory(session(), 1), undefined],
  ["xwidget-webkit-reload", "Load the page again.", () => e8.xwidgetWebkitGotoHistory(session(), 0), undefined],
  ["xwidget-webkit-zoom-in", "Zoom the page in.", () => e8.xwidgetWebkitZoom(session(), 0.1), undefined],
  ["xwidget-webkit-zoom-out", "Zoom the page out.", () => e8.xwidgetWebkitZoom(session(), -0.1), undefined],
  ["xwidget-webkit-stop", "Stop loading the page.", () => e8.xwidgetWebkitStopLoading(session()), undefined],
  [
    "xwidget-webkit-current-url",
    "Show the page's URL and put it on the kill ring.",
    () => {
      const url = e8.xwidgetWebkitUri(session());
      if (url) e8.killNew(url);
      e8.message(`URL: ${url}`);
    },
    undefined,
  ],
  ["xwidget-webkit-copy-selection-as-kill", "Put the page's selection on the kill ring.", () => script("window.getSelection().toString();", (s) => e8.killNew(String(s ?? ""))), undefined],
  ["xwidget-webkit-scroll-up", "Scroll the page up by N pixels, the window's height without a prefix argument.", (n) => script(`window.scrollBy(0, ${prefixPixels(n, insideHeight())});`), "prefix"],
  ["xwidget-webkit-scroll-down", "Scroll the page down by N pixels, the window's height without a prefix argument.", (n) => script(`window.scrollBy(0, -${prefixPixels(n, insideHeight())});`), "prefix"],
  ["xwidget-webkit-scroll-up-line", "Scroll the page up by N lines.", (n) => script(`window.scrollBy(0, ${Number(n ?? 1) * lineHeight()});`), "count"],
  ["xwidget-webkit-scroll-down-line", "Scroll the page down by N lines.", (n) => script(`window.scrollBy(0, -${Number(n ?? 1) * lineHeight()});`), "count"],
  ["xwidget-webkit-scroll-forward", "Scroll the page right by N characters.", (n) => script(`window.scrollBy(${Number(n ?? 1) * charWidth()}, 0);`), "count"],
  ["xwidget-webkit-scroll-backward", "Scroll the page left by N characters.", (n) => script(`window.scrollBy(-${Number(n ?? 1) * charWidth()}, 0);`), "count"],
  ["xwidget-webkit-scroll-top", "Scroll to the top of the page.", () => script("window.scrollTo(pageXOffset, 0);"), undefined],
  ["xwidget-webkit-scroll-bottom", "Scroll to the bottom of the page.", () => script("window.scrollTo(pageXOffset, window.document.body.scrollHeight);"), undefined],
  ["xwidget-webkit-adjust-size-to-window", "Make the web view the size of the window.", () => e8.xwidgetResize(session(), insideWidth(), insideHeight()), undefined],
];
for (const [name, doc, run, kind] of commands) {
  e8.defineCommand({ name, doc, params: kind === undefined ? [] : [{ name: "n", kind }], run });
}

e8.defineCommand({
  name: "xwidget-webkit-search",
  doc: "Search the page for text, as xwidget-webkit-search does with the web view's own search.",
  params: [{ name: "query", kind: "string", prompt: "Search: " }],
  run: (query: string) => e8.xwidgetWebkitSearch(String(query), session(), true, false, true),
});

e8.defineMajorMode({
  name: "xwidget-webkit-mode",
  modeName: "xwidget-webkit",
  parent: "special-mode",
  doc: "A web page in a buffer, shown by a WebKit xwidget: g browses a URL, b and f go back and forward, r reloads, + and - zoom, w copies the URL and SPC and DEL scroll.",
  bindings: {
    g: "xwidget-webkit-browse-url",
    a: "xwidget-webkit-adjust-size-to-window",
    b: "xwidget-webkit-back",
    f: "xwidget-webkit-forward",
    r: "xwidget-webkit-reload",
    w: "xwidget-webkit-current-url",
    "+": "xwidget-webkit-zoom-in",
    "-": "xwidget-webkit-zoom-out",
    "C-s": "xwidget-webkit-search",
    SPC: "xwidget-webkit-scroll-up",
    "S-SPC": "xwidget-webkit-scroll-down",
    DEL: "xwidget-webkit-scroll-down",
    "<remap> <scroll-up-command>": "xwidget-webkit-scroll-up",
    "<remap> <scroll-down-command>": "xwidget-webkit-scroll-down",
    "<remap> <forward-char>": "xwidget-webkit-scroll-forward",
    "<remap> <backward-char>": "xwidget-webkit-scroll-backward",
    "<remap> <right-char>": "xwidget-webkit-scroll-forward",
    "<remap> <left-char>": "xwidget-webkit-scroll-backward",
    "<remap> <previous-line>": "xwidget-webkit-scroll-down-line",
    "<remap> <next-line>": "xwidget-webkit-scroll-up-line",
    "<remap> <beginning-of-buffer>": "xwidget-webkit-scroll-top",
    "<remap> <end-of-buffer>": "xwidget-webkit-scroll-bottom",
  },
  setup: () => {
    e8.makeLocalVariable("xwidget-webkit--loading-p");
    e8.setVariable("xwidget-webkit--loading-p", false);
    e8.makeLocalVariable("truncate-lines");
    e8.setVariable("truncate-lines", true);
  },
});
