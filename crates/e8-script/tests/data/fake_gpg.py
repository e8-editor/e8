#!/usr/bin/env python3
"""A stand-in for GnuPG, for the tests of epg.ts and org-crypt.ts.

It speaks the part of gpg's protocol EasyPG uses: --with-colons listings
of its configuration and its keys, and encryption and decryption with
status lines on --status-fd 1 and answers read from --command-fd 0. Its
"encryption" is base64 of the UTF-8 text in PGP armor, so the tests can
read it back, and the same armor batch Emacs's stubbed epg-encrypt-string
writes for the comparisons. Encrypting to keys puts a Comment header
naming them. With --pinentry-mode loopback it asks for passphrases with
GET_HIDDEN, as gpg 2.1 and later do; otherwise it asks nothing, as if
its agent's pinentry had. The passphrase for symmetric text is "secret".

Each run appends its arguments, as a JSON list, to gpg.log beside this
program, and each passphrase it reads, as bytes, to passphrases.log.

It also says what real gpg says that EasyPG passes over (KEY_CONSIDERED,
PINENTRY_LAUNCHED, DECRYPTION_KEY, PLAINTEXT_LENGTH); answers text
encrypted to keys it has none of with NO_SECKEY and DECRYPTION_FAILED;
refuses an expired key with INV_RECP 0, as gpg 2 does; and, with a file
named no-output beside it, fails after BEGIN_ENCRYPTION, removing its
output file.
"""

import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
ARGS = sys.argv[1:]

with open(os.path.join(HERE, "gpg.log"), "a") as log:
    log.write(json.dumps(ARGS) + "\n")

# The keyring: each key's primary id, subkey id, user id, and whether
# encrypting to it works.
KEYS = [
    ("0123456789ABCDEF", "FEDCBA9876543210", "Alice Example <alice@example.org>", True, "1111"),
    ("ABCDABCDABCDABCD", "DCBADCBADCBADCBA", "Bob \\x3a Builder <bob@example.org>", True, "2222"),
    ("EEEEEEEEEEEEEEEE", "FFFFFFFFFFFFFFFF", "Old Key <expired@example.org>", False, "3333"),
]


def status(line):
    sys.stdout.write("[GNUPG:] " + line + "\n")
    sys.stdout.flush()


def option(name):
    if name in ARGS:
        return ARGS[ARGS.index(name) + 1]
    return None


def matches(name, key):
    if name == "":
        return False
    primary, sub, uid = key[0], key[1], key[2]
    return name.lower() in uid.lower() or primary.endswith(name.upper()) or sub.endswith(name.upper())


def list_keys():
    names = [ARGS[i + 1] for i, a in enumerate(ARGS) if a in ("--list-keys", "--list-secret-keys") and i + 1 < len(ARGS)]
    secret = "--list-secret-keys" in ARGS
    for key in KEYS:
        if names and not any(matches(n, key) for n in names):
            continue
        if not names:
            pass
        primary, sub, uid, ok, fpr = key
        validity = "u" if ok else "e"
        print(f"{'sec' if secret else 'pub'}:{validity}:255:22:{primary}:1700000000:{'' if ok else '1710000000'}::u:::scESC:::::ed25519:::0:")
        print(f"fpr:::::::::{fpr * 10}:")
        print(f"uid:{validity}::::1700000000::HASH::{uid}::::::::::0:")
        print(f"{'ssb' if secret else 'sub'}:{validity}:255:18:{sub}:1700000000::::::e:::::cv25519::")
        print(f"fpr:::::::::{fpr[::-1] * 10}:")
    return 0


def read_passphrase():
    status("GET_HIDDEN passphrase.enter")
    line = sys.stdin.buffer.readline()
    with open(os.path.join(HERE, "passphrases.log"), "ab") as log:
        log.write(line)
    status("GOT_IT")
    return line.rstrip(b"\n").decode("utf-8", "replace")


def armor(plain, recipients):
    b64 = base64.b64encode(plain).decode()
    lines = [b64[i : i + 64] for i in range(0, len(b64), 64)] or [""]
    header = f"Comment: to {' '.join(recipients)}\n" if recipients else ""
    return "-----BEGIN PGP MESSAGE-----\n" + header + "\n" + "\n".join(lines) + "\n-----END PGP MESSAGE-----\n"


def loopback():
    return option("--pinentry-mode") == "loopback"


def ask_passphrase_symmetric():
    """Asks for a passphrase as gpg does for symmetric text: through E8 with
    loopback, else through the agent's pinentry, which says it started."""
    if loopback():
        status("NEED_PASSPHRASE_SYM 9 3 2")
        return read_passphrase()
    status("PINENTRY_LAUNCHED 4242 curses 1.2.1 - xterm - - 501/20 0")
    return "secret"


def encrypt():
    recipients = [ARGS[i + 1] for i, a in enumerate(ARGS) if a == "-r"]
    if "--symmetric" in ARGS:
        ask_passphrase_symmetric()
    else:
        for r in recipients:
            key = next((k for k in KEYS if r in (k[0], k[1])), None)
            if key is not None:
                status(f"KEY_CONSIDERED {key[4] * 10} 0")
            if key is None:
                status(f"INV_RECP 1 {r}")
            elif not key[3]:
                # An expired key, as gpg 2 says of it: unusable, for no reason it gives.
                status(f"INV_RECP 0 {r}")
            else:
                continue
            status("FAILURE encrypt 53")
            sys.stderr.write(f"gpg: {r}: skipped: Unusable public key\n")
            return 2
    status("BEGIN_ENCRYPTION 2 9")
    plain = sys.stdin.buffer.read()
    output = option("--output")
    if os.path.exists(os.path.join(HERE, "no-output")):
        # Failing partway, gpg removes what it had begun to write.
        os.remove(output)
        status("FAILURE encrypt 1")
        sys.stderr.write("gpg: [stdin]: encryption failed: General error\n")
        return 2
    with open(output, "w") as out:
        out.write(armor(plain, recipients))
    status("END_ENCRYPTION")
    return 0


def decrypt():
    cipher = open(ARGS[ARGS.index("--") + 1]).read()
    lines = cipher.split("\n")
    if not lines or lines[0] != "-----BEGIN PGP MESSAGE-----":
        status("NODATA 1")
        status("NODATA 2")
        sys.stderr.write("gpg: no valid OpenPGP data found.\n")
        return 2
    headers = lines[1 : lines.index("")]
    body = lines[lines.index("") + 1 :]
    b64 = "".join(body[: next(i for i, l in enumerate(body) if l.startswith("-----END"))])
    to = [h[len("Comment: to ") :].split() for h in headers if h.startswith("Comment: to ")]
    if to:
        held = None
        for r in to[0]:
            key = next((k for k in KEYS if r in (k[0], k[1])), None)
            status(f"ENC_TO {key[1] if key else r} 18 0")
            if key is not None:
                status(f"KEY_CONSIDERED {key[4] * 10} 0")
                held = held or key
        if held is None:
            # No secret key for any of them, as gpg says.
            for r in to[0]:
                status(f"NO_SECKEY {r}")
            status("BEGIN_DECRYPTION")
            status("DECRYPTION_FAILED")
            status("END_DECRYPTION")
            sys.stderr.write("gpg: decryption failed: No secret key\n")
            return 2
        if loopback():
            status(f"USERID_HINT {held[1]} {held[2].replace(' ', '%20', 1)}")
            status(f"NEED_PASSPHRASE {held[1]} {held[0]} 18 0")
            read_passphrase()
        status(f"DECRYPTION_KEY {held[4][::-1] * 10} {held[4] * 10} u")
    elif ask_passphrase_symmetric() != "secret":
        status("ERROR symkey_decrypt.maybe_error 11_Bad_passphrase")
        status("BEGIN_DECRYPTION")
        status("DECRYPTION_FAILED")
        status("END_DECRYPTION")
        sys.stderr.write("gpg: decryption failed: Bad session key\n")
        return 2
    plain = base64.b64decode(b64)
    status("BEGIN_DECRYPTION")
    status("DECRYPTION_INFO 2 9 0")
    status("PLAINTEXT 62 0")
    status(f"PLAINTEXT_LENGTH {len(plain)}")
    with open(option("--output"), "wb") as out:
        out.write(plain)
    status("DECRYPTION_OKAY")
    status("GOODMDC")
    status("END_DECRYPTION")
    return 0


def main():
    if "--list-config" in ARGS:
        print("cfg:version:2.4.5")
        print("cfg:pubkey:1;16;17;18;19;22")
        print("cfg:cipher:2;3;4;7;8;9;10;11;12;13")
        return 0
    if "--list-keys" in ARGS or "--list-secret-keys" in ARGS:
        return list_keys()
    if "--decrypt" in ARGS:
        return decrypt()
    if "--symmetric" in ARGS or "--encrypt" in ARGS:
        return encrypt()
    sys.stderr.write("fake gpg: nothing to do\n")
    return 2


sys.exit(main())
