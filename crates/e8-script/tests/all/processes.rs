//! Processes, as Emacs's make-process and call-process: output into a
//! buffer or a filter, sentinels when they end, input, signals, and the
//! agent's permission.

use std::time::Duration;

use crate::driven::Driven;
use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, scripting: &Scripting, source: &str) {
    scripting.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn buffer_text(ed: &Editor, name: &str) -> String {
    let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
    b.slice(0..b.len())
}

#[test]
fn output_goes_into_the_buffer_and_the_end_is_noted() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "echo", buffer: "*out*", command: ["sh", "-c", "echo hello; echo oops >&2"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    let text = buffer_text(&ed, "*out*");
    assert!(text.starts_with("hello\n"), "{text:?}");
    assert!(text.contains("oops\n"), "standard error comes in too: {text:?}");
    assert!(text.ends_with("\nProcess echo finished\n"), "{text:?}");
    assert!(ed.process_list().is_empty(), "an ended process is forgotten once noted");
}

#[test]
fn standard_error_can_have_a_buffer_of_its_own() {
    let (mut ed, s) = setup();
    // As make-process's :stderr: what goes to standard error is kept apart,
    // the filter seeing only the output, and the end noted only once both
    // have closed, the last of each first.
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = "";
        e8.makeProcess({
          name: "both", connectionType: "pipe", stderr: "*errors*",
          command: ["sh", "-c", "echo out; echo err >&2; echo é >&2; sleep 0.1; echo late >&2"],
          filter: (_p, text) => { seen += text; },
          sentinel: (_p, event) => { seen += "|" + event; },
        });"#,
    );
    until(&mut ed, &s, r#"seen.includes("|")"#);
    assert_eq!(s.eval_expression(&mut ed, "seen").unwrap(), r#""out\n|finished\n""#);
    assert_eq!(buffer_text(&ed, "*errors*"), "err\né\nlate\n");
}

#[test]
fn filters_and_sentinels_see_output_and_the_end() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        globalThis.seen = [];
        e8.makeProcess({
          name: "cat",
          command: ["cat"],
          filter: (p, out) => globalThis.seen.push(`${p}:${out}`),
          sentinel: (p, event) => { globalThis.seen.push(`${p} ${event}`); e8.message(globalThis.seen.join("|")); },
        });
        e8.processSendString("cat", "typed\n");
        e8.processSendEof("cat");
        "#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(ed.messages().last().map(String::as_str), Some("cat:typed\n|cat finished\n"));
}

#[test]
fn killing_ends_it_and_what_it_started() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"e8.makeProcess({ name: "sleeper", buffer: "*s*", command: ["sh", "-c", "sleep 30; echo late"], sentinel: (p, e) => e8.message(e) });"#,
    );
    assert_eq!(ed.process_list(), ["sleeper"]);
    assert!(ed.next_timer_in().is_some_and(|d| d <= Duration::from_millis(30)), "front ends wake to take output in");
    eval(&mut ed, &s, r#"e8.message(e8.processStatus("sleeper") ?? "none"); e8.interruptProcess("sleeper");"#);
    // Interrupted again while it runs on, as C-c C-c is pressed again:
    // dash, CI's sh, catches SIGINT under -c and loses one that comes while
    // it is starting or between commands rather than waiting for one, and
    // then the shell and its sleep both ran on. In a Linux container,
    // interrupted the moment it started, dash lost the first in 43 runs of
    // 500, and every run ended by the interrupt within the second.
    // accept_process_output returns as soon as the process has ended; the
    // time is for a runner busy with the whole suite.
    for _ in 0..10 {
        ed.accept_process_output(Duration::from_secs(2));
        if ed.process_list().is_empty() {
            break;
        }
        eval(&mut ed, &s, r#"e8.interruptProcess("sleeper");"#);
    }
    assert!(ed.messages().iter().any(|m| m == "run"));
    // What was still running, if it never ended, for a failure on CI.
    let left = || {
        let ps = std::process::Command::new("ps").args(["-A", "-o", "pid,ppid,pgid,stat,args"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        let ps = ps.unwrap_or_default().lines().filter(|l| l.contains("sleep 30")).collect::<Vec<_>>().join("\n");
        format!("processes {:?}, *s* {:?}, ps:\n{ps}", ed.process_list(), buffer_text(&ed, "*s*"))
    };
    assert_eq!(ed.messages().last().map(String::as_str), Some("interrupt\n"), "{}", left());
    assert!(!buffer_text(&ed, "*s*").contains("late"));
}

#[test]
fn call_process_waits_for_the_result() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        const r = e8.callProcess(["sh", "-c", "read x; echo got $x; exit 3"], { input: "it\n" });
        e8.message(`${r.exit} ${r.output.trim()}`);
        "#,
    );
    assert_eq!(ed.messages().last().map(String::as_str), Some("3 got it"));
}

#[test]
fn an_agent_needs_approval_to_run_a_program() {
    let (mut ed, s) = setup();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "test.ts", r#"e8.makeProcess({ name: "x", command: ["true"] });"#.to_string());
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}

#[test]
fn a_new_process_of_the_same_name_gets_none_of_the_old_ones_output() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "p", buffer: "*old*", command: ["sh", "-c", "yes"] });"#);
    ed.accept_process_output(Duration::from_millis(100));
    eval(&mut ed, &s, r#"e8.deleteProcess("p"); e8.makeProcess({ name: "p", buffer: "*new*", command: ["echo", "new"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*new*"), "new\n\nProcess p finished\n");
}

#[test]
fn output_a_slow_reader_has_not_read_yet_comes_before_the_end() {
    // On a loaded machine the thread reading a program's output can run
    // late; the program has exited by then, and its output must still come
    // before "Process finished", as Emacs reads what is waiting first.
    let (mut ed, s) = setup();
    ed.delay_process_reads_for_tests(Duration::from_millis(600));
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "slow", buffer: "*slow*", command: ["echo", "late"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*slow*"), "late\n\nProcess slow finished\n");
    // The same through a pipe rather than a terminal.
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "piped", buffer: "*piped*", connectionType: "pipe", command: ["echo", "late"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*piped*"), "late\n\nProcess piped finished\n");
}

#[test]
fn a_process_whose_child_keeps_its_output_open_still_ends() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "bg", buffer: "*bg*", command: ["sh", "-c", "sleep 5 & echo hi"] });"#);
    ed.accept_process_output(Duration::from_secs(3));
    assert!(ed.process_list().is_empty(), "noticed once it exits, though sleep holds its output");
    assert!(buffer_text(&ed, "*bg*").starts_with("hi\n"));
}

#[test]
fn output_goes_in_at_the_mark_whatever_the_narrowing() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"
        e8.getBufferCreate("*n*");
        e8.withCurrentBuffer("*n*", () => { e8.insert("ab\ncd\n"); e8.narrowToRegion(0, 2); });
        e8.makeProcess({ name: "n", buffer: "*n*", command: ["echo", "out"] });
        "#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    assert!(buffer_text(&ed, "*n*").starts_with("ab\ncd\nout\n"), "{:?}", buffer_text(&ed, "*n*"));
}

#[test]
fn killing_a_buffer_with_a_running_process_asks() {
    // process-kill-buffer-query-function asks, from kill-buffer-query-functions,
    // and the question waits for its answer, so on the editor's own thread.
    let d = Driven::new(r#"e8.makeProcess({ name: "s", buffer: "*s*", command: ["sleep", "30"] });"#);
    d.press("C-x k");
    d.type_text("*s*\n");
    assert_eq!(d.prompt().as_deref(), Some("Buffer \"*s*\" has a running process; kill it? (yes or no) "));
    d.type_text("no\n");
    assert!(d.with(|ed| ed.find_buffer("*s*").is_some()), "no keeps it");
    // From code too, as in Emacs.
    d.start(|ed| {
        let _ = ed.call("kill-buffer", vec![e8_core::Arg::Str("*s*".into())]);
    });
    assert_eq!(d.prompt().as_deref(), Some("Buffer \"*s*\" has a running process; kill it? (yes or no) "));
    d.type_text("yes\n");
    assert!(d.with(|ed| ed.find_buffer("*s*").is_none()));
    assert!(d.with(|ed| ed.process_list().is_empty()));
}

/// Runs `ed`'s processes until `done` says so, or a few seconds pass.
fn until(ed: &mut Editor, s: &Scripting, done: &str) {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        ed.accept_process_output(Duration::from_millis(20));
        if s.eval_expression(ed, done).unwrap() == "true" {
            return;
        }
    }
    panic!("never: {done}");
}

#[test]
fn a_terminal_of_its_own_by_default() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"e8.makeProcess({ name: "t", buffer: "*t*", command: ["sh", "-c", "test -t 0 && echo tty; printf 'a\nb\n'"] });
        globalThis.ttyName = e8.processTtyName("t");"#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    // No carriage returns, as Emacs sets the terminal up without them.
    assert_eq!(buffer_text(&ed, "*t*"), "tty\na\nb\n\nProcess t finished\n");
    assert!(s.eval_expression(&mut ed, "ttyName").unwrap().contains("/dev/"));
    // With pipes, as process-connection-type nil asks.
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "p", buffer: "*p*", connectionType: "pipe", command: ["sh", "-c", "test -t 0 && echo tty; echo pipe"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*p*"), "pipe\n\nProcess p finished\n");
}

#[test]
fn end_of_file_and_interrupts_on_a_terminal() {
    let (mut ed, s) = setup();
    // C-d on a terminal ends cat's input, which it sees as end of file.
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "cat", buffer: "*cat*", command: ["cat"] }); e8.processSendString("cat", "hi\n"); e8.processSendEof("cat");"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*cat*"), "hi\n\nProcess cat finished\n");
    // Interrupting the job in the foreground, as a shell's C-c C-c does.
    eval(
        &mut ed,
        &s,
        r#"globalThis.events = [];
        e8.makeProcess({ name: "sleep", command: ["sleep", "30"], sentinel: (p, e) => events.push(e) });"#,
    );
    ed.accept_process_output(Duration::from_millis(200));
    eval(&mut ed, &s, r#"e8.interruptProcess("sleep", true);"#);
    until(&mut ed, &s, "events.length > 0");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(events)").unwrap(), r#""[\"interrupt\\n\"]""#);
}

#[test]
fn output_and_input_in_the_process_coding() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"e8.makeProcess({ name: "l", buffer: "*l*", coding: "latin-1", command: ["sh", "-c", "read x; printf '%s' \"$x\" | od -An -tx1; printf '\\351\\n'"] });
        e8.processSendString("l", "é\n");
        globalThis.codings = e8.processCodingSystem("l");"#,
    );
    ed.accept_process_output(Duration::from_secs(5));
    let text = buffer_text(&ed, "*l*");
    // od's spacing differs between macOS's and GNU's: compare the byte it printed.
    assert_eq!(text.split_whitespace().next(), Some("e9"), "sent as Latin-1: {text:?}");
    assert!(text.contains("é\n"), "read as Latin-1: {text:?}");
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(codings)").unwrap(), r#""[\"iso-latin-1\",\"iso-latin-1\"]""#);
    // UTF-8 split between reads still decodes whole.
    eval(&mut ed, &s, r#"e8.makeProcess({ name: "u", buffer: "*u*", command: ["sh", "-c", "printf '\\342'; sleep 0.2; printf '\\202\\254\\n'"] });"#);
    ed.accept_process_output(Duration::from_secs(5));
    assert_eq!(buffer_text(&ed, "*u*"), "€\n\nProcess u finished\n");
}

#[test]
fn network_servers_and_clients() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.got = []; globalThis.events = [];
        e8.makeNetworkProcess({ name: "srv", service: true, server: true,
          filter: (p, text) => { got.push([p, text]); e8.processSendString(p, text.toUpperCase()); },
          sentinel: (p, e) => events.push([p, e]) });
        globalThis.port = e8.processContact("srv", "service");
        e8.makeNetworkProcess({ name: "cli", buffer: "*cli*", service: Number(port), sentinel: (p, e) => events.push([p, e]) });
        e8.processSendString("cli", "hello");
        globalThis.statuses = [e8.processStatus("srv"), e8.processStatus("cli"), e8.processType("cli"), e8.processLiveP("cli")];"#,
    );
    until(&mut ed, &s, r#"e8.bufferText !== undefined && e8.withCurrentBuffer("*cli*", () => e8.bufferText()) === "HELLO""#);
    let got = s.eval_expression(&mut ed, "JSON.stringify([got, events, statuses])").unwrap();
    assert!(got.contains(r#"\"srv <127.0.0.1:"#), "{got}");
    assert!(got.contains(r#"\"hello\"]]"#), "{got}");
    assert!(got.contains(r#"\"open from 127.0.0.1\\n\""#), "{got}");
    assert!(got.contains(r#"[\"listen\",\"open\",\"network\",true]"#), "{got}");
    // The client closing shows on the server's side as the remote end going.
    eval(&mut ed, &s, r#"e8.deleteProcess("cli");"#);
    until(&mut ed, &s, r#"events.some(([, e]) => e === "connection broken by remote peer\n")"#);
    let got = s.eval_expression(&mut ed, "JSON.stringify(events)").unwrap();
    assert!(got.contains(r#"[\"cli\",\"deleted\\n\"]"#), "{got}");
    eval(&mut ed, &s, r#"e8.deleteProcess("srv");"#);
    assert!(ed.process_list().is_empty(), "{:?}", ed.process_list());
}

#[test]
fn local_sockets() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sock").display().to_string();
    eval(
        &mut ed,
        &s,
        &format!(
            r#"globalThis.got = "";
            e8.makeNetworkProcess({{ name: "srv", family: "local", service: {path:?}, server: true, filter: (p, text) => {{ got += text; }} }});
            e8.makeNetworkProcess({{ name: "cli", family: "local", service: {path:?} }});
            e8.processSendString("cli", "over a socket");
            globalThis.contact = e8.processContact("cli");"#
        ),
    );
    until(&mut ed, &s, r#"got === "over a socket""#);
    assert_eq!(s.eval_expression(&mut ed, "JSON.stringify(contact)").unwrap(), format!("{:?}", format!("[null,{path:?}]")));
}

#[test]
fn an_agent_needs_approval_to_connect() {
    let (mut ed, s) = setup();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "t.ts", r#"e8.makeNetworkProcess({ name: "c", host: "example.com", service: 80 });"#.into());
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}

#[test]
fn accept_process_output_returns_as_soon_as_a_reply_comes() {
    let (mut ed, s) = setup();
    // A conversation with cat, a line at a time, as with a spell checker:
    // each wait ends when the reply comes, rather than after a pause.
    eval(
        &mut ed,
        &s,
        r#"let got = "";
        const p = e8.makeProcess({ name: "cat", command: ["cat"], connectionType: "pipe", filter: (_p, o) => { got += o; } });
        const t0 = Date.now();
        for (let i = 0; i < 200; i++) {
          got = "";
          e8.processSendString(p, `line ${i}\n`);
          while (!got.endsWith("\n")) e8.acceptProcessOutput(p, 1);
        }
        e8.setVariable("test-took", Date.now() - t0);
        e8.deleteProcess(p);"#,
    );
    let took: f64 = s.eval_expression(&mut ed, "e8.variable('test-took')").unwrap().parse().unwrap();
    // Sleeping 2 ms between looks took 400 ms or more for these.
    let limit = if std::env::var_os("CI").is_some() { 900.0 } else { 300.0 };
    assert!(took < limit, "200 replies took {took} ms");
}
