//! E8's graphical front end, built on egui.

mod app;
#[cfg(not(target_arch = "wasm32"))]
pub mod clipboard;
mod fringe;
mod image;
pub mod keys;
pub mod metrics;
pub mod modeline;
#[cfg(unix)]
pub mod shell_path;
pub mod theme;

pub use app::{E8App, transparent_title_bar};
