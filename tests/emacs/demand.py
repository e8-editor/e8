#!/usr/bin/env python3
"""Which of Emacs's C primitives that E8 lacks real Emacs Lisp calls, and how much.

parity.py counts the primitives E8 has by name; this weighs the missing ones
by demand. Each file of a corpus of Emacs Lisp is read as forms by batch
Emacs (demand.el) with Emacs's own macros expanded, and the calls to each
primitive are counted, per package, so a name in a string or a comment is
not a call. A primitive is also needed by a package that uses a macro or a
small function of subr.el that calls it, when E8 lacks that wrapper by name
too (`save-window-excursion` needs `current-window-configuration`).

The corpus is in three parts, kept apart in the results:

  emacs  the Lisp that ships with Emacs for what E8 has or wants (EMACS_UNITS)
  melpa  MELPA's most downloaded packages, fetched with `fetch` below
  daily  the packages one person's config loads, a directory per package

Run from the repository's root, with a corpus directory outside it:

    python3 tests/emacs/demand.py fetch CORPUS --top 300
    python3 tests/emacs/demand.py count CORPUS            # reads CORPUS/melpa, CORPUS/daily if present
    python3 tests/emacs/demand.py report CORPUS > CORPUS/report.md

`count` writes CORPUS/counts.json; `report` reads it with what E8 has now,
so after E8 gains a primitive only `report` needs running again. Packages
whose licence is neither the GPL nor a permissive one are not read; they
are listed in the report.
"""
import argparse
import collections
import glob
import json
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parity  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# The Emacs corpus: units of Emacs's own Lisp, each a package as a user
# would name it, as globs under lisp-directory.
EMACS_UNITS = {
    "subr": ["subr.el", "subr-x.el"],
    "simple": ["simple.el", "indent.el", "paragraphs.el", "textmodes/fill.el", "newcomment.el", "rect.el", "register.el", "sort.el"],
    "files": ["files.el", "files-x.el", "userlock.el", "autorevert.el", "filenotify.el", "uniquify.el", "saveplace.el", "recentf.el", "savehist.el"],
    "window": ["window.el", "frame.el", "windmove.el", "winner.el", "tab-bar.el", "tab-line.el", "frameset.el", "follow.el"],
    "minibuffer": ["minibuffer.el", "icomplete.el", "completion-preview.el", "mb-depth.el", "minibuf-eldef.el"],
    "isearch": ["isearch.el", "replace.el", "misearch.el", "char-fold.el"],
    "help": ["help.el", "help-fns.el", "help-mode.el", "apropos.el", "descr-text.el", "info.el", "man.el", "woman.el"],
    "buffers": ["buff-menu.el", "ibuffer.el", "ibuf-ext.el", "ibuf-macs.el", "bs.el"],
    "dired": ["dired.el", "dired-aux.el", "dired-x.el", "wdired.el", "find-dired.el", "ls-lisp.el"],
    "font-lock": ["font-lock.el", "jit-lock.el", "font-core.el", "hi-lock.el", "hl-line.el", "whitespace.el", "paren.el", "faces.el", "face-remap.el", "display-line-numbers.el", "display-fill-column-indicator.el"],
    "editing": ["electric.el", "elec-pair.el", "abbrev.el", "dabbrev.el", "hippie-exp.el", "skeleton.el", "thingatpt.el", "imenu.el", "outline.el", "kmacro.el", "macros.el", "repeat.el", "delsel.el", "bookmark.el", "view.el", "so-long.el", "visual-wrap.el"],
    "text-modes": ["textmodes/text-mode.el", "textmodes/ispell.el", "textmodes/flyspell.el", "textmodes/markdown-ts-mode.el", "textmodes/css-mode.el", "textmodes/sgml-mode.el", "textmodes/tex-mode.el"],
    "comint": ["comint.el", "shell.el", "ansi-color.el", "ansi-osc.el", "pcomplete.el"],
    "term": ["term.el"],
    "eshell": ["eshell/*.el"],
    "compile": ["progmodes/compile.el", "progmodes/grep.el", "progmodes/gud.el"],
    "project": ["progmodes/project.el", "fileloop.el"],
    "xref": ["progmodes/xref.el", "progmodes/etags.el"],
    "eglot": ["progmodes/eglot.el", "jsonrpc.el", "external-completion.el"],
    "flymake": ["progmodes/flymake.el", "progmodes/flymake-proc.el"],
    "eldoc": ["emacs-lisp/eldoc.el"],
    "diff": ["vc/diff-mode.el", "vc/diff.el", "vc/smerge-mode.el"],
    "ediff": ["vc/ediff*.el", "vc/emerge.el"],
    "vc": ["vc/vc.el", "vc/vc-*.el", "vc/log-edit.el", "vc/log-view.el", "vc/add-log.el"],
    "tramp": ["net/tramp*.el"],
    "org": ["org/*.el"],
    "calendar": ["calendar/*.el"],
    "treesit": ["treesit.el", "progmodes/*-ts-mode.el", "progmodes/c-ts-common.el", "textmodes/*-ts-mode.el"],
    "prog-modes": ["progmodes/prog-mode.el", "progmodes/elisp-mode.el", "emacs-lisp/lisp-mode.el", "progmodes/python.el", "progmodes/js.el", "progmodes/sh-script.el", "progmodes/ruby-mode.el", "progmodes/which-func.el", "progmodes/hideshow.el", "progmodes/subword.el"],
    "cc-mode": ["progmodes/cc-*.el"],
    "eww": ["net/eww.el", "net/shr.el", "net/browse-url.el", "dom.el"],
    "url": ["url/*.el"],
    "network": ["net/network-stream.el", "net/gnutls.el", "net/nsm.el", "net/puny.el"],
    "auth": ["auth-source.el", "auth-source-pass.el", "password-cache.el", "epa*.el", "epg*.el"],
    "server": ["server.el"],
    "package": ["emacs-lisp/package.el", "emacs-lisp/package-vc.el", "use-package/*.el"],
    "ert": ["emacs-lisp/ert.el", "emacs-lisp/ert-x.el"],
    "edebug": ["emacs-lisp/edebug.el", "emacs-lisp/debug.el", "emacs-lisp/backtrace.el"],
    "which-key": ["which-key.el"],
    "transient": ["transient.el"],
    "image": ["image.el", "image-mode.el", "image/*.el", "doc-view.el", "svg.el"],
    "mouse": ["mouse.el", "mwheel.el", "pixel-scroll.el", "mouse-drag.el", "xt-mouse.el", "touch-screen.el"],
    "custom": ["cus-edit.el", "custom.el", "wid-edit.el", "widget.el", "cus-theme.el", "cus-face.el"],
    "gnus": ["gnus/*.el"],
    "erc": ["erc/*.el"],
    "proced": ["proced.el"],
    "desktop": ["desktop.el"],
    "speedbar": ["speedbar.el"],
    "calc": ["calc/*.el"],
}

SKIP_FILE = re.compile(r"(-pkg|-autoloads|loaddefs|-tests?|-test-helpers?)\.el(\.gz)?$")
SKIP_DIR = re.compile(r"/(tests?|t|examples?|test-files)/")

GPL = re.compile(r"same terms as Emacs|GNU (Affero |Lesser |Library )?General Public License|\bGPL\b|GPLv\d|GPL-\d", re.I)
PERMISSIVE = re.compile(r"MIT License|Permission is hereby granted, free of charge|BSD|ISC License|Apache License|"
                        r"Apache-2|Redistribution and use in source and binary forms|public domain|Unlicense|WTFPL|zlib|CC0", re.I)

# Primitives E8 has under another name, or stands in for otherwise: the
# Emacs name, then where E8 has it. Checked by hand against crates/e8-core,
# crates/e8-script/src/natives and packages/ (see docs/parity/demand.md).
OTHER_NAMES = json.load(open(os.path.join(HERE, "demand-other-names.json")))

# The pieces of work the missing primitives fall into, each landing together.
GROUPS = json.load(open(os.path.join(HERE, "demand-groups.json")))
GROUP_OF = {p: g for g, entry in GROUPS.items() for p in entry["primitives"]}


def lisp_directory():
    out = subprocess.run(["emacs", "-Q", "--batch", "--eval", "(princ lisp-directory)"],
                         capture_output=True, text=True, check=True).stdout
    return out.strip()


def licence(paths):
    """'gpl', 'permissive' or None, from the files' headers and any licence files beside them."""
    text = ""
    for p in paths:
        if p.endswith(".el"):
            with open(p, errors="replace") as f:
                text += f.read(100000)
    for d in {os.path.dirname(p) for p in paths}:
        for name in glob.glob(os.path.join(d, "*")):
            if re.search(r"/(LICEN[CS]E|COPYING)[^/]*$", name, re.I) and os.path.isfile(name):
                with open(name, errors="replace") as f:
                    text += f.read(3000)
    if GPL.search(text):
        return "gpl"
    if PERMISSIVE.search(text):
        return "permissive"
    return None


def package_files(directory):
    files = []
    for root, dirs, names in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            p = os.path.realpath(os.path.join(root, n))
            if (n.endswith(".el") or n.endswith(".el.gz")) and not SKIP_FILE.search(n) \
                    and not SKIP_DIR.search(p[len(directory):] + "/") and os.path.isfile(p):
                files.append(p)
    return sorted(files)


def manifest(corpus_dir):
    """(corpus, package, path) for every file, and the packages not read for their licence."""
    lisp = lisp_directory()
    rows, refused = [], []
    for unit, globs in EMACS_UNITS.items():
        for g in globs:
            for p in sorted(glob.glob(os.path.join(lisp, g + ".gz")) + glob.glob(os.path.join(lisp, g))):
                if not SKIP_FILE.search(p):
                    rows.append(("emacs", unit, p))
    for corpus in ["melpa", "daily"]:
        d = os.path.join(corpus_dir, corpus)
        if not os.path.isdir(d):
            continue
        for package in sorted(os.listdir(d)):
            files = package_files(os.path.realpath(os.path.join(d, package)))
            if not files:
                continue
            if files[0].startswith(lisp) or licence(files):
                rows += [(corpus, package, p) for p in files]
            else:
                refused.append((corpus, package))
    return rows, refused


def fetch(corpus_dir, top):
    """MELPA's TOP most downloaded packages into CORPUS/melpa, a directory each, with their counts."""
    meta = os.path.join(corpus_dir, "melpa-meta")
    os.makedirs(meta, exist_ok=True)
    for name in ["download_counts.json", "archive.json"]:
        if not os.path.exists(os.path.join(meta, name)):
            urllib.request.urlretrieve(f"https://melpa.org/{name}", os.path.join(meta, name))
    counts = json.load(open(os.path.join(meta, "download_counts.json")))
    archive = json.load(open(os.path.join(meta, "archive.json")))
    names = [k for k, _ in sorted(counts.items(), key=lambda kv: -kv[1]) if k in archive][:top]
    out = os.path.join(corpus_dir, "melpa")
    for name in names:
        entry = archive[name]
        version = ".".join(map(str, entry["ver"]))
        dest = os.path.join(out, name)
        if os.path.isdir(dest):
            continue
        os.makedirs(dest)
        if entry["type"] == "tar":
            tmp = dest + ".tar"
            urllib.request.urlretrieve(f"https://melpa.org/packages/{name}-{version}.tar", tmp)
            with tarfile.open(tmp) as t:
                for m in t.getmembers():
                    if m.isfile():
                        m.name = os.path.basename(m.name)
                        t.extract(m, dest, filter="data")
            os.remove(tmp)
        else:
            urllib.request.urlretrieve(f"https://melpa.org/packages/{name}-{version}.el", os.path.join(dest, name + ".el"))
        print(name, file=sys.stderr)
    json.dump({k: {"downloads": counts[k], "deps": sorted(archive[k].get("deps") or {})} for k in names},
              open(os.path.join(corpus_dir, "melpa-top.json"), "w"), indent=0)


def count(corpus_dir, jobs):
    rows, refused = manifest(corpus_dir)
    work = os.path.join(corpus_dir, "work")
    os.makedirs(work, exist_ok=True)
    by_package = collections.OrderedDict()
    for r in rows:
        by_package.setdefault((r[0], r[1]), []).append(r)
    chunks = [[] for _ in range(jobs)]
    sizes = [0] * jobs
    for files in sorted(by_package.values(), key=lambda fs: -sum(os.path.getsize(f[2]) for f in fs)):
        i = sizes.index(min(sizes))
        chunks[i] += files
        sizes[i] += sum(os.path.getsize(f[2]) for f in files)
    procs = []
    for i, chunk in enumerate(chunks):
        m, o = os.path.join(work, f"manifest-{i}.tsv"), os.path.join(work, f"out-{i}.tsv")
        with open(m, "w") as f:
            f.writelines("\t".join(r) + "\n" for r in chunk)
        procs.append(subprocess.Popen(["emacs", "-Q", "--batch", "-l", os.path.join(HERE, "demand.el"), m, o],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for p in procs:
        p.wait()

    calls = collections.defaultdict(collections.Counter)    # (corpus, package) -> primitive -> calls
    lisp_calls = collections.defaultdict(collections.Counter)  # (corpus, package) -> Lisp function -> calls
    macros = collections.defaultdict(collections.Counter)   # (corpus, package) -> macro -> uses
    samples = collections.defaultdict(list)                 # macro -> [functions one use brought, with how often]
    defuns = {}                                             # function -> (file, set of functions it calls)
    errors = collections.Counter()
    requires = collections.defaultdict(set)                 # (corpus, package) -> Emacs libraries required
    for i in range(jobs):
        for line in open(os.path.join(work, f"out-{i}.tsv"), encoding="utf-8", errors="replace"):
            f = line.rstrip("\n").split("\t")
            if f[0] == "C":
                calls[f[1], f[2]][f[3]] += int(f[4])
            elif f[0] == "F":
                lisp_calls[f[1], f[2]][f[3]] += int(f[4])
            elif f[0] == "R":
                requires[f[1], f[2]].add(f[3])
            elif f[0] == "M":
                macros[f[1], f[2]][f[3]] += int(f[4])
            elif f[0] == "X":
                samples[f[1]].append(collections.Counter(x for x in f[2:] if x))
            elif f[0] == "W":
                defuns[f[2]] = (f[1], set(f[3:]))
            elif f[0] == "E":
                errors[f[1], f[2]] += 1
    brought = {}
    for m, s in samples.items():
        common = s[0]
        for c in s[1:]:
            common &= c
        brought[m] = dict(common)
    packages = sorted(set(k for k, _ in by_package.items()))
    result = {
        "packages": [{"corpus": c, "package": p, "files": len(by_package[c, p]),
                      "calls": dict(calls[c, p]), "lisp_calls": dict(lisp_calls[c, p]),
                      "macros": dict(macros[c, p]), "requires": sorted(requires[c, p]), "errors": errors[c, p]} for c, p in packages],
        "refused": refused,
        "macro_brings": brought,
        "wrappers": {name: sorted(fs) for name, (file, fs) in defuns.items()
                     if file.startswith("subr") or name.startswith("internal--")},
    }
    json.dump(result, open(os.path.join(corpus_dir, "counts.json"), "w"))
    print(f"{len(rows)} files in {len(packages)} packages, {len(refused)} packages not read for their licence; "
          f"{sum(errors.values())} forms or files not read or expanded", file=sys.stderr)


def e8_has(names):
    """A predicate: whether E8 has NAME, by Emacs's name or another."""
    return lambda name: name in names or name in OTHER_NAMES


def needs(counts, prims, has):
    """For each package, the primitives E8 lacks that it needs.

    Returns (corpus, package) -> primitive -> (calls, uses through wrappers, {wrapper: uses}).
    Calls are those in the expanded code less those an Emacs macro brought,
    which count as uses through that macro only when E8 lacks the macro too.
    """
    editor = {n for n, (_, kind) in prims.items() if kind != "language"}
    wrappers = counts["wrappers"]

    def resolve(fns, depth=0):
        out = set()
        for fn in fns:
            if fn in editor:
                out.add(fn)
            elif fn in wrappers and depth < 3 and not has(fn):
                out |= resolve(wrappers[fn], depth + 1)
        return out
    brings = {m: resolve(fns) for m, fns in counts["macro_brings"].items() if not has(m)}
    wrapper_prims = {w: resolve(fs) for w, fs in wrappers.items() if not has(w)}
    result = {}
    for pkg in counts["packages"]:
        from_macros = collections.Counter()
        for m, n in pkg["macros"].items():
            for f, k in counts["macro_brings"].get(m, {}).items():
                from_macros[f] += n * k
        direct = {p: max(0, n - from_macros[p]) for p, n in pkg["calls"].items() if p in editor and not has(p)}
        lisp_calls = {f: max(0, n - from_macros[f]) for f, n in pkg["lisp_calls"].items()}
        via = collections.defaultdict(collections.Counter)
        for table, uses in [(brings, pkg["macros"]), (wrapper_prims, lisp_calls)]:
            for w, n in uses.items():
                for p in table.get(w, ()):
                    if not has(p):
                        via[p][w] += n
        ps = {p: (direct.get(p, 0), sum(via[p].values()), dict(via[p])) for p in set(direct) | set(via)}
        result[pkg["corpus"], pkg["package"]] = {p: v for p, v in ps.items() if v[0] or v[1]}
    return result


def missing_wrappers(counts, prims, has):
    """subr.el's functions and Emacs's macros that E8 lacks by name and that bring in a primitive E8 lacks:
    name -> (primitives, corpus -> packages using it)."""
    editor = {n for n, (_, kind) in prims.items() if kind != "language"}
    wrappers = counts["wrappers"]

    def resolve(fns, depth=0):
        out = set()
        for fn in fns:
            if fn in editor and not has(fn):
                out.add(fn)
            elif fn in wrappers and depth < 3 and not has(fn):
                out |= resolve(wrappers[fn], depth + 1)
        return out
    bring = {m: resolve(fns) for m, fns in counts["macro_brings"].items() if not has(m)}
    bring.update({w: resolve(fns) for w, fns in wrappers.items() if not has(w) and not w.startswith("internal--")})
    out = {}
    for pkg in counts["packages"]:
        for name in set(pkg["macros"]) | set(pkg["lisp_calls"]):
            if bring.get(name):
                out.setdefault(name, (bring[name], collections.Counter()))[1][pkg["corpus"]] += 1
    return out


def ported():
    """The packages E8 has ports of, from docs/features.md's e8-editor/e8-NAME links."""
    text = open(os.path.join(HERE, "..", "..", "docs", "features.md")).read()
    return set(re.findall(r"e8-editor/e8-([a-z0-9-]+)", text))


# Libraries that ship with Emacs which E8 stands in for otherwise: the Lisp
# language's own (TypeScript stands in), and those whose work E8 does in its core.
LANGUAGE_LIBRARIES = {
    "cl-lib", "cl-macs", "cl-extra", "cl-seq", "cl-generic", "cl-print", "cl", "subr-x", "seq", "map", "pcase", "rx", "gv",
    "macroexp", "nadvice", "eieio", "eieio-base", "eieio-core", "json", "let-alist", "ring", "thunk", "generator", "inline",
    "bytecomp", "byte-run", "byte-opt", "compat", "easy-mmode", "easymenu", "custom", "derived", "advice", "cus-edit",
    "help-fns", "find-func", "lisp-mnt", "warnings", "timer", "format-spec", "text-property-search", "tabulated-list",
}


def e8_libraries():
    """The features E8's own packages provide."""
    return {os.path.basename(p)[:-3] for p in glob.glob(os.path.join(HERE, "..", "..", "packages", "*.ts"))}


def nearest(corpus_dir, counts, need, top=150):
    """Among MELPA's TOP most downloaded packages that define commands, (name, downloads, primitives missing,
    Emacs libraries missing), counting their MELPA dependencies, fewest missing first."""
    path = os.path.join(corpus_dir, "melpa-top.json")
    if not os.path.exists(path):
        return []
    meta = json.load(open(path))
    own = {p: set(ps) for (c, p), ps in need.items() if c == "melpa"}
    pkgs = {p["package"]: p for p in counts["packages"] if p["corpus"] == "melpa"}
    have = e8_libraries() | LANGUAGE_LIBRARIES

    def closure(name, seen):
        if name in seen or name not in pkgs:
            return set(), set()
        seen.add(name)
        prims, libs = set(own.get(name, ())), {r for r in pkgs[name].get("requires", []) if r not in have}
        for dep in meta.get(name, {}).get("deps", []):
            p, l = closure(dep, seen)
            prims |= p
            libs |= l
        return prims, libs
    names = [n for n in sorted(meta, key=lambda n: -meta[n]["downloads"]) if n in pkgs][:top]
    rows = [(n, meta[n]["downloads"], *closure(n, set())) for n in names if pkgs[n]["calls"].get("interactive", 0) >= 3]
    return sorted(rows, key=lambda r: (len(r[2]) + len(r[3]), -r[1]))


CORPORA = ["emacs", "melpa", "daily"]
WEIGHT = {"emacs": 1, "melpa": 1, "daily": 2}


def report(corpus_dir):
    counts = json.load(open(os.path.join(corpus_dir, "counts.json")))
    prims = {n: (f, kind) for n, f, kind in parity.primitives()}
    names = parity.e8_names()
    has = e8_has(names)
    need = needs(counts, prims, has)
    sizes = collections.Counter(pkg["corpus"] for pkg in counts["packages"])
    rows = collections.defaultdict(lambda: {c: [0, 0, 0] for c in CORPORA})  # prim -> corpus -> [packages, calls, via]
    through = collections.defaultdict(collections.Counter)
    for (c, _), ps in need.items():
        for p, (d, v, ws) in ps.items():
            rows[p][c][0] += 1
            rows[p][c][1] += d
            rows[p][c][2] += v
            through[p].update(ws)

    def score(row):
        return sum(WEIGHT[c] * row[c][0] / sizes[c] for c in CORPORA if sizes[c])
    ranked = sorted(rows, key=lambda p: (-score(rows[p]), p))
    out = []
    w = out.append
    w("# Demand for the primitives E8 lacks\n")
    w("Corpus: " + ", ".join(f"{sizes[c]} {c} packages" for c in CORPORA if sizes[c]) + ".")
    refused = [p for c, p in counts["refused"] if c != "daily"]
    if refused:
        others = len(counts["refused"]) - len(refused)
        w("Not read for their licence: " + ", ".join(refused) + (f", and {others} of the daily corpus." if others else "."))
    w("\nScore: the share of each corpus's packages that need the primitive, directly or through a wrapper E8 also lacks, "
      "summed with weights " + ", ".join(f"{c} {WEIGHT[c]}" for c in CORPORA) +
      ". Each corpus's cell is packages / calls / uses through wrappers; the last column names the wrappers most of those come through.\n")
    w("| # | primitive | C file | score | " + " | ".join(CORPORA) + " | through |")
    w("|---|---|---|---|" + "---|" * len(CORPORA) + "---|")
    for i, p in enumerate(ranked, 1):
        f, kind = prims.get(p, ("?", "?"))
        cells = " | ".join("{} / {} / {}".format(*rows[p][c]) if rows[p][c][0] else "" for c in CORPORA)
        via = ", ".join(f"`{m}`" for m, _ in through[p].most_common(2))
        w(f"| {i} | `{p}` | {f}{' (platform)' if kind == 'platform' else ''} | {score(rows[p]):.2f} | {cells} | {via} |")

    groups = collections.defaultdict(lambda: {c: set() for c in CORPORA})
    for (c, pkg), ps in need.items():
        for p in ps:
            groups[GROUP_OF.get(p, "ungrouped")][c].add(pkg)
    downloads = {}
    if os.path.exists(os.path.join(corpus_dir, "melpa-top.json")):
        downloads = {n: m["downloads"] for n, m in json.load(open(os.path.join(corpus_dir, "melpa-top.json"))).items()}
    alone = collections.defaultdict(list)
    for (c, pkg), ps in need.items():
        gs = {GROUP_OF.get(p, "ungrouped") for p in ps}
        if len(gs) == 1 and c != "daily":
            alone[gs.pop()].append(pkg if c == "melpa" else f"{pkg} (Emacs)")
    w("\n## By piece of work\n")
    w("Packages needing at least one primitive of the group, per corpus, and those for which the group is all they lack "
      "(MELPA's by downloads, then Emacs's own).\n")
    w("| group | needed | score | " + " | ".join(CORPORA) + " | all they lack |")
    w("|---|---|---|" + "---|" * len(CORPORA) + "---|")
    gscore = lambda g: sum(WEIGHT[c] * len(groups[g][c]) / sizes[c] for c in CORPORA if sizes[c])
    for g in sorted(groups, key=lambda g: -gscore(g)):
        members = [p for p in ranked if GROUP_OF.get(p, "ungrouped") == g]
        only = sorted(alone[g], key=lambda n: (n.endswith("(Emacs)"), -downloads.get(n, 0)))
        w(f"| {g} | {len(members)} | {gscore(g):.2f} | " + " | ".join(str(len(groups[g][c])) for c in CORPORA) +
          f" | {len(only)}: " + ", ".join(only[:8]) + " |")

    w("\n## One-liners over what E8 has\n")
    w("Primitives E8 has no function for but a line of its API does (`demand-other-names.json`, `derived`), "
      "scored as above as if they were missing. Ports write them inline; giving them Emacs's names in `subr` "
      "would keep ports closer to the Lisp they follow.\n")
    derived = {n for n, v in OTHER_NAMES.items() if v["how"] == "derived"}
    need_d = needs(counts, prims, lambda n: (n in names or n in OTHER_NAMES) and n not in derived)
    drows = collections.defaultdict(lambda: {c: 0 for c in CORPORA})
    for (c, _), ps in need_d.items():
        for p in ps:
            if p in derived:
                drows[p][c] += 1
    dscore = lambda p: sum(WEIGHT[c] * drows[p][c] / sizes[c] for c in CORPORA if sizes[c])
    w("| primitive | score | " + " | ".join(f"{c} packages" for c in CORPORA) + " | in E8 |")
    w("|---|---|" + "---|" * len(CORPORA) + "---|")
    for p in sorted(drows, key=lambda p: -dscore(p)):
        w(f"| `{p}` | {dscore(p):.2f} | " + " | ".join(str(drows[p][c]) for c in CORPORA) + f" | {OTHER_NAMES[p]['e8']} |")

    mw = missing_wrappers(counts, prims, has)
    w("\n## Wrappers from subr.el and Emacs's macros that E8 lacks by name\n")
    w("Those whose expansion or body calls a primitive E8 lacks: packages using each, per corpus, and the primitives it brings.\n")
    w("| wrapper | " + " | ".join(CORPORA) + " | brings |")
    w("|---|" + "---|" * len(CORPORA) + "---|")
    for name in sorted(mw, key=lambda n: -sum(WEIGHT[c] * mw[n][1][c] / sizes[c] for c in CORPORA if sizes[c]))[:40]:
        w(f"| `{name}` | " + " | ".join(str(mw[name][1][c] or "") for c in CORPORA) + " | " +
          ", ".join(f"`{p}`" for p in sorted(mw[name][0])) + " |")

    w("\n## MELPA packages nearest to needing nothing E8 lacks\n")
    w("Among MELPA's 150 most downloaded, those defining commands (three or more `interactive` forms), with the primitives "
      "and the libraries shipped with Emacs each still needs, its MELPA dependencies' included, fewest first. "
      "Those E8 has ported already are marked.\n")
    w("| package | downloads | primitives missing | libraries missing | ported |")
    w("|---|---|---|---|---|")
    for name, downloads, missing, libs in nearest(corpus_dir, counts, need)[:30]:
        w(f"| {name} | {downloads:,} | " + ", ".join(f"`{p}`" for p in sorted(missing)) + " | " +
          ", ".join(f"`{p}`" for p in sorted(libs)) + f" | {'yes' if name in ported() else ''} |")

    unused = sorted(n for n, (f, kind) in prims.items() if kind == "editor" and not has(n) and n not in rows)
    w(f"\n## Missing and needed by nothing in the corpus ({len(unused)})\n")
    w(", ".join(f"`{n}`" for n in unused))
    print("\n".join(out))
    json.dump({"ranked": [{"name": p, "file": prims.get(p, ("?",))[0], "group": GROUP_OF.get(p, "ungrouped"),
                           "score": round(score(rows[p]), 4), **rows[p]} for p in ranked],
               "unused": unused,
               "groups": {g: {c: sorted(v) for c, v in groups[g].items()} for g in groups},
               "needs": {f"{c}/{p}": {k: [v[0], v[1]] for k, v in ps.items()} for (c, p), ps in need.items()}},
              open(os.path.join(corpus_dir, "ranked.json"), "w"), indent=0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["fetch", "count", "report"])
    ap.add_argument("corpus")
    ap.add_argument("--top", type=int, default=300)
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    a = ap.parse_args()
    if a.command == "fetch":
        fetch(a.corpus, a.top)
    elif a.command == "count":
        count(a.corpus, a.jobs)
    else:
        report(a.corpus)


if __name__ == "__main__":
    main()
