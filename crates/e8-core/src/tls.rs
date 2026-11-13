//! TLS on network processes, as Emacs's gnutls.c gives it ([ADR 0075]):
//! `gnutls-boot` makes a connection's traffic encrypted, at once or after
//! some plain text, as STARTTLS does, and `gnutls-peer-status` describes
//! the peer and what verifying it found. With rustls on ring.
//!
//! A connection's socket is read and written by threads of their own, as a
//! plain one's is; what TLS adds sits between them under a lock: the
//! reader feeds what arrives through it and passes on the plain text, the
//! writer encrypts what is sent. Nothing polls, and a connection can start
//! plain and become TLS.
//!
//! Verifying the peer records what is wrong rather than refusing it, as
//! GnuTLS does for Emacs, unless `:verify-error` asks for a refusal; what
//! to do about the rest is the caller's, as nsm.el decides in Emacs.
//!
//! [ADR 0075]: ../../../docs/adr/0075-compression-and-tls-as-emacs-has-them.md

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::error::{Error, Result};

/// How far a connection's TLS has come, as gnutls.c's init stages number
/// it: `gnutls-get-initstage` gives these.
pub mod stage {
    /// Nothing done, or a connection that is not TLS.
    pub const EMPTY: u8 = 0;
    /// What `gnutls-deinit` leaves, as Emacs's leaves GNUTLS_STAGE_INIT - 1.
    pub const DEINIT: u8 = 3;
    /// The handshake started.
    pub const HANDSHAKE_TRIED: u8 = 8;
    /// The handshake done.
    pub const READY: u8 = 9;
}

/// What `gnutls-boot` is given, as its PROPLIST.
#[derive(Clone, Debug, Default)]
pub struct TlsParams {
    /// Whom the certificate must name, and what is asked for by SNI.
    pub hostname: String,
    /// PEM files of authorities to trust as well as the system's.
    pub trustfiles: Vec<String>,
    /// Pairs of PEM key and certificate files to offer the peer.
    pub keylist: Vec<(String, String)>,
    /// What failing to verify refuses the connection: `:trustfiles` (the
    /// chain), `:hostname` (the name), or both, as `:verify-error` t.
    pub verify_chain: bool,
    pub verify_hostname: bool,
}

/// What verifying the peer found, as gnutls.c keeps its verification bits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Verification {
    /// GnuTLS's names for what is wrong with the chain, in the order
    /// gnutls-peer-status checks them.
    chain: Vec<&'static str>,
    no_host_match: bool,
    /// Why the handshake was refused, if verifying refused it.
    refusal: Option<String>,
}

/// A connection's TLS, between its socket and its process.
pub(crate) struct Shared {
    state: Mutex<State>,
    /// Signalled when the handshake ends, well or badly.
    changed: Condvar,
    /// Held while writing to the socket, so records from the reader's
    /// thread and the writer's go out whole and in order.
    writing: Mutex<()>,
}

#[derive(Default)]
struct State {
    tls: Option<Session>,
    stage: u8,
}

struct Session {
    conn: ClientConnection,
    verification: Arc<Mutex<Verification>>,
    /// Why the handshake failed, once it has.
    failed: Option<String>,
}

impl Default for Shared {
    fn default() -> Shared {
        Shared { state: Mutex::new(State::default()), changed: Condvar::new(), writing: Mutex::new(()) }
    }
}

/// Reads a connection, passing on plain text: as it comes before TLS
/// starts, and decrypted after.
pub(crate) struct Reader<R, W> {
    pub(crate) raw: R,
    /// Where records the reading answers go, as handshake messages.
    pub(crate) out: W,
    pub(crate) shared: Arc<Shared>,
}

/// Writes to a connection: as it is before TLS starts, encrypted after.
pub(crate) struct Writer<W> {
    pub(crate) raw: W,
    pub(crate) shared: Arc<Shared>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Writes what the session has to send, holding the write lock taken
    /// while `state` is still held, so the order is the session's.
    fn flush(&self, mut state: std::sync::MutexGuard<'_, State>, out: &mut impl Write) -> std::io::Result<()> {
        let mut records = Vec::new();
        if let Some(s) = state.tls.as_mut() {
            while s.conn.wants_write() {
                s.conn.write_tls(&mut records)?;
            }
        }
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        drop(state);
        if !records.is_empty() {
            out.write_all(&records)?;
            out.flush()?;
        }
        Ok(())
    }
}

impl<R: Read, W: Write> Read for Reader<R, W> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            {
                let mut state = self.shared.lock();
                if let Some(s) = state.tls.as_mut() {
                    match s.conn.reader().read(buf) {
                        Ok(n) => return Ok(n),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            let n = self.raw.read(buf)?;
            if n == 0 {
                self.shared.end_handshake(Some("The connection closed during the TLS handshake".into()));
                return Ok(0);
            }
            let mut state = self.shared.lock();
            let Some(s) = state.tls.as_mut() else { return Ok(n) };
            let mut taken = &buf[..n];
            while !taken.is_empty() {
                s.conn.read_tls(&mut taken)?;
                if let Err(e) = s.conn.process_new_packets() {
                    let refusal = s.verification.lock().unwrap_or_else(|e| e.into_inner()).refusal.clone();
                    let message = refusal.unwrap_or_else(|| format!("TLS handshake failed: {e}"));
                    let handshaking = s.conn.is_handshaking();
                    // The alert saying why goes to the peer.
                    let _ = self.shared.flush(state, &mut self.out);
                    if handshaking {
                        self.shared.end_handshake(Some(message.clone()));
                    }
                    return Err(std::io::Error::other(message));
                }
            }
            let ready = !s.conn.is_handshaking() && state.stage == stage::HANDSHAKE_TRIED;
            if ready {
                state.stage = stage::READY;
            }
            self.shared.flush(state, &mut self.out)?;
            if ready {
                self.shared.end_handshake(None);
            }
        }
    }
}

impl<W: Write> Write for Writer<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut state = self.shared.lock();
        match state.tls.as_mut() {
            None => {
                let _writing = self.shared.writing.lock().unwrap_or_else(|e| e.into_inner());
                drop(state);
                self.raw.write_all(buf)?;
            }
            // Before the handshake ends, rustls keeps it until it can go.
            Some(s) => {
                s.conn.writer().write_all(buf)?;
                self.shared.flush(state, &mut self.raw)?;
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.raw.flush()
    }
}

impl Shared {
    /// Notes how the handshake ended, waking whoever waits for it.
    fn end_handshake(&self, failure: Option<String>) {
        let mut state = self.lock();
        let trying = state.stage == stage::HANDSHAKE_TRIED;
        if let (Some(s), Some(failure)) = (state.tls.as_mut(), failure)
            && s.failed.is_none()
            && trying
        {
            s.failed = Some(failure);
        }
        self.changed.notify_all();
    }

    /// Starts TLS over the connection: sends the first handshake message
    /// to the peer through `out`, a handle on the socket.
    pub(crate) fn start(&self, params: &TlsParams, out: &mut impl Write) -> Result<()> {
        let verification = Arc::new(Mutex::new(Verification::default()));
        let config = client_config(params, verification.clone())?;
        let name = ServerName::try_from(params.hostname.clone()).map_err(|_| Error::new(format!("gnutls-boot: invalid :hostname parameter: {}", params.hostname)))?;
        let conn = ClientConnection::new(Arc::new(config), name).map_err(|e| Error::new(format!("gnutls-boot: {e}")))?;
        let mut state = self.lock();
        state.tls = Some(Session { conn, verification, failed: None });
        state.stage = stage::HANDSHAKE_TRIED;
        self.flush(state, out).map_err(|e| Error::new(format!("gnutls-boot: {e}")))
    }

    /// Waits for the handshake to end, checking `quit` meanwhile: what
    /// failed it, if anything did.
    pub(crate) fn wait(&self, mut quit: impl FnMut() -> Result<()>) -> Result<std::result::Result<(), String>> {
        let mut state = self.lock();
        loop {
            match &state.tls {
                Some(s) if s.failed.is_some() => return Ok(Err(s.failed.clone().unwrap_or_default())),
                Some(_) if state.stage == stage::READY => return Ok(Ok(())),
                Some(_) => {}
                None => return Ok(Err("TLS was taken down".into())),
            }
            state = self.changed.wait_timeout(state, std::time::Duration::from_millis(50)).unwrap_or_else(|e| e.into_inner()).0;
            drop(state);
            quit()?;
            state = self.lock();
        }
    }

    /// How far TLS has come, as `gnutls-get-initstage`.
    pub(crate) fn stage(&self) -> u8 {
        self.lock().stage
    }

    /// Sends the peer the alert that ends TLS, as `gnutls-bye`.
    pub(crate) fn bye(&self, out: &mut impl Write) -> std::io::Result<bool> {
        let mut state = self.lock();
        let Some(s) = state.tls.as_mut() else { return Ok(false) };
        s.conn.send_close_notify();
        self.flush(state, out)?;
        Ok(true)
    }

    /// Takes TLS down, as `gnutls-deinit`: what the connection carries
    /// from now on is as it comes.
    pub(crate) fn deinit(&self) {
        let mut state = self.lock();
        state.tls = None;
        state.stage = stage::DEINIT;
        self.changed.notify_all();
    }

    /// The peer and what verifying it found, once the handshake is done,
    /// as `gnutls-peer-status`.
    pub(crate) fn peer_status(&self) -> Option<PeerStatus> {
        let state = self.lock();
        let s = state.tls.as_ref().filter(|_| state.stage == stage::READY)?;
        let verification = s.verification.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let certificates: Vec<CertificateDetails> = s.conn.peer_certificates().unwrap_or_default().iter().filter_map(|c| certificate_details(c)).collect();
        let mut warnings: Vec<&'static str> = verification.chain.clone();
        if verification.no_host_match {
            warnings.push("no-host-match");
        }
        if certificates.first().is_some_and(|c| c.self_signed) {
            warnings.push("self-signed");
        }
        // Consed one at a time in gnutls.c, so the last checked comes first.
        warnings.reverse();
        let tls13 = s.conn.protocol_version() == Some(rustls::ProtocolVersion::TLSv1_3);
        let suite = s.conn.negotiated_cipher_suite().map(|c| format!("{:?}", c.suite())).unwrap_or_default();
        Some(PeerStatus {
            warnings,
            certificates,
            protocol: if tls13 { "TLS1.3" } else { "TLS1.2" }.into(),
            key_exchange: key_exchange(&suite, tls13),
            cipher: cipher(&suite),
            mac: mac(&suite),
            safe_renegotiation: (!tls13).then_some(true),
        })
    }
}

/// What `gnutls-peer-status` says of a peer.
#[derive(Clone, Debug, PartialEq)]
pub struct PeerStatus {
    /// GnuTLS's names for what is wrong, as `gnutls-peer-status-warning-describe` takes them.
    pub warnings: Vec<&'static str>,
    /// The peer's certificate first, then those that sign it.
    pub certificates: Vec<CertificateDetails>,
    pub protocol: String,
    pub key_exchange: String,
    pub cipher: String,
    pub mac: String,
    /// Before TLS 1.3, whether renegotiating is safe, which rustls refuses unsafe.
    pub safe_renegotiation: Option<bool>,
}

/// A certificate, as `gnutls-peer-status` describes each.
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
    self_signed: bool,
}

/// What each of `gnutls-peer-status`'s warnings means, as
/// `gnutls-peer-status-warning-describe` says it.
pub fn describe_warning(warning: &str) -> Option<&'static str> {
    Some(match warning {
        "invalid" => "certificate could not be verified",
        "revoked" => "certificate was revoked (CRL)",
        "self-signed" => "certificate signer was not found (self-signed)",
        "unknown-ca" => "the certificate was signed by an unknown and therefore untrusted authority",
        "not-ca" => "certificate signer is not a CA",
        "insecure" => "certificate was signed with an insecure algorithm",
        "not-activated" => "certificate is not yet activated",
        "expired" => "certificate has expired",
        "no-host-match" => "certificate host does not match hostname",
        "signature-failure" => "certificate signature could not be verified",
        "revocation-data-superseded" => "certificate revocation data are old and have been superseded",
        "revocation-data-issued-in-future" => "certificate revocation data have a future issue date",
        "signer-constraints-failure" => "certificate signer constraints were violated",
        "purpose-mismatch" => "certificate does not match the intended purpose",
        "missing-ocsp-status" => "certificate requires the server to send a OCSP certificate status, but no status was received",
        "invalid-ocsp-status" => "the received OCSP certificate status is invalid",
        _ => return None,
    })
}

/// Where systems keep their trusted authorities as PEM, as gnutls.el's
/// `gnutls-trustfiles` lists them: macOS's is the last.
const BUNDLES: &[&str] = &[
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/usr/ssl/certs/ca-bundle.crt",
    "/usr/local/share/certs/ca-root-nss.crt",
    "/etc/ssl/cert.pem",
];

/// The system's trusted authorities, read once: `SSL_CERT_FILE`, else the
/// first bundle there is, else the platform's own store. Reading macOS's
/// keychains takes seconds where its bundle takes a moment, so the bundle
/// comes first, as gnutls.el gives GnuTLS.
fn system_certificates() -> &'static [CertificateDer<'static>] {
    static CERTS: std::sync::OnceLock<Vec<CertificateDer<'static>>> = std::sync::OnceLock::new();
    CERTS.get_or_init(|| {
        let from_env = std::env::var("SSL_CERT_FILE").ok();
        for file in from_env.iter().map(String::as_str).chain(BUNDLES.iter().copied()) {
            if let Ok(certs) = CertificateDer::pem_file_iter(file) {
                let certs: Vec<_> = certs.filter_map(|c| c.ok()).collect();
                if !certs.is_empty() {
                    return certs;
                }
            }
        }
        rustls_native_certs::load_native_certs().certs
    })
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The client's configuration: the system's authorities and the trust
/// files', the verifier that records rather than refuses, and any key.
fn client_config(params: &TlsParams, verification: Arc<Mutex<Verification>>) -> Result<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(system_certificates().iter().cloned());
    for file in &params.trustfiles {
        let certs = CertificateDer::pem_file_iter(file).map_err(|e| Error::new(format!("gnutls-boot: {file}: {e}")))?;
        roots.add_parsable_certificates(certs.filter_map(|c| c.ok()));
    }
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
        .build()
        .map_err(|e| Error::new(format!("gnutls-boot: {e}")))?;
    let verifier = Recording { inner, verification, verify_chain: params.verify_chain, verify_hostname: params.verify_hostname, hostname: params.hostname.clone() };
    let builder = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::new(format!("gnutls-boot: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier));
    Ok(match params.keylist.first() {
        None => builder.with_no_client_auth(),
        Some((key, cert)) => {
            let key = PrivateKeyDer::from_pem_file(key).map_err(|e| Error::new(format!("gnutls-boot: {key}: {e}")))?;
            let certs = CertificateDer::pem_file_iter(cert)
                .map_err(|e| Error::new(format!("gnutls-boot: {cert}: {e}")))?
                .filter_map(|c| c.ok())
                .collect();
            builder.with_client_auth_cert(certs, key).map_err(|e| Error::new(format!("gnutls-boot: {e}")))?
        }
    })
}

/// Verifies the peer as the web's rules say, recording what is wrong and
/// refusing only what `:verify-error` asks it to, as gnutls.c does. The
/// handshake's own signatures are always checked.
#[derive(Debug)]
struct Recording {
    inner: Arc<WebPkiServerVerifier>,
    verification: Arc<Mutex<Verification>>,
    verify_chain: bool,
    verify_hostname: bool,
    hostname: String,
}

impl ServerCertVerifier for Recording {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let mut found = Verification::default();
        match self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now) {
            Ok(_) => {}
            Err(rustls::Error::InvalidCertificate(e)) => {
                let name_only = matches!(e, CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. });
                if !name_only {
                    found.chain = chain_warnings(&e);
                }
            }
            Err(_) => found.chain = vec!["invalid"],
        }
        // The name, checked on its own, as gnutls_x509_crt_check_hostname is.
        let matches = webpki::EndEntityCert::try_from(end_entity).is_ok_and(|cert| cert.verify_is_valid_for_subject_name(server_name).is_ok());
        found.no_host_match = !matches;
        if self.verify_chain && !found.chain.is_empty() {
            found.refusal = Some(format!("Certificate validation failed {}, verification code {}", self.hostname, found.chain.join(", ")));
        } else if self.verify_hostname && found.no_host_match {
            found.refusal = Some(format!("The x509 certificate does not match \"{}\"", self.hostname));
        }
        let refused = found.refusal.is_some();
        *self.verification.lock().unwrap_or_else(|e| e.into_inner()) = found;
        if refused {
            return Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// GnuTLS's warnings for what is wrong with a chain, in the order
/// gnutls-peer-status checks them: invalid always, then the reason.
fn chain_warnings(e: &CertificateError) -> Vec<&'static str> {
    let reason = match e {
        CertificateError::Revoked => Some("revoked"),
        CertificateError::UnknownIssuer => Some("unknown-ca"),
        CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => Some("not-activated"),
        CertificateError::Expired | CertificateError::ExpiredContext { .. } => Some("expired"),
        CertificateError::BadSignature => Some("signature-failure"),
        CertificateError::InvalidPurpose | CertificateError::InvalidPurposeContext { .. } => Some("purpose-mismatch"),
        _ => None,
    };
    std::iter::once("invalid").chain(reason).collect()
}

/// GnuTLS's name for the key exchange: in TLS 1.3, ECDHE-RSA for an
/// elliptic curve group whatever the key, as gnutls_kx_get gives it.
fn key_exchange(suite: &str, tls13: bool) -> String {
    if tls13 {
        return "ECDHE-RSA".into();
    }
    if suite.contains("ECDHE_ECDSA") { "ECDHE-ECDSA" } else { "ECDHE-RSA" }.into()
}

/// GnuTLS's name for the cipher, from rustls's suite.
fn cipher(suite: &str) -> String {
    if suite.contains("AES_256_GCM") {
        "AES-256-GCM"
    } else if suite.contains("AES_128_GCM") {
        "AES-128-GCM"
    } else if suite.contains("CHACHA20_POLY1305") {
        "CHACHA20-POLY1305"
    } else {
        "UNKNOWN"
    }
    .into()
}

/// GnuTLS's name for the MAC: AEAD for every suite rustls offers.
fn mac(suite: &str) -> String {
    let _ = suite;
    "AEAD".into()
}

/// Bytes as GnuTLS writes them: two hex digits each, colons between.
fn hex(prefix: &str, bytes: &[u8]) -> String {
    prefix.to_string() + &bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

fn digest(algorithm: &'static ring::digest::Algorithm, bytes: &[u8]) -> Vec<u8> {
    ring::digest::digest(algorithm, bytes).as_ref().to_vec()
}

/// A distinguished name as GnuTLS writes it: its parts in the
/// certificate's order, commas between, as `C=US,O=Example,CN=host`.
fn distinguished_name(name: &x509_parser::x509::X509Name<'_>) -> String {
    let mut parts = Vec::new();
    for rdn in name.iter() {
        for attr in rdn.iter() {
            let key = x509_parser::objects::oid2abbrev(attr.attr_type(), x509_parser::objects::oid_registry())
                .map(str::to_string)
                .unwrap_or_else(|_| attr.attr_type().to_id_string());
            let value = attr.as_str().map(str::to_string).unwrap_or_else(|_| format!("#{}", attr.attr_value().data.iter().map(|b| format!("{b:02x}")).collect::<String>()));
            // RFC 4514's escapes, as GnuTLS writes them.
            let value = value.replace('\\', "\\\\").replace(',', "\\,").replace('+', "\\+").replace('"', "\\\"").replace('<', "\\<").replace('>', "\\>").replace(';', "\\;");
            parts.push(format!("{key}={value}"));
        }
    }
    parts.join(",")
}

/// A certificate as `gnutls-peer-status` describes it.
pub fn certificate_details(der: &[u8]) -> Option<CertificateDetails> {
    use x509_parser::prelude::*;
    let (_, cert) = X509Certificate::from_der(der).ok()?;
    let tbs = &cert.tbs_certificate;
    let date = |t: &ASN1Time| t.to_datetime().date().to_string();
    let spki = tbs.subject_pki.raw;
    let (algorithm, bits) = match tbs.subject_pki.parsed() {
        Ok(x509_parser::public_key::PublicKey::RSA(rsa)) => ("RSA", rsa.key_size()),
        Ok(x509_parser::public_key::PublicKey::EC(ec)) => ("EC/ECDSA", ec.key_size()),
        _ if tbs.subject_pki.algorithm.algorithm.to_id_string() == "1.3.101.112" => ("EdDSA (Ed25519)", 256),
        _ => ("UNKNOWN", 0),
    };
    // GnuTLS's security levels for a key's size.
    let level = match (algorithm, bits) {
        ("RSA", b) if b >= 15360 => "Ultra",
        ("RSA", b) if b >= 7680 => "Ultra",
        ("RSA", b) if b >= 3072 => "High",
        ("RSA", b) if b >= 2048 => "Medium",
        ("RSA", b) if b >= 1024 => "Legacy",
        ("RSA", _) => "Very weak",
        (_, b) if b >= 512 => "Ultra",
        (_, b) if b >= 384 => "Ultra",
        (_, b) if b >= 256 => "High",
        (_, b) if b >= 224 => "Medium",
        (_, b) if b >= 192 => "Legacy",
        _ => "Unknown",
    };
    let signature = match cert.signature_algorithm.algorithm.to_id_string().as_str() {
        "1.2.840.113549.1.1.11" => "RSA-SHA256",
        "1.2.840.113549.1.1.12" => "RSA-SHA384",
        "1.2.840.113549.1.1.13" => "RSA-SHA512",
        "1.2.840.113549.1.1.5" => "RSA-SHA1",
        "1.2.840.10045.4.3.2" => "ECDSA-SHA256",
        "1.2.840.10045.4.3.3" => "ECDSA-SHA384",
        "1.2.840.10045.4.3.4" => "ECDSA-SHA512",
        "1.3.101.112" => "EdDSA-Ed25519",
        "1.2.840.113549.1.1.10" => "RSA-PSS-SHA256",
        _ => "UNKNOWN",
    };
    let body: String = {
        let b64 = base64(der);
        b64.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned() + "\n").collect()
    };
    Some(CertificateDetails {
        version: tbs.version.0 + 1,
        serial_number: hex("", tbs.raw_serial()),
        issuer: distinguished_name(&tbs.issuer),
        valid_from: date(&tbs.validity.not_before),
        valid_to: date(&tbs.validity.not_after),
        subject: distinguished_name(&tbs.subject),
        public_key_algorithm: algorithm.into(),
        certificate_security_level: level.into(),
        signature_algorithm: signature.into(),
        // The key's id as GnuTLS takes it: a hash of its SubjectPublicKeyInfo.
        public_key_id: hex("sha1:", &digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, spki)),
        public_key_id_sha256: hex("sha256:", &digest(&ring::digest::SHA256, spki)),
        certificate_id: hex("sha1:", &digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, der)),
        pem: format!("-----BEGIN CERTIFICATE-----\n{body}-----END CERTIFICATE-----\n"),
        self_signed: tbs.issuer.as_raw() == tbs.subject.as_raw() && !spki.is_empty(),
    })
}

/// Bytes in base64, as PEM writes them.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A PEM certificate described as text, as `gnutls-format-certificate`
/// gives GnuTLS's full description: the same headings, fewer details.
pub fn format_certificate(pem: &str) -> Result<String> {
    let der = CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|e| Error::new(format!("gnutls-format-certificate: {e}")))?;
    let c = certificate_details(&der).ok_or_else(|| Error::new("gnutls-format-certificate: not an X.509 certificate"))?;
    Ok(format!(
        "X.509 Certificate Information:\n\tVersion: {}\n\tSerial Number (hex): {}\n\tIssuer: {}\n\tValidity:\n\t\tNot Before: {}\n\t\tNot After: {}\n\tSubject: {}\n\tSubject Public Key Algorithm: {}\n\tAlgorithm Security Level: {}\n\tSignature Algorithm: {}\nOther Information:\n\tFingerprint:\n\t\tsha1:{}\n\tPublic Key ID:\n\t\tsha1:{}\n\t\tsha256:{}\n",
        c.version,
        c.serial_number.replace(':', ""),
        c.issuer,
        c.valid_from,
        c.valid_to,
        c.subject,
        c.public_key_algorithm,
        c.certificate_security_level,
        c.signature_algorithm,
        c.certificate_id.trim_start_matches("sha1:").replace(':', ""),
        c.public_key_id.trim_start_matches("sha1:").replace(':', ""),
        c.public_key_id_sha256.trim_start_matches("sha256:").replace(':', ""),
    ))
}

/// What this build can do, as `gnutls-available-p` lists it.
pub fn capabilities() -> Vec<&'static str> {
    vec!["gnutls", "gnutls3", "ClientHello Extensions", "Server Name Indication", "ALPN", "Supported Versions", "Key Share", "Signature Algorithms", "Extended Master Secret"]
}
