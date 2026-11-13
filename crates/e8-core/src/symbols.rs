//! Symbols, as Emacs has them: one table, in which each name has a value
//! (a variable, or a hook's functions), a function (a function, a command,
//! which is a function with an interactive spec, or another name, as
//! `defalias` makes), a property list, and the advice on its function, as
//! nadvice.el keeps it.

use std::rc::Rc;

use crate::command::{Arg, Command};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::properties::Props;
use crate::variables::{Function, HookEntry, Value, Variable};

/// One symbol's cells.
#[derive(Default)]
pub(crate) struct Symbol {
    /// Its value cell, if it is a variable.
    pub(crate) variable: Option<Variable>,
    /// A hook's global functions, when the variable is a hook.
    pub(crate) hook: Vec<HookEntry>,
    pub(crate) function: Option<Definition>,
    /// Where its function was defined, such as a script file, as Emacs's
    /// `load-history` records a `defun`; a command keeps its own.
    pub(crate) function_source: Option<String>,
    pub(crate) plist: Props,
    /// Outermost first.
    pub(crate) advice: Vec<Advice>,
}

/// What a symbol's function cell holds.
#[derive(Clone)]
pub enum Definition {
    Function(Function),
    /// A function that keys and M-x can run, reading its arguments as its
    /// parameters say, as a function with an interactive spec.
    Command(Rc<Command>),
    /// Another symbol, whose function this one calls, as `defalias` to a symbol.
    Alias(String),
}

/// How a piece of advice combines with the function it advises, as
/// `advice-add`'s HOW.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdviceHow {
    /// Called with the original function and the arguments, in its place.
    Around,
    Before,
    After,
    Override,
    /// The advice runs first, and the original only if it returns nil.
    BeforeUntil,
    /// The advice runs first, and the original only if it returns non-nil.
    BeforeWhile,
    /// The original runs first, and the advice only if it returns nil.
    AfterUntil,
    /// The original runs first, and the advice only if it returns non-nil.
    AfterWhile,
    /// Called with the arguments as one list, it returns the list to call the original with.
    FilterArgs,
    /// Called with what the original returns, it returns what the call returns.
    FilterReturn,
}

impl AdviceHow {
    /// From Emacs's keyword, with or without its colon: `:around`.
    pub fn from_name(name: &str) -> Option<AdviceHow> {
        Some(match name.strip_prefix(':').unwrap_or(name) {
            "around" => AdviceHow::Around,
            "before" => AdviceHow::Before,
            "after" => AdviceHow::After,
            "override" => AdviceHow::Override,
            "before-until" => AdviceHow::BeforeUntil,
            "before-while" => AdviceHow::BeforeWhile,
            "after-until" => AdviceHow::AfterUntil,
            "after-while" => AdviceHow::AfterWhile,
            "filter-args" => AdviceHow::FilterArgs,
            "filter-return" => AdviceHow::FilterReturn,
            _ => return None,
        })
    }
}

#[derive(Clone)]
pub(crate) struct Advice {
    how: AdviceHow,
    function: Function,
    /// The name it can be referred to by, from advice-add's PROPS.
    name: Option<String>,
    /// Where it goes among the others: -100 outermost, 100 innermost.
    depth: f64,
}

impl Editor {
    /// A symbol's cells, interned if new, as `intern` makes a symbol.
    pub(crate) fn symbol_mut(&mut self, name: &str) -> &mut Symbol {
        if !self.symbols.contains_key(name) {
            self.symbols.insert(name.to_string(), Symbol::default());
        }
        self.symbols.get_mut(name).expect("just interned")
    }

    pub(crate) fn var(&self, name: &str) -> Option<&Variable> {
        self.symbols.get(name)?.variable.as_ref()
    }

    /// A hook's global functions.
    pub(crate) fn global_hook(&self, name: &str) -> &[HookEntry] {
        self.symbols.get(name).map_or(&[], |s| &s.hook)
    }

    // Functions

    /// Names a function for code to call by name, as Emacs's `defun`. A
    /// command of that name stops being one, as a `defun` without an
    /// interactive spec makes it; advice on the name stays.
    pub fn defun(&mut self, name: &str, function: Function) {
        let symbol = self.symbol_mut(name);
        symbol.function = Some(Definition::Function(function));
        symbol.function_source = None;
    }

    /// Notes where a name's function was defined, as loading a file records
    /// its `defun`s in Emacs's `load-history`.
    pub fn set_function_source(&mut self, name: &str, source: Option<String>) {
        self.symbol_mut(name).function_source = source;
    }

    /// The file that defined a name, as Emacs's `symbol-file`: its function
    /// (`defun`), its variable (`defvar`) or its face (`defface`), or with
    /// no `kind`, whichever it has. Only what a script file defined has one:
    /// a package E8 ships gives its name in the source tree, as
    /// `packages/files.ts`.
    pub fn symbol_file(&self, name: &str, kind: Option<&str>) -> Option<String> {
        let function = || match self.symbols.get(name)?.function.as_ref()? {
            Definition::Command(c) => c.source.clone(),
            _ => self.symbols.get(name)?.function_source.clone(),
        };
        let variable = || self.var(name)?.source.clone();
        let face = || self.face(name)?.source.clone();
        match kind {
            None => function().or_else(variable).or_else(face),
            Some("defun") => function(),
            Some("defvar") => variable(),
            Some("defface") => face(),
            Some(_) => None,
        }
    }

    /// Makes a name call another's function, or a function, as Emacs's `defalias`.
    pub fn defalias(&mut self, name: &str, definition: &Value) -> Result<()> {
        let definition = match definition {
            Value::Function(f) => Definition::Function(f.clone().with_name(name)),
            Value::Str(target) | Value::Symbol(target) if target == name => {
                return Err(Error::signal("cyclic-function-indirection", format!("Symbol\u{2019}s chain of function indirections contains a loop: {name}"), vec![definition.clone()]));
            }
            Value::Str(target) | Value::Symbol(target) => Definition::Alias(target.clone()),
            other => return Err(Error::signal("wrong-type-argument", format!("Wrong type argument: functionp, {other}"), vec![other.clone()])),
        };
        self.symbol_mut(name).function = Some(definition);
        Ok(())
    }

    /// Empties a name's function cell, as Emacs's `fmakunbound`.
    pub fn fmakunbound(&mut self, name: &str) {
        if let Some(symbol) = self.symbols.get_mut(name) {
            symbol.function = None;
        }
    }

    /// Whether a name is a function or a command, as Emacs's `fboundp`.
    pub fn fboundp(&self, name: &str) -> bool {
        self.symbols.get(name).is_some_and(|s| s.function.is_some())
    }

    /// What a name's function cell holds, as Emacs's `symbol-function`.
    pub fn definition(&self, name: &str) -> Option<&Definition> {
        self.symbols.get(name)?.function.as_ref()
    }

    /// The definition a name ends at, following aliases, with the name it
    /// was found under, as Emacs's `indirect-function`.
    fn indirect_definition<'a>(&'a self, name: &'a str) -> Option<(&'a str, &'a Definition)> {
        let mut name = name;
        for _ in 0..100 {
            match self.definition(name)? {
                Definition::Alias(target) => name = target,
                definition => return Some((name, definition)),
            }
        }
        None
    }

    /// The function a name holds, as Emacs's `symbol-function`, following
    /// aliases; a command's is a function that calls it.
    pub fn symbol_function(&self, name: &str) -> Option<Function> {
        match self.indirect_definition(name)? {
            (_, Definition::Function(f)) => Some(f.clone()),
            (target, Definition::Command(_)) => {
                let target = Value::Symbol(target.to_string());
                Some(Function::new(Some(name), move |ed, args| ed.funcall(&target, args)))
            }
            (_, Definition::Alias(_)) => None,
        }
    }

    /// Calls a function, or the function or command a name holds, as
    /// Emacs's `funcall`, through the name's advice. A command is called
    /// with its parameters made from the values, and returns null.
    pub fn funcall(&mut self, function: &Value, args: &[Value]) -> Result<Value> {
        match function {
            Value::Function(f) => f.call(self, args),
            Value::Str(name) | Value::Symbol(name) => {
                let Some((target, definition)) = self.indirect_definition(name) else {
                    return Err(Error::signal("void-function", format!("Symbol\u{2019}s function definition is void: {name}"), vec![function.clone()]));
                };
                match definition.clone() {
                    Definition::Function(f) => {
                        let advice = self.advice_on(name, target);
                        self.call_advised(&advice, &f, args)
                    }
                    Definition::Command(command) => {
                        let args = self.args_from_values(&command, args)?;
                        let name = name.clone();
                        self.call(&name, args)?;
                        Ok(Value::Null)
                    }
                    Definition::Alias(_) => unreachable!("indirect_definition follows aliases"),
                }
            }
            other => Err(Error::signal("invalid-function", format!("Invalid function: {other}"), vec![other.clone()])),
        }
    }

    // Commands

    /// Adds a command, replacing any function or command of the same name.
    pub fn define_command(&mut self, command: Command) {
        let name = command.name.clone();
        self.symbol_mut(&name).function = Some(Definition::Command(Rc::new(command)));
    }

    /// The command a name holds, following aliases.
    pub fn command(&self, name: &str) -> Option<Rc<Command>> {
        match self.indirect_definition(name)? {
            // An alias runs as itself, so it is this-command and its advice applies.
            (target, Definition::Command(command)) if target != name => Some(Rc::new(command.aliased(name))),
            (_, Definition::Command(command)) => Some(command.clone()),
            _ => None,
        }
    }

    /// A command's arguments from values, as funcall and advice pass them:
    /// a buffer by its name, and counts and prefix arguments left out
    /// taken from the prefix argument, as an &optional one is nil.
    fn args_from_values(&self, command: &Command, values: &[Value]) -> Result<Vec<Arg>> {
        let mut args = Vec::new();
        for (p, v) in command.params.iter().zip(values) {
            let v = match v {
                Value::Buffer(id) => self.buffer_with_id(*id).map_or(Value::Null, |i| Value::Str(self.buffers[i].name.clone())),
                Value::Process(id) => self.process_info(*id).map_or(Value::Null, |p| Value::Str(p.name)),
                v => v.clone(),
            };
            args.push(Arg::from_value(p.kind, &v)?);
        }
        Ok(args)
    }

    /// All commands, sorted by name; aliases are left out.
    pub fn commands(&self) -> impl Iterator<Item = &Command> {
        self.symbols.values().filter_map(|s| match &s.function {
            Some(Definition::Command(c)) => Some(c.as_ref()),
            _ => None,
        })
    }

    /// The names that run commands, aliases included, sorted, as M-x completes them.
    pub fn command_names(&self) -> impl Iterator<Item = &str> {
        self.symbols.keys().map(String::as_str).filter(|name| self.command(name).is_some())
    }

    /// Runs a command's body with its arguments, through any advice on it.
    pub(crate) fn run_command_body(&mut self, command: &Rc<Command>, args: &[Arg]) -> Result<()> {
        let advice = self.advice_on(&command.name, command.alias_of.as_deref().unwrap_or(&command.name));
        if advice.is_empty() {
            return (command.run)(self, args);
        }
        let body = command.clone();
        let base = Function::new(Some(&command.name), move |ed, values| {
            let mut args = ed.args_from_values(&body, values)?;
            if args.len() < body.params.len() && body.params[args.len()..].iter().all(|p| p.kind.optional()) {
                let prefix = ed.current_prefix_arg();
                for p in &body.params[args.len()..] {
                    args.push(ed.state_arg(p.kind, prefix)?);
                }
            }
            if args.len() != body.params.len() {
                return Err(Error::signal("wrong-number-of-arguments", format!("{} takes {} arguments, got {}", body.name, body.params.len(), args.len()), Vec::new()));
            }
            (body.run)(ed, &args).map(|()| Value::Null)
        });
        let values: Vec<Value> = args.iter().map(Arg::to_value).collect();
        self.call_advised(&advice, &base, &values).map(drop)
    }

    // Symbol properties

    /// Gives a symbol a property, as Emacs's `put`.
    pub fn put(&mut self, symbol: &str, property: &str, value: Value) {
        self.symbol_mut(symbol).plist.insert(property.to_string(), value);
    }

    /// A symbol's property, as Emacs's `get`.
    pub fn get(&self, symbol: &str, property: &str) -> Option<&Value> {
        self.symbols.get(symbol)?.plist.get(property)
    }

    // Advice

    /// Advises a name's function, as Emacs's `advice-add`: calls to it by
    /// name, from keys, M-x, `funcall` or hooks, go through the advice,
    /// which stays when the function is defined again. The newest is
    /// outermost among those of its depth. Advice of the same `name`, or
    /// without one the same function, is moved to where the new one goes.
    pub fn advice_add(&mut self, symbol: &str, how: AdviceHow, function: Function, name: Option<&str>, depth: f64) {
        let advice = Advice { how, function, name: name.map(str::to_string), depth: depth.clamp(-100.0, 100.0) };
        let list = &mut self.symbol_mut(symbol).advice;
        // Advice already there goes, to be added again where its depth puts
        // it: by its name if it has one, else by the function.
        list.retain(|a| match &advice.name {
            Some(name) => a.name.as_ref() != Some(name),
            None => a.function != advice.function,
        });
        let at = list.iter().position(|a| a.depth >= advice.depth).unwrap_or(list.len());
        list.insert(at, advice);
    }

    /// Takes advice off a name's function, as Emacs's `advice-remove`: by
    /// the function, or by the name it was given.
    pub fn advice_remove(&mut self, symbol: &str, function: &Value) {
        if let Some(s) = self.symbols.get_mut(symbol) {
            s.advice.retain(|a| match function {
                Value::Function(f) => a.function != *f,
                other => a.name.as_deref() != other.as_str(),
            });
        }
    }

    /// Whether a function, or advice of that name, advises a name's function,
    /// as Emacs's `advice-member-p`.
    pub fn advice_member_p(&self, function: &Value, symbol: &str) -> bool {
        self.symbols.get(symbol).is_some_and(|s| {
            s.advice.iter().any(|a| match function {
                Value::Function(f) => a.function == *f,
                other => a.name.as_deref() == other.as_str(),
            })
        })
    }

    /// Whether a name's function has advice, its own or its alias's.
    pub fn advised(&self, symbol: &str) -> bool {
        let target = self.indirect_definition(symbol).map_or(symbol, |(target, _)| target);
        !self.advice_on(symbol, target).is_empty()
    }

    /// The advice a call by `name` goes through: the name's own, then the
    /// one its alias leads to, as each symbol's function cell carries its own.
    fn advice_on(&self, name: &str, target: &str) -> Rc<[Advice]> {
        let own = self.symbols.get(name).map_or(&[][..], |s| &s.advice[..]);
        if name == target {
            return own.into();
        }
        let theirs = self.symbols.get(target).map_or(&[][..], |s| &s.advice[..]);
        own.iter().chain(theirs).cloned().collect()
    }

    /// Calls `base` through `advice`, outermost first.
    fn call_advised(&mut self, advice: &Rc<[Advice]>, base: &Function, args: &[Value]) -> Result<Value> {
        call_through(self, advice.clone(), 0, base, args)
    }
}

fn call_through(ed: &mut Editor, chain: Rc<[Advice]>, at: usize, base: &Function, args: &[Value]) -> Result<Value> {
    let Some(advice) = chain.get(at).cloned() else {
        return base.call(ed, args);
    };
    let inner = |ed: &mut Editor, args: &[Value]| call_through(ed, chain.clone(), at + 1, base, args);
    let f = &advice.function;
    Ok(match advice.how {
        AdviceHow::Around => {
            let (chain, base) = (chain.clone(), base.clone());
            let name = base.name().map(str::to_string);
            let original = Function::new(name.as_deref(), move |ed, args| call_through(ed, chain.clone(), at + 1, &base, args));
            let mut with = vec![Value::Function(original)];
            with.extend_from_slice(args);
            f.call(ed, &with)?
        }
        AdviceHow::Before => {
            f.call(ed, args)?;
            inner(ed, args)?
        }
        AdviceHow::After => {
            let value = inner(ed, args)?;
            f.call(ed, args)?;
            value
        }
        AdviceHow::Override => f.call(ed, args)?,
        AdviceHow::BeforeUntil => match f.call(ed, args)? {
            v if v.is_true() => v,
            _ => inner(ed, args)?,
        },
        AdviceHow::BeforeWhile => match f.call(ed, args)? {
            v if v.is_true() => inner(ed, args)?,
            v => v,
        },
        AdviceHow::AfterUntil => match inner(ed, args)? {
            v if v.is_true() => v,
            _ => f.call(ed, args)?,
        },
        AdviceHow::AfterWhile => match inner(ed, args)? {
            v if v.is_true() => f.call(ed, args)?,
            v => v,
        },
        AdviceHow::FilterArgs => match f.call(ed, &[Value::List(args.to_vec())])? {
            Value::List(args) => inner(ed, &args)?,
            Value::Null => inner(ed, &[])?,
            other => return Err(Error::signal("wrong-type-argument", format!("Wrong type argument: listp, {other}"), vec![other])),
        },
        AdviceHow::FilterReturn => {
            let value = inner(ed, args)?;
            f.call(ed, &[value])?
        }
    })
}
