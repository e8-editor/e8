//! The built-in commands and their default key bindings.

use crate::buffer::Buffer;
use crate::command::{Arg, Command, ParamKind};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::{Key, KeyCode};
use crate::prefix::PrefixArg;
use crate::variables::Value;

/// The command a kill joins onto: every kill command sets this-command to
/// it when it kills, as Emacs's do through kill-region, so one that fails
/// leaves the next kill a new entry.
pub(crate) const KILL_COMMANDS: &[&str] = &["kill-region"];

fn def(
    ed: &mut Editor,
    name: &str,
    doc: &str,
    run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
) {
    ed.define_command(Command::new(name, doc, run));
}

/// Defines a movement command that Shift selection applies to.
fn def_motion(
    ed: &mut Editor,
    name: &str,
    doc: &str,
    run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
) {
    ed.define_command(Command::new(name, doc, run).shift_select());
}

/// Defines a command that takes the prefix argument as a count, its
/// first parameter, as interactive "p" gives it: code can pass a number.
fn def_counted(ed: &mut Editor, name: &str, doc: &str, run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static) {
    ed.define_command(Command::new(name, doc, run).param("n", ParamKind::Count, ""));
}

/// Defines a movement command that takes a count and that Shift selection applies to.
fn def_motion_counted(ed: &mut Editor, name: &str, doc: &str, run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static) {
    ed.define_command(Command::new(name, doc, run).param("n", ParamKind::Count, "").shift_select());
}

fn err<T>(message: &str) -> Result<T> {
    // The conditions Emacs signals for these, so code can catch them.
    let symbol = match message {
        "Beginning of buffer" => "beginning-of-buffer",
        "End of buffer" => "end-of-buffer",
        "Quit" => "quit",
        _ => "error",
    };
    Err(Error::signal(symbol, message, Vec::new()))
}

pub(crate) fn install(ed: &mut Editor) {
    movement(ed);
    editing(ed);
    killing(ed);
    files_and_buffers(ed);
    minibuffer(ed);
    searching(ed);
    fontifying(ed);
    recursive_editing(ed);
    casing(ed);
    bind_defaults(ed);
}

/// Changing case, as Emacs's casefiddle.c has the commands.
fn casing(ed: &mut Editor) {
    use crate::casefiddle::Case;
    let regions = [
        ("upcase-region", Case::Up, "Convert the region to upper case."),
        ("downcase-region", Case::Down, "Convert the region to lower case."),
        ("capitalize-region", Case::Capitalize, "Capitalize the region: each word's first character in title case or upper case, and the rest in lower case."),
        ("upcase-initials-region", Case::UpcaseInitials, "Upcase the initial of each word in the region, leaving the rest as it is."),
    ];
    for (name, case, doc) in regions {
        ed.define_command(
            Command::new(name, doc, move |ed, args| {
                ed.casify_region(case, args[0].as_int()? as usize, args[1].as_int()? as usize)?;
                Ok(())
            })
            .param("beg", ParamKind::RegionBeginning, "")
            .param("end", ParamKind::RegionEnd, ""),
        );
    }
    let words = [
        ("upcase-word", Case::Up, "Convert to upper case from point to the end of the word, moving over it."),
        ("downcase-word", Case::Down, "Convert to lower case from point to the end of the word, moving over it."),
        ("capitalize-word", Case::Capitalize, "Capitalize from point to the end of the word, moving over it: its first character in upper case and the rest in lower case."),
    ];
    for (name, case, doc) in words {
        let doc = format!("{doc}\n\nA prefix argument does that many words; a negative one does the words before point, which stays where it is. Point in the middle of a word cases only the part after it.");
        def_counted(ed, name, &doc, move |ed, args| ed.casify_word(case, args[0].as_int()?));
    }
}

/// Recursive edits, as Emacs's keyboard.c has the commands for them.
fn recursive_editing(ed: &mut Editor) {
    def(
        ed,
        "recursive-edit",
        "Edit recursively: go on with commands, with [ ] around the modes in the mode line, until C-M-c goes back to what entered the edit or C-] quits it.",
        |ed, _| ed.recursive_edit(),
    );
    def(ed, "menu-bar-open", "Open the first menu of the menu bar, to walk with the arrows, RET and C-g.", |ed, _| {
        ed.menu_bar_open(0)
    });
    def(ed, "exit-recursive-edit", "Leave the innermost recursive edit or minibuffer, going on with what entered it.", |ed, _| {
        ed.exit_recursive_edit()
    });
    def(ed, "abort-recursive-edit", "Quit the innermost recursive edit or minibuffer, and what entered it.", |ed, _| {
        ed.abort_recursive_edit()
    });
    def(ed, "top-level", "Leave every recursive edit and minibuffer, back to the top level.", |ed, _| {
        ed.top_level();
        Ok(())
    });
}

/// Fontifying by hand, which redisplay otherwise does as text comes into view.
fn fontifying(ed: &mut Editor) {
    def(ed, "font-lock-ensure", "Fontify the whole buffer now, rather than as it comes into view.", |ed, _| {
        ed.font_lock_ensure()
    });
    def(ed, "font-lock-flush", "Fontify the whole buffer again as it comes into view.", |ed, _| {
        ed.font_lock_flush();
        Ok(())
    });
}

/// The search commands Emacs has in C: literal and regular expression
/// search, forward and backward. The prefix argument says how many matches
/// to go through, and a negative one searches the other way.
fn searching(ed: &mut Editor) {
    for (name, regexp, backward, prompt, doc) in [
        ("search-forward", false, false, "Search: ", "Search forward from point for a string, leaving point after the match."),
        ("search-backward", false, true, "Search backward: ", "Search backward from point for a string, leaving point at the start of the match."),
        ("re-search-forward", true, false, "RE search: ", "Search forward from point for a regular expression, leaving point after the match."),
        ("re-search-backward", true, true, "RE search backward: ", "Search backward from point for a regular expression, leaving point at the start of the match."),
    ] {
        let doc = format!(
            "{doc}\n\nA prefix argument finds that many matches, and a negative one searches the other way. \
             Case is ignored if case-fold-search is on. Regular expressions use Emacs's syntax."
        );
        ed.define_command(
            Command::new(name, &doc, move |ed, args| {
                let pattern = args[0].as_str()?.to_string();
                let n = args[1].as_int()?;
                let options = crate::search::SearchOptions {
                    regexp,
                    backward: backward != (n < 0),
                    case_fold: crate::search::fold_case_for(ed, &pattern, false),
                    bound: None,
                };
                match ed.search_buffer(&pattern, &options, n.unsigned_abs() as usize)? {
                    Some(_) => Ok(()),
                    None => Err(Error::signal(
                        "search-failed",
                        format!("Search failed: \"{pattern}\""),
                        vec![crate::Value::Str(pattern.to_string())],
                    )),
                }
            })
            .param("string", ParamKind::String, prompt)
            .param("count", ParamKind::Count, ""),
        );
    }
}

fn movement(ed: &mut Editor) {
    def_motion_counted(
        ed,
        "forward-char",
        "Move point forward a character, or as many as the prefix argument says.\n\nA negative argument moves backward.",
        |ed, args| move_chars(ed, args[0].as_int()?),
    );
    def_motion_counted(
        ed,
        "backward-char",
        "Move point backward a character, or as many as the prefix argument says.\n\nA negative argument moves forward.",
        |ed, args| move_chars(ed, -args[0].as_int()?),
    );
    def_motion_counted(
        ed,
        "next-line",
        "Move point down a line, or as many as the prefix argument says.\n\nRepeated line moves keep to the column where they started.",
        |ed, args| line_move(ed, args[0].as_int()?),
    );
    def_motion_counted(
        ed,
        "previous-line",
        "Move point up a line, or as many as the prefix argument says.\n\nRepeated line moves keep to the column where they started.",
        |ed, args| line_move(ed, -args[0].as_int()?),
    );
    def_motion_counted(
        ed,
        "move-beginning-of-line",
        "Move point to the beginning of the line.\n\nWith a prefix argument N, move forward N - 1 lines first. Where text is hidden, this is the start of the row on screen, as in Emacs.",
        |ed, args| {
            let n = args[0].as_int()?;
            let b = ed.buffer();
            let orig = b.point();
            let pos = if n == 1 { orig } else { forward_line(b, orig, n - 1) };
            let row = ed.row_line_in(b, b.line_of(pos));
            // Fields, such as the minibuffer's prompt, stop it.
            let start = ed.constrain_to_field(b.line_start(row), orig, n != 1, true, None);
            ed.buffer_mut().set_point(start);
            Ok(())
        },
    );
    def_motion_counted(
        ed,
        "move-end-of-line",
        "Move point to the end of the line.\n\nWith a prefix argument N, move forward N - 1 lines first. Where text is hidden, this is the end of the row on screen, after the hidden text, as in Emacs.",
        |ed, args| {
            let n = args[0].as_int()?;
            let b = ed.buffer();
            // Emacs moves N lines to the start of one and then back over its
            // newline, so going back to the first line or past it stops at the
            // start of the buffer.
            if n <= 0 && b.line_of(b.point()) as i64 + n <= 0 {
                ed.buffer_mut().set_point(0);
                return Ok(());
            }
            let pos = if n == 1 { b.point() } else { forward_line(b, b.point(), n - 1) };
            // Past hidden text that runs on from the end of the line, to the row's end.
            let mut end = b.line_end(b.line_of(pos));
            while ed.invisible_in(b, end).is_some() {
                end = b.line_end(b.line_of(ed.skip_invisible_in(b, end).0));
            }
            ed.buffer_mut().set_point(end);
            Ok(())
        },
    );
    def_motion_counted(
        ed,
        "forward-word",
        "Move point forward to the end of a word, or as many words as the prefix argument says.\n\nA negative argument moves backward.",
        |ed, args| {
            let n = args[0].as_int()?;
            let point = ed.buffer().point();
            let to = move_words(ed, point, n)?;
            ed.buffer_mut().set_point(to);
            Ok(())
        },
    );
    def_motion_counted(
        ed,
        "backward-word",
        "Move point back to the start of a word, or as many words as the prefix argument says.\n\nA negative argument moves forward.",
        |ed, args| {
            let n = args[0].as_int()?;
            let point = ed.buffer().point();
            let to = move_words(ed, point, -n)?;
            ed.buffer_mut().set_point(to);
            Ok(())
        },
    );
    def_motion(
        ed,
        "beginning-of-buffer",
        "Move point to the beginning of the buffer.\n\nUnless the region is active, leaves the mark where point was. With a numeric prefix argument N, move to N tenths of the way through the buffer instead, at the start of the next line. Plain C-u does not leave the mark.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let quiet = ed.executing_kbd_macro();
            let pushed = !matches!(arg, Some(PrefixArg::Universal(_))) && !ed.buffer().is_mark_active();
            if pushed {
                ed.push_mark(ed.buffer().point(), false);
            }
            let b = ed.buffer_mut();
            match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let pos = (1 + tenths(b.len(), arg.numeric())).clamp(0, b.len() as i64) as usize;
                    b.set_point(forward_line(b, pos, 1));
                }
                _ => b.set_point(b.point_min()),
            }
            // As Emacs's push-mark says, unless a macro is running.
            if pushed && !quiet {
                ed.message("Mark set");
            }
            Ok(())
        },
    );
    def_motion(
        ed,
        "end-of-buffer",
        "Move point to the end of the buffer.\n\nUnless the region is active, leaves the mark where point was. With a numeric prefix argument N, move to N tenths of the way from the end instead, at the start of the next line. Plain C-u does not leave the mark.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let quiet = ed.executing_kbd_macro();
            let pushed = !matches!(arg, Some(PrefixArg::Universal(_))) && !ed.buffer().is_mark_active();
            if pushed {
                ed.push_mark(ed.buffer().point(), false);
            }
            let b = ed.buffer_mut();
            match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let pos = (b.len() as i64 - tenths(b.len(), arg.numeric())).clamp(0, b.len() as i64) as usize;
                    b.set_point(forward_line(b, pos, 1));
                }
                _ => b.set_point(b.point_max()),
            }
            if pushed && !quiet {
                ed.message("Mark set");
            }
            Ok(())
        },
    );
    def_motion(ed, "scroll-up-command", "Scroll the text up by nearly a screen, showing later lines.\n\nWith a numeric prefix argument, scroll that many lines; with C-- alone, scroll the other way.", |ed, _| {
        match ed.current_prefix_arg() {
            None => {}
            Some(PrefixArg::Minus) => return scroll_screen_down(ed),
            Some(arg) => return scroll_lines_or_error(ed, arg.numeric()),
        }
        let step = scroll_step(ed) as i64;
        let b = ed.window_buffer();
        let from = ed.row_line_in(b, b.top_line);
        // Off the grid, rows are as tall as their fonts: the window moves on
        // by as many lines as fill the step.
        let (top, short) = if ed.text_metrics().uniform() {
            let (top, moved) = ed.move_rows_in(b, from, step);
            (top, moved < step)
        } else {
            move_by_height(ed, b, from, step as f32, true)
        };
        let point_row = ed.row_line_in(b, b.line_of(b.point()));
        let b = ed.window_buffer_mut();
        // As scroll-up with scroll-error-top-bottom off: the end showing
        // already is an error, and point stays.
        if short {
            return err("End of buffer");
        }
        b.top_line = top;
        if point_row < top {
            b.set_point(b.line_start(top));
        }
        Ok(())
    });
    for (name, sign, doc) in [
        ("scroll-left", 1, "Scroll the selected window's text left by the prefix argument's columns, showing more of long lines' ends.\n\nWithout one, by the window's width less two. Run by keys, the scroll it leaves is the least that keeping point in sight scrolls back to, until it scrolls back further. Gives the window's scroll."),
        ("scroll-right", -1, "Scroll the selected window's text right by the prefix argument's columns, back towards the lines' starts.\n\nWithout one, by the window's width less two. Run by keys, the scroll it leaves is the least that keeping point in sight scrolls back to. Gives the window's scroll."),
    ] {
        ed.define_command(
            Command::new(name, doc, move |ed, args| {
                let columns = match args.first() {
                    Some(Arg::Prefix(Some(arg))) => Some(arg.numeric()),
                    Some(Arg::Int(n)) => Some(*n),
                    _ => None,
                };
                let set_minimum = ed.called_interactively();
                // The window's body, line numbers included, as window_body_width.
                let body = ed.window_body_columns(ed.selected_window());
                let columns = columns.unwrap_or(body as i64 - 2);
                ed.scroll_left(sign * columns, set_minimum);
                Ok(())
            })
            .param("arg", ParamKind::Prefix, "")
            .shift_select(),
        );
    }
    def_motion(ed, "scroll-down-command", "Scroll the text down by nearly a screen, showing earlier lines.\n\nWith a numeric prefix argument, scroll that many lines; with C-- alone, scroll the other way.", |ed, _| {
        match ed.current_prefix_arg() {
            None => scroll_screen_down(ed),
            Some(PrefixArg::Minus) => ed.call("scroll-up-command", Vec::new()),
            Some(arg) => scroll_lines_or_error(ed, -arg.numeric()),
        }
    });
    def(
        ed,
        "mwheel-scroll",
        "Scroll the window for the mouse wheel or a trackpad.\n\nScrolls by as many lines as the wheel event carries. Point stays where it is unless it would leave the window.",
        |ed, _| {
            let lines = ed.wheel_lines as isize;
            let lines = match ed.last_key.map(|k| k.code) {
                Some(KeyCode::WheelUp) => -lines,
                _ => lines,
            };
            // Like mwheel-scroll in Emacs, reaching either end is not an
            // error, and the window under the mouse scrolls.
            match ed.last_mouse.map(|m| m.window) {
                Some(window) => ed.with_selected_window(window, |ed| scroll_lines(ed, lines)),
                None => scroll_lines(ed, lines),
            };
            Ok(())
        },
    );
    def_counted(ed, "scroll-up-line", "Scroll the text up a line, or as many as the prefix argument says.", |ed, args| {
        scroll_lines_or_error(ed, args[0].as_int()?)
    });
    def_counted(ed, "scroll-down-line", "Scroll the text down a line, or as many as the prefix argument says.", |ed, args| {
        scroll_lines_or_error(ed, -args[0].as_int()?)
    });
    def(
        ed,
        "suspend-emacs",
        "Stop E8 and go back to the shell, which continues it with fg, as a terminal's C-z stops a program.\n\nRuns suspend-hook first and suspend-resume-hook once continued. In a window there is no shell to go back to; C-z iconifies the window instead.",
        |ed, _| ed.suspend_emacs(),
    );
    def(
        ed,
        "recenter",
        "Scroll so the line with point is in the middle of the window.\n\nWith a numeric prefix argument N, put it on line N of the window instead, counting from the bottom if N is negative.",
        |ed, _| {
            let height = ed.viewport_height() as i64;
            let arg = ed.current_prefix_arg();
            let b = ed.window_buffer();
            let point_row = ed.row_line_in(b, b.line_of(b.point()));
            let row = match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let n = arg.numeric();
                    if n >= 0 { n.min(height - 1) } else { (height + n).max(0) }
                }
                _ => height / 2,
            };
            let top = ed.move_rows_in(b, point_row, -row).0;
            ed.window_buffer_mut().top_line = top;
            // Whole lines from the top, as Emacs's recenter resets the vscroll.
            let window = ed.selected_window();
            ed.reset_vscroll(window);
            Ok(())
        },
    );
    def(
        ed,
        "move-to-window-line",
        "Move point to the start of the line in the middle of the window.\n\nWith a numeric prefix argument N, to line N of the window instead, counting from 0 at the top, or from the bottom if N is negative.",
        |ed, _| {
            let height = ed.viewport_height() as i64;
            let arg = ed.current_prefix_arg();
            let row = match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let n = arg.numeric();
                    if n >= 0 { n.min(height - 1) } else { (height + n).max(0) }
                }
                _ => height / 2,
            };
            let b = ed.window_buffer();
            let top = ed.row_line_in(b, b.top_line);
            let line = ed.move_rows_in(b, top, row).0;
            let pos = b.line_start(line).clamp(b.point_min(), b.point_max());
            ed.window_buffer_mut().set_point(pos);
            Ok(())
        },
    );
}

/// Moves point `n` characters, backward if negative. Like Emacs, going past
/// either end stops there and signals an error.
fn move_chars(ed: &mut Editor, n: i64) -> Result<()> {
    let b = ed.buffer_mut();
    let target = b.point() as i64 + n;
    if target < b.point_min() as i64 {
        b.set_point(b.point_min());
        return err("Beginning of buffer");
    }
    if target > b.point_max() as i64 {
        b.set_point(b.point_max());
        return err("End of buffer");
    }
    b.set_point(target as usize);
    Ok(())
}

/// The start of the line `n` lines from the one containing `pos`, as Emacs's
/// `forward-line` moves: line 0 is the current line, and going past the last
/// line stops at the end of the buffer.
fn forward_line(b: &Buffer, pos: usize, n: i64) -> usize {
    let line = b.line_of(pos) as i64 + n;
    let (first, last) = (b.line_of(b.point_min()) as i64, b.line_of(b.point_max()) as i64);
    if line < first {
        b.point_min()
    } else if line > last || line as usize >= b.line_count() {
        b.point_max()
    } else {
        b.line_start(line as usize).max(b.point_min())
    }
}

/// `n` tenths of `size`, rounding towards zero as Emacs's integer division does.
fn tenths(size: usize, n: i64) -> i64 {
    size as i64 * n / 10
}

/// The position after moving `n` words from `pos`, backward if negative,
/// as Emacs's `scan_words`: a word whose first character, or last going
/// back, `find-word-boundary-function-table` gives a function ends where
/// that function, called with that character's position and the limit,
/// says, as subword and superword modes split and join words.
pub(crate) fn move_words(ed: &mut Editor, mut pos: usize, n: i64) -> Result<usize> {
    let start = pos;
    let table = match ed.variable("find-word-boundary-function-table") {
        Some(Value::CharTable(id)) => Some(id),
        _ => None,
    };
    let word = |ed: &Editor, c: char| ed.char_syntax(c).class == crate::syntax_table::Class::Word;
    for _ in 0..n.unsigned_abs() {
        let (min, max) = (ed.buffer().point_min(), ed.buffer().point_max());
        if n > 0 {
            while pos < max && ed.buffer().char_at(pos).is_some_and(|c| !word(ed, c)) {
                pos += 1;
            }
            let function = table.zip(ed.buffer().char_at(pos)).map(|(t, c)| ed.char_table_get(t, c as u32));
            match function {
                Some(f) if f.is_true() && pos < max => pos = boundary(ed, &f, pos, max)?,
                _ => {
                    while pos < max && ed.buffer().char_at(pos).is_some_and(|c| word(ed, c)) {
                        pos += 1;
                    }
                }
            }
        } else {
            while pos > min && ed.buffer().char_at(pos - 1).is_some_and(|c| !word(ed, c)) {
                pos -= 1;
            }
            let function = table.zip(pos.checked_sub(1).and_then(|p| ed.buffer().char_at(p))).map(|(t, c)| ed.char_table_get(t, c as u32));
            match function {
                Some(f) if f.is_true() && pos > min => pos = boundary(ed, &f, pos - 1, min)?,
                _ => {
                    while pos > min && ed.buffer().char_at(pos - 1).is_some_and(|c| word(ed, c)) {
                        pos -= 1;
                    }
                }
            }
        }
    }
    // Word motion keeps to the field it started in, such as the
    // minibuffer's input, as Emacs's does.
    Ok(ed.constrain_to_field(pos, start, false, false, None))
}

/// Where a word boundary function says the word at `pos` ends, going towards `limit`.
fn boundary(ed: &mut Editor, function: &Value, pos: usize, limit: usize) -> Result<usize> {
    let to = ed.funcall(function, &[Value::Number(pos as f64), Value::Number(limit as f64)])?;
    Ok(to.as_number().map_or(pos, |n| n as usize))
}

/// Scrolls `lines` lines, signalling an error if the window cannot scroll at all.
fn scroll_lines_or_error(ed: &mut Editor, lines: i64) -> Result<()> {
    if scroll_lines(ed, lines as isize) {
        Ok(())
    } else if lines < 0 {
        err("Beginning of buffer")
    } else {
        err("End of buffer")
    }
}

/// Scrolls back by nearly a screen, as M-v does.
fn scroll_screen_down(ed: &mut Editor) -> Result<()> {
    let step = scroll_step(ed) as i64;
    let height = ed.viewport_height() as i64;
    let b = ed.window_buffer();
    let old_top = ed.row_line_in(b, b.top_line);
    let (top, bottom) = if ed.text_metrics().uniform() {
        let top = ed.move_rows_in(b, old_top, -step).0;
        (top, ed.move_rows_in(b, top, height - 1).0)
    } else {
        // The last line that shows whole below the new top.
        let top = move_by_height(ed, b, old_top, step as f32, false).0;
        let next = move_by_height(ed, b, top, height as f32, true).0;
        (top, if next > top { ed.move_rows_in(b, next, -1).0 } else { top })
    };
    let point_row = ed.row_line_in(b, b.line_of(b.point()));
    let b = ed.window_buffer_mut();
    if old_top == 0 {
        b.set_point(0);
        return err("Beginning of buffer");
    }
    b.top_line = top;
    if point_row > bottom {
        b.set_point(b.line_start(bottom));
    }
    Ok(())
}

/// Scrolls the window by `lines`, positive towards the end of the buffer,
/// until the last line is at the top. Point stays put unless it would leave
/// the window; then it moves to the nearest visible line, keeping its column
/// across repeated scrolls as line moves do. Returns whether anything scrolled.
fn scroll_lines(ed: &mut Editor, lines: isize) -> bool {
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    let height = ed.viewport_height();
    let b = ed.window_buffer();
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ => b.column(b.point()) as f32,
    };
    ed.goal_column = Some(goal);
    let goal = goal as usize;
    let b = ed.window_buffer();
    let (top, moved) = ed.move_rows_in(b, ed.row_line_in(b, b.top_line), lines as i64);
    if moved == 0 {
        return false;
    }
    let bottom = ed.move_rows_in(b, top, height as i64 - 1).0;
    let point_row = ed.row_line_in(b, b.line_of(b.point()));
    let target = point_row.clamp(top, bottom);
    let b = ed.window_buffer_mut();
    b.top_line = top;
    if target != point_row {
        let start = b.line_start(target);
        b.set_point((start + goal).min(b.line_end(target)));
    }
    true
}

/// Commands after which scrolling and line moves keep the earlier goal column.
const SCROLL_KEEPS_COLUMN: &[&str] =
    &["next-line", "previous-line", "mwheel-scroll", "scroll-up-line", "scroll-down-line"];

/// Moves point `n` lines, up if negative, keeping the goal column. Where
/// long lines are continued, it moves by screen lines, as Emacs's
/// `line-move-visual` does.
fn line_move(ed: &mut Editor, n: i64) -> Result<()> {
    if let Some(wrap) = ed.visual_wrap() {
        return line_move_visual(ed, n, wrap);
    }
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    // Columns depend on what font-lock hides, which redisplay would have
    // brought up to date before this command.
    let p = ed.buffer().point();
    let _ = ed.fontify_region(p..p);
    let b = ed.buffer();
    let line = b.line_of(b.point());
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ => match off_grid_row(ed, b, b.point()) {
            Some(row) => row_column(ed, b, &row, b.point()),
            None => current_column(ed, b, b.point()) as f32,
        },
    };
    ed.goal_column = Some(goal);
    // Lines inside hidden text are skipped, as Emacs's line-move-ignore-invisible does.
    let b = ed.buffer();
    let (target, moved) = ed.move_rows_in(b, ed.row_line_in(b, line), n);
    if moved != n {
        let b = ed.buffer_mut();
        if n > 0 {
            b.set_point(b.point_max());
            return err("End of buffer");
        }
        b.set_point(b.point_min());
        return err("Beginning of buffer");
    }
    let start = ed.buffer().line_start(target);
    let _ = ed.fontify_region(start..start);
    let b = ed.buffer();
    let pos = match off_grid_row(ed, b, start) {
        Some(row) => position_at_x(ed, b, &row, goal),
        None if goal.fract() != 0.0 => position_at_x(ed, b, &ed.screen_rows_of(b, target, None)[0], goal),
        None => position_at_goal_column(ed, b, target, goal as usize),
    };
    ed.buffer_mut().set_point(pos);
    Ok(())
}

/// The row a position shows in, if it is off the grid: text of another
/// size or a proportional font, measured as the front end's fonts are,
/// unwrapped as a truncated line shows.
fn off_grid_row(ed: &Editor, b: &Buffer, pos: usize) -> Option<crate::rows::Row> {
    // Rows reordered for bidirectional text are measured as they show too.
    let bidi = ed.bidi_lines(b).is_some();
    if ed.text_metrics().uniform() && !bidi {
        return None;
    }
    let rows = ed.screen_rows_of(b, ed.row_line_in(b, b.line_of(pos)), None);
    let row = rows.iter().find(|r| r.shows_point(pos)).or(rows.first())?;
    let reordered = bidi && (row.right_to_left || crate::display::reordered(&crate::display::row_glyphs(row, ed.tab_width_in(b))));
    (!ed.row_on_grid(row) || reordered).then(|| row.clone())
}

/// The column, in default columns as the layout measures it, of where a
/// position shows in its row.
fn row_column(ed: &Editor, b: &Buffer, row: &crate::rows::Row, pos: usize) -> f32 {
    let tab = ed.tab_width_in(b);
    let glyphs = crate::display::row_glyphs(row, tab);
    let index = crate::display::cursor_glyph(row, &glyphs, pos);
    ed.glyph_columns(row, &glyphs, tab)[..index].iter().sum::<f32>() + ed.row_offset_in(ed.selected_window(), row)
}

/// Where a goal column lands in a row, as Emacs's vertical-motion does
/// with a goal in pixels: before the glyph that reaches past it, or the
/// row's end; on a continued row, its last character rather than its end,
/// which shows at the start of the next.
fn position_at_x(ed: &Editor, b: &Buffer, row: &crate::rows::Row, goal: f32) -> usize {
    position_at_x_in(ed, ed.selected_window(), b, row, goal)
}

/// As [`position_at_x`], in a row as a window lays it out.
pub(crate) fn position_at_x_in(ed: &Editor, window: crate::window::WindowId, b: &Buffer, row: &crate::rows::Row, goal: f32) -> usize {
    let tab = ed.tab_width_in(b);
    let glyphs = crate::display::row_glyphs(row, tab);
    let widths = ed.glyph_columns(row, &glyphs, tab);
    // A right-to-left row is laid out from the window's right edge.
    let mut x = ed.row_offset_in(window, row);
    for (i, glyph) in glyphs.iter().enumerate() {
        if x + widths[i] > goal {
            // An ellipsis or a string stands before the text after it.
            if let Some(p) = glyph.pos.or_else(|| glyphs[i + 1..].iter().find_map(|g| g.pos)) {
                return p;
            }
            break;
        }
        x += widths[i];
    }
    if row.continued { row.end.saturating_sub(1).max(row.start) } else { row.end }
}

/// Where move-to-column takes point on a line for a column: past text
/// hidden without an ellipsis, then to where the column is reached, past a
/// character that spans it, or the line's end.
pub(crate) fn move_to_column_on(ed: &Editor, b: &Buffer, line: usize, goal: usize) -> usize {
    use unicode_width::UnicodeWidthChar;
    let tab = ed.tab_width_in(b).max(1);
    let end = b.line_end(line);
    let mut col = 0;
    let mut p = b.line_start(line);
    while p < end {
        // Hidden text is skipped first, so point goes before the character the cursor shows on.
        if ed.invisible_in(b, p) == Some(false) {
            p += 1;
            continue;
        }
        if col >= goal {
            break;
        }
        col = match b.char_at(p) {
            Some('\t') => (col / tab + 1) * tab,
            Some(c) => col + c.width().unwrap_or(0),
            None => col,
        };
        p += 1;
    }
    p
}

/// Where a line move lands on a line for a goal column, as Emacs's
/// move-to-column does: the first position the column is reached at, even
/// if hidden text starts there, past a character that spans the column, or
/// the line's end.
fn position_at_goal_column(ed: &Editor, b: &Buffer, line: usize, goal: usize) -> usize {
    use unicode_width::UnicodeWidthChar;
    let tab = ed.tab_width_in(b).max(1);
    let end = b.line_end(line);
    let mut col = 0;
    let mut p = b.line_start(line);
    while p < end && col < goal {
        if ed.invisible_in(b, p) == Some(false) {
            p += 1;
            continue;
        }
        col = match b.char_at(p) {
            Some('\t') => (col / tab + 1) * tab,
            Some(c) => col + c.width().unwrap_or(0),
            None => col,
        };
        p += 1;
    }
    p
}

/// The column of a position as Emacs's current-column counts it: from the
/// start of its line, with tabs to tab stops, wide characters taking two
/// columns, and hidden text taking none, unless it shows an ellipsis, as
/// folds do: that counts as if shown.
pub(crate) fn current_column(ed: &Editor, b: &Buffer, pos: usize) -> usize {
    use unicode_width::UnicodeWidthChar;
    let tab = ed.tab_width_in(b).max(1);
    let mut col = 0;
    for p in b.line_start(b.line_of(pos))..pos {
        if ed.invisible_in(b, p) == Some(false) {
            continue;
        }
        col = match b.char_at(p) {
            Some('\t') => (col / tab + 1) * tab,
            Some(c) => col + c.width().unwrap_or(0),
            None => col,
        };
    }
    col
}

fn line_move_visual(ed: &mut Editor, n: i64, wrap: crate::rows::Wrap) -> Result<()> {
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    let b = ed.buffer();
    let (mut rows, mut k, col) = ed.screen_position(b, b.point(), Some(wrap));
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ if !ed.row_on_grid(&rows[k]) => row_column(ed, b, &rows[k], b.point()),
        _ => col as f32,
    };
    let mut line = ed.row_line_in(b, b.line_of(b.point()));
    let mut left = n.abs();
    while left > 0 {
        // Rows that show only an overlay string's later lines are passed over.
        let counts = |rows: &[crate::rows::Row], k: usize| !rows[k].in_string;
        if n > 0 && k + 1 < rows.len() {
            k += 1;
            left -= i64::from(counts(&rows, k));
            continue;
        }
        if n < 0 && k > 0 {
            k -= 1;
            left -= i64::from(counts(&rows, k));
            continue;
        }
        let (next, moved) = ed.move_rows_in(b, line, n.signum());
        if moved == 0 {
            ed.goal_column = Some(goal);
            let b = ed.buffer_mut();
            if n > 0 {
                b.set_point(b.point_max());
                return err("End of buffer");
            }
            b.set_point(b.point_min());
            return err("Beginning of buffer");
        }
        line = next;
        rows = ed.screen_rows_of(b, line, Some(wrap));
        k = if n > 0 { 0 } else { rows.len() - 1 };
        left -= i64::from(counts(&rows, k));
    }
    // Moving back onto an overlay string's rows ends on the text before them.
    while rows[k].in_string && k > 0 {
        k -= 1;
    }
    let row = &rows[k];
    let glyphs = crate::display::row_glyphs(row, ed.tab_width_in(b));
    // Bidirectional text is measured where it shows.
    let reordered = row.right_to_left || crate::display::reordered(&glyphs);
    if !ed.row_on_grid(row) || goal.fract() != 0.0 || reordered {
        let target = position_at_x(ed, b, row, goal);
        ed.goal_column = Some(goal);
        ed.buffer_mut().set_point(target);
        return Ok(());
    }
    let goal = goal as usize;
    // As move-to-column does: where the column is first reached, so past a
    // character that spans it, and before hidden text that starts there.
    let mut target = row.end;
    let (mut x, mut last_end) = (0, row.start);
    for glyph in &glyphs {
        if x >= goal {
            target = last_end;
            break;
        }
        x += glyph.width;
        if let Some(p) = glyph.pos {
            last_end = p + 1;
        }
    }
    // The end of a continued row shows at the start of the next, so stop
    // on its last character instead.
    if row.continued && target >= row.end {
        target = row.end.saturating_sub(1).max(row.start);
    }
    ed.goal_column = Some(goal as f32);
    ed.buffer_mut().set_point(target);
    Ok(())
}

/// How tall the rows of the row of text starting at a line are, in default
/// lines, as the selected window shows them.
fn line_rows_height(ed: &Editor, b: &Buffer, line: usize) -> f32 {
    let wrap = ed.wrap_in(ed.selected_window(), b);
    ed.screen_rows_of(b, line, wrap).iter().map(|r| ed.row_height(b, r)).sum()
}

/// The row of text `height` default lines of rows on from the one starting
/// at `line`, or back with `forward` false, whole rows of text at a time:
/// as many as fit in the height, at least one if there is one, as Emacs
/// moves a window's start by pixels when it scrolls. Also whether it ran
/// out of text before filling the height.
fn move_by_height(ed: &Editor, b: &Buffer, mut line: usize, height: f32, forward: bool) -> (usize, bool) {
    let (mut used, mut moved) = (0.0, 0);
    loop {
        let (next, step) = ed.move_rows_in(b, line, if forward { 1 } else { -1 });
        if step == 0 {
            return (line, used < height);
        }
        let h = line_rows_height(ed, b, if forward { line } else { next });
        if moved > 0 && used + h > height {
            return (line, false);
        }
        used += h;
        line = next;
        moved += 1;
        if used >= height {
            return (line, false);
        }
    }
}

/// How far a screen scroll moves: the window height less two lines of context.
fn scroll_step(ed: &Editor) -> usize {
    ed.viewport_height().saturating_sub(2).max(1)
}

/// What Emacs's self-insert does after inserting a character: a space or
/// newline runs `auto-fill-function`, on the line it ends for a newline,
/// then `post-self-insert-hook` runs.
fn after_self_insert(ed: &mut Editor, c: char, fill: bool) -> Result<()> {
    if fill
        && (c == ' ' || c == '\n')
        && let Some(Value::Str(function)) = ed.variable("auto-fill-function")
    {
        let newline = c == '\n';
        if newline {
            let p = ed.buffer().point();
            ed.buffer_mut().set_point(p - 1);
        }
        let tick = ed.buffer().modified_tick();
        ed.call(&function, Vec::new())?;
        // As Emacs's self-insert-command, a character that filled the line
        // ends the run of typing that undo takes as one step.
        if ed.buffer().modified_tick() != tick {
            ed.undo_auto_stop_amalgamating();
        }
        let b = ed.buffer_mut();
        if newline && b.point() < b.len() {
            let p = b.point();
            b.set_point(p + 1);
        }
    }
    ed.run_hooks("post-self-insert-hook")
}

fn editing(ed: &mut Editor) {
    def_counted(ed, "self-insert-command", "Insert the character you typed, as many times as the prefix argument says.", |ed, args| {
        let c = ed
            .last_key
            .and_then(|k| k.printable())
            .ok_or_else(|| Error::new("self-insert-command must be run from a key"))?;
        let n = args[0].as_int()?;
        if n < 0 {
            return Err(Error::new(format!("Negative repetition argument {n}")));
        }
        // In overwrite mode each character replaces the one after point,
        // except at the end of a line, as in Emacs.
        if ed.variable("overwrite-mode").is_some_and(|v| v.is_true()) {
            let b = ed.buffer();
            let p = b.point();
            let line_end = b.line_end(b.line_of(p));
            ed.delete_region(p, (p + n as usize).min(line_end))?;
        }
        // As Emacs's self-insert-command, the text takes on the properties around it.
        ed.insert_and_inherit(&c.to_string().repeat(n as usize))?;
        after_self_insert(ed, c, true)
    });
    ed.define_command(
        Command::new("insert", "Insert text at point.", |ed, args| {
            let text = args[0].as_str()?.to_string();
            ed.insert(&text)
        })
        .param("text", ParamKind::String, "Insert: "),
    );
    def_counted(ed, "newline", "Insert a newline, or as many as the prefix argument says.", |ed, args| {
        let n = args[0].as_int()?.max(0) as usize;
        // newline self-inserts, so the newlines take on the properties around them.
        ed.insert_and_inherit(&"\n".repeat(n))?;
        // With a prefix argument it does not auto-fill.
        let fill = ed.current_prefix_arg().is_none();
        after_self_insert(ed, '\n', fill)
    });
    // Without packages, TAB inserts a tab; indent.ts replaces this with
    // Emacs's, which indents as the mode says.
    def(ed, "indent-for-tab-command", "Insert a tab. The indent.ts package replaces this with one that indents the line as the mode says.", |ed, _| {
        ed.insert("\t")
    });
    def_counted(
        ed,
        "delete-backward-char",
        "Delete the character before point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted, so they can be yanked back. If the region is active, delete it instead, as the variable delete-active-region says.",
        |ed, args| {
            if delete_active_region(ed, args[0].as_int()?)? {
                return Ok(());
            }
            delete_chars(ed, -args[0].as_int()?)
        },
    );
    def_counted(
        ed,
        "delete-forward-char",
        "Delete the character after point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted. If the region is active, delete it instead, as the variable delete-active-region says.",
        |ed, args| {
            if delete_active_region(ed, args[0].as_int()?)? {
                return Ok(());
            }
            delete_chars(ed, args[0].as_int()?)
        },
    );
    def(ed, "ignore", "Do nothing. A pre-command-hook function can make a command this one, to cancel it.", |_, _| Ok(()));
    def_counted(
        ed,
        "delete-char",
        "Delete the character after point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted, so they can be yanked back.",
        |ed, args| delete_chars(ed, args[0].as_int()?),
    );
    def(
        ed,
        "undo",
        "Undo the last change, or as many changes as the prefix argument says.\n\nRepeat to undo earlier changes. Undoing is itself a change, so after any other command, undo undoes the undos: it redoes.",
        |ed, _| {
            ed.claim_undo(ed.current);
            let mut continuing = ed.last_command() == Some("undo") && ed.buffer().undo_continues();
            let mut redid = false;
            // With the region active, or a C-u or C-- argument, Emacs undoes only
            // changes inside the region, but an empty region takes in the
            // whole history. A run of undos keeps to the region it started in.
            let arg = ed.current_prefix_arg();
            let in_region = if continuing {
                ed.buffer().undo_in_region_message()
            } else {
                let region_arg = matches!(arg, Some(PrefixArg::Universal(_)) | Some(PrefixArg::Minus));
                if region_arg && ed.buffer().mark().is_none() {
                    return err("The mark is not set now, so there is no region");
                }
                let in_region = ed.buffer().is_mark_active() || region_arg;
                let b = ed.buffer_mut();
                b.stop_undo_in_region();
                if in_region && let Some(region) = b.region().filter(|r| !r.is_empty()) {
                    b.start_undo_in_region(region);
                }
                b.set_undo_in_region_message(in_region);
                in_region
            };
            // A count undoes that many changes, stopping quietly if there are fewer.
            let count = match arg {
                Some(PrefixArg::Number(n)) => n,
                _ => 1,
            };
            // As undo-more, a count of 0 or less undoes nothing but still
            // fails when there is nothing left to undo.
            if count <= 0 && !ed.buffer().undoing_in_region() && !ed.buffer().can_undo(continuing) {
                return err(if in_region { "No further undo information for region" } else { "No further undo information" });
            }
            if ed.buffer().undoing_in_region() {
                if ed.buffer().can_undo_in_region() {
                    ed.before_undo(continuing, false)?;
                }
                ed.buffer_mut().undo_in_region(count.max(0) as usize)?;
            } else {
                // Emacs's undo starts with (undo-more 1) to take off the boundary
                // the command loop put at the head of the list. With edits since
                // the last boundary, as after a C-d run that amalgamated and then
                // failed, there is none, and that call undoes those edits too.
                let unbounded = !continuing && count > 0 && ed.buffer().has_open_undo_group();
                for k in 0..count.max(0) + i64::from(unbounded) {
                    if ed.buffer().can_undo(continuing) {
                        ed.before_undo(continuing, false)?;
                    }
                    redid = match ed.buffer_mut().undo(continuing) {
                        Err(_) if k > 0 => break,
                        Err(_) if in_region => return err("No further undo information for region"),
                        result => result?,
                    };
                    continuing = true;
                }
            }
            ed.run_undo_applies()?;
            let message = if redid { "Redo" } else { "Undo" };
            ed.message(if in_region { format!("{message} in region") } else { message.to_string() });
            Ok(())
        },
    );
    def(
        ed,
        "undo-only",
        "Undo the last change, or as many as the prefix argument says, passing over the last undo and the change it undid: undo without redoing them.",
        |ed, _| {
            let prefix = ed.current_prefix_arg();
            ed.buffer_mut().undo_no_redo = true;
            let result = ed.call_with_prefix("undo", Vec::new(), prefix);
            ed.buffer_mut().undo_no_redo = false;
            // So that a following undo-only carries on from here.
            ed.set_this_command("undo");
            result
        },
    );
    def_counted(
        ed,
        "undo-redo",
        "Undo the last undo, or as many as the prefix argument says: redo.\n\nUnlike undoing an undo with undo, this leaves no trace in the undo history.",
        |ed, args| {
            ed.claim_undo(ed.current);
            for _ in 0..args[0].as_int()?.max(1) {
                ed.before_undo(false, true)?;
                ed.buffer_mut().undo_redo()?;
                ed.run_undo_applies()?;
            }
            // So that a following undo carries on from here.
            ed.set_this_command("undo");
            ed.message("Redo");
            Ok(())
        },
    );
    def(
        ed,
        "set-mark-command",
        "Set the mark at point and activate the region, saving the old mark on the mark ring.\n\nRepeating it straight away deactivates the region, leaving the mark set. With C-u, jump to the mark instead and take the previous one from the mark ring, so repeating C-u C-SPC goes back through earlier marks.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let repeated = ed.last_command() == Some("set-mark-command");
            let b = ed.buffer_mut();
            // A region Shift made goes first, as Emacs's does.
            if b.is_shift_selected() {
                b.deactivate_mark();
            }
            // Any argument but C-u C-u pops the mark, as in Emacs, a number included.
            if arg.is_some() && !matches!(arg, Some(PrefixArg::Universal(n)) if n > 4) {
                let mark = b.mark().ok_or_else(|| Error::new("No mark set in this buffer"))?;
                let popped = b.point() == mark;
                b.set_point(mark);
                b.pop_mark();
                if popped {
                    ed.message("Mark popped");
                }
            } else if repeated && b.is_mark_active() && b.mark() == Some(b.point()) {
                b.deactivate_mark();
                ed.message("Mark deactivated");
            } else {
                let p = b.point();
                ed.push_mark(p, true);
                ed.message("Mark set");
            }
            Ok(())
        },
    );
    def(
        ed,
        "exchange-point-and-mark",
        "Put the mark where point is and point where the mark was.\n\nWith a prefix argument, deactivate the region if it is active, and otherwise leave it inactive.",
        |ed, _| {
            let arg = ed.current_prefix_arg().is_some();
            let b = ed.buffer_mut();
            let mark = b.mark().ok_or_else(|| Error::new("No mark set in this buffer"))?;
            let temporary = b.is_shift_selected();
            b.set_mark(Some(b.point()));
            b.set_point(mark);
            // As Emacs's: setting the mark activates it, then a prefix
            // argument deactivates it, unless Shift made the region.
            if temporary || !arg {
                b.activate_region();
            } else {
                b.deactivate_mark();
            }
            Ok(())
        },
    );
    def(
        ed,
        "narrow-to-region",
        "Restrict editing in this buffer to the region: the rest is hidden and out of reach until widen (C-x n w).",
        |ed, _| {
            let region = region(ed.buffer())?;
            ed.buffer_mut().narrow(region.start, region.end);
            Ok(())
        },
    );
    def(
        ed,
        "pop-global-mark",
        "Go to the place on the global mark ring set last, in its buffer: each buffer's mark when another buffer's was set after it. Again, the one before.",
        |ed, _| ed.pop_global_mark(),
    );
    def(ed, "widen", "Remove the restriction on this buffer, making all of it accessible again.", |ed, _| {
        ed.buffer_mut().widen();
        Ok(())
    });
    def(ed, "mark-whole-buffer", "Put point at the beginning of the buffer and the mark at the end.", |ed, _| {
        ed.push_mark(ed.buffer().point(), false);
        ed.push_mark(ed.buffer().point_max(), true);
        let b = ed.buffer_mut();
        b.set_point(b.point_min());
        Ok(())
    });
    def(ed, "keyboard-quit", "Cancel the current prompt or key sequence, and deactivate the region.", |ed, _| {
        // Quitting a prompt leaves the buffer's region alone, as Emacs's
        // abort-minibuffers does.
        if ed.prompt().is_none() {
            ed.window_buffer_mut().deactivate_mark();
        }
        ed.abort();
        err("Quit")
    });
}

fn killing(ed: &mut Editor) {
    def(
        ed,
        "kill-line",
        "Kill the rest of the line, or the newline if only spaces and tabs are left.\n\nWith a prefix argument N, kill N whole lines, newlines included; 0 kills back to the start of the line, and a negative N kills lines backward. Consecutive kills join into one kill ring entry.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let p = ed.buffer().point();
            let to = match arg {
                Some(arg) => forward_line(ed.buffer(), p, arg.numeric()),
                None => {
                    if p >= ed.buffer().point_max() {
                        return err("End of buffer");
                    }
                    // The end of the visible line: a folded heading's hidden text goes too.
                    let end = ed.end_of_visible_line(p);
                    let b = ed.buffer();
                    let rest_is_blank = b.slice(p..end).chars().all(|c| c == ' ' || c == '\t');
                    let end = end.min(b.point_max());
                    if rest_is_blank && end < b.point_max() { end + 1 } else { end }
                }
            };
            kill_to(ed, p, to)
        },
    );
    def_counted(
        ed,
        "kill-word",
        "Kill forward to the end of a word, or as many words as the prefix argument says.\n\nA negative argument kills backward.",
        |ed, args| kill_words(ed, args[0].as_int()?),
    );
    def_counted(
        ed,
        "backward-kill-word",
        "Kill back to the start of a word, or as many words as the prefix argument says.\n\nA negative argument kills forward.",
        |ed, args| kill_words(ed, -args[0].as_int()?),
    );
    def(ed, "kill-region", "Kill the text between point and the mark.", |ed, _| {
        let region = region(ed.buffer())?;
        // Emacs passes the mark and point unsorted, so with point before the
        // mark the text joins the front of a kill before it.
        let backward = ed.buffer().mark().is_some_and(|m| ed.buffer().point() < m);
        kill_range(ed, region, backward)
    });
    def(ed, "kill-ring-save", "Copy the text between point and the mark to the kill ring.", |ed, _| {
        let region = region(ed.buffer())?;
        let backward = ed.buffer().mark().is_some_and(|m| ed.buffer().point() < m);
        let text = ed.buffer().substring(region);
        // As copy-region-as-kill does, a copy right after a kill joins it.
        ed.kill(text, backward);
        ed.buffer_mut().deactivate_mark();
        Ok(())
    });
    def(
        ed,
        "yank",
        "Insert the most recent kill, leaving the mark at its start.\n\nWith a numeric prefix argument N, insert the Nth most recent kill. With plain C-u, leave point at the start and the mark at the end.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            // Emacs sets the mark before it looks at the kill ring, even if it is empty.
            ed.push_mark(ed.buffer().point(), false);
            let back = match arg {
                None | Some(PrefixArg::Universal(_)) => 0,
                Some(PrefixArg::Minus) => -2,
                Some(PrefixArg::Number(n)) => n - 1,
            };
            // As push-mark says, unless a macro runs or the minibuffer is active.
            if !ed.executing_kbd_macro() && ed.prompt().is_none() {
                ed.message("Mark set");
            }
            let text = ed.current_kill_text(back)?;
            ed.insert_for_yank(text)?;
            let b = ed.buffer_mut();
            if let Some(PrefixArg::Universal(_)) = arg {
                let mark = b.mark().expect("set above");
                b.set_mark(Some(b.point()));
                b.set_point(mark);
            }
            Ok(())
        },
    );
}

/// Deletes `n` characters after point, or before it if negative. With a
/// prefix argument they are killed instead, as Emacs's delete-char does.
/// Like Emacs, asking for more characters than there are deletes nothing.
fn delete_chars(ed: &mut Editor, n: i64) -> Result<()> {
    // As Emacs's delete-char, whoever calls it: a run of commands deleting
    // a character at a time is one undo step, as typing is.
    if n.abs() < 2 {
        ed.undo_auto_amalgamate();
    }
    let kill = ed.current_prefix_arg().is_some();
    let b = ed.buffer_mut();
    let p = b.point() as i64;
    let (start, end) = if n >= 0 { (p, p + n) } else { (p + n, p) };
    if start < b.point_min() as i64 {
        return err("Beginning of buffer");
    }
    if end > b.point_max() as i64 {
        return err("End of buffer");
    }
    if kill {
        return kill_range(ed, start as usize..end as usize, n < 0);
    }
    ed.delete_region(start as usize, end as usize)?;
    Ok(())
}

/// Deletes the active region for DEL and <delete>, as Emacs does when
/// `delete-active-region` is on and there is no count other than 1. Kills it
/// instead if the variable is "kill". Returns whether it did.
fn delete_active_region(ed: &mut Editor, n: i64) -> Result<bool> {
    let setting = ed.variable("delete-active-region").unwrap_or(Value::Null);
    let region = ed.buffer().active_region().filter(|r| !r.is_empty());
    let (Some(region), true) = (region, setting.is_true() && n == 1) else {
        return Ok(false);
    };
    let deleted = ed.buffer().substring(region.clone());
    ed.delete_region(region.start, region.end)?;
    if setting.as_str() == Some("kill") {
        ed.kill(deleted, false);
        ed.set_this_command("kill-region");
    }
    Ok(true)
}

/// Kills `n` words after point, or before it if negative.
fn kill_words(ed: &mut Editor, n: i64) -> Result<()> {
    let p = ed.buffer().point();
    let to = move_words(ed, p, n)?;
    kill_to(ed, p, to)
}

/// Kills from point to where a motion took it, as Emacs's
/// `(kill-region (point) (progn (forward-word) (point)))` does: point has
/// moved there before the kill, so it stays there if the kill is refused,
/// as when the file changed on disk.
/// Kills from `beg` to `end`, as Emacs's kill-region called from code: the
/// text joins the kill before it if that command killed too, before it if
/// `end` is before `beg`.
pub(crate) fn kill_region(ed: &mut Editor, beg: usize, end: usize) -> Result<()> {
    // Point stays put, even when the kill is refused.
    kill_range(ed, beg.min(end)..beg.max(end), end < beg)
}

fn kill_to(ed: &mut Editor, p: usize, to: usize) -> Result<()> {
    let len = ed.buffer().len();
    kill_range(ed, p.min(to)..p.max(to), to < p).inspect_err(|_| {
        // Only a refused kill; one whose change hook failed deleted the text.
        if ed.buffer().len() == len {
            ed.buffer_mut().set_point(to);
        }
    })
}

/// Deletes a range and kills its text, as Emacs's kill-region does. The
/// change hooks run with the deletion, before the kill, so one that fails
/// leaves the text deleted but not on the kill ring. Read-only text is
/// copied to the kill ring instead, and the error signalled, unless
/// `kill-read-only-ok` says only to say so.
fn kill_range(ed: &mut Editor, range: std::ops::Range<usize>, backward: bool) -> Result<()> {
    // The text with its properties, as filter-buffer-substring gives it.
    let killed = ed.buffer().substring(range.clone());
    match ed.delete_region(range.start, range.end) {
        Ok(_) => {}
        Err(e) if e.is("buffer-read-only") || e.is("text-read-only") => {
            let text = killed;
            ed.kill(text, backward);
            ed.set_this_command("kill-region");
            if ed.variable("kill-read-only-ok").is_some_and(|v| v.is_true()) {
                ed.message("Read only text copied to kill ring");
                return Ok(());
            }
            // As barf-if-buffer-read-only, then the text's own error.
            if e.symbol() == "buffer-read-only" {
                return Err(e);
            }
            let name = ed.buffer().name.clone();
            return Err(Error::signal("text-read-only", format!("Text is read-only: #<buffer {name}>"), vec![Value::Str(name)]));
        }
        Err(e) => return Err(e),
    }
    ed.kill(killed, backward);
    // As kill-region sets deactivate-mark, even when nothing was killed.
    ed.buffer_mut().deactivate_mark();
    // As in Emacs, so the next kill or copy joins this one even when a
    // command such as org-cut-subtree called it.
    ed.set_this_command("kill-region");
    Ok(())
}

/// Completes the minibuffer's input as far as it goes, as Emacs's
/// `completion--do-completion`, saying so when it cannot. Returns whether
/// it is now a match.
fn minibuffer_complete(ed: &mut Editor) -> Result<bool> {
    let input = ed.minibuffer_input();
    ed.flush_all_sorted_completions();
    match ed.completion_try() {
        crate::completion::Try::None => err("[No match]"),
        crate::completion::Try::Exact => {
            ed.message("[Sole completion]");
            Ok(true)
        }
        crate::completion::Try::Completed { text, point } => {
            ed.replace_minibuffer_input(&text, point);
            if text == input && ed.is_completion_match(&text) {
                ed.message("[Complete, but not unique]");
            }
            Ok(ed.is_completion_match(&text))
        }
    }
}

/// The answer the minibuffer's input gives: the default for empty input,
/// or for a file name left as it started.
fn minibuffer_value(ed: &Editor) -> Result<String> {
    let prompt = ed.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?;
    let input = ed.minibuffer_input();
    let unchanged = input.is_empty() || (prompt.kind == ParamKind::File && input == prompt.initial);
    Ok(match &prompt.default {
        Some(default) if unchanged => default.clone(),
        _ => input,
    })
}

fn region(b: &Buffer) -> Result<std::ops::Range<usize>> {
    b.region()
        .ok_or_else(|| Error::new("The mark is not set now, so there is no region"))
}

fn files_and_buffers(ed: &mut Editor) {
    ed.define_command(
        Command::new(
            "find-file",
            "Visit a file in a buffer.\n\nA file that does not exist yet is created when the buffer is saved.",
            |ed, args| {
                let path = ed.expand_file_name(args[0].as_str()?);
                // A directory is listed in Dired, as find-file-run-dired has it.
                if crate::vfs::path_is_dir(&path) && ed.command("dired").is_some() {
                    return ed.call("dired", vec![Arg::Str(format!("{}/", path.display()))]);
                }
                ed.visit_file(&path)
            },
        )
        .param("file", ParamKind::File, "Find file: "),
    );
    ed.define_command(
        Command::new(
            "switch-to-buffer",
            "Show a buffer in the window, creating it if it does not exist.\n\nEmpty input switches to the buffer shown before this one.",
            |ed, args| {
                let name = match args[0].as_str()? {
                    "" => ed
                        .other_buffer()
                        .map(str::to_string)
                        .ok_or_else(|| Error::new("No other buffer"))?,
                    name => name.to_string(),
                };
                // As display-buffer-alist and the other actions say, with
                // switch-to-buffer-obey-display-actions (window.ts).
                if ed.obeys_display_actions() {
                    ed.get_buffer_create(&name);
                    return ed.call("pop-to-buffer-same-window", vec![Arg::Str(name)]);
                }
                // A window strongly dedicated to its buffer keeps it: typed,
                // switching is refused, as switch-to-buffer-in-dedicated-window
                // is nil in Emacs; from code, another window shows the buffer.
                if ed.window_dedicated(ed.selected_window()) == Value::Bool(true) && ed.minibuffer_depth() == 0 {
                    if ed.called_interactively() {
                        return Err(Error::user("Cannot switch buffers in a dedicated window"));
                    }
                    if ed.command("pop-to-buffer").is_none() {
                        return Err(Error::new("Cannot switch buffers in a dedicated window"));
                    }
                    ed.get_buffer_create(&name);
                    return ed.call("pop-to-buffer", vec![Arg::Str(name)]);
                }
                ed.switch_to_buffer(&name);
                Ok(())
            },
        )
        .param("buffer", ParamKind::Buffer, "Switch to buffer: ")
        // As Emacs's, naming what empty input chooses.
        .prompt_with(|ed, _| {
            Ok(match ed.other_buffer() {
                Some(other) => format!("Switch to buffer (default {other}): "),
                None => "Switch to buffer: ".to_string(),
            })
        }),
    );
    ed.define_command(
        Command::new(
            "kill-buffer",
            "Close a buffer. Empty input closes the current one.\n\nA file buffer with unsaved changes is closed only once you say so: yes, no, or save and then kill. Called from code, it refuses to close one.",
            |ed, args| {
                let name = match args[0].as_str()? {
                    "" => ed.window_buffer().name.clone(),
                    name => name.to_string(),
                };
                if ed.find_buffer(&name).is_none() {
                    return ed.kill_buffer(&name);
                }
                // As Emacs's kill-buffer: first kill-buffer-query-functions, with
                // the buffer current, any of which can keep it, as
                // process-kill-buffer-query-function does for a running process.
                let old = ed.set_current_buffer(&name)?;
                let kill = ed.run_hook_with_args_until_failure("kill-buffer-query-functions", &[]);
                if ed.find_buffer(&old).is_some() {
                    ed.set_current_buffer(&old)?;
                }
                if !kill? {
                    return Ok(());
                }
                if !ed.called_interactively() {
                    return ed.kill_buffer(&name);
                }
                // Then, typed, about unsaved changes, as kill-buffer--possibly-save asks.
                let modified = ed.find_buffer(&name).map(|i| &ed.buffers()[i]).is_some_and(|b| b.path.is_some() && b.is_modified());
                if !modified {
                    return ed.kill_buffer(&name);
                }
                let question = format!("Buffer {name} modified; kill anyway? ");
                match ed.read_answer(&question, &["yes", "no", "save and then kill"])?.as_str() {
                    "yes" => ed.kill_buffer_unsaved(&name),
                    "save and then kill" => {
                        let old = ed.set_current_buffer(&name)?;
                        let saved = ed.call("save-buffer", Vec::new());
                        if ed.find_buffer(&old).is_some() {
                            ed.set_current_buffer(&old)?;
                        }
                        saved?;
                        ed.kill_buffer(&name)
                    }
                    _ => Ok(()),
                }
            },
        )
        .param("buffer", ParamKind::Buffer, "Kill buffer: ")
        .prompt_with(|ed, _| Ok(format!("Kill buffer (default {}): ", ed.window_buffer().name))),
    );
    ed.define_command(
        Command::new(
            "rename-buffer",
            "Give the current buffer a new name. Empty input keeps the name it has.\n\nIf another buffer has the name, it is an error, unless there is a prefix argument: then the name gets a <2> or the like to make it unique, as Emacs's UNIQUE argument says.",
            |ed, args| {
                let current = ed.buffer().name.clone();
                // Empty input is the default, the name it has; from code, an error.
                let name = match args[0].as_str()? {
                    "" if ed.called_interactively() => current.clone(),
                    "" => return Err(Error::new("Empty string is invalid as a buffer name")),
                    name => name.to_string(),
                };
                let unique = !matches!(args[1], Arg::Prefix(None));
                let taken = |ed: &Editor, n: &str| n != current && ed.find_buffer(n).is_some();
                let name = if !taken(ed, &name) {
                    name
                } else if unique {
                    // As generate-new-buffer-name with the buffer's own name to ignore.
                    (2..).map(|n| format!("{name}<{n}>")).find(|n| !taken(ed, n)).expect("some name is free")
                } else {
                    return Err(Error::new(format!("Buffer name \u{2018}{name}\u{2019} is in use")));
                };
                ed.buffer_mut().name = name;
                Ok(())
            },
        )
        .param("newname", ParamKind::String, "Rename buffer (to new name): ")
        .history("buffer-name-history")
        .param("unique", ParamKind::Prefix, ""),
    );
}

fn minibuffer(ed: &mut Editor) {
    def(ed, "exit-minibuffer", "Finish the minibuffer input and pass it to the waiting command.\n\nEmpty input stands for the prompt's default, if it has one.", |ed, _| {
        let value = minibuffer_value(ed)?;
        ed.finish_prompt(value)
    });
    def(
        ed,
        "minibuffer-complete-and-exit",
        "Finish the minibuffer input if it is one of the completions, completing it first if only one matches.\n\nRET runs this in prompts that must be answered by one of their completions, such as M-x's.",
        |ed, _| {
            let value = minibuffer_value(ed)?;
            // Empty input is an answer even where one must match, as Emacs's
            // completing-read returns "" for it.
            let must_match = ed.prompt.as_ref().is_some_and(|p| p.require_match);
            if !must_match || value.is_empty() || ed.is_completion_match(&value) {
                return ed.finish_prompt(value);
            }
            match ed.prompt_completions(&value).as_slice() {
                [only] => ed.finish_prompt(only.clone()),
                [] => err("[No match]"),
                _ => {
                    // Completing as far as it goes may give a match, as
                    // find-f gives find-file, which finishes.
                    if minibuffer_complete(ed)? {
                        let value = ed.minibuffer_input();
                        if ed.is_completion_match(&value) {
                            return ed.finish_prompt(value);
                        }
                    }
                    Ok(())
                }
            }
        },
    );
    def(
        ed,
        "minibuffer-force-complete",
        "Complete the minibuffer input to the first of its completions, in the order they are offered in.",
        |ed, _| {
            if !ed.force_complete() {
                return err("[No completions]");
            }
            Ok(())
        },
    );
    def(
        ed,
        "minibuffer-force-complete-and-exit",
        "Complete the minibuffer input to the first of its completions and finish it.\n\nWith no completions, the input is finished as it is, unless the prompt must be answered by a completion.",
        |ed, _| {
            ed.force_complete();
            let value = minibuffer_value(ed)?;
            let must_match = ed.prompt.as_ref().is_some_and(|p| p.require_match);
            if must_match && !value.is_empty() && !ed.is_completion_match(&value) {
                return err("[Incomplete]");
            }
            ed.finish_prompt(value)
        },
    );
    def(
        ed,
        "minibuffer-complete",
        "Complete the minibuffer input as far as it is unambiguous.\n\nWhich names match the input is up to completion-styles.",
        |ed, _| {
            ed.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?;
            minibuffer_complete(ed).map(|_| ())
        },
    );
    def_counted(
        ed,
        "previous-history-element",
        "Replace the minibuffer input with the answer before, from the prompt's history.\n\nWith a prefix argument, go that many answers back.",
        |ed, args| ed.minibuffer_history(args[0].as_int()?),
    );
    def_counted(
        ed,
        "next-history-element",
        "Replace the minibuffer input with the next answer in the prompt's history, or what was typed.\n\nWith a prefix argument, go that many answers on.",
        |ed, args| ed.minibuffer_history(-args[0].as_int()?),
    );
    ed.define_command(
        Command::new(
            "execute-extended-command",
            "Read a command name, with completion, and run it.\n\nA prefix argument given to M-x goes to the command it runs.",
            |ed, args| {
                ed.set_prefix_arg(ed.current_prefix_arg());
                ed.run_interactive(args[0].as_str()?);
                Ok(())
            },
        )
        .param("command", ParamKind::Command, "M-x "),
    );
}

fn bind_defaults(ed: &mut Editor) {
    // The prefix maps Emacs names, so code binds into them as Emacs's
    // Lisp does with (define-key ctl-x-4-map ...).
    for (name, keys) in [
        ("ctl-x-map", "C-x"),
        ("ctl-x-4-map", "C-x 4"),
        ("ctl-x-5-map", "C-x 5"),
        ("ctl-x-x-map", "C-x x"),
        ("narrow-map", "C-x n"),
        ("help-map", "C-h"),
    ] {
        let map = ed.define_keymap(name, None);
        let global = ed.global_map();
        ed.keymaps_mut().bind(global, &Key::parse_seq(keys).expect("valid keys"), crate::keymap::Binding::Keymap(map));
    }
    // The translation maps the command loop reads keys through.
    for name in ["input-decode-map", "key-translation-map"] {
        ed.define_keymap(name, None);
    }
    let global = [
        ("C-f", "forward-char"),
        ("<right>", "forward-char"),
        ("C-b", "backward-char"),
        ("<left>", "backward-char"),
        ("C-n", "next-line"),
        ("<down>", "next-line"),
        ("C-p", "previous-line"),
        ("<up>", "previous-line"),
        ("C-a", "move-beginning-of-line"),
        ("<home>", "move-beginning-of-line"),
        ("C-e", "move-end-of-line"),
        ("<end>", "move-end-of-line"),
        ("M-f", "forward-word"),
        ("M-u", "upcase-word"),
        ("M-l", "downcase-word"),
        ("M-c", "capitalize-word"),
        ("C-x C-u", "upcase-region"),
        ("C-x C-l", "downcase-region"),
        ("M-b", "backward-word"),
        ("M-<", "beginning-of-buffer"),
        ("M->", "end-of-buffer"),
        ("C-v", "scroll-up-command"),
        ("<next>", "scroll-up-command"),
        ("M-v", "scroll-down-command"),
        ("<prior>", "scroll-down-command"),
        ("C-l", "recenter"),
        ("C-x <", "scroll-left"),
        ("C-x >", "scroll-right"),
        ("<wheel-up>", "mwheel-scroll"),
        ("<wheel-down>", "mwheel-scroll"),
        ("RET", "newline"),
        ("TAB", "indent-for-tab-command"),
        ("DEL", "delete-backward-char"),
        ("C-d", "delete-char"),
        ("<delete>", "delete-forward-char"),
        ("C-k", "kill-line"),
        ("M-d", "kill-word"),
        ("M-DEL", "backward-kill-word"),
        ("C-w", "kill-region"),
        ("M-w", "kill-ring-save"),
        ("C-y", "yank"),
        ("C-SPC", "set-mark-command"),
        ("C-@", "set-mark-command"),
        ("C-x C-x", "exchange-point-and-mark"),
        ("C-x h", "mark-whole-buffer"),
        ("C-/", "undo"),
        ("C-_", "undo"),
        ("C-x u", "undo"),
        ("C-?", "undo-redo"),
        ("C-M-_", "undo-redo"),
        ("C-g", "keyboard-quit"),
        ("C-]", "abort-recursive-edit"),
        ("C-M-c", "exit-recursive-edit"),
        ("M-x", "execute-extended-command"),
        ("<f10>", "menu-bar-open"),
        ("C-x C-f", "find-file"),
        ("C-x C-SPC", "pop-global-mark"),
        ("C-x C-@", "pop-global-mark"),
        ("C-x b", "switch-to-buffer"),
        ("C-x k", "kill-buffer"),
        ("C-x x r", "rename-buffer"),
        ("C-x n n", "narrow-to-region"),
        ("C-x n w", "widen"),
    ];
    for (keys, command) in global {
        let map = ed.global_map();
        ed.keymaps_mut().bind_str(map, keys, command);
    }
    // Emacs on macOS follows the Mac convention that Home and End go to the
    // ends of the document (ns-win.el); elsewhere they go to the ends of the line.
    if cfg!(target_os = "macos") {
        let map = ed.global_map();
        ed.keymaps_mut().bind_str(map, "<home>", "beginning-of-buffer");
        ed.keymaps_mut().bind_str(map, "<end>", "end-of-buffer");
    }
    let map = ed.define_keymap(crate::menu::NAVIGATION_MAP, None);
    for (keys, what) in crate::menu::NAVIGATION {
        ed.keymaps_mut().bind_str(map, keys, what);
    }
    ed.define_keymap(crate::minibuffer::MUST_MATCH_MAP, None);
    for keys in ["RET", "C-j", "C-m"] {
        let keys = Key::parse_seq(keys).expect("valid keys");
        ed.bind_key_in(crate::minibuffer::MUST_MATCH_MAP, &keys, "minibuffer-complete-and-exit").expect("the keymap exists");
    }
    for (keys, command) in [
        ("RET", "exit-minibuffer"),
        ("C-j", "exit-minibuffer"),
        ("TAB", "minibuffer-complete"),
        ("C-g", "keyboard-quit"),
        ("M-p", "previous-history-element"),
        ("M-n", "next-history-element"),
        ("<up>", "previous-history-element"),
        ("<down>", "next-history-element"),
    ] {
        let map = ed.minibuffer_map;
        ed.keymaps_mut().bind_str(map, keys, command);
    }
}
