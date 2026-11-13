//! TLS where there is none, as in a browser, which has no sockets: the
//! same names as tls.rs, connections passed through as they are, and
//! `gnutls-boot` an error, as in an Emacs built without GnuTLS ([ADR 0075]).
//!
//! [ADR 0075]: ../../../docs/adr/0075-compression-and-tls-as-emacs-has-them.md

use std::io::{Read, Write};

use crate::error::{Error, Result};

pub mod stage {
    pub const EMPTY: u8 = 0;
    pub const DEINIT: u8 = 3;
    pub const HANDSHAKE_TRIED: u8 = 8;
    pub const READY: u8 = 9;
}

#[derive(Clone, Debug, Default)]
pub struct TlsParams {
    pub hostname: String,
    pub trustfiles: Vec<String>,
    pub keylist: Vec<(String, String)>,
    pub verify_chain: bool,
    pub verify_hostname: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PeerStatus {
    pub warnings: Vec<&'static str>,
    pub certificates: Vec<CertificateDetails>,
    pub protocol: String,
    pub key_exchange: String,
    pub cipher: String,
    pub mac: String,
    pub safe_renegotiation: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CertificateDetails {
    pub version: u32,
    pub serial_number: String,
    pub issuer: String,
    pub valid_from: String,
    pub valid_to: String,
    pub subject: String,
    pub public_key_algorithm: String,
    pub certificate_security_level: String,
    pub signature_algorithm: String,
    pub public_key_id: String,
    pub public_key_id_sha256: String,
    pub certificate_id: String,
    pub pem: String,
}

#[derive(Default)]
pub(crate) struct Shared;

// The same fields as tls.rs's, which process.rs fills; `shared` is unused here.
#[allow(dead_code)]
pub(crate) struct Reader<R> {
    pub(crate) raw: R,
    pub(crate) shared: std::sync::Arc<Shared>,
}

/// A connection with no TLS writes its own socket, so the writing thread
/// tls.rs needs is not started and this only carries what is sent.
pub(crate) struct Writer<W> {
    pub(crate) raw: W,
    #[allow(dead_code)]
    pub(crate) shared: std::sync::Arc<Shared>,
}

impl<R: Read> Read for Reader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.raw.read(buf)
    }
}

impl<W: Write> Write for Writer<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.raw.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.raw.flush()
    }
}

impl Shared {
    pub(crate) fn start(&self, _params: &TlsParams) -> Result<()> {
        Err(Error::new("gnutls-boot: this E8 has no TLS"))
    }

    pub(crate) fn died(&self, _why: &str) {}

    pub(crate) fn wait(&self, _quit: impl FnMut() -> Result<()>) -> Result<std::result::Result<(), String>> {
        Ok(Err("this E8 has no TLS".into()))
    }

    pub(crate) fn stage(&self) -> u8 {
        stage::EMPTY
    }

    pub(crate) fn bye(&self) -> std::io::Result<bool> {
        Ok(false)
    }

    pub(crate) fn deinit(&self) {}

    pub(crate) fn peer_status(&self) -> Option<PeerStatus> {
        None
    }
}

pub fn describe_warning(_warning: &str) -> Option<&'static str> {
    None
}

pub fn format_certificate(_pem: &str) -> Result<String> {
    Err(Error::new("gnutls-format-certificate: this E8 has no TLS"))
}

pub fn certificate_details(_der: &[u8]) -> Option<CertificateDetails> {
    None
}

pub fn capabilities() -> Vec<&'static str> {
    Vec::new()
}

pub struct Cipher {
    pub name: &'static str,
    pub id: u32,
    pub tag_size: usize,
    pub block_size: usize,
    pub key_size: usize,
    pub iv_size: usize,
}

pub fn ciphers() -> Vec<Cipher> {
    Vec::new()
}

pub fn symmetric(_encrypting: bool, cipher: &str, _key: &[u8], _iv: &[u8], _input: &[u8], _aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    Err(Error::new(format!("GnuTLS cipher is invalid or not found: {cipher}")))
}
