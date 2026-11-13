//! Hashes of text, as Emacs's fns.c gives them to `secure-hash` and `md5`
//! ([ADR 0075]): the text's bytes, raw bytes as themselves and anything
//! else as UTF-8, hashed with MD5 or SHA-1 and SHA-2, in hex or as bytes.
//!
//! [ADR 0075]: ../../../docs/adr/0075-compression-and-tls-as-emacs-has-them.md

use sha2::Digest;

use crate::error::{Error, Result};

/// The algorithms `secure-hash` knows, as `secure-hash-algorithms` lists them.
pub const ALGORITHMS: &[&str] = &["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];

/// The hash of `bytes` by `algorithm`, as `secure-hash` computes it.
pub fn digest(algorithm: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    Ok(match algorithm {
        "md5" => md5::Md5::digest(bytes).to_vec(),
        "sha1" => sha1::Sha1::digest(bytes).to_vec(),
        "sha224" => sha2::Sha224::digest(bytes).to_vec(),
        "sha256" => sha2::Sha256::digest(bytes).to_vec(),
        "sha384" => sha2::Sha384::digest(bytes).to_vec(),
        "sha512" => sha2::Sha512::digest(bytes).to_vec(),
        other => return Err(Error::new(format!("Invalid algorithm arg: {other}"))),
    })
}

/// Text as the bytes hashing reads, as fns.c's extract_data_from_object
/// encodes a multibyte string: raw bytes as themselves, the rest as UTF-8.
pub fn text_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for c in text.chars() {
        match crate::coding::char_raw_byte(c) {
            Some(b) => out.push(b),
            None => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out
}

/// Bytes in lower-case hex, as `secure-hash` gives them unless BINARY.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
