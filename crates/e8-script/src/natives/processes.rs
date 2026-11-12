//! Processes, as Emacs's process.c gives them to Lisp: each a `Process`
//! object, which every function here takes, or its name ([ADR 0070]).
//!
//! [ADR 0070]: ../../../../docs/adr/0070-processes-as-emacs-has-them.md

use crate::*;
use crate::natives::{natives, Fields, Proc, ProcObj, Record, Rest};

natives! {
    fn makeProcess(
        ed,
        name: String,
        buffer: Option<String>,
        command: Vec<String>,
        options: Fields,
        filter: Option<EditorValue>,
        sentinel: Option<EditorValue>,
    ) -> ProcObj {
        let spec = e8_core::ProcessSpec {
            name,
            buffer,
            command,
            directory: options.string("directory"),
            env: match options.get("env") {
                Some(EditorValue::List(pairs)) => pairs
                    .iter()
                    .filter_map(|kv| match kv {
                        EditorValue::List(kv) => Some((kv.first()?.as_str()?.to_string(), kv.get(1)?.as_str()?.to_string())),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            merge_stderr: options.get("stderr").is_none_or(EditorValue::is_true),
            stderr_buffer: options.string("stderr"),
            filter: handler(filter),
            sentinel: handler(sentinel),
            pty: options.flag("pty"),
            coding: coding_pair(options.get("coding"))?,
        };
        let name = ed.make_process(spec)?;
        Ok(ProcObj(ed.process_named(&name).expect("just started")))
    }

    fn makeNetworkProcess(ed, options: Fields, filter: Option<EditorValue>, sentinel: Option<EditorValue>) -> ProcObj {
        let spec = e8_core::NetworkSpec {
            name: options.string("name").ok_or_else(|| Error::new("A network process needs a name"))?,
            buffer: options.string("buffer"),
            host: options.string("host"),
            service: options.get("service").map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_string)).unwrap_or_default(),
            server: options.flag("server"),
            filter: handler(filter),
            sentinel: handler(sentinel),
            coding: coding_pair(options.get("coding"))?,
        };
        let name = ed.make_network_process(spec)?;
        Ok(ProcObj(ed.process_named(&name).expect("just opened")))
    }

    /// The processes, oldest first, as process-list: those running, and
    /// those that have ended until their sentinel has run.
    pub fn processList(ed) -> Vec<ProcObj> {
        Ok(ed.process_ids().into_iter().map(ProcObj).collect())
    }

    /// The process of a name, as get-process; a process is itself.
    pub fn getProcess(ed, process: Proc) -> Option<ProcObj> {
        Ok(match process {
            Proc::Id(id) => Some(ProcObj(id)),
            Proc::Name(name) => ed.process_named(&name).map(ProcObj),
        })
    }

    fn getBufferProcess(ed, buffer: String) -> Option<ProcObj> {
        Ok(ed.buffer_process_id(&buffer).map(ProcObj))
    }

    /// Whether a value is a process, as processp: a process object, listed
    /// or gone; its name is not one.
    #[ts = "(value: unknown): value is Process"]
    pub fn processp(ed, value: EditorValue) -> bool {
        Ok(matches!(value, EditorValue::Process(_)))
    }

    /// Write to a process's input, encoded in its coding, as process-send-string.
    pub fn processSendString(ed, process: Proc, text: String) {
        let name = process.listed_name(ed)?;
        ed.process_send_string(&name, &text)
    }

    /// Make a process see the end of its input, as process-send-eof: C-d on a terminal, else its input closed.
    pub fn processSendEof(ed, process: Proc) {
        let name = process.listed_name(ed)?;
        ed.process_send_eof(&name)
    }

    /// Kill a process and forget it, as delete-process: its sentinel runs.
    /// One that has gone already is left as it is.
    pub fn deleteProcess(ed, process: Proc) {
        match process {
            Proc::Id(id) => match ed.listed_process_name(id) {
                Some(name) => ed.delete_process(&name),
                None => Ok(()),
            },
            Proc::Name(name) => ed.delete_process(&name),
        }
    }

    /// Whether exiting asks first while the process runs, as set-process-query-on-exit-flag.
    pub fn setProcessQueryOnExitFlag(ed, process: Proc, query: bool) {
        let name = process.listed_name(ed)?;
        ed.set_process_query_on_exit(&name, query)
    }

    /// Wait for output from a process, or any with none named, for up to
    /// `seconds`, or until some comes, as accept-process-output: it goes to
    /// the filters meanwhile, and timers run, but keys wait. Whether output came.
    #[ts = "(process?: ProcessLike, seconds?: number): boolean"]
    pub fn acceptProcessOutput(ed, process: Option<Proc>, seconds: Option<f64>) -> bool {
        match process {
            Some(p) => {
                let id = p.id(ed)?;
                ed.wait_for_process_output_id(Some(id), seconds)
            }
            None => ed.wait_for_process_output_id(None, seconds),
        }
    }

    /// The rest of process.c's functions on a process, by their Lisp names.
    fn processPrimitive(ed, op: String, process: Proc, args: Rest<EditorValue>) -> EditorValue {
        process_primitive(ed, &op, &process, &args.0)
    }

    /// What can be asked of a process, listed or gone, or undefined for a
    /// name no listed process has.
    fn processInfo(ed, process: Proc) -> Option<Record> {
        let Some(p) = process.id_if_any(ed).and_then(|id| ed.process_info(id)) else { return Ok(None) };
        let code = match p.status {
            e8_core::ProcessStatus::Run => None,
            e8_core::ProcessStatus::Exit(c) | e8_core::ProcessStatus::Signal(c) => Some(c),
        };
        Ok(Some(
            Record::new()
                .with("name", p.name)
                .with("status", p.status_name)
                .with("exitStatus", code)
                .with("buffer", p.buffer)
                .with("mark", p.mark)
                .with("command", p.command)
                .with("pid", p.pid)
                .with("queryOnExit", p.query_on_exit)
                .with("listed", p.listed),
        ))
    }

    /// Give a process a filter, called with the process and each piece of
    /// its output, as set-process-filter: null for the default, which
    /// inserts it at the process mark, and true, as Emacs's t, to hold its
    /// output back until another filter is set. Returns the filter.
    #[ts = "<F extends ((process: Process, output: string) => void) | string | symbol | true | null | undefined>(process: ProcessLike, filter: F): F"]
    pub fn setProcessFilter(ed, process: Proc, filter: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_filter(id, filter.clone());
        Ok(filter)
    }

    /// Give a process a sentinel, called with the process and a word on
    /// what happened, as "finished\n", when its status changes, as
    /// set-process-sentinel: null for the default, a line in its buffer.
    /// Returns the sentinel.
    #[ts = "<F extends ((process: Process, event: string) => void) | string | symbol | null | undefined>(process: ProcessLike, sentinel: F): F"]
    pub fn setProcessSentinel(ed, process: Proc, sentinel: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_sentinel(id, sentinel.clone());
        Ok(sentinel)
    }

    /// A process's filter as set, or null for the default.
    fn processFilterSet(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(ed.process_filter(id).unwrap_or(EditorValue::Null))
    }

    /// A process's sentinel as set, or null for the default.
    fn processSentinelSet(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(ed.process_sentinel(id).unwrap_or(EditorValue::Null))
    }

    /// What a process's filter does by default, as
    /// internal-default-process-filter: the text inserted at the process
    /// mark in its buffer, point moving along if it was there.
    pub fn internalDefaultProcessFilter(ed, process: Proc, text: String) {
        let id = process.id(ed)?;
        ed.internal_default_process_filter(id, &text);
        Ok(())
    }

    /// What a process's sentinel does by default, as
    /// internal-default-process-sentinel: a line "Process NAME EVENT" at the
    /// process mark in its buffer.
    pub fn internalDefaultProcessSentinel(ed, process: Proc, event: String) {
        let id = process.id(ed)?;
        ed.internal_default_process_sentinel(id, &event);
        Ok(())
    }

    /// A process's property list, as process-plist: property and value in turn.
    #[ts = "(process: ProcessLike): Value[]"]
    pub fn processPlist(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(match ed.process_plist(id) {
            EditorValue::Null => EditorValue::List(Vec::new()),
            plist => plist,
        })
    }

    /// Replace a process's property list, as set-process-plist. Returns it.
    #[ts = "(process: ProcessLike, plist: Value[]): Value[]"]
    pub fn setProcessPlist(ed, process: Proc, plist: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_plist(id, plist.clone())?;
        Ok(plist)
    }

    fn callProcess(ed, command: Vec<String>, directory: Option<String>, input: Option<String>) -> Record {
        let (code, output) = ed.call_process(&command, directory.as_deref(), input.as_deref())?;
        Ok(Record::new().with("exit", code).with("output", output))
    }
}

/// A filter or sentinel as make-process's :filter and :sentinel take it:
/// a function, a name, or for a filter t; nil for the default.
fn handler(value: Option<EditorValue>) -> Option<EditorValue> {
    value.filter(|v| !v.is_nil())
}

/// The signal a name gives, as signal-process takes them: "SIGINT", "int", or a number.
fn signal_number(value: Option<&EditorValue>) -> Option<i32> {
    match value? {
        EditorValue::Number(n) => Some(*n as i32),
        v => e8_core::process::signal_number(v.as_str()?),
    }
}

fn process_primitive(ed: &mut Editor, op: &str, process: &Proc, args: &[EditorValue]) -> e8_core::Result<EditorValue> {
    let flag = |i: usize| args.get(i).is_some_and(EditorValue::is_true);
    // What can be asked of a process that has gone.
    match op {
        "process-coding-system" => {
            return Ok(match process.id_if_any(ed).and_then(|id| ed.process_coding_system_of(id)) {
                Some((d, e)) => EditorValue::List(vec![EditorValue::Str(d.name()), EditorValue::Str(e.name())]),
                None => EditorValue::Null,
            });
        }
        "process-type" => {
            return Ok(process.id_if_any(ed).and_then(|id| ed.process_info(id)).map_or(EditorValue::Null, |p| EditorValue::Str(p.kind.into())));
        }
        // A signal to a process that has gone does nothing, as to one that has exited.
        "signal-process" if matches!(process, Proc::Id(id) if ed.listed_process_name(*id).is_none()) => return Ok(EditorValue::Null),
        _ => {}
    }
    let name = match process {
        Proc::Id(id) => match ed.listed_process_name(*id) {
            Some(name) => name,
            None if matches!(op, "process-tty-name" | "process-contact") => return Ok(EditorValue::Null),
            None => return Err(process.listed_name(ed).expect_err("not listed")),
        },
        Proc::Name(name) => name.clone(),
    };
    let name = name.as_str();
    Ok(match op {
        "set-process-coding-system" => {
            let coding = |i: usize| -> e8_core::Result<e8_core::coding::Coding> {
                let n = args.get(i).and_then(EditorValue::as_str).unwrap_or("undecided");
                e8_core::coding::Coding::parse(n).ok_or_else(|| e8_core::Error::new(format!("Invalid coding system: {n}")))
            };
            ed.set_process_coding_system(name, coding(0)?, coding(1)?)?;
            EditorValue::Null
        }
        "process-tty-name" => ed.process_tty_name(name).map_or(EditorValue::Null, EditorValue::Str),
        "process-contact" => match ed.process_contact(name) {
            None => EditorValue::Bool(true),
            Some((c, server)) => {
                let s = |x: Option<String>| x.map_or(EditorValue::Null, EditorValue::Str);
                match args.first().and_then(EditorValue::as_str).map(|k| k.trim_start_matches(':')) {
                    None => EditorValue::List(vec![s(c.host), EditorValue::Str(c.service)]),
                    Some("host") => s(c.host),
                    Some("service") => EditorValue::Str(c.service),
                    Some("remote") => s(c.remote),
                    Some("server") => EditorValue::Bool(server),
                    Some(_) => EditorValue::Null,
                }
            }
        },
        "set-process-window-size" => {
            let n = |i: usize| args.get(i).and_then(EditorValue::as_number).unwrap_or(0.0) as u16;
            EditorValue::Bool(ed.set_process_window_size(name, n(0), n(1))?)
        }
        "signal-process" => {
            let signal = signal_number(args.first()).ok_or_else(|| e8_core::Error::new("Undefined signal name"))?;
            ed.signal_process_group(name, signal, flag(1))?;
            EditorValue::Null
        }
        _ => return Err(e8_core::Error::new(format!("No process primitive {op}"))),
    })
}
