//! macOS: Core Graphics events for input, `screencapture` and `sips` for
//! screenshots. Points are global display coordinates, top-left origin.
//!
//! Input needs the Accessibility permission and screenshots need Screen
//! Recording. Without them macOS silently drops events and captures only the
//! wallpaper, so each call checks first and asks for the permission if needed.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread::sleep;
use std::time::Duration;

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGDisplayBounds, CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType, CGMainDisplayID,
    CGMouseButton, CGPreflightPostEventAccess, CGPreflightScreenCaptureAccess, CGRequestPostEventAccess,
    CGRequestScreenCaptureAccess, CGScrollEventUnit,
};

use crate::keys::{Combo, RETURN};
use crate::{Button, Direction, Error, Frame, Result};

/// Gives apps time to see each step, as they would from a person.
const STEP: Duration = Duration::from_millis(30);
/// UTF-16 units per typed event; macOS drops anything past 20.
const TYPE_CHUNK: usize = 20;
const JPEG_QUALITY: &str = "70";

pub fn display_size() -> Result<(f64, f64)> {
    let bounds = CGDisplayBounds(CGMainDisplayID());
    Ok((bounds.size.width, bounds.size.height))
}

pub fn capture(frame: &Frame) -> Result<Vec<u8>> {
    if !CGPreflightScreenCaptureAccess() {
        CGRequestScreenCaptureAccess();
        return Err(Error::Permission("Screen Recording"));
    }
    let path = temp_file("jpg");
    let result = (|| {
        run(Command::new("screencapture").args(["-x", "-m", "-t", "jpg"]).arg(&path))?;
        run(Command::new("sips")
            .args(["-z", &frame.height.to_string(), &frame.width.to_string()])
            .args(["-s", "format", "jpeg", "-s", "formatOptions", JPEG_QUALITY])
            .arg(&path))?;
        Ok(std::fs::read(&path)?)
    })();
    let _ = std::fs::remove_file(&path);
    result
}

pub fn cursor() -> Result<(f64, f64)> {
    let event = CGEvent::new(None).ok_or_else(|| Error::Failed("Couldn't read the pointer's position.".into()))?;
    let at = CGEvent::location(Some(&event));
    Ok((at.x, at.y))
}

pub fn move_to(at: (f64, f64)) -> Result<()> {
    require_input()?;
    mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0)
}

pub fn click(at: (f64, f64), button: Button, count: u8) -> Result<()> {
    require_input()?;
    let (down, up, button) = match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    };
    // Hover first, so the app sees the pointer arrive as it would from a person.
    mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0)?;
    sleep(STEP);
    for n in 1..=i64::from(count) {
        mouse(down, at, button, n)?;
        mouse(up, at, button, n)?;
    }
    Ok(())
}

pub fn drag(from: (f64, f64), to: (f64, f64)) -> Result<()> {
    require_input()?;
    const STEPS: u32 = 20;
    mouse(CGEventType::MouseMoved, from, CGMouseButton::Left, 0)?;
    sleep(STEP);
    mouse(CGEventType::LeftMouseDown, from, CGMouseButton::Left, 1)?;
    for i in 1..=STEPS {
        let t = f64::from(i) / f64::from(STEPS);
        let at = (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
        sleep(Duration::from_millis(10));
        mouse(CGEventType::LeftMouseDragged, at, CGMouseButton::Left, 1)?;
    }
    sleep(STEP);
    mouse(CGEventType::LeftMouseUp, to, CGMouseButton::Left, 1)
}

pub fn scroll(at: (f64, f64), direction: Direction, lines: i32) -> Result<()> {
    require_input()?;
    mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0)?;
    sleep(STEP);
    // Positive wheel values scroll up (or left), as a mouse wheel turned away from you does.
    let (vertical, horizontal) = match direction {
        Direction::Up => (lines, 0),
        Direction::Down => (-lines, 0),
        Direction::Left => (0, lines),
        Direction::Right => (0, -lines),
    };
    let event = CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, vertical, horizontal, 0)
        .ok_or_else(|| Error::Failed("Couldn't create a scroll event.".into()))?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

pub fn type_text(text: &str) -> Result<()> {
    require_input()?;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            key(RETURN, CGEventFlags::empty())?;
        }
        let units: Vec<u16> = line.encode_utf16().collect();
        for chunk in units.chunks(TYPE_CHUNK) {
            for down in [true, false] {
                let event = keyboard(0, down)?;
                // SAFETY: `chunk` is a live slice of `chunk.len()` UTF-16 units.
                unsafe { CGEvent::keyboard_set_unicode_string(Some(&event), chunk.len() as _, chunk.as_ptr()) };
                CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
            }
            sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}

pub fn press(combo: Combo) -> Result<()> {
    require_input()?;
    let m = combo.modifiers;
    let mut flags = CGEventFlags::empty();
    for (on, flag) in [
        (m.command, CGEventFlags::MaskCommand),
        (m.shift, CGEventFlags::MaskShift),
        (m.control, CGEventFlags::MaskControl),
        (m.option, CGEventFlags::MaskAlternate),
        (m.function, CGEventFlags::MaskSecondaryFn),
    ] {
        if on {
            flags |= flag;
        }
    }
    key(combo.key, flags)
}

pub fn open(target: &str) -> Result<()> {
    let mut command = Command::new("open");
    if target.contains("://") {
        command.arg(target);
    } else {
        command.args(["-a", target]);
    }
    run(&mut command)
}

fn require_input() -> Result<()> {
    if CGPreflightPostEventAccess() {
        return Ok(());
    }
    CGRequestPostEventAccess();
    Err(Error::Permission("Accessibility"))
}

fn mouse(kind: CGEventType, (x, y): (f64, f64), button: CGMouseButton, clicks: i64) -> Result<()> {
    let event = CGEvent::new_mouse_event(None, kind, CGPoint { x, y }, button)
        .ok_or_else(|| Error::Failed("Couldn't create a mouse event.".into()))?;
    if clicks > 0 {
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventClickState, clicks);
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn key(code: u16, flags: CGEventFlags) -> Result<()> {
    for down in [true, false] {
        let event = keyboard(code, down)?;
        CGEvent::set_flags(Some(&event), flags);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn keyboard(code: u16, down: bool) -> Result<objc2_core_foundation::CFRetained<CGEvent>> {
    CGEvent::new_keyboard_event(None, code, down).ok_or_else(|| Error::Failed("Couldn't create a key event.".into()))
}

fn run(command: &mut Command) -> Result<()> {
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let program = command.get_program().to_string_lossy().into_owned();
    Err(Error::Failed(format!("`{program}` failed: {}", stderr.trim())))
}

fn temp_file(extension: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("elaris-screen-{}-{n}.{extension}", std::process::id()))
}
