//! Editing, the kill ring, the mark, prefix arguments and keyboard macros.

use crate::*;
use crate::natives::{natives, ArgText, Opt, Prefix, Rest};

natives! {
    /// Run a command as keys would (Emacs's call-interactively): prompting in
    /// the minibuffer for its arguments, which it gets once they are read.
    #[ts = "(name: CommandName | DefinedCommand): void"]
    pub fn callInteractively(ed, name: String) {
        if ed.command(&name).is_none() {
            return Err(Error::new(format!("No such command: {name}")));
        }
        ed.call_interactively(&name)
    }

    fn message(ed, text: String, log: Opt<bool>) {
        if log.0 == Some(false) {
            ed.message_unlogged(text);
        } else {
            ed.message(text);
        }
        Ok(())
    }

    fn insert(ed, text: String) {
        ed.insert(&text)
    }

    /// TypeScript as the script evalTypescript runs, once the agent allows
    /// running code: its types erased, a quit check in each loop, and in a
    /// block of its own, so its const and let clash with nothing else's.
    fn typescriptToScript(ed, source: String) -> String {
        ed.check_permission("run TypeScript")?;
        Ok(format!("\"use strict\";void 0;{{{}\n}}", strip_types("evalTypescript", source)?))
    }

    /// Join the running command's undo step to the one before, as Emacs's
    /// undo-auto-amalgamate does when self-insert-command runs, if the command
    /// before was this one and did the same. For commands that insert newlines
    /// as newline does.
    pub fn undoAutoAmalgamate(ed) {
        ed.undo_auto_amalgamate();
        Ok(())
    }

    /// Point's column as Emacs's current-column counts it: tabs to tab stops,
    /// wide characters as two, and text hidden without an ellipsis as none.
    pub fn currentColumn(ed) -> usize {
        Ok(ed.current_column())
    }

    fn moveToColumn(ed, column: usize) -> usize {
        Ok(ed.move_to_column(column))
    }

    /// Point, as a character offset from the start of the buffer, counting from 0.
    pub fn point(ed) -> usize {
        Ok(ed.buffer().point())
    }

    /// Move point to a character offset.
    pub fn gotoChar(ed, position: usize) {
        ed.buffer_mut().set_point(position);
        Ok(())
    }

    fn bufferText(ed, start: Opt<usize>, end: Opt<usize>) -> String {
        let b = ed.buffer();
        let end = end.0.unwrap_or(b.len()).min(b.len());
        let start = start.0.unwrap_or(0).min(end);
        Ok(b.slice(start..end))
    }

    /// Delete the text from start up to end and return it.
    pub fn deleteRegion(ed, start: usize, end: usize) -> String {
        ed.delete_region(start, end)
    }

    fn bufferName(ed) -> String {
        Ok(ed.buffer().name.clone())
    }

    /// The mark, or undefined if it is not set.
    pub fn mark(ed) -> Option<usize> {
        Ok(ed.buffer().mark())
    }

    /// The key that ran the current command, in Emacs notation such as "M-5" (Emacs's last-command-event).
    pub fn lastKey(ed) -> Option<String> {
        Ok(ed.last_key().map(|k| k.to_string()))
    }

    fn currentKill(ed, n: Opt<i64>) -> String {
        ed.current_kill(n.0.unwrap_or(0))
    }

    /// The kills, newest first, as the kill-ring variable lists them.
    pub fn killRing(ed) -> Vec<String> {
        Ok(ed.kill_ring().into_iter().rev().collect::<Vec<_>>())
    }

    fn setKillRingYankPointer(ed, index: usize) {
        ed.set_kill_ring_yank_pointer(index);
        Ok(())
    }

    /// Take the newest kill off the kill ring and return it, as (pop kill-ring) does.
    pub fn popKill(ed) -> Option<String> {
        Ok(ed.pop_kill())
    }

    /// The command that ran before this one (Emacs's last-command).
    pub fn lastCommand(ed) -> Option<String> {
        Ok(ed.last_command().map(str::to_string))
    }

    fn setLastCommand(ed, name: Option<String>) {
        ed.set_last_command(name.as_deref());
        Ok(())
    }

    /// Make the running command count as another one afterwards (Emacs's
    /// this-command). yank-pop sets "yank", so that M-y can follow M-y.
    #[ts = "(name: CommandName | DefinedCommand): void"]
    pub fn setThisCommand(ed, name: String) {
        ed.set_this_command(&name);
        Ok(())
    }

    /// Put the mark at a position without activating the region, or remove it with null.
    #[ts = "(position: number | null): void"]
    pub fn setMark(ed, pos: Option<usize>) {
        ed.buffer_mut().set_mark(pos);
        Ok(())
    }

    fn pushMark(ed, pos: usize, activate: bool) {
        ed.push_mark(pos, activate);
        Ok(())
    }

    /// Activate the region between the mark and point, if there is a mark.
    pub fn activateMark(ed) {
        ed.buffer_mut().activate_region();
        Ok(())
    }

    /// Hide the region, leaving the mark where it is.
    pub fn deactivateMark(ed) {
        ed.buffer_mut().deactivate_mark();
        Ok(())
    }

    fn takeChanged(ed) -> bool {
        Ok(ed.buffer_mut().take_changed())
    }

    fn setChanged(ed, changed: bool) {
        ed.buffer_mut().set_changed(changed);
        Ok(())
    }

    /// Start recording typed keys into a keyboard macro (Emacs's
    /// start-kbd-macro). With `append`, go on from the last macro, running
    /// it once more first unless `noExec`.
    pub fn startKbdMacro(ed, append: Opt<bool>, no_exec: Opt<bool>) {
        if append.0 == Some(true) { ed.start_kbd_macro_appending(no_exec.0 == Some(true)) } else { ed.start_kbd_macro() }
    }

    /// Finish the keyboard macro, leaving out the keys that ended it (Emacs's end-kbd-macro).
    pub fn endKbdMacro(ed) {
        ed.end_kbd_macro()
    }

    /// Run KEYS, a key sequence in Emacs notation such as "C-x u", as a
    /// keyboard macro, COUNT times (once if left out, until an error if 0),
    /// as Emacs's execute-kbd-macro: each command runs as if typed, with its
    /// undo boundary, so a package's tests drive the editor with it.
    pub fn executeKbdMacro(ed, keys: String, count: Opt<i64>) {
        ed.execute_kbd_macro(&keys, count.0.unwrap_or(1))
    }

    fn callLastKbdMacro(ed, count: i64) {
        ed.call_last_kbd_macro(count)
    }

    /// Whether a keyboard macro is being recorded.
    pub fn definingKbdMacro(ed) -> bool {
        Ok(ed.defining_kbd_macro())
    }

    /// Whether a keyboard macro is running.
    pub fn executingKbdMacro(ed) -> bool {
        Ok(ed.executing_kbd_macro())
    }

    /// The tree-sitter primitives, as treesit.c: one native, by the Lisp
    /// name, for the prelude's wrappers.
    fn treesitPrimitive(ed, name: String, args: Rest<EditorValue>) -> EditorValue {
        ed.treesit_primitive(&name, &args.0)
    }

    /// The coding and charset primitives, as coding.c and charset.c, likewise.
    fn codingPrimitive(ed, name: String, args: Rest<EditorValue>) -> EditorValue {
        ed.coding_primitive(&name, &args.0)
    }

    fn insertBeforeMarkers(ed, text: e8_core::Text) {
        ed.insert_text_with(&text, e8_core::Insertion::BeforeMarkers)
    }

    fn insertAndInherit(ed, text: e8_core::Text) {
        ed.insert_text_with(&text, e8_core::Insertion::Inherit)
    }

    /// The prefix argument the running command was given (Emacs's current-prefix-arg).
    pub fn prefixArg(ed) -> Prefix {
        let arg = ed.current_prefix_arg();
        Ok(Prefix(arg))
    }

    /// Give the next command a prefix argument, as C-u does (Emacs's prefix-arg).
    /// A command that leaves one does not count as the last command.
    pub fn setPrefixArg(ed, arg: Prefix) {
        let arg = arg.0;
        ed.set_prefix_arg(arg);
        Ok(())
    }

    fn setTransientMap(ed, keymap: EditorValue) {
        let map = ed.keymap_of(&keymap)?;
        ed.set_transient_map(map);
        Ok(())
    }

    fn currentKillText(ed, n: Opt<i64>) -> EditorValue {
        let text = ed.current_kill_text(n.0.unwrap_or(0))?;
        Ok(EditorValue::Text(text))
    }

    /// Run the last command again, with the same arguments and key, and with
    /// `arg` as its prefix argument if given (Emacs's last-repeatable-command).
    #[ts = "(arg?: PrefixArg): void"]
    pub fn repeatLastCommand(ed, arg: Prefix) {
        let arg = arg.0;
        ed.repeat_last_command(arg)
    }

    fn bindKey(ed, keys: String, binding: EditorValue, keymap: EditorValue) {
        let keymap = if matches!(keymap, EditorValue::Null) { EditorValue::Str("global-map".into()) } else { keymap };
        let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
        ed.define_key(&keymap, &parsed, Some(&binding))
    }

    /// Run a command with its arguments. Throws if the command fails.
    #[ts = "<N extends CommandName | DefinedCommand>(name: N, ...args: N extends CommandName ? Commands[N] : Value[]): void"]
    pub fn call(ed, name: String, args: Rest<ArgText>) {
        let args = command_args(ed, &name, args.0)?;
        ed.call(&name, args)
    }

    /// Run a command with a prefix argument and its arguments, as if typed
    /// after C-u or M-5. Pass prefixArg() to hand on the running command's.
    #[ts = "<N extends CommandName | DefinedCommand>(prefix: PrefixArg, name: N, ...args: N extends CommandName ? Commands[N] : Value[]): void"]
    pub fn callWithPrefix(ed, prefix: Prefix, name: String, args: Rest<ArgText>) {
        let args = command_args(ed, &name, args.0)?;
        ed.call_with_prefix(&name, args, prefix.0)
    }

    fn insertForYank(ed, text: e8_core::Text) {
        ed.insert_for_yank(text)
    }

    /// A character in Emacs's notation, as text-char-description: a control character as ^A, ^? for DEL, any other as itself.
    #[ts = "(character: number): string"]
    pub fn textCharDescription(_ed, character: EditorValue) -> String {
        let n = match &character {
            EditorValue::Number(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= 4194303.0 => *n as u32,
            other => return Err(e8_core::xfaces::wrong_type("characterp", other)),
        };
        Ok(match n {
            0..=31 => format!("^{}", char::from_u32(n + 64).unwrap_or('?')),
            127 => "^?".to_string(),
            // A raw byte, as Emacs's eight-bit characters.
            0x3FFF80.. => e8_core::coding::raw_byte_char((n - 0x3FFF00) as u8).to_string(),
            _ => char::from_u32(n).map(String::from).unwrap_or_default(),
        })
    }

    /// Send text to the terminal as it is, as send-string-to-terminal: in batch to standard output; an error on a graphical frame.
    #[ts = "(string: string, terminal?: Terminal | Frame | null): undefined"]
    pub fn sendStringToTerminal(ed, text: EditorValue, _terminal: Opt<EditorValue>) -> Option<bool> {
        let s = match &text {
            EditorValue::Str(s) => s.clone(),
            EditorValue::Text(t) => t.string.clone(),
            other => return Err(e8_core::xfaces::wrong_type("stringp", other)),
        };
        ed.send_string_to_terminal(&s)?;
        Ok(None)
    }

    /// Make thisCommandKeys give the keys a string's characters are, as Lisp's set--this-command-keys takes them.
    #[ts = "(keys: string): undefined"]
    pub fn setThisCommandKeysFromChars(ed, keys: EditorValue) -> Option<bool> {
        let s = match &keys {
            EditorValue::Str(s) => s.clone(),
            other => return Err(e8_core::xfaces::wrong_type("stringp", other)),
        };
        ed.set_this_command_keys_from_chars(&s);
        Ok(None)
    }
}
