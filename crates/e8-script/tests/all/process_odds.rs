//! The last of process.c's primitives: set-network-process-option, serial
//! ports (make-serial-process, serial-process-configure), process-thread,
//! the datagram address, and internal-default-interrupt-process and
//! internal-default-signal-process. What Emacs does was checked with Emacs
//! 30.2 in batch on macOS, as each test says; a serial port is a
//! pseudo-terminal's other side here, as it was there.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::Duration;

use e8_core::Editor;
use e8_script::Scripting;


/// Whether a pseudo-terminal keeps the character size and parity set on it,
/// as a serial port does: not on Linux, whose pty driver forces 8 bits.
const PTY_KEEPS_SIZE_AND_PARITY: bool = !cfg!(target_os = "linux");

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    // What a call gives, or the error it signals: its condition and data.
    eval(
        &mut ed,
        &s,
        r#"globalThis.res = (f) => e8.conditionCase(() => { const v = f(); return JSON.stringify(v === undefined ? "nil" : v); },
             { error: (e) => JSON.stringify([e.symbol, ...(e.symbol === "error" && e.data.length === 0 ? [e.message] : e.data.map((d) => (typeof d === "symbol" ? d.description : d)))]) });"#,
    );
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

fn js(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// The descriptor of a socket of this process bound to `port` on this
/// machine, as the editor's connection is, found by looking at each.
fn socket_bound_to(port: u16) -> i32 {
    for fd in 3..4096 {
        // SAFETY: sockaddr_in is plain data, filled in by getsockname.
        let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
        // SAFETY: addr has room for len bytes; a closed fd only fails.
        if unsafe { libc::getsockname(fd, &mut addr as *mut _ as *mut libc::sockaddr, &mut len) } == 0
            && addr.sin_family as i32 == libc::AF_INET
            && u16::from_be(addr.sin_port) == port
        {
            return fd;
        }
    }
    panic!("no socket bound to {port}");
}

fn int_option(fd: i32, option: i32) -> i32 {
    let mut v: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: v has room for len bytes.
    assert_eq!(unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, option, &mut v as *mut _ as *mut libc::c_void, &mut len) }, 0);
    v
}

fn linger_option(fd: i32) -> (i32, i32) {
    // SAFETY: linger is plain data.
    let mut v: libc::linger = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::linger>() as libc::socklen_t;
    // SAFETY: v has room for len bytes.
    assert_eq!(unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_LINGER, &mut v as *mut _ as *mut libc::c_void, &mut len) }, 0);
    (v.l_onoff, v.l_linger)
}

/// A connection from the editor, "cli", to a server of the test's, and
/// the descriptor of the editor's socket.
fn connection(ed: &mut Editor, s: &Scripting) -> (std::net::TcpStream, i32) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    eval(ed, s, &format!(r#"globalThis.cli = e8.makeNetworkProcess({{ name: "cli", host: "127.0.0.1", service: {port} }});"#));
    let (peer, from) = listener.accept().unwrap();
    (peer, socket_bound_to(from.port()))
}

/// Emacs 30 on macOS, with cli a connection: :keepalive, :reuseaddr,
/// :linger (5, nil or t), :broadcast, :dontroute and :oobinline give t;
/// :nodelay, :priority, :bindtodevice and :bogus signal "Unknown or
/// unsupported option", or with NO-ERROR give nil; a keyword without its
/// colon is no option. (process-contact cli :keepalive) is then t.
#[test]
fn socket_options_are_set_on_the_socket() {
    let (mut ed, s) = setup();
    let (_peer, fd) = connection(&mut ed, &s);
    assert_eq!(int_option(fd, libc::SO_KEEPALIVE), 0);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":keepalive", true)"#), "true");
    assert_ne!(int_option(fd, libc::SO_KEEPALIVE), 0);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":keepalive", null)"#), "true");
    assert_eq!(int_option(fd, libc::SO_KEEPALIVE), 0);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":reuseaddr", true)"#), "true");
    assert_ne!(int_option(fd, libc::SO_REUSEADDR), 0);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":linger", 5)"#), "true");
    assert_eq!(linger_option(fd), (1, 5));
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":linger", null)"#), "true");
    assert_eq!(linger_option(fd).0, 0);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":linger", true)"#), "true");
    assert_eq!(linger_option(fd), (1, 0));
    for option in [":broadcast", ":dontroute", ":oobinline"] {
        assert_eq!(res(&mut ed, &s, &format!(r#"e8.setNetworkProcessOption(cli, "{option}", true)"#)), "true", "{option}");
    }
    assert_ne!(int_option(fd, libc::SO_BROADCAST), 0);
    assert_ne!(int_option(fd, libc::SO_OOBINLINE), 0);
    let unsupported: &[&str] = if cfg!(target_os = "linux") { &[":nodelay", ":bogus", "keepalive"] } else { &[":nodelay", ":priority", ":bindtodevice", ":bogus", "keepalive"] };
    for option in unsupported {
        assert_eq!(res(&mut ed, &s, &format!(r#"e8.setNetworkProcessOption(cli, "{option}", true)"#)), r#"["error","Unknown or unsupported option"]"#, "{option}");
        assert_eq!(res(&mut ed, &s, &format!(r#"e8.setNetworkProcessOption(cli, "{option}", true, true)"#)), r#""nil""#, "{option}");
    }
    // What was set is kept in its contact.
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(cli, "keepalive")"#), r#""nil""#); // set to nil last
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(cli, ":linger")"#), "true");
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(cli, ":oobinline")"#), "true");
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(cli, ":nodelay")"#), r#""nil""#);
}

/// Emacs 30: a server and the connections it accepts take options too;
/// a program or a pipe process signals "Process is not a network
/// process", a connection deleted "Process is not running", a number
/// wrong-type-argument processp and an option given as a string
/// wrong-type-argument symbolp (E8 takes a string as a symbol, as
/// everywhere, so only a non-string is that here).
#[test]
fn socket_options_need_an_open_network_process() {
    let (mut ed, s) = setup();
    let (_peer, _) = connection(&mut ed, &s);
    eval(
        &mut ed,
        &s,
        r#"globalThis.srv = e8.makeNetworkProcess({ name: "srv", server: true, service: true });
           globalThis.cat = e8.makeProcess({ name: "cat", command: ["cat"] });
           globalThis.pipe = e8.makePipeProcess({ name: "pipe" });
           globalThis.cli2 = e8.makeNetworkProcess({ name: "cli2", service: Number(e8.processContact(srv, "service")) });"#,
    );
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(srv, ":reuseaddr", true)"#), "true");
    until(&mut ed, &s, r#"e8.processList().some((p) => e8.processName(p).startsWith("srv <"))"#);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(e8.processList().find((p) => e8.processName(p).startsWith("srv <")), ":keepalive", true)"#), "true");
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cat, ":keepalive", true)"#), r#"["error","Process is not a network process"]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(pipe, ":keepalive", true)"#), r#"["error","Process is not a network process"]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(5, ":keepalive", true)"#), r#"["wrong-type-argument","processp",5]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(null, ":keepalive", true)"#), r#"["wrong-type-argument","processp",null]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, 5, true)"#), r#"["wrong-type-argument","symbolp",5]"#);
    eval(&mut ed, &s, "e8.deleteProcess(cli);");
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(cli, ":keepalive", true)"#), r#"["error","Process is not running"]"#);
    eval(&mut ed, &s, "e8.deleteProcess(cat); e8.deleteProcess(pipe); e8.deleteProcess(cli2); e8.deleteProcess(srv);");
}

/// Emacs 30: process-thread gives the thread that made a process, the
/// main thread in batch, where E8, which has no Lisp threads, gives nil;
/// set-process-thread takes nil, giving nil, and signals
/// wrong-type-argument threadp for 5 or t; both signal processp for a
/// non-process, as process-datagram-address and set-process-datagram-address
/// do, which give nil for a connection and a program, neither a datagram
/// process, and so for every process in E8, which has none.
#[test]
fn threads_and_datagram_addresses_are_nil() {
    let (mut ed, s) = setup();
    let (_peer, _) = connection(&mut ed, &s);
    eval(&mut ed, &s, r#"globalThis.cat = e8.makeProcess({ name: "cat", command: ["cat"] });"#);
    for p in ["cli", "cat"] {
        assert_eq!(res(&mut ed, &s, &format!("e8.processThread({p})")), r#""nil""#);
        assert_eq!(res(&mut ed, &s, &format!("e8.setProcessThread({p}, null)")), r#""nil""#);
        assert_eq!(res(&mut ed, &s, &format!("e8.processDatagramAddress({p})")), r#""nil""#);
        assert_eq!(res(&mut ed, &s, &format!("e8.setProcessDatagramAddress({p}, [127, 0, 0, 1, 80])")), r#""nil""#);
    }
    assert_eq!(res(&mut ed, &s, "e8.setProcessThread(cli, 5)"), r#"["wrong-type-argument","threadp",5]"#);
    assert_eq!(res(&mut ed, &s, "e8.setProcessThread(cli, true)"), r#"["wrong-type-argument","threadp",true]"#);
    for f in ["processThread", "processDatagramAddress"] {
        assert_eq!(res(&mut ed, &s, &format!("e8.{f}(5)")), r#"["wrong-type-argument","processp",5]"#, "{f}");
        assert_eq!(res(&mut ed, &s, &format!("e8.{f}(null)")), r#"["wrong-type-argument","processp",null]"#, "{f}");
    }
    assert_eq!(res(&mut ed, &s, "e8.setProcessThread(5, null)"), r#"["wrong-type-argument","processp",5]"#);
    assert_eq!(res(&mut ed, &s, "e8.setProcessDatagramAddress(5, [127, 0, 0, 1, 80])"), r#"["wrong-type-argument","processp",5]"#);
    // A process that has gone answers still, as in Emacs.
    eval(&mut ed, &s, "e8.deleteProcess(cli);");
    assert_eq!(res(&mut ed, &s, "e8.processThread(cli)"), r#""nil""#);
    assert_eq!(res(&mut ed, &s, "e8.processDatagramAddress(cli)"), r#""nil""#);
    eval(&mut ed, &s, "e8.deleteProcess(cat);");
}

/// Emacs 30: (internal-default-interrupt-process cat) gives the process,
/// which then has status signal and exit status 2; a connection or pipe
/// process signals "Process NAME is not a subprocess", a name no process
/// or buffer has "Process nope does not exist", 5 processp, and nil, in a
/// buffer with none, "Buffer *scratch* has no process".
#[test]
fn the_default_interrupt_interrupts_a_program() {
    let (mut ed, s) = setup();
    let (_peer, _) = connection(&mut ed, &s);
    eval(
        &mut ed,
        &s,
        r#"globalThis.cat = e8.makeProcess({ name: "cat", command: ["cat"] });
           globalThis.pipe = e8.makePipeProcess({ name: "pipe" });"#,
    );
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(cli)"), r#"["error","Process cli is not a subprocess"]"#);
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(pipe)"), r#"["error","Process pipe is not a subprocess"]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultInterruptProcess("nope")"#), r#"["error","Process nope does not exist"]"#);
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(5)"), r#"["wrong-type-argument","processp",5]"#);
    let buffer = value(&mut ed, &s, "e8.bufferName()");
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(null)"), format!(r#"["error","Buffer {buffer} has no process"]"#));
    assert_eq!(value(&mut ed, &s, "e8.internalDefaultInterruptProcess(cat) === cat"), "true");
    until(&mut ed, &s, r#"e8.processStatus(cat) === "signal""#);
    assert_eq!(value(&mut ed, &s, "e8.processExitStatus(cat)"), "2");
    // Interrupting it again: it has ended, as Emacs's "is not active".
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(cat)"), r#"["error","Process cat is not active"]"#);
    eval(&mut ed, &s, "e8.deleteProcess(pipe);");
}

/// Emacs 30: internal-default-signal-process gives what kill(2) did, 0
/// for a program and signal 0, a number, `sigcont` or `cont`; a process id
/// that is no process's, as a number or written out, -1; a string that is
/// neither a process's name nor a number nil; a connection "Cannot signal
/// process cli"; an unknown name "Undefined signal name BOGUS"; nil in a
/// buffer with no process "Buffer *scratch* has no process", and a
/// non-process processp.
#[test]
fn the_default_signal_signals_a_process_id() {
    let (mut ed, s) = setup();
    let (_peer, _) = connection(&mut ed, &s);
    eval(&mut ed, &s, r#"globalThis.cat = e8.makeProcess({ name: "cat", command: ["cat"] });"#);
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess(cli, "INT")"#), r#"["error","Cannot signal process cli"]"#);
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess("nope", "INT")"#), r#""nil""#);
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess("999999999", 0)"#), "-1");
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(999999999, 0)"), "-1");
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess("12x", 0)"#), r#""nil""#);
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess(cat, "BOGUS")"#), r#"["error","Undefined signal name BOGUS"]"#);
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(cat, 0)"), "0");
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess(cat, "sigcont")"#), "0");
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess("cat", "cont")"#), "0");
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(e8.processId(cat), 0)"), "0");
    let buffer = value(&mut ed, &s, "e8.bufferName()");
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(null, 0)"), format!(r#"["error","Buffer {buffer} has no process"]"#));
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(true, 0)"), r#"["wrong-type-argument","processp",true]"#);
    // TERM ends it, signalled.
    assert_eq!(res(&mut ed, &s, r#"e8.internalDefaultSignalProcess(cat, "TERM")"#), "0");
    until(&mut ed, &s, r#"e8.processStatus(cat) === "signal""#);
    assert_eq!(value(&mut ed, &s, "e8.processExitStatus(cat)"), "15");
}

/// A pseudo-terminal: its controlling side, the side a serial port would
/// be, and that side's file, which make-serial-process opens.
fn pty() -> (OwnedFd, OwnedFd, String) {
    let (mut master, mut slave) = (0, 0);
    // SAFETY: openpty fills in two descriptors it opens, which we then own.
    assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
    // SAFETY: just opened, owned by nothing else.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // SAFETY: ttyname gives a static string or null.
    let path = unsafe { std::ffi::CStr::from_ptr(libc::ttyname(slave.as_raw_fd())).to_string_lossy().into_owned() };
    (master, slave, path)
}

fn termios(fd: &OwnedFd) -> libc::termios {
    // SAFETY: termios is plain data, filled in by tcgetattr.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: fd is an open terminal.
    assert_eq!(unsafe { libc::tcgetattr(fd.as_raw_fd(), &mut t) }, 0);
    t
}

// speed_t is a u64 on macOS, a u32 on Linux.
#[allow(clippy::unnecessary_cast)]
fn speed(t: &libc::termios) -> u64 {
    // SAFETY: t is a valid termios.
    let s = unsafe { libc::cfgetospeed(t) } as u64;
    // On Linux a speed is a constant of its own.
    match s {
        x if x == libc::B1200 as u64 => 1200,
        x if x == libc::B2400 as u64 => 2400,
        x if x == libc::B4800 as u64 => 4800,
        x if x == libc::B9600 as u64 => 9600,
        x => x,
    }
}

/// What has come out of a pseudo-terminal's controlling side, waiting up
/// to a second for `want` bytes.
fn read_master(master: &OwnedFd, want: usize) -> String {
    let mut got = Vec::new();
    let start = std::time::Instant::now();
    while got.len() < want && start.elapsed() < Duration::from_secs(5) {
        let mut ready = libc::pollfd { fd: master.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: poll reads and writes the one pollfd given it.
        if unsafe { libc::poll(&mut ready, 1, 100) } > 0 {
            let mut buf = [0u8; 256];
            // SAFETY: buf has room for its length.
            let n = unsafe { libc::read(master.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n > 0 {
                got.extend_from_slice(&buf[..n as usize]);
            }
        }
    }
    String::from_utf8_lossy(&got).into_owned()
}

fn write_master(master: &OwnedFd, text: &str) {
    // SAFETY: text is valid for its length.
    let n = unsafe { libc::write(master.as_raw_fd(), text.as_ptr() as *const libc::c_void, text.len()) };
    assert_eq!(n, text.len() as isize);
}

/// Emacs 30: (make-serial-process :port TTY :speed 9600) is a process
/// named TTY with a buffer of that name, process-type serial, status open,
/// no process id, command or terminal, exit status 0; process-contact is
/// (TTY 9600), with t (:port TTY :speed 9600 :bytesize 8 :parity nil
/// :stopbits 1 :flowcontrol nil :summary "8N1"). What it is sent comes out
/// of the terminal's other side, and what that side writes into its buffer.
#[test]
fn a_serial_port_is_a_process() {
    let (mut ed, s) = setup();
    let (master, slave, path) = pty();
    eval(&mut ed, &s, &format!("globalThis.ser = e8.makeSerialProcess({{ port: {}, speed: 9600 }});", js(&path)));
    assert_eq!(value(&mut ed, &s, "e8.processName(ser)"), path);
    assert_eq!(value(&mut ed, &s, "e8.processBuffer(ser)"), path);
    assert_eq!(value(&mut ed, &s, "e8.processType(ser)"), "serial");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(ser)"), "open");
    assert_eq!(value(&mut ed, &s, "String(e8.processId(ser))"), "undefined");
    assert_eq!(value(&mut ed, &s, "String(e8.processTtyName(ser))"), "undefined");
    assert_eq!(value(&mut ed, &s, "e8.processLiveP(ser)"), "true");
    assert_eq!(value(&mut ed, &s, "e8.processQueryOnExitFlag(ser)"), "true");
    assert_eq!(res(&mut ed, &s, "e8.processContact(ser)"), format!("[{},9600]", js(&path)));
    assert_eq!(
        res(&mut ed, &s, "e8.processContact(ser, true)"),
        format!(r#"[":port",{},":speed",9600,":bytesize",8,":parity",null,":stopbits",1,":flowcontrol",null,":summary","8N1"]"#, js(&path))
    );
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(ser, "summary")"#), r#""8N1""#);
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(ser, ":port")"#), js(&path));
    // Raw, at 9600 bits a second, 8N1, as serial_configure leaves it.
    let t = termios(&slave);
    assert_eq!(speed(&t), 9600);
    assert_eq!(t.c_cflag & libc::CSIZE, libc::CS8);
    assert_eq!(t.c_cflag & (libc::PARENB | libc::CSTOPB | libc::CRTSCTS), 0);
    assert_eq!(t.c_cflag & (libc::CLOCAL | libc::CREAD), libc::CLOCAL | libc::CREAD);
    assert_eq!(t.c_lflag & (libc::ICANON | libc::ECHO), 0);
    eval(&mut ed, &s, r#"e8.processSendString(ser, "to-master\n");"#);
    assert_eq!(read_master(&master, 10), "to-master\n");
    write_master(&master, "to-serial\n");
    until(&mut ed, &s, &format!("e8.withCurrentBuffer({}, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())) === 'to-serial\\n'", js(&path)));
    // process-send-eof waits for what was sent to go, and leaves it open.
    assert_eq!(value(&mut ed, &s, "e8.processSendEof(ser), e8.processStatus(ser)"), "open");
    eval(&mut ed, &s, "globalThis.events = []; e8.setProcessSentinel(ser, (p, e) => events.push(e)); e8.deleteProcess(ser);");
    assert_eq!(res(&mut ed, &s, "events"), r#"["finished\n"]"#);
    assert_eq!(value(&mut ed, &s, "e8.processStatus(ser)"), "closed");
    assert_eq!(value(&mut ed, &s, "e8.processType(ser)"), "serial");
    // Its port closed, configuring it fails as reading a closed descriptor does.
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: ser, speed: 9600 })"), r#"["file-error","Failed tcgetattr","Bad file descriptor"]"#);
}

/// Emacs 30: serial-process-configure with :speed 1200 :bytesize 7
/// :parity odd :stopbits 2 :flowcontrol sw gives nil, the contact then
/// saying so with :summary "7O2"; then :parity even, "7E2", then
/// :flowcontrol hw. What is left out stays as it was. The process is
/// found by :process, :name, :buffer or :port.
#[test]
fn configuring_a_serial_port_sets_its_termios() {
    let (mut ed, s) = setup();
    let (_master, slave, path) = pty();
    eval(&mut ed, &s, &format!("globalThis.ser = e8.makeSerialProcess({{ port: {}, speed: 9600 }});", js(&path)));
    let contact = |rest: &str| format!(r#"[":port",{},":speed",{rest}]"#, js(&path));
    assert_eq!(
        res(&mut ed, &s, r#"e8.serialProcessConfigure({ process: ser, speed: 1200, bytesize: 7, parity: "odd", stopbits: 2, flowcontrol: "sw" })"#),
        r#""nil""#
    );
    assert_eq!(res(&mut ed, &s, "e8.processContact(ser, true)"), contact(r#"1200,":bytesize",7,":parity","odd",":stopbits",2,":flowcontrol","sw",":summary","7O2""#));
    let t = termios(&slave);
    assert_eq!(speed(&t), 1200);
    // Linux's pseudo-terminals keep 8 bits and no parity whatever is set
    // (the kernel's pty_set_termios clears CSIZE and PARENB), so a real
    // port's size and parity show there only on macOS.
    if PTY_KEEPS_SIZE_AND_PARITY {
        assert_eq!(t.c_cflag & libc::CSIZE, libc::CS7);
        assert_eq!(t.c_cflag & (libc::PARENB | libc::PARODD | libc::CSTOPB), libc::PARENB | libc::PARODD | libc::CSTOPB);
    } else {
        assert_eq!(t.c_cflag & (libc::PARODD | libc::CSTOPB), libc::PARODD | libc::CSTOPB);
    }
    assert_eq!(t.c_iflag & (libc::IXON | libc::IXOFF | libc::INPCK), libc::IXON | libc::IXOFF | libc::INPCK);
    eval(&mut ed, &s, r#"e8.serialProcessConfigure({ process: ser, parity: "even" });"#);
    assert_eq!(res(&mut ed, &s, "e8.processContact(ser, true)"), contact(r#"1200,":bytesize",7,":parity","even",":stopbits",2,":flowcontrol","sw",":summary","7E2""#));
    let even = if PTY_KEEPS_SIZE_AND_PARITY { libc::PARENB } else { 0 };
    assert_eq!(termios(&slave).c_cflag & (libc::PARENB | libc::PARODD), even);
    eval(&mut ed, &s, r#"e8.serialProcessConfigure({ process: ser, flowcontrol: "hw" });"#);
    assert_eq!(res(&mut ed, &s, "e8.processContact(ser, true)"), contact(r#"1200,":bytesize",7,":parity","even",":stopbits",2,":flowcontrol","hw",":summary","7E2""#));
    let t = termios(&slave);
    assert_eq!(t.c_cflag & libc::CRTSCTS, libc::CRTSCTS);
    assert_eq!(t.c_iflag & (libc::IXON | libc::IXOFF), 0);
    // Found by its name, its buffer, or its port, which is its name.
    eval(&mut ed, &s, &format!("e8.serialProcessConfigure({{ name: {}, speed: 4800 }});", js(&path)));
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(ser, "speed")"#), "4800");
    assert_eq!(speed(&termios(&slave)), 4800);
    eval(&mut ed, &s, "e8.serialProcessConfigure({ buffer: e8.processBuffer(ser), speed: 2400 });");
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(ser, "speed")"#), "2400");
    eval(&mut ed, &s, &format!("e8.serialProcessConfigure({{ port: {}, speed: 1200 }});", js(&path)));
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(ser, "speed")"#), "1200");
    // Emacs 30's errors.
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: ser, bytesize: 9 })"), r#"["error",":bytesize must be nil (8), 7, or 8"]"#);
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: ser, speed: null })"), r#"["wrong-type-argument","fixnump",null]"#);
    eval(&mut ed, &s, r#"globalThis.cat = e8.makeProcess({ name: "cat", command: ["cat"] });"#);
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: cat, speed: 9600 })"), r#"["error","Not a serial process"]"#);
    let buffer = value(&mut ed, &s, "e8.bufferName()");
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ speed: 9600 })"), format!(r#"["error","Buffer {buffer} has no process"]"#));
    assert_eq!(res(&mut ed, &s, r#"e8.serialProcessConfigure({ process: "nope", speed: 9600 })"#), r#"["error","Process nope does not exist"]"#);
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: 5, speed: 9600 })"), r#"["wrong-type-argument","processp",5]"#);
    // Neither a connection's options nor a program's signals are a serial port's.
    assert_eq!(res(&mut ed, &s, r#"e8.setNetworkProcessOption(ser, ":keepalive", true)"#), r#"["error","Process is not a network process"]"#);
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultInterruptProcess(ser)"), format!(r#"["error","Process {path} is not a subprocess"]"#));
    assert_eq!(res(&mut ed, &s, "e8.internalDefaultSignalProcess(ser, 0)"), format!(r#"["error","Cannot signal process {path}"]"#));
    eval(&mut ed, &s, "e8.deleteProcess(ser); e8.deleteProcess(cat);");
}

/// Emacs 30's checks of make-serial-process's arguments: none gives nil;
/// no :port "No port specified", a port not a string stringp; no :speed
/// ":speed not specified", one not a number fixnump; a :name not a string
/// stringp; a port that is not there file-missing "Opening serial port";
/// and serial-process-configure's own, after which the process is gone.
#[test]
fn a_serial_ports_arguments_are_checked() {
    let (mut ed, s) = setup();
    let (_master, _slave, path) = pty();
    let port = js(&path);
    assert_eq!(res(&mut ed, &s, "e8.makeSerialProcess()"), r#""nil""#);
    assert_eq!(res(&mut ed, &s, "e8.makeSerialProcess({ speed: 9600 })"), r#"["error","No port specified"]"#);
    assert_eq!(res(&mut ed, &s, "e8.makeSerialProcess({ port: 5, speed: 9600 })"), r#"["wrong-type-argument","stringp",5]"#);
    assert_eq!(res(&mut ed, &s, &format!("e8.makeSerialProcess({{ port: {port} }})")), r#"["error",":speed not specified"]"#);
    assert_eq!(res(&mut ed, &s, &format!(r#"e8.makeSerialProcess({{ port: {port}, speed: "fast" }})"#)), r#"["wrong-type-argument","fixnump","fast"]"#);
    assert_eq!(res(&mut ed, &s, &format!("e8.makeSerialProcess({{ port: {port}, speed: 9600, name: 5 }})")), r#"["wrong-type-argument","stringp",5]"#);
    assert_eq!(
        res(&mut ed, &s, r#"e8.makeSerialProcess({ port: "/nonexistent/tty", speed: 9600 })"#),
        r#"["file-missing","Opening serial port","No such file or directory","/nonexistent/tty"]"#
    );
    // Each opens the port, then fails configuring it: a pseudo-terminal of
    // its own each, as one opened is E8's alone (TIOCEXCL) on Linux.
    for (args, error) in [
        ("bytesize: 6", r#"["error",":bytesize must be nil (8), 7, or 8"]"#),
        (r#"bytesize: "8""#, r#"["wrong-type-argument","fixnump","8"]"#),
        (r#"parity: "mark""#, "[\"error\",\":parity must be nil (no parity), \u{2018}even\u{2019}, or \u{2018}odd\u{2019}\"]"),
        ("stopbits: 3", r#"["error",":stopbits must be nil (1 stopbit), 1, or 2"]"#),
        (r#"flowcontrol: "yes""#, "[\"error\",\":flowcontrol must be nil (no flowcontrol), \u{2018}hw\u{2019}, or \u{2018}sw\u{2019}\"]"),
    ] {
        let (_m, _s, path) = pty();
        assert_eq!(res(&mut ed, &s, &format!("e8.makeSerialProcess({{ port: {}, speed: 9600, {args} }})", js(&path))), error, "{args}");
    }
    assert_eq!(value(&mut ed, &s, "e8.processList().length"), "0");
}

/// Emacs 30: with :speed nil the port is not configured, and its contact
/// is the arguments as given; :noquery, :stop, :plist and :coding are
/// taken; serial-process-configure then does nothing. stop-process gives
/// the process, its status stop, what comes left unread; continue-process
/// makes it open again. A second process of the same name is NAME<1>.
#[test]
fn a_serial_port_left_unconfigured_and_stopped() {
    let (mut ed, s) = setup();
    let (master, slave, path) = pty();
    let before = termios(&slave);
    eval(
        &mut ed,
        &s,
        &format!(r#"globalThis.s2 = e8.makeSerialProcess({{ port: {}, speed: null, name: "s2", buffer: "s2buf", noquery: true, stop: true, plist: ["a", 1], coding: "latin-1" }});"#, js(&path)),
    );
    assert_eq!(
        res(&mut ed, &s, "e8.processContact(s2, true)"),
        format!(r#"[":port",{},":speed",null,":name","s2",":buffer","s2buf",":noquery",true,":stop",true,":plist",["a",1],":coding","latin-1"]"#, js(&path))
    );
    assert_eq!(value(&mut ed, &s, "e8.processStatus(s2)"), "stop");
    assert_eq!(value(&mut ed, &s, "e8.processQueryOnExitFlag(s2)"), "false");
    assert_eq!(res(&mut ed, &s, "e8.processPlist(s2)"), r#"["a",1]"#);
    assert_eq!(value(&mut ed, &s, "e8.processBuffer(s2)"), "s2buf");
    assert_eq!(res(&mut ed, &s, "e8.serialProcessConfigure({ process: s2, speed: 9600 })"), r#""nil""#);
    assert_eq!(res(&mut ed, &s, r#"e8.processContact(s2, "speed")"#), r#""nil""#);
    assert_eq!(speed(&termios(&slave)), speed(&before));
    // Stopped, it is not read; continued, it is, what came meanwhile
    // thrown away as tcflush does.
    write_master(&master, "unread\n");
    ed.accept_process_output(Duration::from_millis(200));
    assert_eq!(value(&mut ed, &s, r#"e8.withCurrentBuffer("s2buf", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))"#), "");
    assert_eq!(value(&mut ed, &s, "e8.continueProcess(s2) === s2"), "true");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(s2)"), "open");
    write_master(&master, "read\n");
    until(&mut ed, &s, r#"e8.withCurrentBuffer("s2buf", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())).length > 0"#);
    assert_eq!(value(&mut ed, &s, r#"e8.withCurrentBuffer("s2buf", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))"#), "read\n");
    assert_eq!(value(&mut ed, &s, "e8.stopProcess(s2) === s2"), "true");
    assert_eq!(value(&mut ed, &s, "e8.processStatus(s2)"), "stop");
    let (_master3, _slave3, other) = pty();
    eval(&mut ed, &s, &format!(r#"globalThis.s3 = e8.makeSerialProcess({{ port: {}, speed: 9600, name: "s2" }});"#, js(&other)));
    assert_eq!(value(&mut ed, &s, "e8.processName(s3)"), "s2<1>");
    eval(&mut ed, &s, "e8.deleteProcess(s2); e8.deleteProcess(s3);");
}

/// Opening a serial port asks the agent's permission, as starting a
/// program does.
#[test]
fn an_agent_needs_approval_to_open_a_serial_port() {
    let (mut ed, s) = setup();
    let (_master, _slave, path) = pty();
    ed.set_agent_acting(true);
    let result = s.eval_typescript(&mut ed, "t.ts", format!("e8.makeSerialProcess({{ port: {}, speed: 9600 }});", js(&path)));
    assert!(result.is_err());
    assert!(ed.permission_requested());
    assert!(ed.process_list().is_empty());
}
