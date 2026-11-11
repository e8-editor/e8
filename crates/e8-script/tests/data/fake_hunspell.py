#!/usr/bin/env python3
"""A stand-in for Hunspell, for ispell.ts's tests: it answers -vv, -D and
ispell's pipe mode, -a, as Hunspell does, from the NAME.dic word lists
beside it, one word a line, taking several dictionaries as -d en_US,sv_SE.
Each run's arguments are appended to args.log beside it, and words saved
with # to the -p file."""

import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "args.log"), "a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\n")

VERSION = "@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.2)"
names = sorted(f[:-4] for f in os.listdir(here) if f.endswith(".dic"))

if "-vv" in args:
    print(VERSION)
    sys.exit(0)

if "-D" in args:
    # Hunspell lists where it looked and what it found on standard error.
    err = sys.stderr
    err.write("SEARCH PATH:\n" + here + "\n")
    err.write("AVAILABLE DICTIONARIES (path is not mandatory for -d option):\n")
    for name in names:
        err.write(os.path.join(here, name) + "\n")
    err.write("LOADED DICTIONARY:\n" + os.path.join(here, "en_US.aff") + "\n" + os.path.join(here, "en_US.dic") + "\n")
    sys.exit(0)

dicts = names[:1]
if "-d" in args:
    dicts = args[args.index("-d") + 1].split(",")
pdict = args[args.index("-p") + 1] if "-p" in args else None
known = set()
for name in dicts:
    with open(os.path.join(here, name + ".dic"), encoding="utf-8") as f:
        known.update(line.strip().lower() for line in f if line.strip())

SUGGESTIONS = {"speling": ["spelling", "spieling"], "wrod": ["word", "prod"], "helo": ["hello", "help"]}

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
print(VERSION, flush=True)
terse = False
inserted = []
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if line == "" or line == "\x1a":
        continue
    c = line[0]
    if c == "!":
        terse = True
    elif c == "%":
        terse = False
    elif c == "@":
        known.add(line[1:].lower())
    elif c == "*":
        known.add(line[1:].lower())
        inserted.append(line[1:])
    elif c == "#":
        if pdict is not None and inserted:
            with open(pdict, "a", encoding="utf-8") as f:
                f.write("".join(w + "\n" for w in inserted))
        inserted = []
    elif c in "+-~$":
        pass
    else:
        text = line[1:] if c == "^" else line
        for m in re.finditer(r"[^\W\d_]+(?:'[^\W\d_]+)?", text):
            word = m.group(0)
            offset = m.start() + (1 if c == "^" else 0)
            if word.lower() in known:
                if not terse:
                    print("*")
            elif word.lower() in SUGGESTIONS:
                s = SUGGESTIONS[word.lower()]
                print(f"& {word} {len(s)} {offset}: {', '.join(s)}")
            else:
                print(f"# {word} {offset}")
        print(flush=True)
