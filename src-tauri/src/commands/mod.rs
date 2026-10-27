//! Tauri commands, grouped by area. Each one is thin: validate, hand blocking
//! work to the crates, return serialisable results.

pub mod chat;
pub mod code;
pub mod customizations;
pub mod edit;
pub mod git;
pub mod sessions;
pub mod terminal;
pub mod workspace;
