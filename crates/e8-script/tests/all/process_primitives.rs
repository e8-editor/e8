//! The rest of process.c and callproc.c that packages call (ADR 0070,
//! stage 2): call-process-region and call-shell-region, pipe processes,
//! the system's processes and network interfaces, getenv-internal,
//! signal-names, process-running-child-p, format-network-address,
//! network-lookup-address-info, the inherit-coding flag and
//! waiting-for-user-input-p. What Emacs does was checked with Emacs 30.2
//! in batch, as each test says; its positions count from 1, E8's from 0.

use std::time::Duration;

use e8_core::Editor;
use e8_script::Scripting;

use crate::driven::Driven;

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

/// A fresh buffer holding `text`, current, with point at `point`.
fn buffer_with(ed: &mut Editor, s: &Scripting, text: &str, point: usize) {
    let name = value(ed, s, "e8.generateNewBufferName('in')");
    ed.switch_to_buffer(&name);
    eval(ed, s, &format!("e8.insert({}); e8.gotoChar({point});", serde_json::to_string(text).unwrap()));
}

/// The accessible text and point, as buffer-string and point.
fn current(ed: &mut Editor, s: &Scripting) -> String {
    value(ed, s, &format!("JSON.stringify([{BUFFER_STRING}, e8.point()])"))
}

const BUFFER_STRING: &str = "e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())";

fn buffer_string(ed: &mut Editor, s: &Scripting) -> String {
    value(ed, s, BUFFER_STRING)
}

/// Emacs 30: with "hello world\nfoo\n" and point at 3,
/// (call-process-region 1 6 "tr" nil t nil "a-z" "A-Z") is 0 and leaves
/// "heHELLOllo world\nfoo\n" with point at 8, after the output.
#[test]
fn the_output_goes_in_at_point_and_point_follows_it() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "hello world\nfoo\n", 2);
    assert_eq!(value(&mut ed, &s, r#"e8.callProcessRegion(0, 5, "tr", null, true, null, "a-z", "A-Z")"#), "0");
    assert_eq!(current(&mut ed, &s), r#"["heHELLOllo world\nfoo\n",7]"#);
}

/// Emacs 30: with DELETE, the region goes first, and the output goes in at
/// point where the deletion left it: point at 3 gives "HELLO world" with
/// point at 6, point at 8 " wHELLOorld" with point at 8.
#[test]
fn deleting_takes_the_region_out_before_the_output_goes_in() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "hello world\nfoo\n", 2);
    assert_eq!(value(&mut ed, &s, r#"e8.callProcessRegion(0, 5, "tr", true, true, null, "a-z", "A-Z")"#), "0");
    assert_eq!(current(&mut ed, &s), r#"["HELLO world\nfoo\n",5]"#);
    buffer_with(&mut ed, &s, "hello world\nfoo\n", 7);
    eval(&mut ed, &s, r#"e8.callProcessRegion(0, 5, "tr", true, true, null, "a-z", "A-Z");"#);
    assert_eq!(current(&mut ed, &s), r#"[" wHELLOorld\nfoo\n",7]"#);
    // Positions in either order, as (call-process-region 3 1 "cat" nil t).
    buffer_with(&mut ed, &s, "abc", 3);
    eval(&mut ed, &s, r#"e8.callProcessRegion(2, 0, "cat", null, true);"#);
    assert_eq!(current(&mut ed, &s), r#"["abcab",5]"#);
}

/// Emacs 30: a START of nil sends the whole buffer, its narrowing aside, and
/// with DELETE deletes all of it; a region outside the narrowing is
/// args-out-of-range.
#[test]
fn a_start_of_nil_is_the_whole_buffer_narrowed_or_not() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "hello world\nfoo\n", 4);
    eval(&mut ed, &s, "e8.narrowToRegion(2, 7);");
    assert_eq!(value(&mut ed, &s, r#"e8.callProcessRegion(null, null, "cat", null, true)"#), "0");
    assert_eq!(current(&mut ed, &s), r#"["llhello world\nfoo\no w",20]"#);
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.callProcessRegion(0, 2, "cat", null, true), { "args-out-of-range": () => "out" })"#),
        "out"
    );
    buffer_with(&mut ed, &s, "b\na\n", 0);
    eval(&mut ed, &s, "e8.narrowToRegion(0, 2);");
    eval(&mut ed, &s, r#"e8.callProcessRegion(null, null, "sort", true, true); e8.widen();"#);
    assert_eq!(buffer_string(&mut ed, &s), "a\nb\n");
}

/// Emacs 30: a string START is the input, END ignored; deleting it is
/// wrong-type-argument integer-or-marker-p.
#[test]
fn a_string_start_is_the_input() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "abc", 3);
    assert_eq!(value(&mut ed, &s, r#"e8.callProcessRegion("xyz\n", 2, "cat", null, true)"#), "0");
    assert_eq!(buffer_string(&mut ed, &s), "abcxyz\n");
    assert_eq!(
        value(
            &mut ed,
            &s,
            r#"e8.conditionCase(() => e8.callProcessRegion("xyz\n", null, "cat", true, true), { "wrong-type-argument": (e) => e.message })"#
        ),
        "Wrong type argument: integer-or-marker-p, \"xyz\\n\""
    );
}

/// Emacs 30 on macOS: exit 3 gives 3; kill -9 "Killed: 9" and kill -15
/// "Terminated: 15", strsignal's words, which on Linux have no number; a
/// destination of 0 does not wait and gives nil; a missing program is
/// file-missing, the region deleted before.
#[test]
fn it_returns_the_exit_code_or_the_signal_or_nothing() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "abc", 0);
    assert_eq!(value(&mut ed, &s, r#"e8.callProcessRegion(0, 3, "sh", null, null, null, "-c", "exit 3")"#), "3");
    let killed = value(&mut ed, &s, r#"e8.callProcessRegion(0, 3, "sh", null, null, null, "-c", "kill -9 $$")"#);
    assert!(killed.starts_with("Killed"), "{killed}");
    let terminated = value(&mut ed, &s, r#"e8.callProcessRegion(0, 3, "sh", null, null, null, "-c", "kill -15 $$")"#);
    assert!(terminated.starts_with("Terminated"), "{terminated}");
    assert_eq!(value(&mut ed, &s, r#"String(e8.callProcessRegion(0, 3, "sh", null, 0, null, "-c", "exit 3"))"#), "undefined");
    // Emacs 30: (call-process "true" nil 1), 2 or -1 are nil too, not waited for.
    for n in ["1", "2", "-1"] {
        assert_eq!(value(&mut ed, &s, &format!(r#"String(e8.callProcessRegion(0, 3, "true", null, {n}))"#)), "undefined");
    }
    assert_eq!(
        value(
            &mut ed,
            &s,
            r#"JSON.stringify(e8.conditionCase(() => e8.callProcessRegion(0, 3, "nonexistent-program-e8", true, true), { "file-missing": (e) => e.data }))"#
        ),
        r#"["Searching for program","No such file or directory","nonexistent-program-e8"]"#
    );
    assert_eq!(buffer_string(&mut ed, &s), "");
}

/// Emacs 30: a buffer name gets output and standard error at its point,
/// made if there is none; ("*out*" nil) throws standard error away,
/// ("*out*" t) keeps it, ("*out*" FILE) writes it to FILE, and
/// (:file FILE) writes both to FILE.
#[test]
fn destinations_as_call_process_takes_them() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let err = dir.path().join("err.txt");
    let out = dir.path().join("out.txt");
    buffer_with(&mut ed, &s, "abc", 0);
    let run = |ed: &mut Editor, destination: &str| {
        value(ed, &s, &format!(r#"e8.callProcessRegion(0, 3, "sh", null, {destination}, null, "-c", "cat; echo err >&2")"#))
    };
    assert_eq!(run(&mut ed, r#""*out*""#), "0");
    assert_eq!(buffer_text(&ed, "*out*"), "abcerr\n");
    assert_eq!(value(&mut ed, &s, r#"e8.withCurrentBuffer("*out*", () => e8.point())"#), "7");
    run(&mut ed, r#"["*out2*", null]"#);
    assert_eq!(buffer_text(&ed, "*out2*"), "abc");
    run(&mut ed, r#"["*out3*", true]"#);
    assert_eq!(buffer_text(&ed, "*out3*"), "abcerr\n");
    run(&mut ed, &format!(r#"["*out4*", {}]"#, serde_json::to_string(&err).unwrap()));
    assert_eq!(buffer_text(&ed, "*out4*"), "abc");
    assert_eq!(std::fs::read_to_string(&err).unwrap(), "err\n");
    run(&mut ed, &format!(r#"[":file", {}]"#, serde_json::to_string(&out).unwrap()));
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "abcerr\n");
    // A buffer object as well as a name.
    run(&mut ed, r#"e8.getBufferCreate("*b*")"#);
    assert_eq!(buffer_text(&ed, "*b*"), "abcerr\n");
    // Nothing went into the current buffer.
    assert_eq!(buffer_string(&mut ed, &s), "abc");
}

/// Emacs 30: (call-shell-region 1 2 "cat; echo hi" nil t) in "q", with
/// shell-file-name /bin/sh, is 0 and leaves "qqhi\n".
#[test]
fn call_shell_region_runs_the_shell() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.setVariable("shell-file-name", "/bin/sh");"#);
    buffer_with(&mut ed, &s, "q", 1);
    assert_eq!(value(&mut ed, &s, r#"subr.callShellRegion(0, 1, "cat; echo hi", null, true)"#), "0");
    assert_eq!(buffer_string(&mut ed, &s), "qqhi\n");
}

/// Emacs 30: a pipe process is "open", of type pipe, with no pid; as
/// make-process's :stderr it takes the program's standard error, and when
/// the program has ended it is "closed", exit status 0, its sentinel told
/// "finished\n", and gone from process-list. What is sent to it goes nowhere.
#[test]
fn a_pipe_process_takes_a_programs_standard_error() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.log = [];
        globalThis.err = e8.makePipeProcess({ name: "err", buffer: "*err*", noquery: true,
          sentinel: (p, e) => log.push(["pipe", e, e8.processStatus(p)]) });"#,
    );
    assert_eq!(
        value(
            &mut ed,
            &s,
            r#"JSON.stringify([e8.processStatus(err), e8.processType(err), e8.processId(err) ?? null, e8.processLiveP(err),
              e8.processQueryOnExitFlag(err), e8.processp(err), err.name, e8.processBuffer(err)])"#
        ),
        r#"["open","pipe",null,true,false,true,"err","*err*"]"#
    );
    eval(&mut ed, &s, r#"e8.processSendString(err, "hi\n");"#);
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.processRunningChildP(err), { error: (e) => e.message })"#),
        "Process err is not a subprocess"
    );
    eval(
        &mut ed,
        &s,
        r#"globalThis.p = e8.makeProcess({ name: "x", buffer: "*out*", connectionType: "pipe", stderr: err,
          command: ["sh", "-c", "echo out; echo err >&2; echo err2 >&2"],
          sentinel: (p, e) => log.push(["proc", e]) });"#,
    );
    until(&mut ed, &s, "!e8.processLiveP(p) && !e8.processLiveP(err)");
    assert_eq!(buffer_text(&ed, "*out*"), "out\n");
    assert_eq!(buffer_text(&ed, "*err*"), "err\nerr2\n");
    assert_eq!(
        value(&mut ed, &s, r#"JSON.stringify([e8.processStatus(err), e8.processExitStatus(err), e8.processList().includes(err)])"#),
        r#"["closed",0,false]"#
    );
    let log = value(&mut ed, &s, "JSON.stringify(log)");
    assert!(log.contains(r#"["pipe","finished\n","closed"]"#), "{log}");
    assert!(log.contains(r#"["proc","finished\n"]"#), "{log}");
}

/// Emacs 30: deleting a pipe process tells its sentinel "finished\n", and
/// the default sentinel says so in its buffer, after what came.
#[test]
fn a_pipe_process_deleted_or_ended_says_finished() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.log = [];
        globalThis.e = e8.makePipeProcess({ name: "e", sentinel: (p, ev) => log.push([ev, e8.processStatus(p), e8.processExitStatus(p)]) });
        e8.deleteProcess(e);"#,
    );
    assert_eq!(value(&mut ed, &s, "JSON.stringify(log)"), r#"[["finished\n","closed",0]]"#);
    eval(
        &mut ed,
        &s,
        r#"globalThis.e2 = e8.makePipeProcess({ name: "e", buffer: "*e2*" });
        globalThis.p = e8.makeProcess({ name: "x", buffer: "*o2*", connectionType: "pipe", stderr: e2, command: ["sh", "-c", "echo err >&2"] });"#,
    );
    until(&mut ed, &s, "!e8.processLiveP(e2)");
    assert_eq!(buffer_text(&ed, "*e2*"), "err\n\nProcess e finished\n");
    // A pipe process already handed to a program cannot be handed to another.
    assert!(
        value(
            &mut ed,
            &s,
            r#"e8.conditionCase(() => { e8.makeProcess({ name: "y", command: ["true"], connectionType: "pipe", stderr: e2 }); return "ran"; }, { error: (e) => e.message })"#
        )
        .contains("not an open pipe process")
    );
}

/// Emacs 30: process-running-child-p is nil for a program alone on its
/// terminal, the job's group for a shell running one, and for a program
/// on pipes, where E8 cannot tell, t (Emacs on macOS says 0 there).
#[test]
fn process_running_child_p_looks_at_the_terminals_foreground_job() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"globalThis.alone = e8.makeProcess({ name: "alone", command: ["sleep", "5"], connectionType: "pty" });"#);
    assert_eq!(value(&mut ed, &s, "String(e8.processRunningChildP(alone))"), "undefined");
    eval(&mut ed, &s, r#"globalThis.piped = e8.makeProcess({ name: "piped", command: ["sleep", "5"], connectionType: "pipe" });"#);
    assert_eq!(value(&mut ed, &s, "String(e8.processRunningChildP(piped))"), "true");
    eval(&mut ed, &s, r#"globalThis.sh = e8.makeProcess({ name: "sh", command: ["sh", "-i"], connectionType: "pty", filter: () => {} });"#);
    ed.accept_process_output(Duration::from_millis(200));
    eval(&mut ed, &s, r#"e8.processSendString(sh, "sleep 5\n");"#);
    until(&mut ed, &s, "typeof e8.processRunningChildP(sh) === 'number'");
    assert_ne!(value(&mut ed, &s, "e8.processRunningChildP('sh')"), value(&mut ed, &s, "String(e8.processId(sh))"));
    eval(&mut ed, &s, "e8.deleteProcess(alone); e8.deleteProcess(piped); e8.deleteProcess(sh);");
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.processRunningChildP(alone), { error: (e) => e.message })"#),
        "Process alone is not active"
    );
}

/// Emacs 30 on macOS: (signal-names) runs from USR2 down to HUP, then
/// EXIT, without "SIG"; signal-process takes each.
#[test]
fn signal_names_lists_the_systems_signals() {
    let (mut ed, s) = setup();
    let names: Vec<String> = serde_json::from_str(&value(&mut ed, &s, "JSON.stringify(e8.signalNames())")).unwrap();
    assert_eq!(names.last().map(String::as_str), Some("EXIT"));
    assert_eq!(names[names.len() - 2], "HUP");
    for name in ["INT", "KILL", "TERM", "USR1", "USR2", "CHLD", "WINCH"] {
        assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
    }
    #[cfg(target_os = "macos")]
    assert_eq!(
        names,
        "USR2 USR1 INFO WINCH PROF VTALRM XFSZ XCPU IO TTOU TTIN CHLD CONT TSTP STOP URG TERM ALRM PIPE SYS SEGV BUS KILL FPE EMT ABRT TRAP ILL QUIT INT HUP EXIT"
            .split(' ')
            .collect::<Vec<_>>()
    );
    eval(&mut ed, &s, r#"globalThis.p = e8.makeProcess({ name: "u", command: ["sleep", "5"], connectionType: "pipe" }); e8.signalProcess(p, "USR1");"#);
    until(&mut ed, &s, "!e8.processLiveP(p)");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(p)"), "signal");
}

/// Emacs 30: (getenv-internal "FOO" '("FOO=bar" "BAZ")) is "bar", "BAZ"
/// alone is t, a name not in the list nil though it is in the
/// environment, the first of two wins; without a list, the environment.
#[test]
fn getenv_internal_looks_in_the_list_given() {
    let (mut ed, s) = setup();
    assert_eq!(
        value(
            &mut ed,
            &s,
            r#"JSON.stringify([
              e8.getenvInternal("FOO", ["FOO=bar", "BAZ"]), e8.getenvInternal("BAZ", ["FOO=bar", "BAZ"]),
              e8.getenvInternal("HOME", ["FOO=bar"]) ?? null, e8.getenvInternal("FOO", ["FOO=bar", "FOO=two"]),
              e8.getenvInternal("FO", ["FOO=bar"]) ?? null,
              e8.getenvInternal("HOME") === e8.getenv("HOME"), e8.getenvInternal("E8_SURELY_UNSET_VARIABLE") ?? null])"#
        ),
        r#"["bar",true,null,"bar",null,true,null]"#
    );
}

/// Emacs 30's outputs, each.
#[test]
fn format_network_address_writes_addresses_as_emacs_does() {
    let (mut ed, s) = setup();
    let cases = [
        ("[127, 0, 0, 1, 80]", "127.0.0.1:80"),
        ("[127, 0, 0, 1, 80], true", "127.0.0.1"),
        ("[127, 0, 0, 1]", "127.0.0.1"),
        ("[127, 0, 0, 1, 0]", "127.0.0.1:0"),
        ("[0, 0, 0, 0, 0, 0, 0, 1, 80]", "[0:0:0:0:0:0:0:1]:80"),
        ("[0, 0, 0, 0, 0, 0, 0, 1, 80], true", "0:0:0:0:0:0:0:1"),
        ("[0, 0, 0, 0, 0, 0, 0, 1]", "0:0:0:0:0:0:0:1"),
        ("[8193, 3512, 0, 0, 0, 0, 0, 1, 443]", "[2001:db8:0:0:0:0:0:1]:443"),
        ("[8193, 3512, 0, 0, 0, 0, 65535, 1]", "2001:db8:0:0:0:0:ffff:1"),
        (r#""/tmp/sock""#, "/tmp/sock"),
        ("[1, 2, 3]", "undefined"),
        ("[300, 0, 0, 1, 80]", "undefined"),
        ("[-1, 0, 0, 1, 80]", "undefined"),
        ("null", "undefined"),
        ("7", "undefined"),
        // A port beyond 16 bits, or an element out of its range, is none.
        ("[1, 2, 3, 4, 99999]", "undefined"),
        ("[1, 2, 3, 4, -1]", "undefined"),
        ("[1, 2, 3, 4, 65535]", "1.2.3.4:65535"),
        ("[1, 2, 3, 4, 65536]", "undefined"),
        ("[1, 2, 3, 4, 99999], true", "undefined"),
        ("[256, 0, 0, 1]", "undefined"),
        ("[0, 0, 0, 0, 0, 0, 0, 65536, 80]", "undefined"),
        ("[0, 0, 0, 0, 0, 0, 0, 1, 99999]", "undefined"),
        ("[0, 0, 0, 0, 0, 0, 0, 1, -1]", "undefined"),
        ("[1.5, 2, 3, 4]", "undefined"),
    ];
    for (args, want) in cases {
        assert_eq!(value(&mut ed, &s, &format!("String(e8.formatNetworkAddress({args}))")), want, "{args}");
    }
}

/// Emacs 30: "127.0.0.1" gives ([127 0 0 1 0]), numerically too; "localhost"
/// numerically nil, and for ipv4 ([127 0 0 1 0]); "::1" ([0 0 0 0 0 0 0 1
/// 0]); an unknown family is an error.
#[test]
fn network_lookup_address_info_resolves_names() {
    let (mut ed, s) = setup();
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.networkLookupAddressInfo("127.0.0.1"))"#), "[[127,0,0,1,0]]");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.networkLookupAddressInfo("127.0.0.1", null, "numeric"))"#), "[[127,0,0,1,0]]");
    assert_eq!(value(&mut ed, &s, r#"String(e8.networkLookupAddressInfo("localhost", null, "numeric"))"#), "undefined");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.networkLookupAddressInfo("localhost", "ipv4"))"#), "[[127,0,0,1,0]]");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.networkLookupAddressInfo("::1"))"#), "[[0,0,0,0,0,0,0,1,0]]");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.networkLookupAddressInfo("::1", "ipv4") ?? null)"#), "null");
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.networkLookupAddressInfo("localhost", "foo"), { error: (e) => e.message })"#),
        "Unsupported family"
    );
}

/// Emacs 30 on macOS: lo0's IPv4 entry is ("lo0" . [127 0 0 1 0]), with
/// FULL ("lo0" [127 0 0 1 0] [127 255 255 255 0] [255 0 0 0 0]), and
/// (network-interface-info "lo0") ([127 0 0 1 0] nil [255 0 0 0 0] nil
/// (multicast running loopback up)); an unknown interface nil.
#[test]
fn network_interfaces_list_the_loopback() {
    let (mut ed, s) = setup();
    let lo = value(&mut ed, &s, r#"e8.networkInterfaceList(null, "ipv4").find(([, a]) => a[0] === 127)?.[0]"#);
    assert!(lo == "lo0" || lo == "lo", "{lo}");
    let entry = |ed: &mut Editor, full: &str| {
        value(ed, &s, &format!(r#"JSON.stringify(e8.networkInterfaceList({full}).find(([n, a]) => n === "{lo}" && a.length === 5 && a[0] === 127))"#))
    };
    assert_eq!(entry(&mut ed, "null"), format!(r#"["{lo}",[127,0,0,1,0]]"#));
    assert_eq!(entry(&mut ed, "true"), format!(r#"["{lo}",[127,0,0,1,0],[127,255,255,255,0],[255,0,0,0,0]]"#));
    assert_eq!(value(&mut ed, &s, r#"String(e8.networkInterfaceList(null, "ipv6").every(([, a]) => a.length === 9))"#), "true");
    let info = value(&mut ed, &s, &format!(r#"JSON.stringify(e8.networkInterfaceInfo("{lo}"))"#));
    let info: serde_json::Value = serde_json::from_str(&info).unwrap();
    assert_eq!(info[0], serde_json::json!([127, 0, 0, 1, 0]));
    assert_eq!(info[1], serde_json::Value::Null);
    assert_eq!(info[2], serde_json::json!([255, 0, 0, 0, 0]));
    let flags = info[4].as_array().unwrap();
    assert!(flags.contains(&"up".into()) && flags.contains(&"loopback".into()), "{flags:?}");
    assert_eq!(flags.last(), Some(&"up".into()));
    assert_eq!(value(&mut ed, &s, r#"String(e8.networkInterfaceInfo("nonexist0"))"#), "undefined");
}

/// Emacs 30 on macOS: (process-attributes (emacs-pid)) has euid, user,
/// egid, group, comm, state, ppid, pgrp, tpgid, utime, stime, time,
/// majflt, nice, start, etime, vsize, rss, thcount and args, in the
/// reverse of that order; a pid with no process nil. list-system-processes
/// has the editor's own, in increasing order.
#[test]
fn process_attributes_describe_the_editors_own_process() {
    let (mut ed, s) = setup();
    let attrs = value(&mut ed, &s, "JSON.stringify(e8.processAttributes(e8.emacsPid()))");
    let attrs: Vec<(String, serde_json::Value)> = serde_json::from_str(&attrs).unwrap();
    let get = |key: &str| attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_else(|| panic!("no {key} in {attrs:?}"));
    let me = std::process::id();
    assert_eq!(get("ppid"), serde_json::json!(parent_pid(me)));
    assert_eq!(get("euid"), serde_json::json!(effective_uid()));
    assert!(get("user").as_str().is_some_and(|u| !u.is_empty()));
    let exe = std::env::current_exe().unwrap();
    let name = exe.file_name().unwrap().to_string_lossy();
    let comm = get("comm").as_str().unwrap().to_string();
    assert!(name.starts_with(&comm), "{comm} for {name}");
    assert!(get("args").as_str().unwrap().contains(&*name));
    assert!(get("rss").as_f64().unwrap() > 0.0);
    assert!(get("thcount").as_f64().unwrap() >= 1.0);
    assert!(get("etime").as_f64().unwrap() >= 0.0);
    assert!(get("start").as_f64().unwrap() > 1.7e9);
    assert!(["R", "S"].contains(&get("state").as_str().unwrap()));
    // Emacs's order: the last found first.
    assert_eq!(attrs.last().map(|(k, _)| k.as_str()), Some("euid"));
    assert_eq!(attrs.first().map(|(k, _)| k.as_str()), Some("args"));
    assert_eq!(value(&mut ed, &s, "String(e8.processAttributes(2147483000))"), "undefined");
    let pids: Vec<u32> = serde_json::from_str(&value(&mut ed, &s, "JSON.stringify(e8.listSystemProcesses())")).unwrap();
    assert!(pids.contains(&me));
    assert!(pids.windows(2).all(|w| w[0] < w[1]));
}

/// The test's parent, as ps reports it.
fn parent_pid(pid: u32) -> u32 {
    let out = std::process::Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

/// The effective user id, as `id -u` gives it.
fn effective_uid() -> u32 {
    let out = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

/// Emacs 30: the flag is nil for a process started without
/// inherit-process-coding-system, and set-process-inherit-coding-system-flag
/// returns what it sets, which process-inherit-coding-system-flag gives
/// back, for a pipe process too, and after a process has gone.
#[test]
fn the_inherit_coding_flag_is_kept() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"globalThis.p = e8.makeProcess({ name: "i", buffer: "*i*", command: ["true"], connectionType: "pipe" });"#);
    assert_eq!(value(&mut ed, &s, "String(e8.processInheritCodingSystemFlag(p))"), "false");
    assert_eq!(value(&mut ed, &s, "String(e8.setProcessInheritCodingSystemFlag(p, true))"), "true");
    until(&mut ed, &s, "!e8.processLiveP(p)");
    assert_eq!(value(&mut ed, &s, "String(e8.processInheritCodingSystemFlag(p))"), "true");
    eval(&mut ed, &s, r#"globalThis.pp = e8.makePipeProcess({ name: "pp" });"#);
    assert_eq!(
        value(&mut ed, &s, "JSON.stringify([e8.setProcessInheritCodingSystemFlag(pp, true), e8.processInheritCodingSystemFlag(pp)])"),
        "[true,true]"
    );
    eval(&mut ed, &s, "e8.deleteProcess(pp);");
}

/// Emacs 30: nil from code a command runs, as in batch; true in a filter
/// the command loop runs while it waits for a key, or while a prompt
/// does; nil while sleep-for waits, which reads no keys though E8 runs
/// them meanwhile, and in a filter accept-process-output runs.
#[test]
fn waiting_for_user_input_p_is_true_only_while_waiting_for_keys() {
    let d = Driven::new(
        r#"globalThis.seen = { idle: [], sleeping: [], prompting: [], accepting: [] };
        globalThis.phase = "idle";
        globalThis.p = e8.makeProcess({ name: "w", command: ["sh", "-c", "while true; do echo x; sleep 0.05; done"], connectionType: "pipe",
          filter: () => seen[phase].push(e8.waitingForUserInputP()) });"#,
    );
    let wait_for = |what: &str| {
        let start = std::time::Instant::now();
        while d.eval_expression(&format!("seen.{what}.length > 2")) != "true" {
            assert!(start.elapsed() < Duration::from_secs(10), "no output while {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait_for("idle");
    d.start_eval(r#"phase = "sleeping"; e8.sleepFor(0.6); phase = "idle";"#);
    wait_for("sleeping");
    d.eval(r#"phase = "accepting"; e8.acceptProcessOutput(p, 0.3); e8.acceptProcessOutput(p, 0.3); phase = "idle";"#);
    d.start_eval(r#"phase = "prompting"; e8.readString("Say: ");"#);
    wait_for("prompting");
    d.press("C-g");
    d.eval(r#"phase = "idle"; e8.deleteProcess(p);"#);
    let all = |what: &str, want: bool| {
        let got: Vec<bool> = serde_json::from_str(&d.eval_expression(&format!("seen.{what}"))).unwrap();
        assert!(!got.is_empty() && got.iter().all(|b| *b == want), "{what}: {got:?}");
    };
    all("sleeping", false);
    all("accepting", false);
    all("prompting", true);
    assert!(d.eval_expression("seen.idle.includes(true)") == "true");
    assert_eq!(d.eval_expression("e8.waitingForUserInputP()"), "false");
}

/// As Emacs opens the file as the program's standard error, nothing waits
/// for what the program leaves running with it open.
#[test]
fn standard_error_to_a_file_does_not_wait_for_what_is_left_running() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let err = dir.path().join("err.txt");
    buffer_with(&mut ed, &s, "abc", 0);
    let started = std::time::Instant::now();
    let code = value(
        &mut ed,
        &s,
        &format!(
            r#"e8.callProcessRegion(0, 3, "sh", null, ["*o*", {}], null, "-c", "sleep 30 >/dev/null & echo err >&2; cat")"#,
            serde_json::to_string(&err).unwrap()
        ),
    );
    assert_eq!(code, "0");
    assert!(started.elapsed() < Duration::from_secs(10), "waited {:?}", started.elapsed());
    assert_eq!(buffer_text(&ed, "*o*"), "abc");
    assert_eq!(std::fs::read_to_string(&err).unwrap(), "err\n");
}

/// Emacs 30: output for a read-only buffer is buffer-read-only, the buffer
/// left as it was; so is deleting the region of a read-only current buffer.
#[test]
fn a_read_only_destination_is_buffer_read_only() {
    let (mut ed, s) = setup();
    buffer_with(&mut ed, &s, "abc", 0);
    eval(&mut ed, &s, r#"e8.withCurrentBuffer(e8.getBufferCreate("*ro*"), () => { e8.insert("x"); e8.setReadOnly(true); });"#);
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.callProcessRegion(0, 3, "cat", null, "*ro*"), { "buffer-read-only": () => "ro" })"#),
        "ro"
    );
    assert_eq!(buffer_text(&ed, "*ro*"), "x");
    eval(&mut ed, &s, "e8.setReadOnly(true);");
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.callProcessRegion(0, 3, "cat", true, true), { "buffer-read-only": () => "ro" })"#),
        "ro"
    );
    assert_eq!(buffer_string(&mut ed, &s), "abc");
}

/// Emacs 30: deleting the region and inserting the output leave no
/// boundary between them in buffer-undo-list, so one undo takes back both.
#[test]
fn deleting_and_inserting_undo_as_one() {
    let (mut ed, s) = setup();
    ed.switch_to_buffer("undo");
    ed.type_text("hello");
    eval(&mut ed, &s, r#"e8.callProcessRegion(0, 5, "tr", true, true, null, "a-z", "A-Z");"#);
    assert_eq!(buffer_string(&mut ed, &s), "HELLO");
    // Emacs: ((1 . 6) ("hello" . -1) 6 nil ...), the insertion and the
    // deletion with no boundary between.
    let list: serde_json::Value = serde_json::from_str(&value(&mut ed, &s, "JSON.stringify(e8.bufferUndoList())")).unwrap();
    assert_eq!(list[0], serde_json::json!([0, 5]));
    assert_eq!(list[1][0]["string"], "hello");
}

/// Emacs 30: process-running-child-p on a program that has ended, in its
/// sentinel or after, is "Process NAME is not active".
#[test]
fn a_program_that_has_ended_has_no_running_child() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.said = undefined;
        globalThis.p = e8.makeProcess({ name: "t", command: ["true"], connectionType: "pty",
          sentinel: (p) => { said = e8.conditionCase(() => String(e8.processRunningChildP(p)), { error: (e) => e.message }); } });"#,
    );
    until(&mut ed, &s, "said !== undefined");
    assert_eq!(value(&mut ed, &s, "said"), "Process t is not active");
    assert_eq!(
        value(&mut ed, &s, r#"e8.conditionCase(() => e8.processRunningChildP(p), { error: (e) => e.message })"#),
        "Process t is not active"
    );
}
