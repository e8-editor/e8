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
    // Text that is not bytes, as Emacs refuses a multibyte buffer: an error.
    ed.window_buffer_mut().set_text("→ not bytes");
    assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => e8.zlibDecompressRegion(0, 5), { error: (e) => e.message })"), r#""The region holds characters that are not bytes""#);
    assert_eq!(eval(&mut ed, &s, "e8.conditionCase(() => e8.zlibDecompressRegion(0, 500), { error: (e) => e.symbol })"), r#""args-out-of-range""#);
}

#[test]
fn symbol_file_names_the_file_that_defined_it() {
    let (mut ed, s) = setup();
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
    // Defined again with no file, as at M-:, it has none.
    assert_eq!(eval(&mut ed, &s, r#"(e8.defun("my-fn", () => 2), e8.symbolFile("my-fn", "defun") ?? null)"#), "null");
    // Any other kind, as a symbol property Emacs records, has none.
    assert_eq!(eval(&mut ed, &s, r#"e8.symbolFile("my-var", "cl-defmethod") ?? null"#), "null");
}
