//! Desktop control for the agent's `desktop-control` tool: screenshots of the
//! main display, and mouse and keyboard input as if the user did it. macOS only
//! for now; elsewhere every call fails with [`Error::Unsupported`].
//!
//! Coordinates are in screenshot pixels. Screenshots are scaled down to fit
//! [`MAX_WIDTH`]×[`MAX_HEIGHT`], which keeps them cheap for the model, and
//! [`Frame`] maps those pixels back to the display's points. Every call works
//! the frame out afresh, so nothing goes stale when the display changes.

pub mod keys;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(not(target_os = "macos"))]
#[path = "unsupported.rs"]
mod platform;

pub use keys::Combo;

/// The largest screenshot the agent gets, in pixels.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 800;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Desktop control only works on macOS for now.")]
    Unsupported,
    /// macOS hasn't granted Elaris a privacy permission; it has been asked for.
    #[error(
        "Elaris needs the {0} permission. macOS has asked the user to grant it in System Settings › Privacy & Security › {0}; once they have (Elaris may need a restart), try again."
    )]
    Permission(&'static str),
    #[error("({x}, {y}) is off the screen, which is {width}×{height} pixels.")]
    OffScreen { x: i32, y: i32, width: u32, height: u32 },
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// How screenshot pixels map onto the main display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    /// The screenshot's size in pixels.
    pub width: u32,
    pub height: u32,
    /// Display points per screenshot pixel.
    pub scale: f64,
}

impl Frame {
    /// The frame for a display `width`×`height` points in size: as large as
    /// fits in [`MAX_WIDTH`]×[`MAX_HEIGHT`] without scaling up.
    pub fn fit(width: f64, height: f64) -> Self {
        let scale = (width / f64::from(MAX_WIDTH)).max(height / f64::from(MAX_HEIGHT)).max(1.0);
        Self { width: (width / scale).round() as u32, height: (height / scale).round() as u32, scale }
    }

    /// The display point under screenshot pixel (`x`, `y`).
    pub fn to_points(&self, x: i32, y: i32) -> Result<(f64, f64)> {
        let inside = |v: i32, max: u32| v >= 0 && (v as u32) < max;
        if !inside(x, self.width) || !inside(y, self.height) {
            return Err(Error::OffScreen { x, y, width: self.width, height: self.height });
        }
        Ok(((f64::from(x) + 0.5) * self.scale, (f64::from(y) + 0.5) * self.scale))
    }

    /// The screenshot pixel over display point (`x`, `y`).
    pub fn to_pixels(&self, x: f64, y: f64) -> (i32, i32) {
        ((x / self.scale).floor() as i32, (y / self.scale).floor() as i32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// A JPEG of the main display, scaled to `frame`.
pub struct Screenshot {
    pub jpeg: Vec<u8>,
    pub frame: Frame,
}

/// The main display's frame.
pub fn frame() -> Result<Frame> {
    let (width, height) = platform::display_size()?;
    Ok(Frame::fit(width, height))
}

pub fn screenshot() -> Result<Screenshot> {
    let frame = frame()?;
    Ok(Screenshot { jpeg: platform::capture(&frame)?, frame })
}

/// Where the mouse pointer is, in screenshot pixels.
pub fn cursor() -> Result<(i32, i32)> {
    let frame = frame()?;
    let (x, y) = platform::cursor()?;
    Ok(frame.to_pixels(x, y))
}

/// Clicks `count` times (2 is a double-click) at (`x`, `y`).
pub fn click(x: i32, y: i32, button: Button, count: u8) -> Result<()> {
    if !(1..=3).contains(&count) {
        return Err(Error::Invalid("Click 1, 2 or 3 times.".into()));
    }
    let at = frame()?.to_points(x, y)?;
    platform::click(at, button, count)
}

/// Moves the pointer to (`x`, `y`), e.g. to show a tooltip or menu.
pub fn move_to(x: i32, y: i32) -> Result<()> {
    let at = frame()?.to_points(x, y)?;
    platform::move_to(at)
}

/// Presses the left button at `from`, moves to `to` and lets go.
pub fn drag(from: (i32, i32), to: (i32, i32)) -> Result<()> {
    let frame = frame()?;
    platform::drag(frame.to_points(from.0, from.1)?, frame.to_points(to.0, to.1)?)
}

/// Scrolls `lines` lines in `direction` with the pointer over (`x`, `y`).
pub fn scroll(x: i32, y: i32, direction: Direction, lines: u32) -> Result<()> {
    if lines == 0 || lines > 100 {
        return Err(Error::Invalid("Scroll between 1 and 100 lines.".into()));
    }
    let at = frame()?.to_points(x, y)?;
    platform::scroll(at, direction, lines as i32)
}

/// Types `text` into whatever has keyboard focus. Newlines press Return.
pub fn type_text(text: &str) -> Result<()> {
    platform::type_text(text)
}

/// Presses a key combination such as `cmd+shift+t` (see [`keys`]).
pub fn press(keys: &str) -> Result<()> {
    let combo = Combo::parse(keys).map_err(Error::Invalid)?;
    platform::press(combo)
}

/// Opens an app by name (`Safari`) or a URL, bringing it to the front.
pub fn open(target: &str) -> Result<()> {
    let target = target.trim();
    if target.is_empty() {
        return Err(Error::Invalid("Name an app or a URL to open.".into()));
    }
    platform::open(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retina_laptop_fits_without_cropping() {
        let frame = Frame::fit(1512.0, 982.0);
        assert_eq!((frame.width, frame.height), (1232, 800));
        let (x, y) = frame.to_points(616, 400).unwrap();
        assert!((x - 756.6).abs() < 1.0 && (y - 491.6).abs() < 1.0, "{x}, {y}");
    }

    #[test]
    fn small_displays_are_not_scaled_up() {
        assert_eq!(Frame::fit(1024.0, 768.0), Frame { width: 1024, height: 768, scale: 1.0 });
    }

    #[test]
    fn pixels_and_points_round_trip() {
        let frame = Frame::fit(2560.0, 1440.0);
        let (x, y) = frame.to_points(100, 200).unwrap();
        assert_eq!(frame.to_pixels(x, y), (100, 200));
    }

    #[test]
    fn coordinates_off_the_screenshot_are_refused() {
        let frame = Frame::fit(1280.0, 800.0);
        assert!(frame.to_points(1279, 799).is_ok());
        assert!(matches!(frame.to_points(1280, 10), Err(Error::OffScreen { .. })));
        assert!(matches!(frame.to_points(-1, 10), Err(Error::OffScreen { .. })));
    }
}
