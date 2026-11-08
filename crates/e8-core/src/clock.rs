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
