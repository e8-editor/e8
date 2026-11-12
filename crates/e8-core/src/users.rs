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

/// The login names of the system's users, as Emacs's `system-users`.
pub fn system_users() -> Vec<String> {
    imp::system_users()
}

/// The names of the system's groups, as Emacs's `system-groups`.
pub fn system_groups() -> Vec<String> {
    imp::system_groups()
}

/// The login name the editor goes by, as Emacs sets `user-login-name`:
/// `$LOGNAME`, else `$USER`, else the effective user's.
pub fn login_name() -> String {
    std::env::var("LOGNAME")
        .ok()
        .filter(|n| !n.is_empty())
        .or_else(|| std::env::var("USER").ok().filter(|n| !n.is_empty()))
        .or_else(|| account(user_uid()).map(|a| a.login))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The real user's login name, as Emacs sets `user-real-login-name`.
pub fn real_login_name() -> String {
    account(user_real_uid()).map_or_else(|| "unknown".to_string(), |a| a.login)
}

/// The full name the editor goes by, as Emacs sets `user-full-name`:
/// `$NAME`, else the login name's account's.
pub fn full_name() -> String {
    std::env::var("NAME")
        .ok()
        .filter(|n| !n.is_empty())
        .or_else(|| account_named(&login_name()).map(|a| a.full_name))
        .unwrap_or_else(|| "unknown".to_string())
}

/// How many processors there are, as Emacs's `num-processors`.
pub fn num_processors(query: Processors) -> usize {
    let current = std::thread::available_parallelism().map_or(1, |n| n.get());
    match query {
        Processors::Current => current,
        Processors::All => imp::all_processors().unwrap_or(current),
        Processors::Overridable => {
            // As gnulib's num_processors with NPROC_CURRENT_OVERRIDABLE.
            let env = |name: &str| std::env::var(name).ok().and_then(|v| v.split(',').next()?.trim().parse::<usize>().ok()).filter(|n| *n > 0);
            let wanted = env("OMP_NUM_THREADS").unwrap_or(current);
            env("OMP_THREAD_LIMIT").map_or(wanted, |limit| wanted.min(limit))
        }
    }
}

/// Stops the process until the shell continues it, as a terminal's job is
/// stopped by `C-z`: what Emacs's `suspend-emacs` does once the terminal is
/// back as the shell left it. Does nothing where there is no shell.
pub fn stop_self() {
    imp::stop_self();
}

/// A full name as the password database's comment field gives it, as
/// Emacs reads it: up to the first comma, `&` standing for the login name
/// with its first letter capitalized.
#[cfg_attr(not(unix), allow(dead_code))]
fn full_name_of(gecos: &str, login: &str) -> String {
    let name = gecos.split(',').next().unwrap_or("");
    let mut capital = login.chars();
    let login = capital.next().map(|c| c.to_uppercase().chain(capital).collect::<String>()).unwrap_or_default();
    name.replace('&', &login)
}

#[cfg(all(unix, not(target_arch = "wasm32")))]
mod imp {
    use super::Account;
    use std::ffi::{CStr, CString};

    fn from_passwd(pwd: &libc::passwd) -> Account {
        // SAFETY: the fields of a passwd getpw*_r filled point to NUL-terminated strings in its buffer.
        let field = |p: *const libc::c_char| if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() };
        let login = field(pwd.pw_name);
        Account { full_name: super::full_name_of(&field(pwd.pw_gecos), &login), login }
    }

    pub fn account(uid: u32) -> Option<Account> {
        let mut buf = vec![0u8; 16384];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        // SAFETY: getpwuid_r writes only into pwd and buf, which outlive the call.
        let ok = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result) } == 0;
        (ok && !result.is_null()).then(|| from_passwd(&pwd))
    }

    pub fn account_named(login: &str) -> Option<Account> {
        let name = CString::new(login).ok()?;
        let mut buf = vec![0u8; 16384];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        // SAFETY: getpwnam_r writes only into pwd and buf, which outlive the call.
        let ok = unsafe { libc::getpwnam_r(name.as_ptr(), &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result) } == 0;
        (ok && !result.is_null()).then(|| from_passwd(&pwd))
    }

    pub fn ids() -> (u32, u32, u32, u32) {
        // SAFETY: these only read the process's credentials.
        unsafe { (libc::geteuid(), libc::getuid(), libc::getegid(), libc::getgid()) }
    }

    pub fn group_name(gid: u32) -> Option<String> {
        let mut buf = vec![0u8; 16384];
        let mut grp: libc::group = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        // SAFETY: getgrgid_r writes only into grp and buf, which outlive the call.
        let ok = unsafe { libc::getgrgid_r(gid, &mut grp, buf.as_mut_ptr().cast(), buf.len(), &mut result) } == 0;
        // SAFETY: on success gr_name points to a NUL-terminated string in buf.
        (ok && !result.is_null()).then(|| unsafe { CStr::from_ptr(grp.gr_name) }.to_string_lossy().into_owned())
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
                out.push(CStr::from_ptr((*p).pw_name).to_string_lossy().into_owned());
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
                out.push(CStr::from_ptr((*g).gr_name).to_string_lossy().into_owned());
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
        // SAFETY: raise only sends this process a signal, whose default
        // action stops it until a SIGCONT.
        unsafe {
            libc::raise(libc::SIGTSTP);
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
        assert_eq!(full_name_of("", "x"), "");
    }
}
