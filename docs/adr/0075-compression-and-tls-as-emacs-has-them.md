# 0075. Compression and TLS as Emacs has them: zlib, symbol-file, and gnutls

Status: accepted · 2026-11-13

## Context

Measured again on 2026-11-13, after mouse events ([docs/parity/demand.md](../parity/demand.md)), zlib and TLS are the most needed group of missing primitives (0.48). Almost all of that demand is one call:

- `symbol-file`, which E8 lacks by name, calls `zlib-available-p`. Through it, ten of Emacs's libraries, eleven MELPA packages and six daily ones need zlib: consult, marginalia, helpful, smex and pkg-info among them. For fourteen packages it is all they lack.
- `zlib-decompress-region` is used to read compressed data: package archives, `url` responses, `.el.gz` files.
- The `gnutls-*` functions are needed by Emacs's own `gnutls.el`, `network-stream.el`, `url`, ERC, Gnus and `nsm.el`.
  - `gnutls-available-p` and `gnutls-boot` make encrypted connections.
  - `gnutls-peer-status` and its kin describe the peer's certificate, for the Network Security Manager.
  - `gnutls-hash-digest`, `gnutls-hash-mac` and `gnutls-symmetric-encrypt` give hashes, MACs and ciphers.

E8's network processes are TCP and local sockets, with no TLS. The agent's HTTPS goes through `ureq` in its own crate.

## Options considered

1. **TLS from a system library**, as Emacs links GnuTLS: OpenSSL or the platform's own (Security.framework, SChannel) through `native-tls`. The behaviour differs by platform, the dependency is a system one, and there is no web build.
2. **TLS in Rust, with rustls**, already in the workspace through `ureq`. It verifies certificates against the system's roots (`rustls-native-certs`), and needs no system library at build time.

For compression there is one choice: `flate2`, already in the core through `resvg`, on the pure-Rust `miniz_oxide`.

## Decision

Option 2, as Mark approved on 2026-11-13: TLS is a network dependency of `e8-core`, which CLAUDE.md asks about first. The work lands in three pull requests, each behind `make check`, a review against the C files and the ported packages' tests.

1. **Compression and `symbol-file`.**
   - `zlib-available-p` is always true.
   - `zlib-decompress-region` decompresses gzip and zlib data as decompress.c does: as far as zlib reads, the checksums checked, and ALLOW-PARTIAL's count of bytes left as zlib leaves them.
     - E8's buffers are all multibyte, so the region's characters are taken as bytes: ASCII, raw bytes, and characters below 256.
     - What comes out goes in as ASCII and raw bytes, which `decode-coding-region` decodes.
   - `symbol-file` names the file that defined a function, variable or face, from what E8 records as each is defined. Functions made with `e8.defun` now record theirs, as commands, variables and faces already did.
     - A package E8 ships names its file in E8's source (`packages/files.ts`). A file of one's own gives its absolute name.
2. **TLS connections.**
   - `gnutls-boot` on a network process, and `makeNetworkProcess`'s `tls` option, as `:tls-parameters` is.
   - Certificates are verified against the system's roots, as `gnutls-verify-error` and the trust files ask.
   - `gnutls-peer-status`, `gnutls-peer-status-warning-describe` and `gnutls-format-certificate` describe the peer.
   - `gnutls-bye`, `gnutls-deinit`, `gnutls-get-initstage`, `gnutls-errorp`, `gnutls-error-string` and `gnutls-asynchronous-parameters`.
   - `gnutls-available-p` lists what the build has.
   - On the web, which has no sockets, `gnutls-available-p` is nil.
3. **Hashes and ciphers.** `gnutls-digests`, `gnutls-macs`, `gnutls-ciphers`, `gnutls-hash-digest`, `gnutls-hash-mac`, `gnutls-symmetric-encrypt` and `gnutls-symmetric-decrypt`, with the algorithms rustls's crypto provider gives.

## Consequences

- Consult, marginalia, helpful and the other packages that call `symbol-file` lack nothing more from this group.
- Compressed data can be read once it is in a buffer. Visiting `.gz` files as Emacs's `auto-compression-mode` does is not part of this.
- E8 can talk to servers that need TLS, IRC, IMAP and HTTPS among them, through Emacs's own Lisp for them.
- `e8-core` depends on rustls, and through it on its crypto provider.

## Dependencies introduced

- `flate2`, already built into the core through `resvg`, made a direct dependency for decompressing.
- `rustls` and `rustls-native-certs` (stage 2), for TLS connections verified against the system's certificates.
