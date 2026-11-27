//! Org's own link types beyond files and IDs, as ol.el sets them: help,
//! the web's, which browse-url opens, and shell. The Emacs oracle cannot
//! open a browser or watch one open, so these are E8's own.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.press("M-<").unwrap();
    (ed, s)
}

/// Text typed key by key, as press takes it.
fn spell(text: &str) -> String {
    text.chars().map(|c| if c == ' ' { "SPC".to_string() } else { c.to_string() }).collect::<Vec<_>>().join(" ")
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

/// Records the URLs browse-url is given, in place of a browser.
fn record_urls(ed: &mut Editor, s: &Scripting) {
    eval(ed, s, "(globalThis.urls = [], e8.defun('test-browser', (url) => { globalThis.urls.push(url); }), e8.setVariable('browse-url-browser-function', 'test-browser'), 'ok')");
}

/// C-c C-o on a web link gives its URL, scheme and all, to browse-url.
#[test]
fn web_links_open_with_browse_url() {
    let (mut ed, s) = org("[[https://example.com/a?b=1][site]] [[mailto:a@example.com]] http://example.org/x\n");
    record_urls(&mut ed, &s);
    ed.press("C-f C-f C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    ed.press("C-s m a i l RET C-c C-o").unwrap();
    ed.press("C-s e x a m p l e . o RET C-c C-o").unwrap();
    assert_eq!(eval(&mut ed, &s, "globalThis.urls.join(' ')"), "https://example.com/a?b=1 mailto:a@example.com http://example.org/x");
}

/// browse-url takes an alist of regexps and functions too.
#[test]
fn browse_url_with_an_alist() {
    let (mut ed, s) = org("x\n");
    eval(&mut ed, &s, "(globalThis.urls = [], e8.defun('test-browser', (url) => { globalThis.urls.push('alist ' + url); }), e8.setVariable('browse-url-browser-function', [['^https:', 'test-browser']]), 'ok')");
    ed.press(&format!("M-x {} RET {} RET", spell("browse-url"), spell("https://e8.example"))).unwrap();
    assert_eq!(eval(&mut ed, &s, "globalThis.urls.join(' ')"), "alist https://e8.example");
}

/// A shell link asks first, and runs its command with its output in a
/// buffer of its own; no runs nothing; a matching skip regexp asks nothing.
#[test]
fn shell_links_ask_before_running() {
    let (mut ed, s) = org("[[shell:echo one; echo two]]\n");
    ed.press("C-f C-f C-c C-o n o RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Abort".to_string()));
    ed.press("C-c C-o y e s RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "e8.withCurrentBuffer('*Org Shell Output*', () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))"), r"one\ntwo\n");
    eval(&mut ed, &s, "e8.setVariable('org-link-shell-skip-confirm-regexp', '^echo')");
    ed.press("C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "String(e8.getBuffer('*Org Shell Output*<2>') !== undefined)"), "true");
}

/// A help link shows a command's or a variable's help; an unknown name says so.
#[test]
fn help_links_show_help() {
    let (mut ed, s) = org("[[help:forward-char]] [[help:fill-column]] [[help:no-such-thing-at-all]]\n");
    ed.press("C-f C-f C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(eval(&mut ed, &s, "e8.withCurrentBuffer('*Help*', () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))").starts_with("forward-char"));
    ed.press("C-s f i l l RET C-c C-o").unwrap();
    assert!(eval(&mut ed, &s, "e8.withCurrentBuffer('*Help*', () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))").starts_with("fill-column"));
    ed.press("C-s n o - s u c h RET C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Unknown function or variable: no-such-thing-at-all".to_string()));
}

/// org-store-link in *Help* stores a help link to what it describes, the
/// command a key runs for a key's help.
#[test]
fn help_links_are_stored_from_help() {
    let (mut ed, s) = org("x\n");
    ed.press(&format!("C-h f {} RET", spell("forward-char"))).unwrap();
    eval(&mut ed, &s, "e8.withCurrentBuffer('*Help*', () => e8.callInteractively('org-store-link'))");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.variable('org-stored-links')[0])"), r#"[\"help:forward-char\",null]"#);
    ed.press("C-h k C-f").unwrap();
    eval(&mut ed, &s, "e8.withCurrentBuffer('*Help*', () => e8.callInteractively('org-store-link'))");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.variable('org-stored-links')[0])"), r#"[\"help:forward-char\",null]"#);
}

/// browse-url-handlers picks a handler by regexp before
/// browse-url-browser-function, which gets browse-url-new-window-flag when
/// no argument is given; browse-url-encode-url encodes what misleads browsers.
#[test]
fn browse_url_handlers_and_encoding() {
    let (mut ed, s) = org("x\n");
    eval(&mut ed, &s, "(globalThis.urls = [], e8.defun('test-handler', (url, w) => { globalThis.urls.push('handler ' + url + ' ' + w); }), e8.defun('test-browser', (url, w) => { globalThis.urls.push('browser ' + url + ' ' + w); }), e8.setVariable('browse-url-handlers', [['^https://docs\\\\.', 'test-handler']]), e8.setVariable('browse-url-browser-function', 'test-browser'), e8.setVariable('browse-url-new-window-flag', true), 'ok')");
    eval(&mut ed, &s, "import('browse-url').then((b) => { b.browseUrl('https://docs.example/a'); b.browseUrl('https://other.example/b'); globalThis.encoded = b.browseUrlEncodeUrl('https://e.x/a b(\"c\")'); })");
    assert_eq!(eval(&mut ed, &s, "globalThis.urls.join(' | ')"), "handler https://docs.example/a true | browser https://other.example/b true");
    assert_eq!(eval(&mut ed, &s, "globalThis.encoded"), "https://e.x/a%20b%28%22c%22%29");
}
