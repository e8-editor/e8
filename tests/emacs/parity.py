#!/usr/bin/env python3
"""How many of Emacs's C primitives E8 has under Emacs's own name.

Lists Emacs's primitives (`subr-primitive-p`) with the C file that defines
each (`help-C-file-name`) from batch Emacs, and matches them by name against
E8's commands and script functions (packages/e8.d.ts, camelCase read
as kebab-case), e8-core's functions and the functions packages define
or export.
Primitives of the Lisp language and of platforms E8 stands in for
otherwise are counted apart. Run from the repository's root:

    python3 tests/emacs/parity.py
"""
import collections
import glob
import re
import subprocess

LISP = r"""(progn (require 'help-fns)
  (mapatoms (lambda (s)
    (when (and (fboundp s) (subr-primitive-p (symbol-function s)))
      (princ (format "%s\t%s\n" s (or (ignore-errors (help-C-file-name (symbol-function s) 'subr)) "?")))))))"""
LANGUAGE = {"data.c", "fns.c", "eval.c", "alloc.c", "lread.c", "print.c", "floatfns.c", "bytecode.c", "comp.c", "pdumper.c",
            "emacs-module.c", "thread.c", "json.c", "profiler.c", "timefns.c", "doc.c"}
PLATFORM = {"nsfns.m", "nsselect.m", "nsmenu.m", "xwidget.c", "gnutls.c", "sqlite.c", "fontset.c", "term.c", "terminal.c",
            "kqueue.c", "decompress.c", "xml.c", "menu.c", "sysdep.c", "emacs.c", "ccl.c"}


def kebab(name):
    if re.search(r"[a-z]P$", name):
        name = name[:-1] + "-p"
    return re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", name).lower()


def e8_names():
    names = set()
    dts = open("packages/e8.d.ts").read()
    commands = re.search(r"interface Commands \{(.*?)\n    \}", dts, re.S).group(1)
    names |= set(re.findall(r'^\s+"([^"]+)": ', commands, re.M))
    names |= {kebab(f) for f in re.findall(r"^\s+function (\w+)", dts, re.M)}
    for path in glob.glob("crates/e8-core/src/*.rs"):
        names |= {f.replace("_", "-") for f in re.findall(r"pub(?:\(crate\))? fn (\w+)", open(path).read())}
    for path in glob.glob("packages/*.ts"):
        text = open(path).read()
        names |= set(re.findall(r'e8\.defun\("([^"]+)"', text))
        names |= {kebab(f) for f in re.findall(r"^export (?:async )?function (\w+)", text, re.M)}
    return names


def primitives():
    """Emacs's primitives, as (name, C file, kind), kind being language, platform or editor."""
    out = subprocess.run(["emacs", "-Q", "--batch", "--eval", LISP], capture_output=True, text=True, check=True).stdout
    result = []
    for line in out.splitlines():
        if "\t" in line:
            name, path = line.split("\t")
            f = path.replace("src/", "")
            result.append((name, f, "language" if f in LANGUAGE else "platform" if f in PLATFORM else "editor"))
    return result


def main():
    prims = primitives()
    names = e8_names()
    totals = collections.Counter()
    by_file = collections.defaultdict(lambda: [0, 0])
    for name, f, kind in prims:
        totals[kind, name in names] += 1
        if kind == "editor":
            by_file[f][0] += 1
            by_file[f][1] += name in names
    print(f"{len(prims)} primitives")
    for kind in ["language", "platform", "editor"]:
        have, lack = totals[kind, True], totals[kind, False]
        print(f"  {kind:9} {have + lack:5}, {have:4} under Emacs's name ({100 * have / (have + lack):.0f}%)")
    for f, (n, have) in sorted(by_file.items(), key=lambda kv: -kv[1][0]):
        print(f"    {f:16} {have:3} of {n:3}")


if __name__ == "__main__":
    main()
