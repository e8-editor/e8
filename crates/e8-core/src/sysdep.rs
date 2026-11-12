//! What Emacs's sysdep.c and process.c ask the system about its processes
//! and network interfaces: list-system-processes, process-attributes,
//! network-interface-list and network-interface-info. On macOS from
//! libproc and sysctl, on Linux from /proc, and on both from getifaddrs;
//! elsewhere, as on the web, there is nothing to tell.

use crate::variables::Value;

/// The ids of the processes running on this machine, as
/// list-system-processes, in increasing order.
pub fn list_system_processes() -> Vec<u32> {
    let mut pids = imp::list();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// What the system says of a process, as process-attributes: each
/// attribute's name and value, in the order Emacs lists them, or None if
/// there is no such process. Sizes are in kilobytes, times in seconds, and
/// `start` in seconds since 1970. What the system will not say of another
/// user's process is left out, as Emacs leaves it out.
pub fn process_attributes(pid: u32) -> Option<Vec<(&'static str, Value)>> {
    let mut attrs = imp::attributes(pid)?;
    // Emacs conses each onto the front as it finds it.
    attrs.reverse();
    Some(attrs)
}

/// An address of a network interface, as network-interface-list gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct InterfaceAddress {
    pub name: String,
    /// Its address as Emacs writes one, `[a b c d 0]` or eight words and 0.
    pub address: Vec<u32>,
    pub netmask: Vec<u32>,
    /// Whether it is IPv6.
    pub ipv6: bool,
}

impl InterfaceAddress {
    /// Its broadcast address as network-interface-list gives it: the
    /// address with the bits outside its netmask set.
    pub fn broadcast(&self) -> Vec<u32> {
        let max = if self.ipv6 { 0xffff } else { 0xff };
        let n = self.address.len() - 1;
        let mut out: Vec<u32> = (0..n).map(|i| (self.address[i] | (!self.netmask.get(i).copied().unwrap_or(0) & max)) & max).collect();
        out.push(0);
        out
    }
}

/// The addresses of the machine's network interfaces, as
/// network-interface-list: Emacs's order, the reverse of the system's.
pub fn network_interfaces() -> Vec<InterfaceAddress> {
    let mut list = imp::interfaces().into_iter().filter_map(|i| i.address).collect::<Vec<_>>();
    list.reverse();
    list
}

/// What network-interface-info says of an interface: its IPv4 address,
/// broadcast address and netmask, its hardware address as its type and
/// bytes, and its flags, or None if there is no such interface.
#[derive(Clone, Debug, PartialEq)]
pub struct InterfaceInfo {
    pub address: Option<Vec<u32>>,
    pub broadcast: Option<Vec<u32>>,
    pub netmask: Option<Vec<u32>>,
    pub hardware: Option<(u32, Vec<u32>)>,
    pub flags: Vec<&'static str>,
}

/// What the system says of a network interface, as network-interface-info.
pub fn network_interface_info(name: &str) -> Option<InterfaceInfo> {
    let entries: Vec<imp::Entry> = imp::interfaces().into_iter().filter(|e| e.name == name).collect();
    let first = entries.first()?;
    let ipv4 = entries.iter().find(|e| e.address.as_ref().is_some_and(|a| !a.ipv6));
    Some(InterfaceInfo {
        address: ipv4.and_then(|e| e.address.as_ref()).map(|a| a.address.clone()),
        broadcast: ipv4.and_then(|e| e.broadcast.clone()),
        netmask: ipv4.and_then(|e| e.address.as_ref()).map(|a| a.netmask.clone()),
        hardware: entries.iter().find_map(|e| e.hardware.clone()),
        flags: flag_names(first.flags),
    })
}

/// The interface flags Emacs names, in the order of its table, each
/// consed on so the list comes out reversed.
fn flag_names(flags: u32) -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    const TABLE: &[(u32, &str)] = &[
        (0x1, "up"),
        (0x2, "broadcast"),
        (0x4, "debug"),
        (0x8, "loopback"),
        (0x10, "pointopoint"),
        (0x40, "running"),
        (0x80, "noarp"),
        (0x100, "promisc"),
        // Emacs calls it smart on macOS, where notrailers is obsolete.
        (0x20, "smart"),
        (0x200, "allmulti"),
        (0x8000, "multicast"),
        (0x400, "oactive"),
        (0x800, "simplex"),
        (0x1000, "link0"),
        (0x2000, "link1"),
        (0x4000, "link2"),
    ];
    #[cfg(not(target_os = "macos"))]
    const TABLE: &[(u32, &str)] = &[
        (0x1, "up"),
        (0x2, "broadcast"),
        (0x4, "debug"),
        (0x8, "loopback"),
        (0x10, "pointopoint"),
        (0x40, "running"),
        (0x80, "noarp"),
        (0x100, "promisc"),
        (0x20, "notrailers"),
        (0x200, "allmulti"),
        (0x400, "master"),
        (0x800, "slave"),
        (0x1000, "multicast"),
        (0x2000, "portsel"),
        (0x4000, "automedia"),
        (0x8000, "dynamic"),
    ];
    let mut names: Vec<&str> = TABLE.iter().filter(|(bit, _)| flags & bit != 0).map(|(_, name)| *name).collect();
    names.reverse();
    names
}

#[cfg(unix)]
mod ifaddrs {
    use super::InterfaceAddress;

    /// One of getifaddrs's entries: an interface's name and flags, and an
    /// address, broadcast address or hardware address if it has one.
    pub struct Entry {
        pub name: String,
        pub flags: u32,
        pub address: Option<InterfaceAddress>,
        pub broadcast: Option<Vec<u32>>,
        pub hardware: Option<(u32, Vec<u32>)>,
    }

    /// An IPv4 or IPv6 address as Emacs writes one, with a port of 0.
    ///
    /// # Safety
    /// `sa` is null or points to a socket address of its family's size.
    unsafe fn address(sa: *const libc::sockaddr) -> Option<(Vec<u32>, bool)> {
        if sa.is_null() {
            return None;
        }
        // SAFETY: the caller's promise: a socket address of its family.
        unsafe {
            match (*sa).sa_family as i32 {
                libc::AF_INET => {
                    let sin = &*(sa as *const libc::sockaddr_in);
                    let mut v: Vec<u32> = u32::from_be(sin.sin_addr.s_addr).to_be_bytes().iter().map(|b| *b as u32).collect();
                    v.push(0);
                    Some((v, false))
                }
                libc::AF_INET6 => {
                    let sin6 = &*(sa as *const libc::sockaddr_in6);
                    let b = sin6.sin6_addr.s6_addr;
                    let mut v: Vec<u32> = (0..8).map(|i| u16::from_be_bytes([b[2 * i], b[2 * i + 1]]) as u32).collect();
                    v.push(0);
                    Some((v, true))
                }
                _ => None,
            }
        }
    }

    /// A link-level address, as its type and bytes.
    ///
    /// # Safety
    /// `sa` is null or points to a socket address of its family's size.
    unsafe fn hardware(sa: *const libc::sockaddr) -> Option<(u32, Vec<u32>)> {
        if sa.is_null() {
            return None;
        }
        // SAFETY: the caller's promise: a socket address of its family.
        unsafe {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
            if (*sa).sa_family as i32 == libc::AF_LINK {
                let dl = &*(sa as *const libc::sockaddr_dl);
                if dl.sdl_alen == 0 {
                    return None;
                }
                // The name comes first in sdl_data, then the address, which
                // may run past the field's declared length.
                let data = dl.sdl_data.as_ptr() as *const u8;
                let bytes = std::slice::from_raw_parts(data.add(dl.sdl_nlen as usize), dl.sdl_alen as usize);
                return Some((libc::AF_LINK as u32, bytes.iter().map(|b| *b as u32).collect()));
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            if (*sa).sa_family as i32 == libc::AF_PACKET {
                let ll = &*(sa as *const libc::sockaddr_ll);
                let len = (ll.sll_halen as usize).min(ll.sll_addr.len());
                if len == 0 {
                    return None;
                }
                return Some((ll.sll_hatype as u32, ll.sll_addr[..len].iter().map(|b| *b as u32).collect()));
            }
        }
        None
    }

    /// Every entry getifaddrs gives, in its order.
    pub fn interfaces() -> Vec<Entry> {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: getifaddrs fills in a list it allocates, freed below.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut at = head;
        while !at.is_null() {
            // SAFETY: each entry of the list getifaddrs made, until freed.
            let ifa = unsafe { &*at };
            at = ifa.ifa_next;
            // SAFETY: ifa_name is a NUL-terminated string in the list.
            let name = unsafe { std::ffi::CStr::from_ptr(ifa.ifa_name) }.to_string_lossy().into_owned();
            let flags = ifa.ifa_flags as u32;
            #[cfg(any(target_os = "linux", target_os = "android"))]
            let other = ifa.ifa_ifu;
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            let other = ifa.ifa_dstaddr;
            // SAFETY: the list's addresses are each of their family's size.
            let (address, netmask, broadcast, hardware) = unsafe {
                (address(ifa.ifa_addr), address(ifa.ifa_netmask), address(other), hardware(ifa.ifa_addr))
            };
            let address = address.map(|(address, ipv6)| InterfaceAddress {
                name: name.clone(),
                netmask: netmask.map_or_else(|| vec![0; address.len()], |(m, _)| m),
                address,
                ipv6,
            });
            // The other address is the broadcast one only on a broadcast interface.
            let broadcast = broadcast.filter(|_| flags & 0x2 != 0).map(|(b, _)| b);
            out.push(Entry { name, flags, address, broadcast, hardware });
        }
        // SAFETY: freed once, after the last use of the list.
        unsafe { libc::freeifaddrs(head) };
        out
    }
}

#[cfg(target_os = "macos")]
mod imp {
    pub use super::ifaddrs::{Entry, interfaces};
    use crate::variables::Value;
    use std::mem::{size_of, zeroed};

    pub fn list() -> Vec<u32> {
        // SAFETY: with no buffer it says how many processes there are.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0 as libc::pid_t; n as usize + 64];
        let bytes = (pids.len() * size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: the buffer holds `bytes` bytes, which is all it writes.
        let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if got <= 0 {
            return Vec::new();
        }
        pids.truncate((got as usize).min(pids.len()));
        pids.into_iter().filter(|p| *p >= 0).map(|p| p as u32).collect()
    }

    /// Fills `out` with one of proc_pidinfo's records: whether it could.
    fn pidinfo<T>(pid: u32, flavor: libc::c_int, out: &mut T) -> bool {
        let size = size_of::<T>() as libc::c_int;
        // SAFETY: out is a T, and proc_pidinfo writes at most `size` bytes.
        unsafe { libc::proc_pidinfo(pid as libc::c_int, flavor, 0, (out as *mut T).cast(), size) == size }
    }

    fn c_name(chars: &[libc::c_char]) -> String {
        let bytes: Vec<u8> = chars.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// A process's arguments, joined by spaces, from KERN_PROCARGS2: its
    /// argument count, its program's path, then the arguments.
    fn args(pid: u32) -> Option<String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        // SAFETY: with no buffer sysctl says how big a one it needs.
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
            return None;
        }
        let mut buf = vec![0u8; size];
        // SAFETY: buf holds `size` bytes, which is all sysctl writes.
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
            return None;
        }
        buf.truncate(size);
        let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?) as usize;
        let rest = &buf[4..];
        // Past the program's path and the NULs after it.
        let path_end = rest.iter().position(|b| *b == 0)?;
        let start = path_end + rest[path_end..].iter().position(|b| *b != 0)?;
        let args: Vec<String> = rest[start..].split(|b| *b == 0).take(argc).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        Some(args.join(" "))
    }

    /// Mach's time units in nanoseconds, as its timebase gives them.
    #[allow(deprecated)]
    fn mach_ns(units: u64) -> f64 {
        let mut base = libc::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: fills in the struct given it.
        unsafe {
            libc::mach_timebase_info(&mut base);
        }
        if base.denom == 0 {
            return units as f64;
        }
        units as f64 * base.numer as f64 / base.denom as f64
    }

    pub fn attributes(pid: u32) -> Option<Vec<(&'static str, Value)>> {
        let mut out = Vec::new();
        let num = |n: f64| Value::Number(n);
        // SAFETY: plain data, filled in by proc_pidinfo.
        let mut bsd: libc::proc_bsdinfo = unsafe { zeroed() };
        if pidinfo(pid, libc::PROC_PIDTBSDINFO, &mut bsd) {
            out.push(("euid", num(bsd.pbi_uid as f64)));
            out.push(("user", Value::Str(crate::fileops::user_name(bsd.pbi_uid))));
            out.push(("egid", num(bsd.pbi_gid as f64)));
            out.push(("group", Value::Str(crate::fileops::group_name(bsd.pbi_gid))));
            out.push(("comm", Value::Str(c_name(&bsd.pbi_comm))));
            out.push(("state", Value::Str(state(bsd.pbi_status).into())));
            out.push(("ppid", num(bsd.pbi_ppid as f64)));
            out.push(("pgrp", num(bsd.pbi_pgid as f64)));
            if bsd.e_tdev != u32::MAX {
                // SAFETY: devname returns a static name or null.
                let name = unsafe { libc::devname(bsd.e_tdev as libc::dev_t, libc::S_IFCHR) };
                if !name.is_null() {
                    // SAFETY: a NUL-terminated name, copied at once.
                    let name = unsafe { std::ffi::CStr::from_ptr(name) }.to_string_lossy();
                    out.push(("ttname", Value::Str(format!("/dev/{name}"))));
                }
            }
            out.push(("tpgid", num(bsd.e_tpgid as f64)));
        } else {
            // SAFETY: plain data, filled in by proc_pidinfo.
            let mut short: libc::proc_bsdshortinfo = unsafe { zeroed() };
            if !pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, &mut short) {
                return None;
            }
            out.push(("euid", num(short.pbsi_uid as f64)));
            out.push(("user", Value::Str(crate::fileops::user_name(short.pbsi_uid))));
            out.push(("egid", num(short.pbsi_gid as f64)));
            out.push(("group", Value::Str(crate::fileops::group_name(short.pbsi_gid))));
            out.push(("comm", Value::Str(c_name(&short.pbsi_comm))));
            out.push(("state", Value::Str(state(short.pbsi_status).into())));
            out.push(("ppid", num(short.pbsi_ppid as f64)));
            out.push(("pgrp", num(short.pbsi_pgid as f64)));
        }
        // SAFETY: plain data, filled in by proc_pidinfo.
        let mut task: libc::proc_taskinfo = unsafe { zeroed() };
        let has_task = pidinfo(pid, libc::PROC_PIDTASKINFO, &mut task);
        if has_task {
            let user = mach_ns(task.pti_total_user) / 1e9;
            let system = mach_ns(task.pti_total_system) / 1e9;
            out.push(("utime", num(user)));
            out.push(("stime", num(system)));
            out.push(("time", num(user + system)));
            out.push(("majflt", num(task.pti_pageins as f64)));
        }
        if bsd.pbi_pid != 0 || bsd.pbi_start_tvsec != 0 {
            out.push(("nice", num(bsd.pbi_nice as f64)));
            let start = bsd.pbi_start_tvsec as f64 + bsd.pbi_start_tvusec as f64 / 1e6;
            out.push(("start", num(start)));
            let now = crate::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
            out.push(("etime", num((now - start).max(0.0))));
        }
        if has_task {
            out.push(("vsize", num((task.pti_virtual_size / 1024) as f64)));
            out.push(("rss", num((task.pti_resident_size / 1024) as f64)));
            out.push(("thcount", num(task.pti_threadnum as f64)));
        }
        if let Some(args) = args(pid) {
            out.push(("args", Value::Str(args)));
        }
        Some(out)
    }

    /// A process's p_stat as ps writes it.
    fn state(status: u32) -> &'static str {
        match status {
            1 => "I",
            2 => "R",
            3 => "S",
            4 => "T",
            5 => "Z",
            _ => "?",
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
    pub use super::ifaddrs::{Entry, interfaces};
    use crate::variables::Value;
    use crate::vfs as fs;

    pub fn list() -> Vec<u32> {
        let Ok(dir) = fs::read_dir("/proc") else { return Vec::new() };
        dir.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str()?.parse().ok()).collect()
    }

    /// A field of /proc/PID/status, as "Uid:", its numbers.
    fn status_numbers(status: &str, key: &str) -> Vec<f64> {
        status.lines().find_map(|l| l.strip_prefix(key)).map_or_else(Vec::new, |rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect())
    }

    pub fn attributes(pid: u32) -> Option<Vec<(&'static str, Value)>> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
        // The command is in parentheses, and may hold spaces and parentheses itself.
        let open = stat.find('(')?;
        let close = stat.rfind(')')?;
        let comm = stat[open + 1..close].to_string();
        let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
        let field = |i: usize| fields.get(i).and_then(|f| f.parse::<f64>().ok()).unwrap_or(0.0);
        // SAFETY: sysconf only reads a configuration value.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
        // SAFETY: as above.
        let page_kb = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as f64 / 1024.0;
        let num = Value::Number;
        let mut out = Vec::new();
        if let (Some(uid), Some(gid)) = (status_numbers(&status, "Uid:").get(1).copied(), status_numbers(&status, "Gid:").get(1).copied()) {
            out.push(("euid", num(uid)));
            out.push(("user", Value::Str(crate::fileops::user_name(uid as u32))));
            out.push(("egid", num(gid)));
            out.push(("group", Value::Str(crate::fileops::group_name(gid as u32))));
        }
        out.push(("comm", Value::Str(comm)));
        out.push(("state", Value::Str(fields.first().copied().unwrap_or("?").to_string())));
        out.push(("ppid", num(field(1))));
        out.push(("pgrp", num(field(2))));
        out.push(("sess", num(field(3))));
        let tty = field(4) as u64;
        if tty != 0 {
            let (major, minor) = ((tty >> 8) & 0xfff, (tty & 0xff) | ((tty >> 12) & 0xfff00));
            let name = match major {
                136..=143 => Some(format!("/dev/pts/{}", (major - 136) * 256 + minor)),
                4 if minor < 64 => Some(format!("/dev/tty{minor}")),
                _ => None,
            };
            if let Some(name) = name {
                out.push(("ttname", Value::Str(name)));
            }
        }
        out.push(("tpgid", num(field(5))));
        out.push(("minflt", num(field(7))));
        out.push(("majflt", num(field(9))));
        out.push(("cminflt", num(field(8))));
        out.push(("cmajflt", num(field(10))));
        let (utime, stime, cutime, cstime) = (field(11) / hz, field(12) / hz, field(13) / hz, field(14) / hz);
        out.push(("utime", num(utime)));
        out.push(("stime", num(stime)));
        out.push(("time", num(utime + stime)));
        out.push(("cutime", num(cutime)));
        out.push(("cstime", num(cstime)));
        out.push(("ctime", num(cutime + cstime)));
        out.push(("pri", num(field(15))));
        out.push(("nice", num(field(16))));
        out.push(("thcount", num(field(17))));
        let boot = fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|s| s.lines().find_map(|l| l.strip_prefix("btime ").and_then(|b| b.trim().parse::<f64>().ok())));
        let now = crate::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        let start = boot.map(|boot| boot + field(19) / hz);
        if let Some(start) = start {
            out.push(("start", num(start)));
        }
        out.push(("vsize", num((field(20) / 1024.0).floor())));
        let rss = field(21) * page_kb;
        out.push(("rss", num(rss)));
        let etime = start.map(|start| (now - start).max(0.0));
        if let Some(etime) = etime {
            out.push(("etime", num(etime)));
        }
        if let Some(etime) = etime.filter(|e| *e > 0.0) {
            out.push(("pcpu", num(100.0 * (utime + stime) / etime)));
        }
        let total = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|m| m.lines().find_map(|l| l.strip_prefix("MemTotal:").and_then(|t| t.split_whitespace().next()?.parse::<f64>().ok())));
        if let Some(total) = total.filter(|t| *t > 0.0) {
            out.push(("pmem", num(100.0 * rss / total)));
        }
        if let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) {
            let args: Vec<String> = cmdline.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
            if !args.is_empty() {
                out.push(("args", Value::Str(args.join(" "))));
            }
        }
        Some(out)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
mod imp {
    use crate::variables::Value;

    #[cfg(unix)]
    pub use super::ifaddrs::{Entry, interfaces};

    #[cfg(not(unix))]
    pub struct Entry {
        pub name: String,
        pub flags: u32,
        pub address: Option<super::InterfaceAddress>,
        pub broadcast: Option<Vec<u32>>,
        pub hardware: Option<(u32, Vec<u32>)>,
    }

    #[cfg(not(unix))]
    pub fn interfaces() -> Vec<Entry> {
        Vec::new()
    }

    pub fn list() -> Vec<u32> {
        Vec::new()
    }

    pub fn attributes(_pid: u32) -> Option<Vec<(&'static str, Value)>> {
        None
    }
}
