//! Ctrl+C / Ctrl+X / Ctrl+V on macOS, where only ⌘ does these natively. The
//! UI forwards them here and they run as the real Edit-menu actions, so
//! pasting an image or copying a selection behaves exactly like ⌘.

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditAction {
    Copy,
    Cut,
    Paste,
}

#[tauri::command]
pub fn edit_action(app: AppHandle, action: EditAction) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || {
        use objc2::{MainThreadMarker, sel};
        use objc2_app_kit::NSApplication;

        let selector = match action {
            EditAction::Copy => sel!(copy:),
            EditAction::Cut => sel!(cut:),
            EditAction::Paste => sel!(paste:),
        };
        let mtm = MainThreadMarker::new().expect("runs on the main thread");
        // SAFETY: standard responder-chain actions, sent to the first responder.
        unsafe { NSApplication::sharedApplication(mtm).sendAction_to_from(selector, None, None) };
    })?;
    // Elsewhere Ctrl already is the shortcut, so the UI never calls this.
    #[cfg(not(target_os = "macos"))]
    let _ = (app, action);
    Ok(())
}
