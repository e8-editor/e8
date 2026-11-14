//! SQLite databases, as Emacs's sqlite.c gives them (ADR 0087): opened,
//! queried with values bound to `?`, stepped through as sets, and closed.

use crate::*;
use crate::natives::{Opt, natives};

fn text(value: &EditorValue, what: &str) -> Result<String> {
    match value {
        EditorValue::Str(s) => Ok(s.clone()),
        EditorValue::Text(t) => Ok(t.string.clone()),
        other => Err(e8_core::xfaces::wrong_type(what, other)),
    }
}

natives! {
    /// Whether SQLite is there, as sqlite-available-p: everywhere but the web.
    pub fn sqliteAvailableP(_ed) -> bool {
        Ok(e8_core::sqlite::available())
    }

    /// The version of the SQLite compiled in, as sqlite-version.
    pub fn sqliteVersion(_ed) -> String {
        e8_core::sqlite::sqlite_version()
    }

    /// Open a database, as sqlite-open: a file, made if there is none, or one of its own in memory with none; undefined if SQLite cannot open it.
    #[ts = "(file?: string | null): Sqlite | undefined"]
    pub fn sqliteOpen(ed, file: Opt<EditorValue>) -> Option<EditorValue> {
        let file = match file.0 {
            None | Some(EditorValue::Null) => None,
            Some(f) => Some(text(&f, "stringp")?),
        };
        Ok(match ed.sqlite_open(file.as_deref())? {
            EditorValue::Null => None,
            db => Some(db),
        })
    }

    /// Close a database, as sqlite-close; true.
    #[ts = "(db: Sqlite): boolean"]
    pub fn sqliteClose(ed, db: EditorValue) -> bool {
        ed.sqlite_close(&db)?;
        Ok(true)
    }

    /// Run the first statement of a query with values bound to its `?`s, as sqlite-execute: how many rows it changed, or the rows it gives.
    #[ts = "(db: Sqlite, query: string, values?: Value[] | null): number | Value[][]"]
    pub fn sqliteExecute(ed, db: EditorValue, query: EditorValue, values: Opt<EditorValue>) -> EditorValue {
        let query = text(&query, "stringp")?;
        ed.sqlite_execute(&db, &query, &values.0.unwrap_or(EditorValue::Null))
    }

    /// The rows a query selects, as sqlite-select: with returnType "full" the column names first, with "set" a set to step through with sqliteNext.
    #[ts = "(db: Sqlite, query: string, values?: Value[] | null, returnType?: \"full\" | \"set\" | symbol | null): Value[][] | Sqlite"]
    pub fn sqliteSelect(ed, db: EditorValue, query: EditorValue, values: Opt<EditorValue>, return_type: Opt<EditorValue>) -> EditorValue {
        let query = text(&query, "stringp")?;
        let kind = return_type.0.as_ref().and_then(|v| v.as_str().map(str::to_string));
        ed.sqlite_select(&db, &query, &values.0.unwrap_or(EditorValue::Null), kind.as_deref())
    }

    /// Run every statement in a string, as sqlite-execute-batch: true, or false if one fails.
    #[ts = "(db: Sqlite, statements: string): boolean"]
    pub fn sqliteExecuteBatch(ed, db: EditorValue, statements: EditorValue) -> bool {
        let statements = text(&statements, "stringp")?;
        ed.sqlite_execute_batch(&db, &statements)
    }

    /// Begin a transaction, as sqlite-transaction.
    #[ts = "(db: Sqlite): boolean"]
    pub fn sqliteTransaction(ed, db: EditorValue) -> bool {
        ed.sqlite_command(&db, "begin")
    }

    /// Commit a transaction, as sqlite-commit.
    #[ts = "(db: Sqlite): boolean"]
    pub fn sqliteCommit(ed, db: EditorValue) -> bool {
        ed.sqlite_command(&db, "commit")
    }

    /// Roll a transaction back, as sqlite-rollback.
    #[ts = "(db: Sqlite): boolean"]
    pub fn sqliteRollback(ed, db: EditorValue) -> bool {
        ed.sqlite_command(&db, "rollback")
    }

    /// Run a pragma, as sqlite-pragma.
    #[ts = "(db: Sqlite, pragma: string): boolean"]
    pub fn sqlitePragma(ed, db: EditorValue, pragma: EditorValue) -> bool {
        let pragma = text(&pragma, "stringp")?;
        ed.sqlite_command(&db, &format!("PRAGMA {pragma}"))
    }

    /// Load a module on Emacs's allowlist into a database, as sqlite-load-extension.
    #[ts = "(db: Sqlite, module: string): boolean"]
    pub fn sqliteLoadExtension(ed, db: EditorValue, module: EditorValue) -> bool {
        let module = text(&module, "stringp")?;
        ed.sqlite_load_extension(&db, &module)
    }

    /// The next row of a set, as sqlite-next; undefined once there are none.
    #[ts = "(set: Sqlite): Value[] | undefined"]
    pub fn sqliteNext(ed, set: EditorValue) -> Option<EditorValue> {
        Ok(match ed.sqlite_next(&set)? {
            EditorValue::Null => None,
            row => Some(row),
        })
    }

    /// A set's column names, as sqlite-columns.
    #[ts = "(set: Sqlite): string[]"]
    pub fn sqliteColumns(ed, set: EditorValue) -> EditorValue {
        ed.sqlite_columns(&set)
    }

    /// Whether a set may have rows left, as sqlite-more-p.
    #[ts = "(set: Sqlite): boolean"]
    pub fn sqliteMoreP(ed, set: EditorValue) -> bool {
        ed.sqlite_more_p(&set)
    }

    /// Finish a set, freeing its statement, as sqlite-finalize.
    #[ts = "(set: Sqlite): boolean"]
    pub fn sqliteFinalize(ed, set: EditorValue) -> bool {
        ed.sqlite_finalize(&set)?;
        Ok(true)
    }

    /// How an SQLite object prints, as Emacs prints one.
    fn sqliteDescription(ed, object: EditorValue) -> Option<String> {
        let EditorValue::Sqlite(id) = object else { return Ok(None) };
        Ok(ed.sqlite_description(id).map(|(set, name)| if set { format!("#<sqlite statement name={name}>") } else { format!("#<sqlite db name={name}>") }))
    }
}
