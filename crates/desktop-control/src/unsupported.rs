//! Platforms without desktop control yet: every call fails.

use crate::keys::Combo;
use crate::{Button, Direction, Error, Frame, Result};

pub fn display_size() -> Result<(f64, f64)> {
    Err(Error::Unsupported)
}

pub fn capture(_: &Frame) -> Result<Vec<u8>> {
    Err(Error::Unsupported)
}

pub fn cursor() -> Result<(f64, f64)> {
    Err(Error::Unsupported)
}

pub fn move_to(_: (f64, f64)) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn click(_: (f64, f64), _: Button, _: u8) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn drag(_: (f64, f64), _: (f64, f64)) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn scroll(_: (f64, f64), _: Direction, _: i32) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn type_text(_: &str) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn press(_: Combo) -> Result<()> {
    Err(Error::Unsupported)
}

pub fn open(_: &str) -> Result<()> {
    Err(Error::Unsupported)
}
