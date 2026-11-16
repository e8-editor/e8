use std::rc::Rc;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::Key;

/// What kind of value a command parameter takes. Decides how the minibuffer
/// reads it and what it completes against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    /// Free text.
    String,
    /// A file name, completed from the file system.
    File,
    /// A buffer name, completed from open buffers.
    Buffer,
    /// A command name, completed from the command registry.
    Command,
    /// A key sequence, read key by key rather than typed as text.
    Keys,
    /// A variable name, completed from the defined variables.
    Variable,
    /// A face name, completed from the defined faces.
    Face,
    /// A number typed in the minibuffer, as interactive "n".
    Number,
    /// The prefix argument as a count, 1 without one, as interactive "p".
    /// Never prompted for; from code it can be left out.
    Count,
    /// The raw prefix argument, as interactive "P". Never prompted for;
    /// from code it can be left out.
    Prefix,
    /// Point, as interactive "d".
    Point,
    /// The mark, as interactive "m".
    Mark,
    /// The start of the region, as the first of interactive "r".
    RegionBeginning,
    /// The end of the region, as the second of interactive "r".
    RegionEnd,
}

impl ParamKind {
    pub const ALL: [ParamKind; 14] = [
        ParamKind::String,
        ParamKind::File,
        ParamKind::Buffer,
        ParamKind::Command,
        ParamKind::Keys,
        ParamKind::Variable,
        ParamKind::Face,
        ParamKind::Number,
        ParamKind::Count,
        ParamKind::Prefix,
        ParamKind::Point,
        ParamKind::Mark,
        ParamKind::RegionBeginning,
        ParamKind::RegionEnd,
    ];

    /// The kind's name in scripts, such as `"file"`.
    pub fn name(&self) -> &'static str {
        match self {
            ParamKind::String => "string",
            ParamKind::File => "file",
            ParamKind::Buffer => "buffer",
            ParamKind::Command => "command",
            ParamKind::Keys => "keys",
            ParamKind::Variable => "variable",
            ParamKind::Face => "face",
            ParamKind::Number => "number",
            ParamKind::Count => "count",
            ParamKind::Prefix => "prefix",
            ParamKind::Point => "point",
            ParamKind::Mark => "mark",
            ParamKind::RegionBeginning => "region-beginning",
            ParamKind::RegionEnd => "region-end",
        }
    }

    /// Whether the minibuffer completes it against names of its own kind.
    pub fn completes(self) -> bool {
        matches!(self, ParamKind::File | ParamKind::Buffer | ParamKind::Command | ParamKind::Variable | ParamKind::Face)
    }

    /// Whether the editor supplies it rather than the minibuffer reading
    /// it: the prefix argument, point, the mark and the region.
    pub fn from_state(self) -> bool {
        matches!(self, ParamKind::Count | ParamKind::Prefix | ParamKind::Point | ParamKind::Mark | ParamKind::RegionBeginning | ParamKind::RegionEnd)
    }

    /// Whether code can leave it out, as an &optional argument: a count
    /// or prefix argument, taken from the call's prefix argument.
    pub fn optional(self) -> bool {
        matches!(self, ParamKind::Count | ParamKind::Prefix)
    }

    pub fn from_name(name: &str) -> Option<ParamKind> {
        ParamKind::ALL.into_iter().find(|k| k.name() == name)
    }

    pub fn describe(&self) -> &'static str {
        match self {
            ParamKind::String => "text",
            ParamKind::File => "file name",
            ParamKind::Buffer => "buffer name",
            ParamKind::Command => "command name",
            ParamKind::Keys => "key sequence",
            ParamKind::Variable => "variable name",
            ParamKind::Face => "face name",
            ParamKind::Number => "number",
            ParamKind::Count => "prefix count",
            ParamKind::Prefix => "raw prefix argument",
            ParamKind::Point => "point",
            ParamKind::Mark => "mark",
            ParamKind::RegionBeginning => "region start",
            ParamKind::RegionEnd => "region end",
        }
    }

    /// The history variable answers of this kind go in, by Emacs's names.
    pub fn history(self) -> &'static str {
        match self {
            ParamKind::Command => "extended-command-history",
            ParamKind::File => "file-name-history",
            ParamKind::Buffer => "buffer-name-history",
            ParamKind::Variable => "variable-name-history",
            ParamKind::Face => "face-name-history",
            _ => "minibuffer-history",
        }
    }
}

/// A function of the arguments read so far, for working out what a
/// parameter's prompt shows.
pub type ArgsFn<T> = dyn Fn(&mut Editor, &[Arg]) -> Result<T>;

/// Works out the names a parameter completes against from the arguments
/// read before it.
#[derive(Clone)]
pub struct CollectionFn(pub Rc<ArgsFn<Vec<String>>>);

impl std::fmt::Debug for CollectionFn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CollectionFn")
    }
}

/// Works out a parameter's prompt from the arguments read before it, as
/// Emacs's interactive specs can: "Rename foo.txt to file: ".
#[derive(Clone)]
pub struct PromptFn(pub Rc<ArgsFn<String>>);

impl std::fmt::Debug for PromptFn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PromptFn")
    }
}

#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub kind: ParamKind,
    pub prompt: String,
    /// Works the prompt out when it is asked, instead of `prompt`.
    pub prompt_fn: Option<PromptFn>,
    /// Works out the input the minibuffer starts with, instead of the kind's.
    pub initial_fn: Option<PromptFn>,
    /// Works out what empty input stands for, as `completing-read`'s DEF,
    /// which completion frameworks such as vertico list first.
    pub default_fn: Option<PromptFn>,
    /// Works out the names to complete against, as `completing-read`'s
    /// collection, instead of the kind's.
    pub collection_fn: Option<CollectionFn>,
    /// Works out the argument from those read before it without asking,
    /// when it gives one, as an interactive spec's code can: none or one
    /// value.
    pub value_fn: Option<CollectionFn>,
    /// Whether the answer must be one of the completions.
    pub require_match: bool,
    /// The variable holding earlier answers, which M-p and M-n go through.
    /// `None` uses the kind's usual history, as [`ParamKind::history`] says.
    pub history: Option<String>,
}

/// An argument value passed to a command.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Str(String),
    Keys(Vec<Key>),
    /// A number: a count, a position or one typed.
    Int(i64),
    /// A raw prefix argument, or none.
    Prefix(Option<crate::prefix::PrefixArg>),
}

impl std::fmt::Display for Arg {
    /// Text as is; key sequences in Emacs notation; a prefix argument as
    /// Emacs prints it: nothing for none, (4) for C-u, - and numbers.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use crate::prefix::PrefixArg;
        match self {
            Arg::Str(s) => f.write_str(s),
            Arg::Keys(k) => f.write_str(&crate::key::format_keys(k)),
            Arg::Int(n) => write!(f, "{n}"),
            Arg::Prefix(None) => Ok(()),
            Arg::Prefix(Some(PrefixArg::Universal(n))) => write!(f, "({n})"),
            Arg::Prefix(Some(PrefixArg::Minus)) => f.write_str("-"),
            Arg::Prefix(Some(PrefixArg::Number(n))) => write!(f, "{n}"),
        }
    }
}

impl Arg {
    /// An argument of a kind from text, as the MCP server and the agent
    /// pass them: keys in Emacs notation, numbers in digits, and a prefix
    /// argument as nothing, "-", a number, or C-u, (4) or true.
    pub fn from_text(kind: ParamKind, text: &str) -> Result<Arg> {
        use crate::prefix::PrefixArg;
        let number = |text: &str| text.trim().parse::<i64>().map_err(|_| Error::signal("wrong-type-argument", format!("Not a number: {text:?}"), Vec::new()));
        Ok(match kind {
            ParamKind::Keys => Arg::Keys(Key::parse_seq(text).ok_or_else(|| Error::new(format!("Invalid key sequence: {text:?}")))?),
            // A count given as nil counts 1, as prefix-numeric-value says.
            ParamKind::Count if matches!(text.trim(), "" | "nil") => Arg::Int(1),
            ParamKind::Number | ParamKind::Count | ParamKind::Point | ParamKind::Mark | ParamKind::RegionBeginning | ParamKind::RegionEnd => {
                Arg::Int(number(text)?)
            }
            ParamKind::Prefix => Arg::Prefix(match text.trim() {
                "" | "nil" | "false" => None,
                "-" => Some(PrefixArg::Minus),
                // Any other non-nil value, as Lisp passes t for an optional flag.
                "C-u" | "t" | "true" => Some(PrefixArg::Universal(4)),
                t if t.starts_with('(') && t.ends_with(')') => Some(PrefixArg::Universal(number(&t[1..t.len() - 1])?)),
                t => Some(PrefixArg::Number(number(t)?)),
            }),
            _ => Arg::Str(text.to_string()),
        })
    }

    /// An argument of a kind from a value, as `funcall` and advice pass
    /// them: numbers for counts and positions, nil, a list of a number for
    /// C-u, - or a number for a prefix argument, and text for the rest.
    pub fn from_value(kind: ParamKind, value: &crate::Value) -> Result<Arg> {
        use crate::Value;
        use crate::prefix::PrefixArg;
        Ok(match (kind, value) {
            (ParamKind::Prefix, Value::Null | Value::Bool(false)) => Arg::Prefix(None),
            (ParamKind::Prefix, Value::Bool(true)) => Arg::Prefix(Some(PrefixArg::Universal(4))),
            (ParamKind::Prefix, Value::Number(n)) => Arg::Prefix(Some(PrefixArg::Number(*n as i64))),
            (ParamKind::Prefix, Value::List(items)) => match items.first().and_then(Value::as_number) {
                Some(n) => Arg::Prefix(Some(PrefixArg::Universal(n as i64))),
                None => Arg::Prefix(Some(PrefixArg::Universal(4))),
            },
            (ParamKind::Count, Value::Null | Value::Bool(false)) => Arg::Int(1),
            (_, Value::Number(n)) if !matches!(kind, ParamKind::Keys) => match kind {
                ParamKind::Number | ParamKind::Count | ParamKind::Point | ParamKind::Mark | ParamKind::RegionBeginning | ParamKind::RegionEnd => Arg::Int(*n as i64),
                _ => Arg::Str(value.to_string()),
            },
            (_, Value::Str(_) | Value::Symbol(_) | Value::Text(_)) => Arg::from_text(kind, value.as_str().expect("text"))?,
            (_, other) => Arg::from_text(kind, &other.to_string())?,
        })
    }

    /// The argument as a value, as advice and `funcall` see it: text,
    /// keys in Emacs notation, numbers, and a prefix argument as nil, a
    /// list of a number for C-u, the symbol - or a number.
    pub fn to_value(&self) -> crate::Value {
        use crate::Value;
        use crate::prefix::PrefixArg;
        match self {
            Arg::Str(s) => Value::Str(s.clone()),
            Arg::Keys(k) => Value::Str(crate::key::format_keys(k)),
            Arg::Int(n) => Value::Number(*n as f64),
            Arg::Prefix(None) => Value::Null,
            Arg::Prefix(Some(PrefixArg::Universal(n))) => Value::List(vec![Value::Number(*n as f64)]),
            Arg::Prefix(Some(PrefixArg::Minus)) => Value::Symbol("-".into()),
            Arg::Prefix(Some(PrefixArg::Number(n))) => Value::Number(*n as f64),
        }
    }

    /// The argument as a number, as a count or position parameter takes it.
    pub fn as_int(&self) -> Result<i64> {
        match self {
            Arg::Int(n) => Ok(*n),
            Arg::Str(s) => s.trim().parse().map_err(|_| Error::new(format!("Expected a number, got {s:?}"))),
            _ => Err(Error::new("Expected a number")),
        }
    }

    pub fn as_str(&self) -> Result<&str> {
        match self {
            Arg::Str(s) => Ok(s),
            _ => Err(Error::new("Expected text")),
        }
    }

    pub fn as_keys(&self) -> Result<&[Key]> {
        match self {
            Arg::Keys(k) => Ok(k),
            _ => Err(Error::new("Expected a key sequence")),
        }
    }
}

pub type CommandFn = Rc<dyn Fn(&mut Editor, &[Arg]) -> Result<()>>;

/// A named, documented editor action. One definition serves key bindings,
/// M-x (which prompts for each parameter) and calls from code, which pass
/// the arguments directly.
pub struct Command {
    pub name: String,
    pub doc: String,
    pub params: Vec<Param>,
    pub run: CommandFn,
    /// Where the command was defined, such as a script file. `None` for built-in commands.
    pub source: Option<String>,
    /// Whether the command moves point in a way Shift can select, like the
    /// `^` interactive spec in Emacs. With Shift it starts or extends the
    /// region; without, it ends a region Shift started.
    pub shift_select: bool,
    /// The command this one is an alias of, found by a name `defalias` made,
    /// whose advice applies after the alias's own.
    pub alias_of: Option<String>,
}

impl Command {
    /// The command under another name, as an alias runs it.
    pub(crate) fn aliased(&self, name: &str) -> Command {
        Command {
            name: name.to_string(),
            doc: self.doc.clone(),
            params: self.params.clone(),
            run: self.run.clone(),
            source: self.source.clone(),
            shift_select: self.shift_select,
            alias_of: Some(self.alias_of.clone().unwrap_or_else(|| self.name.clone())),
        }
    }

    pub fn new(
        name: &str,
        doc: &str,
        run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
    ) -> Command {
        Command {
            name: name.to_string(),
            doc: doc.to_string(),
            params: Vec::new(),
            run: Rc::new(run),
            source: None,
            shift_select: false,
            alias_of: None,
        }
    }

    /// Adds a parameter. Interactive calls prompt for parameters in order.
    pub fn param(mut self, name: &str, kind: ParamKind, prompt: &str) -> Command {
        self.params.push(Param {
            name: name.to_string(),
            kind,
            prompt: prompt.to_string(),
            prompt_fn: None,
            initial_fn: None,
            default_fn: None,
            collection_fn: None,
            value_fn: None,
            require_match: false,
            history: None,
        });
        self
    }

    /// Gives the last parameter added a value worked out from the arguments
    /// read before it, the first of those `value` gives, in place of asking
    /// for it; when it gives none, the parameter is asked for as usual.
    pub fn value_with(mut self, value: impl Fn(&mut Editor, &[Arg]) -> Result<Vec<String>> + 'static) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.value_fn = Some(CollectionFn(Rc::new(value)));
        }
        self
    }

    /// Gives the last parameter added a prompt worked out from the arguments
    /// read before it.
    pub fn prompt_with(mut self, prompt: impl Fn(&mut Editor, &[Arg]) -> Result<String> + 'static) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.prompt_fn = Some(PromptFn(Rc::new(prompt)));
        }
        self
    }

    /// Gives the last parameter added the input the minibuffer starts with,
    /// worked out from the arguments read before it.
    pub fn initial_with(mut self, initial: impl Fn(&mut Editor, &[Arg]) -> Result<String> + 'static) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.initial_fn = Some(PromptFn(Rc::new(initial)));
        }
        self
    }

    /// Gives the last parameter added the default its prompt offers,
    /// worked out from the arguments read before it, as the DEF argument
    /// of Emacs's `read-buffer` and `completing-read`: what empty input
    /// stands for. An empty string is no default.
    pub fn default_with(mut self, default: impl Fn(&mut Editor, &[Arg]) -> Result<String> + 'static) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.default_fn = Some(PromptFn(Rc::new(default)));
        }
        self
    }

    /// Makes the last parameter added complete against names worked out
    /// when it is asked, as `completing-read`, which must be matched if
    /// `require_match`.
    pub fn collection(mut self, require_match: bool, names: impl Fn(&mut Editor, &[Arg]) -> Result<Vec<String>> + 'static) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.collection_fn = Some(CollectionFn(Rc::new(names)));
            param.require_match = require_match;
        }
        self
    }

    /// Gives the last parameter added its own history variable.
    pub fn history(mut self, variable: &str) -> Command {
        if let Some(param) = self.params.last_mut() {
            param.history = Some(variable.to_string());
        }
        self
    }

    /// Marks the command as a movement that Shift selection applies to.
    pub fn shift_select(mut self) -> Command {
        self.shift_select = true;
        self
    }

    /// The first line of the documentation.
    pub fn summary(&self) -> &str {
        self.doc.lines().next().unwrap_or("")
    }
}
