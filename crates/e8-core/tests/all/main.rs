//! e8-core's tests, built as one binary with each file a module, so a
//! change links one test program rather than one a file, and macOS checks
//! one new program before it first runs rather than many.

mod bidi;
mod buffer_read_only;
mod clipboard;
mod display;
mod driver;
mod editing;
mod faces;
mod fonts;
mod images;
mod keys;
mod margins_and_fringes;
mod modeline;
mod quit;
mod scrolling;
mod search;
mod selection;
mod undo_list;
mod windows;
