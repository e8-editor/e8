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

/// How long each algorithm's hash is, in bytes.
pub fn length(algorithm: &str) -> Option<usize> {
    Some(match algorithm {
        "md5" => 16,
        "sha1" => 20,
        "sha224" => 28,
        "sha256" => 32,
        "sha384" => 48,
        "sha512" => 64,
        _ => return None,
    })
}

/// GnuTLS's name for an algorithm, as `gnutls-digests` and `gnutls-macs`
/// list them: SHA1, SHA256 and the rest in capitals.
pub fn gnutls_name(algorithm: &str) -> String {
    algorithm.to_uppercase()
}

/// The algorithm a GnuTLS name stands for, as `gnutls-hash-mac` takes it.
pub fn by_gnutls_name(name: &str) -> Option<&'static str> {
    ALGORITHMS.iter().copied().find(|a| a.eq_ignore_ascii_case(name))
}

/// The MAC of `bytes` with `key`, as `gnutls-hash-mac`: HMAC on the hash
/// `algorithm` names, as GnuTLS's MACs of those names are.
pub fn mac(algorithm: &str, key: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    use hmac::Mac;
    /// HMAC on one hash, as the generic bounds are more trouble than the match.
    macro_rules! hmac_of {
        ($d:ty) => {{
            let mut mac = <hmac::Hmac<$d>>::new_from_slice(key).expect("HMAC takes a key of any length");
            mac.update(bytes);
            mac.finalize().into_bytes().to_vec()
        }};
    }
    Ok(match algorithm {
        "md5" => hmac_of!(md5::Md5),
        "sha1" => hmac_of!(sha1::Sha1),
        "sha224" => hmac_of!(sha2::Sha224),
        "sha256" => hmac_of!(sha2::Sha256),
        "sha384" => hmac_of!(sha2::Sha384),
        "sha512" => hmac_of!(sha2::Sha512),
        other => return Err(Error::new(format!("GnuTLS MAC is invalid or not found: {other}"))),
    })
}

/// Bytes in lower-case hex, as `secure-hash` gives them unless BINARY.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
