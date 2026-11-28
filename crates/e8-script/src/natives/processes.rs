//! Processes, as Emacs's process.c gives them to Lisp: each a `Process`
//! object, which every function here takes, or its name ([ADR 0070]).
//!
//! [ADR 0070]: ../../../../docs/adr/0070-processes-as-emacs-has-them.md

use crate::*;
use crate::natives::{natives, Fields, Proc, ProcObj, Record, Rest};

natives! {
    /// What TLS this E8 has, as gnutls-available-p: a list of names, as
    /// Emacs's of symbols, or undefined where there is none, as on the web.
    #[ts = "(): string[] | undefined"]
    pub fn gnutlsAvailableP(ed) -> Option<Vec<String>> {
        let _ = ed;
        let caps = e8_core::tls::capabilities();
        Ok((!caps.is_empty()).then(|| caps.into_iter().map(str::to_string).collect()))
    }

    /// The symmetric ciphers there are, as gnutls-ciphers: each with
    /// GnuTLS's name and id, and the sizes of its tag, block, key and
    /// nonce. E8 has the AEAD ciphers its TLS gives, strongest last.
    #[ts = "(): GnutlsCipher[]"]
    pub fn gnutlsCiphers(ed) -> Vec<Record> {
        let _ = ed;
        Ok(e8_core::tls::ciphers()
            .into_iter()
            .map(|c| {
                Record::new()
                    .with("name", c.name)
                    .with("cipherId", EditorValue::Number(c.id as f64))
                    .with("type", "gnutls-symmetric-cipher")
                    .with("cipherAeadCapable", EditorValue::Bool(c.tag_size > 0))
                    .with("cipherTagsize", EditorValue::Number(c.tag_size as f64))
                    .with("cipherBlocksize", EditorValue::Number(c.block_size as f64))
                    .with("cipherKeysize", EditorValue::Number(c.key_size as f64))
                    .with("cipherIvsize", EditorValue::Number(c.iv_size as f64))
            })
            .collect())
    }

    /// The MACs there are, as gnutls-macs: HMAC on each hash E8 has.
    #[ts = "(): GnutlsMac[]"]
    pub fn gnutlsMacs(ed) -> Vec<Record> {
        let _ = ed;
        Ok(e8_core::hashes::ALGORITHMS
            .iter()
            .map(|a| {
                let length = e8_core::hashes::length(a).unwrap_or(0);
                Record::new()
                    .with("name", e8_core::hashes::gnutls_name(a))
                    .with("macAlgorithmId", EditorValue::Number(e8_core::hashes::gnutls_id(a).unwrap_or(0) as f64))
                    .with("type", "gnutls-mac-algorithm")
                    .with("macAlgorithmLength", EditorValue::Number(length as f64))
                    .with("macAlgorithmKeysize", EditorValue::Number(length as f64))
                    .with("macAlgorithmNoncesize", EditorValue::Number(0.0))
            })
            .collect())
    }

    /// The hashes there are, as gnutls-digests.
    #[ts = "(): GnutlsDigest[]"]
    pub fn gnutlsDigests(ed) -> Vec<Record> {
        let _ = ed;
        Ok(e8_core::hashes::ALGORITHMS
            .iter()
            .map(|a| {
                Record::new()
                    .with("name", e8_core::hashes::gnutls_name(a))
                    .with("digestAlgorithmId", EditorValue::Number(e8_core::hashes::gnutls_id(a).unwrap_or(0) as f64))
                    .with("type", "gnutls-digest-algorithm")
                    .with("digestAlgorithmLength", EditorValue::Number(e8_core::hashes::length(a).unwrap_or(0) as f64))
            })
            .collect())
    }

    /// The MAC of `input` with `key`, as gnutls-hash-mac: HMAC by a name
    /// gnutlsMacs gives ("SHA256"). Both are bytes, as what this gives
    /// back is, so one MAC is the key of the next, as SCRAM chains them;
    /// text is encoded first, with encodeCodingString.
    #[ts = "(method: string, key: string, input: string): string"]
    pub fn gnutlsHashMac(ed, method: String, key: String, input: String) -> String {
        let _ = ed;
        let algorithm = e8_core::hashes::by_gnutls_name(&method).ok_or_else(|| e8_core::Error::new(format!("GnuTLS MAC is invalid or not found: {method}")))?;
        let mut key = crypto_bytes(&key)?;
        let mac = e8_core::hashes::mac(algorithm, &key, &crypto_bytes(&input)?);
        wipe(&mut key);
        Ok(e8_core::coding::string_of_bytes(&mac?))
    }

    /// The hash of `input`, as gnutls-hash-digest, by a name gnutlsDigests
    /// gives. Bytes, as gnutlsHashMac takes and gives them.
    #[ts = "(method: string, input: string): string"]
    pub fn gnutlsHashDigest(ed, method: String, input: String) -> String {
        let _ = ed;
        let algorithm = e8_core::hashes::by_gnutls_name(&method).ok_or_else(|| e8_core::Error::new(format!("GnuTLS digest is invalid or not found: {method}")))?;
        let hash = e8_core::hashes::digest(algorithm, &crypto_bytes(&input)?)?;
        Ok(e8_core::coding::string_of_bytes(&hash))
    }

    /// Encrypt `input` with a cipher gnutlsCiphers gives, as
    /// gnutls-symmetric-encrypt: the text with its tag after it, and the
    /// nonce used, which an empty `iv` asks to be made here, as Emacs's
    /// `iv-auto` does. Strings of bytes, as secureHash's `binary` gives.
    #[ts = "(cipher: string, key: string, iv: string, input: string, aeadAuth?: string): [text: string, iv: string]"]
    pub fn gnutlsSymmetricEncrypt(ed, cipher: String, key: String, iv: String, input: String, aead_auth: Option<String>) -> Vec<String> {
        let _ = ed;
        symmetric(true, &cipher, &key, &iv, &input, aead_auth.as_deref())
    }

    /// Decrypt what gnutlsSymmetricEncrypt gave, as gnutls-symmetric-decrypt.
    #[ts = "(cipher: string, key: string, iv: string, input: string, aeadAuth?: string): [text: string, iv: string]"]
    pub fn gnutlsSymmetricDecrypt(ed, cipher: String, key: String, iv: String, input: String, aead_auth: Option<String>) -> Vec<String> {
        let _ = ed;
        symmetric(false, &cipher, &key, &iv, &input, aead_auth.as_deref())
    }

    /// Start TLS on a network connection, as gnutls-boot: `type` is
    /// "gnutls-x509pki"; `params` names the host the certificate must
    /// name, trust files of authorities beyond the system's, key and
    /// certificate files to offer, and which failures of verifying the
    /// peer refuse it ("trustfiles", "hostname", or true for both). Waits
    /// for the handshake; true when done, else an error.
    #[ts = "(process: ProcessLike, type: \"gnutls-x509pki\" | \"gnutls-anon\", params: { hostname: string; trustfiles?: string[]; keylist?: [key: string, certificate: string][]; verifyError?: true | (\"trustfiles\" | \"hostname\")[] }): true"]
    pub fn gnutlsBoot(ed, process: Proc, kind: String, params: Fields) -> bool {
        let name = process.listed_name(ed)?;
        if kind != "gnutls-x509pki" {
            return Err(Error::new(format!("gnutls-boot: {kind} is not supported: E8's TLS is gnutls-x509pki only")));
        }
        let hostname = params.string("hostname").ok_or_else(|| Error::new("gnutls-boot: invalid :hostname parameter (not a string)"))?;
        let names = |v: &EditorValue| -> Vec<String> {
            match v {
                EditorValue::List(items) => items.iter().filter_map(|i| i.as_str().map(|s| s.trim_start_matches(':').to_string())).collect(),
                _ => Vec::new(),
            }
        };
        let (verify_chain, verify_hostname) = match params.get("verifyError") {
            Some(EditorValue::Bool(true)) => (true, true),
            Some(v) => {
                let n = names(v);
                (n.iter().any(|s| s == "trustfiles"), n.iter().any(|s| s == "hostname"))
            }
            None => (false, false),
        };
        let keylist = match params.get("keylist") {
            Some(EditorValue::List(pairs)) => pairs
                .iter()
                .filter_map(|kv| match kv {
                    EditorValue::List(kv) => Some((kv.first()?.as_str()?.to_string(), kv.get(1)?.as_str()?.to_string())),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let tls = e8_core::tls::TlsParams { hostname, trustfiles: params.strings("trustfiles").unwrap_or_default(), keylist, verify_chain, verify_hostname };
        ed.gnutls_boot(&name, tls)?;
        Ok(true)
    }

    /// How far a process's TLS has come, as gnutls-get-initstage: 0 for
    /// none, 8 while its handshake goes on, 9 once done, 3 once taken down.
    #[ts = "(process: ProcessLike): number"]
    pub fn gnutlsGetInitstage(ed, process: Proc) -> u8 {
        let Some(name) = gone_or_name(ed, &process) else { return Ok(e8_core::tls::stage::EMPTY) };
        ed.gnutls_get_initstage(&name)
    }

    /// The peer of a process's TLS once its handshake is done, as
    /// gnutls-peer-status: what verifying it found wrong ("unknown-ca",
    /// "no-host-match", ...), its certificates, the peer's first, and the
    /// protocol, key exchange, cipher and MAC; undefined before.
    #[ts = "(process: ProcessLike): GnutlsPeerStatus | undefined"]
    pub fn gnutlsPeerStatus(ed, process: Proc) -> Option<Record> {
        let Some(name) = gone_or_name(ed, &process) else { return Ok(None) };
        let Some(status) = ed.gnutls_peer_status(&name)? else { return Ok(None) };
        let cert = |c: &e8_core::tls::CertificateDetails| {
            Record::new()
                .with("version", EditorValue::Number(c.version as f64))
                .with("serialNumber", c.serial_number.as_str())
                .with("issuer", c.issuer.as_str())
                .with("validFrom", c.valid_from.as_str())
                .with("validTo", c.valid_to.as_str())
                .with("subject", c.subject.as_str())
                .with("publicKeyAlgorithm", c.public_key_algorithm.as_str())
                .with("certificateSecurityLevel", c.certificate_security_level.as_str())
                .with("signatureAlgorithm", c.signature_algorithm.as_str())
                .with("publicKeyId", c.public_key_id.as_str())
                .with("publicKeyIdSha256", c.public_key_id_sha256.as_str())
                .with("certificateId", c.certificate_id.as_str())
                .with("pem", c.pem.as_str())
        };
        let mut r = Record::new();
        if !status.warnings.is_empty() {
            r = r.with("warnings", status.warnings.iter().map(|w| w.to_string()).collect::<Vec<_>>());
        }
        if let Some(first) = status.certificates.first() {
            r = r.with("certificates", status.certificates.iter().map(cert).collect::<Vec<_>>()).with("certificate", cert(first));
        }
        r = r
            .with("keyExchange", status.key_exchange.as_str())
            .with("protocol", status.protocol.as_str())
            .with("cipher", status.cipher.as_str())
            .with("mac", status.mac.as_str())
            .with("encryptThenMac", EditorValue::Bool(false));
        if let Some(safe) = status.safe_renegotiation {
            r = r.with("safeRenegotiation", EditorValue::Bool(safe));
        }
        Ok(Some(r))
    }

    /// What a warning gnutlsPeerStatus gives means, as
    /// gnutls-peer-status-warning-describe.
    #[ts = "(warning: string): string | undefined"]
    pub fn gnutlsPeerStatusWarningDescribe(ed, warning: String) -> Option<String> {
        let _ = ed;
        Ok(e8_core::tls::describe_warning(warning.trim_start_matches(':')).map(str::to_string))
    }

    /// A PEM certificate described as text, as gnutls-format-certificate.
    pub fn gnutlsFormatCertificate(ed, certificate: String) -> String {
        let _ = ed;
        e8_core::tls::format_certificate(&certificate)
    }

    /// End a process's TLS, telling the peer, as gnutls-bye; `cont` is
    /// Emacs's, which E8 needs not, as it never waits for the peer's answer.
    #[ts = "(process: ProcessLike, cont?: boolean): boolean"]
    pub fn gnutlsBye(ed, process: Proc, cont: Option<bool>) -> bool {
        let _ = cont;
        let Some(name) = gone_or_name(ed, &process) else { return Ok(false) };
        ed.gnutls_bye(&name)
    }

    /// Take a process's TLS down, as gnutls-deinit.
    #[ts = "(process: ProcessLike): true"]
    pub fn gnutlsDeinit(ed, process: Proc) -> bool {
        let Some(name) = gone_or_name(ed, &process) else { return Ok(false) };
        ed.gnutls_deinit(&name)?;
        Ok(true)
    }

    /// Keep parameters for a later gnutlsBoot of a process, as
    /// gnutls-asynchronous-parameters.
    #[ts = "(process: ProcessLike, params: unknown): void"]
    pub fn gnutlsAsynchronousParameters(ed, process: Proc, params: EditorValue) {
        let Some(name) = gone_or_name(ed, &process) else { return Ok(()) };
        ed.gnutls_asynchronous_parameters(&name, params)
    }

    /// Whether a value gnutlsBoot gave says something went wrong, as
    /// gnutls-errorp: anything but true and "gnutls-e-again".
    #[ts = "(error: unknown): boolean"]
    pub fn gnutlsErrorp(ed, error: EditorValue) -> bool {
        let _ = ed;
        Ok(!matches!(&error, EditorValue::Bool(true)) && error.as_str() != Some("gnutls-e-again"))
    }

    /// What a value gnutlsBoot gave says, as gnutls-error-string.
    #[ts = "(error: unknown): string"]
    pub fn gnutlsErrorString(ed, error: EditorValue) -> String {
        let _ = ed;
        Ok(match &error {
            EditorValue::Bool(true) => "Not an error".into(),
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "gnutls-e-again" => "Resource temporarily unavailable, try again.".into(),
            EditorValue::Str(s) | EditorValue::Symbol(s) => s.clone(),
            _ => "Not an error symbol or code".into(),
        })
    }

    /// The login name E8 goes by, as user-login-name, or a user id's, or
    /// undefined for an id no account has.
    #[ts = "(uid?: number | null): string | undefined"]
    pub fn userLoginName(ed, uid: Option<u32>) -> Option<String> {
        Ok(match uid {
            None => ed.variable("user-login-name").and_then(|v| v.as_str().map(str::to_string)),
            Some(uid) => e8_core::users::account(uid).map(|a| a.login),
        })
    }

    /// The login name of the user who started E8, as user-real-login-name.
    pub fn userRealLoginName(ed) -> String {
        Ok(ed.variable("user-real-login-name").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default())
    }

    /// The full name E8 goes by, as user-full-name: the variable's value,
    /// or a user id's or login name's account's, undefined if none has one.
    #[ts = "(user?: number | string | null): string | undefined"]
    pub fn userFullName(ed, user: EditorValue) -> Option<String> {
        Ok(match user {
            EditorValue::Null => ed.variable("user-full-name").and_then(|v| v.as_str().map(str::to_string)),
            EditorValue::Number(uid) if uid.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&uid) => e8_core::users::account(uid as u32).map(|a| a.full_name),
            EditorValue::Str(login) => e8_core::users::account_named(&login).map(|a| a.full_name),
            other => return Err(e8_core::Error::signal("error", "Invalid UID specification", vec![other])),
        })
    }

    /// The user id E8 runs as, as user-uid.
    pub fn userUid(ed) -> u32 {
        Ok(e8_core::users::user_uid())
    }

    /// The user id that started E8, as user-real-uid.
    pub fn userRealUid(ed) -> u32 {
        Ok(e8_core::users::user_real_uid())
    }

    /// The group id E8 runs as, as group-gid.
    pub fn groupGid(ed) -> u32 {
        Ok(e8_core::users::group_gid())
    }

    /// The group id that started E8, as group-real-gid.
    pub fn groupRealGid(ed) -> u32 {
        Ok(e8_core::users::group_real_gid())
    }

    /// A group's name, as group-name, or undefined if there is no such group.
    pub fn groupName(ed, gid: u32) -> Option<String> {
        Ok(e8_core::users::group_name(gid))
    }

    /// The login names of the system's users, as system-users.
    pub fn systemUsers(ed) -> Vec<String> {
        Ok(e8_core::users::system_users())
    }

    /// The names of the system's groups, as system-groups.
    pub fn systemGroups(ed) -> Vec<String> {
        Ok(e8_core::users::system_groups())
    }

    /// The machine's name, as system-name.
    pub fn systemName(ed) -> String {
        Ok(e8_core::filelock::system_name())
    }

    /// Whether E8 runs as a server with no frames, as daemonp: undefined,
    /// as E8 has no daemon.
    pub fn daemonp(ed) -> Option<bool> {
        Ok(None)
    }

    /// How many processors there are, as num-processors: those E8 may use,
    /// less as OMP_NUM_THREADS or OMP_THREAD_LIMIT say; with "current", those
    /// it may use; with "all", all the system has.
    #[ts = "(query?: \"current\" | \"all\" | boolean | null): number"]
    pub fn numProcessors(ed, query: EditorValue) -> usize {
        let query = match &query {
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "current" => e8_core::users::Processors::Current,
            EditorValue::Str(s) | EditorValue::Symbol(s) if s == "all" => e8_core::users::Processors::All,
            _ => e8_core::users::Processors::Overridable,
        };
        Ok(e8_core::users::num_processors(query))
    }

    fn makeProcess(
        ed,
        name: String,
        buffer: Option<String>,
        command: Vec<String>,
        options: Fields,
        filter: Option<EditorValue>,
        sentinel: Option<EditorValue>,
    ) -> ProcObj {
        let spec = e8_core::ProcessSpec {
            name,
            buffer,
            command,
            directory: options.string("directory"),
            env: match options.get("env") {
                Some(EditorValue::List(pairs)) => pairs
                    .iter()
                    .filter_map(|kv| match kv {
                        EditorValue::List(kv) => Some((kv.first()?.as_str()?.to_string(), kv.get(1)?.as_str()?.to_string())),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            merge_stderr: options.get("stderr").is_none_or(EditorValue::is_true),
            stderr_buffer: options.string("stderr"),
            stderr_process: match options.get("stderr") {
                Some(EditorValue::Process(id)) => Some(*id),
                _ => None,
            },
            filter: handler(filter),
            sentinel: handler(sentinel),
            pty: options.flag("pty"),
            coding: coding_pair(options.get("coding"))?,
        };
        let name = ed.make_process(spec)?;
        Ok(ProcObj(ed.process_named(&name).expect("just started")))
    }

    fn makeNetworkProcess(ed, options: Fields, filter: Option<EditorValue>, sentinel: Option<EditorValue>) -> ProcObj {
        let spec = e8_core::NetworkSpec {
            name: options.string("name").ok_or_else(|| Error::new("A network process needs a name"))?,
            buffer: options.string("buffer"),
            host: options.string("host"),
            service: options.get("service").map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_string)).unwrap_or_default(),
            server: options.flag("server"),
            filter: handler(filter),
            sentinel: handler(sentinel),
            coding: coding_pair(options.get("coding"))?,
            tls: None,
            stop: options.flag("stop"),
            nowait: options.flag("nowait"),
            datagram: options.get("type").and_then(EditorValue::as_str) == Some("datagram"),
        };
        let name = ed.make_network_process(spec)?;
        Ok(ProcObj(ed.process_named(&name).expect("just opened")))
    }

    fn makePipeProcess(ed, options: Fields, filter: Option<EditorValue>, sentinel: Option<EditorValue>) -> ProcObj {
        let spec = e8_core::PipeSpec {
            name: options.string("name").ok_or_else(|| Error::new("A pipe process needs a name"))?,
            buffer: options.string("buffer"),
            filter: handler(filter),
            sentinel: handler(sentinel),
            coding: coding_pair(options.get("coding"))?,
            noquery: options.flag("noquery"),
            stop: options.flag("stop"),
        };
        let name = ed.make_pipe_process(spec)?;
        Ok(ProcObj(ed.process_named(&name).expect("just made")))
    }

    /// The processes, oldest first, as process-list: those running, and
    /// those that have ended until their sentinel has run.
    pub fn processList(ed) -> Vec<ProcObj> {
        Ok(ed.process_ids().into_iter().map(ProcObj).collect())
    }

    /// The process of a name, as get-process; a process is itself.
    pub fn getProcess(ed, process: Proc) -> Option<ProcObj> {
        Ok(match process {
            Proc::Id(id) => Some(ProcObj(id)),
            Proc::Name(name) => ed.process_named(&name).map(ProcObj),
        })
    }

    fn getBufferProcess(ed, buffer: String) -> Option<ProcObj> {
        Ok(ed.buffer_process_id(&buffer).map(ProcObj))
    }

    /// Whether a value is a process, as processp: a process object, listed
    /// or gone; its name is not one.
    #[ts = "(value: unknown): value is Process"]
    pub fn processp(ed, value: EditorValue) -> bool {
        Ok(matches!(value, EditorValue::Process(_)))
    }

    /// Ask, while an agent acts, the user's approval of an effect outside
    /// the editor's buffers, as "run in the shell of *shell*: make", as
    /// starting a program asks it: an error until the user allows it, and
    /// nothing for the user's own commands. For code that sends a program
    /// input that runs, as a Babel session's code.
    pub fn checkPermission(ed, effect: String) {
        ed.check_permission(&effect)
    }

    /// Write to a process's input, encoded in its coding, as process-send-string.
    pub fn processSendString(ed, process: Proc, text: String) {
        let name = process.listed_name(ed)?;
        ed.process_send_string(&name, &text)
    }

    /// Make a process see the end of its input, as process-send-eof: C-d on a terminal, else its input closed.
    pub fn processSendEof(ed, process: Proc) {
        let name = process.listed_name(ed)?;
        ed.process_send_eof(&name)
    }

    /// Kill a process and forget it, as delete-process: its sentinel runs.
    /// One that has gone already is left as it is.
    pub fn deleteProcess(ed, process: Proc) {
        match process {
            Proc::Id(id) => match ed.listed_process_name(id) {
                Some(name) => ed.delete_process(&name),
                None => Ok(()),
            },
            Proc::Name(name) => ed.delete_process(&name),
        }
    }

    /// Whether exiting asks first while the process runs, as set-process-query-on-exit-flag.
    pub fn setProcessQueryOnExitFlag(ed, process: Proc, query: bool) {
        let name = process.listed_name(ed)?;
        ed.set_process_query_on_exit(&name, query)
    }

    /// Wait for output from a process, or any with none named, for up to
    /// `seconds`, or until some comes, as accept-process-output: it goes to
    /// the filters meanwhile, and timers run, but keys wait. Whether output came.
    #[ts = "(process?: ProcessLike, seconds?: number): boolean"]
    pub fn acceptProcessOutput(ed, process: Option<Proc>, seconds: Option<f64>) -> bool {
        // The time the program takes is not the script's.
        match process {
            Some(p) => {
                let id = p.id(ed)?;
                waiting(|| ed.wait_for_process_output_id(Some(id), seconds))
            }
            None => waiting(|| ed.wait_for_process_output_id(None, seconds)),
        }
    }

    /// The rest of process.c's functions on a process, by their Lisp names.
    fn processPrimitive(ed, op: String, process: Proc, args: Rest<EditorValue>) -> EditorValue {
        process_primitive(ed, &op, &process, &args.0)
    }

    /// What can be asked of a process, listed or gone, or undefined for a
    /// name no listed process has.
    fn processInfo(ed, process: Proc) -> Option<Record> {
        let Some(p) = process.id_if_any(ed).and_then(|id| ed.process_info(id)) else { return Ok(None) };
        let code = match p.status {
            e8_core::ProcessStatus::Run => None,
            e8_core::ProcessStatus::Exit(c) | e8_core::ProcessStatus::Signal(c) => Some(c),
        };
        Ok(Some(
            Record::new()
                .with("name", p.name)
                .with("status", p.status_name)
                .with("exitStatus", code)
                .with("buffer", p.buffer)
                .with("mark", p.mark)
                .with("command", p.command)
                .with("pid", p.pid)
                .with("queryOnExit", p.query_on_exit)
                .with("listed", p.listed),
        ))
    }

    /// Give a process a filter, called with the process and each piece of
    /// its output, as set-process-filter: null for the default, which
    /// inserts it at the process mark, and true, as Emacs's t, to hold its
    /// output back until another filter is set. Returns the filter.
    #[ts = "<F extends ((process: Process, output: string) => void) | string | symbol | true | null | undefined>(process: ProcessLike, filter: F): F"]
    pub fn setProcessFilter(ed, process: Proc, filter: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_filter(id, filter.clone());
        Ok(filter)
    }

    /// Give a process a sentinel, called with the process and a word on
    /// what happened, as "finished\n", when its status changes, as
    /// set-process-sentinel: null for the default, a line in its buffer.
    /// Returns the sentinel.
    #[ts = "<F extends ((process: Process, event: string) => void) | string | symbol | null | undefined>(process: ProcessLike, sentinel: F): F"]
    pub fn setProcessSentinel(ed, process: Proc, sentinel: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_sentinel(id, sentinel.clone());
        Ok(sentinel)
    }

    /// A process's filter as set, or null for the default.
    fn processFilterSet(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(ed.process_filter(id).unwrap_or(EditorValue::Null))
    }

    /// A process's sentinel as set, or null for the default.
    fn processSentinelSet(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(ed.process_sentinel(id).unwrap_or(EditorValue::Null))
    }

    /// What a process's filter does by default, as
    /// internal-default-process-filter: the text inserted at the process
    /// mark in its buffer, point moving along if it was there.
    pub fn internalDefaultProcessFilter(ed, process: Proc, text: String) {
        let id = process.id(ed)?;
        ed.internal_default_process_filter(id, &text);
        Ok(())
    }

    /// What a process's sentinel does by default, as
    /// internal-default-process-sentinel: a line "Process NAME EVENT" at the
    /// process mark in its buffer.
    pub fn internalDefaultProcessSentinel(ed, process: Proc, event: String) {
        let id = process.id(ed)?;
        ed.internal_default_process_sentinel(id, &event);
        Ok(())
    }

    /// A process's property list, as process-plist: property and value in turn.
    #[ts = "(process: ProcessLike): Value[]"]
    pub fn processPlist(ed, process: Proc) -> EditorValue {
        let id = process.id(ed)?;
        Ok(match ed.process_plist(id) {
            EditorValue::Null => EditorValue::List(Vec::new()),
            plist => plist,
        })
    }

    /// Replace a process's property list, as set-process-plist. Returns it.
    #[ts = "(process: ProcessLike, plist: Value[]): Value[]"]
    pub fn setProcessPlist(ed, process: Proc, plist: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_plist(id, plist.clone())?;
        Ok(plist)
    }

    /// Run a program with text of the current buffer as its input and wait
    /// for it, as Emacs's call-process-region: the text from `start` to
    /// `end`, within the accessible portion, or the whole buffer for a
    /// `start` of null, or `start` itself if it is a string. `del` deletes
    /// the region first. What the program writes goes where `destination`
    /// says, as call-process's: true for point in the current buffer, null
    /// to throw it away, 0 or another integer to throw it away without waiting, a buffer or
    /// its name for point in that buffer, `[":file", FILE]` for a file, or
    /// `[DESTINATION, STDERR]` to send standard error elsewhere, STDERR
    /// null to throw it away, true to keep it with the output, or a file
    /// name. With `display`, output going into a buffer is shown there
    /// line by line as it comes. Codings are coding-system-for-read and
    /// -write if bound, else process-coding-system-alist's for the
    /// program, else default-process-coding-system's. Returns the exit code, a
    /// description of the signal that ended the program, as "Killed: 9",
    /// or undefined if not waited for. Asks the agent's permission first.
    #[ts = "(start: number | string | null, end: number | null, program: string, del?: boolean | null, destination?: CallProcessDestination, display?: boolean | null, ...args: string[]): number | string | undefined"]
    pub fn callProcessRegion(
        ed,
        start: EditorValue,
        end: EditorValue,
        program: String,
        del: Option<EditorValue>,
        destination: Option<EditorValue>,
        // DISPLAY, then the arguments: one parameter, as QuickJS's
        // functions take at most seven.
        display_and_args: Rest<EditorValue>,
    ) -> Option<EditorValue> {
        let position = |v: &EditorValue| -> e8_core::Result<usize> {
            match v.as_number() {
                Some(n) if n >= 0.0 && n.fract() == 0.0 => Ok(n as usize),
                _ => Err(Error::signal(
                    "wrong-type-argument",
                    format!("Wrong type argument: integer-or-marker-p, {v}"),
                    vec![EditorValue::Symbol("integer-or-marker-p".into()), v.clone()],
                )),
            }
        };
        let input = match &start {
            EditorValue::Null | EditorValue::Bool(false) => e8_core::RegionInput::Whole,
            EditorValue::Str(_) | EditorValue::Text(_) => e8_core::RegionInput::Text(start.as_str().unwrap_or_default().to_string()),
            v => e8_core::RegionInput::Region(position(v)?, position(&end)?),
        };
        let destination = ed.call_destination(destination.as_ref().unwrap_or(&EditorValue::Null))?;
        let mut command = vec![program];
        for arg in display_and_args.0.iter().skip(1) {
            let text = arg.as_str().ok_or_else(|| {
                Error::signal("wrong-type-argument", format!("Wrong type argument: stringp, {arg}"), vec![EditorValue::Symbol("stringp".into()), arg.clone()])
            })?;
            command.push(text.to_string());
        }
        let delete = del.is_some_and(|d| d.is_true());
        let display = display_and_args.0.first().is_some_and(EditorValue::is_true);
        let result = waiting(|| ed.call_process_region(input, delete, &command, &destination, display))?;
        Ok((!result.is_nil()).then_some(result))
    }

    /// Set whether a process's buffer takes on the coding its output is
    /// decoded in, as set-process-inherit-coding-system-flag: E8 keeps the
    /// flag, which decides nothing yet. Returns it.
    pub fn setProcessInheritCodingSystemFlag(ed, process: Proc, flag: EditorValue) -> EditorValue {
        let id = process.id(ed)?;
        ed.set_process_inherit_coding_system_flag(id, flag.is_true());
        Ok(flag)
    }

    /// A process's process-inherit-coding-system-flag: set at its start if
    /// it has a buffer and inherit-process-coding-system is.
    pub fn processInheritCodingSystemFlag(ed, process: Proc) -> bool {
        let id = process.id(ed)?;
        Ok(ed.process_inherit_coding_system_flag(id).unwrap_or(false))
    }

    /// Whether a process on a terminal has given it to a job of its own, as
    /// process-running-child-p: the job's process group id if so,
    /// undefined if not, and true where E8 cannot tell, as for a program
    /// on pipes. An error for a connection or pipe process.
    #[ts = "(process: ProcessLike): number | true | undefined"]
    pub fn processRunningChildP(ed, process: Proc) -> Option<EditorValue> {
        let id = process.id(ed)?;
        let child = ed.process_running_child_p(id)?;
        Ok((!child.is_nil()).then_some(child))
    }

    /// Whether the editor is waiting for the user to type, as
    /// waiting-for-user-input-p: true in a filter, sentinel or timer run
    /// while the command loop waits for a key, false in one run from
    /// acceptProcessOutput or sleepFor, or while a command runs.
    pub fn waitingForUserInputP(ed) -> bool {
        Ok(ed.waiting_for_user_input_p())
    }

    /// The names of the signals this system has, as signal-names: without
    /// "SIG", the highest numbered first, and "EXIT", signal 0, last;
    /// on Linux the real-time ones first, as "RTMAX" and "RTMIN+1".
    /// signalProcess takes each but those.
    pub fn signalNames(ed) -> Vec<String> {
        Ok(e8_core::process::signal_names())
    }

    /// The ids of the processes running on this machine, as
    /// list-system-processes, in increasing order.
    pub fn listSystemProcesses(ed) -> Vec<u32> {
        Ok(e8_core::sysdep::list_system_processes())
    }

    /// What the system says of a process of this machine, as
    /// process-attributes: [KEY, VALUE] pairs, as euid, user, egid, group,
    /// comm, state, ppid, pgrp, ttname, tpgid, majflt, utime, stime, time,
    /// nice, start, etime, vsize, rss, thcount and args, with sess, minflt,
    /// pri, pcpu, pmem and the children's times on Linux. Sizes are in
    /// kilobytes, times in seconds, `start` in seconds since 1970. What the
    /// system will not say of another user's process is left out;
    /// undefined if there is no such process.
    #[ts = "(pid: number): [string, number | string][] | undefined"]
    pub fn processAttributes(ed, pid: f64) -> Option<EditorValue> {
        if pid < 0.0 || pid.fract() != 0.0 || pid > u32::MAX as f64 {
            return Ok(None);
        }
        Ok(e8_core::sysdep::process_attributes(pid as u32).map(|attrs| {
            EditorValue::List(attrs.into_iter().map(|(k, v)| EditorValue::List(vec![EditorValue::Str(k.into()), v])).collect())
        }))
    }

    /// An environment variable's value, as getenv-internal: from `env`, a
    /// list of "NAME=VALUE" strings, if it is one, true for a name listed
    /// alone; else, `env` being a frame or left out, from
    /// process-environment, where a name alone unsets it. Undefined if it
    /// is not set.
    #[ts = "(variable: string, env?: string[] | Frame | null): string | true | undefined"]
    pub fn getenvInternal(ed, variable: String, env: Option<EditorValue>) -> Option<EditorValue> {
        Ok(match &env {
            Some(EditorValue::List(list)) => ed.getenv_internal(&variable, Some(list)),
            _ => ed.getenv_internal(&variable, None),
        })
    }

    /// An address as Emacs writes one, as format-network-address: from
    /// `[a, b, c, d, port]` "a.b.c.d:port", from eight 16-bit words and a
    /// port "[x:x:x:x:x:x:x:x]:port", without the port if left out or with
    /// `omitPort`; a string, a local socket's name, as itself. Undefined
    /// for anything else.
    #[ts = "(address: number[] | string, omitPort?: boolean): string | undefined"]
    pub fn formatNetworkAddress(ed, address: EditorValue, omit_port: Option<bool>) -> Option<String> {
        Ok(format_network_address(&address, omit_port.unwrap_or(false)))
    }

    /// The addresses a host name has, as network-lookup-address-info, each
    /// as Emacs writes one, with a port of 0: only IPv4 or IPv6 ones for a
    /// `family` of "ipv4" or "ipv6", and with `hints` "numeric" only if the
    /// name is itself an address. Undefined if it has none.
    #[ts = "(name: string, family?: \"ipv4\" | \"ipv6\" | null, hints?: \"numeric\" | null): number[][] | undefined"]
    pub fn networkLookupAddressInfo(ed, name: String, family: Option<EditorValue>, hints: Option<EditorValue>) -> Option<Vec<Vec<u32>>> {
        let family = match family.as_ref().filter(|f| !f.is_nil()) {
            None => None,
            Some(f) => match f.as_str() {
                Some("ipv4") => Some(false),
                Some("ipv6") => Some(true),
                _ => return Err(Error::new("Unsupported family")),
            },
        };
        let numeric = match hints.as_ref().filter(|h| !h.is_nil()) {
            None => false,
            Some(h) if h.as_str() == Some("numeric") => true,
            Some(_) => return Err(Error::new("Unsupported hints value")),
        };
        if !name.is_ascii() {
            return Err(Error::new(format!("Non-ASCII hostname {name} detected, please use `puny-encode-domain'")));
        }
        let addresses: Vec<std::net::IpAddr> = if numeric {
            name.parse::<std::net::IpAddr>().into_iter().collect()
        } else {
            use std::net::ToSocketAddrs;
            match (name.as_str(), 0).to_socket_addrs() {
                Ok(found) => found.map(|a| a.ip()).collect(),
                Err(_) => {
                    // Said in the echo area, as Emacs says getaddrinfo's error.
                    if let Some(why) = e8_core::sysdep::lookup_failure(&name) {
                        ed.message(why);
                    }
                    Vec::new()
                }
            }
        };
        let mut out: Vec<Vec<u32>> = Vec::new();
        for ip in addresses {
            if family.is_some_and(|v6| v6 != ip.is_ipv6()) {
                continue;
            }
            let v = address_vector(ip);
            if !out.contains(&v) {
                out.push(v);
            }
        }
        Ok((!out.is_empty()).then_some(out))
    }

    /// The machine's network interfaces' addresses, as network-interface-list:
    /// [NAME, ADDRESS] for each, or with `full` [NAME, ADDRESS, BROADCAST,
    /// NETMASK], each address as Emacs writes one; only IPv4 or IPv6 ones
    /// for a `family` of "ipv4" or "ipv6".
    #[ts = "(full?: boolean | null, family?: \"ipv4\" | \"ipv6\" | null): [string, ...number[][]][]"]
    pub fn networkInterfaceList(ed, full: Option<bool>, family: Option<EditorValue>) -> EditorValue {
        let family = match family.as_ref().filter(|f| !f.is_nil()) {
            None => None,
            Some(f) => match f.as_str() {
                Some("ipv4") => Some(false),
                Some("ipv6") => Some(true),
                _ => return Err(Error::new("Unsupported address family")),
            },
        };
        let vector = |v: &[u32]| EditorValue::List(v.iter().map(|n| EditorValue::Number(*n as f64)).collect());
        Ok(EditorValue::List(
            e8_core::sysdep::network_interfaces()
                .into_iter()
                .filter(|a| family.is_none_or(|v6| v6 == a.ipv6))
                .map(|a| {
                    let mut entry = vec![EditorValue::Str(a.name.clone()), vector(&a.address)];
                    if full.unwrap_or(false) {
                        entry.push(vector(&a.broadcast()));
                        entry.push(vector(&a.netmask));
                    }
                    EditorValue::List(entry)
                })
                .collect(),
        ))
    }

    /// What the system says of a network interface, as
    /// network-interface-info: [ADDRESS, BROADCAST, NETMASK, HARDWARE,
    /// FLAGS], the addresses IPv4 ones as Emacs writes them, HARDWARE its
    /// type and bytes, FLAGS names such as "up" and "loopback", each null
    /// if it has none. Undefined if there is no such interface.
    #[ts = "(ifname: string): [number[] | null, number[] | null, number[] | null, [number, number[]] | null, string[]] | undefined"]
    pub fn networkInterfaceInfo(ed, ifname: String) -> Option<EditorValue> {
        let vector = |v: &[u32]| EditorValue::List(v.iter().map(|n| EditorValue::Number(*n as f64)).collect());
        let opt = |v: Option<Vec<u32>>| v.map_or(EditorValue::Null, |v| vector(&v));
        Ok(e8_core::sysdep::network_interface_info(&ifname).map(|i| {
            EditorValue::List(vec![
                opt(i.address),
                opt(i.broadcast),
                opt(i.netmask),
                i.hardware.map_or(EditorValue::Null, |(kind, bytes)| EditorValue::List(vec![EditorValue::Number(kind as f64), vector(&bytes)])),
                EditorValue::List(i.flags.into_iter().map(|f| EditorValue::Str(f.into())).collect()),
            ])
        }))
    }

    /// Set a socket option on a network connection or server, as
    /// set-network-process-option: `option` is its keyword, ":keepalive",
    /// ":reuseaddr", ":linger" (a number of seconds, or whether), ":broadcast",
    /// ":dontroute" or ":oobinline", with ":priority" and ":bindtodevice" on
    /// Linux, as Emacs's system gives them. True once set, when
    /// processContact gives it by its key; an error for an option the
    /// system has not, or undefined with `noError`.
    #[ts = "(process: ProcessLike, option: string, value: unknown, noError?: boolean | null): true | undefined"]
    pub fn setNetworkProcessOption(ed, process: EditorValue, option: EditorValue, value: EditorValue, no_error: Option<EditorValue>) -> Option<bool> {
        let id = process_arg(&process)?.id(ed)?;
        let option = match &option {
            EditorValue::Str(s) | EditorValue::Symbol(s) => s.clone(),
            v => return Err(wrong_type("symbolp", v)),
        };
        let set = ed.set_network_process_option(id, &option, &value, no_error.is_some_and(|v| v.is_true()))?;
        Ok(set.then_some(true))
    }

    /// The thread a process is locked to, as process-thread: undefined, as
    /// E8 has no Lisp threads, where Emacs gives the thread that made it.
    #[ts = "(process: ProcessLike): undefined"]
    pub fn processThread(ed, process: EditorValue) -> Option<bool> {
        process_arg(&process)?.id(ed)?;
        Ok(None)
    }

    /// Lock a process to a thread, as set-process-thread: E8 has no Lisp
    /// threads, so only null, which unlocks it, is taken, and given back.
    #[ts = "(process: ProcessLike, thread: null | undefined): undefined"]
    pub fn setProcessThread(ed, process: EditorValue, thread: Option<EditorValue>) -> Option<bool> {
        process_arg(&process)?.id(ed)?;
        match thread {
            Some(t) if !t.is_nil() => Err(wrong_type("threadp", &t)),
            _ => Ok(None),
        }
    }

    /// A datagram process's address, as process-datagram-address: where
    /// what it sends goes, as `[a, b, c, d, port]` or eight 16-bit words and
    /// a port for IPv6; undefined for a server not yet heard from, or a
    /// process that sends no datagrams.
    #[ts = "(process: ProcessLike): number[] | undefined"]
    pub fn processDatagramAddress(ed, process: EditorValue) -> Option<Vec<u32>> {
        let id = process_arg(&process)?.id(ed)?;
        Ok(ed.process_datagram_address(id).flatten().map(|addr| {
            let mut v = address_vector(addr.ip());
            *v.last_mut().expect("an address has a port") = addr.port() as u32;
            v
        }))
    }

    /// Set where a datagram process sends to, as
    /// set-process-datagram-address: `address` as processDatagramAddress
    /// gives one, or "host:port". Returns it, or undefined if it is no
    /// address or the process sends no datagrams.
    #[ts = "(process: ProcessLike, address: number[] | string): number[] | string | undefined"]
    pub fn setProcessDatagramAddress(ed, process: EditorValue, address: EditorValue) -> Option<EditorValue> {
        let id = process_arg(&process)?.id(ed)?;
        let addr = match &address {
            EditorValue::List(items) => {
                let n: Option<Vec<u16>> = items.iter().map(|v| v.as_number().filter(|n| n.fract() == 0.0 && (0.0..=65535.0).contains(n)).map(|n| n as u16)).collect();
                match n.as_deref() {
                    Some([a, b, c, d, port]) if [a, b, c, d].iter().all(|x| **x <= 255) => {
                        Some(std::net::SocketAddr::from(([*a as u8, *b as u8, *c as u8, *d as u8], *port)))
                    }
                    Some([w @ .., port]) if w.len() == 8 => {
                        let ip = std::net::Ipv6Addr::new(w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7]);
                        Some(std::net::SocketAddr::from((ip, *port)))
                    }
                    _ => None,
                }
            }
            v => v.as_str().and_then(|s| s.parse().ok()),
        };
        Ok(match addr {
            Some(addr) if ed.set_process_datagram_address(id, addr) => Some(address),
            _ => None,
        })
    }

    /// Interrupt a process, as internal-default-interrupt-process, what
    /// interrupt-process does by default: SIGINT to its process group, or
    /// with `currentGroup` to the job in the foreground on its terminal.
    /// The process is a process, a process's or buffer's name, a buffer, or
    /// null for the current buffer's; an error for one that is not a
    /// program, or has ended. Gives the process.
    #[ts = "(process?: ProcessLike | BufferLike | null, currentGroup?: boolean | null): Process"]
    pub fn internalDefaultInterruptProcess(ed, process: Option<EditorValue>, current_group: Option<EditorValue>) -> ProcObj {
        let id = ed.get_process(&process.unwrap_or(EditorValue::Null))?;
        ed.internal_default_interrupt_process(id, current_group.is_some_and(|v| v.is_true()))?;
        Ok(ProcObj(id))
    }

    /// Send a signal to a process, as internal-default-signal-process,
    /// what signal-process does by default: to its process id alone, as
    /// kill(2) does. The process is a process, a buffer or null for the
    /// current buffer's, a process id, or a string: a process's name, or a
    /// process id written out, else undefined. `sigcode` is a number or a
    /// name, "INT" or "SIGINT". Gives 0 if sent, -1 if not; an error for a
    /// process with no id of its own, as a connection.
    #[ts = "(process: ProcessLike | BufferLike | number | null, sigcode: number | string, remote?: unknown): number | undefined"]
    pub fn internalDefaultSignalProcess(ed, process: EditorValue, sigcode: EditorValue, remote: Option<EditorValue>) -> Option<i32> {
        let _ = remote;
        let integer = |n: f64| (n.fract() == 0.0 && n >= i32::MIN as f64 && n <= i32::MAX as f64).then_some(n as i32);
        let pid = match &process {
            EditorValue::Str(_) | EditorValue::Text(_) => {
                let name = process.as_str().unwrap_or_default();
                match ed.process_named(name) {
                    Some(id) => ed.process_pid_to_signal(id)?,
                    None => match name.parse::<i64>().ok().and_then(|n| i32::try_from(n).ok()) {
                        Some(pid) => Some(pid),
                        None => return Ok(None),
                    },
                }
            }
            EditorValue::Number(n) => Some(integer(*n).ok_or_else(|| wrong_type("integerp", &process))?),
            other => {
                let id = ed.get_process(other)?;
                ed.process_pid_to_signal(id)?
            }
        };
        let signal = match &sigcode {
            EditorValue::Number(n) => integer(*n).ok_or_else(|| wrong_type("fixnump", &sigcode))?,
            EditorValue::Str(name) | EditorValue::Symbol(name) => {
                e8_core::process::signal_number(name).ok_or_else(|| Error::new(format!("Undefined signal name {name}")))?
            }
            v => return Err(wrong_type("symbolp", v)),
        };
        // A process that has ended is not signalled, as its id may be
        // another's by now: as kill(2) on one that has gone.
        Ok(Some(pid.map_or(-1, |pid| e8_core::process::kill_pid(pid, signal))))
    }

    fn makeSerialProcess(ed, args: Fields, filter: Option<EditorValue>, sentinel: Option<EditorValue>) -> Option<ProcObj> {
        let coding = coding_pair(args.get("coding"))?;
        let pairs = args.0.into_iter().map(|(k, v)| (format!(":{k}"), v)).collect();
        Ok(ed.make_serial_process(pairs, handler(filter), handler(sentinel), coding)?.map(ProcObj))
    }

    /// Configure a serial process's port, as serial-process-configure:
    /// `speed` in bits per second, `bytesize` 7 or 8 (null for 8), `parity`
    /// null, "odd" or "even", `stopbits` 1 or 2 (null for 1), and
    /// `flowcontrol` null, "hw" (RTS/CTS) or "sw" (XON/XOFF); what is left
    /// out stays as it was. The process is `process`, or the one named
    /// `name`, writing to `buffer`, or named `port`, or the current
    /// buffer's. Nothing is done to a port made with a `speed` of null.
    #[ts = "(args: { process?: ProcessLike; name?: string; buffer?: BufferLike; port?: string; speed?: number; bytesize?: 7 | 8 | null; parity?: \"odd\" | \"even\" | null; stopbits?: 1 | 2 | null; flowcontrol?: \"hw\" | \"sw\" | null }): void"]
    pub fn serialProcessConfigure(ed, args: Fields) {
        let pairs: Vec<(String, EditorValue)> = args.0.into_iter().map(|(k, v)| (format!(":{k}"), v)).collect();
        ed.serial_process_configure(&pairs)
    }

    /// call-process as Emacs takes it: the program, its input file or
    /// none, DESTINATION, then DISPLAY and the arguments in one, as
    /// QuickJS's functions take at most seven parameters.
    fn callProcessFile(ed, program: String, infile: Option<String>, destination: EditorValue, display_and_args: Rest<EditorValue>) -> Option<EditorValue> {
        let destination = ed.call_destination(&destination)?;
        let mut command = vec![program];
        for arg in display_and_args.0.iter().skip(1) {
            let text = arg.as_str().ok_or_else(|| {
                Error::signal("wrong-type-argument", format!("Wrong type argument: stringp, {arg}"), vec![EditorValue::Symbol("stringp".into()), arg.clone()])
            })?;
            command.push(text.to_string());
        }
        let display = display_and_args.0.first().is_some_and(EditorValue::is_true);
        // The time the program takes is not the script's.
        let result = waiting(|| ed.call_process_file(&command, infile.as_deref(), &destination, display))?;
        Ok((!result.is_nil()).then_some(result))
    }

    fn callProcess(ed, command: Vec<String>, directory: Option<String>, input: Option<String>) -> Record {
        let (code, output) = waiting(|| ed.call_process(&command, directory.as_deref(), input.as_deref()))?;
        Ok(Record::new().with("exit", code).with("output", output))
    }
}

/// An address as Emacs writes one: four bytes, or eight 16-bit words, and a port of 0.
fn address_vector(ip: std::net::IpAddr) -> Vec<u32> {
    let mut v: Vec<u32> = match ip {
        std::net::IpAddr::V4(a) => a.octets().iter().map(|b| *b as u32).collect(),
        std::net::IpAddr::V6(a) => a.segments().iter().map(|w| *w as u32).collect(),
    };
    v.push(0);
    v
}

/// format-network-address, as process.c's: each element a whole number
/// within a byte, or a 16-bit word for IPv6; the port any whole number.
fn format_network_address(address: &EditorValue, omit_port: bool) -> Option<String> {
    let items = match address {
        EditorValue::Str(_) | EditorValue::Text(_) => return address.as_str().map(str::to_string),
        EditorValue::List(items) => items,
        _ => return None,
    };
    let numbers: Vec<i64> = items.iter().map(|v| v.as_number().filter(|n| n.fract() == 0.0).map(|n| n as i64)).collect::<Option<_>>()?;
    let (words, port, max) = match numbers.len() {
        4 => (&numbers[..4], None, 255),
        5 => (&numbers[..4], Some(numbers[4]), 255),
        8 => (&numbers[..8], None, 65535),
        9 => (&numbers[..8], Some(numbers[8]), 65535),
        _ => return None,
    };
    if words.iter().any(|n| !(0..=max).contains(n)) {
        return None;
    }
    // A port beyond 16 bits is no address, as Emacs says, omitted or not.
    if port.is_some_and(|p| !(0..=65535).contains(&p)) {
        return None;
    }
    let port = port.filter(|_| !omit_port);
    Some(if words.len() == 4 {
        let host = words.iter().map(i64::to_string).collect::<Vec<_>>().join(".");
        match port {
            Some(p) => format!("{host}:{p}"),
            None => host,
        }
    } else {
        let host = words.iter().map(|w| format!("{w:x}")).collect::<Vec<_>>().join(":");
        match port {
            Some(p) => format!("[{host}]:{p}"),
            None => host,
        }
    })
}

/// A filter or sentinel as make-process's :filter and :sentinel take it:
/// a function, a name, or for a filter t; nil for the default.
fn handler(value: Option<EditorValue>) -> Option<EditorValue> {
    value.filter(|v| !v.is_nil())
}

/// A process as process.c's CHECK_PROCESS takes one: a process object,
/// or, as E8's functions take one, its name; wrong-type-argument processp
/// for anything else.
fn process_arg(value: &EditorValue) -> e8_core::Result<Proc> {
    match value {
        EditorValue::Process(id) => Ok(Proc::Id(*id)),
        EditorValue::Str(_) | EditorValue::Text(_) => Ok(Proc::Name(value.as_str().unwrap_or_default().to_string())),
        v => Err(wrong_type("processp", v)),
    }
}

fn wrong_type(predicate: &str, value: &EditorValue) -> e8_core::Error {
    Error::signal("wrong-type-argument", format!("Wrong type argument: {predicate}, {value}"), vec![EditorValue::Symbol(predicate.into()), value.clone()])
}

/// A plist kept as pairs, as a script gets one: key and value in turn.
fn flat_plist(pairs: Vec<(String, EditorValue)>) -> EditorValue {
    EditorValue::List(pairs.into_iter().flat_map(|(k, v)| [EditorValue::Str(k), v]).collect())
}

/// The signal a name gives, as signal-process takes them: "SIGINT", "int", or a number.
fn signal_number(value: Option<&EditorValue>) -> Option<i32> {
    match value? {
        EditorValue::Number(n) => Some(*n as i32),
        v => e8_core::process::signal_number(v.as_str()?),
    }
}

fn process_primitive(ed: &mut Editor, op: &str, process: &Proc, args: &[EditorValue]) -> e8_core::Result<EditorValue> {
    let flag = |i: usize| args.get(i).is_some_and(EditorValue::is_true);
    // What can be asked of a process that has gone.
    match op {
        "process-coding-system" => {
            return Ok(match process.id_if_any(ed).and_then(|id| ed.process_coding_system_of(id)) {
                Some((d, e)) => EditorValue::List(vec![EditorValue::Str(d.name()), EditorValue::Str(e.name())]),
                None => EditorValue::Null,
            });
        }
        "process-type" => {
            return Ok(process.id_if_any(ed).and_then(|id| ed.process_info(id)).map_or(EditorValue::Null, |p| EditorValue::Str(p.kind.into())));
        }
        // A signal to a process that has gone does nothing, as to one that has exited.
        "signal-process" | "stop-process" | "continue-process" if matches!(process, Proc::Id(id) if ed.listed_process_name(*id).is_none()) => return Ok(EditorValue::Null),
        _ => {}
    }
    let name = match process {
        Proc::Id(id) => match ed.listed_process_name(*id) {
            Some(name) => name,
            None if matches!(op, "process-tty-name" | "process-contact") => return Ok(EditorValue::Null),
            None => return Err(process.listed_name(ed).expect_err("not listed")),
        },
        Proc::Name(name) => name.clone(),
    };
    let name = name.as_str();
    Ok(match op {
        "set-process-coding-system" => {
            let coding = |i: usize| -> e8_core::Result<e8_core::coding::Coding> {
                let n = args.get(i).and_then(EditorValue::as_str).unwrap_or("undecided");
                e8_core::coding::Coding::parse(n).ok_or_else(|| e8_core::Error::new(format!("Invalid coding system: {n}")))
            };
            ed.set_process_coding_system(name, coding(0)?, coding(1)?)?;
            EditorValue::Null
        }
        "process-tty-name" => ed.process_tty_name(name).map_or(EditorValue::Null, EditorValue::Str),
        // A serial port's: [port, speed], all of it with true, as Emacs's
        // plist, or a part by key.
        "process-contact" if ed.process_named(name).and_then(|id| ed.serial_contact(id)).is_some() => {
            let contact = ed.process_named(name).and_then(|id| ed.serial_contact(id)).unwrap_or_default();
            let get = |key: &str| contact.iter().find(|(k, _)| k == key).map_or(EditorValue::Null, |(_, v)| v.clone());
            match args.first() {
                None | Some(EditorValue::Null) => EditorValue::List(vec![get(":port"), get(":speed")]),
                Some(EditorValue::Bool(true)) => flat_plist(contact),
                Some(key) => get(&format!(":{}", key.as_str().unwrap_or_default().trim_start_matches(':'))),
            }
        }
        "stop-process" | "continue-process" => {
            let id = process.id(ed)?;
            let stop = op == "stop-process";
            // A serial port, connection or pipe process is kept from being
            // read, or read again; a program is signalled.
            if !ed.set_serial_stopped(id, stop) && !ed.set_process_stopped(id, stop) {
                let signal = e8_core::process::signal_number(if stop { "TSTP" } else { "CONT" }).unwrap_or(0);
                ed.signal_process_group(name, signal, flag(0))?;
            }
            EditorValue::Process(id)
        }
        "process-contact" => match ed.process_contact(name) {
            None => EditorValue::Bool(true),
            Some((c, server)) => {
                let s = |x: Option<String>| x.map_or(EditorValue::Null, EditorValue::Str);
                match args.first().and_then(EditorValue::as_str).map(|k| k.trim_start_matches(':')) {
                    None => EditorValue::List(vec![s(c.host), EditorValue::Str(c.service)]),
                    Some("host") => s(c.host),
                    Some("service") => EditorValue::Str(c.service),
                    Some("remote") => s(c.remote),
                    Some("server") => EditorValue::Bool(server),
                    // An option set-network-process-option set.
                    Some(k) => c.options.iter().find(|(o, _)| o.trim_start_matches(':') == k).map_or(EditorValue::Null, |(_, v)| v.clone()),
                }
            }
        },
        "set-process-window-size" => {
            let n = |i: usize| args.get(i).and_then(EditorValue::as_number).unwrap_or(0.0) as u16;
            EditorValue::Bool(ed.set_process_window_size(name, n(0), n(1))?)
        }
        "signal-process" => {
            let signal = signal_number(args.first()).ok_or_else(|| e8_core::Error::new("Undefined signal name"))?;
            ed.signal_process_group(name, signal, flag(1))?;
            EditorValue::Null
        }
        _ => return Err(e8_core::Error::new(format!("No process primitive {op}"))),
    })
}

/// A listed process's name, or nothing for one that has gone: asking a
/// connection that has closed about its TLS answers rather than failing,
/// as Emacs's gnutls-peer-status gives nil for a process with no session.
fn gone_or_name(ed: &e8_core::Editor, process: &Proc) -> Option<String> {
    process.listed_name(ed).ok()
}

/// What GnuTLS's own functions take: bytes, as `string_of_bytes` gives
/// them and `secureHash`'s `binary` does. Text is not bytes until it is
/// encoded, which the caller does, as auth-source encodes before
/// encrypting; saying so beats hashing one encoding where Emacs hashes
/// another.
fn crypto_bytes(s: &str) -> Result<Vec<u8>, e8_core::Error> {
    e8_core::coding::bytes_of_string(s)
        .ok_or_else(|| e8_core::Error::new("GnuTLS takes bytes, and this is text: encode it first, as with encodeCodingString"))
}

/// Forgets a key E8 copied, as gnutls.c clears the string it was given.
fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        // Written through a pointer, so it is not optimised away.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

/// Encrypts or decrypts for the two natives, taking strings of bytes and
/// giving them, as gnutls.c takes and gives unibyte strings.
fn symmetric(encrypting: bool, cipher: &str, key: &str, iv: &str, input: &str, aad: Option<&str>) -> Result<Vec<String>, e8_core::Error> {
    let mut key = crypto_bytes(key)?;
    let made = e8_core::tls::symmetric(encrypting, cipher, &key, &crypto_bytes(iv)?, &crypto_bytes(input)?, &crypto_bytes(aad.unwrap_or(""))?);
    wipe(&mut key);
    let (text, nonce) = made?;
    Ok(vec![e8_core::coding::string_of_bytes(&text), e8_core::coding::string_of_bytes(&nonce)])
}
