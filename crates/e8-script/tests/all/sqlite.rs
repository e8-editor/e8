//! SQLite, as Emacs's sqlite.c gives it (ADR 0087). Each expectation is
//! what Emacs 30.2 gives for the same calls.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript with `db` an in-memory database kept between calls,
/// giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.db ??= e8.sqliteOpen(); const db = globalThis.db; globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn databases_are_queried_as_emacs_queries_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return [e8.sqliteAvailableP(), e8.sqlitep(db), e8.sqlitep(3)];"), "[true,true,false]");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "create table t (a integer, b text, c real, d blob)");"#), "0");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "insert into t values (?, ?, ?, ?)", [1, "één", 2.5, null]);"#), "1");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "insert into t values (?, ?, ?, ?)", [2, "two", null, true]);"#), "1");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "insert into t values (3, 'x', 0.5, x'00ff')");"#), "1");
    // As Emacs: ((1 "één" 2.5 nil) (2 "two" nil 1) (3 "x" 0.5 "\0\377")).
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select * from t");"#), r#"[[1,"één",2.5,null],[2,"two",null,1],[3,"x",0.5,"\u0000ÿ"]]"#);
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select a, b from t where a > ?", [1], "full");"#), r#"[["a","b"],[2,"two"],[3,"x"]]"#);
    assert_eq!(r(r#"return e8.sqliteExecute(db, "update t set b = 'y' where a >= 2");"#), "2");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "select a from t");"#), "[[1],[2],[3]]");
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select 1, 'a', null, 1.5");"#), r#"[[1,"a",null,1.5]]"#);
    // Errors, as Emacs signals them.
    assert_eq!(
        r(r#"return e8.sqliteExecute(db, "insert into t values (?)", [1, 2]);"#),
        "ERR sqlite-error SQL logic error, table t has 4 columns but 1 values were supplied, 1, 1"
    );
    assert_eq!(r(r#"return e8.sqliteExecute(db, "insert into t values (?, ?, ?, ?)", [[1], 2, 3, 4]);"#), "ERR sqlite-error invalid argument");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "bogus sql");"#), "ERR sqlite-error SQL logic error, near \"bogus\": syntax error, 1, 1");
    assert_eq!(r(r#"return e8.sqliteExecute(db, "select", 3 as any);"#), "ERR sqlite-error VALUES must be a list or a vector");
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select * from nosuch");"#), "ERR sqlite-error SQL logic error, no such table: nosuch, 1, 1");
}

#[test]
fn sets_batches_transactions_and_closing() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.sqliteExecute(db, "create table t (a)"); for (const a of [1, 2, 3]) e8.sqliteExecute(db, "insert into t values (?)", [a]); return null;"#);
    // As Emacs: (("a") t (1) (2) (3) t nil nil t (sqlite-error "Statement closed")).
    assert_eq!(
        r(r#"const s = e8.sqliteSelect(db, "select a from t order by a", null, "set") as e8.Sqlite;
            const out: any[] = [e8.sqliteColumns(s), e8.sqliteMoreP(s), e8.sqliteNext(s), e8.sqliteNext(s), e8.sqliteNext(s), e8.sqliteMoreP(s), e8.sqliteNext(s) ?? null, e8.sqliteMoreP(s), e8.sqliteFinalize(s)];
            try { e8.sqliteNext(s); } catch (e: any) { out.push(e.message); }
            return out;"#),
        r#"[["a"],true,[1],[2],[3],true,null,false,true,"Statement closed"]"#
    );
    assert_eq!(r(r#"return e8.sqliteExecuteBatch(db, "create table u (x); insert into u values (1); insert into u values (2);");"#), "true");
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select count(*) from u");"#), "[[2]]");
    assert_eq!(r(r#"return e8.sqliteExecuteBatch(db, "nonsense;");"#), "false");
    assert_eq!(r(r#"return [e8.sqliteTransaction(db), e8.sqliteExecute(db, "insert into u values (3)"), e8.sqliteRollback(db), e8.sqliteSelect(db, "select count(*) from u")];"#), "[true,1,true,[[2]]]");
    assert_eq!(r(r#"return [e8.sqliteTransaction(db), e8.sqliteExecute(db, "insert into u values (3)"), e8.sqliteCommit(db), e8.sqliteSelect(db, "select count(*) from u")];"#), "[true,1,true,[[3]]]");
    assert_eq!(r(r#"return [e8.sqlitePragma(db, "user_version = 7"), e8.sqliteSelect(db, "pragma user_version")];"#), "[true,[[7]]]");
    assert_eq!(r(r#"return e8.sqliteLoadExtension(db, "/tmp/evil.so");"#), "ERR sqlite-error Module name not on allowlist");
    assert_eq!(r("return e8.sqliteNext(db);"), "ERR sqlite-error Invalid set object");
    assert_eq!(r(r#"return e8.sqliteClose(e8.sqliteSelect(db, "select 1", null, "set") as e8.Sqlite);"#), "ERR sqlite-error Invalid database object");
    assert_eq!(r("return e8.sqliteClose(db);"), "true");
    assert_eq!(r("return e8.sqliteClose(db);"), "ERR sqlite-error Database closed");
    assert_eq!(r(r#"return e8.sqliteSelect(db, "select 1");"#), "ERR sqlite-error Database closed");
    assert_eq!(r("return e8.sqliteClose(3 as any);"), "ERR wrong-type-argument Wrong type argument: sqlitep, 3");
    assert_eq!(r("return typeof e8.sqliteVersion();"), r#""string""#);
    assert_eq!(r(r#"return e8.sqliteOpen("/nonexistent/dir/x.db") ?? null;"#), "null");
}

#[test]
fn a_database_in_a_file_keeps_its_data() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("data.db");
    let path = file.to_str().unwrap();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(&format!(r#"const d = e8.sqliteOpen({path:?})!; e8.sqliteExecute(d, "create table k (v)"); e8.sqliteExecute(d, "insert into k values ('kept')"); return e8.sqliteClose(d);"#)), "true");
    assert_eq!(r(&format!(r#"const d = e8.sqliteOpen({path:?})!; return e8.sqliteSelect(d, "select v from k");"#)), r#"[["kept"]]"#);
    assert!(file.exists());
}
