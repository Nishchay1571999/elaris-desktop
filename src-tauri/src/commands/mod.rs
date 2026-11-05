//! Tauri commands, grouped by area. Each one is thin: validate, hand blocking
//! work to the crates, return serialisable results.

pub mod chat;
pub mod code;
pub mod contexts;
pub mod customizations;
pub mod edit;
pub mod git;
pub mod github;
pub mod sessions;
pub mod terminal;
pub mod workspace;
