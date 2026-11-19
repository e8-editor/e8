//! Serial ports, as Emacs's make-serial-process and
//! serial-process-configure (process.c, with sysdep.c's serial_open and
//! serial_configure): a port opened as a file, read on a thread of its own
//! and configured with termios, a process of process-type `serial`.

use std::os::fd::AsRawFd;

use super::*;
use super::odds::wrong_type;

/// What a serial process keeps of its port.
pub(crate) struct Port {
    file: std::fs::File,
    /// Its contact, as process-contact gives it: the arguments it was made
    /// with, keys with their colons, in order, and what configuring set.
    pub(super) contact: Vec<(String, Value)>,
    /// Set by stop-process, so its reader leaves what comes unread.
    stopped: Arc<AtomicBool>,
    /// Set when it is deleted, so its reader lets go of the port.
    closed: Arc<AtomicBool>,
}

impl Port {
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }

    pub(super) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

/// The value of a key in a plist kept as pairs, as plist-get.
pub(super) fn plist_get<'a>(plist: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    plist.iter().find(|(k, _)| k == key).map(|(_, v)| v).filter(|v| !v.is_nil())
}

/// Whether a plist kept as pairs has a key, as plist-member.
fn plist_member(plist: &[(String, Value)], key: &str) -> bool {
    plist.iter().any(|(k, _)| k == key)
}

/// Sets a key in a plist kept as pairs, in its place or at the end, as plist-put.
pub(super) fn plist_put(plist: &mut Vec<(String, Value)>, key: &str, value: Value) {
    match plist.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => *v = value,
        None => plist.push((key.to_string(), value)),
    }
}

/// A whole number, as CHECK_FIXNUM takes one.
fn fixnum(value: Option<&Value>) -> Result<i64> {
    match value {
        Some(Value::Number(n)) if n.fract() == 0.0 && n.abs() < (1u64 << 61) as f64 => Ok(*n as i64),
        Some(v) => Err(wrong_type("fixnump", v)),
        None => Err(wrong_type("fixnump", &Value::Null)),
    }
}

/// The name of a symbol given as a value, as `odd` or `hw`.
fn symbol_name(value: &Value) -> Option<&str> {
    match value {
        Value::Symbol(s) | Value::Str(s) => Some(s.as_str()),
        _ => None,
    }
}

/// An error from a system call on the port, as report_file_error words it.
fn port_error(doing: &str, e: &std::io::Error, data: Option<&Value>) -> Error {
    let text = e.to_string();
    let why = text.split(" (os error").next().unwrap_or(&text).to_string();
    let mut values = vec![Value::Str(doing.into()), Value::Str(why.clone())];
    values.extend(data.cloned());
    let message = match data {
        Some(d) => format!("{doing}: {why}, {d}"),
        None => format!("{doing}: {why}"),
    };
    Error::signal("file-error", message, values)
}

/// The speeds termios names, as sysdep.c's table converts them: on Linux
/// a speed is a constant of its own, on macOS the number itself.
const SPEEDS: &[(i64, libc::speed_t)] = &[
    (0, libc::B0),
    (50, libc::B50),
    (75, libc::B75),
    (110, libc::B110),
    (134, libc::B134),
    (150, libc::B150),
    (200, libc::B200),
    (300, libc::B300),
    (600, libc::B600),
    (1200, libc::B1200),
    (1800, libc::B1800),
    (2400, libc::B2400),
    (4800, libc::B4800),
    (9600, libc::B9600),
    (19200, libc::B19200),
    (38400, libc::B38400),
    (57600, libc::B57600),
    (115200, libc::B115200),
    (230400, libc::B230400),
];

/// A speed in bits per second as termios takes it, as convert_speed.
fn convert_speed(speed: i64) -> libc::speed_t {
    for (value, internal) in SPEEDS {
        if speed == *internal as i64 {
            return speed as libc::speed_t;
        }
        if speed == *value {
            return *internal;
        }
    }
    speed as libc::speed_t
}

/// Reads a serial port until it is deleted or can no longer be read,
/// leaving what comes unread while it is stopped, as Emacs stops
/// selecting its descriptor. It looks every so often whether it is
/// stopped or deleted, so a deleted port is let go of soon.
fn read_port(id: u64, mut file: std::fs::File, tx: EventSender, stopped: Arc<AtomicBool>, closed: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let fd = file.as_raw_fd();
        let mut buf = [0u8; 4096];
        while !closed.load(Ordering::Relaxed) {
            if stopped.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let mut ready = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            // SAFETY: poll reads and writes the one pollfd given it.
            let r = unsafe { libc::poll(&mut ready, 1, 50) };
            if r < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if r == 0 || stopped.load(Ordering::Relaxed) || closed.load(Ordering::Relaxed) {
                continue;
            }
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Event::Output(id, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(Event::Closed(id));
    });
}

/// Opens a serial port as serial_open does: for reading and writing,
/// without making it the controlling terminal or waiting for a carrier,
/// and for E8 alone; then reads on it wait, as the reader polls first.
fn open_port(port: &str) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK).open(port)?;
    let fd = file.as_raw_fd();
    // SAFETY: fd is open; these only set its flags.
    unsafe {
        libc::ioctl(fd, libc::TIOCEXCL as _);
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
    }
    Ok(file)
}

impl Editor {
    /// Opens a serial port as a process, as make-serial-process: `args`
    /// are its keyword arguments, keys with their colons, in order, which
    /// become its contact. None for no arguments, as Emacs gives nil. Asks
    /// the agent's permission. Configured as serial-process-configure
    /// does, unless its :speed is nil; if that fails, it is gone again.
    pub fn make_serial_process(&mut self, args: Vec<(String, Value)>, filter: Option<Value>, sentinel: Option<Value>, coding: Option<(Coding, Coding)>) -> Result<Option<u64>> {
        if args.is_empty() {
            return Ok(None);
        }
        let port = match plist_get(&args, ":port") {
            None => return Err(Error::new("No port specified")),
            Some(v @ (Value::Str(_) | Value::Text(_))) => v.as_str().unwrap_or_default().to_string(),
            Some(v) => return Err(wrong_type("stringp", v)),
        };
        if !plist_member(&args, ":speed") {
            return Err(Error::new(":speed not specified"));
        }
        if let Some(speed) = plist_get(&args, ":speed") {
            fixnum(Some(speed))?;
        }
        let name = match plist_get(&args, ":name") {
            None => port.clone(),
            Some(v) => v.as_str().ok_or_else(|| wrong_type("stringp", v))?.to_string(),
        };
        self.check_permission(&format!("open serial port {port}"))?;
        let file = open_port(&port).map_err(|e| crate::fileops::file_error("Opening serial port", &e, &[std::path::Path::new(&port)]))?;
        let name = self.unique_process_name(&name);
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        let buffer_name = match plist_get(&args, ":buffer") {
            None => name.clone(),
            Some(Value::Buffer(b)) => self.buffers.iter().find(|x| x.id == *b).map_or_else(|| name.clone(), |x| x.name.clone()),
            Some(v) => v.as_str().map_or_else(|| v.to_string(), str::to_string),
        };
        let index = self.get_buffer_create(&buffer_name);
        let b = &mut self.buffers[index];
        let end = b.len();
        let (buffer_id, mark) = (Some(b.id), Some(b.make_marker(end, false)));
        let stopped = Arc::new(AtomicBool::new(plist_get(&args, ":stop").is_some()));
        let closed = Arc::new(AtomicBool::new(false));
        read_port(id, file.try_clone()?, self.processes.tx.clone(), stopped.clone(), closed.clone());
        let stdin = writer(self.processes.write_delay.clone(), file.try_clone()?, || {});
        let inherit_coding = coding.is_none() && self.inherits_coding(buffer_id);
        let coding = coding.unwrap_or_else(|| (Coding::named("no-conversion"), Coding::named("no-conversion")));
        let plist = match plist_get(&args, ":plist") {
            Some(v @ Value::List(_)) => v.clone(),
            _ => Value::Null,
        };
        let query_on_exit = plist_get(&args, ":noquery").is_none();
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
            sentinel,
            plist,
            held_output: String::new(),
            stopped: false,
            deferred_closes: 0,
            connecting: false,
            datagram: None,
            failed: false,
            query_on_exit,
            inherit_coding,
            exited: None,
            kind: Kind::Serial(Port { file, contact: args.clone(), stopped, closed }),
            coding,
            pending: Vec::new(),
            gate: None,
            stderr: None,
            tls: None,
            socket: None,
        });
        let configured = if plist_get(&args, ":speed").is_some() { self.configure_serial(id, &args) } else { Ok(()) };
        if let Err(e) = configured {
            // Gone again, as Emacs's remove_process unwinds it.
            if let Some(i) = self.processes.list.iter().position(|p| p.id == id) {
                let mut p = self.processes.list.remove(i);
                hang_up(&mut p);
                if let Some(mark) = p.mark {
                    self.delete_marker(mark);
                }
            }
            return Err(e);
        }
        Ok(Some(id))
    }

    /// Configures a serial process's port, as serial-process-configure:
    /// the process is :process, or the one named :name, or writing to
    /// :buffer, or named :port, or the current buffer's. What is not given
    /// stays as its contact says; nothing is done if its :speed is nil.
    pub fn serial_process_configure(&mut self, args: &[(String, Value)]) -> Result<()> {
        let which = [":process", ":name", ":buffer", ":port"].iter().find_map(|k| plist_get(args, k)).cloned().unwrap_or(Value::Null);
        let id = self.get_process(&which)?;
        let Some(p) = self.processes.list.iter().find(|p| p.id == id) else {
            // Deleted, its descriptor closed, as Emacs then fails reading it.
            return match self.process_info(id) {
                Some(info) if info.kind == "serial" => {
                    Err(port_error("Failed tcgetattr", &std::io::Error::from_raw_os_error(libc::EBADF), None))
                }
                _ => Err(Error::new("Not a serial process")),
            };
        };
        let Kind::Serial(port) = &p.kind else { return Err(Error::new("Not a serial process")) };
        if plist_get(&port.contact, ":speed").is_none() {
            return Ok(());
        }
        self.configure_serial(id, args)
    }

    /// Sets a serial port's termios from `args`, or its contact for what
    /// they leave out, as sysdep.c's serial_configure, and keeps what was
    /// set in its contact, with :summary, as "8N1".
    fn configure_serial(&mut self, id: u64, args: &[(String, Value)]) -> Result<()> {
        let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else { return Ok(()) };
        let Kind::Serial(port) = &mut p.kind else { return Ok(()) };
        let fd = port.file.as_raw_fd();
        let mut contact = port.contact.clone();
        let given = |key: &str| -> Option<Value> {
            if plist_member(args, key) { plist_get(args, key).cloned() } else { plist_get(&port.contact, key).cloned() }
        };
        // SAFETY: termios is plain data, filled in by tcgetattr before use.
        let mut attr: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: fd is open and attr a valid termios.
        if unsafe { libc::tcgetattr(fd, &mut attr) } != 0 {
            return Err(port_error("Failed tcgetattr", &std::io::Error::last_os_error(), None));
        }
        // SAFETY: attr is a valid termios.
        unsafe { libc::cfmakeraw(&mut attr) };
        attr.c_cflag |= libc::CLOCAL | libc::CREAD;
        let mut summary = String::new();

        let speed = given(":speed");
        let n = fixnum(speed.as_ref())?;
        // SAFETY: attr is a valid termios.
        if unsafe { libc::cfsetspeed(&mut attr, convert_speed(n)) } != 0 {
            return Err(port_error("Failed cfsetspeed", &std::io::Error::last_os_error(), speed.as_ref()));
        }
        plist_put(&mut contact, ":speed", Value::Number(n as f64));

        let bytesize = given(":bytesize").unwrap_or(Value::Number(8.0));
        let n = fixnum(Some(&bytesize))?;
        if n != 7 && n != 8 {
            return Err(Error::new(":bytesize must be nil (8), 7, or 8"));
        }
        summary.push(if n == 7 { '7' } else { '8' });
        attr.c_cflag &= !libc::CSIZE;
        attr.c_cflag |= if n == 7 { libc::CS7 } else { libc::CS8 };
        plist_put(&mut contact, ":bytesize", bytesize);

        let parity = given(":parity");
        let kind = parity.as_ref().map(|v| symbol_name(v).unwrap_or(""));
        attr.c_cflag &= !(libc::PARENB | libc::PARODD);
        attr.c_iflag &= !(libc::IGNPAR | libc::INPCK);
        match kind {
            None => summary.push('N'),
            Some("even") => {
                summary.push('E');
                attr.c_cflag |= libc::PARENB;
                attr.c_iflag |= libc::IGNPAR | libc::INPCK;
            }
            Some("odd") => {
                summary.push('O');
                attr.c_cflag |= libc::PARENB | libc::PARODD;
                attr.c_iflag |= libc::IGNPAR | libc::INPCK;
            }
            Some(_) => return Err(Error::new(":parity must be nil (no parity), \u{2018}even\u{2019}, or \u{2018}odd\u{2019}")),
        }
        plist_put(&mut contact, ":parity", parity.unwrap_or(Value::Null));

        let stopbits = given(":stopbits").unwrap_or(Value::Number(1.0));
        let n = fixnum(Some(&stopbits))?;
        if n != 1 && n != 2 {
            return Err(Error::new(":stopbits must be nil (1 stopbit), 1, or 2"));
        }
        summary.push(if n == 2 { '2' } else { '1' });
        attr.c_cflag &= !libc::CSTOPB;
        if n == 2 {
            attr.c_cflag |= libc::CSTOPB;
        }
        plist_put(&mut contact, ":stopbits", stopbits);

        let flow = given(":flowcontrol");
        attr.c_cflag &= !libc::CRTSCTS;
        attr.c_iflag &= !(libc::IXON | libc::IXOFF);
        match flow.as_ref().map(|v| symbol_name(v).unwrap_or("")) {
            None => {}
            Some("hw") => attr.c_cflag |= libc::CRTSCTS,
            Some("sw") => attr.c_iflag |= libc::IXON | libc::IXOFF,
            Some(_) => return Err(Error::new(":flowcontrol must be nil (no flowcontrol), \u{2018}hw\u{2019}, or \u{2018}sw\u{2019}")),
        }
        plist_put(&mut contact, ":flowcontrol", flow.unwrap_or(Value::Null));

        // SAFETY: fd is open and attr a valid termios.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &attr) } != 0 {
            return Err(port_error("Failed tcsetattr", &std::io::Error::last_os_error(), None));
        }
        plist_put(&mut contact, ":summary", Value::Str(summary));
        port.contact = contact;
        Ok(())
    }

    /// A serial process's contact, as process-contact with t gives it:
    /// keys with their colons, in order; None for another kind of process.
    pub fn serial_contact(&self, id: u64) -> Option<Vec<(String, Value)>> {
        match &self.processes.list.iter().find(|p| p.id == id)?.kind {
            Kind::Serial(port) => Some(port.contact.clone()),
            _ => None,
        }
    }

    /// Stops or continues reading a serial process, as stop-process and
    /// continue-process do for one: stopped, what comes is left unread,
    /// and continuing throws away what came meanwhile, as tcflush does.
    /// False for another kind of process, which is signalled instead.
    pub fn set_serial_stopped(&mut self, id: u64, stop: bool) -> bool {
        let Some(p) = self.processes.list.iter().find(|p| p.id == id) else { return false };
        let Kind::Serial(port) = &p.kind else { return false };
        if !stop && port.is_stopped() {
            // SAFETY: the port is open; tcflush only discards its input.
            unsafe { libc::tcflush(port.file.as_raw_fd(), libc::TCIFLUSH) };
        }
        port.stopped.store(stop, Ordering::Relaxed);
        true
    }

    /// Waits until what was sent to a serial port has gone out, as
    /// process-send-eof does for one, which leaves it open.
    pub(super) fn drain_serial(&mut self, name: &str) -> Result<()> {
        let p = self.process(name)?;
        let Kind::Serial(port) = &p.kind else { return Ok(()) };
        if let Some(stdin) = &p.stdin {
            let (sent, done) = sync_channel(0);
            if stdin.send(Some(ToProcess::Sent(sent))).is_ok() {
                let _ = done.recv_timeout(Duration::from_secs(30));
            }
        }
        // SAFETY: the port is open; tcdrain waits for its output to go.
        if unsafe { libc::tcdrain(port.file.as_raw_fd()) } != 0 {
            return Err(port_error("Failed tcdrain", &std::io::Error::last_os_error(), None));
        }
        Ok(())
    }
}
