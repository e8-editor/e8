//! What programs run with and how processes talk, after Emacs's callproc.c,
//! env.el and process.c: process-environment, setenv and getenv, exec-path,
//! call-process as Emacs takes it, the coding alists, output that runs the
//! change hooks, stopped connections and pipe processes, connections made
//! with :nowait, datagrams, and a failed lookup. What Emacs does was
//! checked with Emacs 30.2 in batch on macOS, as each test says.

use std::time::Duration;

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    eval(
        &mut ed,
        &s,
        r#"globalThis.res = (f) => e8.conditionCase(() => { const v = f(); return JSON.stringify(v === undefined ? "nil" : v); },
             { error: (e) => JSON.stringify([e.symbol, ...(e.symbol === "error" && e.data.length === 0 ? [e.message] : e.data.map((d) => (typeof d === "symbol" ? d.description : d)))]) });
           globalThis.out = (f) => { const b = e8.getBufferCreate(" *out*"); return e8.withCurrentBuffer(b, () => { e8.deleteRegion(e8.pointMin(), e8.pointMax()); f(); return e8.bufferText(); }); };"#,
    );
    // The packages' own functions, for code here to call.
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("globals.ts");
    std::fs::write(&module, r#"import * as env from "env"; import * as subr from "subr"; Object.assign(globalThis, { env, subr });"#).unwrap();
    s.load_module(&mut ed, &module).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// What `code`, a function's body, gives or signals, as `res` writes it.
fn res(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    value(ed, s, &format!("res(() => {code})"))
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

/// Emacs 30: after (setenv "E8TEST" "bar") a program sees bar; after
/// (setenv "E8TEST") process-environment starts with "E8TEST", getenv
/// gives nil and a program sees it unset.
#[test]
fn setenv_changes_what_programs_are_given() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"env.setenv("E8TEST", "bar");"#);
    assert_eq!(value(&mut ed, &s, r#"out(() => e8.callProcess("sh", null, true, false, "-c", "echo $E8TEST"))"#), "bar\n");
    assert_eq!(value(&mut ed, &s, r#"e8.getenv("E8TEST")"#), "bar");
    eval(&mut ed, &s, r#"env.setenv("E8TEST");"#);
    assert_eq!(res(&mut ed, &s, r#"e8.getenv("E8TEST")"#), r#""nil""#);
    assert_eq!(value(&mut ed, &s, r#"e8.variable("process-environment")[0]"#), "E8TEST");
    assert_eq!(value(&mut ed, &s, r#"out(() => e8.callProcess("sh", null, true, false, "-c", "echo ${E8TEST-unset}"))"#), "unset\n");
    // Binding process-environment changes one program's.
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "process-environment": ["E8TEST=bound", ...e8.variable("process-environment")] }, () => out(() => e8.callProcess("sh", null, true, false, "-c", "echo $E8TEST")))"#),
        "bound\n"
    );
    // initial-environment keeps what E8 started with.
    assert_eq!(value(&mut ed, &s, r#"e8.variable("initial-environment").some((e) => e.startsWith("E8TEST"))"#), "false");
    // The command, with a prefix argument, unsets the variable.
    eval(&mut ed, &s, r#"env.setenv("E8TEST", "again");"#);
    ed.press("C-u M-x").unwrap();
    ed.type_text("setenv");
    ed.press("RET").unwrap();
    ed.type_text("E8TEST");
    ed.press("RET").unwrap();
    assert_eq!(res(&mut ed, &s, r#"e8.getenv("E8TEST")"#), r#""nil""#);
    ed.press("M-x").unwrap();
    ed.type_text("setenv");
    ed.press("RET").unwrap();
    ed.type_text("E8TEST");
    ed.press("RET").unwrap();
    ed.type_text("$HOME/x");
    ed.press("RET").unwrap();
    assert_eq!(value(&mut ed, &s, r#"e8.getenv("E8TEST") === e8.getenv("HOME") + "/x""#), "true");
}

/// Emacs 30: (substitute-env-vars "$HOME-x ${NOPE}y $$") is
/// "/Users/mark-x y $"; with WHEN-UNDEFINED t, "a$NOPE" stays; setenv-internal
/// takes B out of ("A=1" "B=2") without KEEP-EMPTY and puts "C=3" first;
/// (getenv-internal "A" '("A" "A=1")) is t.
#[test]
fn environment_lists_are_read_and_changed_as_env_el_does() {
    let (mut ed, s) = setup();
    let home = std::env::var("HOME").unwrap();
    assert_eq!(value(&mut ed, &s, r#"env.substituteEnvVars("$HOME-x ${NOPE}y $$")"#), format!("{home}-x y $"));
    assert_eq!(value(&mut ed, &s, r#"env.substituteEnvVars("a$NOPE", true)"#), "a$NOPE");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(env.setenvInternal(["A=1", "B=2"], "B", undefined, false))"#), r#"["A=1"]"#);
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(env.setenvInternal(["A=1", "B=2"], "C", "3", true))"#), r#"["C=3","A=1","B=2"]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.getenvInternal("A", ["A", "A=1"])"#), "true");
    assert_eq!(res(&mut ed, &s, r#"e8.getenvInternal("A", ["A=1"])"#), r#""1""#);
    // substitute-in-file-name reads process-environment too.
    eval(&mut ed, &s, r#"env.setenv("E8DIR", "/opt/e8");"#);
    assert_eq!(value(&mut ed, &s, r#"e8.substituteInFileName("$E8DIR/lib")"#), "/opt/e8/lib");
}

/// Emacs 30: (call-process "no-such-program-x") and, with exec-path
/// ("/nonexistent"), (call-process "ls") signal (file-missing "Searching
/// for program" "No such file or directory" NAME); a program is found along
/// exec-path, not along the PATH it is given.
#[test]
fn programs_are_found_along_exec_path() {
    let (mut ed, s) = setup();
    assert_eq!(
        res(&mut ed, &s, r#"e8.callProcess("no-such-program-x")"#),
        r#"["file-missing","Searching for program","No such file or directory","no-such-program-x"]"#
    );
    assert_eq!(
        res(&mut ed, &s, r#"e8.letBind({ "exec-path": ["/nonexistent"] }, () => e8.callProcess("ls"))"#),
        r#"["file-missing","Searching for program","No such file or directory","ls"]"#
    );
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("e8-hello");
    std::fs::write(&script, "#!/bin/sh\necho hello from exec-path\n").unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let dir_js = serde_json::to_string(&dir.path().display().to_string()).unwrap();
    assert_eq!(
        value(&mut ed, &s, &format!(r#"e8.letBind({{ "exec-path": [{dir_js}, ...e8.variable("exec-path")] }}, () => out(() => e8.callProcess("e8-hello", null, true)))"#)),
        "hello from exec-path\n"
    );
    eval(&mut ed, &s, &format!(r#"e8.setVariable("exec-path", [{dir_js}, ...e8.variable("exec-path")]);"#));
    assert_eq!(value(&mut ed, &s, r#"subr.executableFind("e8-hello")"#), script.display().to_string());
    eval(&mut ed, &s, r#"globalThis.seen = ""; e8.makeProcess({ name: "hello", command: ["e8-hello"], filter: (_p, t) => { seen += t; } });"#);
    until(&mut ed, &s, r#"seen.includes("\n")"#);
    assert_eq!(value(&mut ed, &s, "seen"), "hello from exec-path\n");
}

/// Emacs 30: with PWD set, a program running in default-directory /usr/
/// is given PWD=/usr, without the trailing slash.
#[test]
fn a_program_is_given_its_directory_as_pwd() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"env.setenv("PWD", "/somewhere");"#);
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "default-directory": "/usr/" }, () => out(() => e8.callProcess("sh", null, true, false, "-c", "echo $PWD")))"#),
        "/usr\n"
    );
}

/// Emacs 30: with process-coding-system-alist (("printf" . latin-1)),
/// (process-coding-system (start-process "x" nil "printf" "a")) is
/// (latin-1 . latin-1), and call-process decodes printf's output in it.
#[test]
fn process_coding_system_alist_chooses_a_programs_codings() {
    let (mut ed, s) = setup();
    let latin1 = value(&mut ed, &s, r#"e8.codingSystemBase("latin-1")"#);
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "process-coding-system-alist": [["printf", "latin-1"]] }, () => { const p = e8.makeProcess({ name: "x", command: ["printf", "a"] }); return JSON.stringify(e8.processCodingSystem(p).map((c) => e8.codingSystemBase(c))); })"#),
        format!(r#"["{latin1}","{latin1}"]"#)
    );
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "process-coding-system-alist": [["printf", "latin-1"]] }, () => out(() => e8.callProcess("printf", null, true, false, "caf\\351")))"#),
        "café"
    );
    // call-process-region encodes its input in the alist's coding too.
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "process-coding-system-alist": [["od", "latin-1"]] }, () => out(() => e8.callProcessRegion("é", null, "od", false, true, false, "-An", "-tx1")))"#).trim(),
        "e9"
    );
    // A coding-system-for-read bound wins over the alist.
    assert_eq!(
        value(&mut ed, &s, r#"e8.letBind({ "process-coding-system-alist": [["printf", "latin-1"]], "coding-system-for-read": "utf-8" }, () => out(() => e8.callProcess("printf", null, true, false, "caf\\303\\251")))"#),
        "café"
    );
}

/// Emacs 30: (call-process-region (point-min) (point-max) "cat" nil t t)
/// in a buffer holding "x" leaves "xx"; with DISPLAY the output is the
/// same, shown as it comes.
#[test]
fn call_process_takes_emacs_arguments_and_display() {
    let (mut ed, s) = setup();
    assert_eq!(
        value(&mut ed, &s, r#"out(() => { e8.insert("x"); e8.callProcessRegion(e8.pointMin(), e8.pointMax(), "cat", false, true, true); })"#),
        "xx"
    );
    assert_eq!(
        value(&mut ed, &s, r#"out(() => e8.callProcess("sh", null, true, true, "-c", "echo one; sleep 0.05; echo two; printf three"))"#),
        "one\ntwo\nthree"
    );
    // INFILE is the program's input; the result is its exit code.
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.txt");
    std::fs::write(&input, "from a file\n").unwrap();
    let input_js = serde_json::to_string(&input.display().to_string()).unwrap();
    assert_eq!(value(&mut ed, &s, &format!(r#"out(() => e8.callProcess("cat", {input_js}, true))"#)), "from a file\n");
    assert_eq!(res(&mut ed, &s, r#"e8.callProcess("sh", null, null, false, "-c", "exit 3")"#), "3");
    assert_eq!(res(&mut ed, &s, r#"e8.callProcess("sh", null, 0, false, "-c", "exit 3")"#), r#""nil""#);
    // E8's own shape still works.
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.callProcess(["sh", "-c", "echo hi"]))"#), r#"{"exit":0,"output":"hi\n"}"#);
}

/// Emacs's default filter inserts with insert_from_string_before_markers,
/// which runs the change hooks, and into a read-only buffer.
#[test]
fn process_output_runs_the_change_hooks() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.changes = [];
        const b = e8.getBufferCreate("*hooked*");
        e8.withCurrentBuffer(b, () => {
          e8.setVariable("buffer-read-only", true);
          e8.addHook("after-change-functions", (start: number, end: number, len: number) => changes.push([start, end, len]), { local: true });
        });
        e8.makeProcess({ name: "echo", buffer: "*hooked*", command: ["printf", "hi"], sentinel: () => {} });"#,
    );
    until(&mut ed, &s, "changes.length > 0");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(changes)"), "[[0,2,0]]");
    assert_eq!(value(&mut ed, &s, r#"e8.withCurrentBuffer("*hooked*", () => e8.bufferText())"#), "hi");
    assert_eq!(value(&mut ed, &s, r#"String(e8.withCurrentBuffer("*hooked*", () => e8.variable("buffer-read-only")))"#), "true");
}

/// Emacs 30: (make-pipe-process :name "p" :stop t) has status stop until
/// continue-process, then open; a stopped connection keeps what comes until
/// it is continued, when its filter is given it.
#[test]
fn pipe_processes_and_connections_can_be_stopped() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"globalThis.pipe = e8.makePipeProcess({ name: "p", stop: true });"#);
    assert_eq!(value(&mut ed, &s, "e8.processStatus(pipe)"), "stop");
    eval(&mut ed, &s, r#"e8.continueProcess(pipe);"#);
    assert_eq!(value(&mut ed, &s, "e8.processStatus(pipe)"), "open");
    eval(&mut ed, &s, "e8.deleteProcess(pipe);");

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    eval(&mut ed, &s, &format!(r#"globalThis.seen = ""; globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port}, filter: (_p, t) => {{ seen += t; }} }});"#));
    let (mut peer, _) = listener.accept().unwrap();
    eval(&mut ed, &s, "e8.stopProcess(cli);");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(cli)"), "stop");
    std::io::Write::write_all(&mut peer, b"held").unwrap();
    for _ in 0..10 {
        ed.accept_process_output(Duration::from_millis(20));
    }
    assert_eq!(value(&mut ed, &s, "seen"), "");
    eval(&mut ed, &s, "e8.continueProcess(cli);");
    until(&mut ed, &s, r#"seen === "held""#);
    assert_eq!(value(&mut ed, &s, "e8.processStatus(cli)"), "open");
    eval(&mut ed, &s, "e8.deleteProcess(cli);");
}

/// Emacs 30: a connection made with :nowait t has status connect, then
/// open, its sentinel told "open\n"; to a port nothing listens on, its
/// status is failed and its sentinel told "failed with code 61\n" on macOS,
/// ECONNREFUSED. Sending to it waits for the connection.
#[test]
fn a_connection_can_be_made_without_waiting() {
    let (mut ed, s) = setup();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    eval(
        &mut ed,
        &s,
        &format!(r#"globalThis.events = []; globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port}, nowait: true, sentinel: (_p, e) => events.push(e) }});"#),
    );
    let status = value(&mut ed, &s, "e8.processStatus(cli)");
    assert!(status == "connect" || status == "open", "{status}");
    eval(&mut ed, &s, r#"e8.processSendString(cli, "sent");"#);
    let (mut peer, _) = listener.accept().unwrap();
    let mut got = [0u8; 4];
    std::io::Read::read_exact(&mut peer, &mut got).unwrap();
    assert_eq!(&got, b"sent");
    until(&mut ed, &s, "events.length > 0");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(events)"), r#"["open\n"]"#);
    assert_eq!(value(&mut ed, &s, "e8.processStatus(cli)"), "open");
    eval(&mut ed, &s, "e8.deleteProcess(cli);");

    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    eval(
        &mut ed,
        &s,
        &format!(r#"globalThis.events = []; globalThis.bad = e8.makeNetworkProcess({{ name: "bad", host: "127.0.0.1", service: {closed_port}, nowait: true, sentinel: (_p, e) => events.push(e) }});"#),
    );
    until(&mut ed, &s, "events.length > 0");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(events)"), format!(r#"["failed with code {}\n"]"#, libc::ECONNREFUSED));
    assert_eq!(value(&mut ed, &s, "e8.processStatus(bad)"), "failed");
}

/// Emacs 30: a datagram server (make-network-process :type 'datagram
/// :server t) takes each datagram as one piece of output and sends back
/// to whoever sent the last; process-datagram-address gives that address,
/// and set-process-datagram-address changes it.
#[test]
fn datagrams_are_sent_and_taken() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.got = []; globalThis.srv = e8.makeNetworkProcess({ name: "srv", host: "127.0.0.1", service: true, server: true, type: "datagram", filter: (_p, t) => got.push(t) });"#,
    );
    let port: u16 = value(&mut ed, &s, r#"e8.processContact(srv, "service")"#).parse().unwrap();
    assert_eq!(res(&mut ed, &s, "e8.processDatagramAddress(srv)"), r#""nil""#);
    let peer = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    peer.send_to(b"one", ("127.0.0.1", port)).unwrap();
    peer.send_to(b"two", ("127.0.0.1", port)).unwrap();
    until(&mut ed, &s, "got.length === 2");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(got)"), r#"["one","two"]"#);
    let peer_port = peer.local_addr().unwrap().port();
    assert_eq!(res(&mut ed, &s, "e8.processDatagramAddress(srv)"), format!("[127,0,0,1,{peer_port}]"));
    eval(&mut ed, &s, r#"e8.processSendString(srv, "back");"#);
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buf = [0u8; 16];
    let n = peer.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"back");

    // A client sends to its host and port.
    let other = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    other.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let other_port = other.local_addr().unwrap().port();
    eval(&mut ed, &s, &format!(r#"globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port}, type: "datagram" }});"#));
    eval(&mut ed, &s, &format!(r#"e8.setProcessDatagramAddress(cli, [127, 0, 0, 1, {other_port}]); e8.processSendString(cli, "moved");"#));
    let n = other.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"moved");
    assert_eq!(res(&mut ed, &s, r#"e8.setProcessDatagramAddress(cli, "nonsense")"#), r#""nil""#);
    eval(&mut ed, &s, "e8.deleteProcess(cli); e8.deleteProcess(srv);");
}

/// Emacs 30: (network-lookup-address-info "no-such-host.invalid") gives nil
/// and says "no-such-host.invalid/0 nodename nor servname provided, or not
/// known", getaddrinfo's message; a name that is not ASCII is refused.
#[test]
fn a_name_that_does_not_resolve_is_reported() {
    let (mut ed, s) = setup();
    assert_eq!(res(&mut ed, &s, r#"e8.networkLookupAddressInfo("no-such-host.invalid")"#), r#""nil""#);
    let last = ed.messages().last().cloned().unwrap_or_default();
    assert!(last.starts_with("no-such-host.invalid/0 "), "{last}");
    assert_eq!(
        res(&mut ed, &s, r#"e8.networkLookupAddressInfo("bücher.example")"#),
        r#"["error","Non-ASCII hostname bücher.example detected, please use `puny-encode-domain'"]"#
    );
}

/// gnulib's sig2str, and so Emacs's signal-names, names Linux's signal 29
/// POLL, the name its table has before IO.
#[test]
fn signal_names_give_one_name_for_each_number() {
    let (mut ed, s) = setup();
    let names = value(&mut ed, &s, "JSON.stringify(e8.signalNames())");
    let names: Vec<String> = serde_json::from_str(&names).unwrap();
    let mut numbers: Vec<i32> = names.iter().filter(|n| *n != "EXIT" && !n.starts_with("RT")).map(|n| e8_core::process::signal_number(n).unwrap()).collect();
    let count = numbers.len();
    numbers.dedup();
    assert_eq!(numbers.len(), count, "{names:?}");
    if cfg!(target_os = "linux") {
        assert!(names.contains(&"POLL".to_string()) && !names.contains(&"IO".to_string()), "{names:?}");
    } else {
        assert!(names.contains(&"IO".to_string()), "{names:?}");
    }
}


/// Emacs 30: a stopped connection whose peer sends and closes neither gives
/// the output nor ends until continued; then the filter has the output
/// first and the sentinel runs after.
#[test]
fn a_stopped_connection_ends_only_once_continued() {
    let (mut ed, s) = setup();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    eval(
        &mut ed,
        &s,
        &format!(r#"globalThis.seen = []; globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port}, filter: (_p, t) => seen.push(t), sentinel: (_p, e) => seen.push(e) }});"#),
    );
    let (mut peer, _) = listener.accept().unwrap();
    eval(&mut ed, &s, "e8.stopProcess(cli);");
    std::io::Write::write_all(&mut peer, b"hi").unwrap();
    drop(peer);
    for _ in 0..15 {
        ed.accept_process_output(Duration::from_millis(20));
    }
    assert_eq!(value(&mut ed, &s, "JSON.stringify(seen)"), "[]");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(cli)"), "stop");
    eval(&mut ed, &s, "e8.continueProcess(cli);");
    until(&mut ed, &s, "seen.length === 2");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(seen)"), r#"["hi","connection broken by remote peer\n"]"#);
}

/// Emacs 30: process-send-eof waits for a :nowait connection, then shuts
/// its sending side; on a datagram process it does nothing, and :nowait
/// does not hold a datagram process up.
#[test]
fn sending_the_end_waits_for_the_connection_and_skips_datagrams() {
    let (mut ed, s) = setup();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    eval(&mut ed, &s, &format!(r#"globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port}, nowait: true }}); e8.processSendString(cli, "x"); e8.processSendEof(cli);"#));
    let (mut peer, _) = listener.accept().unwrap();
    let mut all = String::new();
    std::io::Read::read_to_string(&mut peer, &mut all).unwrap();
    assert_eq!(all, "x");
    eval(&mut ed, &s, &format!(r#"globalThis.dg = e8.makeNetworkProcess({{ name: "dg", host: "127.0.0.1", service: {port}, type: "datagram", nowait: true }}); e8.processSendEof(dg);"#));
    assert_eq!(value(&mut ed, &s, "e8.processStatus(dg)"), "open");
    // A name that does not resolve is an error at once, :nowait or not.
    assert!(res(&mut ed, &s, r#"e8.makeNetworkProcess({ name: "bad", host: "no-such-host.invalid", service: 80, nowait: true })"#).contains("file-error"));
}

/// Emacs's getenv_internal_1 passes over entries that are not strings, and
/// getenv-internal with nil looks in process-environment.
#[test]
fn getenv_passes_over_what_is_not_a_string() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.setVariable("process-environment", [null, "E8X=/x", ...e8.variable("process-environment")]);"#);
    assert_eq!(value(&mut ed, &s, r#"e8.getenv("E8X")"#), "/x");
    assert_eq!(res(&mut ed, &s, r#"e8.getenvInternal("E8X", [])"#), r#""/x""#);
}
