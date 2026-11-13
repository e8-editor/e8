//! Variables, hooks, keymaps, modes and help.

use crate::*;
use crate::natives::{natives, Field, Fields, Opt, Record};

natives! {
    /// Give the current buffer its own value, starting from the one it sees now.
    #[ts = "(name: VariableName | (string & {})): void"]
    pub fn makeLocalVariable(ed, name: String) {
        ed.make_local_variable(&name);
        Ok(())
    }

    /// Remove the current buffer's own value, so it sees the global one again.
    #[ts = "(name: VariableName | (string & {})): void"]
    pub fn killLocalVariable(ed, name: String) {
        ed.kill_local_variable(&name);
        Ok(())
    }

    /// Whether the current buffer has its own value.
    #[ts = "(name: VariableName | (string & {})): boolean"]
    pub fn isLocalVariable(ed, name: String) -> bool {
        Ok(ed.is_local_variable(&name))
    }

    #[ts = "(name: VariableName | (string & {})): string | undefined"]
    pub fn variableDocumentation(ed, name: String) -> Option<String> {
        Ok(ed.variable_definition(&name).map(|v| v.doc.clone()))
    }

    /// The file that defined a variable, if a script did.
    #[ts = "(name: VariableName | (string & {})): string | undefined"]
    pub fn variableSource(ed, name: String) -> Option<String> {
        Ok(ed.variable_definition(&name).and_then(|v| v.source.clone()))
    }

    /// Whether a variable is a hook. A hook's value is the names of its functions.
    pub fn isHook(ed, name: String) -> bool {
        Ok(ed.variable_definition(&name).is_some_and(|v| v.hook))
    }

    /// Remove all of the current buffer's own values, hooks and keymap, as a new major mode does first.
    pub fn killAllLocalVariables(ed) {
        ed.kill_all_local_variables()
    }

    fn defineHook(ed, name: String, doc: String) {
        ed.define_hook(&name, &doc);
        Ok(())
    }

    fn registerMinorMode(ed, name: String, lighter: String, keymap: String, global: bool) {
        ed.register_minor_mode(MinorMode { name, lighter, keymap: Some(keymap), global });
        Ok(())
    }

    /// The minor modes on in the current buffer.
    pub fn enabledMinorModes(ed) -> Vec<String> {
        Ok(ed.enabled_minor_modes())
    }

    /// Buffers as objects, by the ids they keep when renamed.
    fn bufferIdOf(ed, name: Opt<String>) -> Option<f64> {
        Ok(match name.0 {
            Some(name) => ed.find_buffer(&name).map(|i| ed.buffers()[i].id() as f64),
            None => Some(ed.buffer().id() as f64),
        })
    }

    fn bufferNameOf(ed, id: f64) -> Option<String> {
        Ok(ed.buffer_with_id(id as u64).map(|i| ed.buffers()[i].name.clone()))
    }

    fn advised(ed, symbol: String) -> bool {
        Ok(ed.advised(&symbol))
    }

    fn fmakunbound(ed, name: String) {
        ed.fmakunbound(&name);
        Ok(())
    }

    fn fboundp(ed, name: String) -> bool {
        Ok(ed.fboundp(&name))
    }

    /// A command's documentation, or undefined if there is no such command.
    #[ts = "(name: CommandName | DefinedCommand | (string & {})): string | undefined"]
    pub fn documentation(ed, name: String) -> Option<String> {
        Ok(ed.command(&name).map(|c| c.doc.clone()))
    }

    /// The file that defined a command, if a script did.
    #[ts = "(name: CommandName | DefinedCommand | (string & {})): string | undefined"]
    pub fn commandSource(ed, name: String) -> Option<String> {
        Ok(ed.command(&name).and_then(|c| c.source.clone()))
    }

    /// Show text in the read-only *Help* buffer.
    pub fn showHelp(ed, text: String) {
        ed.show_help(&text);
        Ok(())
    }

    /// What describe-command shows of a command besides its documentation: its
    /// parameters, each with its kind, a description of the kind and its
    /// prompt, the file that defined it, whether Shift selects as it moves,
    /// and the command it is an alias of; undefined if there is no such command.
    #[ts = "(name: CommandName | DefinedCommand | (string & {})): { doc: string; params: { name: string; kind: ParamKind; description: string; prompt: string }[]; source?: string; shiftSelect: boolean; aliasOf?: string } | undefined"]
    pub fn commandInfo(ed, name: String) -> Option<Record> {
        Ok(ed.command(&name).map(|c| {
            let params: Vec<Record> = c
                .params
                .iter()
                .map(|p| {
                    Record::new()
                        .with("name", p.name.clone())
                        .with("kind", p.kind.name())
                        .with("description", p.kind.describe())
                        .with("prompt", p.prompt.clone())
                })
                .collect();
            Record::new()
                .with("doc", c.doc.clone())
                .with("params", params)
                .with("source", c.source.clone())
                .with("shiftSelect", c.shift_select)
                .with("aliasOf", c.alias_of.clone())
        }))
    }

    /// Every binding of a keymap and its parents as [keys, command], in key
    /// order through its prefix maps, a parent's that the keymap's own shadow
    /// left out; a string or vector binding is "Keyboard Macro", as
    /// describe-bindings lists it.
    fn keymapBindings(ed, keymap: EditorValue) -> Vec<Vec<String>> {
        let map = ed.keymap_of(&keymap)?;
        let mut out: Vec<(Vec<Key>, String)> = Vec::new();
        for m in std::iter::successors(Some(map), |&m| ed.keymaps().parent(m)).take(32) {
            for (keys, command) in ed.keymaps().bindings(m) {
                if !out.iter().any(|(k, _)| *k == keys) {
                    out.push((keys, command));
                }
            }
        }
        Ok(out.into_iter().map(|(k, c)| vec![e8_core::format_keys(&k), c]).collect())
    }

    /// The names of all variables, as all-completions over obarray with boundp.
    pub fn variableNames(ed) -> Vec<String> {
        Ok(ed.variables().map(|v| v.name.clone()).collect())
    }

    /// The file the current buffer visits, if any.
    pub fn bufferFileName(ed) -> Option<String> {
        Ok(ed.buffer().path.as_ref().map(|p| p.display().to_string()))
    }

    /// How deep in recursive edits and minibuffers the editor is, as recursion-depth.
    pub fn recursionDepth(ed) -> usize {
        Ok(ed.recursion_depth())
    }

    fn thisCommandKeys(ed) -> Vec<String> {
        Ok(ed.this_command_keys().iter().map(|k| k.to_string()).collect::<Vec<_>>())
    }

    fn lossageSize(ed, size: Opt<usize>) -> usize {
        if let Some(size) = size.0 {
            ed.set_lossage_size(size)?;
        }
        Ok(ed.lossage_size())
    }

    fn inputPendingP(ed) -> bool {
        Ok(ed.input_pending_p())
    }

    /// Forget keys waiting to be read, as discard-input.
    pub fn discardInput(ed) {
        ed.discard_input();
        Ok(())
    }

    /// Where the minibuffer's prompt ends and its input starts, as
    /// minibuffer-prompt-end: the prompt is read-only text at the start of
    /// the minibuffer, and point is kept after it.
    pub fn minibufferPromptEnd(ed) -> usize {
        Ok(ed.minibuffer_prompt_end())
    }

    /// The minibuffer's input, after its prompt, as minibuffer-contents.
    pub fn minibufferContents(ed) -> String {
        Ok(ed.minibuffer_input())
    }

    fn cacheAllSortedCompletions(ed, comps: Vec<String>) {
        ed.cache_all_sorted_completions(comps);
        Ok(())
    }

    /// The first key sequence that runs a command in the selected window's
    /// buffer, as Emacs's where-is-internal with FIRSTONLY, such as "C-x C-f".
    pub fn whereIs(ed, command: String) -> Option<String> {
        Ok(ed.where_is(&command).map(|keys| e8_core::format_keys(&keys)))
    }

    /// Every key sequence that runs a command in the selected window's
    /// buffer, as where-is-internal: those in its modes' keymaps first, then
    /// the global map's, and none that another binding shadows.
    pub fn whereIsInternal(ed, command: String) -> Vec<String> {
        Ok(ed.where_is_all(&command).iter().map(|keys| e8_core::format_keys(keys)).collect())
    }

    fn frameSize(ed) -> Vec<f64> {
        let total = ed.frame_lines();
        Ok(vec![ed.frame_cells().0 as f64, total as f64, ed.max_mini_window_lines(total) as f64])
    }

    /// Stop a timer, as Emacs's cancel-timer.
    pub fn cancelTimer(ed, id: f64) {
        ed.cancel_timer(id as u64);
        Ok(())
    }

    /// Whether a file name names a directory, as Emacs's file-directory-p.
    pub fn fileDirectoryP(ed, file: String) -> bool {
        ed.file_directory_p(&file)
    }

    /// The names of all buffers, in the order Emacs's buffer-list gives them.
    pub fn bufferList(ed) -> Vec<String> {
        Ok(ed.buffer_list().into_iter().map(|i| ed.buffers()[i].name.clone()).collect::<Vec<_>>())
    }

    /// Write the current buffer to its file, as Emacs's basic-save-buffer-2:
    /// the first save keeps the old file as name~, the text is written in
    /// buffer-file-coding-system, and the buffer is then unmodified and its
    /// auto-save file deleted. Asks nothing; save-buffer does the asking.
    pub fn writeVisitedFile(ed) {
        ed.write_visited_file()
    }

    /// Replace the current buffer's text with its file's, keeping point where it can, and mark it unmodified.
    pub fn revertToVisitedFile(ed) {
        ed.revert_to_visited_file()
    }

    /// Replace the current buffer's text with its auto-save file's, leaving it modified.
    pub fn recoverFromAutoSave(ed) {
        ed.recover_from_auto_save()
    }

    /// Whether the visited file changed on disk since it was visited or saved, as not verify-visited-file-modtime.
    pub fn visitedFileChanged(ed) -> bool {
        Ok(ed.buffer().visited_file_changed())
    }

    fn setVisitedFileName(ed, file: Option<String>, along: Opt<bool>) {
        match file {
        Some(file) => ed.set_visited_file_name_along(&ed.expand_file_name(&file), along.0 == Some(true)),
        None => {
            ed.forget_visited_file();
            Ok(())
        }
        }
    }

    fn expandFileName(ed, file: String, dir: Opt<String>) -> String {
        let dir = match dir.0 {
            Some(dir) => ed.expand_file_name(&dir),
            None => ed.default_directory(),
        };
        Ok(e8_core::expand_file_name_string(&file, &dir))
    }

    fn directoryFiles(ed, dir: String, full: Opt<bool>, pattern: Opt<Option<String>>, nosort: Opt<bool>, count: Opt<Option<usize>>) -> Vec<String> {
        ed.directory_files(&dir, full.0.unwrap_or(false), pattern.0.flatten().as_deref(), nosort.0.unwrap_or(false), count.0.flatten())
    }

    fn copyFile(ed, from: String, to: String, ok: bool, keep_time: bool) -> String {
        let to_dir = to.ends_with('/');
        ed.copy_file(&ed.expand_file_name(&from), &ed.expand_file_name(&to), to_dir, ok, keep_time).map(|p| p.display().to_string())
    }

    fn copyDirectory(ed, from: String, to: String, keep_time: bool) -> String {
        ed.copy_directory(&ed.expand_file_name(&from), &ed.expand_file_name(&to), keep_time).map(|p| p.display().to_string())
    }

    fn renameFile(ed, from: String, to: String, ok: bool) -> String {
        let to_dir = to.ends_with('/');
        ed.rename_file(&ed.expand_file_name(&from), &ed.expand_file_name(&to), to_dir, ok).map(|p| p.display().to_string())
    }

    fn deleteFile(ed, file: String, trash: bool) {
        ed.delete_file(&ed.expand_file_name(&file), trash)
    }

    fn makeDirectory(ed, dir: String, parents: bool) {
        ed.make_directory(&ed.expand_file_name(&dir), parents)
    }

    fn deleteDirectory(ed, dir: String, recursive: bool, trash: bool) {
        ed.delete_directory(&ed.expand_file_name(&dir), recursive, trash)
    }

    /// A file's text, read as UTF-8.
    pub fn readTextFile(ed, file: String) -> String {
        let path = ed.expand_file_name(&file);
        fs::read_to_string(&path).map_err(|e| e8_core::fileops::file_error("Opening input file", &e, &[&path]))
    }

    fn writeTextFile(ed, file: String, text: String, mode: Option<u32>) {
        ed.write_text_file_with_mode(&ed.expand_file_name(&file), &text, mode)
    }

    fn projectFiles(ed, root: String, ignores: Vec<String>) -> Vec<String> {
        let root = ed.expand_file_name(&root);
        // Asking Git runs a program, which waits for the user's approval
        // while an agent acts, as every program does.
        ed.check_permission("run git ls-files")?;
        let files = e8_core::fileops::vc_files(&root).unwrap_or_else(|| e8_core::fileops::files_in_directory(&root, &ignores));
        Ok(files.iter().map(|p| p.display().to_string()).collect::<Vec<_>>())
    }

    fn stringMatch(ed, pattern: String, text: String, fold: bool, start: Opt<usize>) -> Option<f64> {
        let found = ed.string_match(&pattern, &text, start.0.unwrap_or(0), fold)?;
        let at = found.as_ref().map(|m| m.start as f64);
        if found.is_some() {
            ed.set_match_data(found);
        }
        Ok(at)
    }

    /// The messages shown, oldest first, as *Messages* logs them: one shown again straight after itself as "Mark set [2 times]".
    pub fn messages(ed) -> Vec<String> {
        Ok(ed.messages())
    }

    /// Put text in the kill ring as a kill of its own, as Emacs's kill-new.
    pub fn killNew(ed, text: String) {
        ed.kill_new(&text);
        Ok(())
    }

    pub fn fileExists(ed, file: String) -> bool {
        ed.file_exists_p(&file)
    }

    fn doAutoSave(ed, quiet: bool) -> bool {
        Ok(ed.do_auto_save(quiet))
    }

    /// Turn auto-saving on or off for the current buffer, which must visit a file.
    pub fn setAutoSave(ed, on: bool) {
        ed.set_auto_save(on);
        Ok(())
    }

    pub fn autoSaving(ed) -> bool {
        Ok(ed.auto_saving())
    }

    /// Ask the front end to exit, as Emacs's kill-emacs, the program
    /// exiting with `status`, 0 if it is left out.
    pub fn killEmacs(ed, status: Opt<f64>) {
        ed.kill_emacs_with_status(status.0.unwrap_or(0.0) as i32)
    }

    pub fn commandExists(ed, name: String) -> bool {
        Ok(ed.command(&name).is_some())
    }

    /// The command that is running (Emacs's this-command). In pre-command-hook,
    /// the command about to run; setThisCommand changes which one runs.
    pub fn thisCommand(ed) -> Option<String> {
        Ok(ed.this_command().map(str::to_string))
    }

    /// Whether the region is active: shown, and what region commands act on (Emacs's region-active-p).
    pub fn regionActive(ed) -> bool {
        Ok(ed.buffer().is_mark_active())
    }

    /// Whether the running command was started by keys or M-x rather than called from code.
    pub fn calledInteractively(ed) -> bool {
        Ok(ed.called_interactively())
    }

    fn defineVariable(ed, name: String, doc: String, value: EditorValue, local: bool) {
        let mut var = Variable::new(&name, &doc, value);
        var.local = local;
        var.source = LOADING.with_borrow(|files| files.last().cloned());
        ed.define_variable(var);
        Ok(())
    }

    /// The value in the current buffer, or undefined if the variable is not defined.
    #[ts = "(name: VariableName | (string & {})): Value | undefined"]
    pub fn variable(ed, name: String) -> Option<EditorValue> {
        Ok(ed.variable(&name))
    }

    /// Set a variable (Emacs's setq): the current buffer's own value if it has
    /// one or the variable is buffer-local, otherwise the global value.
    #[ts = "(name: VariableName | (string & {}), value: Value): void"]
    pub fn setVariable(ed, name: String, value: EditorValue) {
        ed.set_variable(&name, value);
        Ok(())
    }

    /// The global value, which buffers without their own value see.
    #[ts = "(name: VariableName | (string & {})): Value | undefined"]
    pub fn defaultValue(ed, name: String) -> Option<EditorValue> {
        Ok(ed.default_value(&name))
    }

    /// Set the global value.
    #[ts = "(name: VariableName | (string & {}), value: Value): void"]
    pub fn setDefault(ed, name: String, value: EditorValue) {
        ed.set_default(&name, value);
        Ok(())
    }

    fn removeHook(ed, hook: String, run: e8_core::Function, local: bool) {
        let function = run;
        ed.remove_hook_function(&hook, &function, local);
        Ok(())
    }

    fn runHooks(ed, hook: String, args: Opt<Vec<EditorValue>>) {
        let args = args.0.unwrap_or_default();
        ed.run_hook_with_args(&hook, &args)
    }

    fn defineKeymap(ed, name: String, parent: Opt<Option<String>>) -> EditorValue {
        let map = ed.define_keymap(&name, parent.0.flatten().as_deref());
        Ok(EditorValue::Keymap(map))
    }

    fn keymapUnset(ed, keymap: EditorValue, keys: String, remove: Opt<bool>) {
        let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
        let nil = EditorValue::Null;
        ed.define_key(&keymap, &parsed, if remove.0 == Some(true) { None } else { Some(&nil) })
    }

    /// The keymaps active now, in the order keys are looked up, as
    /// current-active-maps: a transient map, an overriding one, the
    /// minibuffer's while a prompt is open, text's at point, the minor modes',
    /// the major mode's, and the global map.
    #[ts = "(): Keymap[]"]
    pub fn currentActiveMaps(ed) -> EditorValue {
        let maps = ed.current_active_maps();
        Ok(EditorValue::List(maps.into_iter().map(EditorValue::Keymap).collect()))
    }

    /// Functions named for code to call, as Emacs's defun, funcall and
    /// fboundp; a function is a value, so a variable or property can hold one.
    /// Notes that a module's body starts or ends running, for what it defines.
    fn loadingFile(ed, file: String, entering: bool) {
        let _ = ed;
        crate::note_loading(&file, entering);
        Ok(())
    }

    fn defun(ed, name: String, f: e8_core::Function) {
        let function = f;
        let function = function.with_name(&name);
        ed.defun(&name, function);
        // Defined again with no file, as at M-:, it keeps the file it had, as load-history does.
        if let Some(file) = crate::LOADING.with_borrow(|files| files.last().cloned()) {
            ed.set_function_source(&name, Some(file));
        }
        Ok(())
    }

    /// The text from start to end with its properties, as Emacs's buffer-substring.
    #[ts = "(start: number, end: number): PropertizedString"]
    pub fn bufferSubstring(ed, start: usize, end: usize) -> EditorValue {
        let text = ed.buffer().substring(start.min(end)..start.max(end));
        Ok(EditorValue::Text(text))
    }

    fn put(ed, symbol: String, property: String, value: EditorValue) {
        ed.put(&symbol, &property, value);
        Ok(())
    }

    fn adviceRemove(ed, symbol: String, f: EditorValue) {
        ed.advice_remove(&symbol, &f);
        Ok(())
    }

    fn adviceMemberP(ed, f: EditorValue, symbol: String) -> bool {
        Ok(ed.advice_member_p(&f, &symbol))
    }

    fn formatModeLine(ed, format: EditorValue) -> String {
        Ok(ed.format_mode_line(&format)?.into_iter().map(|s| s.text).collect::<String>())
    }

    fn defalias(ed, name: String, definition: EditorValue) {
        ed.defalias(&name, &definition)?;
        if let Some(file) = crate::LOADING.with_borrow(|files| files.last().cloned()) {
            ed.set_function_source(&name, Some(file));
        }
        Ok(())
    }

    fn funcall(ed, f: EditorValue, args: Vec<EditorValue>) -> EditorValue {
        ed.funcall(&f, &args)
    }

    fn composeLocalMap(ed, keymap: EditorValue) {
        ed.compose_local_map(&keymap)
    }

    fn addHook(ed, hook: String, function: e8_core::Function, depth: f64, local: bool) -> f64 {
        Ok(ed.add_hook_function(&hook, function, depth, local) as f64)
    }

    fn runHookUntil(ed, hook: String, args: Vec<EditorValue>, success: bool) -> EditorValue {
        if success {
            ed.run_hook_with_args_until_success(&hook, &args)
        } else {
            Ok(EditorValue::Bool(ed.run_hook_with_args_until_failure(&hook, &args)?))
        }
    }

    /// The current buffer's local map, the major mode's, as current-local-map.
    #[ts = "(): Keymap | undefined"]
    pub fn currentLocalMap(ed) -> Option<EditorValue> {
        Ok(ed.current_local_map().map(EditorValue::Keymap))
    }

    /// The global keymap now, as current-global-map: global-map unless useGlobalMap changed it.
    #[ts = "(): Keymap"]
    pub fn currentGlobalMap(ed) -> EditorValue {
        Ok(EditorValue::Keymap(ed.global_map()))
    }

    /// Make a keymap the global one, as use-global-map.
    #[ts = "(keymap: Keymap | (string & {})): void"]
    pub fn useGlobalMap(ed, keymap: EditorValue) {
        ed.use_global_map(&keymap)
    }

    /// A copy of a keymap, as copy-keymap: the prefix maps it binds are
    /// copied too, but for those a variable names, such as ctl-x-4-map.
    #[ts = "(keymap: Keymap | (string & {})): Keymap"]
    pub fn copyKeymap(ed, keymap: EditorValue) -> EditorValue {
        Ok(EditorValue::Keymap(ed.copy_keymap(&keymap)?))
    }

    /// The keymaps reachable from a keymap through prefix keys, each with
    /// the keys that reach it, the keymap itself first, as accessible-keymaps;
    /// with a prefix, only those under it.
    #[ts = "(keymap: Keymap | (string & {}), prefix?: string): [string, Keymap][]"]
    pub fn accessibleKeymaps(ed, keymap: EditorValue, prefix: Opt<String>) -> EditorValue {
        let map = ed.keymap_of(&keymap)?;
        let prefix = match prefix.0 {
            Some(p) if !p.is_empty() => Key::parse_seq(&p).ok_or_else(|| Error::new(format!("Invalid key sequence: {p:?}")))?,
            _ => Vec::new(),
        };
        let found = ed.keymaps().accessible(map, &prefix);
        Ok(EditorValue::List(
            found
                .into_iter()
                .map(|(keys, m)| EditorValue::List(vec![EditorValue::Str(e8_core::format_keys(&keys)), EditorValue::Keymap(m)]))
                .collect(),
        ))
    }

    /// The minor modes on whose keymaps bind keys, each with the binding,
    /// in the order keys are looked up, as minor-mode-key-binding.
    #[ts = "(keys: string): [string, string | Keymap | string[]][]"]
    pub fn minorModeKeyBinding(ed, keys: String) -> EditorValue {
        let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
        Ok(EditorValue::List(
            ed.minor_mode_key_binding(&parsed)
                .into_iter()
                .filter_map(|(mode, b)| binding_value(b).map(|v| EditorValue::List(vec![EditorValue::Str(mode), v])))
                .collect(),
        ))
    }

    /// The keymaps of the minor modes on in the current buffer, in the order
    /// keys are looked up in them, as current-minor-mode-maps.
    #[ts = "(): Keymap[]"]
    pub fn currentMinorModeMaps(ed) -> EditorValue {
        Ok(EditorValue::List(ed.current_minor_mode_maps().into_iter().map(EditorValue::Keymap).collect()))
    }

    fn makeSparseKeymap(ed, parent: EditorValue) -> EditorValue {
        let parent = keymap_or_none(ed, &parent)?;
        Ok(EditorValue::Keymap(ed.keymaps_mut().make(parent)))
    }

    fn keymapParent(ed, keymap: EditorValue) -> Option<EditorValue> {
        Ok(ed.keymaps().parent(ed.keymap_of(&keymap)?).map(EditorValue::Keymap))
    }

    fn setKeymapParent(ed, keymap: EditorValue, parent: EditorValue) {
        let map = ed.keymap_of(&keymap)?;
        let parent = keymap_or_none(ed, &parent)?;
        ed.keymaps_mut().set_parent(map, parent);
        Ok(())
    }

    fn lookupKey(ed, keymap: EditorValue, keys: String) -> Option<EditorValue> {
        let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
        Ok(ed.keymaps().binding_of(ed.keymap_of(&keymap)?, &parsed).and_then(binding_value))
    }

    fn useLocalMap(ed, keymap: EditorValue) {
        ed.use_local_map(Some(&keymap).filter(|k| !matches!(k, EditorValue::Null)))
    }

    fn insertText(ed, text: EditorValue) {
        let EditorValue::Text(text) = text else {
            return Err(Error::signal("wrong-type-argument", "insertText takes a propertized string", Vec::new()));
        };
        ed.insert_text(&text)
    }

    fn get(ed, symbol: String, property: String) -> Option<EditorValue> {
        Ok(ed.get(&symbol, &property).cloned())
    }

    /// Advice, as nadvice.el's advice-add: calls by name go through it.
    fn adviceAdd(ed, symbol: String, how: String, function: e8_core::Function, name: Option<String>, depth: Option<f64>) {
        let Some(how) = e8_core::AdviceHow::from_name(&how) else {
            return Err(Error::signal("wrong-type-argument", format!("Unknown advice kind {how:?}"), Vec::new()));
        };
        ed.advice_add(&symbol, how, function, name.as_deref(), depth.unwrap_or(0.0));
        Ok(())
    }

    fn symbolFunction(ed, name: String) -> Option<EditorValue> {
        Ok(ed.symbol_function(&name).map(EditorValue::Function))
    }

    /// Questions, reading keys and recursive edits wait for their answer, as
    /// Emacs's do, the command loop running meanwhile (ADR 0053).
    fn ask(ed, kind: String, question: String, choices: Vec<String>) -> EditorValue {
        waiting(|| {
            Ok(match kind.as_str() {
                "yes-or-no" => EditorValue::Bool(ed.yes_or_no_p(&question)?),
                "y-or-n" => EditorValue::Bool(ed.y_or_n_p(&question)?),
                "answer" => EditorValue::Str(ed.read_answer(&question, &choices.iter().map(String::as_str).collect::<Vec<_>>())?),
                _ => EditorValue::Str(ed.read_char_choice(&question, &choices.iter().filter_map(|c| c.chars().next()).collect::<Vec<_>>())?),
            })
        })
    }

    /// Reading a key partway through a command, as Emacs's read-key,
    /// read-event, read-char and read-key-sequence, and recursive edits.
    fn readKeyEvent(ed, kind: String, prompt: String, seconds: Option<f64>) -> Option<String> {
        let kind = match kind.as_str() {
            "key" => e8_core::keyboard::ReadKind::Key,
            "event" => e8_core::keyboard::ReadKind::Event,
            "char" => e8_core::keyboard::ReadKind::Char,
            _ => e8_core::keyboard::ReadKind::KeySequence,
        };
        let timeout = seconds.map(|s| std::time::Duration::from_secs_f64(s.max(0.0)));
        waiting(|| ed.read_key_event(kind, &prompt, timeout))
    }

    fn sleepFor(ed, seconds: f64) {
        waiting(|| ed.sleep_for(seconds))
    }

    /// Edit recursively, as Emacs's recursive-edit: the editor goes on taking
    /// commands, with [ ] around the modes in the mode line, until C-M-c
    /// (exit-recursive-edit) returns from it, or C-] (abort-recursive-edit)
    /// quits it.
    pub fn recursiveEdit(ed) {
        waiting(|| ed.recursive_edit())
    }

    /// The keys typed lately, oldest first, as recent-keys; with
    /// `includeCmds`, each command after the keys that ran it. Keys a
    /// keyboard macro replays are not among them.
    #[ts = "(includeCmds?: boolean): (string | { command: string })[]"]
    pub fn recentKeys(ed, include_cmds: bool) -> Vec<Field> {
        Ok(ed
            .recent_keys(include_cmds)
            .into_iter()
            .map(|e| match e {
                e8_core::keyboard::Lossage::Key(k) => Field::from(k.to_string()),
                e8_core::keyboard::Lossage::Command(c) => Record::new().with("command", c).into(),
            })
            .collect())
    }

    /// Reading from the minibuffer partway through a command, as Emacs's
    /// read-from-minibuffer, completing-read and read-file-name.
    fn read(ed, kind: String, prompt: String, options: Fields) -> EditorValue {
        let Some(kind) = ParamKind::from_name(&kind) else {
            return Err(Error::signal("wrong-type-argument", format!("Unknown kind of reading {kind:?}"), Vec::new()));
        };
        let mut reading = Reading::new(&prompt, kind);
        reading.collection = options.strings("collection");
        if let Some(EditorValue::Function(f)) = options.get("collectionFunction") {
            reading.collection_fn = Some(f.clone());
        }
        reading.category = options.string("category");
        reading.require_match = options.flag("requireMatch");
        reading.initial = options.string("initial");
        reading.default = options.string("default");
        reading.history = options.string("history");
        reading.dir = options.string("dir");
        waiting(|| ed.read_from_minibuffer(reading))
    }

    /// What the open prompt reads, or undefined if none is open.
    #[ts = "(): MinibufferInfo | undefined"]
    pub fn minibufferInfo(ed) -> Option<Record> {
        Ok(ed.minibuffer_info().map(|info| {
            Record::new()
                .with("prompt", info.prompt)
                .with("completing", info.completing)
                .with("category", info.category)
                .with("requireMatch", info.require_match)
                .with("default", info.default)
                .with("initial", info.initial)
                .with("ignoreCase", info.ignore_case)
                .with("kept", info.kept)
                .with("history", info.history)
        }))
    }

    fn completionAllSortedCompletions(ed, at_end: Opt<bool>) -> Option<Record> {
        let point = if at_end.0 == Some(true) { ed.minibuffer_input().chars().count() } else { ed.minibuffer_input_point() };
        Ok(ed
            .completion_all_sorted_completions_at(point)
            .map(|(base, comps, fresh)| Record::new().with("base", base).with("completions", comps).with("fresh", fresh)))
    }

    /// What the open prompt's input completes against, with point at
    /// `point` (where it is by default), as Emacs's completion-boundaries
    /// split it against minibuffer-completion-table: `base`, the part
    /// completion leaves alone, such as a file name's directory; `before`
    /// and `after`, the part before and after point that completes;
    /// `suffix`, what follows that; and the names it could complete to.
    #[ts = "(point?: number): { base: string; before: string; after: string; suffix: string; names: string[] } | undefined"]
    pub fn minibufferCompletionField(ed, point: Option<usize>) -> Option<Record> {
        let point = point.unwrap_or_else(|| ed.minibuffer_input_point());
        Ok(ed.minibuffer_completion_field(point).map(|(base, before, after, suffix, names)| {
            Record::new().with("base", base).with("before", before).with("after", after).with("suffix", suffix).with("names", names)
        }))
    }

    /// The completion styles for the open prompt, in order: its category's
    /// first, from completion-category-overrides or -defaults, then
    /// completion-styles, as Emacs's completion--styles.
    pub fn completionStyles(ed) -> Vec<String> {
        Ok(ed.completion_styles())
    }

    /// The names that BEFORE and AFTER, the input either side of point,
    /// match in one of the completion styles E8 has built in: basic,
    /// partial-completion, substring, flex, emacs22 or initials. Undefined
    /// for a style it does not have, as one a package adds to
    /// completion-styles-alist.
    pub fn completionAllInStyle(ed, style: String, before: String, after: String, names: Vec<String>, ignore_case: Option<bool>) -> Option<Vec<String>> {
        let _ = ed;
        Ok(e8_core::completion::all_in_style(&style, &before, &after, &names, ignore_case.unwrap_or(false)))
    }

    /// Asks the open prompt's completion function, a completingRead table
    /// that is a function, for its names again, as when output a process
    /// gave changes them between commands, as consult's async tables do.
    pub fn refreshCompletionTable(ed) {
        ed.refresh_dynamic_collection();
        Ok(())
    }

    /// The names of all commands, as all-completions over obarray with commandp.
    pub fn commandNames(ed) -> Vec<String> {
        Ok(ed.command_names().map(str::to_string).collect())
    }

    /// The places the mark was set in other buffers, the newest first, as
    /// global-mark-ring's markers: each [buffer, position].
    #[ts = "(): [string, number][]"]
    pub fn globalMarkRing(ed) -> EditorValue {
        Ok(EditorValue::List(
            ed.global_mark_ring()
                .into_iter()
                .map(|(b, p)| EditorValue::List(vec![EditorValue::Str(b), EditorValue::Number(p as f64)]))
                .collect(),
        ))
    }

    /// The current buffer's mark ring, the newest first, as mark-ring's markers.
    pub fn markRing(ed) -> Vec<usize> {
        Ok(ed.buffer().mark_ring().to_vec())
    }

    /// Whether `input` is an answer the open prompt takes, as test-completion.
    pub fn testCompletion(ed, input: String) -> bool {
        Ok(ed.test_completion(&input))
    }

    /// Null for no completion, true for the only one, and `{ text, point }` otherwise.
    fn completionTryCompletion(ed, input: String, names: Option<Vec<String>>) -> Field {
        Ok(match ed.completion_try_with(&input, input.chars().count(), names) {
            e8_core::completion::Try::None => Field::Value(EditorValue::Null),
            e8_core::completion::Try::Exact => Field::from(true),
            e8_core::completion::Try::Completed { text, point } => Record::new().with("text", text).with("point", point).into(),
        })
    }

    fn runWithTimer(ed, secs: f64, repeat: Option<f64>, idle: bool, run: e8_core::Function) -> f64 {
        let f = hook_of(run);
        Ok(if idle { ed.run_with_idle_timer(secs, repeat.is_some(), f) } else { ed.run_with_timer(secs, repeat, f) } as f64)
    }

    /// An environment variable's value, as Emacs's getenv.
    pub fn getenv(ed, name: String) -> Option<String> {
        Ok(std::env::var(name).ok())
    }

    /// A file's attributes, or undefined if there is no such file.
    #[ts = "(file: string): FileAttributes | undefined"]
    pub fn fileAttributes(ed, file: String) -> Option<Record> {
        let path = ed.expand_file_name(&file);
        let Some(a) = e8_core::fileops::file_attributes(&path) else { return Ok(None) };
        Ok(Some(attributes_record(&a)))
    }

    /// Where a file is auto-saved: #name# beside it.
    pub fn autoSaveFileName(ed, file: String) -> String {
        Ok(e8_core::auto_save_file_name(Path::new(&file)).display().to_string())
    }

    /// Whether a file's auto-save file is newer than the file.
    pub fn hasNewerAutoSave(ed, file: String) -> bool {
        Ok(Editor::has_newer_auto_save(Path::new(&file)))
    }
}

/// A file's attributes as scripts see them, as [`fileAttributes`] gives them.
pub(crate) fn attributes_record(a: &e8_core::fileops::FileAttributes) -> Record {
    // To the nanosecond as far as a number holds it, so a time read here can be set back exactly.
    let ms = |t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_nanos() as f64 / 1e6);
    let (kind, link) = match &a.kind {
        e8_core::fileops::FileKind::File => ("file", None),
        e8_core::fileops::FileKind::Directory => ("directory", None),
        e8_core::fileops::FileKind::Symlink(to) => ("symlink", Some(to.clone())),
    };
    Record::new()
        .with("type", kind)
        .with("linkTarget", link)
        .with("links", a.links as f64)
        .with("uid", a.uid)
        .with("gid", a.gid)
        .with("user", a.user.clone())
        .with("group", a.group.clone())
        .with("size", a.size as f64)
        .with("modified", ms(a.modified))
        .with("accessed", ms(a.accessed))
        .with("modes", a.modes.clone())
        .with("inode", a.inode as f64)
}

/// A binding as scripts see it: a command's name, a prefix keymap, or the
/// keys of a keyboard macro; none for nil.
fn binding_value(binding: e8_core::Binding) -> Option<EditorValue> {
    match binding {
        e8_core::Binding::Command(c) => Some(EditorValue::Str(c)),
        e8_core::Binding::Keymap(m) => Some(EditorValue::Keymap(m)),
        e8_core::Binding::Keys(k) => Some(EditorValue::List(k.iter().map(|k| EditorValue::Str(k.to_string())).collect())),
        e8_core::Binding::Nil => None,
    }
}
