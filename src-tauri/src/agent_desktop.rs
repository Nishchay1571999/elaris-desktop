//! The agent's `desktop-control` tool, which only Elaris provides: screenshots
//! of the main display, and the mouse and keyboard, used as if by the user.
//! macOS asks the user for the Screen Recording and Accessibility permissions
//! the first time they're needed.

use std::sync::Mutex;

use agent_core::{DesktopRequest, MouseButton, ResultImage, ScrollDirection};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use desktop_control::{Button, Direction};

/// Lines a scroll moves when the agent doesn't say.
const SCROLL_LINES: u32 = 5;

/// What a call answers the agent with.
pub struct Answer {
    pub text: String,
    pub image: Option<ResultImage>,
}

impl From<String> for Answer {
    fn from(text: String) -> Self {
        Self { text, image: None }
    }
}

/// Carries out one call; it blocks while events play out, so run it off the
/// async runtime. One call at a time, across every chat, so two agents can't
/// interleave their clicks and keystrokes.
pub fn handle(request: DesktopRequest) -> Result<Answer, String> {
    static BUSY: Mutex<()> = Mutex::new(());
    let _turn = BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    act(request).map_err(|e| e.to_string())
}

fn act(request: DesktopRequest) -> desktop_control::Result<Answer> {
    Ok(match request {
        DesktopRequest::Screenshot => {
            let shot = desktop_control::screenshot()?;
            let (width, height) = (shot.frame.width, shot.frame.height);
            let pointer = match desktop_control::cursor() {
                Ok((x, y)) => format!(" The pointer is at ({x}, {y})."),
                Err(_) => String::new(),
            };
            Answer {
                text: format!(
                    "Screenshot of the main display, {width}×{height} pixels.{pointer} Give other actions coordinates in these pixels."
                ),
                image: Some(ResultImage { media_type: "image/jpeg".into(), data: BASE64.encode(&shot.jpeg) }),
            }
        }
        DesktopRequest::Click { x, y, button, count } => {
            let count = count.unwrap_or(1);
            desktop_control::click(x, y, button_of(button), count)?;
            let what = match (button, count) {
                (MouseButton::Right, _) => "Right-clicked",
                (MouseButton::Middle, _) => "Middle-clicked",
                (MouseButton::Left, 2) => "Double-clicked",
                (MouseButton::Left, 3) => "Triple-clicked",
                (MouseButton::Left, _) => "Clicked",
            };
            format!("{what} at ({x}, {y}).").into()
        }
        DesktopRequest::Move { x, y } => {
            desktop_control::move_to(x, y)?;
            format!("Moved the pointer to ({x}, {y}).").into()
        }
        DesktopRequest::Drag { from_x, from_y, to_x, to_y } => {
            desktop_control::drag((from_x, from_y), (to_x, to_y))?;
            format!("Dragged from ({from_x}, {from_y}) to ({to_x}, {to_y}).").into()
        }
        DesktopRequest::Scroll { x, y, direction, amount } => {
            let lines = amount.unwrap_or(SCROLL_LINES);
            desktop_control::scroll(x, y, direction_of(direction), lines)?;
            format!("Scrolled {} {lines} lines at ({x}, {y}).", name_of(direction)).into()
        }
        DesktopRequest::Type { text } => {
            desktop_control::type_text(&text)?;
            format!("Typed {} characters.", text.chars().count()).into()
        }
        DesktopRequest::Key { keys } => {
            desktop_control::press(&keys)?;
            format!("Pressed {keys}.").into()
        }
        DesktopRequest::Open { target } => {
            desktop_control::open(&target)?;
            format!("Opened {target}.").into()
        }
    })
}

fn button_of(button: MouseButton) -> Button {
    match button {
        MouseButton::Left => Button::Left,
        MouseButton::Right => Button::Right,
        MouseButton::Middle => Button::Middle,
    }
}

fn direction_of(direction: ScrollDirection) -> Direction {
    match direction {
        ScrollDirection::Up => Direction::Up,
        ScrollDirection::Down => Direction::Down,
        ScrollDirection::Left => Direction::Left,
        ScrollDirection::Right => Direction::Right,
    }
}

fn name_of(direction: ScrollDirection) -> &'static str {
    match direction {
        ScrollDirection::Up => "up",
        ScrollDirection::Down => "down",
        ScrollDirection::Left => "left",
        ScrollDirection::Right => "right",
    }
}
