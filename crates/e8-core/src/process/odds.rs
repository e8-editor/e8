//! The rest of process.c's primitives on processes: socket options
//! (set-network-process-option) and what interrupt-process and
//! signal-process do by default.

use super::*;

/// A socket option as process.c's socket_options table names it, and
/// how its value is given: whether set, a number, an interface's name, or
/// how long to linger.
#[cfg(unix)]
enum OptionType {
    Bool,
    #[cfg(any(target_os = "linux", target_os = "android"))]
    Int,
    #[cfg(any(target_os = "linux", target_os = "android"))]
    IfName,
    Linger,
}

/// The options this system has, as Emacs's table has those its system
/// defines: :priority and :bindtodevice only on Linux. Emacs has no
/// :nodelay here, though make-network-process documents it.
#[cfg(unix)]
const SOCKET_OPTIONS: &[(&str, libc::c_int, OptionType)] = &[
    #[cfg(any(target_os = "linux", target_os = "android"))]
    (":bindtodevice", libc::SO_BINDTODEVICE, OptionType::IfName),
    (":broadcast", libc::SO_BROADCAST, OptionType::Bool),
    (":dontroute", libc::SO_DONTROUTE, OptionType::Bool),
    (":keepalive", libc::SO_KEEPALIVE, OptionType::Bool),
    (":linger", libc::SO_LINGER, OptionType::Linger),
    (":oobinline", libc::SO_OOBINLINE, OptionType::Bool),
    #[cfg(any(target_os = "linux", target_os = "android"))]
    (":priority", libc::SO_PRIORITY, OptionType::Int),
    (":reuseaddr", libc::SO_REUSEADDR, OptionType::Bool),
];

/// A number within a C int, as TYPE_RANGED_FIXNUMP (int, ...) takes one.
#[cfg(unix)]
fn c_int(value: &Value) -> Option<libc::c_int> {
    match value {
        Value::Number(n) if n.fract() == 0.0 && *n >= libc::c_int::MIN as f64 && *n <= libc::c_int::MAX as f64 => Some(*n as libc::c_int),
        _ => None,
    }
}

/// Sets an option on a socket, as process.c's set_socket_option: whether
/// the option is one this system has; an error if setting it fails.
#[cfg(unix)]
fn set_socket_option(fd: libc::c_int, option: &str, value: &Value) -> Result<bool> {
    let Some((_, optnum, kind)) = SOCKET_OPTIONS.iter().find(|(name, ..)| *name == option) else { return Ok(false) };
    let set = |ptr: *const libc::c_void, len: usize| -> libc::c_int {
        // SAFETY: ptr points at len bytes of the option's value, alive for the call.
        unsafe { libc::setsockopt(fd, libc::SOL_SOCKET, *optnum, ptr, len as libc::socklen_t) }
    };
    let ret = match kind {
        OptionType::Bool => {
            let v: libc::c_int = if value.is_nil() { 0 } else { 1 };
            set(&v as *const _ as *const libc::c_void, std::mem::size_of_val(&v))
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        OptionType::Int => {
            let v = c_int(value).ok_or_else(|| Error::new(format!("Bad option value for {option}")))?;
            set(&v as *const _ as *const libc::c_void, std::mem::size_of_val(&v))
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        OptionType::IfName => {
            let mut name = [0u8; libc::IFNAMSIZ];
            match value {
                v if v.is_nil() => {}
                Value::Str(_) | Value::Text(_) => {
                    let s = value.as_str().unwrap_or_default().as_bytes();
                    let n = s.len().min(libc::IFNAMSIZ);
                    name[..n].copy_from_slice(&s[..n]);
                }
                _ => return Err(Error::new(format!("Bad option value for {option}"))),
            }
            set(name.as_ptr() as *const libc::c_void, libc::IFNAMSIZ)
        }
        OptionType::Linger => {
            let linger = match c_int(value) {
                Some(n) => libc::linger { l_onoff: 1, l_linger: n },
                None => libc::linger { l_onoff: if value.is_nil() { 0 } else { 1 }, l_linger: 0 },
            };
            set(&linger as *const _ as *const libc::c_void, std::mem::size_of_val(&linger))
        }
    };
    if ret < 0 {
        let e = std::io::Error::last_os_error();
        let text = e.to_string();
        let why = text.split(" (os error").next().unwrap_or(&text).to_string();
        let data = vec![Value::Str("Cannot set network option".into()), Value::Str(why.clone()), Value::Str(option.into()), value.clone()];
        return Err(Error::signal("file-error", format!("Cannot set network option: {why}, {option}, {value}"), data));
    }
    Ok(true)
}

pub(super) fn wrong_type(predicate: &str, value: &Value) -> Error {
    Error::signal("wrong-type-argument", format!("Wrong type argument: {predicate}, {value}"), vec![Value::Symbol(predicate.into()), value.clone()])
}

impl Editor {
    /// The process `which` names, as process.c's get_process: a process, a
    /// process's or buffer's name, a buffer, or nil for the current
    /// buffer's; wrong-type-argument processp for anything else.
    pub fn get_process(&self, which: &Value) -> Result<u64> {
        let of_buffer = |ed: &Editor, b: &crate::buffer::Buffer| {
            ed.processes.list.iter().find(|p| p.buffer == Some(b.id)).map(|p| p.id).ok_or_else(|| Error::new(format!("Buffer {} has no process", b.name)))
        };
        match which {
            Value::Process(id) => Ok(*id),
            Value::Null => of_buffer(self, self.buffer()),
            Value::Buffer(id) => match self.buffers.iter().find(|b| b.id == *id) {
                Some(b) => of_buffer(self, b),
                None => Err(Error::new("Attempt to get process for a dead buffer")),
            },
            Value::Str(_) | Value::Text(_) => {
                let name = which.as_str().unwrap_or_default();
                if let Some(id) = self.process_named(name) {
                    return Ok(id);
                }
                match self.buffers.iter().find(|b| b.name == name) {
                    Some(b) => of_buffer(self, b),
                    None => Err(Error::new(format!("Process {name} does not exist"))),
                }
            }
            v => Err(wrong_type("processp", v)),
        }
    }

    /// Serial ports need termios, which this system has not.
    #[cfg(not(unix))]
    pub fn make_serial_process(&mut self, args: Vec<(String, Value)>, filter: Option<Value>, sentinel: Option<Value>, coding: Option<(Coding, Coding)>) -> Result<Option<u64>> {
        let _ = (filter, sentinel, coding);
        if args.is_empty() { Ok(None) } else { Err(Error::new("Serial ports are not supported here")) }
    }

    #[cfg(not(unix))]
    pub fn serial_process_configure(&mut self, args: &[(String, Value)]) -> Result<()> {
        let which = [":process", ":name", ":buffer", ":port"].iter().find_map(|k| args.iter().find(|(n, v)| n == k && !v.is_nil()).map(|(_, v)| v.clone())).unwrap_or(Value::Null);
        self.get_process(&which)?;
        Err(Error::new("Not a serial process"))
    }

    #[cfg(not(unix))]
    pub fn serial_contact(&self, id: u64) -> Option<Vec<(String, Value)>> {
        let _ = id;
        None
    }

    #[cfg(not(unix))]
    pub fn set_serial_stopped(&mut self, id: u64, stop: bool) -> bool {
        let _ = (id, stop);
        false
    }

    /// Sets a socket option on a network connection or server, as
    /// set-network-process-option: OPTION is its keyword, as ":keepalive".
    /// True if set, and kept in its contact; for an option this system
    /// does not have, an error, or with `no_error` false. An error for a
    /// process that is not a network process, or has closed.
    pub fn set_network_process_option(&mut self, id: u64, option: &str, value: &Value, no_error: bool) -> Result<bool> {
        let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) else {
            return Err(match self.process_info(id) {
                Some(info) if info.kind == "network" => Error::new("Process is not running"),
                _ => Error::new("Process is not a network process"),
            });
        };
        if !matches!(p.kind, Kind::Network(_) | Kind::Server(..)) {
            return Err(Error::new("Process is not a network process"));
        }
        if p.status != Status::Run {
            return Err(Error::new("Process is not running"));
        }
        #[cfg(unix)]
        let set = {
            use std::os::fd::AsRawFd;
            match &p.socket {
                Some(socket) => set_socket_option(socket.as_raw_fd(), option, value)?,
                None => return Err(Error::new("Process is not running")),
            }
        };
        #[cfg(not(unix))]
        let set = false;
        if set {
            if let Kind::Network(contact) | Kind::Server(contact, _) = &mut p.kind {
                match contact.options.iter_mut().find(|(k, _)| k == option) {
                    Some((_, v)) => *v = value.clone(),
                    None => contact.options.push((option.to_string(), value.clone())),
                }
            }
            return Ok(true);
        }
        if no_error {
            return Ok(false);
        }
        Err(Error::new("Unknown or unsupported option"))
    }

    /// Interrupts a process, as internal-default-interrupt-process, the
    /// default of interrupt-process: SIGINT to its process group, or with
    /// `current_group` to the job in the foreground on its terminal. An
    /// error for a process that is not a program, or has ended.
    pub fn internal_default_interrupt_process(&mut self, id: u64, current_group: bool) -> Result<()> {
        let Some(p) = self.processes.list.iter().find(|p| p.id == id) else {
            let info = self.process_info(id);
            let name = info.as_ref().map_or_else(|| id.to_string(), |i| i.name.clone());
            return Err(match info {
                Some(i) if i.kind != "real" => Error::new(format!("Process {name} is not a subprocess")),
                _ => Error::new(format!("Process {name} is not active")),
            });
        };
        if p.kind_name() != "real" {
            return Err(Error::new(format!("Process {} is not a subprocess", p.name)));
        }
        if p.status != Status::Run {
            return Err(Error::new(format!("Process {} is not active", p.name)));
        }
        let name = p.name.clone();
        #[cfg(unix)]
        return self.signal_process_group(&name, libc::SIGINT, current_group);
        #[cfg(not(unix))]
        self.signal_process_group(&name, 2, current_group)
    }

    /// The process id internal-default-signal-process signals for a
    /// process: an error if it has none, as a connection has not. One that
    /// has ended gives None, as its id may be another's by now.
    pub fn process_pid_to_signal(&self, id: u64) -> Result<Option<i32>> {
        let info = self.process_info(id).ok_or_else(|| Error::new(format!("Cannot signal process {id}")))?;
        match info.pid {
            Some(pid) if pid > 0 => Ok((info.listed && info.status == Status::Run).then_some(pid as i32)),
            _ => Err(Error::new(format!("Cannot signal process {}", info.name))),
        }
    }
}

/// Sends a signal to a process id, as kill(2) does for
/// internal-default-signal-process: 0 if sent, -1 if not.
pub fn kill_pid(pid: i32, signal: i32) -> i32 {
    #[cfg(unix)]
    {
        // SAFETY: kill only sends a signal.
        unsafe { libc::kill(pid, signal) }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        -1
    }
}
