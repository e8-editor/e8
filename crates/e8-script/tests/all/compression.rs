//! Decompressing gzip and zlib data in a buffer, as Emacs's decompress.c
//! does, and symbol-file (ADR 0075). What Emacs gives was recorded from
//! Emacs 30 in a unibyte buffer holding "AB" and then the compressed data,
//! decompressing from position 3 to the end with point at the end.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// "héllo world\n" 40 times in UTF-8, 480 characters, gzipped.
const GZ: &str = "1f8b08000000000002ffcb38bc3227275fa13cbf2827852b6394335239007b3307f008020000";
/// The same, zlib-compressed.
const Z: &str = "789ccb38bc3227275fa13cbf2827852b639433523900ab17d909";
/// The same gzip data with a byte of its CRC changed.
const BAD_CRC: &str = "1f8b08000000000002ffcb38bc3227275fa13cbf2827852b6394335239007b33f8f008020000";

/// Decompresses `data` after "AB", as the recorded case did: the result,
/// point, the buffer's size, and the text decoded as UTF-8.
fn decompress(data: &[u8], partial: bool) -> (String, usize, usize, String) {
    let (mut ed, s) = setup();
    let text: String = "AB".chars().chain(data.iter().map(|&b| e8_core::coding::raw_byte_char(b))).collect();
    ed.window_buffer_mut().set_text(&text);
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    let result = eval(&mut ed, &s, &format!("e8.zlibDecompressRegion(2, {end}, {partial}) ?? null"));
    let (point, size) = (ed.window_buffer().point(), ed.window_buffer().len());
    eval(&mut ed, &s, &format!("e8.decodeCodingRegion(2, {size}, \"utf-8\")"));
    let decoded = ed.window_buffer().text().to_string();
    (result, point, size, decoded)
}

#[test]
fn gzip_and_zlib_data_decompress_as_emacs_decompresses_them() {
    let text = format!("AB{}", "héllo world\n".repeat(40));
    for partial in [false, true] {
        // Whole: t, point where it was, 520 bytes that decode to 480 characters.
        assert_eq!(decompress(&hex(GZ), partial), ("true".into(), 40, 522, text.clone()));
        assert_eq!(decompress(&hex(Z), partial), ("true".into(), 28, 522, text.clone()));
    }
    // Cut in half: nil and the region as it was; with ALLOW-PARTIAL, 0
    // bytes left and what came out, point kept in the buffer.
    let cut = &hex(GZ)[..19];
    assert_eq!(decompress(cut, false).0, "null");
    assert_eq!(decompress(cut, false).2, 21);
    let (result, point, size, decoded) = decompress(cut, true);
    assert_eq!((result.as_str(), point), ("0", size));
    assert!(text.starts_with(&decoded));
    // Not compressed: nil; with ALLOW-PARTIAL, 19 of 21 bytes left and the region empty.
    assert_eq!(decompress(b"not compressed at all", false), ("null".into(), 23, 23, "ABnot compressed at all".into()));
    assert_eq!(decompress(b"not compressed at all", true), ("19".into(), 2, 2, "AB".into()));
    // A wrong checksum: nil; with ALLOW-PARTIAL, the data, and the 4 bytes after the CRC left.
    assert_eq!(decompress(&hex(BAD_CRC), false).0, "null");
    assert_eq!(decompress(&hex(BAD_CRC), true), ("4".into(), 40, 522, text.clone()));
}

#[test]
fn decompressing_is_an_edit_that_text_not_bytes_refuses() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "e8.zlibAvailableP()");
    let gz: String = hex(GZ).iter().map(|&b| e8_core::coding::raw_byte_char(b)).collect();
    ed.window_buffer_mut().set_text(&gz);
    let end = ed.window_buffer().len();
    // Undone as one change, as Emacs's is.
    eval(&mut ed, &s, &format!("e8.zlibDecompressRegion(0, {end})"));
    assert_eq!(ed.window_buffer().len(), 520);
    ed.press("C-/").unwrap();
    assert_eq!(ed.window_buffer().text().to_string(), gz);
    // Text that is not bytes, as Emacs refuses a multibyte buffer: an
    // error, é from UTF-8 as well as →, though é's code is below 256.
    for text in ["→ not bytes", "é not bytes"] {
        ed.window_buffer_mut().set_text(text);
        assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => e8.zlibDecompressRegion(0, 5), { error: (e) => e.message })"), r#""The region holds characters that are not bytes""#);
    }
    // Outside the accessible part, and a read-only buffer, as Emacs: errors, bad data or not.
    ed.window_buffer_mut().set_text("junk data");
    assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => e8.zlibDecompressRegion(0, 500), { error: (e) => e.symbol })"), r#""args-out-of-range""#);
    assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => (e8.narrowToRegion(0, 4), e8.zlibDecompressRegion(0, 9)), { error: (e) => e.symbol })"), r#""args-out-of-range""#);
    eval(&mut ed, &s, "e8.widen()");
    ed.window_buffer_mut().read_only = true;
    assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => e8.zlibDecompressRegion(0, 9), { error: (e) => e.symbol })"), r#""buffer-read-only""#);
}

#[test]
fn symbol_file_names_the_file_that_defined_it() {
    let (mut ed, s) = setup();
    // Each package its own file, those a package imports included, as each
    // Lisp file has its load-history entry: org.ts imports org-list.ts.
    assert_eq!(eval(&mut ed, &s, r#"e8.symbolFile("org-set-property")"#), r#""packages/org-list.ts""#);
    // A package required while a file loads: its own file, not the requirer's.
    let req = tempfile::tempdir().unwrap();
    let requirer = req.path().join("requirer.ts");
    std::fs::write(&requirer, r#"e8.require("ert");"#).unwrap();
    s.load_file(&mut ed, &requirer).unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.symbolFile("ert")"#), r#""packages/ert.ts""#);
    // A package E8 ships: its file in E8's source.
    assert_eq!(
        eval(&mut ed, &s, r#"[e8.symbolFile("mouse-set-point"), e8.symbolFile("only-global-abbrevs", "defvar"), e8.symbolFile("ansi-color-red", "defface")]"#),
        r#"["packages/mouse.ts","packages/abbrev.ts","packages/ansi-color.ts"]"#
    );
    // What E8 defines itself has none, as Emacs's C has none.
    assert_eq!(eval(&mut ed, &s, r#"[e8.symbolFile("forward-char") ?? null, e8.symbolFile("visible-bell") ?? null]"#), "[null,null]");
    // A file of one's own: its absolute name, by kind.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("mine.ts");
    std::fs::write(
        &file,
        r#"e8.defun("my-fn", () => 1);
        e8.defineVariable({ name: "my-var", doc: "Mine.", value: 1 });
        e8.defineFace({ name: "my-face", doc: "Mine." });
        e8.defineCommand({ name: "my-command", run: () => {} });"#,
    )
    .unwrap();
    s.load_file(&mut ed, &file).unwrap();
    let path = file.canonicalize().unwrap().display().to_string();
    let got = eval(&mut ed, &s, r#"["my-fn", "my-var", "my-face", "my-command"].map((n) => [e8.symbolFile(n), e8.symbolFile(n, "defun") ?? null, e8.symbolFile(n, "defvar") ?? null, e8.symbolFile(n, "defface") ?? null])"#);
    let p = format!("{path:?}");
    assert_eq!(got.replace(&p, "F").replace(&format!("{:?}", file.display().to_string()), "F"), "[[F,F,null,null],[F,null,F,null],[F,null,null,F],[F,F,null,null]]");
    // Defined again with no file, as at M-:, it keeps its file, as load-history does.
    assert_eq!(
        eval(&mut ed, &s, r#"(e8.defun("my-fn", () => 2), e8.defineCommand({ name: "my-command", run: () => {} }), [e8.symbolFile("my-fn", "defun"), e8.symbolFile("my-command")])"#).replace(&p, "F").replace(&format!("{:?}", file.display().to_string()), "F"),
        "[F,F]"
    );
    // An alias records the file that made it.
    let other = dir.path().join("other.ts");
    std::fs::write(&other, r#"e8.defalias("my-alias", "car"); e8.defalias("my-fn", "cdr");"#).unwrap();
    s.load_file(&mut ed, &other).unwrap();
    let got = eval(&mut ed, &s, r#"[e8.symbolFile("my-alias"), e8.symbolFile("my-fn")]"#);
    assert!(got.matches("other.ts").count() == 2, "{got}");
    // Any other kind, as a symbol property Emacs records, has none.
    assert_eq!(eval(&mut ed, &s, r#"e8.symbolFile("my-var", "cl-defmethod") ?? null"#), "null");
}

#[test]
fn secure_hash_and_md5_as_emacs_hashes() {
    let (mut ed, s) = setup();
    // As Emacs 30 gives them.
    assert_eq!(
        eval(&mut ed, &s, r#"[e8.secureHash("sha1", "localhost:443"), e8.md5("héllo"), e8.secureHash("sha1", "hello world", 6, 11), e8.secureHash("sha256", "abc", null, null, true).length]"#),
        r#"["86e4b43bd38012c7b5666e53e158af0eb27d493f","be50e8478cf24ff3595bc7307fb91b50","7c211433f02071597741e6ff5a8ea34789abbf43",32]"#
    );
    assert_eq!(
        eval(&mut ed, &s, r#"e8.secureHashAlgorithms().map((a) => e8.secureHash(a, "abc"))"#),
        r#"["900150983cd24fb0d6963f7d28e17f72","a9993e364706816aba3e25717850c26c9cd0d89d","23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7","ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"]"#
    );
    // A buffer's text, from 1 to 3 here, 2 to 4 in Emacs's counting.
    ed.window_buffer_mut().set_text("abcdef");
    assert_eq!(eval(&mut ed, &s, r#"e8.secureHash("md5", e8.currentBuffer(), 1, 3)"#), r#""5360af35bde9ebd8f01f492dc059593c""#);
    assert_eq!(eval(&mut ed, &s, r#"e8.conditionCase(() => e8.secureHash("sha3", "x"), { error: (e) => e.message })"#), r#""Invalid algorithm arg: sha3""#);
}
