//! Org Crypt (org-crypt.ts) on EasyPG (epg.ts), with a stand-in for GnuPG
//! (tests/data/fake_gpg.py) first on exec-path: real gpg is not run. The
//! stand-in "encrypts" as base64 in PGP armor and records what it was run
//! with, so the tests look at the arguments epg passes and at how the
//! replies are handled. Each expected buffer is what Org 9.7 in Emacs 30.2
//! makes of the same text with epg-encrypt-string and epg-decrypt-string
//! stubbed to write and read the same armor.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;
use std::path::{Path, PathBuf};

struct Crypt {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
}

/// An editor with the stand-in gpg alone on exec-path and org-crypt
/// loaded, its buffer in Org mode holding `text`; None without python3.
fn crypt(text: &str) -> Option<Crypt> {
    if std::process::Command::new("python3").arg("-V").output().is_err() {
        return None;
    }
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let program = dir.path().join("gpg");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_gpg.py"), &program).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let mut t = Crypt { ed, s, dir };
    let path = t.dir.path().display().to_string();
    t.eval(&format!("e8.setVariable('exec-path', [{path:?}])"));
    t.eval("e8.require('org-crypt')");
    t.ed.window_buffer_mut().set_text(text);
    t.ed.call("org-mode", vec![]).unwrap();
    Some(t)
}

impl Crypt {
    fn eval(&mut self, expression: &str) -> String {
        self.s.eval_expression(&mut self.ed, expression).unwrap()
    }

    fn text(&self) -> String {
        let b = self.ed.window_buffer();
        b.slice(0..b.len())
    }

    /// What the stand-in was run with, a run to an entry, with --use-agent
    /// taken out, which a GPG_AGENT_INFO in the tests' environment adds.
    fn runs(&self) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(self.dir.path().join("gpg.log")).unwrap_or_default();
        log.lines()
            .map(|l| serde_json::from_str::<Vec<String>>(l).unwrap().into_iter().filter(|a| a != "--use-agent").collect())
            .collect()
    }

    /// The runs that encrypted.
    fn encryptions(&self) -> usize {
        self.runs().iter().filter(|r| r.iter().any(|a| a == "--symmetric" || a == "--encrypt")).count()
    }

    fn passphrases(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("passphrases.log")).unwrap_or_default()
    }

    fn clear_log(&self) {
        let _ = std::fs::remove_file(self.dir.path().join("gpg.log"));
    }

    fn set(&mut self, name: &str, value: Value) {
        self.ed.set_variable(name, value);
    }

    fn goto_line(&mut self, line: usize) {
        self.eval(&format!("e8.gotoChar(e8.lineStart({}))", line - 1));
    }
}

const DOC: &str = "#+TITLE: T
* Plain
text
* Secret :crypt:
:PROPERTIES:
:ID: x
:END:

Body line 1
 indented line é
** Child
child body

* Next
SCHEDULED: <2026-11-28 Sat>
* Planning secret :crypt:
SCHEDULED: <2026-11-28 Sat>
:LOGBOOK:
- Note taken
:END:
Hidden body
* Empty secret :crypt:
* Last :crypt:
final";

const DOC_ENCRYPTED: &str = "#+TITLE: T
* Plain
text
* Secret :crypt:
:PROPERTIES:
:ID: x
:END:

-----BEGIN PGP MESSAGE-----

Qm9keSBsaW5lIDEKIGluZGVudGVkIGxpbmUgw6kKKiogQ2hpbGQKY2hpbGQgYm9k
eQo=
-----END PGP MESSAGE-----

* Next
SCHEDULED: <2026-11-28 Sat>
* Planning secret :crypt:
SCHEDULED: <2026-11-28 Sat>
:LOGBOOK:
- Note taken
:END:
-----BEGIN PGP MESSAGE-----

SGlkZGVuIGJvZHkK
-----END PGP MESSAGE-----
* Empty secret :crypt:
-----BEGIN PGP MESSAGE-----


-----END PGP MESSAGE-----
* Last :crypt:
-----BEGIN PGP MESSAGE-----

ZmluYWw=
-----END PGP MESSAGE-----
";

/// Each tagged entry is encrypted after its planning line, property drawer
/// and logbook, and decrypted back; saved again unchanged, only the empty
/// entry, whose decrypted text holds nothing to remember its encryption
/// by, runs gpg again, and a changed entry is encrypted anew.
#[test]
fn entries_are_encrypted_decrypted_and_not_encrypted_again_unchanged() {
    let Some(mut t) = crypt(DOC) else { return };
    t.set("org-crypt-key", Value::Null);
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), DOC_ENCRYPTED);
    assert_eq!(t.encryptions(), 4);
    t.ed.call("org-decrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), DOC);
    t.clear_log();
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), DOC_ENCRYPTED);
    assert_eq!(t.encryptions(), 1);
    t.ed.call("org-decrypt-entries", vec![]).unwrap();
    t.eval("e8.gotoChar(0), e8.reSearchForward('Hidden body'), e8.insert(' changed')");
    t.clear_log();
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    assert_eq!(t.encryptions(), 2);
    assert_eq!(t.text(), DOC_ENCRYPTED.replace("SGlkZGVuIGJvZHkK", "SGlkZGVuIGJvZHkgY2hhbmdlZAo="));
}

/// gpg is found and run as epg runs it: its configuration read with
/// --list-config, then each operation with its status on standard output,
/// its commands on standard input, armored text, and the output in a file.
#[test]
fn gpg_is_run_with_the_arguments_epg_gives_it() {
    let Some(mut t) = crypt("* S :crypt:\nsecret text\n") else { return };
    t.set("org-crypt-key", Value::Null);
    t.ed.call("org-encrypt-entry", vec![]).unwrap();
    t.ed.call("org-decrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), "* S :crypt:\nsecret text\n");
    let runs = t.runs();
    assert_eq!(runs.len(), 3, "{runs:?}");
    assert_eq!(runs[0], ["--with-colons", "--list-config"]);
    let common = ["--no-tty", "--status-fd", "1", "--yes", "--command-fd", "0", "--armor", "--textmode", "--output"];
    assert_eq!(runs[1][..9], common);
    assert!(runs[1][9].contains("epg-output"), "{:?}", runs[1]);
    assert_eq!(runs[1][10..], ["--symmetric"]);
    assert_eq!(runs[2][..9], common);
    assert!(runs[2][9].contains("epg-output"), "{:?}", runs[2]);
    assert_eq!(runs[2][10..12], ["--decrypt", "--"]);
    assert!(runs[2][12].contains("epg-input"), "{:?}", runs[2]);
    // The temporary files are gone.
    for file in [&runs[1][9], &runs[2][9], &runs[2][12]] {
        assert!(!Path::new(file).exists(), "{file}");
    }
}

/// With epg-pinentry-mode loopback, gpg asks E8 for the passphrase, read
/// with read-passwd, twice when encrypting; a wrong one fails decryption
/// with epg's error and leaves the entry encrypted.
#[test]
fn passphrases_are_read_in_the_minibuffer_with_loopback() {
    let Some(mut t) = crypt("* S :crypt:\nsecret text\n") else { return };
    t.set("org-crypt-key", Value::Null);
    t.set("epg-pinentry-mode", Value::Symbol("loopback".into()));
    t.ed.press("M-x o r g - e n c r y p t - e n t r y RET s e c r e t RET s e c r e t RET").unwrap();
    assert_eq!(t.text(), "* S :crypt:\n-----BEGIN PGP MESSAGE-----\n\nc2VjcmV0IHRleHQK\n-----END PGP MESSAGE-----\n");
    assert_eq!(t.passphrases(), "secret\n");
    let runs = t.runs();
    let encrypt = runs.iter().find(|r| r.iter().any(|a| a == "--symmetric")).unwrap();
    assert_eq!(encrypt[encrypt.len() - 3..], ["--pinentry-mode", "loopback", "--symmetric"]);
    t.ed.press("M-x o r g - d e c r y p t - e n t r y RET w r o n g RET").unwrap();
    assert_eq!(t.ed.messages().last().map(String::as_str), Some("GPG error: \"Decryption failed\", \"\""));
    assert!(t.text().contains("-----BEGIN PGP MESSAGE-----"));
    t.ed.press("M-x o r g - d e c r y p t - e n t r y RET s e c r e t RET").unwrap();
    assert_eq!(t.text(), "* S :crypt:\nsecret text\n");
}

/// org-crypt-key and the CRYPTKEY property name the keys, looked up with
/// gpg --list-keys and encrypted to by their primary key's id; "nil", or a
/// name no key matches, falls back to symmetric encryption, saying so.
#[test]
fn keys_come_from_org_crypt_key_and_the_cryptkey_property() {
    let Some(mut t) = crypt(
        "* A :crypt:\na\n* B :crypt:\n:PROPERTIES:\n:CRYPTKEY: bob\n:END:\nb\n* C :crypt:\n:PROPERTIES:\n:CRYPTKEY: nil\n:END:\nc\n",
    ) else {
        return;
    };
    t.set("org-crypt-key", Value::Str("alice".into()));
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    let runs = t.runs();
    let listed: Vec<&str> = runs
        .iter()
        .filter_map(|r| r.iter().position(|a| a == "--list-keys").map(|i| r[i + 1].as_str()))
        .collect();
    assert_eq!(listed, ["alice", "bob", ""]);
    let encryptions: Vec<String> = runs
        .iter()
        .filter(|r| r.iter().any(|a| a == "--symmetric" || a == "--encrypt"))
        .map(|r| r[10..].join(" "))
        .collect();
    assert_eq!(encryptions, ["--encrypt -r 0123456789ABCDEF", "--encrypt -r ABCDABCDABCDABCD", "--symmetric"]);
    assert!(t.ed.messages().iter().any(|m| m == "No crypt key set, using symmetric encryption."));
    assert!(t.text().starts_with("* A :crypt:\n-----BEGIN PGP MESSAGE-----\nComment: to 0123456789ABCDEF\n\nYQo=\n"), "{}", t.text());
    // Decrypting reads the keys again, for the text to remember.
    t.clear_log();
    t.ed.call("org-decrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), "* A :crypt:\na\n* B :crypt:\n:PROPERTIES:\n:CRYPTKEY: bob\n:END:\nb\n* C :crypt:\n:PROPERTIES:\n:CRYPTKEY: nil\n:END:\nc\n");
    // Encrypted again unchanged, A and B run gpg again, as in Emacs:
    // org-decrypt-entry looks up the keys after taking out the encrypted
    // text with the newline before it, so A's heading line runs into B's
    // and A seems to have B's drawer, and B's drawer, its :END: running
    // into C's heading, seems to be none; A remembers B's key and B
    // org-crypt-key's. C, symmetric, is not encrypted again.
    t.clear_log();
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    let again: Vec<String> = t
        .runs()
        .iter()
        .filter(|r| r.iter().any(|a| a == "--symmetric" || a == "--encrypt"))
        .map(|r| r[10..].join(" "))
        .collect();
    assert_eq!(again, ["--encrypt -r 0123456789ABCDEF", "--encrypt -r ABCDABCDABCDABCD"]);
}

/// When gpg refuses a key, the entry's text goes back, and the error is
/// epg's, as error-message-string words it.
#[test]
fn a_failed_encryption_puts_the_text_back() {
    let text = "* Old :crypt:\n:PROPERTIES:\n:CRYPTKEY: expired\n:END:\nkept\n";
    let Some(mut t) = crypt(text) else { return };
    let err = t.ed.call("org-encrypt-entries", vec![]).unwrap_err().to_string();
    assert_eq!(err, "GPG error: \"Encrypt failed\", \"Unusable public key: EEEEEEEEEEEEEEEE (key expired); Exit\"");
    assert_eq!(t.text(), text);
}

/// Text decrypted with headings at the entry's level or above is put
/// below it, and the encrypted text's indentation is ignored.
#[test]
fn decrypted_headings_go_below_the_entry() {
    let armor = "   -----BEGIN PGP MESSAGE-----\n\n   KiBPbmUKeAoqKiBUd28KeQo=\n   -----END PGP MESSAGE-----\n";
    let Some(mut t) = crypt(&format!("* Top\n** Sec :crypt:\n{armor}** After\n")) else { return };
    t.goto_line(2);
    t.ed.call("org-decrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), "* Top\n** Sec :crypt:\n*** One\nx\n**** Two\ny\n** After\n");
}

/// A PGP message's first line without its last, before the next heading,
/// is not an encrypted entry.
#[test]
fn a_message_without_its_end_is_not_encrypted() {
    let text = "* H :crypt:\n-----BEGIN PGP MESSAGE-----\nabc\n* Next\n";
    let Some(mut t) = crypt(text) else { return };
    assert_eq!(t.eval("e8.funcall('org-at-encrypted-entry-p')"), "null");
    t.ed.call("org-decrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), text);
    assert_eq!(t.runs().len(), 0);
}

/// An entry with only blank lines after its drawer encrypts those lines,
/// as delete-and-extract-region takes its ends in either order.
#[test]
fn blank_lines_after_the_drawer_are_encrypted() {
    let text = "* H :crypt:\n:PROPERTIES:\n:A: 1\n:END:\n\n\n* Next\n";
    let Some(mut t) = crypt(text) else { return };
    t.set("org-crypt-key", Value::Null);
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), "* H :crypt:\n:PROPERTIES:\n:A: 1\n:END:\n-----BEGIN PGP MESSAGE-----\n\nCgo=\n-----END PGP MESSAGE-----\n* Next\n");
    t.ed.call("org-decrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), text);
}

/// A tagged heading's tagged subheading is encrypted with it, and shows
/// again, decrypted, when it is.
#[test]
fn a_tagged_subheading_goes_with_its_parent() {
    let text = "* Up\nup\n** Down :crypt:\ndown\n*** Deeper :crypt:\ndeeper\n** Side\nside\n";
    let Some(mut t) = crypt(text) else { return };
    t.set("org-crypt-key", Value::Null);
    t.ed.call("org-encrypt-entries", vec![]).unwrap();
    assert_eq!(
        t.text(),
        "* Up\nup\n** Down :crypt:\n-----BEGIN PGP MESSAGE-----\n\nZG93bgoqKiogRGVlcGVyIDpjcnlwdDoKZGVlcGVyCg==\n-----END PGP MESSAGE-----\n** Side\nside\n"
    );
    t.ed.call("org-decrypt-entries", vec![]).unwrap();
    assert_eq!(t.text(), text);
}

/// A file visited with org-crypt-use-before-save-magic on is saved with
/// its tagged entries encrypted, which stay encrypted in the buffer.
#[test]
fn saving_encrypts_with_the_before_save_magic() {
    let Some(mut t) = crypt("") else { return };
    let path: PathBuf = t.dir.path().join("diary.org");
    std::fs::write(&path, "* Diary :crypt:\nDear diary\n* Open\nopen\n").unwrap();
    t.set("org-crypt-key", Value::Null);
    t.eval("e8.funcall('org-crypt-use-before-save-magic')");
    t.ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    t.eval("e8.gotoChar(e8.pointMax()), e8.insert('more\\n')");
    t.ed.call("save-buffer", vec![]).unwrap();
    let expected = "* Diary :crypt:\n-----BEGIN PGP MESSAGE-----\n\nRGVhciBkaWFyeQo=\n-----END PGP MESSAGE-----\n* Open\nopen\nmore\n";
    assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
    assert_eq!(t.text(), expected);
}

/// Decrypting in a buffer that auto-saves turns auto-saving off, with
/// org-crypt-disable-auto-save t, or with encrypt has the decrypted
/// entries encrypted again before each auto-save.
#[test]
fn auto_saving_is_turned_off_or_encrypts_first() {
    let Some(mut t) = crypt("") else { return };
    let path = t.dir.path().join("auto.org");
    let encrypted = "* S :crypt:\n-----BEGIN PGP MESSAGE-----\n\nc2VjcmV0Cg==\n-----END PGP MESSAGE-----\n";
    std::fs::write(&path, encrypted).unwrap();
    t.set("org-crypt-key", Value::Null);
    t.ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    assert_eq!(t.eval("e8.autoSaving()"), "true");
    t.set("org-crypt-disable-auto-save", Value::Bool(true));
    t.ed.call("org-decrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), "* S :crypt:\nsecret\n");
    assert_eq!(t.eval("e8.autoSaving()"), "false");
    assert!(t.ed.messages().iter().any(|m| m == &format!("org-decrypt: Disabling auto-save-mode for {}", path.display())));
    t.ed.call("org-encrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), encrypted);
    t.eval("e8.setAutoSave(true)");
    t.set("org-crypt-disable-auto-save", Value::Symbol("encrypt".into()));
    t.ed.call("org-decrypt-entry", vec![]).unwrap();
    assert_eq!(t.text(), "* S :crypt:\nsecret\n");
    assert!(t.ed.messages().iter().any(|m| m == "org-decrypt: Enabling re-encryption on auto-save."));
    t.ed.call("do-auto-save", vec![]).unwrap();
    assert_eq!(t.text(), encrypted);
    assert!(t.ed.messages().iter().any(|m| m == "org-crypt: Re-encrypting all decrypted entries due to auto-save."));
}
