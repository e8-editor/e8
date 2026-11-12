//! Processes as objects, as Emacs's are (ADR 0070): the same object each
//! time, filters and sentinels set at any time and read back, a plist, and
//! answers about a process after it has gone. What Emacs does was checked
//! with Emacs 30.2 in batch, as each test says.

use std::time::Duration;

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "load.ts", r#"import("subr").then((m) => { globalThis.subr = m; });"#.into()).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

fn buffer_text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

fn until(ed: &mut Editor, s: &Scripting, done: &str) {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        ed.accept_process_output(Duration::from_millis(20));
        if s.eval_expression(ed, done).unwrap() == "true" {
            return;
        }
    }
    panic!("never: {done}");
}

/// Emacs 30: (processp (start-process "x" nil "true")) is t, (processp "x") nil.
#[test]
fn a_process_is_an_object_and_its_name_is_not_one() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"globalThis.p = e8.makeProcess({ name: "obj", buffer: "*obj*", command: ["sleep", "10"] });"#);
    let got = value(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.processp(p), e8.processp("obj"), subr.processp(p), subr.processp("obj"), e8.processp(undefined),
          String(p), `${p}`, p.name, p.live, JSON.stringify(p), subr.processName(p),
          p === e8.getProcess("obj"), p === subr.getProcess("obj"), p === subr.getProcess(p),
          p === e8.processList()[0], p === e8.getBufferProcess("*obj*"),
        ])"#,
    );
    assert_eq!(got, r##"[true,false,true,false,false,"obj","obj","obj",true,"\"#<process obj>\"","obj",true,true,true,true,true]"##);
    eval(&mut ed, &s, "e8.deleteProcess(p);");
}

/// The filter and sentinel are called with the process object, the one makeProcess gave.
#[test]
fn filters_and_sentinels_are_given_the_process_itself() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.same = [];
        globalThis.p = e8.makeProcess({ name: "same", command: ["echo", "hi"],
          filter: (proc) => same.push(proc === p && e8.processp(proc)),
          sentinel: (proc) => same.push(proc === p) });"#,
    );
    until(&mut ed, &s, "same.length === 2");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(same)"), "[true,true]");
}

/// As `(set-process-filter (start-process ...) f)`: set after starting, it
/// sees all the output, and nothing goes into the buffer.
#[test]
fn a_filter_set_after_starting_sees_all_the_output() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = "";
        globalThis.p = e8.makeProcess({ name: "late", buffer: "*late*", command: ["sh", "-c", "echo one; echo two"] });
        globalThis.returned = e8.setProcessFilter(p, (_p, text) => { seen += text; });
        globalThis.readBack = typeof returned === "function" && returned === e8.processFilter(p);"#,
    );
    until(&mut ed, &s, "!p.live");
    assert_eq!(value(&mut ed, &s, "seen"), "one\ntwo\n");
    assert_eq!(value(&mut ed, &s, "readBack"), "true");
    assert_eq!(buffer_text(&ed, "*late*"), "\nProcess late finished\n");
}

/// Emacs 30: process-filter of a new process is internal-default-process-filter,
/// and a filter wrapping it with funcall inserts at the process mark.
#[test]
fn the_default_filter_can_be_read_back_and_wrapped() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = "";
        globalThis.p = e8.makeProcess({ name: "wrap", buffer: "*wrap*", command: ["sh", "-c", "sleep 0.1; echo out"] });
        globalThis.old = e8.processFilter(p);
        globalThis.isDefault = old === e8.internalDefaultProcessFilter;
        e8.setProcessFilter(p, (proc, text) => { seen += text; e8.funcall(old, proc, text.toUpperCase()); });
        globalThis.wrapped = e8.processFilter(p) !== old;"#,
    );
    until(&mut ed, &s, "!p.live");
    assert_eq!(value(&mut ed, &s, "JSON.stringify([isDefault, wrapped, seen])"), r#"[true,true,"out\n"]"#);
    assert_eq!(buffer_text(&ed, "*wrap*"), "OUT\n\nProcess wrap finished\n");
    // By their Lisp names too.
    eval(
        &mut ed,
        &s,
        r#"globalThis.q = e8.makeProcess({ name: "wrap2", buffer: "*wrap2*", command: ["sleep", "10"] });
        e8.funcall("internal-default-process-filter", q, "by name;");
        e8.funcall("internal-default-process-sentinel", q, "noted\n");
        e8.setProcessSentinel(q, () => {});
        e8.deleteProcess(q);"#,
    );
    assert_eq!(buffer_text(&ed, "*wrap2*"), "by name;\nProcess wrap2 noted\n");
}

/// Emacs 30: set-process-filter or -sentinel with nil gives
/// internal-default-process-filter or -sentinel back.
#[test]
fn nil_sets_the_default_filter_and_sentinel() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.ran = [];
        globalThis.p = e8.makeProcess({ name: "nil", buffer: "*nil*", command: ["sh", "-c", "sleep 0.1; echo text"],
          filter: () => ran.push("filter"), sentinel: () => ran.push("sentinel") });
        e8.setProcessFilter(p, null);
        e8.setProcessSentinel(p, undefined);
        globalThis.back = [e8.processFilter(p) === e8.internalDefaultProcessFilter, e8.processSentinel(p) === e8.internalDefaultProcessSentinel];"#,
    );
    until(&mut ed, &s, "!p.live");
    assert_eq!(value(&mut ed, &s, "JSON.stringify([back, ran])"), "[[true,true],[]]");
    assert_eq!(buffer_text(&ed, "*nil*"), "text\n\nProcess nil finished\n");
}

/// As `(set-process-sentinel (start-process ...) f)`.
#[test]
fn a_sentinel_set_after_starting_is_told_the_end() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.events = [];
        globalThis.p = e8.makeProcess({ name: "sent", buffer: "*sent*", command: ["sh", "-c", "exit 3"] });
        e8.setProcessSentinel(p, (proc, event) => events.push([proc === p, event, e8.processStatus(proc), e8.processExitStatus(proc)]));"#,
    );
    until(&mut ed, &s, "events.length > 0");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(events)"), r#"[[true,"exited abnormally with code 3\n","exit",3]]"#);
    assert_eq!(buffer_text(&ed, "*sent*"), "", "the sentinel took the place of the default line");
}

/// Emacs 30: with a filter of t the output is not read; once another filter
/// is set it gets what was written meanwhile, in order. E8 reads on, holding
/// the output back, and gives it the same way.
#[test]
fn a_filter_of_t_holds_the_output_until_another_is_set() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = [];
        globalThis.p = e8.makeProcess({ name: "held", buffer: "*held*", command: ["sh", "-c", "echo one; echo two; sleep 0.6; echo three"] });
        e8.setProcessFilter(p, true);
        globalThis.isT = e8.processFilter(p) === true;"#,
    );
    ed.accept_process_output(Duration::from_millis(300));
    assert_eq!(buffer_text(&ed, "*held*"), "", "nothing given while the filter is t");
    assert_eq!(value(&mut ed, &s, "JSON.stringify([isT, p.live])"), "[true,true]");
    eval(&mut ed, &s, r#"e8.setProcessFilter(p, (_p, text) => seen.push(text));"#);
    assert_eq!(value(&mut ed, &s, "seen.length"), "0", "given on the next poll, not while setting it");
    until(&mut ed, &s, "!p.live");
    assert_eq!(value(&mut ed, &s, r#"seen.join("")"#), "one\ntwo\nthree\n");
}

/// Emacs 30: (process-put p 'foo 42), then (process-get p 'foo) in the
/// sentinel is 42, and process-plist is (foo 42).
#[test]
fn a_plist_kept_on_the_process_is_read_back_in_its_sentinel() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.read = [];
        globalThis.p = e8.makeProcess({ name: "plist", command: ["true"],
          sentinel: (proc) => read.push(subr.processGet(proc, Symbol.for("foo")), subr.processGet(proc, "missing")) });
        subr.processPut(p, Symbol.for("foo"), 41);
        subr.processPut("plist", Symbol.for("foo"), 42);
        subr.processPut(p, "bar", "b");
        globalThis.plist = e8.processPlist(p);"#,
    );
    until(&mut ed, &s, "read.length > 0");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(read)"), "[42,null]");
    assert_eq!(value(&mut ed, &s, "plist.length === 4 && plist[0] === Symbol.for(\"foo\") && plist[1] === 42 && plist[3] === \"b\""), "true");
    // Emacs 30: (set-process-plist p 3) signals wrong-type-argument listp.
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.setProcessPlist(p, 3), { "wrong-type-argument": () => "listp" })"#),
        "listp"
    );
}

/// Emacs 30, once a process has ended and its sentinel run: it is not in
/// process-list, get-process finds nothing by its name, and its object
/// still gives status exit, exit status 3, its name, command and plist.
#[test]
fn a_process_that_has_ended_answers_on_its_object() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.p = e8.makeProcess({ name: "gone", buffer: "*gone*", command: ["sh", "-c", "exit 3"] });
        subr.processPut(p, "k", "v");"#,
    );
    until(&mut ed, &s, "e8.processList().length === 0");
    let got = value(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.processStatus(p), e8.processExitStatus(p), e8.processName(p), p.name, e8.processBuffer(p),
          e8.processCommand(p), subr.processGet(p, "k"), e8.processLiveP(p), p.live, e8.processp(p),
          e8.processType(p), e8.getProcess("gone") === undefined, e8.processStatus("gone") === undefined,
          e8.acceptProcessOutput(p, 0),
        ])"#,
    );
    assert_eq!(got, r#"["exit",3,"gone","gone","*gone*",["sh","-c","exit 3"],"v",false,false,true,"real",true,true,false]"#);
}

/// Emacs 30, after delete-process: status signal, exit status 9, its name,
/// buffer, command and plist; deleting it again is nothing, and sending to
/// it is an error, "Process y not running".
#[test]
fn a_deleted_process_answers_on_its_object() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = [];
        globalThis.p = e8.makeProcess({ name: "y", buffer: "*y*", command: ["sleep", "10"] });
        e8.setProcessSentinel(p, (proc, event) => seen.push([e8.processStatus(proc), event, subr.processGet(proc, "k")]));
        subr.processPut(p, "k", "v");
        e8.deleteProcess(p);
        e8.deleteProcess(p);"#,
    );
    let got = value(
        &mut ed,
        &s,
        r#"JSON.stringify([
          seen, e8.processList().length, e8.processStatus(p), e8.processExitStatus(p), e8.processName(p),
          e8.processBuffer(p), e8.processCommand(p), e8.processPlist(p), p.live,
          e8.conditionCase(() => e8.processSendString(p, "x"), { error: (e) => e.message }),
        ])"#,
    );
    assert_eq!(got, r#"[[["signal","killed\n","v"]],0,"signal",9,"y","*y*",["sleep","10"],["k","v"],false,"Process y not running"]"#);
}

/// Emacs 30: a new process may take a name an old one had; the old one's
/// object goes on answering for itself, not for the new.
#[test]
fn a_name_taken_again_does_not_make_the_old_object_the_new_process() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"globalThis.old = e8.makeProcess({ name: "x", command: ["true"] });"#);
    until(&mut ed, &s, "!old.live");
    eval(
        &mut ed,
        &s,
        r#"globalThis.renewed = e8.makeProcess({ name: "x", command: ["sleep", "10"] });
        e8.deleteProcess(old);"#,
    );
    let got = value(
        &mut ed,
        &s,
        r#"JSON.stringify([
          old === renewed, String(renewed), e8.processStatus(old), e8.processStatus(renewed), e8.processStatus("x"),
          old.live, renewed.live, e8.getProcess("x") === renewed, e8.processCommand(old),
        ])"#,
    );
    assert_eq!(got, r#"[false,"x","exit","run","run",false,true,true,["true"]]"#);
    eval(&mut ed, &s, r#"e8.deleteProcess("x");"#);
    assert_eq!(value(&mut ed, &s, "JSON.stringify([e8.processStatus(renewed), e8.processStatus(old)])"), r#"["signal","exit"]"#);
}

/// Packages written before the objects pass names; every function still takes one.
#[test]
fn functions_still_take_a_process_by_name() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.out = [];
        e8.makeProcess({ name: "named", connectionType: "pipe", command: ["cat"] });
        e8.setProcessFilter("named", (proc, text) => out.push([e8.processp(proc), String(proc), text]));
        e8.setProcessSentinel("named", (proc, event) => out.push([event]));
        e8.setProcessQueryOnExitFlag("named", false);
        e8.setProcessCodingSystem("named", "utf-8-unix");
        subr.processPut("named", "k", 1);
        globalThis.before = [e8.processStatus("named"), e8.processLiveP("named"), e8.processQueryOnExitFlag("named"),
          e8.processCodingSystem("named"), e8.processType("named"), e8.processCommand("named"), subr.processGet("named", "k"),
          typeof e8.processFilter("named"), e8.processName("named")];
        e8.processSendString("named", "hello\n");"#,
    );
    until(&mut ed, &s, "out.length > 0");
    eval(&mut ed, &s, r#"e8.processSendEof("named");"#);
    until(&mut ed, &s, "out.length > 1");
    let got = value(&mut ed, &s, "JSON.stringify([before, out])");
    assert_eq!(
        got,
        r#"[["run",true,false,["utf-8-unix","utf-8-unix"],"real",["cat"],1,"function","named"],[[true,"named","hello\n"],["finished\n"]]]"#
    );
}
