//! TLS on network processes, as Emacs's gnutls.c gives it (ADR 0075),
//! against a server in the test with certificates made for it: an
//! authority of its own, and certificates trusted, expired, self-signed
//! or for another name, which verifying records as GnuTLS's warnings. The
//! shape of what gnutls-peer-status gives was recorded from Emacs 30
//! against a public server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

use e8_core::Editor;
use e8_script::Scripting;
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

/// An authority, and the PEM file of its certificate, to trust.
struct Authority {
    params: CertificateParams,
    key: KeyPair,
    pem: String,
}

fn authority() -> Authority {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.distinguished_name.push(DnType::OrganizationName, "E8 Test");
    params.distinguished_name.push(DnType::CommonName, "E8 Test CA");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let pem = params.self_signed(&key).unwrap().pem();
    Authority { params, key, pem }
}

/// What a server presents: its certificate chain and key.
struct Identity {
    chain: Vec<rustls::pki_types::CertificateDer<'static>>,
    key: rustls::pki_types::PrivateKeyDer<'static>,
}

/// A certificate for `name`, signed by `ca` or by itself, valid now or not.
fn identity(name: &str, ca: Option<&Authority>, expired: bool) -> Identity {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec![name.to_string()]).unwrap();
    params.distinguished_name.push(DnType::CommonName, name);
    if expired {
        params.not_before = rcgen::date_time_ymd(2019, 1, 1);
        params.not_after = rcgen::date_time_ymd(2020, 1, 1);
    }
    let cert = match ca {
        Some(ca) => params.signed_by(&key, &Issuer::from_params(&ca.params, &ca.key)).unwrap(),
        None => params.self_signed(&key).unwrap(),
    };
    let der = rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der());
    Identity { chain: vec![cert.der().clone()], key: der.into() }
}

/// What a test's server does once TLS is up.
#[derive(Clone, Copy, PartialEq)]
enum Serve {
    /// Sends each line back in capitals.
    Lines,
    /// Sends back whatever comes, as it comes.
    Echo,
    /// Sends this many bytes before reading anything, so both ends have
    /// more to send than the other is taking.
    Flood(usize),
}

/// A server on a free port taking every connection: with `starttls`, it says
/// "READY" and waits for "STARTTLS" in plain text first. Returns its port.
fn server_doing(id: Identity, starttls: bool, serve: Serve) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(id.chain, id.key)
        .unwrap();
    let config = Arc::new(config);
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(sock) = sock else { return };
            let config = config.clone();
            std::thread::spawn(move || talk_to(sock, config, starttls, serve));
        }
    });
    port
}

/// A server sending each line back in capitals.
fn server(id: Identity, starttls: bool) -> u16 {
    server_doing(id, starttls, Serve::Lines)
}

/// Talks to one client, as [`server_doing`] says.
fn talk_to(mut sock: std::net::TcpStream, config: Arc<rustls::ServerConfig>, starttls: bool, serve: Serve) {
    {
        if starttls {
            sock.write_all(b"READY\n").unwrap();
            let mut line = [0u8; 9];
            if sock.read_exact(&mut line).is_err() || &line != b"STARTTLS\n" {
                return;
            }
        }
        let conn = rustls::ServerConnection::new(config).unwrap();
        let mut tls = rustls::StreamOwned::new(conn, sock);
        if let Serve::Flood(size) = serve
            && tls.write_all(&vec![b'y'; size]).and_then(|_| tls.flush()).is_err()
        {
            return;
        }
        let mut lines = String::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match tls.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) if matches!(serve, Serve::Flood(_)) => {}
                Ok(n) if serve == Serve::Echo => {
                    if tls.write_all(&buf[..n]).and_then(|_| tls.flush()).is_err() {
                        return;
                    }
                }
                Ok(n) => {
                    lines.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(at) = lines.find('\n') {
                        let line: String = lines.drain(..=at).collect();
                        if tls.write_all(line.to_uppercase().as_bytes()).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// A file holding `pem`, kept while the test runs.
fn pem_file(dir: &tempfile::TempDir, pem: &str) -> String {
    let path = dir.path().join("ca.pem");
    std::fs::write(&path, pem).unwrap();
    path.display().to_string()
}

/// Connects to a server on `port` with TLS as `tls` (a JS object) asks:
/// the peer's warnings and the server's answer to "hello", or the error.
fn talk(ed: &mut Editor, s: &Scripting, port: u16, tls: &str) -> String {
    eval(
        ed,
        s,
        &format!(
            r#"e8.conditionCase(() => {{
              globalThis.got = "";
              const p = e8.makeNetworkProcess({{ name: "tls", host: "127.0.0.1", service: {port}, filter: (_, out) => {{ got += out; }}, tls: {tls} }});
              const status = e8.gnutlsPeerStatus(p);
              e8.processSendString(p, "hello\n");
              for (let i = 0; i < 50 && !got.includes("\n"); i++) e8.acceptProcessOutput(p, 0.1);
              e8.deleteProcess(p);
              return [status.warnings ?? [], got];
            }}, {{ error: (e) => e.message }})"#
        ),
    )
}

#[test]
fn a_trusted_peer_has_no_warnings_and_traffic_goes_both_ways() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, &format!(r#"{{ hostname: "localhost", trustfiles: [{trust:?}] }}"#)), r#"[[],"HELLO\n"]"#);
}

#[test]
fn what_verifying_finds_wrong_is_recorded_as_gnutls_warns_of_it() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    let with_trust = |host: &str| format!(r#"{{ hostname: "{host}", trustfiles: [{trust:?}] }}"#);
    // An authority not trusted: invalid and unknown-ca, the last checked first, as gnutls.c conses them.
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, r#"{ hostname: "localhost" }"#), r#"[["unknown-ca","invalid"],"HELLO\n"]"#);
    // Another name.
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, &with_trust("other.test")), r#"[["no-host-match"],"HELLO\n"]"#);
    // Expired.
    let port = server(identity("localhost", Some(&ca), true), false);
    assert_eq!(talk(&mut ed, &s, port, &with_trust("localhost")), r#"[["expired","invalid"],"HELLO\n"]"#);
    // Self-signed.
    let port = server(identity("localhost", None, false), false);
    assert_eq!(talk(&mut ed, &s, port, r#"{ hostname: "localhost" }"#), r#"[["self-signed","unknown-ca","invalid"],"HELLO\n"]"#);
    // Refused when :verify-error asks, with gnutls.c's messages, the connection deleted.
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, r#"{ hostname: "localhost", verifyError: true }"#), r#""Certificate validation failed localhost, verification code invalid, unknown-ca""#);
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, &format!(r#"{{ hostname: "other.test", trustfiles: [{trust:?}], verifyError: ["hostname"] }}"#)), r#""The x509 certificate does not match \"other.test\"""#);
    // Asking only about the name, the chain's faults are recorded and let through.
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(talk(&mut ed, &s, port, r#"{ hostname: "localhost", verifyError: ["hostname"] }"#), r#"[["unknown-ca","invalid"],"HELLO\n"]"#);
    assert_eq!(eval(&mut ed, &s, "e8.processList().length"), "0");
}

#[test]
fn a_plain_connection_becomes_tls_and_says_how_far_it_has_come() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    let port = server(identity("localhost", Some(&ca), false), true);
    let got = eval(
        &mut ed,
        &s,
        &format!(
            r#"(() => {{
              globalThis.got = "";
              const p = e8.makeNetworkProcess({{ name: "starttls", host: "127.0.0.1", service: {port}, filter: (_, out) => {{ got += out; }} }});
              for (let i = 0; i < 50 && !got.includes("\n"); i++) e8.acceptProcessOutput(p, 0.1);
              const greeting = got;
              const before = e8.gnutlsGetInitstage(p);
              e8.processSendString(p, "STARTTLS\n");
              const booted = e8.gnutlsBoot(p, "gnutls-x509pki", {{ hostname: "localhost", trustfiles: [{trust:?}] }});
              const ready = e8.gnutlsGetInitstage(p);
              got = "";
              e8.processSendString(p, "secret\n");
              for (let i = 0; i < 50 && !got.includes("\n"); i++) e8.acceptProcessOutput(p, 0.1);
              const status = e8.gnutlsPeerStatus(p);
              const c = status.certificate;
              const result = [greeting, before, booted, ready, got, status.protocol, status.keyExchange, status.mac, status.encryptThenMac,
                c.subject, c.issuer, c.version, c.publicKeyAlgorithm, c.certificateSecurityLevel, c.signatureAlgorithm,
                /^sha1:([0-9a-f]{{2}}:){{19}}[0-9a-f]{{2}}$/.test(c.certificateId), /^sha256:/.test(c.publicKeyIdSha256), c.pem.startsWith("-----BEGIN CERTIFICATE-----\n"),
                status.certificates.length, e8.gnutlsBye(p), e8.gnutlsDeinit(p), e8.gnutlsGetInitstage(p), e8.gnutlsPeerStatus(p) ?? null];
              e8.deleteProcess(p);
              return result;
            }})()"#
        ),
    );
    assert_eq!(
        got,
        r#"["READY\n",0,true,9,"SECRET\n","TLS1.3","ECDHE-RSA","AEAD",false,"CN=localhost","CN=E8 Test CA,O=E8 Test",3,"EC/ECDSA","High","ECDSA-SHA256",true,true,true,1,true,true,3,null]"#
    );
}

#[test]
fn the_rest_of_gnutls_answers_as_emacs_does() {
    let (mut ed, s) = setup();
    // As Emacs 30: t and gnutls-e-again are not errors, anything else is.
    assert_eq!(eval(&mut ed, &s, r#"[e8.gnutlsErrorp(true), e8.gnutlsErrorp("gnutls-e-again"), e8.gnutlsErrorp("gnutls-e-interrupted")]"#), "[false,false,true]");
    assert_eq!(eval(&mut ed, &s, r#"[e8.gnutlsErrorString(true), e8.gnutlsPeerStatusWarningDescribe(":expired"), e8.gnutlsPeerStatusWarningDescribe("unknown-ca"), e8.gnutlsPeerStatusWarningDescribe("nonsense") ?? null]"#),
        r#"["Not an error","certificate has expired","the certificate was signed by an unknown and therefore untrusted authority",null]"#);
    assert!(eval(&mut ed, &s, "e8.gnutlsAvailableP()").contains("\"gnutls\""));
    let ca = authority();
    let text = eval(&mut ed, &s, &format!("e8.gnutlsFormatCertificate({:?})", ca.pem));
    assert!(text.starts_with(r#""X.509 Certificate Information:\n\tVersion: 3\n"#), "{text}");
    assert!(text.contains(r#"\tSubject: CN=E8 Test CA,O=E8 Test\n"#), "{text}");
    // A process that is not a connection has no TLS to start.
    assert!(eval(&mut ed, &s, r#"e8.conditionCase(() => e8.gnutlsBoot(e8.makePipeProcess({ name: "pipe" }), "gnutls-x509pki", { hostname: "x" }), { error: (e) => e.message })"#).contains("not a network connection"));
    // A connection that has closed answers rather than failing, as Emacs's
    // gnutls-peer-status gives nil for a process with no session.
    let gone = eval(
        &mut ed,
        &s,
        r#"(() => { const p = e8.makePipeProcess({ name: "gone" }); e8.deleteProcess(p);
          return [e8.gnutlsPeerStatus(p) ?? null, e8.gnutlsGetInitstage(p), e8.gnutlsBye(p), e8.gnutlsDeinit(p)]; })()"#,
    );
    assert_eq!(gone, "[null,0,false,false]");
    assert!(eval(&mut ed, &s, r#"e8.conditionCase(() => e8.gnutlsBoot("pipe", "gnutls-anon", { hostname: "x" }), { error: (e) => e.message })"#).contains("gnutls-x509pki only"));
}

/// Against a public server, as Emacs 30 was recorded against it: run with
/// `--run-ignored` where the network is there.
#[test]
#[ignore = "reaches example.com"]
fn a_public_server_is_described_as_emacs_describes_it() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          const p = e8.makeNetworkProcess({ name: "ex", host: "example.com", service: 443, tls: { hostname: "example.com" } });
          const st = e8.gnutlsPeerStatus(p);
          e8.deleteProcess(p);
          const c = st.certificate;
          return [st.warnings ?? null, st.protocol, st.keyExchange, st.cipher, st.mac, c.subject, c.publicKeyAlgorithm, c.certificateSecurityLevel, c.signatureAlgorithm, c.issuer];
        })()"#,
    );
    assert!(got.starts_with(r#"[null,"TLS1.3","ECDHE-RSA","AES-256-GCM","AEAD","CN=example.com","EC/ECDSA","High","ECDSA-SHA256","#), "{got}");
}

/// Opens a TLS stream through open-network-stream, as packages do: the
/// process, or null if the Network Security Manager refused it.
fn open_stream(ed: &mut Editor, s: &Scripting, port: u16, trust: Option<&str>) -> String {
    let trust = trust.map_or("null".to_string(), |t| format!("[{t:?}]"));
    eval(
        ed,
        s,
        &format!(
            r#"(() => {{
              e8.setVariable("gnutls-trustfiles", {trust});
              const p = ns.openNetworkStream("stream", null, "localhost", {port}, {{ type: "tls" }});
              const live = p !== undefined && e8.processLiveP(p);
              if (p !== undefined) e8.deleteProcess(p);
              return [live, e8.processList().length];
            }})()"#
        ),
    )
}

#[test]
fn the_network_security_manager_asks_about_a_certificate_and_remembers() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    let config = tempfile::tempdir().unwrap();
    s.eval_typescript(&mut ed, "load.ts", r#"Promise.all([import("network-stream"), import("nsm")]).then(([a, b]) => { globalThis.ns = a; globalThis.nsm = b; });"#.into()).unwrap();
    eval(&mut ed, &s, &format!("e8.setVariable(\"user-emacs-directory\", {:?})", format!("{}/", config.path().display())));
    // Trusted: no question.
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, Some(&trust)), "[true,0]");
    // Not trusted, with no one to ask: refused and deleted, as Emacs's nsm-query says no.
    eval(&mut ed, &s, r#"e8.setVariable("nsm-noninteractive", true)"#);
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[false,0]");
    // Asked, and accepted for this session: the next connection to the same server asks nothing.
    let port = server(identity("localhost", Some(&ca), false), false);
    eval(&mut ed, &s, r#"e8.setVariable("nsm-noninteractive", false)"#);
    let asked = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = asked.clone();
    ed.set_input_source(move |ed| {
        count.set(count.get() + 1);
        ed.type_text("session\n");
        true
    });
    assert_eq!(open_stream(&mut ed, &s, port, None), "[true,0]");
    assert_eq!(asked.get(), 1);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[true,0]");
    assert_eq!(asked.get(), 1);
    assert!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Network Security Manager*", () => e8.bufferSubstring(0, e8.pointMax()))"#).contains("signed by an unknown and therefore untrusted authority"));
    // A key seen and pinned for good, then another: asked about, and refused.
    let first = identity("localhost", Some(&ca), false);
    let port = server(first, false);
    eval(&mut ed, &s, &format!(r#"(() => {{ const p = e8.makeNetworkProcess({{ name: "pin", host: "127.0.0.1", service: {port}, tls: {{ hostname: "localhost", trustfiles: [{trust:?}] }} }}); nsm.nsmVerifyConnection(p, "pinned", 1, true); e8.deleteProcess(p); }})()"#));
    let saved = std::fs::read_to_string(config.path().join("network-security.json")).unwrap();
    assert!(saved.contains("\"fingerprints\"") && saved.contains("sha1:"), "{saved}");
    ed.set_input_source(|ed| {
        ed.type_text("no\n");
        true
    });
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(
        eval(&mut ed, &s, &format!(r#"(() => {{ const p = e8.makeNetworkProcess({{ name: "pin", host: "127.0.0.1", service: {port}, tls: {{ hostname: "localhost", trustfiles: [{trust:?}] }} }}); return [nsm.nsmVerifyConnection(p, "pinned", 1) ?? null, e8.processList().length]; }})()"#)),
        "[null,0]"
    );
}

/// Echoes what is sent over TLS and counts what comes back, giving how
/// many bytes did and whether the connection is still open.
fn echoed(ed: &mut Editor, s: &Scripting, port: u16, trust: &str, chunk: usize, times: usize) -> String {
    eval(
        ed,
        s,
        &format!(
            r#"(() => {{
              globalThis.got = 0;
              const p = e8.makeNetworkProcess({{ name: "echo", host: "127.0.0.1", service: {port}, coding: "binary",
                filter: (_, out) => {{ got += out.length; }}, tls: {{ hostname: "localhost", trustfiles: [{trust:?}] }} }});
              const want = {chunk} * {times};
              const text = "x".repeat({chunk});
              // Sending and taking back what comes at the same time, as a
              // connection carrying traffic both ways does.
              for (let i = 0; i < {times}; i++) {{
                e8.processSendString(p, text);
                e8.acceptProcessOutput(p, 0);
              }}
              for (let i = 0; i < 2000 && got < want; i++) e8.acceptProcessOutput(p, 0.05);
              const result = [got, e8.processStatus(p)];
              e8.deleteProcess(p);
              return result;
            }})()"#
        ),
    )
}

#[test]
fn a_send_larger_than_tls_holds_at_once_goes_through_whole() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    let port = server_doing(identity("localhost", Some(&ca), false), false, Serve::Echo);
    // More than rustls holds at once (64 KiB), which would otherwise be
    // refused and close the connection without a word.
    assert_eq!(echoed(&mut ed, &s, port, &trust, 200_000, 1), r#"[200000,"open"]"#);
}

#[test]
fn sending_while_the_peer_sends_back_does_not_stall() {
    let (mut ed, s) = setup();
    let ca = authority();
    let dir = tempfile::tempdir().unwrap();
    let trust = pem_file(&dir, &ca.pem);
    // Both ends with more to send than the other is taking, which fills
    // what the sockets hold: reading must not wait for writing, or
    // neither end moves again.
    let port = server_doing(identity("localhost", Some(&ca), false), false, Serve::Flood(4 * 1024 * 1024));
    let got = eval(
        &mut ed,
        &s,
        &format!(
            r#"(() => {{
              globalThis.got = 0;
              const p = e8.makeNetworkProcess({{ name: "flood", host: "127.0.0.1", service: {port}, coding: "binary",
                filter: (_, out) => {{ got += out.length; }}, tls: {{ hostname: "localhost", trustfiles: [{trust:?}] }} }});
              const text = "x".repeat(60000);
              for (let i = 0; i < 70; i++) {{
                e8.processSendString(p, text);
                e8.acceptProcessOutput(p, 0);
              }}
              for (let i = 0; i < 600 && got < 4 * 1024 * 1024; i++) e8.acceptProcessOutput(p, 0.05);
              const result = [got, e8.processStatus(p)];
              e8.deleteProcess(p);
              return result;
            }})()"#
        ),
    );
    assert_eq!(got, r#"[4194304,"open"]"#);
}

#[test]
fn a_connection_that_dies_during_the_handshake_fails_rather_than_waiting() {
    let (mut ed, s) = setup();
    // A server that closes at once, as a proxy with nothing behind it.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for sock in listener.incoming().take(2) {
            drop(sock);
        }
    });
    let failed = eval(
        &mut ed,
        &s,
        &format!(
            r#"e8.conditionCase(() => e8.makeNetworkProcess({{ name: "dead", host: "127.0.0.1", service: {port}, tls: {{ hostname: "localhost" }} }}), {{ error: (e) => [e.symbol, e8.processList().length] }})"#
        ),
    );
    assert!(failed.starts_with(r#"["gnutls-error",0]"#) || failed.starts_with(r#"["error",0]"#), "{failed}");
}

#[test]
fn the_security_level_and_what_is_remembered_follow_nsm() {
    let (mut ed, s) = setup();
    let ca = authority();
    let config = tempfile::tempdir().unwrap();
    eval(&mut ed, &s, &format!("e8.setVariable(\"user-emacs-directory\", {:?})", format!("{}/", config.path().display())));
    s.eval_typescript(&mut ed, "load.ts", r#"Promise.all([import("network-stream"), import("nsm")]).then(([a, b]) => { globalThis.ns = a; globalThis.nsm = b; });"#.into()).unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("nsm-noninteractive", true)"#);
    // "low" checks nothing, so a certificate that does not verify is used.
    eval(&mut ed, &s, r#"e8.setVariable("network-security-level", "low")"#);
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[true,0]");
    // A level nsm does not know counts as high, as nsm-level's t does, so
    // the checks still run: a typo must not turn checking off.
    eval(&mut ed, &s, r#"e8.setVariable("network-security-level", "Medium")"#);
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[false,0]");
    // Accepted for the session: the session's list keeps it, not the file's.
    eval(&mut ed, &s, r#"e8.setVariable("network-security-level", "medium")"#);
    eval(&mut ed, &s, r#"e8.setVariable("nsm-noninteractive", false)"#);
    ed.set_input_source(|ed| {
        ed.type_text("session\n");
        true
    });
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[true,0]");
    assert_eq!(eval(&mut ed, &s, r#"[e8.variable("nsm-temporary-host-settings").length, e8.variable("nsm-permanent-host-settings").length]"#), "[1,0]");
    // Accepted for good: it leaves the session's list, as nsm-save-host
    // removes the temporary setting, and is written with its problems.
    ed.set_input_source(|ed| {
        ed.type_text("always\n");
        true
    });
    let port = server(identity("localhost", Some(&ca), false), false);
    assert_eq!(open_stream(&mut ed, &s, port, None), "[true,0]");
    let saved = eval(&mut ed, &s, r#"[e8.variable("nsm-temporary-host-settings").length, e8.variable("nsm-permanent-host-settings").length, e8.variable("nsm-permanent-host-settings")[0].conditions, e8.variable("nsm-permanent-host-settings")[0].fingerprints.length]"#);
    assert_eq!(saved, r#"[1,1,[":unknown-ca",":invalid",":verify-cert"],1]"#);
    let file = std::fs::read_to_string(config.path().join("network-security.json")).unwrap();
    assert!(file.contains(":verify-cert"), "{file}");
}

#[test]
fn open_network_stream_refuses_what_e8_does_not_do() {
    let (mut ed, s) = setup();
    s.eval_typescript(&mut ed, "load.ts", r#"import("network-stream").then((m) => { globalThis.ns = m; });"#.into()).unwrap();
    // STARTTLS, by its type or by a capability command, and keywords E8
    // has no answer for: an error, not a connection without encryption.
    for call in [
        r#"e8.funcall("open-network-stream", "s", null, "127.0.0.1", 1, ":type", "starttls")"#,
        r#"e8.funcall("open-network-stream", "s", null, "127.0.0.1", 1, ":capability-command", "CAPABILITY", ":success", "^OK")"#,
        r#"e8.funcall("open-network-stream", "s", null, "127.0.0.1", 1, ":nowait", true)"#,
        r#"e8.funcall("open-network-stream", "s", null, "127.0.0.1", 1, ":type", "shell")"#,
    ] {
        let got = eval(&mut ed, &s, &format!("e8.conditionCase(() => {call}, {{ error: (e) => e.message }})"));
        assert!(got.contains("not supported"), "{call}: {got}");
    }
}
