//! The macOS display's functions, as nsfns.m, nsselect.m and nsmenu.m give
//! them (ADR 0097): hiding the application and showing its panels, which
//! the graphical front end asks AppKit for; the clipboard and selections;
//! the pointer; the defaults; and the questions about the display.

use crate::*;
use crate::natives::{Opt, natives};
use e8_core::AppRequest;

/// Emacs's error for a function that needs a window system, as check_window_system's.
fn need_window_system(ed: &Editor) -> Result<()> {
    if ed.window_system().is_none() {
        return Err(Error::signal("error", "Window system frame should be used", Vec::new()));
    }
    Ok(())
}

/// A selection's name: a symbol such as CLIPBOARD, PRIMARY by default.
fn selection_name(value: Option<EditorValue>) -> String {
    value.as_ref().and_then(EditorValue::as_str).map_or_else(|| "PRIMARY".to_string(), str::to_string)
}

/// A defaults owner's name, the editor's by default, as ns_app_name.
fn owner_name(owner: &EditorValue) -> String {
    owner.as_str().map_or_else(|| "E8".to_string(), str::to_string)
}

natives! {
    /// Hide the whole application with on true, show it again with null, or show it and make it active with "activate" or "activate-front", as ns-hide-emacs.
    #[ts = "(on: boolean | \"activate\" | \"activate-front\" | null): undefined"]
    pub fn nsHideEmacs(ed, on: EditorValue) -> Option<bool> {
        need_window_system(ed)?;
        let request = match on.as_str() {
            Some("activate" | "activate-front") => AppRequest::Activate,
            _ if on.is_true() => AppRequest::Hide,
            _ => AppRequest::Unhide,
        };
        ed.ask_application(request);
        Ok(None)
    }

    /// Hide every application but this one, as ns-hide-others.
    #[ts = "(): undefined"]
    pub fn nsHideOthers(ed) -> Option<bool> {
        need_window_system(ed)?;
        ed.ask_application(AppRequest::HideOthers);
        Ok(None)
    }

    /// Show the application's About panel, as ns-emacs-info-panel.
    #[ts = "(): undefined"]
    pub fn nsEmacsInfoPanel(ed) -> Option<bool> {
        need_window_system(ed)?;
        ed.ask_application(AppRequest::AboutPanel);
        Ok(None)
    }

    /// Show the colour panel, as ns-popup-color-panel.
    #[ts = "(frame?: FrameLike | null): undefined"]
    pub fn nsPopupColorPanel(ed, _frame: Opt<EditorValue>) -> Option<bool> {
        need_window_system(ed)?;
        ed.ask_application(AppRequest::ColorPanel);
        Ok(None)
    }

    /// Show the character palette, as ns-show-character-palette.
    #[ts = "(): undefined"]
    pub fn nsShowCharacterPalette(ed) -> Option<bool> {
        need_window_system(ed)?;
        ed.ask_application(AppRequest::CharacterPalette);
        Ok(None)
    }

    /// The services macOS offers, as ns-list-services: none, as on Cocoa, which cannot list them since 10.6.
    #[ts = "(): undefined"]
    pub fn nsListServices(_ed) -> Option<bool> {
        Ok(None)
    }

    /// Run a macOS service on some text, as ns-perform-service: E8 runs none, so there is no result.
    #[ts = "(service: string, send: string | null): undefined"]
    pub fn nsPerformService(ed, _service: String, _send: Opt<EditorValue>) -> Option<String> {
        need_window_system(ed)?;
        Ok(None)
    }

    /// The colours there are, as ns-list-colors: the names E8 knows, as defined-colors.
    #[ts = "(frame?: FrameLike | null): string[]"]
    pub fn nsListColors(_ed, _frame: Opt<EditorValue>) -> Vec<String> {
        Ok(e8_core::color_names().map(str::to_string).collect())
    }

    /// The family name of a font named by its XLFD name, or the name itself, as ns-font-name; a fontset's name is left alone.
    #[ts = "(name: string): string"]
    pub fn nsFontName(_ed, name: String) -> String {
        if name.contains("fontset") && !name.contains("fontset-startup") {
            return Ok(name);
        }
        Ok(e8_core::font::font_spec_from_name(&name).and_then(|f| f.family).filter(|_| name.starts_with('-')).unwrap_or(name))
    }

    /// A value from macOS's defaults for an owner, this application's with null, as ns-get-resource: what ns-set-resource set this session.
    #[ts = "(owner: string | null, name: string): string | undefined"]
    pub fn nsGetResource(ed, owner: EditorValue, name: String) -> Option<String> {
        need_window_system(ed)?;
        Ok(ed.ns_resource(&owner_name(&owner), &name))
    }

    /// Set a value in macOS's defaults for an owner, or take it away with null, as ns-set-resource; kept for this session.
    #[ts = "(owner: string | null, name: string, value: string | null): undefined"]
    pub fn nsSetResource(ed, owner: EditorValue, name: String, value: EditorValue) -> Option<bool> {
        need_window_system(ed)?;
        let value = value.as_str().map(str::to_string);
        ed.set_ns_resource(&owner_name(&owner), &name, value.as_deref());
        Ok(None)
    }

    /// Where the pointer is on the screen, as ns-mouse-absolute-pixel-position: [x, y], or undefined if not known.
    #[ts = "(): [x: number, y: number] | undefined"]
    pub fn nsMouseAbsolutePixelPosition(ed) -> Option<Vec<i64>> {
        Ok(ed.mouse_absolute_pixel_position().map(|(x, y)| vec![x, y]))
    }

    /// Move the pointer on the screen, as ns-set-mouse-absolute-pixel-position.
    #[ts = "(x: number, y: number): undefined"]
    pub fn nsSetMouseAbsolutePixelPosition(ed, x: i64, y: i64) -> Option<bool> {
        ed.set_mouse_absolute_pixel_position(x, y);
        Ok(None)
    }

    /// The largest request the display takes, as x-server-max-request-size: undefined, as macOS has none.
    #[ts = "(terminal?: Value): undefined"]
    pub fn xServerMaxRequestSize(ed, _terminal: Opt<EditorValue>) -> Option<f64> {
        need_window_system(ed)?;
        Ok(None)
    }

    /// Who made the display, as x-server-vendor: Apple on macOS.
    #[ts = "(terminal?: Value): string"]
    pub fn xServerVendor(ed, _terminal: Opt<EditorValue>) -> String {
        need_window_system(ed)?;
        Ok(if cfg!(target_os = "macos") { "Apple" } else { "The X.Org Foundation" }.to_string())
    }

    /// Build the menu bar again, as ns-reset-menu: E8 lays it out at every redisplay.
    #[ts = "(): undefined"]
    pub fn nsResetMenu(_ed) -> Option<bool> {
        Ok(None)
    }

    /// A selection's text, as ns-get-selection: CLIPBOARD is the system clipboard, PRIMARY and SECONDARY the editor's own.
    #[ts = "(selection: string | null, target?: Value, time?: Value, terminal?: Value): string | undefined"]
    pub fn nsGetSelection(ed, selection: EditorValue, _target: Opt<EditorValue>, _time: Opt<EditorValue>, _terminal: Opt<EditorValue>) -> Option<String> {
        let name = selection_name(Some(selection));
        Ok(ed.selection_value(&name))
    }

    /// Own a selection with some text, as ns-own-selection-internal; gives the text.
    #[ts = "(selection: string | null, value: string, frame?: FrameLike | null): string"]
    pub fn nsOwnSelectionInternal(ed, selection: EditorValue, value: EditorValue, _frame: Opt<EditorValue>) -> EditorValue {
        let text = value.as_str().ok_or_else(|| e8_core::xfaces::wrong_type("stringp", &value))?.to_string();
        ed.own_selection(&selection_name(Some(selection)), &text);
        Ok(value)
    }

    /// Give up a selection, as ns-disown-selection-internal.
    #[ts = "(selection: string | null, time?: Value, terminal?: Value): undefined"]
    pub fn nsDisownSelectionInternal(ed, selection: EditorValue, _time: Opt<EditorValue>, _terminal: Opt<EditorValue>) -> Option<bool> {
        ed.disown_selection(&selection_name(Some(selection)));
        Ok(None)
    }

    /// Whether the editor owns a selection, PRIMARY by default, as ns-selection-owner-p.
    #[ts = "(selection?: string | null, terminal?: Value): boolean"]
    pub fn nsSelectionOwnerP(ed, selection: Opt<EditorValue>, _terminal: Opt<EditorValue>) -> bool {
        Ok(ed.selection_owner_p(&selection_name(selection.0)))
    }

    /// Whether a selection, PRIMARY by default, holds anything, as ns-selection-exists-p.
    #[ts = "(selection?: string | null, terminal?: Value): boolean"]
    pub fn nsSelectionExistsP(ed, selection: Opt<EditorValue>, _terminal: Opt<EditorValue>) -> bool {
        Ok(ed.selection_exists_p(&selection_name(selection.0)))
    }

    /// Start dragging something from a frame to another program, as ns-begin-drag: E8 does not drag, so nothing is dropped and the answer is undefined.
    #[ts = "(frame: FrameLike | null, pboard: Value, action?: Value, pixelPosition?: Value, followMouse?: Value, allowSameFrame?: Value): undefined"]
    pub fn nsBeginDrag(ed, _frame: EditorValue, _pboard: EditorValue, _rest: crate::natives::Rest<EditorValue>) -> Option<String> {
        need_window_system(ed)?;
        Ok(None)
    }
}
