// Opening URLs, after browse-url.el: browse-url gives a URL to the
// function browse-url-browser-function names, by default the system's way of
// opening one, as browse-url-default-browser does: open on macOS, else
// xdg-open.

import { executableFind, truthy } from "subr";

e8.defineVariable({
  name: "browse-url-browser-function",
  doc: "The function browse-url calls with a URL to open it: browse-url-default-browser, the system's way, by default.",
  value: "browse-url-default-browser",
});

e8.defineVariable({
  name: "browse-url-new-window-flag",
  doc: "Whether browse-url asks for a new window, which a prefix argument turns round.",
  value: false,
});

/** Opens URL with the program the system opens URLs with, as browse-url-default-browser: open on macOS, else xdg-open. */
function defaultBrowser(url: string): void {
  const program = e8.variable("system-type") === "darwin" ? "open" : executableFind("xdg-open") ? "xdg-open" : undefined;
  if (program === undefined) e8.signal("error", "No usable browser found");
  e8.makeProcess({ name: `${program} ${url}`, command: [program!, url] });
}

e8.defun("browse-url-default-browser", (url: string) => defaultBrowser(url));
e8.defun("browse-url-default-macosx-browser", (url: string) => defaultBrowser(url));
e8.defun("browse-url-xdg-open", (url: string) => defaultBrowser(url));

/** Opens URL as browse-url-browser-function says, as browse-url does. */
export function browseUrl(url: string, newWindow?: boolean): void {
  const f = e8.variable("browse-url-browser-function") ?? "browse-url-default-browser";
  // An alist of regexps and functions, as browse-url-browser-function may be, picks the first whose regexp matches.
  if (Array.isArray(f) && f.every((e) => Array.isArray(e))) {
    for (const entry of f as e8.Value[][]) {
      if (typeof entry[0] === "string" && e8.emacsRegexp(entry[0]).test(url)) {
        e8.funcall(entry[1] as string, url, newWindow ?? false);
        return;
      }
    }
    e8.signal("error", `No browse-url-browser-function matching URL ${url}`);
  }
  e8.funcall(f as string, url, newWindow ?? false);
}

e8.defineCommand({
  name: "browse-url",
  doc: "Open a URL, read in the minibuffer, with the browser browse-url-browser-function names.",
  params: [
    { name: "url", prompt: "Open URL: " },
    { name: "newWindow", kind: "prefix" },
  ],
  run: (url: string, newWindow: e8.Value) => browseUrl(url, truthy(newWindow ?? null)),
});
