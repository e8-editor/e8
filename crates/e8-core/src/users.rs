//! Who runs the editor and on what, as Emacs's editfns.c, sysdep.c and
//! emacs.c answer it ([ADR 0073]): login and full names, user and group
//! ids, the system's users and groups, how many processors there are, and
//! stopping the process for the shell, as `suspend-emacs` does on a
//! terminal. From libc natively; on the web, where there are no accounts,
//! the stand-ins Emacs gives when it can ask nothing.
//!
//! [ADR 0073]: ../../../docs/adr/0073-the-user-and-the-system-as-emacs-has-them.md

pub(crate) fn define_variables(ed: &mut crate::editor::Editor) {
    use crate::variables::Variable;
    for (name, doc) in [
        ("suspend-hook", "Run before suspend-emacs stops E8 for the shell."),
        ("suspend-resume-hook", "Run after the shell continues E8 that suspend-emacs stopped."),
    ] {
        ed.define_hook(name, doc);
    }
    for var in [
        Variable::new("user-full-name", "The full name of the user E8 runs for, as signing commits, ChangeLog entries and exported files uses it: from $NAME, else the system's account.", crate::variables::Value::Str(full_name())),
        Variable::new("user-login-name", "The login name E8 goes by: $LOGNAME, else $USER, else the account E8 runs as.", crate::variables::Value::Str(login_name())),
        Variable::new("user-real-login-name", "The login name of the user who started E8, as the system has it.", crate::variables::Value::Str(real_login_name())),
    ] {
        ed.define_variable(var);
    }
}

/// What `num-processors` counts, as its QUERY says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Processors {
    /// Those this process may use, less if `OMP_NUM_THREADS` or
    /// `OMP_THREAD_LIMIT` say so (nil).
    Overridable,
    /// Those this process may use (`current`).
    Current,
    /// Every one the system has (t).
    All,
}

/// An account, as the system's password database holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub login: String,
    pub full_name: String,
}

/// The account of a user id, or `None` if there is none.
pub fn account(uid: u32) -> Option<Account> {
    imp::account(uid)
}

/// The account of a login name, or `None` if there is none.
pub fn account_named(login: &str) -> Option<Account> {
    imp::account_named(login)
}

/// The user id the process runs as, as Emacs's `user-uid`.
pub fn user_uid() -> u32 {
    imp::ids().0
}

/// The user id that started the process, as Emacs's `user-real-uid`.
pub fn user_real_uid() -> u32 {
    imp::ids().1
}

/// The group id the process runs as, as Emacs's `group-gid`.
pub fn group_gid() -> u32 {
    imp::ids().2
}

/// The group id that started the process, as Emacs's `group-real-gid`.
pub fn group_real_gid() -> u32 {
    imp::ids().3
}

/// A group's name, as Emacs's `group-name`, or `None` if there is none.
pub fn group_name(gid: u32) -> Option<String> {
    imp::group_name(gid)
}

/// The login names of the system's users, as Emacs's `system-users`:
/// last first, as Emacs conses them, or the real user alone if the
/// system lists none.
pub fn system_users() -> Vec<String> {
    let mut users = imp::system_users();
    users.reverse();
    if users.is_empty() {
        users.push(real_login_name());
    }
    users
}

/// The names of the system's groups, as Emacs's `system-groups`, last first.
pub fn system_groups() -> Vec<String> {
    let mut groups = imp::system_groups();
    groups.reverse();
    groups
}

/// The login name the editor goes by, as Emacs sets `user-login-name`:
/// `$LOGNAME`, else `$USER`, else the effective user's; set but empty
/// counts, as getenv gives it.
pub fn login_name() -> String {
    std::env::var("LOGNAME")
        .ok()
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| account(user_uid()).map(|a| a.login))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The real user's login name, as Emacs sets `user-real-login-name`.
pub fn real_login_name() -> String {
    account(user_real_uid()).map_or_else(|| "unknown".to_string(), |a| a.login)
}

/// The full name the editor goes by, as Emacs's init_editfns sets
/// `user-full-name`: `$NAME`, else the account of the login name if it is
/// the real user's, and otherwise of the effective user id.
pub fn full_name() -> String {
    if let Ok(name) = std::env::var("NAME") {
        return name;
    }
    let login = login_name();
    let account = if login == real_login_name() { account_named(&login) } else { account(user_uid()) };
    account.map_or_else(|| "unknown".to_string(), |a| a.full_name)
}

/// How many processors there are, as Emacs's `num-processors`.
pub fn num_processors(query: Processors) -> usize {
    let current = std::thread::available_parallelism().map_or(1, |n| n.get());
    match query {
        Processors::Current => current,
        Processors::All => imp::all_processors().unwrap_or(current),
        Processors::Overridable => overridable(current, std::env::var("OMP_NUM_THREADS").ok().as_deref(), std::env::var("OMP_THREAD_LIMIT").ok().as_deref()),
    }
}

/// The processors offered when OpenMP's variables may say fewer, as
/// gnulib's num_processors with NPROC_CURRENT_OVERRIDABLE: the first of
/// `OMP_NUM_THREADS`'s list, at most `OMP_THREAD_LIMIT`.
fn overridable(current: usize, threads: Option<&str>, limit: Option<&str>) -> usize {
    let count = |v: Option<&str>| v.and_then(|v| v.split(',').next()?.trim().parse::<usize>().ok()).filter(|n| *n > 0);
    let wanted = count(threads).unwrap_or(current);
    count(limit).map_or(wanted, |limit| wanted.min(limit))
}

/// Stops the process until the shell continues it, as a terminal's job is
/// stopped by `C-z`: what Emacs's `suspend-emacs` does once the terminal is
/// back as the shell left it. Does nothing where there is no shell.
pub fn stop_self() {
    imp::stop_self();
}

/// A full name as the password database's comment field gives it, as
/// Emacs reads it: up to the first comma, the first `&` standing for the
/// login name with its first letter, if ASCII, capitalized.
#[cfg_attr(not(unix), allow(dead_code))]
fn full_name_of(gecos: &str, login: &str) -> String {
    let name = gecos.split(',').next().unwrap_or("");
    let mut capital = login.chars();
    let login = capital.next().map(|c| std::iter::once(c.to_ascii_uppercase()).chain(capital).collect::<String>()).unwrap_or_default();
    name.replacen('&', &login, 1)
}

#[cfg(all(unix, not(target_arch = "wasm32")))]
mod imp {
    use super::Account;
    use std::ffi::{CStr, CString};

    /// A string a database entry points to, or "" for none.
    fn field(p: *const libc::c_char) -> String {
        // SAFETY: a non-null field of an entry getpw*_r or getgr*_r filled
        // points to a NUL-terminated string in its buffer.
        if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() }
    }

    fn from_passwd(pwd: &libc::passwd) -> Account {
        let login = field(pwd.pw_name);
        Account { full_name: super::full_name_of(&field(pwd.pw_gecos), &login), login }
    }

    /// Calls a getpw*_r or getgr*_r lookup with a buffer that grows while
    /// the entry does not fit, as large directory groups need, and reads
    /// the entry with `read` while the buffer its strings are in lives.
    fn lookup<T, R>(call: impl Fn(&mut T, &mut [u8], *mut *mut T) -> libc::c_int, read: impl Fn(&T) -> R) -> Option<R> {
        let mut size = 16384;
        loop {
            let mut buf = vec![0u8; size];
            // SAFETY: the entry is plain data the call fills in.
            let mut entry: T = unsafe { std::mem::zeroed() };
            let mut result = std::ptr::null_mut();
            match call(&mut entry, &mut buf, &mut result) {
                0 if !result.is_null() => return Some(read(&entry)),
                libc::ERANGE if size < 1 << 22 => size *= 4,
                _ => return None,
            }
        }
    }

    pub fn account(uid: u32) -> Option<Account> {
        // SAFETY: getpwuid_r writes only into the entry and the buffer it is given.
        lookup(|pwd: &mut libc::passwd, buf, result| unsafe { libc::getpwuid_r(uid, pwd, buf.as_mut_ptr().cast(), buf.len(), result) }, from_passwd)
    }

    pub fn account_named(login: &str) -> Option<Account> {
        let name = CString::new(login).ok()?;
        // SAFETY: getpwnam_r writes only into the entry and the buffer it is given.
        lookup(|pwd: &mut libc::passwd, buf, result| unsafe { libc::getpwnam_r(name.as_ptr(), pwd, buf.as_mut_ptr().cast(), buf.len(), result) }, from_passwd)
    }

    pub fn ids() -> (u32, u32, u32, u32) {
        // SAFETY: these only read the process's credentials.
        unsafe { (libc::geteuid(), libc::getuid(), libc::getegid(), libc::getgid()) }
    }

    pub fn group_name(gid: u32) -> Option<String> {
        // SAFETY: getgrgid_r writes only into the entry and the buffer it is given.
        lookup(|grp: &mut libc::group, buf, result| unsafe { libc::getgrgid_r(gid, grp, buf.as_mut_ptr().cast(), buf.len(), result) }, |g| field(g.gr_name))
    }

    /// The database is walked by one cursor per process, as Emacs walks it,
    /// so the walks take turns.
    static WALK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub fn system_users() -> Vec<String> {
        let _turn = WALK.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        // SAFETY: setpwent, getpwent and endpwent walk the database; each
        // entry is read before the next call replaces it.
        unsafe {
            libc::setpwent();
            loop {
                let p = libc::getpwent();
                if p.is_null() {
                    break;
                }
                out.push(field((*p).pw_name));
            }
            libc::endpwent();
        }
        out
    }

    pub fn system_groups() -> Vec<String> {
        let _turn = WALK.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        // SAFETY: as for system_users, with the group database.
        unsafe {
            libc::setgrent();
            loop {
                let g = libc::getgrent();
                if g.is_null() {
                    break;
                }
                out.push(field((*g).gr_name));
            }
            libc::endgrent();
        }
        out
    }

    pub fn all_processors() -> Option<usize> {
        // SAFETY: sysconf only reads a system setting.
        let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_CONF) };
        (n > 0).then_some(n as usize)
    }

    pub fn stop_self() {
        // The whole process group, as Emacs's sys_suspend stops it, so a
        // shell running E8 under a wrapper sees its job stop too.
        // SAFETY: kill only sends the group a signal, whose default action
        // stops it until a SIGCONT.
        unsafe {
            libc::kill(0, libc::SIGTSTP);
        }
    }
}

#[cfg(not(all(unix, not(target_arch = "wasm32"))))]
mod imp {
    use super::Account;

    /// The one user of a browser.
    const USER: &str = "user";

    pub fn account(uid: u32) -> Option<Account> {
        (uid == 0).then(|| Account { login: USER.to_string(), full_name: String::new() })
    }

    pub fn account_named(login: &str) -> Option<Account> {
        (login == USER).then(|| Account { login: USER.to_string(), full_name: String::new() })
    }

    pub fn ids() -> (u32, u32, u32, u32) {
        (0, 0, 0, 0)
    }

    pub fn group_name(gid: u32) -> Option<String> {
        (gid == 0).then(|| USER.to_string())
    }

    pub fn system_users() -> Vec<String> {
        vec![USER.to_string()]
    }

    pub fn system_groups() -> Vec<String> {
        vec![USER.to_string()]
    }

    pub fn all_processors() -> Option<usize> {
        None
    }

    pub fn stop_self() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_names_read_as_emacs_reads_the_comment_field() {
        assert_eq!(full_name_of("Ada Lovelace,Room 1,555", "ada"), "Ada Lovelace");
        assert_eq!(full_name_of("& Smith", "jane"), "Jane Smith");
        assert_eq!(full_name_of("& and &", "jo"), "Jo and &");
        assert_eq!(full_name_of("", "x"), "");
    }

    #[test]
    fn openmp_may_offer_fewer_processors() {
        assert_eq!(overridable(8, None, None), 8);
        assert_eq!(overridable(8, Some("2,4"), None), 2);
        assert_eq!(overridable(8, Some("6"), Some("3")), 3);
        assert_eq!(overridable(8, Some("0"), Some("x")), 8);
    }
}
