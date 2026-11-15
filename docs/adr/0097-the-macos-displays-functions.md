# 0097. The macOS display's functions

Status: accepted · 2026-11-15

## Context

After [ADR 0096](0096-the-mark-as-a-marker.md), the platform primitives E8 lacked were those of Emacs's NS port: nsfns.m, nsselect.m and nsmenu.m. Their users:

- **Configs written for macOS** call `ns-hide-emacs`, `ns-hide-others`, `ns-popup-color-panel` and `ns-show-character-palette` from keys such as `s-h`, as ns-win.el binds them.
- **select.el** reads and sets the clipboard and the primary selection on macOS through `ns-get-selection`, `ns-own-selection-internal` and their kin.
- **Code that asks about the display** calls `x-server-vendor` and `x-server-max-request-size`.

E8's GUI runs on macOS and Linux through winit. Its core has no UI dependencies, and asks the front end for what it cannot do itself through frame requests ([ADR 0077](0077-frames-and-the-window-tree-as-emacs-has-them.md)).

## Decision

- **The application.** A new kind of frame request, `FrameRequest::App(AppRequest)`, asks the front end to:
  - hide, show or activate the application;
  - hide the others;
  - show the About panel, the colour panel or the character palette.

  On macOS the GUI carries each out with AppKit on the main thread, as nsfns.m does (`e8-gui/src/application.rs`, with `objc2-app-kit`'s `NSApplication`). Elsewhere they do nothing, as Emacs has the functions only on its NS port.
- **Selections** (`select.rs`). CLIPBOARD is the system clipboard the front end gives the editor. PRIMARY and SECONDARY are kept by the editor, as Emacs's NS port keeps them on pasteboards of its own. The functions are:
  - `ns-get-selection` and `ns-own-selection-internal`;
  - `ns-disown-selection-internal`, which leaves the clipboard's text, no longer the editor's;
  - `ns-selection-owner-p`, true for the clipboard while it still holds what the editor put there;
  - `ns-selection-exists-p`.
- **Defaults.** `ns-get-resource` gives what `ns-set-resource` set this session, by owner. E8 does not read macOS's defaults database, which would need AppKit in the core.
- **The rest:**
  - the pointer through E8's own (`mouse-absolute-pixel-position`);
  - `ns-list-colors` as `defined-colors`;
  - `ns-font-name`, the family of an XLFD name or the name itself;
  - `x-server-vendor`: Apple on macOS;
  - `x-server-max-request-size`, nil as on macOS;
  - `ns-read-file-name`, in the minibuffer as `read-file-name`;
  - `ns-list-services`, nil as on Cocoa;
  - `ns-perform-service`, `ns-begin-drag` and `ns-reset-menu`, which do nothing.
- **Without a window system** the functions that need one signal as check_window_system does: "Window system frame should be used".

## Consequences

- **What it unblocks.** macOS configs' keys for hiding and the panels work in E8.app, and select.el's NS backend has its primitives.
- **Recorded in [differences.md](../differences.md):**
  - the defaults are E8's own for the session;
  - services and dragging do nothing;
  - the file panel is the minibuffer.
- **Dependencies.** objc2-app-kit, already the GUI's, takes the `NSApplication`, `NSResponder`, `NSColorPanel`, `NSPanel` and `NSWindow` features. `objc2` itself is a direct dependency for `MainThreadMarker`, with no new crate in the lock.
- **Not verified live.** AppKit's calls were built and type-checked on macOS. The tests check the requests the editor makes, not the panels opening.
