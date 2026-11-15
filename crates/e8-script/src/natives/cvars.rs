//! Variables and symbols as Emacs's data.c, eval.c and lread.c give them
//! (ADR 0101): aliases and watchers, being bound and buffer-local, the
//! symbol table, numbers as text, error messages, commands, hooks run
//! through a wrapper, and finding files along a path.

use crate::*;
use crate::natives::{Opt, Rest, natives};

fn name_of(value: &EditorValue) -> Result<String> {
    value.as_str().map(str::to_string).ok_or_else(|| e8_core::xfaces::wrong_type("symbolp", value))
}

/// A buffer argument's index, the current buffer's by default.
fn buffer_index(ed: &Editor, buffer: Option<EditorValue>) -> Result<usize> {
    match buffer {
        None | Some(EditorValue::Null) => Ok(ed.buffers().iter().position(|b| b.id() == ed.buffer().id()).unwrap_or(0)),
        Some(EditorValue::Buffer(id)) => ed.buffer_with_id(id).ok_or_else(|| Error::new("Selecting deleted buffer")),
        Some(EditorValue::Str(name)) => ed.buffers().iter().position(|b| b.name == name).ok_or_else(|| Error::new(format!("No such buffer {name}"))),
        Some(other) => Err(e8_core::xfaces::wrong_type("bufferp", &other)),
    }
}

/// Runs `f` with another buffer current, as with-current-buffer, for a question about it.
fn in_buffer<T>(ed: &mut Editor, index: usize, f: impl FnOnce(&mut Editor) -> T) -> Result<T> {
    let here = ed.buffer().name.clone();
    let there = ed.buffers()[index].name.clone();
    if there == here {
        return Ok(f(ed));
    }
    ed.set_current_buffer(&there)?;
    let answer = f(ed);
    ed.set_current_buffer(&here)?;
    Ok(answer)
}

/// The number a string starts with, as string-to-number: in base 10 an
/// integer or a float, in another base an integer, 0 for none.
fn string_to_number(s: &str, base: u32) -> f64 {
    let s = s.trim_start_matches([' ', '\t', '\n', '\r', '\u{c}']);
    let (sign, rest) = match s.as_bytes().first() {
        Some(b'-') => (-1.0, &s[1..]),
        Some(b'+') => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    if base != 10 {
        let digits: String = rest.chars().take_while(|c| c.is_digit(base)).collect();
        return sign * u64::from_str_radix(&digits, base).map_or(0.0, |n| n as f64);
    }
    // The longest prefix that is an integer or a float in Lisp's syntax.
    let b = rest.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_end = i;
    let mut end = int_end;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 {
            end = j;
            i = j;
        } else if int_end > 0 {
            // "1." is the integer 1.
            i = j;
        }
    }
    if end > 0 && i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let digits = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > digits {
            end = j;
        }
    }
    sign * rest[..end].parse::<f64>().unwrap_or(0.0)
}

/// The message an error symbol's errors start with, as its error-message property says.
fn error_message(symbol: &str) -> &'static str {
    match symbol {
        "void-variable" => "Symbol’s value as variable is void",
        "void-function" => "Symbol’s function definition is void",
        "wrong-type-argument" => "Wrong type argument",
        "args-out-of-range" => "Args out of range",
        "wrong-number-of-arguments" => "Wrong number of arguments",
        "end-of-file" => "End of file during parsing",
        "invalid-read-syntax" => "Invalid read syntax",
        "arith-error" => "Arithmetic error",
        "overflow-error" => "Arithmetic overflow error",
        "search-failed" => "Search failed",
        "invalid-regexp" => "Invalid regexp",
        "setting-constant" => "Attempt to set a constant symbol",
        "cyclic-variable-indirection" => "Symbol’s chain of variable indirections contains a loop",
        "cyclic-function-indirection" => "Symbol’s chain of function indirections contains a loop",
        "beginning-of-buffer" => "Beginning of buffer",
        "end-of-buffer" => "End of buffer",
        "buffer-read-only" => "Buffer is read-only",
        "text-read-only" => "Text is read-only",
        "mark-inactive" => "The mark is not active now",
        "no-catch" => "No catch for tag",
        "coding-system-error" => "Invalid coding system",
        "quit" | "minibuffer-quit" => "Quit",
        "file-error" | "file-missing" | "file-already-exists" | "permission-denied" => "File error",
        _ => "peculiar error",
    }
}

/// An error as text, as print_error_message writes `(SYMBOL . DATA)`.
fn error_text(ed: &Editor, symbol: &str, data: &[EditorValue]) -> String {
    let print = |v: &EditorValue| ed.prin1_to_string(v, false);
    let princ = |v: &EditorValue| ed.prin1_to_string(v, true);
    let conditions = e8_core::error_conditions(symbol);
    // error and user-error, and the file errors, take their message from their data.
    if matches!(symbol, "error" | "user-error") {
        return match data.first() {
            Some(first) => princ(first),
            None => "peculiar error".into(),
        };
    }
    let (message, data) = if conditions.iter().any(|c| c == "file-error") && data.first().is_some_and(|d| d.as_str().is_some()) {
        (princ(&data[0]), &data[1..])
    } else {
        (error_message(symbol).to_string(), data)
    };
    if data.is_empty() {
        return message;
    }
    // A file error's data is written as text, others as Lisp writes them.
    let file = conditions.iter().any(|c| c == "file-error");
    let parts: Vec<String> = data.iter().map(|d| if file { princ(d) } else { print(d) }).collect();
    format!("{message}: {}", parts.join(", "))
}

natives! {
    /// Make a name stand for another variable, as defvaralias; gives the variable.
    #[ts = "(newAlias: string, baseVariable: string, docstring?: string | null): string"]
    pub fn defvaralias(ed, new_alias: EditorValue, base: EditorValue, _doc: Opt<EditorValue>) -> String {
        let (new, base) = (name_of(&new_alias)?, name_of(&base)?);
        ed.defvaralias(&new, &base)?;
        Ok(base)
    }

    /// The variable a name stands for past any aliases, as indirect-variable.
    #[ts = "(object: string): string"]
    pub fn indirectVariable(ed, object: EditorValue) -> String {
        Ok(ed.base_variable(&name_of(&object)?).into_owned())
    }

    /// Call a function before a variable changes, as add-variable-watcher: with the variable, its new value, the operation (set, makunbound or defvaralias) and the buffer whose own value changes, if one does.
    #[ts = "(symbol: string, watchFunction: string | ((symbol: symbol, newval: Value, operation: symbol, where: Value) => void)): undefined"]
    pub fn addVariableWatcher(ed, symbol: EditorValue, watch: EditorValue) -> Option<bool> {
        let name = ed.base_variable(&name_of(&symbol)?).into_owned();
        let watchers = ed.variable_watchers_mut(&name);
        if !watchers.contains(&watch) {
            watchers.push(watch);
        }
        Ok(None)
    }

    /// Stop calling a function before a variable changes, as remove-variable-watcher.
    #[ts = "(symbol: string, watchFunction: Value): undefined"]
    pub fn removeVariableWatcher(ed, symbol: EditorValue, watch: EditorValue) -> Option<bool> {
        let name = ed.base_variable(&name_of(&symbol)?).into_owned();
        ed.remove_variable_watcher(&name, &watch);
        Ok(None)
    }

    /// The functions called before a variable changes, as get-variable-watchers.
    #[ts = "(symbol: string): Value[]"]
    pub fn getVariableWatchers(ed, symbol: EditorValue) -> Vec<EditorValue> {
        let name = ed.base_variable(&name_of(&symbol)?).into_owned();
        Ok(ed.variable_watchers(&name))
    }

    /// Whether a variable has a value, as boundp.
    #[ts = "(symbol: string): boolean"]
    pub fn boundp(ed, symbol: EditorValue) -> bool {
        Ok(ed.variable(&name_of(&symbol)?).is_some())
    }

    /// Whether a variable has a global value, as default-boundp.
    #[ts = "(symbol: string): boolean"]
    pub fn defaultBoundp(ed, symbol: EditorValue) -> bool {
        Ok(ed.default_value(&name_of(&symbol)?).is_some())
    }

    /// Make a variable unbound, the current buffer's own value if it has one, as makunbound; gives the variable.
    #[ts = "(symbol: string): string"]
    pub fn makunbound(ed, symbol: EditorValue) -> String {
        let name = name_of(&symbol)?;
        ed.makunbound(&name);
        Ok(name)
    }

    /// Whether a buffer, the current one by default, has its own value of a variable, as local-variable-p.
    #[ts = "(variable: string, buffer?: BufferLike | null): boolean"]
    pub fn localVariableP(ed, variable: EditorValue, buffer: Opt<EditorValue>) -> bool {
        let name = name_of(&variable)?;
        let index = buffer_index(ed, buffer.0)?;
        in_buffer(ed, index, |ed| ed.is_local_variable(&name))
    }

    /// Whether setting a variable in a buffer would give it its own value, as local-variable-if-set-p.
    #[ts = "(variable: string, buffer?: BufferLike | null): boolean"]
    pub fn localVariableIfSetP(ed, variable: EditorValue, buffer: Opt<EditorValue>) -> bool {
        let name = name_of(&variable)?;
        let index = buffer_index(ed, buffer.0)?;
        let automatic = ed.variable_definition(&ed.base_variable(&name)).is_some_and(|v| v.local);
        Ok(automatic || in_buffer(ed, index, |ed| ed.is_local_variable(&name))?)
    }

    /// Make a variable buffer-local in every buffer that sets it, as make-variable-buffer-local; gives the variable.
    #[ts = "(variable: string): string"]
    pub fn makeVariableBufferLocal(ed, variable: EditorValue) -> String {
        let name = name_of(&variable)?;
        ed.make_variable_buffer_local(&name);
        Ok(name)
    }

    /// Whether a variable was defined, as special-variable-p says of one defvar made.
    #[ts = "(symbol: string): boolean"]
    pub fn specialVariableP(ed, symbol: EditorValue) -> bool {
        let name = name_of(&symbol)?;
        Ok(ed.variable_definition(&ed.base_variable(&name)).is_some())
    }

    /// A variable's value, or void-variable, as symbol-value.
    #[ts = "(symbol: string): Value"]
    pub fn symbolValue(ed, symbol: EditorValue) -> EditorValue {
        let name = name_of(&symbol)?;
        ed.variable(&name).ok_or_else(|| Error::signal("void-variable", format!("Symbol’s value as variable is void: {name}"), vec![EditorValue::Symbol(name)]))
    }

    /// The symbol by a name if one is interned, as intern-soft; undefined if not.
    #[ts = "(name: string): string | undefined"]
    pub fn internSoft(ed, name: EditorValue) -> Option<String> {
        let name = name_of(&name)?;
        Ok(ed.symbol_interned(&name).then_some(name))
    }

    /// Call a function with every interned symbol's name, as mapatoms.
    #[ts = "(fn: string | ((symbol: string) => void)): undefined"]
    pub fn mapatoms(ed, function: EditorValue) -> Option<bool> {
        for name in ed.symbol_names() {
            ed.funcall(&function, &[EditorValue::Str(name)])?;
        }
        Ok(None)
    }

    /// Take a symbol out of the table, as unintern; whether it was there.
    #[ts = "(name: string, obarray?: Value): boolean"]
    pub fn unintern(ed, name: EditorValue, _obarray: Opt<EditorValue>) -> bool {
        Ok(ed.unintern(&name_of(&name)?))
    }

    /// The number a string starts with, as string-to-number: an integer or float in base 10, an integer in another base, 0 for none.
    #[ts = "(string: string, base?: number | null): number"]
    pub fn stringToNumber(_ed, string: String, base: Opt<EditorValue>) -> f64 {
        let base = base.0.as_ref().and_then(EditorValue::as_number).map_or(10, |b| b as u32);
        if !(2..=16).contains(&base) {
            return Err(Error::signal("args-out-of-range", "Args out of range", vec![EditorValue::Number(f64::from(base))]));
        }
        Ok(string_to_number(&string, base))
    }

    /// A number as text, as number-to-string: a whole number without a point.
    #[ts = "(number: number): string"]
    pub fn numberToString(_ed, number: f64) -> String {
        Ok(if number.fract() == 0.0 && number.abs() < 1e17 { format!("{}", number as i64) } else { format!("{number}") })
    }

    /// An error as text, as error-message-string: from its symbol's message and its data, `[symbol, ...data]`.
    fn errorMessageStringNative(ed, error: EditorValue) -> String {
        let EditorValue::List(items) = &error else { return Ok(format!("peculiar error: {}", ed.prin1_to_string(&error, false))) };
        let Some(symbol) = items.first().and_then(EditorValue::as_str) else { return Ok("peculiar error".into()) };
        Ok(error_text(ed, symbol, &items[1..]))
    }

    /// Whether something can be called as a command, as commandp: a command's name, or a list of keys as a keyboard macro. A string is a name, as E8's names are strings, not a keyboard macro as in Emacs.
    #[ts = "(fn: Value, forCallInteractively?: boolean | null): boolean"]
    pub fn commandp(ed, function: EditorValue, _for_call: Opt<EditorValue>) -> bool {
        Ok(match &function {
            EditorValue::Str(name) | EditorValue::Symbol(name) => ed.command(name).is_some(),
            EditorValue::List(keys) => keys.iter().all(|k| k.as_number().is_some() || k.as_str().is_some()),
            _ => false,
        })
    }

    /// Call a wrapper with each of a hook's functions and the arguments until it gives something true, as run-hook-wrapped; gives that.
    #[ts = "(hook: string, wrapFunction: string | ((fn: Value, ...args: any[]) => any), ...args: Value[]): Value"]
    pub fn runHookWrapped(ed, hook: EditorValue, wrap: EditorValue, args: Rest<EditorValue>) -> EditorValue {
        let name = name_of(&hook)?;
        let all = ed.hook_functions(&name);
        for f in all {
            let call: Vec<EditorValue> = std::iter::once(f).chain(args.0.iter().cloned()).collect();
            let answer = ed.funcall(&wrap, &call)?;
            if answer.is_true() {
                return Ok(answer);
            }
        }
        Ok(EditorValue::Null)
    }

    /// The first file along a path that is `filename` with one of `suffixes`, as locate-file-internal; undefined if none.
    #[ts = "(filename: string, path: (string | null)[], suffixes?: string[] | null, predicate?: Value): string | undefined"]
    pub fn locateFileInternal(ed, filename: String, path: Vec<EditorValue>, suffixes: Opt<EditorValue>, _predicate: Opt<EditorValue>) -> Option<String> {
        let suffixes: Vec<String> = match suffixes.0 {
            Some(EditorValue::List(items)) => items.iter().filter_map(|s| s.as_str().map(str::to_string)).collect(),
            _ => vec![String::new()],
        };
        let dirs: Vec<String> = if std::path::Path::new(&filename).is_absolute() {
            vec![String::new()]
        } else {
            path.iter().map(|d| d.as_str().map_or_else(|| ed.default_directory().to_string_lossy().into_owned(), str::to_string)).collect()
        };
        for dir in dirs {
            for suffix in &suffixes {
                let candidate = if dir.is_empty() { format!("{filename}{suffix}") } else { format!("{}/{filename}{suffix}", dir.trim_end_matches('/')) };
                let expanded = ed.expand_file_name(&candidate);
                if e8_core::vfs::path_exists(&expanded) && !e8_core::vfs::path_is_dir(&expanded) {
                    return Ok(Some(expanded.to_string_lossy().into_owned()));
                }
            }
        }
        Ok(None)
    }

    /// The suffixes load tries, as get-load-suffixes: E8 loads TypeScript and JavaScript.
    #[ts = "(): string[]"]
    pub fn getLoadSuffixes(_ed) -> Vec<String> {
        Ok(vec![".ts".into(), ".js".into()])
    }
}
