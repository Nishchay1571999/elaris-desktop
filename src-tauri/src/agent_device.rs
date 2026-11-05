//! The agent's `device-control` tool, which only Elaris provides: Android
//! emulators and iOS simulators, read as text and driven in batches (see the
//! `device-control` crate). The current device, app and element list persist
//! across calls and chats for as long as Elaris runs.

use std::sync::{LazyLock, Mutex};

use agent_core::ResultImage;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use device_control::{DeviceControl, Request};

use crate::agent_desktop::Answer;

static CONTROL: LazyLock<DeviceControl> = LazyLock::new(DeviceControl::default);

/// Carries out one call; it blocks while the device works, so run it off the
/// async runtime. One call at a time, across every chat, so two agents can't
/// interleave their taps.
pub fn handle(request: serde_json::Value) -> Result<Answer, String> {
    static BUSY: Mutex<()> = Mutex::new(());
    let _turn = BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let request: Request = serde_json::from_value(request).map_err(|e| format!("Couldn't read the device-control call: {e}"))?;
    let reply = CONTROL.handle(request).map_err(|e| e.to_string())?;
    Ok(Answer {
        text: reply.text,
        image: reply.image.map(|jpeg| ResultImage { media_type: "image/jpeg".into(), data: BASE64.encode(jpeg) }),
    })
}
