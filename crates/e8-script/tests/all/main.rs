//! e8-script's tests, built as one binary with each file a module, so a
//! change links one test program rather than one a file, and macOS checks
//! one new program before it first runs rather than dozens. `bench`,
//! `emacs`, `org_fuzz`, `regexp`, `icomplete` and `bidi` stay binaries of
//! their own, as the commands that run them name them.

#[path = "../driven/mod.rs"]
mod driven;

mod abbrev;
mod acp;
mod agent_shell;
mod awaiting;
mod batch;
mod blocking;
mod bookmark;
mod buff_menu;
mod changes;
mod chartab;
mod codings;
mod comint;
mod commands;
mod compile;
mod dabbrev;
mod desktop;
mod diff;
mod ediff;
mod dired;
mod editorconfig;
mod elisp;
mod eglot;
mod face_attributes;
mod faces;
mod file_management;
mod file_primitives;
mod file_locals;
mod files;
mod flyspell;
mod fonts;
mod help;
mod help_guide;
mod hi_lock;
mod images;
mod indirect;
mod ispell;
mod keyboard;
mod keymaps;
mod layout;
mod line_numbers;
mod memory_fs;
mod minibuffer;
mod modes;
mod mouse;
mod org;
mod org_select;
mod org_src;
mod package_vc;
mod parens;
mod processes;
mod project;
mod quit;
mod redisplay;
mod registers;
mod scripts;
mod search;
mod sessions;
mod symbols;
mod tab_bar;
mod tabulated_list;
mod textprop;
mod themes;
mod transient;
mod treesit;
mod undo_list;
mod view;
mod which_key;
mod windows;
mod wrapping;
