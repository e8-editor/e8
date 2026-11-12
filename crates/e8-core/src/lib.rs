//! E8's editor core: buffers, commands, keymaps and the minibuffer.
//!
//! The core has no UI dependencies. A front end feeds an [`Editor`] keys with
//! [`Editor::handle_key`] and reads its state back to draw it. Tests and
//! scripts drive it the same way, with no terminal at all.

pub mod bidi;
mod bidi_display;
pub use bidi_display::is_bidi_control;
// Written by tests/emacs/bidi-data.el.
mod bidi_data;
mod buffer;
pub mod casefiddle;
pub mod clock;
pub mod charset;
pub mod chartab;
pub mod clicks;
mod casetab;
mod category;
// Written by tests/emacs/unicode.el; not every table is read yet.
#[allow(dead_code)]
mod chartab_data;
mod colors_data;
pub mod driver;
pub mod font;
pub mod diff;
pub mod frame_description;
pub mod quit;
mod specbind;
mod fringe;
pub mod image;
pub mod coding;
mod command;
pub mod completion;
mod codingfns;
mod commands;
pub mod display;
mod editor;
mod error;
mod faces;
mod filefns;
pub mod filelock;
mod fileio;
pub mod fileops;
mod files;
mod fontify;
mod indent;
pub use indent::{Motion, WindowLine};
mod indirect;
mod insdel;
pub use insdel::Insertion;
mod key;
pub mod keyboard;
mod kill_ring;
mod keymap;
pub mod lread;
pub mod layout;
mod minibuffer;
mod modeline;
pub use modeline::ModeLineSegment;
mod modes;
mod permissions;
mod prefix;
pub mod process;
mod properties;
mod questions;
pub mod regexp;
mod rows;
mod scroll;
mod search;
pub mod select;
mod symbols;
pub mod sysdep;
mod syntax;
mod textprop;
pub mod syntax_table;
mod timers;
pub mod treesitfns;
mod window;
mod window_tree;
mod variables;
pub mod vfs;

pub use buffer::{Buffer, UndoStep};
pub use command::{Arg, Command, Param, ParamKind};
pub use editor::{Editor, LoggedMessage, Resume};
pub use error::{Error, Result, define_error, error_conditions};
pub use faces::{
    Background, Color, Decoration, FACE_ATTRIBUTES, Face, FaceAttrs, FaceBox, FaceHeight, Style, anonymous_face, color_dark_p, color_distance, color_gray_p,
    color_names, color_values, color_values_from_spec, face_names, is_fixed_family, palette, palette_names,
};
pub use fileio::{auto_save_file_name, backup_file_name};
pub use files::{abbreviate_dir, abbreviate_path, expand_file_name, expand_file_name_in, expand_file_name_string};
pub use key::{Key, KeyCode, MouseKind, format_keys};
pub use keymap::{Binding, KeymapId, Keymaps, Lookup};
pub use minibuffer::{MinibufferInfo, Reading, file_name_all_completions};
pub use modes::MinorMode;
pub use prefix::{PrefixArg, prefix_numeric_value};
pub use properties::{Overlay, Props, Text};
pub use process::{CallDestination, CallResult, CallSpec, CallStderr, Contact, Destination as CallOutput, RegionInput, StderrDestination, NetworkSpec, PipeSpec, ProcessInfo, ProcessSpec, Status as ProcessStatus};
pub use font::{Font, FontKind, FontSize, font_spec};
pub use quit::{QuitHandle, QuitState};
pub use fringe::{FringeAlign, FringeBitmap, RowFringes, STANDARD_BITMAPS, WindowFringes};
pub use rows::{FringeSpec, LineNumbers, Margin, Row, Segment};
pub use symbols::{AdviceHow, Definition};
pub use search::{BufferHaystack, Match, SearchOptions, expand_replacement, fold_case_for as search_fold_case};
pub use variables::{Function, HookFn, ScriptObject, Value, Variable};
pub use filefns::{Visit, WriteSource, file_name_absolute_p, file_name_concat, substitute_in_file_name};
pub use window::{BuryOrKill, Combination, FIRST_FRAME, MINIBUFFER_WINDOW, FrameId, MouseEvent, Part, WindowId, WindowRect, WindowTree, WindowView};
