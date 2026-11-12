//! Processes, as Emacs's process.c: programs that run alongside the editor
//! while their output comes into a buffer, as compilation and grep do, on a
//! pipe or a pseudo-terminal of their own, and network connections, as
//! clients or servers, over TCP or a local socket.
//!
//! A process is started with [`Editor::make_process`]. Threads read its
//! output and send it to the editor, waking its command loop (driver.rs),
//! which takes the output in with [`Editor::run_timers`]; an editor without
//! one is asked to wake often by [`Editor::next_timer_in`] while one runs. Output
//! goes to the process's filter, or by default into its buffer at its
//! mark; when it exits its sentinel runs, or by default a line saying so
//! goes into its buffer. Starting a program asks the agent's permission,
//! as running code does. [`Editor::call_process`] runs one and waits, as
//! Emacs's call-process.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
use std::time::Duration;

use crate::clock::Instant;

use crate::coding::{Coding, Eol};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// How a process stands, as Emacs's `process-status`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Run,
    /// Exited with this code.
    Exit(i32),
    /// Ended by this signal.
    Signal(i32),
}

impl Status {
    /// The event a sentinel is told, as Emacs words it: "finished\n",
    /// "exited abnormally with code 2\n", "killed\n".
    pub fn event(self) -> String {
        match self {
            Status::Run => "run\n".into(),
            Status::Exit(0) => "finished\n".into(),
            Status::Exit(code) => format!("exited abnormally with code {code}\n"),
            Status::Signal(sig) => format!("{}\n", signal_name(sig)),
        }
    }
}

/// The signals this system has, by name without "SIG", as Emacs's
/// sig2str names them.
#[cfg(unix)]
const SIGNALS: &[(&str, i32)] = &[
    ("HUP", libc::SIGHUP),
    ("INT", libc::SIGINT),
    ("QUIT", libc::SIGQUIT),
    ("ILL", libc::SIGILL),
    ("TRAP", libc::SIGTRAP),
    ("ABRT", libc::SIGABRT),
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    ("EMT", libc::SIGEMT),
    ("FPE", libc::SIGFPE),
    ("KILL", libc::SIGKILL),
    ("BUS", libc::SIGBUS),
    ("SEGV", libc::SIGSEGV),
    ("SYS", libc::SIGSYS),
    ("PIPE", libc::SIGPIPE),
    ("ALRM", libc::SIGALRM),
    ("TERM", libc::SIGTERM),
    ("URG", libc::SIGURG),
    ("STOP", libc::SIGSTOP),
    ("TSTP", libc::SIGTSTP),
    ("CONT", libc::SIGCONT),
    ("CHLD", libc::SIGCHLD),
    ("TTIN", libc::SIGTTIN),
    ("TTOU", libc::SIGTTOU),
    ("IO", libc::SIGIO),
    ("XCPU", libc::SIGXCPU),
    ("XFSZ", libc::SIGXFSZ),
    ("VTALRM", libc::SIGVTALRM),
    ("PROF", libc::SIGPROF),
    ("WINCH", libc::SIGWINCH),
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    ("INFO", libc::SIGINFO),
    #[cfg(any(target_os = "linux", target_os = "android"))]
    ("STKFLT", libc::SIGSTKFLT),
    #[cfg(any(target_os = "linux", target_os = "android"))]
    ("PWR", libc::SIGPWR),
    ("USR1", libc::SIGUSR1),
    ("USR2", libc::SIGUSR2),
];

/// The signal a name gives, "SIGINT" or "int", as signal-process takes names.
pub fn signal_number(name: &str) -> Option<i32> {
    #[cfg(unix)]
    {
        let name = name.trim_start_matches("SIG").trim_start_matches("sig").to_ascii_uppercase();
        SIGNALS.iter().find(|(n, _)| *n == name).map(|(_, sig)| *sig)
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        None
    }
}

/// The names of the signals this system has, as Emacs's signal-names:
/// without "SIG", the highest numbered first, and "EXIT", signal 0, last.
pub fn signal_names() -> Vec<String> {
    #[cfg(unix)]
    {
        let mut signals: Vec<(&str, i32)> = SIGNALS.to_vec();
        signals.sort_by_key(|(_, sig)| std::cmp::Reverse(*sig));
        let mut names: Vec<String> = signals.into_iter().map(|(n, _)| n.to_string()).collect();
        // The real-time signals, highest first, named as gnulib's sig2str
        // names them: RTMIN+n for the lower half, RTMAX-n for the upper.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let (min, max) = (libc::SIGRTMIN(), libc::SIGRTMAX());
            let rt = (min..=max).rev().map(|sig| {
                if sig <= min + (max - min) / 2 {
                    if sig == min { "RTMIN".to_string() } else { format!("RTMIN+{}", sig - min) }
                } else if sig == max {
                    "RTMAX".to_string()
                } else {
                    format!("RTMAX-{}", max - sig)
                }
            });
            names.splice(0..0, rt);
        }
        names.push("EXIT".into());
        names
    }
    #[cfg(not(unix))]
    Vec::new()
}

/// How Emacs describes a process ended by a signal.
fn signal_name(sig: i32) -> String {
    match sig {
        1 => "hangup".into(),
        2 => "interrupt".into(),
        3 => "quit".into(),
        9 => "killed".into(),
        13 => "broken pipe".into(),
        15 => "terminated".into(),
        n => format!("signal {n}"),
    }
}

/// What a process is connected by, as Emacs's process-type distinguishes.
pub(crate) enum Kind {
    Pipe,
    /// A pseudo-terminal: its controlling side, for its size, its foreground
    /// group and its end of file, and the terminal's name.
    #[cfg(unix)]
    Pty {
        master: std::fs::File,
        tty: String,
        /// The program's side, kept open while the process is: macOS throws
        /// away what a program wrote to a terminal and nobody read once the
        /// last holder of this side closes it, as the program does when it
        /// exits, so a reader that ran late would lose its last output.
        _slave: std::os::fd::OwnedFd,
    },
    /// A network connection, and where it goes, as process-contact gives it.
    Network(Contact),
    /// A server listening for connections, which become processes of their
    /// own; dropping the flag stops it.
    Server(Contact, Arc<AtomicBool>),
    /// A pipe, as make-pipe-process makes: what is written to its other
    /// end is its output. The editor keeps that end until a program is
    /// given it as its standard error, so the pipe ends when the program does.
    PipeProcess(Option<std::io::PipeWriter>),
}

/// Where a network process connects or listens.
#[derive(Clone, Debug)]
pub struct Contact {
    /// The host, or None for a local socket.
    pub host: Option<String>,
    /// The port, or a local socket's file name.
    pub service: String,
    /// For a connection a server accepted, who connected.
    pub remote: Option<String>,
}

pub(crate) struct Process {
    /// Unique among all processes ever started, so output read for one
    /// that has gone never reaches another of the same name.
    id: u64,
    pub(crate) name: String,
    /// The buffer it writes to, by buffer id.
    buffer: Option<u64>,
    /// Where output goes in its buffer, as `process-mark`.
    mark: Option<u64>,
    command: Vec<String>,
    status: Status,
    child: Option<Child>,
    /// Text for its standard input, written on a thread of its own so a
    /// process that does not read cannot stop the editor; None closes it.
    stdin: Option<Sender<Option<Vec<u8>>>>,
    pid: u32,
    /// Output streams still open.
    open_streams: usize,
    /// Its filter, as set-process-filter: None for the default, which
    /// inserts at its mark, and `true` for Emacs's `t`, which holds its
    /// output back until another is set.
    filter: Option<Value>,
    /// Its sentinel, as set-process-sentinel: None for the default.
    sentinel: Option<Value>,
    /// Its property list, as process-plist: [prop, value, ...].
    plist: Value,
    /// Output that came while its filter was `t`, to give the next filter
    /// set, in order.
    held_output: String,
    query_on_exit: bool,
    /// Its process-inherit-coding-system-flag.
    inherit_coding: bool,
    /// When it was seen to have exited, and how, while its output was still open.
    exited: Option<(Instant, Status)>,
    kind: Kind,
    /// How its output is decoded and its input encoded, as process-coding-system.
    coding: (Coding, Coding),
    /// Bytes of output not decoded yet, the start of a character split
    /// between reads.
    pending: Vec<u8>,
    /// How to tell that all a local program's output has been read.
    gate: Option<OutputGate>,
    /// Where its standard error goes when that is a buffer of its own, as
    /// make-process's :stderr: the buffer, its own mark, and bytes not
    /// decoded yet.
    stderr: Option<StderrBuffer>,
}

struct StderrBuffer {
    buffer: u64,
    mark: u64,
    pending: Vec<u8>,
}

/// What tells the editor that a program's output has all been read, so its
/// end is reported after the last of it, as Emacs reads what is waiting
/// before it reports a process's end: the lock its reader holds while it
/// reads a chunk and sends it on, and the descriptor, which says whether
/// the reader has anything left to read.
struct OutputGate {
    lock: Arc<Mutex<()>>,
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
}

impl OutputGate {
    /// Whether all the output has come: the reader is not reading, and has
    /// nothing waiting to read, neither bytes nor the output's end. If so,
    /// `then` runs holding the lock, so nothing more is read meanwhile.
    fn when_quiet(&self, then: impl FnOnce()) -> bool {
        let Ok(_reading) = self.lock.try_lock() else { return false };
        // The reader has something to do if bytes are waiting, or the output
        // has ended, which it reports once it has read the rest: either way
        // the process is not done. Quiet is the output still open, with
        // nothing in it, as when a child the program started holds it.
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let mut ready = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: poll reads and writes the one pollfd given it, and waits for nothing.
            let r = unsafe { libc::poll(&mut ready, 1, 0) };
            if r != 0 {
                return false;
            }
        }
        then();
        true
    }
}

enum Event {
    Output(u64, Vec<u8>),
    /// What a process wrote to standard error, kept apart from its output.
    Stderr(u64, Vec<u8>),
    Closed(u64),
    /// A server took a connection, from this peer.
    Accepted(u64, Conn, String),
}

/// A network connection's socket.
pub(crate) enum Conn {
    Tcp(std::net::TcpStream),
    #[cfg(unix)]
    Local(std::os::unix::net::UnixStream),
}

impl Conn {
    fn try_clone(&self) -> std::io::Result<Conn> {
        Ok(match self {
            Conn::Tcp(s) => Conn::Tcp(s.try_clone()?),
            #[cfg(unix)]
            Conn::Local(s) => Conn::Local(s.try_clone()?),
        })
    }

    fn shutdown(&self, how: std::net::Shutdown) {
        let _ = match self {
            Conn::Tcp(s) => s.shutdown(how),
            #[cfg(unix)]
            Conn::Local(s) => s.shutdown(how),
        };
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Tcp(s) => s.read(buf),
            #[cfg(unix)]
            Conn::Local(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Tcp(s) => s.write(buf),
            #[cfg(unix)]
            Conn::Local(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Tcp(s) => s.flush(),
            #[cfg(unix)]
            Conn::Local(s) => s.flush(),
        }
    }
}

/// Writes what a process is sent on a thread of its own, so a process that
/// does not read cannot stop the editor; `close` runs at end of file.
fn writer(mut out: impl Write + Send + 'static, close: impl FnOnce() + Send + 'static) -> Sender<Option<Vec<u8>>> {
    let (tx, rx) = channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        while let Ok(Some(bytes)) = rx.recv() {
            if out.write_all(&bytes).and_then(|_| out.flush()).is_err() {
                break;
            }
        }
        drop(out);
        close();
    });
    tx
}

/// How many chunks of output wait to be taken in before readers wait,
/// so a program writing fast fills no more memory than this.
const QUEUED_CHUNKS: usize = 64;
/// How many chunks are taken in at a time, as read-process-output-max
/// limits Emacs, so a flood of output leaves the editor answering.
const CHUNKS_PER_POLL: usize = 32;

/// Wakes whatever waits for input when a process has something, as the
/// editor's thread does ([`crate::driver::Driver`]).
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// The sending end of the events processes' threads report, which wakes
/// the editor's thread as it sends.
#[derive(Clone)]
struct EventSender {
    tx: SyncSender<Event>,
    wake: Arc<Mutex<Option<Waker>>>,
}

impl EventSender {
    fn send(&self, event: Event) -> std::result::Result<(), std::sync::mpsc::SendError<Event>> {
        self.tx.send(event)?;
        if let Some(wake) = self.wake.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            wake();
        }
        Ok(())
    }
}

pub(crate) struct Processes {
    list: Vec<Process>,
    tx: EventSender,
    rx: Receiver<Event>,
    next_id: u64,
    /// Events taken off the queue while waiting for a process to end,
    /// which belong to others, to handle first next time.
    held: std::collections::VecDeque<Event>,
    /// Counts output given to processes while accept-process-output waits
    /// for that of `watching`, or of any process.
    outputs_seen: u64,
    watching: Option<u64>,
    /// How long each read of a program's output is held back, for tests.
    read_delay: Duration,
    /// What is kept of processes that have gone from the list, by id, so
    /// their objects still answer, as Emacs's process objects do.
    gone: std::collections::HashMap<u64, Gone>,
    /// Whether filters and timers run now because the editor is waiting
    /// for the user to type, as Emacs's waiting-for-user-input-p.
    waiting_for_user_input: bool,
    /// For each wait for an answer under way, innermost last, whether it
    /// reads keys, as a prompt does, or only lets them run, as sleep-for.
    pub(crate) waits_reading_keys: Vec<bool>,
}

/// What is kept of a process once it has gone from the list: its name,
/// command, status, buffer and plist, without its streams, filter and
/// sentinel ([ADR 0070](../../../docs/adr/0070-processes-as-emacs-has-them.md)).
struct Gone {
    name: String,
    command: Vec<String>,
    status: Status,
    status_name: &'static str,
    kind: &'static str,
    buffer: Option<u64>,
    /// Its mark while its sentinel runs on its way out, then none.
    mark: Option<u64>,
    pid: u32,
    query_on_exit: bool,
    inherit_coding: bool,
    coding: (Coding, Coding),
    plist: Value,
    /// Its filter and sentinel, still read and set, as Emacs's are on a
    /// process that has gone, though never run.
    filter: Option<Value>,
    sentinel: Option<Value>,
}

/// What can be asked of a process, listed or gone, as process-status,
/// process-buffer and their kin answer.
#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub name: String,
    pub command: Vec<String>,
    pub status: Status,
    /// Its status as process-status names it.
    pub status_name: &'static str,
    /// "real" or "network", as process-type.
    pub kind: &'static str,
    /// The name of its buffer, if it has one still live.
    pub buffer: Option<String>,
    pub mark: Option<u64>,
    /// Its program's process id; none for a connection.
    pub pid: Option<u32>,
    pub query_on_exit: bool,
    /// Whether it is still in the process list.
    pub listed: bool,
}

impl Default for Processes {
    fn default() -> Processes {
        let (tx, rx) = sync_channel(QUEUED_CHUNKS);
        let tx = EventSender { tx, wake: Arc::new(Mutex::new(None)) };
        Processes { list: Vec::new(), tx, rx, next_id: 1, held: Default::default(), outputs_seen: 0, watching: None, read_delay: Duration::ZERO, gone: Default::default(), waiting_for_user_input: false, waits_reading_keys: Vec::new() }
    }
}

impl Processes {
    /// Waits up to `limit` for a process's next event, keeping it to be
    /// handled first by the next poll, as a sleep that ends when output comes.
    pub(crate) fn wait_for_event(&mut self, limit: Duration) {
        if !self.held.is_empty() {
            return;
        }
        // A timed wait needs a clock, which a browser's worker lacks, as
        // driver.rs says; there it sleeps and looks, as before.
        #[cfg(not(target_arch = "wasm32"))]
        if let Ok(event) = self.rx.recv_timeout(limit) {
            self.held.push_back(event);
        }
        #[cfg(target_arch = "wasm32")]
        match self.rx.try_recv() {
            Ok(event) => self.held.push_back(event),
            Err(_) => std::thread::sleep(limit),
        }
    }

    /// Waits for a killed child to end, taking its output off the queue
    /// meanwhile, as a program on a terminal ends only once what it wrote is
    /// read; others' output is kept. Gives up after a few seconds.
    fn reap(&mut self, child: &mut Child, id: u64) -> Option<std::process::ExitStatus> {
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= until {
                return None;
            }
            match self.rx.recv_timeout(Duration::from_millis(5)) {
                Ok(Event::Output(i, _) | Event::Stderr(i, _) | Event::Closed(i)) if i == id => {}
                Ok(event) => self.held.push_back(event),
                Err(_) => {}
            }
        }
    }
}

impl Drop for Processes {
    /// Hangs up on the processes still running, as Emacs does when it exits.
    fn drop(&mut self) {
        for p in &mut self.list {
            if p.status == Status::Run {
                hang_up(p);
            }
        }
    }
}

/// Sends SIGHUP to a process's group, then kills what is left; a
/// connection or server is closed.
fn hang_up(p: &mut Process) {
    match &mut p.kind {
        Kind::PipeProcess(writer) => {
            *writer = None;
            p.stdin = None;
            return;
        }
        Kind::Server(_, stop) => {
            stop.store(true, Ordering::Relaxed);
            return;
        }
        Kind::Network(_) => {
            p.stdin = None;
            return;
        }
        _ => {}
    }
    #[cfg(unix)]
    // SAFETY: kill only sends a signal; a stale pid fails harmlessly.
    unsafe {
        libc::kill(-(p.pid as i32), libc::SIGHUP);
    }
    let pty = p.is_pty();
    if let Some(child) = p.child.as_mut() {
        let _ = child.kill();
        // A program on a terminal finishes exiting only once what it wrote
        // has been read, which nothing may do now; it is reaped later.
        if !pty {
            let _ = child.wait();
        }
    }
}

/// What starts a process, as Emacs's make-process takes it.
pub struct ProcessSpec {
    pub name: String,
    /// The buffer it writes to, by name.
    pub buffer: Option<String>,
    /// The program and its arguments.
    pub command: Vec<String>,
    /// The directory it runs in: the buffer's default-directory if none.
    pub directory: Option<String>,
    /// Variables to set in its environment, besides TERM=dumb.
    pub env: Vec<(String, String)>,
    /// Whether what it writes to standard error comes in as output too.
    pub merge_stderr: bool,
    /// A buffer, by name, for what it writes to standard error, made if
    /// there is none, as make-process's :stderr; on pipes only, and
    /// `merge_stderr` then does not apply.
    pub stderr_buffer: Option<String>,
    /// A pipe process, by id, to write its standard error to, as
    /// make-process's :stderr takes one; `merge_stderr` then does not apply.
    pub stderr_process: Option<u64>,
    /// Its filter, called with the process and its output, as
    /// make-process's :filter; None for the default.
    pub filter: Option<Value>,
    /// Its sentinel, called with the process and the event; None for the default.
    pub sentinel: Option<Value>,
    /// Whether it talks through a pseudo-terminal rather than pipes, as
    /// process-connection-type t asks.
    pub pty: bool,
    /// How its output is decoded and its input encoded, if not as
    /// default-process-coding-system says.
    pub coding: Option<(Coding, Coding)>,
}

/// What makes a pipe process, as make-pipe-process takes it.
pub struct PipeSpec {
    pub name: String,
    /// The buffer its output goes to, by name, made if there is none.
    pub buffer: Option<String>,
    pub filter: Option<Value>,
    pub sentinel: Option<Value>,
    pub coding: Option<(Coding, Coding)>,
    /// Whether exiting E8 goes ahead without asking while it is open, as :noquery.
    pub noquery: bool,
}

/// What opens a network connection or server, as make-network-process takes it.
pub struct NetworkSpec {
    pub name: String,
    pub buffer: Option<String>,
    /// The host to connect to or listen on; None for a local socket.
    pub host: Option<String>,
    /// The port, "t" for any free one when listening, or a local socket's file.
    pub service: String,
    pub server: bool,
    pub filter: Option<Value>,
    pub sentinel: Option<Value>,
    pub coding: Option<(Coding, Coding)>,
}

/// Reads a stream in chunks, sending the bytes on to be decoded. With a
/// gate, it waits until there is something to read, then reads it and sends
/// it on holding the gate's lock, so the editor, holding the lock, knows
/// whatever has been read has been sent ([`OutputGate`]); `delay` holds each
/// read back, for tests of a reader that is slow to run. `event` makes what
/// is sent of each chunk: output, or standard error.
fn read_stream(
    id: u64,
    mut stream: impl Read + Send + 'static,
    tx: EventSender,
    gate: Option<(Arc<Mutex<()>>, i32)>,
    delay: Duration,
    event: fn(u64, Vec<u8>) -> Event,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            #[cfg(unix)]
            if let Some((_, fd)) = &gate {
                let mut ready = libc::pollfd { fd: *fd, events: libc::POLLIN, revents: 0 };
                // SAFETY: poll reads and writes the one pollfd given it.
                if unsafe { libc::poll(&mut ready, 1, -1) } < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                    break;
                }
            }
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let _reading = gate.as_ref().map(|(lock, _)| lock.lock().unwrap_or_else(|e| e.into_inner()));
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(event(id, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(Event::Closed(id));
    });
}

/// A pseudo-terminal set up as Emacs's child_setup_tty sets one up for a
/// process: no echo, no carriage return before each newline, signals from
/// C-c and C-\, eight bits, and no erase or kill processing.
#[cfg(unix)]
fn open_pty() -> std::io::Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd, String)> {
    use std::os::fd::{FromRawFd, OwnedFd};
    let (mut master, mut slave) = (0, 0);
    let size = libc::winsize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: openpty fills in two descriptors it opens, which we then own.
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &size as *const _ as *mut _) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: just opened by openpty, and owned by nothing else.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    use std::os::fd::AsRawFd;
    // SAFETY: termios is plain data, filled in by tcgetattr before use.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: slave is an open terminal and t a valid termios.
    unsafe {
        if libc::tcgetattr(slave.as_raw_fd(), &mut t) == 0 {
            t.c_oflag |= libc::OPOST;
            t.c_oflag &= !libc::ONLCR;
            t.c_lflag &= !libc::ECHO;
            t.c_lflag |= libc::ISIG;
            t.c_iflag &= !libc::ISTRIP;
            t.c_cflag = (t.c_cflag & !libc::CSIZE) | libc::CS8;
            t.c_cc[libc::VERASE] = libc::_POSIX_VDISABLE as libc::cc_t;
            t.c_cc[libc::VKILL] = libc::_POSIX_VDISABLE as libc::cc_t;
            libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &t);
        }
    }
    // SAFETY: ttyname returns a pointer to a static string or null.
    let tty = unsafe {
        let name = libc::ttyname(slave.as_raw_fd());
        if name.is_null() { String::new() } else { std::ffi::CStr::from_ptr(name).to_string_lossy().into_owned() }
    };
    Ok((master, slave, tty))
}

/// Takes connections until the server is deleted, passing each on.
fn accept_loop(id: u64, tx: &EventSender, stop: &AtomicBool, mut accept: impl FnMut() -> std::io::Result<(Conn, String)>) {
    while !stop.load(Ordering::Relaxed) {
        match accept() {
            Ok((conn, peer)) => {
                if let Conn::Tcp(s) = &conn {
                    let _ = s.set_nonblocking(false);
                }
                #[cfg(unix)]
                if let Conn::Local(s) = &conn {
                    let _ = s.set_nonblocking(false);
                }
                if tx.send(Event::Accepted(id, conn, peer)).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return,
        }
    }
}

impl Editor {
    /// Calls `wake` whenever a process or network connection has output or
    /// an event to take in, so whatever waits for input, as the editor's
    /// thread does, takes it at once rather than at its next timer.
    pub fn set_process_waker(&mut self, wake: Waker) {
        *self.processes.tx.wake.lock().unwrap_or_else(|e| e.into_inner()) = Some(wake);
    }
}

impl Editor {
    /// Starts a program running alongside the editor, as Emacs's
    /// make-process, and returns its name, made unique with "<1>" and so
    /// on as Emacs does. Asks the agent's permission first.
    pub fn make_process(&mut self, spec: ProcessSpec) -> Result<String> {
        let program = spec.command.first().ok_or_else(|| Error::new("No program to run"))?.clone();
        // The pipe process its standard error goes to, as :stderr.
        if let Some(id) = spec.stderr_process {
            let p = self.processes.list.iter().find(|p| p.id == id);
            if !matches!(p.map(|p| &p.kind), Some(Kind::PipeProcess(Some(_)))) {
                let name = p.map_or_else(|| self.process_info(id).map_or_else(|| id.to_string(), |i| i.name), |p| p.name.clone());
                return Err(Error::new(format!("Process {name} is not an open pipe process")));
            }
        }
        self.check_permission(&format!("run {}", spec.command.join(" ")))?;
        let buffer = spec.buffer.as_ref().map(|name| self.get_buffer_create(name));
        let dir = match &spec.directory {
            Some(d) => self.expand_file_name(d),
            None => self.expand_file_name("."),
        };
        let mut command = Command::new(&program);
        command.args(&spec.command[1..]).current_dir(&dir).env("TERM", "dumb").env("INSIDE_EMACS", "e8");
        for (k, v) in &spec.env {
            command.env(k, v);
        }
        #[cfg(unix)]
        let pty = if spec.pty { Some(open_pty().map_err(|e| Error::new(format!("Opening a pseudo-terminal: {e}")))?) } else { None };
        #[cfg(not(unix))]
        let pty: Option<((), (), String)> = None;
        #[cfg(unix)]
        let gate_fd: std::os::fd::OwnedFd;
        let mut errors: Option<std::io::PipeReader> = None;
        let mut output: Box<dyn Read + Send> = match &pty {
            #[cfg(unix)]
            Some((master, slave, _)) => {
                // The terminal is the program's input, output and error, and
                // its controlling terminal, in a session of its own.
                command.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave.try_clone()?));
                use std::os::unix::process::CommandExt;
                // SAFETY: setsid and the ioctl are async-signal-safe, as pre_exec needs.
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                        Ok(())
                    });
                }
                gate_fd = master.try_clone()?;
                Box::new(std::fs::File::from(master.try_clone()?))
            }
            #[cfg(not(unix))]
            Some(_) => unreachable!(),
            None => {
                // Standard output and error share one pipe, as Emacs gives a
                // process, so what it writes comes in the order it wrote it.
                let (output, writer) = std::io::pipe().map_err(|e| Error::new(format!("Making a pipe: {e}")))?;
                #[cfg(unix)]
                {
                    gate_fd = std::os::fd::OwnedFd::from(output.try_clone()?);
                }
                // Standard error in a pipe of its own when it has a buffer.
                let stderr = if spec.stderr_buffer.is_some() {
                    let (reader, writer) = std::io::pipe().map_err(|e| Error::new(format!("Making a pipe: {e}")))?;
                    errors = Some(reader);
                    Stdio::from(writer)
                } else if spec.merge_stderr {
                    Stdio::from(writer.try_clone()?)
                } else {
                    Stdio::null()
                };
                command.stdin(Stdio::piped()).stdout(writer).stderr(stderr);
                // Its own process group, so signals reach what it starts too.
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                Box::new(output)
            }
        };
        // Standard error to a pipe process, whose end the program now has
        // alone, so the pipe ends when it does, as Emacs gives it.
        if let Some(id) = spec.stderr_process
            && let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id)
            && let Kind::PipeProcess(end) = &mut p.kind
            && let Some(end) = end.take()
        {
            command.stderr(Stdio::from(end));
        }
        let mut child = command.spawn().map_err(|e| crate::fileops::file_error("Searching for program", &e, &[std::path::Path::new(&program)]))?;
        // The command holds the other ends, which must close here for the
        // end of the output to be seen.
        drop(command);
        let name = self.unique_process_name(&spec.name);
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        let (stdin, kind) = match pty {
            #[cfg(unix)]
            Some((master, slave, tty)) => {
                let input = std::fs::File::from(master.try_clone()?);
                (Some(writer(input, || {})), Kind::Pty { master: std::fs::File::from(master), tty, _slave: slave })
            }
            #[cfg(not(unix))]
            Some(_) => unreachable!(),
            None => (child.stdin.take().map(|input| writer(input, || {})), Kind::Pipe),
        };
        let gate = OutputGate {
            lock: Arc::new(Mutex::new(())),
            #[cfg(unix)]
            fd: gate_fd,
        };
        #[cfg(unix)]
        let raw = {
            use std::os::fd::AsRawFd;
            gate.fd.as_raw_fd()
        };
        // Without poll the reader cannot wait outside its lock, so elsewhere
        // a process keeps the 200 ms rule.
        #[cfg(not(unix))]
        let (raw, gate) = { let _ = gate; (-1, None::<OutputGate>) };
        #[cfg(unix)]
        let gate = Some(gate);
        read_stream(
            id,
            std::mem::replace(&mut output, Box::new(std::io::empty())),
            self.processes.tx.clone(),
            gate.as_ref().map(|g| (g.lock.clone(), raw)),
            self.processes.read_delay,
            Event::Output,
        );
        let mut open_streams = 1;
        let stderr = match (errors, &spec.stderr_buffer) {
            (Some(errors), Some(name)) => {
                read_stream(id, errors, self.processes.tx.clone(), None, self.processes.read_delay, Event::Stderr);
                open_streams += 1;
                let index = self.get_buffer_create(name);
                let b = &mut self.buffers[index];
                let end = b.len();
                Some(StderrBuffer { buffer: b.id, mark: b.make_marker(end, false), pending: Vec::new() })
            }
            _ => None,
        };
        let coding = spec.coding.unwrap_or_else(|| self.default_process_coding());
        let (buffer_id, mark) = match buffer {
            Some(index) => {
                let b = &mut self.buffers[index];
                let end = b.len();
                (Some(b.id), Some(b.make_marker(end, false)))
            }
            None => (None, None),
        };
        let inherit_coding = self.inherits_coding(buffer_id);
        self.processes.list.push(Process {
            id,
            name: name.clone(),
            buffer: buffer_id,
            mark,
            command: spec.command,
            status: Status::Run,
            pid: child.id(),
            stdin,
            child: Some(child),
            open_streams,
            filter: spec.filter,
            sentinel: spec.sentinel,
            plist: Value::Null,
            held_output: String::new(),
            query_on_exit: true,
            inherit_coding,
            exited: None,
            kind,
            coding,
            pending: Vec::new(),
            gate,
            stderr,
        });
        Ok(name)
    }

    /// The codings a new process gets: coding-system-for-read and -write if
    /// bound, else default-process-coding-system's, as Emacs chooses.
    pub fn default_process_coding(&self) -> (Coding, Coding) {
        let named = |v: Option<Value>| v.and_then(|v| v.as_str().and_then(Coding::parse));
        let (mut decode, mut encode) = match self.variable("default-process-coding-system") {
            Some(Value::List(pair)) if pair.len() == 2 => (named(pair.first().cloned()), named(pair.get(1).cloned())),
            _ => (None, None),
        };
        decode = named(self.variable("coding-system-for-read")).or(decode);
        encode = named(self.variable("coding-system-for-write")).or(encode);
        let utf8 = Coding::named("utf-8-unix");
        (decode.unwrap_or(utf8), encode.unwrap_or(utf8))
    }

    /// A new process's process-inherit-coding-system-flag: set when it has
    /// a buffer and inherit-process-coding-system is, as make-process sets it.
    fn inherits_coding(&self, buffer: Option<u64>) -> bool {
        buffer.is_some() && self.variable("inherit-process-coding-system").is_some_and(|v| v.is_true())
    }

    /// A process's process-inherit-coding-system-flag, listed or gone.
    pub fn process_inherit_coding_system_flag(&self, id: u64) -> Option<bool> {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => Some(p.inherit_coding),
            None => self.processes.gone.get(&id).map(|g| g.inherit_coding),
        }
    }

    /// Sets a process's process-inherit-coding-system-flag, listed or gone.
    /// E8 keeps it, as Emacs does, though it decides nothing yet.
    pub fn set_process_inherit_coding_system_flag(&mut self, id: u64, flag: bool) {
        if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
            p.inherit_coding = flag;
        } else if let Some(g) = self.processes.gone.get_mut(&id) {
            g.inherit_coding = flag;
        }
    }

    /// Whether a process has given its terminal to a job of its own, as
    /// process-running-child-p: the foreground group's id if so, None if
    /// not, and true where E8 cannot tell, as for a program on pipes. An
    /// error for a connection or pipe process, or one that has gone.
    pub fn process_running_child_p(&self, id: u64) -> Result<Value> {
        // One that has ended is not active, though listed until its
        // sentinel has run, as Emacs's closes its descriptors first.
        let Some(p) = self.processes.list.iter().find(|p| p.id == id && (p.status == Status::Run || matches!(p.kind, Kind::Network(_) | Kind::Server(..) | Kind::PipeProcess(_)))) else {
            let name = self.process_info(id).map_or_else(|| id.to_string(), |i| i.name);
            return Err(Error::new(format!("Process {name} is not active")));
        };
        match &p.kind {
            Kind::Network(_) | Kind::Server(..) | Kind::PipeProcess(_) => Err(Error::new(format!("Process {} is not a subprocess", p.name))),
            #[cfg(unix)]
            Kind::Pty { master, .. } => {
                use std::os::fd::AsRawFd;
                // SAFETY: tcgetpgrp only reads the terminal's foreground group.
                let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
                Ok(if group == p.pid as i32 {
                    Value::Null
                } else if group > 0 {
                    Value::Number(group as f64)
                } else {
                    Value::Bool(true)
                })
            }
            Kind::Pipe => Ok(Value::Bool(true)),
        }
    }

    /// Whether the editor is waiting for the user to type, as Emacs's
    /// waiting-for-user-input-p: true while filters, sentinels and timers
    /// run from the command loop's wait for keys, false while they run from
    /// accept-process-output, sleep-for or a command.
    pub fn waiting_for_user_input_p(&self) -> bool {
        // The command loop runs within sleep-for too, which reads no keys
        // in Emacs, so a filter run there is not waiting for them.
        self.processes.waiting_for_user_input && self.processes.waits_reading_keys.last() != Some(&false)
    }

    /// Runs the timers and takes in processes' output, as
    /// [`Editor::run_timers`], as the command loop does while it waits for
    /// a key: waiting-for-user-input-p is true meanwhile.
    pub fn run_timers_awaiting_input(&mut self) {
        self.with_awaiting_input(true, Editor::run_timers);
    }

    /// Runs `f` with waiting-for-user-input-p false, as Emacs's
    /// wait_reading_process_output binds it when it does not read keys.
    pub(crate) fn not_awaiting_input<T>(&mut self, f: impl FnOnce(&mut Editor) -> T) -> T {
        self.with_awaiting_input(false, f)
    }

    /// Runs `f` with waiting-for-user-input-p's flag set as given, put
    /// back afterwards even if `f` panics, as the driver survives a panic.
    fn with_awaiting_input<T>(&mut self, awaiting: bool, f: impl FnOnce(&mut Editor) -> T) -> T {
        let was = std::mem::replace(&mut self.processes.waiting_for_user_input, awaiting);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(self)));
        self.processes.waiting_for_user_input = was;
        result.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }

    /// A unique process name, made so with "<1>" and on as Emacs does.
    fn unique_process_name(&self, base: &str) -> String {
        let mut name = base.to_string();
        let mut n = 1;
        while self.processes.list.iter().any(|p| p.name == name) {
            name = format!("{base}<{n}>");
            n += 1;
        }
        name
    }

    /// Makes a pipe process, as Emacs's make-pipe-process: no program, its
    /// output what is written to the pipe's other end, which a program
    /// started with it as its standard error writes to. It is "open" until
    /// that program has ended, or it is deleted, and then "closed", its
    /// sentinel told "finished". Returns its name, made unique.
    pub fn make_pipe_process(&mut self, spec: PipeSpec) -> Result<String> {
        let (reader, end) = std::io::pipe().map_err(|e| Error::new(format!("Making a pipe: {e}")))?;
        let name = self.unique_process_name(&spec.name);
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        read_stream(id, reader, self.processes.tx.clone(), None, self.processes.read_delay, Event::Output);
        let buffer = spec.buffer.as_ref().map(|name| self.get_buffer_create(name));
        let (buffer_id, mark) = match buffer {
            Some(index) => {
                let b = &mut self.buffers[index];
                let end = b.len();
                (Some(b.id), Some(b.make_marker(end, false)))
            }
            None => (None, None),
        };
        let coding = spec.coding.unwrap_or_else(|| self.default_process_coding());
        let inherit_coding = self.inherits_coding(buffer_id);
        self.processes.list.push(Process {
            id,
            name: name.clone(),
            buffer: buffer_id,
            mark,
            command: Vec::new(),
            status: Status::Run,
            child: None,
            // What is sent to it goes nowhere, as in Emacs, where nothing
            // reads the pipe it writes to.
            stdin: Some(writer(std::io::sink(), || {})),
            pid: 0,
            open_streams: 1,
            filter: spec.filter,
            sentinel: spec.sentinel,
            plist: Value::Null,
            held_output: String::new(),
            query_on_exit: !spec.noquery,
            inherit_coding,
            exited: None,
            kind: Kind::PipeProcess(Some(end)),
            coding,
            pending: Vec::new(),
            gate: None,
            stderr: None,
        });
        Ok(name)
    }

    /// Opens a network connection, or a server listening for them, as
    /// make-network-process: TCP to a host and port, or a local socket
    /// with no host. A server's connections are processes of their own,
    /// named after it and who connected. Asks the agent's permission.
    pub fn make_network_process(&mut self, spec: NetworkSpec) -> Result<String> {
        let what = match &spec.host {
            Some(host) => format!("{host}:{}", spec.service),
            None => spec.service.clone(),
        };
        let verb = if spec.server { "listen on" } else { "connect to" };
        self.check_permission(&format!("{verb} {what}"))?;
        let name = self.unique_process_name(&spec.name);
        let failed = |e: std::io::Error| {
            Error::signal("file-error", format!("make client process failed: {e}, :name, {}, :service, {}", spec.name, spec.service), vec![])
        };
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        let mut contact = Contact { host: spec.host.clone(), service: spec.service.clone(), remote: None };
        let (kind, stdin, open_streams) = if spec.server {
            let stop = Arc::new(AtomicBool::new(false));
            let tx = self.processes.tx.clone();
            let flag = stop.clone();
            match &spec.host {
                Some(host) => {
                    let port = if spec.service == "t" { "0" } else { spec.service.as_str() };
                    let host = if host == "local" { "127.0.0.1" } else { host.as_str() };
                    let listener = std::net::TcpListener::bind(format!("{host}:{port}")).map_err(failed)?;
                    contact.service = listener.local_addr().map(|a| a.port().to_string()).unwrap_or(contact.service);
                    listener.set_nonblocking(true)?;
                    std::thread::spawn(move || accept_loop(id, &tx, &flag, || listener.accept().map(|(s, a)| (Conn::Tcp(s), a.to_string()))));
                }
                #[cfg(unix)]
                None => {
                    let listener = std::os::unix::net::UnixListener::bind(&spec.service).map_err(failed)?;
                    listener.set_nonblocking(true)?;
                    let mut n = 0;
                    std::thread::spawn(move || {
                        accept_loop(id, &tx, &flag, || {
                            listener.accept().map(|(s, _)| {
                                n += 1;
                                (Conn::Local(s), n.to_string())
                            })
                        })
                    });
                }
                #[cfg(not(unix))]
                None => return Err(Error::new("Local sockets are not supported here")),
            }
            (Kind::Server(contact, stop), None, 0)
        } else {
            let conn = match &spec.host {
                Some(host) => {
                    let host = if host == "local" { "127.0.0.1" } else { host.as_str() };
                    Conn::Tcp(std::net::TcpStream::connect(format!("{host}:{}", spec.service)).map_err(failed)?)
                }
                #[cfg(unix)]
                None => Conn::Local(std::os::unix::net::UnixStream::connect(&spec.service).map_err(failed)?),
                #[cfg(not(unix))]
                None => return Err(Error::new("Local sockets are not supported here")),
            };
            let stdin = self.connect(id, conn)?;
            (Kind::Network(contact), Some(stdin), 1)
        };
        let buffer = spec.buffer.as_ref().map(|name| self.get_buffer_create(name));
        let (buffer_id, mark) = match buffer {
            Some(index) => {
                let b = &mut self.buffers[index];
                let end = b.len();
                (Some(b.id), Some(b.make_marker(end, false)))
            }
            None => (None, None),
        };
        let coding = spec.coding.unwrap_or_else(|| self.default_process_coding());
        let inherit_coding = self.inherits_coding(buffer_id);
        self.processes.list.push(Process {
            id,
            name: name.clone(),
            buffer: buffer_id,
            mark,
            command: Vec::new(),
            status: Status::Run,
            child: None,
            stdin,
            pid: 0,
            open_streams,
            filter: spec.filter,
            sentinel: spec.sentinel,
            plist: Value::Null,
            held_output: String::new(),
            query_on_exit: true,
            inherit_coding,
            exited: None,
            kind,
            coding,
            pending: Vec::new(),
            gate: None,
            stderr: None,
        });
        Ok(name)
    }

    /// Starts reading a connection and returns where to send it text.
    fn connect(&mut self, id: u64, conn: Conn) -> Result<Sender<Option<Vec<u8>>>> {
        let reader = conn.try_clone()?;
        let closer = conn.try_clone()?;
        read_stream(id, reader, self.processes.tx.clone(), None, Duration::ZERO, Event::Output);
        Ok(writer(conn, move || closer.shutdown(std::net::Shutdown::Write)))
    }

    /// A connection a server took becomes a process of its own, as Emacs's
    /// server_accept_connection makes one: named after the server and who
    /// connected, with the server's filter, sentinel and codings, and a
    /// buffer of its own if the server writes to one.
    fn accept_connection(&mut self, server: u64, conn: Conn, peer: String) {
        let Some(s) = self.processes.list.iter().find(|p| p.id == server) else { return };
        let Kind::Server(contact, _) = &s.kind else { return };
        let label = format!("{} <{peer}>", s.name);
        let base = s.name.clone();
        let (filter, sentinel, coding, plist) = (s.filter.clone(), s.sentinel.clone(), s.coding, s.plist.clone());
        let buffer_name = (s.filter.is_none()).then(|| {
            let base = s.buffer.and_then(|b| self.buffers.iter().find(|x| x.id == b)).map_or(base.clone(), |b| b.name.clone());
            format!("{base} <{peer}>")
        });
        let host = peer.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_else(|| "-".into());
        let contact = Contact { remote: Some(peer.clone()), ..contact.clone() };
        let name = self.unique_process_name(&label);
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        let Ok(stdin) = self.connect(id, conn) else { return };
        let (buffer_id, mark) = match buffer_name.map(|n| self.get_buffer_create(&n)) {
            Some(index) => {
                let b = &mut self.buffers[index];
                let end = b.len();
                (Some(b.id), Some(b.make_marker(end, false)))
            }
            None => (None, None),
        };
        let inherit_coding = self.inherits_coding(buffer_id);
        self.processes.list.push(Process {
            id,
            name: name.clone(),
            buffer: buffer_id,
            mark,
            command: Vec::new(),
            status: Status::Run,
            child: None,
            stdin: Some(stdin),
            pid: 0,
            open_streams: 1,
            filter,
            sentinel: sentinel.clone(),
            // A copy of the server's, as server_accept_connection gives it.
            plist,
            held_output: String::new(),
            query_on_exit: true,
            inherit_coding,
            exited: None,
            kind: Kind::Network(contact),
            coding,
            pending: Vec::new(),
            gate: None,
            stderr: None,
        });
        if let Some(f) = sentinel
            && let Err(e) = self.funcall(&f, &[Value::Process(id), Value::Str(format!("open from {host}\n"))])
        {
            self.message(format!("error in process sentinel: {e}"));
        }
    }

    fn process(&self, name: &str) -> Result<&Process> {
        self.processes.list.iter().find(|p| p.name == name).ok_or_else(|| Error::new(format!("Process {name} does not exist")))
    }

    fn process_mut(&mut self, name: &str) -> Result<&mut Process> {
        self.processes.list.iter_mut().find(|p| p.name == name).ok_or_else(|| Error::new(format!("Process {name} does not exist")))
    }

    /// The processes, oldest first, as Emacs's process-list.
    pub fn process_list(&self) -> Vec<String> {
        self.processes.list.iter().map(|p| p.name.clone()).collect()
    }

    /// The processes' ids, oldest first, as process-list gives its objects.
    pub fn process_ids(&self) -> Vec<u64> {
        self.processes.list.iter().map(|p| p.id).collect()
    }

    /// The id of the listed process with a name, as get-process finds it.
    pub fn process_named(&self, name: &str) -> Option<u64> {
        self.processes.list.iter().find(|p| p.name == name).map(|p| p.id)
    }

    /// The name of the listed process with an id: none once it has gone.
    pub fn listed_process_name(&self, id: u64) -> Option<String> {
        self.processes.list.iter().find(|p| p.id == id).map(|p| p.name.clone())
    }

    /// What can be asked of a process by its id, listed or gone, as its
    /// object answers in Emacs; none for an id no process had.
    pub fn process_info(&self, id: u64) -> Option<ProcessInfo> {
        let buffer = |b: Option<u64>| b.and_then(|b| self.buffers.iter().find(|x| x.id == b)).map(|b| b.name.clone());
        if let Some(p) = self.processes.list.iter().find(|p| p.id == id) {
            return Some(ProcessInfo {
                name: p.name.clone(),
                command: p.command.clone(),
                status: p.status,
                status_name: p.status_name(),
                kind: p.kind_name(),
                buffer: buffer(p.buffer),
                mark: p.mark,
                pid: (p.pid != 0).then_some(p.pid),
                query_on_exit: p.query_on_exit,
                listed: true,
            });
        }
        let g = self.processes.gone.get(&id)?;
        Some(ProcessInfo {
            name: g.name.clone(),
            command: g.command.clone(),
            status: g.status,
            status_name: g.status_name,
            kind: g.kind,
            buffer: buffer(g.buffer),
            mark: g.mark,
            pid: (g.pid != 0).then_some(g.pid),
            query_on_exit: g.query_on_exit,
            listed: false,
        })
    }

    /// The codings of a process by id, listed or gone.
    pub fn process_coding_system_of(&self, id: u64) -> Option<(Coding, Coding)> {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => Some(p.coding),
            None => self.processes.gone.get(&id).map(|g| g.coding),
        }
    }

    /// The process writing to a buffer, by id, as get-buffer-process.
    pub fn buffer_process_id(&self, buffer: &str) -> Option<u64> {
        let id = self.buffers.iter().find(|b| b.name == buffer)?.id;
        self.processes.list.iter().find(|p| p.buffer == Some(id)).map(|p| p.id)
    }

    /// A process's filter, as process-filter: None for the default, and
    /// `true` for `t`. A process that has gone keeps its own, as in Emacs.
    pub fn process_filter(&self, id: u64) -> Option<Value> {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => p.filter.clone(),
            None => self.processes.gone.get(&id).and_then(|g| g.filter.clone()),
        }
    }

    /// Sets a process's filter, as set-process-filter: nil for the default,
    /// `t` to hold its output back until another is set. A process that
    /// has gone keeps it, though it has no more output to give it.
    pub fn set_process_filter(&mut self, id: u64, filter: Value) {
        let filter = (!filter.is_nil()).then_some(filter);
        if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
            p.filter = filter;
        } else if let Some(g) = self.processes.gone.get_mut(&id) {
            g.filter = filter;
        }
    }

    /// A process's sentinel, as process-sentinel: None for the default.
    pub fn process_sentinel(&self, id: u64) -> Option<Value> {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => p.sentinel.clone(),
            None => self.processes.gone.get(&id).and_then(|g| g.sentinel.clone()),
        }
    }

    /// Sets a process's sentinel, as set-process-sentinel: nil for the
    /// default. A process that has gone keeps it, never to run it.
    pub fn set_process_sentinel(&mut self, id: u64, sentinel: Value) {
        let sentinel = (!sentinel.is_nil()).then_some(sentinel);
        if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
            p.sentinel = sentinel;
        } else if let Some(g) = self.processes.gone.get_mut(&id) {
            g.sentinel = sentinel;
        }
    }

    /// A process's property list, as process-plist: [prop, value, ...].
    pub fn process_plist(&self, id: u64) -> Value {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => p.plist.clone(),
            None => self.processes.gone.get(&id).map_or(Value::Null, |g| g.plist.clone()),
        }
    }

    /// Replaces a process's property list, as set-process-plist, listed or gone.
    pub fn set_process_plist(&mut self, id: u64, plist: Value) -> Result<()> {
        if !matches!(plist, Value::List(_) | Value::Null) {
            return Err(Error::signal("wrong-type-argument", format!("Wrong type argument: listp, {plist}"), vec![Value::Symbol("listp".into()), plist]));
        }
        if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
            p.plist = plist;
        } else if let Some(g) = self.processes.gone.get_mut(&id) {
            g.plist = plist;
        }
        Ok(())
    }

    pub fn process_status(&self, name: &str) -> Option<Status> {
        self.process(name).ok().map(|p| p.status)
    }

    pub fn process_command(&self, name: &str) -> Option<Vec<String>> {
        self.process(name).ok().map(|p| p.command.clone())
    }

    pub fn process_id(&self, name: &str) -> Option<u32> {
        self.process(name).ok().map(|p| p.pid)
    }

    /// The name of the buffer a process writes to.
    pub fn process_buffer(&self, name: &str) -> Option<String> {
        let id = self.process(name).ok()?.buffer?;
        self.buffers.iter().find(|b| b.id == id).map(|b| b.name.clone())
    }

    /// The marker where a process's output goes, as process-mark.
    pub fn process_mark(&self, name: &str) -> Option<u64> {
        self.process(name).ok()?.mark
    }

    /// The process writing to a buffer, if one is, as get-buffer-process.
    pub fn buffer_process(&self, buffer: &str) -> Option<String> {
        let id = self.buffers.iter().find(|b| b.name == buffer)?.id;
        self.processes.list.iter().find(|p| p.buffer == Some(id)).map(|p| p.name.clone())
    }

    pub fn process_query_on_exit(&self, name: &str) -> bool {
        self.process(name).is_ok_and(|p| p.query_on_exit)
    }

    pub fn set_process_query_on_exit(&mut self, name: &str, query: bool) -> Result<()> {
        self.process_mut(name)?.query_on_exit = query;
        Ok(())
    }

    /// Sends text to a process's input, encoded in its coding, as process-send-string.
    pub fn process_send_string(&mut self, name: &str, text: &str) -> Result<()> {
        let p = self.process_mut(name)?;
        let bytes = p.coding.1.encode_lossy(text).0;
        let stdin = p.stdin.as_ref().ok_or_else(|| Error::new(format!("Process {name} not running")))?;
        stdin.send(Some(bytes)).map_err(|_| Error::new(format!("Process {name} not running")))
    }

    /// Makes a process see the end of its input, as process-send-eof: the
    /// end-of-file character on a terminal, which can go on reading after
    /// it; a pipe or connection is closed for writing.
    pub fn process_send_eof(&mut self, name: &str) -> Result<()> {
        let p = self.process_mut(name)?;
        if p.status != Status::Run {
            return Err(Error::new(format!("Process {name} not running: {}", p.status.event().trim_end())));
        }
        #[cfg(unix)]
        if matches!(p.kind, Kind::Pty { .. }) {
            if let Some(stdin) = &p.stdin {
                let _ = stdin.send(Some(vec![4]));
            }
            return Ok(());
        }
        if let Some(stdin) = p.stdin.take() {
            let _ = stdin.send(None);
        }
        Ok(())
    }

    /// How a process's output is decoded and its input encoded, as process-coding-system.
    pub fn process_coding_system(&self, name: &str) -> Option<(Coding, Coding)> {
        self.process(name).ok().map(|p| p.coding)
    }

    /// Sets how a process's output is decoded and its input encoded, as
    /// set-process-coding-system: a coding without line ends decodes with
    /// them undecided.
    pub fn set_process_coding_system(&mut self, name: &str, decode: Coding, encode: Coding) -> Result<()> {
        let p = self.process_mut(name)?;
        p.coding = (decode, encode.with_eol(Some(encode.eol.unwrap_or(Eol::Unix))));
        Ok(())
    }

    /// The name of a process's terminal, as process-tty-name, if it has one.
    pub fn process_tty_name(&self, name: &str) -> Option<String> {
        match &self.process(name).ok()?.kind {
            #[cfg(unix)]
            Kind::Pty { tty, .. } => Some(tty.clone()),
            _ => None,
        }
    }

    /// What a process is, as process-type: "real" for a program, "network" for a connection or server.
    pub fn process_type(&self, name: &str) -> Option<&'static str> {
        Some(self.process(name).ok()?.kind_name())
    }

    /// Where a network process connects or listens, as process-contact; None for a program.
    pub fn process_contact(&self, name: &str) -> Option<(Contact, bool)> {
        match &self.process(name).ok()?.kind {
            Kind::Network(c) => Some((c.clone(), false)),
            Kind::Server(c, _) => Some((c.clone(), true)),
            _ => None,
        }
    }

    /// Tells a process's terminal its size, as set-process-window-size; false if it has none.
    pub fn set_process_window_size(&mut self, name: &str, height: u16, width: u16) -> Result<bool> {
        match &self.process(name)?.kind {
            #[cfg(unix)]
            Kind::Pty { master, .. } => {
                use std::os::fd::AsRawFd;
                let size = libc::winsize { ws_row: height, ws_col: width, ws_xpixel: 0, ws_ypixel: 0 };
                // SAFETY: master is an open terminal and size a valid winsize.
                Ok(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } == 0)
            }
            _ => Ok(false),
        }
    }

    /// Hangs up on every process still running, as exiting Emacs does.
    pub(crate) fn hang_up_processes(&mut self) {
        for p in &mut self.processes.list {
            if p.status == Status::Run {
                hang_up(p);
            }
        }
    }

    /// Sends a signal to a process and what it started, as signal-process:
    /// 2 interrupts (interrupt-process), 9 kills (kill-process).
    pub fn signal_process(&mut self, name: &str, signal: i32) -> Result<()> {
        self.signal_process_group(name, signal, false)
    }

    /// Sends a signal as interrupt-process and its kin do: with
    /// `current_group`, to the job in the foreground on the process's
    /// terminal, as a shell's C-c C-c does, else to the process's own group.
    pub fn signal_process_group(&mut self, name: &str, signal: i32, current_group: bool) -> Result<()> {
        let p = self.process_mut(name)?;
        if p.status != Status::Run || p.pid == 0 {
            return Ok(());
        }
        #[cfg(unix)]
        {
            // To the job in the foreground on a terminal, the signal's own
            // character, so the terminal signals it and the shell sees the
            // interrupt too, as Emacs does where signals go via characters.
            if current_group && matches!(p.kind, Kind::Pty { .. }) {
                let c = match signal {
                    libc::SIGINT => Some(3u8),
                    libc::SIGQUIT => Some(0x1c),
                    libc::SIGTSTP => Some(0x1a),
                    _ => None,
                };
                if let (Some(c), Some(stdin)) = (c, &p.stdin) {
                    let _ = stdin.send(Some(vec![c]));
                    return Ok(());
                }
            }
            // The whole group, as the process leads it, or the terminal's foreground one.
            let mut pid = p.pid as i32;
            if current_group && let Kind::Pty { master, .. } = &p.kind {
                use std::os::fd::AsRawFd;
                // SAFETY: tcgetpgrp only reads the terminal's foreground group.
                let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
                if group > 0 {
                    pid = group;
                }
            }
            // SAFETY: kill only sends a signal; a stale pid fails harmlessly.
            unsafe {
                libc::kill(-pid, signal);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            if let Some(child) = p.child.as_mut() {
                let _ = child.kill();
            }
        }
        Ok(())
    }

    /// Kills a process and forgets it, as delete-process. Its sentinel runs.
    /// A connection or server is closed, "deleted".
    pub fn delete_process(&mut self, name: &str) -> Result<()> {
        if self.process(name)?.status == Status::Run && self.process(name)?.pid != 0 {
            self.signal_process(name, 9)?;
        }
        let i = self.processes.list.iter().position(|p| p.name == name).expect("found above");
        let mut p = self.processes.list.remove(i);
        let network = matches!(p.kind, Kind::Network(_) | Kind::Server(..) | Kind::PipeProcess(_));
        if network {
            hang_up(&mut p);
        }
        let status = match p.child.as_mut().map(|c| self.processes.reap(c, p.id)) {
            Some(Some(status)) => exit_status(status),
            _ if network => Status::Exit(0),
            _ => Status::Signal(9),
        };
        let notify = p.status == Status::Run;
        if notify {
            p.status = status;
        }
        // Kept, as Emacs's process object is, before its sentinel runs, so
        // the sentinel can ask about it.
        self.keep_gone(&p);
        if notify {
            self.notify(&p);
        }
        self.forget_marks(p);
        Ok(())
    }

    /// Keeps what can still be asked of a process leaving the list.
    fn keep_gone(&mut self, p: &Process) {
        let gone = Gone {
            name: p.name.clone(),
            command: p.command.clone(),
            status: p.status,
            status_name: p.status_name(),
            kind: p.kind_name(),
            buffer: p.buffer,
            mark: p.mark,
            pid: p.pid,
            query_on_exit: p.query_on_exit,
            inherit_coding: p.inherit_coding,
            coding: p.coding,
            plist: p.plist.clone(),
            filter: p.filter.clone(),
            sentinel: p.sentinel.clone(),
        };
        self.processes.gone.insert(p.id, gone);
    }

    /// Deletes the markers of a process that has gone, its sentinel having run.
    fn forget_marks(&mut self, p: Process) {
        if let Some(gone) = self.processes.gone.get_mut(&p.id) {
            gone.mark = None;
        }
        if let Some(id) = p.mark {
            self.delete_marker(id);
        }
        if let Some(err) = p.stderr {
            self.delete_marker(err.mark);
        }
    }

    /// Holds back each read of a program's output started after this, as a
    /// reader thread slow to be run on a loaded machine is, for tests that
    /// its output still comes before its end.
    #[doc(hidden)]
    pub fn delay_process_reads_for_tests(&mut self, delay: Duration) {
        self.processes.read_delay = delay;
    }

    /// Whether a process is running, so front ends should wake to take its output in.
    pub(crate) fn processes_running(&self) -> bool {
        self.processes.list.iter().any(|p| p.status == Status::Run)
    }

    /// Takes in what processes have written and notices those that have
    /// ended, running filters and sentinels, as Emacs's wait_reading_process_output.
    pub(crate) fn poll_processes(&mut self) {
        self.release_held_output();
        let mut drained = false;
        for _ in 0..CHUNKS_PER_POLL {
            let Some(event) = self.processes.held.pop_front().or_else(|| self.processes.rx.try_recv().ok()) else {
                drained = true;
                break;
            };
            match event {
                Event::Output(id, bytes) => {
                    if self.processes.list.iter().any(|p| p.id == id) {
                        let text = self.decode_output(id, &bytes);
                        if !text.is_empty() {
                            self.process_output(id, &text);
                        }
                    }
                }
                Event::Stderr(id, bytes) => self.process_stderr(id, &bytes),
                Event::Accepted(server, conn, peer) => self.accept_connection(server, conn, peer),
                Event::Closed(id) => {
                    if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
                        p.open_streams = p.open_streams.saturating_sub(1);
                    }
                }
            }
        }
        // Those that have exited, once their output has all come; or, when
        // something they started keeps their output open, a moment after
        // they exited with nothing more arriving, as Emacs notices them.
        let mut ended = Vec::new();
        let mut quiet = Vec::new();
        let now = Instant::now();
        for p in &mut self.processes.list {
            if p.status != Status::Run {
                continue;
            }
            // A pipe process ends when the program writing to it has.
            if matches!(p.kind, Kind::PipeProcess(_)) {
                if p.open_streams == 0 {
                    p.status = Status::Exit(0);
                    p.stdin = None;
                    ended.push(p.id);
                }
                continue;
            }
            // A connection ends when the other side closes it.
            if matches!(p.kind, Kind::Network(_)) {
                if p.open_streams == 0 {
                    p.status = Status::Exit(256);
                    p.stdin = None;
                    ended.push(p.id);
                }
                continue;
            }
            let exited = match p.exited {
                Some(exit) => Some(exit),
                None => match p.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => {
                        p.exited = Some((now, exit_status(status)));
                        p.exited
                    }
                    _ => None,
                },
            };
            let Some((when, status)) = exited else { continue };
            if p.open_streams == 0 {
                p.status = status;
                p.stdin = None;
                ended.push(p.id);
            } else if drained && (p.gate.is_some() || now.duration_since(when) >= Duration::from_millis(200)) {
                quiet.push((p.id, status));
            }
        }
        // Exited, with their output still open, as a terminal's always is,
        // E8 keeping its program's side, and a pipe is when a program's
        // children keep it: they end once what they wrote has all been read,
        // the last of it given them first, as Emacs reads what is waiting
        // before it reports the end. A reader slow to run, or bytes waiting,
        // leave them running until the next poll.
        for (id, status) in quiet {
            let Some(i) = self.processes.list.iter().position(|p| p.id == id) else { continue };
            let mut taken = Vec::new();
            let quiet = match &self.processes.list[i].gate {
                Some(gate) => {
                    let (rx, held) = (&self.processes.rx, &mut self.processes.held);
                    gate.when_quiet(|| {
                        held.extend(rx.try_iter());
                        let (mine, others): (Vec<Event>, Vec<Event>) =
                            held.drain(..).partition(|e| matches!(e, Event::Output(i, _) | Event::Stderr(i, _) | Event::Closed(i) if *i == id));
                        held.extend(others);
                        taken = mine;
                    })
                }
                None => true,
            };
            if !quiet {
                continue;
            }
            for event in taken {
                match event {
                    Event::Output(_, bytes) => {
                        let text = self.decode_output(id, &bytes);
                        if !text.is_empty() {
                            self.process_output(id, &text);
                        }
                    }
                    Event::Stderr(_, bytes) => self.process_stderr(id, &bytes),
                    Event::Closed(_) => {}
                    Event::Accepted(..) => unreachable!("only this process's output is taken"),
                }
            }
            // The output may have run a filter that deleted it.
            let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else { continue };
            if p.status == Status::Run {
                p.status = status;
                p.stdin = None;
                ended.push(p.id);
            }
        }
        for id in ended {
            let Some(i) = self.processes.list.iter().position(|p| p.id == id) else { continue };
            // A process that has ended stays listed, as in Emacs, until deleted;
            // its sentinel runs with it still there.
            let (sentinel, event) = (self.processes.list[i].sentinel.clone(), self.processes.list[i].event());
            self.run_sentinel(id, sentinel, event);
            // Gone from the list once ended and reported, as a process whose
            // status has been noticed and which nothing refers to.
            if let Some(i) = self.processes.list.iter().position(|p| p.id == id && p.status != Status::Run) {
                let p = self.processes.list.remove(i);
                self.keep_gone(&p);
                self.forget_marks(p);
            }
        }
    }

    /// Gives output held while a process's filter was `t` to the filter
    /// set since, in order, as Emacs reads it once the filter is not `t`.
    fn release_held_output(&mut self) {
        let waiting: Vec<(u64, String)> = self
            .processes
            .list
            .iter_mut()
            .filter(|p| !p.held_output.is_empty() && p.filter != Some(Value::Bool(true)))
            .map(|p| (p.id, std::mem::take(&mut p.held_output)))
            .collect();
        for (id, text) in waiting {
            self.process_output(id, &text);
        }
    }

    fn notify(&mut self, p: &Process) {
        self.run_sentinel(p.id, p.sentinel.clone(), p.event());
    }

    /// Runs a process's sentinel with the event, or the default one.
    fn run_sentinel(&mut self, id: u64, sentinel: Option<Value>, event: String) {
        let result = match sentinel {
            Some(f) if !f.is_nil() => self.funcall(&f, &[Value::Process(id), Value::Str(event)]).map(drop),
            _ => {
                self.internal_default_process_sentinel(id, &event);
                Ok(())
            }
        };
        if let Err(e) = result {
            self.message(format!("error in process sentinel: {e}"));
        }
    }

    /// What a process's sentinel does by default, as Emacs's
    /// internal-default-process-sentinel: a line saying what happened, at
    /// its mark in its buffer.
    pub fn internal_default_process_sentinel(&mut self, id: u64, event: &str) {
        let Some((name, buffer, mark)) = self.process_place(id) else { return };
        let line = format!("\nProcess {name} {event}");
        self.insert_process_text(buffer, mark, &line, false);
    }

    /// What a process's filter does by default, as Emacs's
    /// internal-default-process-filter: the text inserted at its mark in
    /// its buffer, point moving along if it was there.
    pub fn internal_default_process_filter(&mut self, id: u64, text: &str) {
        let Some((_, buffer, mark)) = self.process_place(id) else { return };
        self.insert_process_text(buffer, mark, text, true);
    }

    /// A process's name, buffer and mark, listed or gone.
    fn process_place(&self, id: u64) -> Option<(String, Option<u64>, Option<u64>)> {
        match self.processes.list.iter().find(|p| p.id == id) {
            Some(p) => Some((p.name.clone(), p.buffer, p.mark)),
            None => self.processes.gone.get(&id).map(|g| (g.name.clone(), g.buffer, g.mark)),
        }
    }

    /// Decodes a process's output in its coding, keeping the start of a
    /// character split between reads for the next, as Emacs's decoding
    /// carryover. Line ends decode as the coding says.
    fn decode_output(&mut self, id: u64, bytes: &[u8]) -> String {
        let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else { return String::new() };
        p.pending.extend_from_slice(bytes);
        let utf8 = matches!(p.coding.0.system().coding_type, "utf-8" | "undecided");
        let complete = if utf8 {
            match std::str::from_utf8(&p.pending) {
                Ok(_) => p.pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => p.pending.len(),
            }
        } else {
            p.pending.len()
        };
        let chunk: Vec<u8> = p.pending.drain(..complete).collect();
        p.coding.0.decode(&chunk).0
    }

    /// Waits for output from a process, or from any with `None`, for up to
    /// `secs` seconds, or until it comes, as Emacs's `accept-process-output`:
    /// what comes meanwhile goes to the processes' filters, and timers run,
    /// but keys wait. `C-g` quits it. Whether output came.
    pub fn wait_for_process_output(&mut self, process: Option<&str>, secs: Option<f64>) -> Result<bool> {
        let id = match process {
            Some(name) => Some(self.process(name)?.id),
            None => None,
        };
        self.wait_for_process_output_id(id, secs)
    }

    /// As [`Editor::wait_for_process_output`], the process by its id: one
    /// that has gone has no more output, so it returns false at once.
    pub fn wait_for_process_output_id(&mut self, id: Option<u64>, secs: Option<f64>) -> Result<bool> {
        self.not_awaiting_input(|ed| ed.wait_for_process_output_until(id, secs))
    }

    fn wait_for_process_output_until(&mut self, id: Option<u64>, secs: Option<f64>) -> Result<bool> {
        let deadline = secs.map(|s| Instant::now() + Duration::from_secs_f64(s.max(0.0)));
        loop {
            let before = self.processes.outputs_seen;
            self.processes.watching = id;
            self.run_timers();
            self.processes.watching = None;
            if self.processes.outputs_seen != before {
                return Ok(true);
            }
            if id.is_some_and(|id| !self.processes.list.iter().any(|p| p.id == id && matches!(p.status, Status::Run))) {
                return Ok(false);
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                return Ok(false);
            }
            self.maybe_quit()?;
            // Woken by the next output rather than sleeping a fixed time, so
            // a program that answers at once, as a spell checker does, is
            // read at once; timers and C-g are still looked at as often.
            self.processes.wait_for_event(Duration::from_millis(2));
        }
    }

    /// Inserts what a process wrote to standard error into its stderr
    /// buffer, decoded in its coding as its output is, as Emacs's :stderr
    /// buffer takes it: no filter, and point moving along if at the end.
    fn process_stderr(&mut self, id: u64, bytes: &[u8]) {
        let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else { return };
        let Some(err) = p.stderr.as_mut() else { return };
        err.pending.extend_from_slice(bytes);
        let complete = match std::str::from_utf8(&err.pending) {
            Ok(_) => err.pending.len(),
            Err(e) if e.error_len().is_none() && matches!(p.coding.0.system().coding_type, "utf-8" | "undecided") => e.valid_up_to(),
            Err(_) => err.pending.len(),
        };
        let chunk: Vec<u8> = err.pending.drain(..complete).collect();
        let text = p.coding.0.decode(&chunk).0;
        let (buffer, mark) = (err.buffer, err.mark);
        if !text.is_empty() {
            self.insert_process_text(Some(buffer), Some(mark), &text, true);
        }
    }

    fn process_output(&mut self, id: u64, text: &str) {
        let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else { return };
        // A filter of t holds the output back, as Emacs stops reading it.
        if p.filter == Some(Value::Bool(true)) {
            p.held_output.push_str(text);
            return;
        }
        // What was held while the filter was t comes first, though the
        // filter was set since the last look at processes.
        let text = if p.held_output.is_empty() {
            std::borrow::Cow::Borrowed(text)
        } else {
            let mut held = std::mem::take(&mut p.held_output);
            held.push_str(text);
            std::borrow::Cow::Owned(held)
        };
        let text: &str = &text;
        let filter = p.filter.clone();
        if self.processes.watching.is_none_or(|w| w == id) {
            self.processes.outputs_seen += 1;
        }
        match filter {
            Some(f) if !f.is_nil() => {
                if let Err(e) = self.funcall(&f, &[Value::Process(id), Value::Str(text.to_string())]) {
                    self.message(format!("error in process filter: {e}"));
                }
            }
            _ => self.internal_default_process_filter(id, text),
        }
    }

    /// Inserts text at a process's mark in its buffer, as Emacs's default
    /// filter: point moves along if it was at the mark.
    fn insert_process_text(&mut self, buffer: Option<u64>, mark: Option<u64>, text: &str, advance: bool) {
        let (Some(id), Some(mark)) = (buffer, mark) else { return };
        let Some(b) = self.buffers.iter_mut().find(|b| b.id == id) else { return };
        // At the mark even outside a narrowing, before markers, as Emacs
        // inserts output: point, the mark and other windows' points there
        // move along with it.
        let at = b.marker(mark).unwrap_or(b.len());
        if b.insert_before_markers_at(at, text).is_ok() && !advance {
            // A note of the end goes after the output without moving the mark.
            b.set_marker(mark, at);
        }
    }

    /// Waits up to `timeout` for processes to write or end, then takes their
    /// output in, as accept-process-output. Returns once none runs.
    pub fn accept_process_output(&mut self, timeout: Duration) {
        let until = Instant::now() + timeout;
        loop {
            self.poll_processes();
            if !self.processes_running() || Instant::now() >= until {
                return;
            }
            self.processes.wait_for_event(Duration::from_millis(5).min(until.saturating_duration_since(Instant::now())));
        }
    }

    /// Runs a program and waits for it, as Emacs's call-process, returning
    /// its exit code and what it wrote, standard error after standard
    /// output. Asks the agent's permission first.
    pub fn call_process(&mut self, command: &[String], directory: Option<&str>, input: Option<&str>) -> Result<(i32, String)> {
        let result = self.call_process_with(CallSpec {
            command,
            directory,
            input: input.map(|t| t.as_bytes().to_vec()),
            stderr: CallStderr::Merge,
            wait: true,
        })?;
        let code = match result.status {
            Status::Exit(c) => c,
            Status::Signal(s) => 128 + s,
            Status::Run => 0,
        };
        Ok((code, String::from_utf8_lossy(&result.output).into_owned()))
    }

    /// Runs a program as Emacs's call-process and call-process-region do:
    /// `input` its standard input, else none, as /dev/null; its output
    /// and standard error read until it exits, unless it is not waited
    /// for, as a destination of 0 asks, when both are thrown away and its
    /// status is `Run`. `C-g` kills it. Asks the agent's permission first.
    pub fn call_process_with(&mut self, spec: CallSpec) -> Result<CallResult> {
        let program = spec.command.first().ok_or_else(|| Error::new("No program to run"))?;
        self.check_permission(&format!("run {}", spec.command.join(" ")))?;
        let dir = self.expand_file_name(spec.directory.unwrap_or("."));
        let mut process = Command::new(program);
        process
            .args(&spec.command[1..])
            .current_dir(&dir)
            .env("TERM", "dumb")
            .stdin(if spec.input.is_some() { Stdio::piped() } else { Stdio::null() });
        let spawn_failed = |e: std::io::Error| crate::fileops::file_error("Searching for program", &e, &[std::path::Path::new(program)]);
        if !spec.wait {
            process.stdout(Stdio::null()).stderr(Stdio::null());
            let mut child = process.spawn().map_err(spawn_failed)?;
            if let (Some(bytes), Some(mut stdin)) = (spec.input, child.stdin.take()) {
                std::thread::spawn(move || {
                    let _ = stdin.write_all(&bytes);
                });
            }
            // Reaped when it ends, as Emacs's SIGCHLD handler reaps it.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(CallResult { status: Status::Run, output: Vec::new() });
        }
        let (mut output, writer) = std::io::pipe().map_err(|e| Error::new(format!("Making a pipe: {e}")))?;
        let stderr = match spec.stderr {
            CallStderr::Merge => Stdio::from(writer.try_clone()?),
            CallStderr::Discard => Stdio::null(),
            // The file itself, as Emacs opens it for the program, so nothing
            // waits for whatever the program leaves running to close it.
            // A program writes to the system's files, not the editor's
            // stand-in, so this is std's.
            CallStderr::File(file) => {
                Stdio::from(std::fs::File::create(&file).map_err(|e| crate::fileops::file_error("Opening process output file", &e, &[&file]))?)
            }
        };
        process.stdout(writer).stderr(stderr);
        let mut child = process.spawn().map_err(spawn_failed)?;
        // The command holds the other ends, which must close here for the
        // end of the output to be seen.
        drop(process);
        if let (Some(bytes), Some(mut stdin)) = (spec.input, child.stdin.take()) {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
            });
        }
        // The output is read on a thread of its own, so the editor can
        // quit while the program runs: C-g kills it, as in Emacs.
        let (chunks, read) = std::sync::mpsc::channel::<std::io::Result<Vec<u8>>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match std::io::Read::read(&mut output, &mut buf) {
                    Ok(0) => return,
                    Ok(n) => {
                        if chunks.send(Ok(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        let _ = chunks.send(Err(e));
                        return;
                    }
                }
            }
        });
        let mut bytes = Vec::new();
        loop {
            match read.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(chunk)) => bytes.extend(chunk),
                Ok(Err(e)) => return Err(Error::new(format!("Running {program}: {e}"))),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Err(quit) = self.maybe_quit() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(quit);
            }
        }
        let status = child.wait().map_err(|e| Error::new(format!("Running {program}: {e}")))?;
        Ok(CallResult { status: exit_status(status), output: bytes })
    }
}

/// What call-process-region gives a program as its input.
#[derive(Clone, Debug, PartialEq)]
pub enum RegionInput {
    /// The text between two positions, in either order, within the
    /// accessible portion.
    Region(usize, usize),
    /// The whole buffer, its narrowing aside, as a START of nil.
    Whole,
    /// A string, as a START that is one.
    Text(String),
}

/// Where call-process and call-process-region put what a program writes,
/// as their DESTINATION.
#[derive(Clone, Debug, PartialEq)]
pub enum Destination {
    /// Thrown away, waiting for the program: nil.
    Discard,
    /// Thrown away, not waiting: 0, or any integer.
    NoWait,
    /// Inserted at point in a buffer, by index: t for the current one, or
    /// a buffer or its name, made if there is none.
    Buffer(usize),
    /// Written to a file, as `(:file FILE)`.
    File(String),
}

/// Where call-process sends standard error, as the second element of
/// `(REAL-DESTINATION STDERR)`.
#[derive(Clone, Debug, PartialEq)]
pub enum StderrDestination {
    /// With the output: t, or a destination alone.
    Merge,
    /// Thrown away: nil.
    Discard,
    /// Written to a file.
    File(String),
}

/// Where a program's output and standard error go, as call-process's
/// DESTINATION.
#[derive(Clone, Debug, PartialEq)]
pub struct CallDestination {
    pub output: Destination,
    pub stderr: StderrDestination,
}

impl Editor {
    /// Reads call-process's DESTINATION: t, nil, 0, a buffer or its name,
    /// `(:file FILE)`, or `(REAL-DESTINATION STDERR)` with STDERR nil, t or
    /// a file name.
    pub fn call_destination(&mut self, value: &Value) -> Result<CallDestination> {
        let wrong = |v: &Value| Error::signal("wrong-type-argument", format!("Wrong type argument: stringp, {v}"), vec![Value::Symbol("stringp".into()), v.clone()]);
        let output = |ed: &mut Editor, v: &Value| -> Result<Destination> {
            Ok(match v {
                Value::Null | Value::Bool(false) => Destination::Discard,
                Value::Bool(true) => Destination::Buffer(ed.current),
                // Any integer, as Emacs 30 takes 1, 2 or -1 as it does 0.
                Value::Number(n) if n.fract() == 0.0 => Destination::NoWait,
                Value::Buffer(id) => Destination::Buffer(ed.buffer_with_id(*id).ok_or_else(|| Error::new("Selecting deleted buffer"))?),
                Value::List(items) if items.first().and_then(Value::as_str) == Some(":file") => {
                    let file = items.get(1).and_then(Value::as_str).ok_or_else(|| wrong(v))?;
                    Destination::File(ed.expand_file_name(file).to_string_lossy().into_owned())
                }
                v => Destination::Buffer(ed.get_buffer_create(v.as_str().ok_or_else(|| wrong(v))?)),
            })
        };
        match value {
            Value::List(items) if items.first().and_then(Value::as_str) != Some(":file") => {
                let real = output(self, items.first().unwrap_or(&Value::Null))?;
                let stderr = match items.get(1).unwrap_or(&Value::Null) {
                    Value::Null | Value::Bool(false) => StderrDestination::Discard,
                    Value::Bool(true) => StderrDestination::Merge,
                    v => StderrDestination::File(self.expand_file_name(v.as_str().ok_or_else(|| wrong(v))?).to_string_lossy().into_owned()),
                };
                Ok(CallDestination { output: real, stderr })
            }
            v => Ok(CallDestination { output: output(self, v)?, stderr: StderrDestination::Merge }),
        }
    }

    /// Runs a program with text of the buffer, or a string, as its input,
    /// as Emacs's call-process-region: `delete` deletes the region first;
    /// what it writes goes where `destination` says, inserted at point,
    /// decoded as a process's output is. Returns its exit code, or how
    /// strsignal describes the signal that ended it, or nil if not waited
    /// for. Asks the agent's permission first.
    pub fn call_process_region(&mut self, input: RegionInput, delete: bool, command: &[String], destination: &CallDestination) -> Result<Value> {
        let text = match &input {
            RegionInput::Region(start, end) => {
                let b = self.buffer();
                let (start, end) = (*start.min(end), *start.max(end));
                if start < b.point_min() || end > b.point_max() {
                    return Err(Error::signal(
                        "args-out-of-range",
                        format!("Args out of range: {start}, {end}"),
                        vec![Value::Number(start as f64), Value::Number(end as f64)],
                    ));
                }
                b.slice(start..end)
            }
            RegionInput::Whole => {
                let b = self.buffer();
                b.slice(0..b.len())
            }
            RegionInput::Text(text) => text.clone(),
        };
        if delete {
            match input {
                RegionInput::Region(start, end) => {
                    self.delete_region(start, end)?;
                }
                RegionInput::Whole => {
                    let len = self.buffer().len();
                    self.delete_region(0, len)?;
                }
                RegionInput::Text(text) => {
                    return Err(Error::signal(
                        "wrong-type-argument",
                        format!("Wrong type argument: integer-or-marker-p, {text:?}"),
                        vec![Value::Symbol("integer-or-marker-p".into()), Value::Str(text)],
                    ));
                }
            }
        }
        let coding = self.default_process_coding();
        let input = coding.1.encode_lossy(&text).0;
        let directory = self.expand_file_name(".").to_string_lossy().into_owned();
        let stderr = match &destination.stderr {
            StderrDestination::Merge => CallStderr::Merge,
            StderrDestination::Discard => CallStderr::Discard,
            StderrDestination::File(file) => CallStderr::File(file.clone().into()),
        };
        let wait = destination.output != Destination::NoWait;
        let result = self.call_process_with(CallSpec { command, directory: Some(&directory), input: Some(input), stderr, wait })?;
        match &destination.output {
            Destination::Discard | Destination::NoWait => {}
            Destination::File(file) => {
                crate::vfs::write(file, &result.output).map_err(|e| crate::fileops::file_error("Writing", &e, &[std::path::Path::new(file)]))?;
            }
            Destination::Buffer(index) => {
                let text = coding.0.decode(&result.output).0;
                if !text.is_empty() {
                    self.with_current_buffer(*index, |ed| ed.insert(&text))?;
                }
            }
        }
        Ok(match result.status {
            Status::Run => Value::Null,
            Status::Exit(code) => Value::Number(code as f64),
            Status::Signal(sig) => Value::Str(signal_description(sig)),
        })
    }
}

/// Where a program [`Editor::call_process_with`] runs sends its standard
/// error, as call-process's destination says.
#[derive(Clone, Debug, PartialEq)]
pub enum CallStderr {
    /// With its output, as a destination that is a buffer alone.
    Merge,
    /// Nowhere, as `(BUFFER nil)`.
    Discard,
    /// Into a file, made afresh, as `(BUFFER FILE)`.
    File(std::path::PathBuf),
}

/// What [`Editor::call_process_with`] runs.
pub struct CallSpec<'a> {
    /// The program and its arguments.
    pub command: &'a [String],
    /// The directory it runs in: the buffer's default-directory if none.
    pub directory: Option<&'a str>,
    /// Its standard input; none is /dev/null.
    pub input: Option<Vec<u8>>,
    pub stderr: CallStderr,
    /// Whether to wait for it; if not, its output is thrown away.
    pub wait: bool,
}

/// How a program [`Editor::call_process_with`] ran ended, and what it wrote.
pub struct CallResult {
    /// How it ended; `Run` for one not waited for.
    pub status: Status,
    /// Its output, with its standard error if merged.
    pub output: Vec<u8>,
}

/// How strsignal describes a signal, as call-process returns it for a
/// program a signal ended: "Killed: 9" on macOS, "Killed" on Linux.
pub fn signal_description(sig: i32) -> String {
    #[cfg(unix)]
    {
        // SAFETY: strsignal returns a pointer to a NUL-terminated string,
        // static or thread-local, valid until the next call, copied at once.
        let text = unsafe { libc::strsignal(sig) };
        if !text.is_null() {
            return unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy().into_owned();
        }
    }
    format!("Unknown signal {sig}")
}

impl Process {
    fn is_pty(&self) -> bool {
        #[cfg(unix)]
        return matches!(self.kind, Kind::Pty { .. });
        #[cfg(not(unix))]
        false
    }

    /// The event its sentinel is told, as Emacs's status_message words it: a
    /// connection is "deleted" or "connection broken by remote peer".
    fn event(&self) -> String {
        match (&self.kind, self.status) {
            (Kind::Network(_) | Kind::Server(..), Status::Exit(0)) => "deleted\n".into(),
            (Kind::Network(_) | Kind::Server(..), Status::Exit(_)) => "connection broken by remote peer\n".into(),
            (_, status) => status.event(),
        }
    }

    /// What it is, as process-type: "real" for a program, "network" for a
    /// connection or server, "pipe" for a pipe process.
    fn kind_name(&self) -> &'static str {
        match self.kind {
            Kind::Network(_) | Kind::Server(..) => "network",
            Kind::PipeProcess(_) => "pipe",
            _ => "real",
        }
    }

    /// Its status as process-status names it: a connection is "open" or
    /// "closed", a server "listen".
    fn status_name(&self) -> &'static str {
        match (&self.kind, self.status) {
            (Kind::Server(..), Status::Run) => "listen",
            (Kind::Network(_) | Kind::PipeProcess(_), Status::Run) => "open",
            (Kind::Network(_) | Kind::Server(..) | Kind::PipeProcess(_), _) => "closed",
            (_, Status::Run) => "run",
            (_, Status::Exit(_)) => "exit",
            (_, Status::Signal(_)) => "signal",
        }
    }
}

impl Editor {
    /// A process's status as process-status names it: "run", "exit",
    /// "signal", or for a connection "open", "closed" or "listen".
    pub fn process_status_name(&self, name: &str) -> Option<&'static str> {
        self.process(name).ok().map(|p| p.status_name())
    }
}

fn exit_status(status: std::process::ExitStatus) -> Status {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Status::Signal(sig);
        }
    }
    Status::Exit(status.code().unwrap_or(-1))
}
