//! SQLite databases, as Emacs's sqlite.c (ADR 0087): databases and the
//! sets `sqlite-select` gives as values (`Value::Sqlite`), on SQLite itself
//! (`libsqlite3-sys`, bundled), call for call as sqlite.c makes them:
//! statements prepared, values bound and rows stepped through, with its
//! errors (`sqlite-error`, `sqlite-locked-error`). On the web there is no
//! SQLite, so `sqlite-available-p` is nil there and the rest signal.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// The modules `sqlite-load-extension` loads, as Emacs's allowlist names them.
const ALLOWED_MODULES: &[&str] = &[
    "base64", "cksumvfs", "compress", "csv", "csvtable", "fts3", "icu", "pcre", "percentile", "regexp", "rot13", "rtree", "sha1", "uuid",
    "vec0", "vector0", "vfslog", "vss0", "zipfile",
];

/// Whether a module's file is one `sqlite-load-extension` may load: its
/// name, after any `libsqlite3_mod_`, an allowed module's and then a
/// shared library's extension.
pub fn module_allowed(module: &str) -> bool {
    let name = module.rsplit('/').next().unwrap_or(module);
    let name = name.strip_prefix("libsqlite3_mod_").unwrap_or(name);
    ALLOWED_MODULES.iter().any(|allow| {
        name.len() > allow.len()
            && name.starts_with(allow)
            && matches!(&name[allow.len()..], ".so" | ".dylib") | name[allow.len()..].eq_ignore_ascii_case(".dll")
    })
}

fn sqlite_error(data: Value) -> Error {
    let message = match &data {
        Value::List(items) => items.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).collect::<Vec<_>>().join(", "),
        other => other.as_str().map_or_else(|| other.to_string(), str::to_string),
    };
    Error::signal("sqlite-error", message, vec![data])
}

fn plain(message: &str) -> Error {
    sqlite_error(Value::Str(message.to_string()))
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
    use libsqlite3_sys as ffi;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_int;

    /// A database or a set, as sqlite.c's `Lisp_Sqlite`: a set keeps its
    /// database's handle and its statement, and a closed one neither.
    pub(crate) struct Object {
        is_statement: bool,
        db: *mut ffi::sqlite3,
        stmt: *mut ffi::sqlite3_stmt,
        pub(crate) name: String,
        eof: bool,
    }

    // SQLite is opened serialized (SQLITE_OPEN_FULLMUTEX), so its handles
    // may move between threads with the editor.
    unsafe impl Send for Object {}

    impl Drop for Object {
        fn drop(&mut self) {
            // SAFETY: a handle is freed once, by whichever of close,
            // finalize and this finds it still held.
            unsafe {
                if self.is_statement && !self.db.is_null() {
                    ffi::sqlite3_finalize(self.stmt);
                } else if !self.is_statement && !self.db.is_null() {
                    ffi::sqlite3_close(self.db);
                }
            }
        }
    }

    #[derive(Default)]
    pub(crate) struct Sqlite {
        objects: std::collections::HashMap<u64, Object>,
        next: u64,
        memory: u64,
    }

    fn errmsg(db: *mut ffi::sqlite3) -> String {
        // SAFETY: sqlite3_errmsg gives a string SQLite owns, valid until the next call.
        unsafe {
            let p = ffi::sqlite3_errmsg(db);
            if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
        }
    }

    /// What sqlite.c's `sqlite_prepare_errdata` gives: the code's text, the
    /// database's message, the code and the extended code.
    fn prepare_errdata(code: c_int, db: *mut ffi::sqlite3) -> Value {
        // SAFETY: sqlite3_errstr gives a static string.
        let errstr = unsafe { CStr::from_ptr(ffi::sqlite3_errstr(code)).to_string_lossy().into_owned() };
        // SAFETY: db is open.
        let extended = unsafe { ffi::sqlite3_extended_errcode(db) };
        Value::List(vec![Value::Str(errstr), Value::Str(errmsg(db)), Value::Number(code as f64), Value::Number(extended as f64)])
    }

    /// A value bound to a statement's parameter, as sqlite.c's `bind_values`.
    fn bind(db: *mut ffi::sqlite3, stmt: *mut ffi::sqlite3_stmt, values: &[Value]) -> std::result::Result<(), Value> {
        // SAFETY: stmt is a live statement of db; text and blobs are copied (SQLITE_TRANSIENT).
        unsafe {
            ffi::sqlite3_reset(stmt);
            for (i, value) in values.iter().enumerate() {
                let n = i as c_int + 1;
                let ret = match value {
                    Value::Str(_) | Value::Text(_) => {
                        let text = value.as_str().unwrap_or_default();
                        let binary = matches!(value, Value::Text(t) if t.properties_at(0).and_then(|p| p.get("coding-system")).and_then(Value::as_str) == Some("binary"));
                        if binary && !text.is_empty() {
                            let Some(bytes) = crate::coding::bytes_of_string(text) else {
                                return Err(Value::Str("BLOB values must be unibyte".into()));
                            };
                            ffi::sqlite3_bind_blob(stmt, n, bytes.as_ptr().cast(), bytes.len() as c_int, ffi::SQLITE_TRANSIENT())
                        } else {
                            ffi::sqlite3_bind_text(stmt, n, text.as_ptr().cast(), text.len() as c_int, ffi::SQLITE_TRANSIENT())
                        }
                    }
                    Value::Number(x) if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 => ffi::sqlite3_bind_int64(stmt, n, *x as i64),
                    Value::Number(x) => ffi::sqlite3_bind_double(stmt, n, *x),
                    Value::Null => ffi::sqlite3_bind_null(stmt, n),
                    Value::Bool(true) => ffi::sqlite3_bind_int(stmt, n, 1),
                    Value::Bool(false) => ffi::sqlite3_bind_int(stmt, n, 0),
                    Value::Symbol(s) if s == "t" => ffi::sqlite3_bind_int(stmt, n, 1),
                    Value::Symbol(s) if s == "nil" => ffi::sqlite3_bind_null(stmt, n),
                    Value::Symbol(s) if s == "false" => ffi::sqlite3_bind_int(stmt, n, 0),
                    _ => return Err(Value::Str("invalid argument".into())),
                };
                if ret != ffi::SQLITE_OK {
                    return Err(Value::Str(errmsg(db)));
                }
            }
        }
        Ok(())
    }

    /// The row a statement is on, as sqlite.c's `row_to_value`: integers,
    /// floats, text, blobs as strings of bytes, and nil for NULL.
    fn row(stmt: *mut ffi::sqlite3_stmt) -> Value {
        // SAFETY: stmt is on a row; column pointers are read before the next step.
        unsafe {
            let count = ffi::sqlite3_column_count(stmt);
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                out.push(match ffi::sqlite3_column_type(stmt, i) {
                    ffi::SQLITE_INTEGER => Value::Number(ffi::sqlite3_column_int64(stmt, i) as f64),
                    ffi::SQLITE_FLOAT => Value::Number(ffi::sqlite3_column_double(stmt, i)),
                    ffi::SQLITE_BLOB => {
                        let p = ffi::sqlite3_column_blob(stmt, i) as *const u8;
                        let n = ffi::sqlite3_column_bytes(stmt, i) as usize;
                        let bytes = if p.is_null() { &[][..] } else { std::slice::from_raw_parts(p, n) };
                        Value::Str(crate::coding::string_of_bytes(bytes))
                    }
                    ffi::SQLITE_TEXT => {
                        let p = ffi::sqlite3_column_text(stmt, i);
                        let n = ffi::sqlite3_column_bytes(stmt, i) as usize;
                        let bytes = if p.is_null() { &[][..] } else { std::slice::from_raw_parts(p, n) };
                        Value::Str(String::from_utf8_lossy(bytes).into_owned())
                    }
                    _ => Value::Null,
                });
            }
            Value::List(out)
        }
    }

    fn column_names(stmt: *mut ffi::sqlite3_stmt) -> Value {
        // SAFETY: stmt is live; names are copied at once.
        unsafe {
            let count = ffi::sqlite3_column_count(stmt);
            Value::List((0..count).map(|i| Value::Str(CStr::from_ptr(ffi::sqlite3_column_name(stmt, i)).to_string_lossy().into_owned())).collect())
        }
    }

    fn values_of(values: &Value) -> Result<Vec<Value>> {
        match values {
            Value::Null => Ok(Vec::new()),
            Value::List(items) => Ok(items.clone()),
            _ => Err(plain("VALUES must be a list or a vector")),
        }
    }

    impl Sqlite {
        fn add(&mut self, object: Object) -> u64 {
            self.next += 1;
            self.objects.insert(self.next, object);
            self.next
        }

        /// The object a value is, checked as sqlite.c's `check_sqlite`.
        fn check(&mut self, value: &Value, statement: bool) -> Result<&mut Object> {
            let Value::Sqlite(id) = value else { return Err(crate::xfaces::wrong_type("sqlitep", value)) };
            let Some(o) = self.objects.get_mut(id) else { return Err(crate::xfaces::wrong_type("sqlitep", value)) };
            match (statement, o.is_statement) {
                (true, false) => return Err(plain("Invalid set object")),
                (false, true) => return Err(plain("Invalid database object")),
                _ => {}
            }
            if o.db.is_null() {
                return Err(plain(if statement { "Statement closed" } else { "Database closed" }));
            }
            Ok(o)
        }
    }

    impl Editor {
        /// Opens a database, as `sqlite-open`: a file, made if there is none,
        /// or one in memory, of its own, with none. Nil if SQLite cannot open it.
        pub fn sqlite_open(&mut self, file: Option<&str>) -> Result<Value> {
            let mut flags = ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_FULLMUTEX | ffi::SQLITE_OPEN_URI;
            let name = match file {
                Some(file) => self.expand_file_name(file).to_string_lossy().into_owned(),
                None => {
                    self.sqlite.memory += 1;
                    flags |= ffi::SQLITE_OPEN_MEMORY;
                    format!(":memory:{}", self.sqlite.memory)
                }
            };
            let Ok(cname) = CString::new(name.clone()) else { return Ok(Value::Null) };
            let mut db = std::ptr::null_mut();
            // SAFETY: cname is a valid C string; db is written by SQLite.
            let ret = unsafe { ffi::sqlite3_open_v2(cname.as_ptr(), &mut db, flags, std::ptr::null()) };
            if ret != ffi::SQLITE_OK {
                // SAFETY: a handle given back with an error is still SQLite's to free.
                unsafe { ffi::sqlite3_close(db) };
                return Ok(Value::Null);
            }
            let id = self.sqlite.add(Object { is_statement: false, db, stmt: std::ptr::null_mut(), name, eof: false });
            Ok(Value::Sqlite(id))
        }

        /// Closes a database, as `sqlite-close`.
        pub fn sqlite_close(&mut self, db: &Value) -> Result<()> {
            let o = self.sqlite.check(db, false)?;
            // SAFETY: the handle is open, and forgotten once closed.
            unsafe { ffi::sqlite3_close(o.db) };
            o.db = std::ptr::null_mut();
            Ok(())
        }

        /// Runs the first statement of QUERY with VALUES bound, as
        /// `sqlite-execute`: how many rows it changed, or the rows a
        /// statement giving rows gives.
        pub fn sqlite_execute(&mut self, db: &Value, query: &str, values: &Value) -> Result<Value> {
            let sdb = self.sqlite.check(db, false)?.db;
            let values = values_of(values)?;
            let Ok(cquery) = CString::new(query) else { return Err(plain("invalid argument")) };
            let mut stmt = std::ptr::null_mut();
            // SAFETY: sdb is open; stmt is finalized on every path below.
            unsafe {
                let ret = ffi::sqlite3_prepare_v2(sdb, cquery.as_ptr(), -1, &mut stmt, std::ptr::null_mut());
                if ret != ffi::SQLITE_OK {
                    let data = prepare_errdata(ret, sdb);
                    ffi::sqlite3_finalize(stmt);
                    return Err(locked_or(ret, data));
                }
                if !values.is_empty()
                    && let Err(data) = bind(sdb, stmt, &values)
                {
                    ffi::sqlite3_finalize(stmt);
                    return Err(sqlite_error(data));
                }
                let mut ret = ffi::sqlite3_step(stmt);
                if ret == ffi::SQLITE_ROW {
                    let mut rows = Vec::new();
                    while ret == ffi::SQLITE_ROW {
                        rows.push(row(stmt));
                        ret = ffi::sqlite3_step(stmt);
                    }
                    ffi::sqlite3_finalize(stmt);
                    return Ok(Value::List(rows));
                }
                if ret == ffi::SQLITE_OK || ret == ffi::SQLITE_DONE {
                    let changes = ffi::sqlite3_changes(sdb);
                    ffi::sqlite3_finalize(stmt);
                    return Ok(Value::Number(changes as f64));
                }
                let data = Value::Str(errmsg(sdb));
                ffi::sqlite3_finalize(stmt);
                Err(locked_or(ret, data))
            }
        }

        /// The rows QUERY selects with VALUES bound, as `sqlite-select`:
        /// the rows, with `full` the column names first, or with `set` a
        /// set to step through.
        pub fn sqlite_select(&mut self, db: &Value, query: &str, values: &Value, return_type: Option<&str>) -> Result<Value> {
            let (sdb, name) = {
                let o = self.sqlite.check(db, false)?;
                (o.db, o.name.clone())
            };
            let values = values_of(values)?;
            let Ok(cquery) = CString::new(query) else { return Err(plain("invalid argument")) };
            let mut stmt = std::ptr::null_mut();
            // SAFETY: as in sqlite_execute; a set keeps its statement.
            unsafe {
                let ret = ffi::sqlite3_prepare_v2(sdb, cquery.as_ptr(), query.len() as c_int, &mut stmt, std::ptr::null_mut());
                if ret != ffi::SQLITE_OK {
                    let data = prepare_errdata(ret, sdb);
                    ffi::sqlite3_finalize(stmt);
                    return Err(sqlite_error(data));
                }
                if !values.is_empty()
                    && let Err(data) = bind(sdb, stmt, &values)
                {
                    ffi::sqlite3_finalize(stmt);
                    return Err(sqlite_error(data));
                }
                if return_type == Some("set") {
                    let id = self.sqlite.add(Object { is_statement: true, db: sdb, stmt, name, eof: false });
                    return Ok(Value::Sqlite(id));
                }
                let mut rows = Vec::new();
                while ffi::sqlite3_step(stmt) == ffi::SQLITE_ROW {
                    rows.push(row(stmt));
                }
                if return_type == Some("full") {
                    rows.insert(0, column_names(stmt));
                }
                ffi::sqlite3_finalize(stmt);
                Ok(Value::List(rows))
            }
        }

        /// Runs SQL on a database, as sqlite.c's `sqlite_exec`: t, or nil
        /// if it fails.
        fn sqlite_exec(&mut self, db: &Value, sql: &str) -> Result<bool> {
            let sdb = self.sqlite.check(db, false)?.db;
            let Ok(c) = CString::new(sql) else { return Ok(false) };
            // SAFETY: sdb is open; no callback.
            Ok(unsafe { ffi::sqlite3_exec(sdb, c.as_ptr(), None, std::ptr::null_mut(), std::ptr::null_mut()) } == ffi::SQLITE_OK)
        }

        /// Runs every statement, as `sqlite-execute-batch`.
        pub fn sqlite_execute_batch(&mut self, db: &Value, statements: &str) -> Result<bool> {
            self.sqlite_exec(db, statements)
        }

        /// Begins, commits or rolls back a transaction, as
        /// `sqlite-transaction`, `sqlite-commit` and `sqlite-rollback`, or
        /// runs a pragma, as `sqlite-pragma`.
        pub fn sqlite_command(&mut self, db: &Value, command: &str) -> Result<bool> {
            self.sqlite_exec(db, command)
        }

        /// Loads an allowed module into a database, as `sqlite-load-extension`.
        pub fn sqlite_load_extension(&mut self, db: &Value, module: &str) -> Result<bool> {
            let sdb = self.sqlite.check(db, false)?.db;
            if !module_allowed(module) {
                return Err(plain("Module name not on allowlist"));
            }
            let path = self.expand_file_name(module).to_string_lossy().into_owned();
            let Ok(c) = CString::new(path) else { return Ok(false) };
            // SAFETY: loading is turned on only for this call.
            unsafe {
                if ffi::sqlite3_db_config(sdb, ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1 as c_int, std::ptr::null_mut::<c_int>()) != ffi::SQLITE_OK {
                    return Ok(false);
                }
                let ret = ffi::sqlite3_load_extension(sdb, c.as_ptr(), std::ptr::null(), std::ptr::null_mut());
                ffi::sqlite3_db_config(sdb, ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0 as c_int, std::ptr::null_mut::<c_int>());
                Ok(ret == ffi::SQLITE_OK)
            }
        }

        /// The next row of a set, as `sqlite-next`; nil once there is none.
        pub fn sqlite_next(&mut self, set: &Value) -> Result<Value> {
            let o = self.sqlite.check(set, true)?;
            if o.eof {
                return Ok(Value::Null);
            }
            // SAFETY: the set's statement is live.
            let ret = unsafe { ffi::sqlite3_step(o.stmt) };
            if ret != ffi::SQLITE_ROW && ret != ffi::SQLITE_OK && ret != ffi::SQLITE_DONE {
                return Err(sqlite_error(Value::Str(errmsg(o.db))));
            }
            if ret == ffi::SQLITE_DONE {
                o.eof = true;
                return Ok(Value::Null);
            }
            Ok(row(o.stmt))
        }

        /// A set's column names, as `sqlite-columns`.
        pub fn sqlite_columns(&mut self, set: &Value) -> Result<Value> {
            Ok(column_names(self.sqlite.check(set, true)?.stmt))
        }

        /// Whether a set may have rows left, as `sqlite-more-p`.
        pub fn sqlite_more_p(&mut self, set: &Value) -> Result<bool> {
            Ok(!self.sqlite.check(set, true)?.eof)
        }

        /// Finishes a set, as `sqlite-finalize`.
        pub fn sqlite_finalize(&mut self, set: &Value) -> Result<()> {
            let o = self.sqlite.check(set, true)?;
            // SAFETY: the statement is live, and forgotten once finalized.
            unsafe { ffi::sqlite3_finalize(o.stmt) };
            o.db = std::ptr::null_mut();
            Ok(())
        }

        /// What an object is, for printing: a database or a set, with its
        /// database's name, as Emacs prints `#<sqlite db=... name=...>`.
        pub fn sqlite_description(&self, id: u64) -> Option<(bool, String)> {
            self.sqlite.objects.get(&id).map(|o| (o.is_statement, o.name.clone()))
        }
    }

    fn locked_or(ret: c_int, data: Value) -> Error {
        if ret == ffi::SQLITE_LOCKED || ret == ffi::SQLITE_BUSY {
            let message = sqlite_error(data.clone()).message().to_string();
            Error::signal("sqlite-locked-error", message, vec![data])
        } else {
            sqlite_error(data)
        }
    }

    /// The version of the SQLite compiled in, as `sqlite-version`.
    pub fn version() -> String {
        // SAFETY: a static string.
        unsafe { CStr::from_ptr(ffi::sqlite3_libversion()).to_string_lossy().into_owned() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use native::Sqlite;

/// No SQLite on the web: every function signals, as Emacs's do where
/// SQLite is not available.
#[cfg(target_arch = "wasm32")]
#[derive(Default)]
pub(crate) struct Sqlite;

#[cfg(target_arch = "wasm32")]
impl Editor {
    pub fn sqlite_open(&mut self, _file: Option<&str>) -> Result<Value> {
        Err(plain("sqlite support is not available"))
    }
    pub fn sqlite_close(&mut self, db: &Value) -> Result<()> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_execute(&mut self, db: &Value, _query: &str, _values: &Value) -> Result<Value> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_select(&mut self, db: &Value, _query: &str, _values: &Value, _return_type: Option<&str>) -> Result<Value> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_execute_batch(&mut self, db: &Value, _statements: &str) -> Result<bool> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_command(&mut self, db: &Value, _command: &str) -> Result<bool> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_load_extension(&mut self, db: &Value, _module: &str) -> Result<bool> {
        Err(crate::xfaces::wrong_type("sqlitep", db))
    }
    pub fn sqlite_next(&mut self, set: &Value) -> Result<Value> {
        Err(crate::xfaces::wrong_type("sqlitep", set))
    }
    pub fn sqlite_columns(&mut self, set: &Value) -> Result<Value> {
        Err(crate::xfaces::wrong_type("sqlitep", set))
    }
    pub fn sqlite_more_p(&mut self, set: &Value) -> Result<bool> {
        Err(crate::xfaces::wrong_type("sqlitep", set))
    }
    pub fn sqlite_finalize(&mut self, set: &Value) -> Result<()> {
        Err(crate::xfaces::wrong_type("sqlitep", set))
    }
    pub fn sqlite_description(&self, _id: u64) -> Option<(bool, String)> {
        None
    }
}

/// Whether SQLite is there, as `sqlite-available-p`.
pub fn available() -> bool {
    cfg!(not(target_arch = "wasm32"))
}

/// SQLite's version, as `sqlite-version`; an error where there is none.
pub fn sqlite_version() -> Result<String> {
    #[cfg(not(target_arch = "wasm32"))]
    return Ok(native::version());
    #[cfg(target_arch = "wasm32")]
    Err(Error::new("sqlite support is not available"))
}
