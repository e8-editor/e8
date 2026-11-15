//! What code asks of the application as a whole, as nsfns.m asks AppKit
//! (ADR 0097): hiding it and the other applications, and showing its
//! About panel, the colour panel and the character palette. Only macOS
//! has these; elsewhere they do nothing, as Emacs has the functions only
//! on its NS port.

use e8_core::AppRequest;

#[cfg(target_os = "macos")]
pub fn carry_out(request: AppRequest) {
    use objc2_app_kit::NSApplication;
    // Frame requests are carried out on the window's thread, AppKit's main one.
    let Some(mtm) = objc2::MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    match request {
        AppRequest::Hide => app.hide(None),
        AppRequest::Unhide => app.unhide(None),
        AppRequest::Activate => {
            app.unhide(None);
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
        }
        AppRequest::HideOthers => app.hideOtherApplications(None),
        AppRequest::AboutPanel => app.orderFrontStandardAboutPanel(None),
        // SAFETY: the shared colour panel, opened on the main thread with no sender.
        AppRequest::ColorPanel => unsafe { app.orderFrontColorPanel(None) },
        AppRequest::CharacterPalette => app.orderFrontCharacterPalette(None),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn carry_out(_request: AppRequest) {}
