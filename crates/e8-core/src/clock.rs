//! The clock, and what else std panics for on the web rather than failing:
//! the editor reads the time, its process id and the temporary directory
//! from here, std's natively and stand-ins on the web.

pub use web_time::Instant;

use std::time::SystemTime;

/// The time now, as `SystemTime::now`.
pub fn system_now() -> SystemTime {
    #[cfg(target_arch = "wasm32")]
    {
        let since = web_time::SystemTime::now().duration_since(web_time::UNIX_EPOCH).unwrap_or_default();
        std::time::UNIX_EPOCH + since
    }
    #[cfg(not(target_arch = "wasm32"))]
    SystemTime::now()
}

/// This process's id, as `std::process::id`; on the web, which has no
/// processes, a fixed one.
pub fn process_id() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        1
    }
    #[cfg(not(target_arch = "wasm32"))]
    std::process::id()
}

/// The directory for temporary files, as `std::env::temp_dir`; on the web,
/// which has no file system, `/tmp`.
pub fn temp_dir() -> std::path::PathBuf {
    #[cfg(target_arch = "wasm32")]
    {
        "/tmp".into()
    }
    #[cfg(not(target_arch = "wasm32"))]
    std::env::temp_dir()
}

/// The processor time this process has used, in seconds, as Emacs's
/// `get-internal-run-time` asks getrusage: user and system time together.
/// On the web, which cannot ask, the time since the editor started.
pub fn run_time() -> f64 {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage fills the struct it is given.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
            // SAFETY: filled by the successful call above.
            let u = unsafe { usage.assume_init() };
            let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
            return secs(u.ru_utime) + secs(u.ru_stime);
        }
        0.0
    }
    #[cfg(not(unix))]
    {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_secs_f64()
    }
}
