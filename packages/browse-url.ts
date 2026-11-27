// Opening URLs, after browse-url.el: browse-url gives a URL to the handler
// browse-url-handlers picks for it, or to browse-url-browser-function, by
// default the system's way of opening one, as browse-url-default-browser
// does: open on macOS, xdg-open with a display elsewhere.

import { allMatches, executableFind, truthy } from "subr";

e8.defineVariable({
  name: "browse-url-browser-function",
  doc: "The function browse-url calls with a URL to open it, when no handler in browse-url-handlers matches: browse-url-default-browser, the system's way, by default. An alist of regexps and functions, as Emacs once took, still works.",
  value: "browse-url-default-browser",
});

e8.defineVariable({
  name: "browse-url-handlers",
  doc: "An alist of (REGEXP-OR-PREDICATE . HANDLER): the first whose regexp matches a URL, or whose predicate is true of it, opens it in place of browse-url-browser-function.",
  value: null,
});

e8.defineVariable({ name: "browse-url-default-handlers", doc: "Handlers tried after browse-url-handlers, as that alist.", value: null });

e8.defineVariable({
  name: "browse-url-new-window-flag",
  doc: "Whether browse-url asks for a new window; a prefix argument to it turns this round.",
  value: false,
});

/** A URL with the characters that mislead browsers' parameters, " ( ) and space, %-encoded, as browse-url-encode-url. */
export function browseUrlEncodeUrl(url: string): string {
  return url.replace(/["() ]/g, (c) => `%${c.codePointAt(0)!.toString(16).toUpperCase()}`);
}

/** Opens URL with the program the system opens URLs with, as browse-url-default-browser: open on macOS, xdg-open where there is a display. */
function defaultBrowser(url: string): void {
  if (e8.variable("system-type") === "darwin") {
    const encoded = browseUrlEncodeUrl(url);
    e8.makeProcess({ name: `open ${encoded}`, command: ["open", encoded] });
    return;
  }
  // xdg-open with a graphical display, as browse-url-can-use-xdg-open checks.
  if ((e8.getenv("DISPLAY") || e8.getenv("WAYLAND_DISPLAY")) && executableFind("xdg-open")) {
    e8.makeProcess({ name: `xdg-open ${url}`, command: ["xdg-open", url] });
    return;
  }
  e8.signal("error", "No usable browser found");
}

e8.defun("browse-url-default-browser", (url: string) => defaultBrowser(url));
e8.defun("browse-url-default-macosx-browser", (url: string) => defaultBrowser(url));
e8.defun("browse-url-xdg-open", (url: string) => defaultBrowser(url));

/** The handler of an alist entry that matches URL: its regexp matches or its predicate is true of it. */
function matchingHandler(alist: e8.Value | undefined, url: string): e8.Value | undefined {
  if (!Array.isArray(alist)) return undefined;
  for (const entry of alist) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [test, handler] = entry;
    const matches = typeof test === "string" ? e8.emacsRegexp(test).test(url) : truthy((e8.funcall(test as unknown as string, url) as e8.Value) ?? null);
    if (matches) return handler;
  }
  return undefined;
}

/**
 * Opens URL as browse-url does: with the handler the alist form of
 * browse-url-browser-function, browse-url-handlers or
 * browse-url-default-handlers picks, else browse-url-browser-function,
 * ARGS passed on, browse-url-new-window-flag if there are none.
 */
export function browseUrl(url: string, ...args: e8.Value[]): void {
  const fn = e8.variable("browse-url-browser-function");
  const alist = Array.isArray(fn) && fn.every((e) => Array.isArray(e));
  const handler = (alist ? matchingHandler(fn, url) : undefined) ?? matchingHandler(e8.variable("browse-url-handlers"), url) ?? matchingHandler(e8.variable("browse-url-default-handlers"), url);
  const passed = args.length > 0 ? args : [e8.variable("browse-url-new-window-flag") ?? null];
  if (handler !== undefined) {
    e8.funcall(handler as string, url, ...passed);
    return;
  }
  if (alist) e8.signal("error", `No suitable browser for URL ${url}`);
  if (fn === null || fn === undefined || fn === false) e8.signal("error", "Symbol’s function definition is void: nil");
  e8.funcall(fn as string, url, ...passed);
}

/** The URL at or before point, as browse-url-url-at-point takes thing-at-point's. */
function urlAtPoint(): string | undefined {
  const line = e8.lineOf(e8.point());
  const text = e8.lineText(line);
  const col = e8.point() - e8.lineStart(line);
  for (const m of allMatches(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|news:)[^\s<>"'()[\]{}]*[^\s<>"'()[\]{}.,;:!?]/gi, text)) {
    const start = m.index ?? 0;
    if (start <= col && col <= start + m[0].length) return m[0];
  }
  return undefined;
}

e8.defineCommand({
  name: "browse-url",
  doc: "Open a URL, read in the minibuffer from the region or the URL at point, with the handler browse-url-handlers picks or browse-url-browser-function; a prefix argument turns browse-url-new-window-flag round.",
  params: [
    {
      name: "url",
      prompt: "URL: ",
      initial: () => {
        const mark = e8.mark();
        if (e8.regionActive() && mark !== undefined) return e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point())).replace(/[\t\r\f\n ]+/g, "");
        return urlAtPoint() ?? "";
      },
    },
    { name: "newWindow", kind: "prefix" },
  ],
  run: (url: string, newWindow: e8.Value) => {
    // The prefix argument xor browse-url-new-window-flag, as browse-url-interactive-arg gives it.
    const flag = truthy(e8.variable("browse-url-new-window-flag") ?? null) !== truthy(newWindow ?? null);
    browseUrl(url, flag);
  },
});
