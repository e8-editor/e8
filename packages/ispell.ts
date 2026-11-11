// Spell checking with an external checker, after Emacs's ispell.el: M-$
// checks the word at point, ispell-region and ispell-buffer go through
// text asking about each misspelling, and flyspell.ts checks as you type.
// The checker is aspell, ispell, hunspell or enchant-2, whichever is found
// first, run in ispell's pipe mode, `-a`. Its dictionaries are found as
// ispell.el finds them, and Hunspell takes several at once, as
// "en_US,sv_SE" (ispell-hunspell-add-multi-dic).
//
// ispell.el keeps one checker running where it can, and runs it afresh for
// each check where it cannot, replaying the session's settings and accepted
// words each time; E8 always does the latter, which takes a few
// milliseconds a check. Words inserted into the personal dictionary are
// kept for the session until it is saved, as with a running checker.
//
// Copyright (C) 1994-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { queryReplaceUntilDone as queryReplace } from "replace";
import { allMatches, executableFind, forwardLine, regexpQuote, truthy } from "subr";

// Values as Lisp has them: symbols, and the slots of a dictionary's entry.

const sym = (name: string): symbol => e8.intern(name);
/** Whether a value is the symbol `name`, or the string, as a config may write it. */
function isSym(value: e8.Value | undefined, name: string): boolean {
  return typeof value === "symbol" ? e8.symbolName(value) === name : value === name;
}
const v = (name: string): e8.Value | undefined => e8.variable(name);
const str = (name: string): string | undefined => {
  const x = v(name);
  return typeof x === "string" ? x : undefined;
};
const set = (name: string, value: e8.Value): void => e8.setVariable(name, value);
const list = (value: e8.Value | undefined): e8.Value[] => (Array.isArray(value) ? value : []);

const defvar = (name: string, value: e8.Value, doc: string, local = false) => e8.defineVariable({ name, value, doc, local });

/** A dictionary's entry: (NAME CASECHARS NOT-CASECHARS OTHERCHARS MANY-OTHERCHARS-P ISPELL-ARGS EXTENDED-CHARACTER-MODE CHARACTER-SET). */
type Dict = e8.Value[];

// Options, as ispell.el's defcustoms.

defvar("ispell-highlight-p", sym("block"), "Whether spelling errors are highlighted; `block' on a terminal with a block cursor.");
defvar("ispell-lazy-highlight", true, "Whether other occurrences of the misspelled word are highlighted too, as isearch highlights matches.");
defvar("ispell-highlight-face", sym("isearch"), "The face the misspelled word is highlighted with.");
defvar("ispell-check-comments", true, "Whether comments are checked: t, nil, or `exclusive' to check only comments.");
defvar("ispell-query-replace-choices", false, "Whether a correction is made throughout the region with query-replace.");
defvar("ispell-skip-tib", false, "Whether `tib' bibliography references, [. to .], are skipped.");
defvar("ispell-tib-ref-beginning", "[[<]\\.", "Regexp matching the beginning of a Tib reference.");
defvar("ispell-tib-ref-end", "\\.[]>]", "Regexp matching the end of a Tib reference.");
defvar("ispell-keep-choices-win", true, "Whether the *Choices* window stays for the whole spelling session.");
defvar("ispell-choices-win-default-height", 2, "The *Choices* window's height to start with, including its mode line.");
defvar(
  "ispell-program-name",
  ["aspell", "ispell", "hunspell", "enchant-2"].map((p) => executableFind(p)).find((p) => p !== undefined) ?? "ispell",
  "The spell checker M-$ and ispell-region run: aspell, ispell, hunspell or enchant-2, the first of them found.",
);
defvar(
  "ispell-alternate-dictionary",
  ["/usr/dict/web2", "/usr/share/dict/web2", "/usr/dict/words", "/usr/lib/dict/words", "/usr/share/dict/words", "/usr/share/lib/dict/words", "/sys/dict"]
    .find((f) => e8.fileReadableP(f)) ?? null,
  "A plain list of words, for looking words up with `l' and ispell-complete-word.",
);
defvar("ispell-complete-word-dict", null, "A plain list of words for ispell-complete-word, when it differs from ispell-alternate-dictionary.");
defvar("ispell-message-dictionary-alist", [], "Pairs (REGEXP . DICTIONARY) choosing a message's dictionary from its headers.");
defvar("ispell-grep-command", "grep", "The grep program that looks words up.");
defvar("ispell-grep-options", "-Ei", "The options ispell-grep-command is given.");
defvar("ispell-look-command", executableFind("look") ?? null, "The look program that looks words up, as an absolute file name.");
defvar("ispell-look-p", v("ispell-look-command") !== null && e8.fileExistsP(String(v("ispell-look-command"))), "Whether look is used rather than grep.");
defvar("ispell-have-new-look", false, "Whether look takes the -r option.");
defvar("ispell-look-options", "-df", "The options ispell-look-command is given.");
defvar("ispell-use-ptys-p", false, "Whether the checker talks through a pseudo-terminal; E8 always uses pipes.");
defvar("ispell-following-word", false, "Whether M-$ checks the word after point, rather than before it, when point is not on one.");
defvar("ispell-help-in-bufferp", false, "Where `?' shows help: nil in the echo area, t in a buffer for a while, `electric' in a buffer until a key.");
defvar("ispell-quietly", false, "Whether M-$ says nothing when the word is right.");
defvar("ispell-format-word-function", sym("upcase"), "The function a word is shown with in messages.");
defvar("ispell-use-framepop-p", false, "Whether the choices show in a frame of their own; E8 always shows them in a window.");
defvar("ispell-personal-dictionary", null, "Your personal dictionary's file, or nil for the checker's own.");
defvar("ispell-silently-savep", false, "Whether the personal dictionary is saved without asking.");
defvar("ispell-local-dictionary-overridden", false, "Whether this buffer's dictionary was set with ispell-change-dictionary.", true);
defvar("ispell-local-dictionary", null, "This buffer's dictionary, overriding ispell-dictionary; nil for that.", true);
defvar("ispell-dictionary", null, "The dictionary to check with when a buffer names none; nil for the checker's default.");
defvar("ispell-extra-args", [], "More arguments for the checker, as (\"-W\" \"3\").");
defvar("ispell-skip-html", sym("use-mode-name"), "Whether HTML and SGML markup is skipped: t, nil, or `use-mode-name' to tell by the major mode.", true);
defvar("ispell-local-dictionary-alist", [], "Your own dictionary entries, in the form of ispell-dictionary-alist, overriding its.");
defvar("ispell-help-timeout", 5, "How many seconds `?' shows its help.");

// The dictionaries ispell.el knows, before those the checker has are found.
const BASE: Dict[] = ([
  [null, "[A-Za-z]", "[^A-Za-z]", "[']", false, ["-B"], null, "iso-8859-1"],
  ["american", "[A-Za-z]", "[^A-Za-z]", "[']", false, ["-B"], null, "iso-8859-1"],
  ["brasileiro", "[A-ZÁÉÍÓÚÀÈÌÒÙÃÕÇÜÂÊÔa-záéíóúàèìòùãõçüâêô]", "[^A-ZÁÉÍÓÚÀÈÌÒÙÃÕÇÜÂÊÔa-záéíóúàèìòùãõçüâêô]", "[']", false, [], null, "iso-8859-1"],
  ["british", "[A-Za-z]", "[^A-Za-z]", "[']", false, ["-B"], null, "iso-8859-1"],
  ["castellano", "[A-ZÁÉÍÑÓÚÜa-záéíñóúü]", "[^A-ZÁÉÍÑÓÚÜa-záéíñóúü]", "[-]", false, ["-B"], "~tex", "iso-8859-1"],
  ["castellano8", "[A-ZÁÉÍÑÓÚÜa-záéíñóúü]", "[^A-ZÁÉÍÑÓÚÜa-záéíñóúü]", "[-]", false, ["-B", "-d", "castellano"], "~latin1", "iso-8859-1"],
  ["czech", "[A-Za-zÁÉĚÍÓÚŮÝŽŠČŘĎŤŇáéěíóúůýžščřďťň]", "[^A-Za-zÁÉĚÍÓÚŮÝŽŠČŘĎŤŇáéěíóúůýžščřďťň]", "", false, ["-B"], null, "iso-8859-2"],
  ["dansk", "[A-ZÆØÅa-zæøå]", "[^A-ZÆØÅa-zæøå]", "[']", false, ["-C"], null, "iso-8859-1"],
  ["deutsch", "[a-zA-Z\"]", "[^a-zA-Z\"]", "[']", true, ["-C"], "~tex", "iso-8859-1"],
  ["deutsch8", "[a-zA-ZÄÖÜäößü]", "[^a-zA-ZÄÖÜäößü]", "[']", true, ["-C", "-d", "deutsch"], "~latin1", "iso-8859-1"],
  ["english", "[A-Za-z]", "[^A-Za-z]", "[']", false, ["-B"], null, "iso-8859-1"],
  ["esperanto", "[A-Za-zĤĴĥĵĈĜŜŬĉĝŝŭ]", "[^A-Za-zĤĴĥĵĈĜŜŬĉĝŝŭ]", "[-']", true, ["-C"], "~latin3", "iso-8859-3"],
  ["esperanto-tex", "[A-Za-z^\\]", "[^A-Za-z^\\]", "[-'`\"]", true, ["-C", "-d", "esperanto"], "~tex", "iso-8859-3"],
  ["finnish", "[A-Za-zåäöÅÄÖ]", "[^A-Za-zåäöÅÄÖ]", "[:]", false, ["-C"], "~list", "iso-8859-1"],
  ["francais7", "[A-Za-z]", "[^A-Za-z]", "[`'^-]", true, [], null, "iso-8859-1"],
  ["francais", "[A-Za-zÀÂÆÇÈÉÊËÎÏÔÙÛÜàâçèéêëîïôùûü]", "[^A-Za-zÀÂÆÇÈÉÊËÎÏÔÙÛÜàâçèéêëîïôùûü]", "[-'.@]", true, [], "~list", "iso-8859-1"],
  ["francais-tex", "[A-Za-zÀÂÆÇÈÉÊËÎÏÔÙÛÜàâçèéêëîïôùûü\\]", "[^A-Za-zÀÂÆÇÈÉÊËÎÏÔÙÛÜàâçèéêëîïôùûü\\]", "[-'^`\".@]", true, [], "~tex", "iso-8859-1"],
  ["german", "[a-zA-Z\"]", "[^a-zA-Z\"]", "[']", true, ["-C"], "~tex", "iso-8859-1"],
  ["german8", "[a-zA-ZÄÖÜäößü]", "[^a-zA-ZÄÖÜäößü]", "[']", true, ["-C", "-d", "german"], "~latin1", "iso-8859-1"],
  ["italiano", "[A-ZÀÁÈÉÌÍÒÓÙÚa-zàáèéìíóùú]", "[^A-ZÀÁÈÉÌÍÒÓÙÚa-zàáèéìíóùú]", "[-.]", false, ["-B", "-d", "italian"], "~tex", "iso-8859-1"],
  ["nederlands", "[A-Za-zÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜàáâãäåçèéêëìíîïñòóôõöùúûü]", "[^A-Za-zÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜàáâãäåçèéêëìíîïñòóôõöùúûü]", "[']", true, ["-C"], null, "iso-8859-1"],
  ["nederlands8", "[A-Za-zÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜàáâãäåçèéêëìíîïñòóôõöùúûü]", "[^A-Za-zÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜàáâãäåçèéêëìíîïñòóôõöùúûü]", "[']", true, ["-C"], null, "iso-8859-1"],
  ["norsk", "[A-Za-zÅÆÇÈÉÒÔØåæçèéòôø]", "[^A-Za-zÅÆÇÈÉÒÔØåæçèéòôø]", "[\"]", false, [], "~list", "iso-8859-1"],
  ["norsk7-tex", "[A-Za-z{}\\'^`]", "[^A-Za-z{}\\'^`]", "[\"]", false, ["-d", "norsk"], "~plaintex", "iso-8859-1"],
  ["polish", "[A-Za-zĄŁŚŹŻąłśźżĆĘŃÓćęńó]", "[^A-Za-zĄŁŚŹŻąłśźżĆĘŃÓćęńó]", "[.]", false, [], null, "iso-8859-2"],
  ["portugues", "[a-zA-ZÁÂÇÉÓàáâéêíóãçú]", "[^a-zA-ZÁÂÇÉÓàáâéêíóãçú]", "[']", true, ["-C"], "~latin1", "iso-8859-1"],
  ["russian", "[абвгдеёжзийклмнопрстуфхцчшщьыъэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯ]", "[^абвгдеёжзийклмнопрстуфхцчшщьыъэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯ]", "", false, [], null, "koi8-r"],
  ["russianw", "[АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯабвгдеёжзийклмнопрстуфхцчшщьыъэюя]", "[^АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯабвгдеёжзийклмнопрстуфхцчшщьыъэюя]", "", false, [], null, "windows-1251"],
  ["slovak", "[A-Za-zÁÄÉÍÓÚÔŔĹĽÝŽŠČĎŤŇáäéíóúôŕĺľýžščďťň]", "[^A-Za-zÁÄÉÍÓÚÔŔĹĽÝŽŠČĎŤŇáäéíóúôŕĺľýžščďťň]", "", false, ["-B"], null, "iso-8859-2"],
  ["slovenian", "[A-Za-zÁÄÉÍÓÚÔŔĹĽÝŽŠČĎŤŇáäéíóúôŕĺľýžščďťň]", "[^A-Za-zÁÄÉÍÓÚÔŔĹĽÝŽŠČĎŤŇáäéíóúôŕĺľýžščďťň]", "", false, ["-B", "-d", "slovenian"], null, "iso-8859-2"],
  ["svenska", "[A-Za-zåäöéàüèæøçÅÄÖÉÀÜÈÆØÇ]", "[^A-Za-zåäöéàüèæøçÅÄÖÉÀÜÈÆØÇ]", "[']", false, ["-C"], "~list", "iso-8859-1"],
  ["hebrew", "[אבגדהוזחטיכךלמםנןסעפףצץקרשת]", "[^אבגדהוזחטיכךלמםנןסעפףצץקרשת]", "", false, ["-B"], null, "cp1255"],
] as [string | null, string, string, string, boolean, string[], string | null, string][]).map((d) => [...d.slice(0, 7), sym(d[7])]);

defvar("ispell-dictionary-base-alist", BASE, "The dictionaries ispell.el knows, before the checker's own are found.");
defvar(
  "ispell-dictionary-alist",
  [],
  "Each dictionary and how to check with it: (NAME CASECHARS NOT-CASECHARS OTHERCHARS MANY-OTHERCHARS-P ISPELL-ARGS " +
    "EXTENDED-CHARACTER-MODE CHARACTER-SET). CASECHARS is a regexp of the characters words are made of; OTHERCHARS of " +
    "those that join them, as the apostrophe in \"they're\", once in a word unless MANY-OTHERCHARS-P.",
);
defvar("ispell-really-aspell", null, "Aspell's version, when the checker is Aspell.");
defvar("ispell-really-hunspell", null, "Hunspell's version, when the checker is Hunspell.");
defvar("ispell-really-enchant", null, "Enchant's version, when the checker is Enchant.");
defvar("ispell-encoding8-command", null, "The checker's option choosing the text's encoding: --encoding= for Aspell, -i for Hunspell.");
defvar(
  "ispell-dicts-name2locale-equivs-alist",
  [
    ["american", "en_US"], ["brasileiro", "pt_BR"], ["british", "en_GB"], ["castellano", "es_ES"], ["castellano8", "es_ES"],
    ["czech", "cs_CZ"], ["dansk", "da_DK"], ["deutsch", "de_DE"], ["deutsch8", "de_DE"], ["english", "en_US"],
    ["esperanto", "eo"], ["esperanto-tex", "eo"], ["finnish", "fi_FI"], ["francais7", "fr_FR"], ["francais", "fr_FR"],
    ["francais-tex", "fr_FR"], ["german", "de_DE"], ["german8", "de_DE"], ["italiano", "it_IT"], ["nederlands", "nl_NL"],
    ["nederlands8", "nl_NL"], ["norsk", "nn_NO"], ["norsk7-tex", "nn_NO"], ["polish", "pl_PL"], ["portugues", "pt_PT"],
    ["russian", "ru_RU"], ["russianw", "ru_RU"], ["slovak", "sk_SK"], ["slovenian", "sl_SI"], ["svenska", "sv_SE"],
    ["hebrew", "he_IL"],
  ],
  "The locale each of ispell.el's dictionary names stands for, as Hunspell and Enchant name them.",
);
defvar("ispell-library-directory", null, "Where the checker keeps its dictionaries, when it says.");
defvar("ispell-process", null, "Whether a spelling session is running: t while one is.");
defvar("ispell-async-processp", false, "Whether the checker keeps running between checks; in E8 it is run afresh for each.");
defvar("ispell-aspell-dictionary-alist", [], "Aspell's dictionaries, as found.");
defvar("ispell-aspell-data-dir", null, "Aspell's data directory.");
defvar("ispell-aspell-dict-dir", null, "Aspell's dictionary directory.");
defvar("ispell-hunspell-dict-paths-alist", [], "Each Hunspell dictionary found and its affix file.");
defvar("ispell-hunspell-dictionary-alist", [], "Hunspell's dictionaries, as found, filled in when first used.");
defvar("ispell-enchant-dictionary-alist", [], "Enchant's dictionaries, as found.");
defvar("ispell-last-program-name", null, "The checker the dictionaries were last found for.");
defvar("ispell-current-dictionary", null, "The dictionary the session checks with, nil for the default.");
defvar("ispell-current-personal-dictionary", null, "The personal dictionary the session uses, nil for the default.");
defvar("ispell-pdict-modified-p", null, "Whether the personal dictionary has changes to save; a list while only the session's words changed.");
defvar("ispell-process-directory", null, "The directory the checker runs in.");
defvar("ispell-filter", [], "The checker's last output, a line each.");
defvar("ispell-checking-message", null, "Whether a mail message is being checked.");
defvar("ispell-words-keyword", "LocalWords: ", "The keyword before the words a file accepts.");
defvar("ispell-dictionary-keyword", "Local IspellDict: ", "The keyword before the dictionary a file is checked with; the last one counts.");
defvar("ispell-pdict-keyword", "Local IspellPersDict: ", "The keyword before the personal dictionary a file is checked with; the last one counts.");
defvar("ispell-parsing-keyword", "Local IspellParsing: ", "The keyword before how a file is parsed: latex-mode, nroff-mode, or ~ and an extended character mode.");
defvar(
  "ispell-skip-region-alist",
  [
    [sym("ispell-words-keyword"), sym("forward-line")],
    [sym("ispell-dictionary-keyword"), sym("forward-line")],
    [sym("ispell-pdict-keyword"), sym("forward-line")],
    [sym("ispell-parsing-keyword"), sym("forward-line")],
    ["^---*BEGIN PGP [A-Z ]*--*", "^---*END PGP [A-Z ]*--*"],
    ["^begin [0-9][0-9][0-9] [^ \t]+$", "\nend\n"],
    ["^%!PS-Adobe-[123].0", "\n%%EOF\n"],
    ["^---* \\(Start of \\)?[Ff]orwarded [Mm]essage", "^---* End of [Ff]orwarded [Mm]essage"],
  ],
  "Where regions not to check start and end: (KEY) skips the key, (KEY REGEXP) to the end of REGEXP, and " +
    "(KEY FUNCTION ARGS...) to where FUNCTION leaves point. A key or REGEXP may be a variable holding the regexp.",
);
defvar(
  "ispell-tex-skip-alists",
  [
    [
      ["\\\\addcontentsline", sym("ispell-tex-arg-end"), 2],
      ["\\\\add\\(tocontents\\|vspace\\)", sym("ispell-tex-arg-end")],
      ["\\\\\\([aA]lph\\|arabic\\)", sym("ispell-tex-arg-end")],
      ["\\\\cref", sym("ispell-tex-arg-end")],
      ["\\\\bibliographystyle", sym("ispell-tex-arg-end")],
      ["\\\\makebox", sym("ispell-tex-arg-end"), 0],
      ["\\\\e?psfig", sym("ispell-tex-arg-end")],
      ["\\\\document\\(class\\|style\\)", "\\\\begin[ \t\n]*{document}"],
    ],
    [
      ["\\(figure\\|table\\)\\*?", sym("ispell-tex-arg-end"), 0],
      ["list", sym("ispell-tex-arg-end"), 2],
      ["program", "\\\\end[ \t]*{program}"],
      ["verbatim\\*?", "\\\\end[ \t]*{verbatim\\*?}"],
    ],
  ],
  "The regions TeX mode skips: the first list as they are, the second with each key inside \\begin{}.",
);
defvar(
  "ispell-html-skip-alists",
  [
    ["<[cC][oO][dD][eE]\\>[^>]*>", "</[cC][oO][dD][eE]*>"],
    ["<[sS][cC][rR][iI][pP][tT]\\>[^>]*>", "</[sS][cC][rR][iI][pP][tT]>"],
    ["<[aA][pP][pP][lL][eE][tT]\\>[^>]*>", "</[aA][pP][pP][lL][eE][tT]>"],
    ["<[vV][eE][rR][bB]\\>[^>]*>", "<[vV][eE][rR][bB]\\>[^>]*>"],
    ["<[tT][tT]/", "/"],
    ["<[^ \t\n>]", ">"],
    ["&[^ \t\n;]", "[; \t\n]"],
  ],
  "The regions HTML buffers skip, as ispell-skip-region-alist.",
);
defvar("ispell-local-pdict", v("ispell-personal-dictionary") ?? null, "This buffer's personal dictionary.", true);
defvar("ispell-buffer-local-name", null, "The buffer whose local words the session has.");
defvar("ispell-buffer-session-localwords", [], "The words accepted for the session in this buffer.", true);
defvar("ispell-parser", sym("use-mode-name"), "How text is parsed: `tex', or `use-mode-name' to use TeX for modes named so; otherwise nroff.");
defvar("ispell-check-only", false, "Whether ispell-word only says a word is wrong, rather than offering corrections.");
e8.defineHook("ispell-update-post-hook", "Run in the command loop before asking about a misspelling.");
e8.defineHook("ispell-kill-ispell-hook", "Run when the spelling session ends, as flyspell does to forget what it was told.");
e8.defineHook("ispell-change-dictionary-hook", "Run after the dictionary changes.");
e8.defineHook("ispell-initialize-spellchecker-hook", "Run when a checker is first used, before ispell-dictionary-alist is made.");
e8.defineHook("ispell-minor-mode-hook", "Run when ispell-minor-mode turns on or off.");

const CHOICES = "*Choices*";

// Running the checker.

/** Runs a program the way ispell-call-process does, from a directory that is there. */
function callChecker(command: string[], input?: string, directory?: string): { exit: number; output: string } {
  const program = command[0];
  if (executableFind(program) === undefined) e8.signal("file-missing", `Searching for program: No such file or directory, ${program}`);
  let dir = directory ?? String(v("default-directory") ?? "~/");
  if (!e8.fileAccessibleDirectoryP(dir)) dir = e8.expandFileName("~/");
  return e8.callProcess(command, { directory: dir, ...(input === undefined ? {} : { input }) });
}

/** Whether version `a` is no later than `b`, as version<=. */
function versionLe(a: string, b: string): boolean {
  const pa = a.split(/[.\-_+ ]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.\-_+ ]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

/**
 * Makes sure the checker is there and new enough, learning which it really
 * is, as ispell-check-version: interactively, says and returns its version
 * line; otherwise returns where it keeps its dictionaries, if it says.
 */
export function checkVersion(interactive = false): string | null {
  const program = String(v("ispell-program-name"));
  const { exit, output } = callChecker([program, "-vv"], undefined, String(v("temporary-file-directory") ?? "/tmp/"));
  let result: string | null = null;
  if (interactive) {
    result = output.split("\n")[0];
    e8.message(result);
  } else {
    result = /LIBDIR = "(.+?)"/.exec(output)?.[1] ?? null;
    const libvar = /LIBRARYVAR = "(.+?)"/.exec(output)?.[1];
    if (libvar !== undefined) {
      const value = e8.getenv(libvar);
      if (value !== undefined && value !== "") result = value;
    }
  }
  if (exit !== 0) e8.signal("error", `${program} exited with code ${exit}`);
  const version = /([0-9]+\.[0-9.]+)/.exec(output)?.[1] ?? "0";
  const really = (name: string) => new RegExp(`\\(but really ${name} ([0-9]+\\.[0-9.]+(?:[-._+ ]?[a-zA-Z0-9]+)?)?\\)`).exec(output)?.[1] ?? null;
  set("ispell-really-aspell", null);
  set("ispell-really-hunspell", null);
  set("ispell-really-enchant", null);
  set("ispell-encoding8-command", null);
  const aspell = really("Aspell");
  const hunspell = aspell === null ? really("Hunspell") : null;
  const enchant = aspell === null && hunspell === null ? really("Enchant") : null;
  set("ispell-really-aspell", aspell);
  set("ispell-really-hunspell", hunspell);
  set("ispell-really-enchant", enchant);
  const minver = !versionLe("3.1.12", version)
    ? "3.1.12"
    : aspell !== null && !versionLe("0.60", aspell)
      ? "0.60"
      : enchant !== null && !versionLe("2.1.0", enchant)
        ? "2.1.0"
        : undefined;
  if (minver !== undefined) e8.signal("error", `${program} release ${minver} or greater is required`);
  if (aspell !== null) set("ispell-encoding8-command", "--encoding=");
  else if (hunspell !== null) {
    if (versionLe("1.1.6", hunspell)) set("ispell-encoding8-command", "-i");
    else set("ispell-really-hunspell", null);
  }
  return result;
}

/** A file's text, or undefined if it cannot be read. */
function readText(file: string): string | undefined {
  if (!e8.fileReadableP(file)) return undefined;
  const buffer = e8.getBufferCreate(" *ispell-file*");
  return e8.withCurrentBuffer(buffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => e8.deleteRegion(e8.pointMin(), e8.pointMax()));
    e8.insertFileContents(file);
    const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    return text;
  });
}

/** A regexp matching any of some characters, as regexp-opt makes for single characters. */
function charsRegexp(chars: string[]): string {
  const unique = [...new Set(chars)].sort();
  if (unique.length === 0) return "";
  if (unique.length === 1) return regexpQuote(unique[0]);
  const hasBracket = unique.includes("]");
  const hasDash = unique.includes("-");
  const hasCaret = unique.includes("^");
  const rest = unique.filter((c) => c !== "]" && c !== "-" && c !== "^");
  return `[${hasBracket ? "]" : ""}${rest.join("")}${hasCaret ? "^" : ""}${hasDash ? "-" : ""}]`;
}

/** Whether an entry's slot holds something, as a Lisp value that is not nil. */
const filled = (x: e8.Value | undefined): boolean => x !== undefined && x !== null && x !== false && !(Array.isArray(x) && x.length === 0);

const assoc = (key: e8.Value, alist: e8.Value[]): Dict | undefined =>
  alist.find((e) => Array.isArray(e) && e[0] === key) as Dict | undefined;

// Aspell's dictionaries.

function aspellConfig(key: string): string | undefined {
  return callChecker([String(v("ispell-program-name")), "config", key]).output.split(/\s+/).find((s) => s !== "");
}

/** An Aspell dictionary's entry, from its data file, as ispell-aspell-find-dictionary. */
function aspellFindDictionary(name: string): Dict | undefined {
  if (v("ispell-aspell-dict-dir") === null) set("ispell-aspell-dict-dir", aspellConfig("dict-dir") ?? null);
  if (v("ispell-aspell-data-dir") === null) set("ispell-aspell-data-dir", aspellConfig("data-dir") ?? null);
  let dataFile: string | undefined;
  search: for (const dir of [str("ispell-aspell-dict-dir"), str("ispell-aspell-data-dir")]) {
    for (const re of [/^\p{L}+/u, /^[\p{L}_]+/u, /^\p{L}+-(alt|old)/u]) {
      const file = `${dir}/${re.exec(name)?.[0] ?? ""}.dat`;
      if (e8.fileReadableP(file)) {
        dataFile = file;
        break search;
      }
    }
  }
  if (dataFile === undefined) return undefined;
  const otherchars: string[] = [];
  const special = /^special(.*)$/m.exec(readText(dataFile) ?? "")?.[1].split(/\s+/).filter((s) => s !== "") ?? [];
  for (let i = 0; i + 1 < special.length; i += 2) if (special[i + 1][1] === "*") otherchars.unshift(special[i]);
  return [name, "[[:alpha:]]", "[^[:alpha:]]", charsRegexp(otherchars), true, ["-d", name], null, sym("utf-8")];
}

/** Adds Aspell's aliases, and ispell.el's names for its locales, as ispell-aspell-add-aliases. */
function aspellAddAliases(alist: Dict[]): Dict[] {
  const dir = str("ispell-aspell-dict-dir") ?? aspellConfig("dict-dir");
  if (dir !== undefined) set("ispell-aspell-dict-dir", dir);
  const files = dir !== undefined && e8.fileAccessibleDirectoryP(dir) ? e8.directoryFiles(dir, { full: true, match: "\\.alias\\'" }) : [];
  for (const file of files) {
    const m = /^add ([^.]+)\.multi/m.exec(readText(file) ?? "");
    if (!m) continue;
    const alias = e8.fileNameNondirectory(file).replace(/\.[^.]*$/, "");
    const real = assoc(m[1], alist);
    if (real && !assoc(alias, alist)) alist.unshift([alias, ...real.slice(1)]);
  }
  for (const [name, locale] of list(v("ispell-dicts-name2locale-equivs-alist")) as [string, string][]) {
    const found = assoc(locale, alist);
    if (!assoc(name, alist) && found) alist.unshift([name, ...found.slice(1)]);
  }
  return alist;
}

let aspellFound: Dict[] = [];

/** Finds Aspell's dictionaries, as ispell-find-aspell-dictionaries. */
function findAspellDictionaries(): void {
  const names = callChecker([String(v("ispell-program-name")), "dicts"]).output.split(/\s+/).filter((s) => s !== "");
  let found = names.map(aspellFindDictionary).filter((d): d is Dict => d !== undefined);
  found = aspellAddAliases(found);
  aspellFound = [...found];
  for (const dict of list(v("ispell-dictionary-base-alist")) as Dict[]) if (!assoc(dict[0], found)) found.push(dict);
  set("ispell-aspell-dictionary-alist", [[null, "[[:alpha:]]", "[^[:alpha:]]", "[']", false, ["-B"], null, sym("utf-8")], ...found]);
}

// Hunspell's dictionaries.

/** Fills the entry of a Hunspell dictionary, and those sharing its affix file, as ispell-hunspell-fill-dictionary-entry. */
function hunspellFillDictionaryEntry(dict: string): void {
  const entry = assoc(dict, list(v("ispell-dictionary-alist")));
  if (entry && filled(entry[1])) {
    e8.message(`ispell-hfde: Non void entry for ${dict}. Skipping.\n`);
    return;
  }
  const equivs = list(v("ispell-dicts-name2locale-equivs-alist")) as [string, string][];
  const alias = equivs.find((e) => e[0] === dict)?.[1];
  const useFor = [dict];
  const rest = parseHunspellAffixFile(dict).slice(1);
  const alist = list(v("ispell-dictionary-alist")) as Dict[];
  for (const e of equivs) {
    if (e.includes(dict) || (alias !== undefined && e.includes(alias))) {
      for (const d of e) {
        const existing = assoc(d, alist);
        if (!(existing && filled(existing[1])) && !useFor.includes(d)) useFor.unshift(d);
      }
    }
  }
  set("ispell-dictionary-alist", alist.map((e) => (useFor.includes(e[0] as string) ? [e[0], ...rest] : e)));
}

/** A Hunspell dictionary's entry, from its affix files; DICT may be several, "DICT1,DICT2", as ispell-parse-hunspell-affix-file. */
function parseHunspellAffixFile(dictKey: string): Dict {
  const paths = list(v("ispell-hunspell-dict-paths-alist")) as [string, string][];
  const otherchars: string[] = [];
  const names: string[] = [];
  let first = true;
  for (const key of dictKey.split(",").filter((s) => s !== "")) {
    const affix = paths.find((p) => p[0] === key)?.[1];
    if (affix === undefined) e8.signal("error", `ispell-phaf: No matching entry for ${key} in ‘ispell-hunspell-dict-paths-alist’.\n`);
    if (first && !e8.fileExistsP(affix)) e8.signal("error", `ispell-phaf: File "${affix}" not found.\n`);
    first = false;
    const wordchars = /^WORDCHARS +(.*)$/m.exec(readText(affix) ?? "")?.[1];
    if (wordchars !== undefined) {
      for (const ch of wordchars.split(/ +/)[0]) if (ch !== " " && !otherchars.includes(ch)) otherchars.unshift(ch);
    }
    names.push(e8.fileNameNondirectory(affix).replace(/\.[^.]*$/, ""));
  }
  return [dictKey, "[[:alpha:]]", "[^[:alpha:]]", charsRegexp(otherchars), true, ["-d", names.join(",")], null, sym("utf-8")];
}

/** Finds Hunspell's dictionaries, as ispell-find-hunspell-dictionaries: returns the default one. */
function findHunspellDictionaries(dictionary?: string): string {
  const { output } = callChecker([String(v("ispell-program-name")), "-D", ...(dictionary ? ["-d", dictionary] : []), "-a", "/dev/null"]);
  const found = output.split(/[\n\r]+/).filter((line) => {
    if (/^Can't open affix or dictionary files for dictionary named "default".$/.test(line)) {
      e8.userError(`Hunspell error (is $LANG unset?): ${line}`);
    }
    return e8.fileNameAbsoluteP(line);
  });
  let paths = list(v("ispell-hunspell-dict-paths-alist")) as [string, string][];
  let defaultDict: [string, string] | undefined;
  let multiDict: string | undefined;
  for (const dict of found) {
    const basename = e8.fileNameNondirectory(dict).replace(/\.[^.]*$/, "");
    if (/\.aff$/.test(dict)) {
      if (defaultDict) multiDict = `${multiDict ?? defaultDict[0]},${basename}`;
      else defaultDict = [basename, dict];
    } else if (!paths.some((p) => p[0] === basename) && e8.fileExistsP(`${dict}.aff`)) {
      paths = [[basename, e8.expandFileName(`${dict}.aff`)], ...paths];
    }
  }
  // An alias goes when a dictionary of its own name is found.
  let equivs = (list(v("ispell-dicts-name2locale-equivs-alist")) as [string, string][]).filter((e) => !paths.some((p) => p[0] === e[0]));
  set("ispell-dicts-name2locale-equivs-alist", equivs);
  const excluded = ["esperanto-tex", "francais7", "francais-tex", "norsk7-tex"];
  for (const [key, value] of equivs) {
    const affix = paths.find((p) => p[0] === value)?.[1];
    if (affix !== undefined && !paths.some((p) => p[0] === key) && !excluded.includes(key)) paths = [[key, affix], ...paths];
  }
  set("ispell-hunspell-dict-paths-alist", paths);
  let defaultName = multiDict ?? defaultDict?.[0];
  if (defaultName === undefined && dictionary === undefined && str("ispell-dictionary") !== undefined) {
    defaultName = findHunspellDictionaries(str("ispell-dictionary"));
  }
  if (defaultName === undefined) e8.signal("error", "Can't find Hunspell dictionary with a .aff affix file");
  const defaultEntry = parseHunspellAffixFile(defaultName);
  const alist: Dict[] = [[null, ...defaultEntry.slice(1)]];
  for (const [name] of paths) if (!assoc(name, alist)) alist.unshift(name === defaultName ? defaultEntry : [name]);
  set("ispell-hunspell-dictionary-alist", alist);
  equivs = [];
  return defaultName;
}

/** Adds a combination of Hunspell dictionaries, "DICT1,DICT2,...", as ispell-hunspell-add-multi-dic. */
export function hunspellAddMultiDic(dict: string): void {
  // Emacs asks code to learn the checker first, or the combination is lost when it does.
  setSpellcheckerParams();
  const first = dict.split(",").filter((s) => s !== "")[0];
  if (list(v("ispell-hunspell-dictionary-alist")).length === 0) {
    findHunspellDictionaries();
    set("ispell-dictionary-alist", list(v("ispell-hunspell-dictionary-alist")));
  }
  if (!assoc(first, list(v("ispell-local-dictionary-alist"))) && !assoc(first, list(v("ispell-dictionary-alist")))) {
    e8.signal("error", `Unknown dictionary: ${first}`);
  }
  const alist = list(v("ispell-dictionary-alist"));
  if (!alist.some((e) => Array.isArray(e) && e.length === 2 && e[0] === dict)) set("ispell-dictionary-alist", [[dict, []], ...alist]);
  hunspellFillDictionaryEntry(dict);
}

// Enchant's dictionaries.

function enchantLsmod(...args: string[]): string {
  const program = String(v("ispell-program-name")).replace(/enchant(-[0-9])?$/, "enchant-lsmod$1");
  return callChecker([program, ...args]).output;
}

/** Finds Enchant's dictionaries, as ispell-find-enchant-dictionaries. */
function findEnchantDictionaries(): void {
  const langs = allMatches(/^(\S+) \([^)]+\)$/gm, enchantLsmod("-list-dicts")).map((m) => m[1]);
  set(
    "ispell-enchant-dictionary-alist",
    langs.map((lang) => {
      const extra = enchantLsmod("-word-chars", lang).trimEnd().split("\n").pop() ?? "";
      return [lang, "[[:alpha:]]", "[^[:alpha:]]", extra === "" ? "" : `[${extra}]`, true, [], null, sym("utf-8")];
    }),
  );
}

/** Learns the checker and its dictionaries when it changes or is first used, as ispell-set-spellchecker-params. */
export function setSpellcheckerParams(): void {
  if (v("ispell-last-program-name") === v("ispell-program-name")) return;
  killIspell(true);
  let known = false;
  try {
    set("ispell-library-directory", checkVersion());
    known = true;
  } catch {
    known = false;
  }
  const aspell = v("ispell-really-aspell") !== null;
  const hunspell = v("ispell-really-hunspell") !== null;
  const enchant = v("ispell-really-enchant") !== null;
  const encoding8 = v("ispell-encoding8-command") !== null;
  if (known && (encoding8 || enchant)) {
    if (aspell) {
      if (list(v("ispell-aspell-dictionary-alist")).length === 0) findAspellDictionaries();
    } else if (hunspell) {
      if (list(v("ispell-hunspell-dictionary-alist")).length === 0) findHunspellDictionaries();
    } else if (enchant) {
      if (list(v("ispell-enchant-dictionary-alist")).length === 0) findEnchantDictionaries();
    }
  }
  const found = (encoding8
    ? aspell ? list(v("ispell-aspell-dictionary-alist")) : hunspell ? list(v("ispell-hunspell-dictionary-alist")) : []
    : enchant ? list(v("ispell-enchant-dictionary-alist")) : []) as Dict[];
  let base = list(v("ispell-dictionary-base-alist")) as Dict[];
  // Hunspell and Enchant name dictionaries by locale: ispell.el's names stand for theirs.
  if (hunspell || enchant) {
    const mapped: Dict[] = [];
    const equivs = list(v("ispell-dicts-name2locale-equivs-alist")) as [string, string][];
    for (const dict of base) {
      const name = dict[0] as string | null;
      const equiv = equivs.find((e) => e[0] === name)?.[1];
      let args = (list(dict[5]) as string[]).slice();
      const d = args.indexOf("-d");
      if (d >= 0) args = [...args.slice(0, d), ...args.slice(d + 2)];
      if (name !== null) {
        if (equiv === undefined) {
          e8.message(`ispell-set-spellchecker-params: Missing equivalent for "${name}". Skipping.`);
          continue;
        }
        args = [...args, "-d", equiv];
      }
      const entry = [name, dict[1], dict[2], dict[3], dict[4], args, dict[6], dict[7]];
      if (!mapped.some((m) => JSON.stringify(m) === JSON.stringify(entry))) mapped.unshift(entry);
    }
    base = mapped;
  }
  e8.letBind({ "ispell-base-dicts-override-alist": [] }, () => {
    e8.runHooks("ispell-initialize-spellchecker-hook");
    const all: Dict[] = [];
    for (const dict of [...found, ...(list(v("ispell-base-dicts-override-alist")) as Dict[]), ...base]) {
      if (!assoc(dict[0], all)) all.unshift(dict);
    }
    set("ispell-dictionary-alist", all);
  });
  // A checker that can be told to talk UTF-8 is told so.
  const utf8: Dict[] = [];
  for (const dict of list(v("ispell-dictionary-alist")) as Dict[]) {
    const entry = filled(dict[1]) ? [...dict.slice(0, 7), encoding8 || enchant ? sym("utf-8") : dict[7]] : dict;
    if (!utf8.some((m) => m[0] === entry[0] && JSON.stringify(m.slice(0, 7)) === JSON.stringify(entry.slice(0, 7)))) utf8.unshift(entry);
  }
  set("ispell-dictionary-alist", utf8);
  set("ispell-last-program-name", v("ispell-program-name") ?? null);
}
defvar("ispell-base-dicts-override-alist", [], "Entries ispell-initialize-spellchecker-hook may give to override ispell.el's own.");

/** The dictionaries there are to choose, as ispell-valid-dictionary-list. */
export function validDictionaryList(): string[] {
  setSpellcheckerParams();
  const dicts = [...list(v("ispell-local-dictionary-alist")), ...list(v("ispell-dictionary-alist"))] as Dict[];
  const names: string[] = ["default"];
  const lib = str("ispell-library-directory");
  const locate = (dict: string, dir?: string): boolean => {
    const directory = dir ?? e8.fileNameDirectory(dict);
    if (directory === undefined) return false;
    const base = e8.fileNameNondirectory(dict);
    const suffixes = /\.[^./]+$/.test(base) ? [""] : [".hash", ".has"];
    return suffixes.some((s) => e8.fileExistsP(`${directory.replace(/\/?$/, "/")}${base}${s}`));
  };
  const aspell = v("ispell-really-aspell") !== null;
  for (const dict of dicts) {
    const name = dict[0];
    if (typeof name !== "string") continue;
    const args = list(dict[5]) as string[];
    const d = args.indexOf("-d");
    const explicit = d >= 0 ? args[d + 1] : undefined;
    if (
      (aspell && assoc(name, aspellFound)) ||
      (!aspell && lib === undefined) ||
      (explicit !== undefined && e8.fileNameAbsoluteP(explicit) && locate(explicit)) ||
      (lib !== undefined && locate(explicit ?? name, lib))
    ) {
      names.unshift(name);
    }
  }
  return names;
}

// The current dictionary's entry.

/** Adds a combination of Hunspell dictionaries the first time it is named, which Emacs leaves to ispell-hunspell-add-multi-dic. */
function addMultiDicIfNamed(dict: e8.Value | undefined): void {
  if (typeof dict !== "string" || !dict.includes(",") || v("ispell-really-hunspell") === null) return;
  if (assoc(dict, list(v("ispell-local-dictionary-alist"))) || assoc(dict, list(v("ispell-dictionary-alist")))) return;
  hunspellAddMultiDic(dict);
}

function currentEntry(): Dict {
  const current = v("ispell-current-dictionary") ?? null;
  addMultiDicIfNamed(current);
  const entry = assoc(current, list(v("ispell-local-dictionary-alist"))) ?? assoc(current, list(v("ispell-dictionary-alist")));
  if (entry === undefined) {
    e8.signal("error", `No data for dictionary "${String(current)}" in ‘ispell-local-dictionary-alist’ or ‘ispell-dictionary-alist’`);
  }
  return entry;
}
const slot = (n: number): string | undefined => {
  const s = currentEntry()[n];
  return typeof s === "string" ? s : undefined;
};
export const getCasechars = (): string => slot(1) ?? "[[:alpha:]]";
export const getNotCasechars = (): string => slot(2) ?? "[^[:alpha:]]";
export const getOtherchars = (): string => slot(3) ?? "";
export const getManyOtherchars = (): boolean => truthy(currentEntry()[4]);
const getIspellArgs = (): string[] => list(currentEntry()[5]).map(String);
function getExtendedCharacterMode(): string | undefined {
  if (v("ispell-really-hunspell") !== null) return undefined;
  const mode = currentEntry()[6];
  return typeof mode === "string" ? mode : undefined;
}
function getCodingSystem(): string {
  const coding = currentEntry()[7];
  return typeof coding === "symbol" ? e8.symbolName(coding) : String(coding ?? "utf-8");
}

/** A word as messages show it, through ispell-format-word-function. */
function formatWord(word: string): string {
  const f = v("ispell-format-word-function");
  if (typeof f === "function") return String(f(word));
  const name = typeof f === "symbol" ? e8.symbolName(f) : typeof f === "string" ? f : undefined;
  if (name === "upcase") return e8.upcase(word);
  if (name === "downcase") return e8.downcase(word);
  if (name === "capitalize") return e8.capitalize(word);
  if (name !== undefined && e8.fboundp(name)) return String(e8.funcall(name, word));
  return word;
}

// The session. Each check runs the checker afresh with what the session has
// told it so far, as ispell-send-string does without a running process.

interface Session {
  args: string[];
  directory: string;
  /** Commands that only change the checker's state, replayed before each check. */
  commands: string[];
  /** Words put in the personal dictionary and not yet saved: accepted for the session until `#` saves them. */
  inserted: string[];
}
let session: Session | undefined;

/** The checker's output from the last check, a line each. */
let filter: string[] = [];

/** Keeps a command that changes the checker's state for the checks to come, dropping ones it overrides. */
function remember(line: string): void {
  if (session === undefined) return;
  const c = line[0];
  if (c === "*") {
    if (!session.inserted.includes(line.slice(1))) session.inserted.push(line.slice(1));
    return;
  }
  const overrides = c === "!" || c === "%" ? "!%" : c === "+" || c === "-" ? "+-" : c === "~" ? "~" : "";
  if (overrides !== "") session.commands = session.commands.filter((l) => !overrides.includes(l[0]));
  else if (session.commands.includes(line)) return;
  session.commands.push(line);
}

/** Sends a line to the checker, as ispell-send-string: one that checks runs it, others are kept for the next. */
export function sendString(text: string): void {
  if (session === undefined) return;
  // Lessons in corrections, $$ra, are kept too, as a running checker keeps them.
  if ("*@~+-!%".includes(text[0]) || text.startsWith("$$ra ")) {
    for (const line of text.split("\n")) if (line !== "") remember(line);
    return;
  }
  const saving = text.startsWith("#");
  const before = [...session.commands, ...session.inserted.map((w) => (saving ? "*" : "@") + w)];
  const program = String(v("ispell-program-name"));
  const hunspell = v("ispell-really-hunspell") !== null;
  const { exit, output } = callChecker(
    [program, "-a", ...(hunspell ? [] : ["-m"]), ...session.args],
    before.map((l) => `${l}\n`).join("") + text,
    session.directory,
  );
  if (!output.startsWith("@(#) ")) e8.signal("error", `Ispell error: ${output.split("\n")[0]}`);
  const lines = output.split("\n");
  if (output.endsWith("\n")) lines.pop();
  filter = text === "\x1a\n" ? lines : lines.slice(1);
  set("ispell-filter", [...filter].reverse());
  if (saving && exit === 0) session.inserted = [];
}

/** Starts the checker's session, as ispell-start-process. */
function startProcess(): void {
  const current = str("ispell-current-dictionary");
  if (v("ispell-really-hunspell") !== null) {
    const entry = assoc(current ?? null, list(v("ispell-dictionary-alist")));
    if (!(entry && filled(entry[1]))) hunspellFillDictionaryEntry(current ?? "");
  }
  const orig = getIspellArgs();
  const encoding = str("ispell-encoding8-command");
  const coding = getCodingSystem();
  const args = [
    ...(current !== undefined && !orig.includes("-d") ? ["-d", current] : []),
    ...orig,
    ...(str("ispell-current-personal-dictionary") !== undefined ? ["-p", str("ispell-current-personal-dictionary")!] : []),
    ...(encoding === undefined ? [] : v("ispell-really-hunspell") !== null ? [encoding, coding.toUpperCase()] : [`${encoding}${coding}`]),
    ...list(v("ispell-extra-args")).map(String),
  ];
  set("ispell-buffer-local-name", null);
  session = { args, directory: String(v("ispell-process-directory")), commands: [], inserted: [] };
  set("ispell-process", true);
  sendString("\x1a\n");
}

/** Makes sure the session is going, starting it if need be, as ispell-init-process. */
export function initProcess(): void {
  const args = getIspellArgs();
  const d = args.indexOf("-d");
  const bname = d >= 0 ? args[d + 1] : str("ispell-current-dictionary");
  let directory = String(v("default-directory") ?? "~/");
  if (
    v("ispell-really-aspell") !== null ||
    v("ispell-really-hunspell") !== null ||
    !e8.fileAccessibleDirectoryP(directory) ||
    !(e8.fileReadableP(`${directory}.ispell_words`) || e8.fileReadableP(`${directory}.ispell_${bname ?? "default"}`))
  ) {
    directory = e8.expandFileName("~/");
  } else directory = e8.expandFileName(directory);
  if (session !== undefined && (truthy(v("ispell-local-pdict")) || truthy(v("ispell-personal-dictionary")) || v("ispell-process-directory") === directory)) {
    filter = [];
    return;
  }
  killIspell(true);
  const dict = str("ispell-local-dictionary") ?? str("ispell-dictionary") ?? "default";
  const program = String(v("ispell-program-name"));
  const reporter = `Starting new Ispell process ${program} with ${dict} dictionary...`;
  e8.message(reporter);
  set("ispell-library-directory", checkVersion());
  set("ispell-process-directory", directory);
  try {
    startProcess();
  } catch (e) {
    session = undefined;
    set("ispell-process", null);
    throw e;
  }
  e8.message(`${reporter}done`);
  if (filter.length === 0) {
    session = undefined;
    set("ispell-process", null);
    e8.signal("error", `${program} did not output version line`);
  }
  const versionLine = filter.find((l) => !/warning: /.test(l));
  if (versionLine === undefined || !/^@\(#\) /.test(versionLine)) {
    session = undefined;
    set("ispell-process", null);
    e8.signal("error", filter.join("\n"));
  }
  filter = [];
  const mode = getExtendedCharacterMode();
  if (mode !== undefined) sendString(`${mode}\n`);
}

/** Ends the session, as ispell-kill-ispell: true if there was none and `noError`. */
export function killIspell(noError = false, clear = false): boolean | null {
  e8.runHooks("ispell-kill-ispell-hook");
  if (clear) set("ispell-buffer-session-localwords", []);
  if (session === undefined) {
    if (!noError) e8.signal("error", "There is no Ispell process running!");
    return true;
  }
  session = undefined;
  set("ispell-process", null);
  e8.message("Ispell process killed");
  return null;
}

/** Saves the personal dictionary if it changed, asking first, as ispell-pdict-save. */
export function pdictSave(noQuery = false, forceSave = false): void {
  let modified = v("ispell-pdict-modified-p");
  if (Array.isArray(modified) && modified.length > 0) modified = modified[0];
  if ((truthy(modified) || forceSave) && (noQuery || e8.yOrNP("Personal dictionary modified.  Save? "))) {
    sendString("#\n");
    e8.message("Personal dictionary saved.");
  }
  set("ispell-pdict-modified-p", null);
}

// Parsing what the checker says.

/** What the checker said of a word: true if right, the root it was found by, or [word, offset, misses, guesses]. */
export type Poss = true | string | [string, number, string[], string[]] | undefined;

/** Parses a line of the checker's output, as ispell-parse-output. */
export function parseOutput(output: string, acceptList?: string[], shift?: number): Poss {
  if (output === "" || output === "*" || output === "-") return true;
  if (output[0] === "+") return output.slice(2);
  if (/^[\ra-zA-Z]/.test(output)) {
    e8.ding();
    e8.message(`Ispell error: ${output}`);
    e8.sitFor(5);
    return undefined;
  }
  const type = output[0];
  const m = /^[&?#] (\S+) (?:(\d+) )?(\d+)(?::? ?(.*))?$/.exec(output);
  if (!m) return undefined;
  const count = type === "#" ? 0 : Number(m[2]);
  const all = type === "#" || m[4] === undefined || m[4] === "" ? [] : m[4].split(", ");
  if (acceptList?.includes(m[1])) return true;
  const offset = Number(m[3]);
  return [m[1], typeof shift === "number" ? shift + offset : offset, all.slice(0, count), all.slice(count)];
}

/** Checks a word, as ispell--run-on-word. */
export function runOnWord(word: string): Poss {
  if (session === undefined) acceptBufferLocalDefs();
  sendString("%\n");
  sendString(`^${word}\n`);
  const lines = filter;
  filter = [];
  const answers = lines.filter((l, i) => !(l === "" && i === lines.length - 1));
  if (answers.length > 1) e8.signal("error", `Ispell and its process have different character maps: ${answers.join(" ")}`);
  return answers.length === 0 ? true : parseOutput(answers[0]);
}

/** Checks words, each on its own, in one run of the checker, as flyspell checks a large region. */
export function checkWords(words: string[]): Poss[] {
  if (words.length === 0) return [];
  if (session === undefined) acceptBufferLocalDefs();
  sendString("%\n");
  sendString(words.map((w) => `^${w}\n`).join(""));
  const blocks = filter.join("\n").split("\n\n");
  filter = [];
  return words.map((_, i) => {
    const line = blocks[i]?.split("\n").find((l) => l !== "");
    return line === undefined ? true : parseOutput(line);
  });
}

/** Whether the word at point is right, as ispell-correct-p. */
export function correctP(following = false): boolean {
  return e8.saveExcursion(() => {
    filter = [];
    const found = getWord(following);
    const poss = runOnWord(found.word);
    if (poss === undefined) e8.signal("error", errorCheckingWord(found.word));
    return poss === true || typeof poss === "string";
  });
}

function errorCheckingWord(word: string): string {
  return `Error checking word ${formatWord(word)} using ${e8.fileNameNondirectory(String(v("ispell-program-name")))} with ${str("ispell-current-dictionary") ?? "default"} dictionary`;
}

// Finding words.

/**
 * The word at point, or before it, or after it with `following`, and where
 * it is, by the dictionary's characters, as ispell-get-word.
 * `extraOtherchars` may come any number of times in a word.
 */
export function getWord(following = false, extraOtherchars?: string): { word: string; start: number; end: number } {
  const found = wordAt(following, extraOtherchars);
  if (found !== undefined) return found;
  if (truthy(v("ispell-check-only"))) return { word: "", start: e8.point(), end: e8.point() };
  e8.userError("No word found to check!");
}

/** The word at point, as getWord finds it, or undefined if there is none, as flyspell-get-word. */
export function wordAt(following = false, extraOtherchars?: string): { word: string; start: number; end: number } | undefined {
  setSpellcheckerParams();
  const casechars = getCasechars();
  const notCasechars = getNotCasechars();
  const otherchars = getOtherchars();
  const many = getManyOtherchars();
  const wordRegexp = `${casechars}+\\(${otherchars !== "" ? `${otherchars}?` : ""}${extraOtherchars ? `${extraOtherchars}?` : ""}${casechars}+\\)${many || extraOtherchars ? "*" : "?"}`;
  return e8.saveExcursion(() => {
    if (!e8.lookingAt(casechars)) {
      if (following) e8.reSearchForward(casechars, { noerror: true });
      else e8.reSearchBackward(casechars, { noerror: true });
    }
    if (e8.reSearchBackward(notCasechars, { noerror: true }) === undefined) e8.gotoChar(e8.pointMin());
    let didItOnce = false;
    let prevpt: number | undefined;
    while (
      ((otherchars !== "" && e8.lookingAt(otherchars)) || (extraOtherchars !== undefined && e8.lookingAt(extraOtherchars))) &&
      e8.point() > e8.pointMin() &&
      (!didItOnce || many) &&
      prevpt !== e8.point()
    ) {
      if (extraOtherchars !== undefined && e8.lookingAt(extraOtherchars)) {
        e8.gotoChar(e8.point() - 1);
        if (e8.lookingAt(casechars) && e8.reSearchBackward(notCasechars, { noerror: true }) === undefined) e8.gotoChar(e8.pointMin());
      } else {
        didItOnce = true;
        prevpt = e8.point();
        e8.gotoChar(e8.point() - 1);
        if (e8.lookingAt(casechars)) {
          if (e8.reSearchBackward(notCasechars, { noerror: true }) === undefined) e8.gotoChar(e8.pointMin());
        } else e8.gotoChar(e8.point() + 1);
      }
    }
    if (e8.reSearchForward(wordRegexp, { noerror: true }) === undefined) return undefined;
    const start = e8.matchBeginning(0)!;
    const end = e8.point();
    return { word: e8.bufferSubstringNoProperties(start, end), start, end };
  });
}

// Showing the choices and the misspelling.

let highlightOverlay: number | undefined;
let lazyOverlays: number[] = [];

/** Highlights the word from `start` to `end`, or takes the highlight off, as ispell-highlight-spelling-error-overlay. */
function highlightSpellingError(start: number, end: number, highlight = false): void {
  if (highlight) {
    if (highlightOverlay !== undefined && e8.overlayStart(highlightOverlay) !== undefined) e8.moveOverlay(highlightOverlay, start, end);
    else highlightOverlay = e8.makeOverlay(start, end, { priority: 1001, face: v("ispell-highlight-face") ?? sym("isearch") });
  } else if (highlightOverlay !== undefined) {
    e8.deleteOverlay(highlightOverlay);
    highlightOverlay = undefined;
  }
  for (const o of lazyOverlays) e8.deleteOverlay(o);
  lazyOverlays = [];
  if (highlight && truthy(v("ispell-lazy-highlight"))) {
    // The word's other occurrences in the window, as isearch's lazy highlighting shows them.
    const word = e8.bufferSubstringNoProperties(start, end);
    e8.saveExcursion(() => {
      const bottom = e8.windowEnd();
      e8.gotoChar(e8.windowStart());
      while (lazyOverlays.length < 200 && e8.reSearchForward(`\\b${regexpQuote(word)}\\b`, { bound: bottom, noerror: true, caseFold: false }) !== undefined) {
        const s = e8.matchBeginning(0)!;
        const t = e8.matchEnd(0)!;
        if (s !== start) lazyOverlays.push(e8.makeOverlay(s, t, { priority: 1000, face: "lazy-highlight" }));
        if (t === s) break;
      }
    });
  }
}

/**
 * Shows a buffer in a window above the selected one, fitted to its text, as
 * ispell-display-buffer, and returns the window that shows the text.
 */
function displayBuffer(buffer: string): number {
  const text = e8.selectedWindow();
  const shown = e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
  if (shown !== undefined) {
    fitWindow(shown, buffer);
    return text;
  }
  const height = Number(v("ispell-choices-win-default-height") ?? 2);
  const point = e8.point();
  const start = e8.windowStart(text);
  let below: number;
  try {
    // The top part keeps the old window, which shows the choices.
    below = e8.splitWindow(text, "below", height);
  } catch {
    e8.call("display-buffer", buffer);
    return text;
  }
  e8.setWindowBuffer(text, buffer);
  e8.setWindowPoint(text, 0);
  e8.selectWindow(below);
  e8.setWindowStart(below, start);
  e8.setWindowPoint(below, point);
  fitWindow(text, buffer);
  return below;
}

/** Fits a window's height to its buffer's lines and its mode line, as fit-window-to-buffer. */
function fitWindow(window: number, buffer: string): void {
  const lines = e8.withCurrentBuffer(buffer, () => {
    const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    return Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
  });
  const size = e8.windowSize(window);
  if (size === undefined) return;
  const want = lines + (size.totalHeight - size.height);
  if (want !== size.totalHeight) e8.resizeWindow(window, want - size.totalHeight);
}

/** Shows the choices above the text, as ispell-show-choices, returning the window with the text. */
function showChoices(): number {
  e8.getBufferCreate(CHOICES);
  return displayBuffer(CHOICES);
}

/** Fills *Choices* with the corrections, and its mode line with the word, as the command loop does. */
function fillChoices(choices: string[], modeLine: string, guess: string[] = []): number {
  const width = e8.windowSize()?.width ?? 80;
  let count = 0x30;
  let skipped = 0;
  e8.withCurrentBuffer(e8.getBufferCreate(CHOICES), () => {
    e8.setVariable("mode-line-format", modeLine);
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      if (guess.length > 0) {
        e8.insert("Affix rules generate and capitalize this word as shown below:\n\t");
        for (const g of guess) {
          if (4 + e8.currentColumn() + [...g].length > width) e8.insert("\n\t");
          e8.insert(`${g}    `);
        }
        e8.insert("\nUse option ‘i’ to accept this spelling and put it in your personal dictionary.\n");
      }
      for (const choice of choices) {
        if (7 + e8.currentColumn() + [...choice].length + (count > 0x7e ? 3 : 0) > width) e8.insert("\n");
        while (COMMAND_CHARS.includes(String.fromCodePoint(count))) {
          count++;
          skipped++;
        }
        e8.insert(`(${String.fromCodePoint(count)}) ${choice}  `);
        count++;
      }
    });
  });
  return count - 0x30 - skipped;
}

const COMMAND_CHARS = " iaArR?xXqlum";

/** Takes flyspell's mark off a word accepted, as the command loop does when flyspell-mode is on. */
function unhighlightFlyspell(pos: number): void {
  if (truthy(v("flyspell-mode")) && e8.fboundp("flyspell-unhighlight-at")) e8.funcall("flyspell-unhighlight-at", pos);
}

/** What the user chose for a misspelling: nil to leave it, 0 to accept it in the file, a word, or a word to check again, with whether to query-replace it. */
type Replace = null | 0 | string | [string] | [string, boolean | "query-replace"];

/** Where an ispell-region or ispell-word was stopped: true to go back, a position to stay at, false to go on. */
let ispellQuit: boolean | number = false;
let recursiveEditMarker: e8.Marker | undefined;

/**
 * Asks what to do with a misspelled word, showing the corrections in
 * *Choices* and highlighting the word, as ispell-command-loop.
 */
export function commandLoop(miss: string[], guess: string[], word: string, start: number, end: number): Replace {
  const dict = str("ispell-current-dictionary") ?? "default";
  const program = e8.fileNameNondirectory(String(v("ispell-program-name")));
  let count = fillChoices(miss, `--  %b  --  word: ${word}  --  dict: ${dict}  --  prog: ${program}`, guess);
  e8.runHooks("ispell-update-post-hook");
  let textwin = showChoices();
  e8.selectWindow(textwin);
  let result: Replace | true;
  try {
    if (truthy(v("ispell-highlight-p"))) highlightSpellingError(start, end, true);
    do {
      e8.message("C-h or ? for more options; SPC to leave unchanged, Character to replace word", { log: false });
      let char = e8.readKey();
      if (char === "C-g") char = "X";
      if (char === "SPC") char = " ";
      const code = [...char].length === 1 ? char.codePointAt(0)! : -1;
      let skip = 0;
      for (const c of COMMAND_CHARS) if (c.codePointAt(0)! > 0x30 && c.codePointAt(0)! < code) skip++;
      const num = code - 0x30 - skip;
      result = ((): Replace | true => {
        switch (char) {
          case " ":
            return null;
          case "i":
            sendString(`*${word}\n`);
            set("ispell-pdict-modified-p", [true]);
            unhighlightFlyspell(start);
            return null;
          case "a":
          case "A": {
            sendString(`@${word}\n`);
            const words = list(v("ispell-buffer-session-localwords")).map(String);
            if (!words.includes(word)) set("ispell-buffer-session-localwords", [word, ...words]);
            unhighlightFlyspell(start);
            if (v("ispell-buffer-local-name") === null) set("ispell-buffer-local-name", e8.bufferName());
            if (!truthy(v("ispell-pdict-modified-p"))) set("ispell-pdict-modified-p", [v("ispell-pdict-modified-p") ?? null]);
            return char === "A" ? 0 : null;
          }
          case "r":
          case "R":
            if (char === "R" || truthy(v("ispell-query-replace-choices"))) {
              return [e8.readString(`Query-replacement for ${word}: `, { initial: word }), true];
            }
            return [e8.readString("Replacement for: ", { initial: word })];
          case "?":
          case "C-h":
            help();
            return true;
          case "x":
            pdictSave(truthy(v("ispell-silently-savep")));
            e8.message("Exited spell-checking");
            ispellQuit = true;
            return null;
          case "X":
            pdictSave(truthy(v("ispell-silently-savep")));
            e8.message("Spell-checking suspended; use C-u M-$ to resume");
            ispellQuit = start;
            return null;
          case "q":
            if (e8.yOrNP("Really kill Ispell process? ")) {
              killIspell(true);
              ispellQuit = true;
              set("ispell-pdict-modified-p", null);
              return null;
            }
            return true;
          case "l": {
            const lookup = e8.readString("Lookup string (`*' is wildcard): ", { initial: word });
            if (lookup !== "") {
              const dictFile = str("ispell-complete-word-dict") ?? str("ispell-alternate-dictionary");
              miss = lookupWords(lookup);
              count = fillChoices(miss, `--  %b  --  word: ${lookup}  --  word-list: ${dictFile}`);
              textwin = showChoices();
              e8.selectWindow(textwin);
            }
            return true;
          }
          case "u":
            sendString(`*${e8.downcase(word)}\n`);
            set("ispell-pdict-modified-p", [true]);
            return null;
          case "m":
            sendString(`*${e8.readString("Insert: ", { initial: word })}\n`);
            set("ispell-pdict-modified-p", [true]);
            return [word];
          case "C-l":
            e8.redrawDisplay();
            return true;
          case "C-r":
            if (recursiveEditMarker !== undefined) {
              e8.message("Only one recursive edit session supported");
              e8.beep();
              e8.sitFor(2);
              return true;
            }
            recursiveEditMarker = e8.makeMarker(start);
            if (truthy(v("ispell-highlight-p"))) highlightSpellingError(start, end);
            try {
              e8.message("Exit recursive edit with C-M-c");
              e8.saveWindowExcursion(() => e8.saveExcursion(() => e8.recursiveEdit()));
            } finally {
              const marker = recursiveEditMarker;
              recursiveEditMarker = undefined;
              const at = e8.markerPosition(marker);
              const same = e8.markerBuffer(marker) === e8.bufferName();
              e8.deleteMarker(marker);
              if (!same) e8.signal("error", "Cannot continue ispell from this buffer");
              if (at !== undefined) e8.gotoChar(at);
            }
            return [word, false];
          case "C-z": {
            const binding = e8.lookupKey("global-map", "C-z");
            if (typeof binding === "string" && e8.commandExists(binding)) e8.call(binding as e8.CommandName);
            return true;
          }
          default:
            if (code >= 0x30 && num >= 0 && num < count) {
              return truthy(v("ispell-query-replace-choices")) ? [miss[num], "query-replace"] : miss[num];
            }
            e8.ding();
            return true;
        }
      })();
    } while (result === true);
    return result;
  } finally {
    if (truthy(v("ispell-highlight-p"))) highlightSpellingError(start, end);
  }
}

const HELP_LONG = `Selections are:

0..9  Replace the word with a digit offered in the *Choices* buffer.
SPC   Accept word this time.
i     Accept word and insert into personal dictionary.
a     Accept word for this session.
A     Accept word and place in \`buffer-local dictionary'.
r     Replace word with typed-in value.  Rechecked.
R     Replace word with typed-in value.  Query-replaced in buffer.  Rechecked.
?     Show these commands.
x     Exit spelling buffer.  Move cursor to original point.
X     Exit spelling buffer.  Leaves cursor at the current point, and permits
        the aborted check to be completed later.
q     Quit spelling session (Kills ispell process).
l     Look up typed-in replacement in alternate dictionary.  Wildcards okay.
u     Like i, but the word is lower-cased first.
m     Place typed-in value in personal dictionary, then recheck current word.
C-l   Redraw screen.
C-r   Recursive edit.
C-z   Suspend Emacs or iconify frame.`;

/** Shows what the keys do while asking about a misspelling, as ispell-help. */
function help(): void {
  const where = v("ispell-help-in-bufferp");
  if (isSym(where, "electric")) {
    e8.saveWindowExcursion(() => {
      const name = "*Help*";
      e8.withCurrentBuffer(e8.getBufferCreate(name), () => {
        e8.letBind({ "inhibit-read-only": true }, () => {
          e8.deleteRegion(e8.pointMin(), e8.pointMax());
          e8.insert(HELP_LONG);
        });
      });
      displayBuffer(name);
      e8.readKey("Press any key to go back to spell-checking");
    });
    return;
  }
  const text = [
    "[r/R]eplace word; [a/A]ccept for this session; [i]nsert into personal dictionary",
    "[l]ook a word up in alternate dictionary;  e[x/X]it;  [q]uit session",
    "[u]ncapitalized insert into dict.  Type `x C-h f ispell-help' for more help",
  ].join("\n");
  const timeout = Number(v("ispell-help-timeout") ?? 5);
  e8.saveWindowExcursion(() => {
    if (truthy(where)) {
      const name = "*Ispell Help*";
      e8.withCurrentBuffer(e8.getBufferCreate(name), () => e8.insert(text));
      displayBuffer(name);
      e8.sitFor(timeout);
      e8.call("kill-buffer", name);
    } else {
      e8.message(text, { log: false });
      e8.sitFor(timeout);
      e8.message("", { log: false });
    }
  });
}

/** Looks a word up in a plain word list, `*' a wildcard, with look or grep, as ispell-lookup-words. */
export function lookupWords(word: string, lookupDict?: string): string[] {
  const dict = lookupDict ?? str("ispell-complete-word-dict") ?? str("ispell-alternate-dictionary");
  if (dict !== undefined) {
    if (!e8.fileReadableP(dict)) e8.signal("error", `ispell-lookup-words: Unreadable or missing plain word-list ${dict}`);
  } else {
    e8.signal(
      "error",
      "ispell-lookup-words: No plain word-list found at system default locations.  Customize ‘ispell-alternate-dictionary’ to set yours.",
    );
  }
  const wild = word.includes("*");
  const look = str("ispell-look-command");
  const useLook = look !== undefined && e8.fileExistsP(look) && !wild;
  const program = useLook ? look : String(v("ispell-grep-command") ?? "grep");
  const options = useLook ? str("ispell-look-options") : str("ispell-grep-options");
  let pattern = word;
  if (!useLook) pattern = `^${word}${wild ? "" : "*"}$`.replace(/\*/g, ".*");
  e8.message(`Starting "${e8.fileNameNondirectory(program)}" process...`);
  const { output } = callChecker([program, ...(options ? [options] : useLook ? [] : ["-e"]), pattern, dict]);
  const results = output.split("\n");
  if (results[results.length - 1] === "") results.pop();
  if (results.length > 0 && /.+: /.test(results[0])) e8.signal("error", `${String(v("ispell-grep-command"))} error: ${results[0]}`);
  return results;
}

// Checking a word.

/**
 * Checks the word at point and offers corrections if it is wrong, as
 * ispell-word: null if it is right or accepted, 0 if put in the file's
 * words, the correction, or "quit" if the session was stopped.
 */
export function ispellWord(following = false, quietly = false, cont = false, region = false): Replace | "quit" {
  if (region && e8.regionActive()) {
    const mark = e8.mark() ?? e8.point();
    ispellRegion(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
    return null;
  }
  if (cont) {
    ispellContinue();
    return null;
  }
  setSpellcheckerParams();
  acceptBufferLocalDefs();
  let cursor = e8.point();
  const found = getWord(following);
  let { start, end } = found;
  const word = found.word;
  if (!quietly) e8.message(`Checking spelling of ${formatWord(word)}...`);
  const poss = runOnWord(word);
  let replace: Replace = null;
  if (poss === true) {
    if (!quietly) e8.message(`${formatWord(word)} is correct`);
  } else if (typeof poss === "string") {
    if (!quietly) e8.message(`${formatWord(word)} is correct because of root ${formatWord(poss)}`);
  } else if (poss === undefined) {
    e8.message(errorCheckingWord(word));
  } else if (truthy(v("ispell-check-only"))) {
    e8.beep();
    e8.message(`${formatWord(word)} is incorrect`);
  } else {
    replace = e8.saveWindowExcursion(() => commandLoop(poss[2], poss[3], poss[0], start, end));
    if (replace === 0) addPerFileWordList(poss[0]);
    else if (replace !== null) {
      const fresh = typeof replace === "string" ? replace : replace[0];
      cursor = [...word].length - (end - start) + cursor;
      if (fresh !== poss[0]) {
        e8.gotoChar(start);
        e8.insert(fresh);
        e8.deleteRegion(e8.point(), e8.point() + (end - start));
        cursor = e8.point();
        end = e8.point();
      }
      if (typeof replace !== "string") {
        if (replace.length > 1 && truthy(replace[1])) e8.saveWindowExcursion(() => queryReplace(word, fresh, true));
        e8.gotoChar(start);
        ispellQuit = ispellRegion(start, end) === null;
      }
    }
    if (e8.getBuffer(CHOICES) !== undefined) e8.call("kill-buffer", CHOICES);
  }
  pdictSave(truthy(v("ispell-silently-savep")));
  let result: Replace | "quit" = replace;
  if (ispellQuit !== false) {
    ispellQuit = false;
    result = "quit";
  }
  e8.gotoChar(cursor);
  return result;
}

// The words, dictionary and parsing a buffer names for itself.

/** Takes up the buffer's own dictionary, words and parsing, restarting the checker when they change, as ispell-accept-buffer-local-defs. */
export function acceptBufferLocalDefs(): void {
  // As each command that takes them up learns the checker first.
  setSpellcheckerParams();
  bufferLocalDict();
  bufferLocalWords();
  bufferLocalParsing();
}

/** The text after the last occurrence of `keyword`, to the end of its line, searching back from the end as ispell.el does. */
function afterLastKeyword(keyword: string): string | undefined {
  const m = e8.search(keyword, { from: e8.pointMax(), backward: true, caseFold: false });
  return m === undefined ? undefined : e8.bufferSubstringNoProperties(m.end, e8.lineEndPosition(m.end));
}

/** Sets this buffer's dictionary and personal dictionary from its keywords, as ispell-buffer-local-dict. */
export function bufferLocalDict(noReload = false): void {
  if (!truthy(v("ispell-local-dictionary-overridden"))) {
    const after = afterLastKeyword(String(v("ispell-dictionary-keyword")));
    const m = after === undefined ? undefined : /^ *([^ "]+)/.exec(after);
    if (m) set("ispell-local-dictionary", m[1]);
  }
  const pdict = afterLastKeyword(String(v("ispell-pdict-keyword")));
  const p = pdict === undefined ? undefined : /^ *([^ "]+)/.exec(pdict);
  if (p) set("ispell-local-pdict", p[1]);
  if (!noReload) internalChangeDictionary();
}

/** Tells the session the words the buffer accepts, as ispell-buffer-local-words. */
function bufferLocalWords(): void {
  const localName = v("ispell-buffer-local-name");
  if (localName !== null && localName !== undefined && localName !== e8.bufferName()) killIspell(true);
  initProcess();
  const sessionWords = list(v("ispell-buffer-session-localwords")).map(String);
  for (const w of sessionWords) sendString(`@${w}\n`);
  if (v("ispell-buffer-local-name") === null && sessionWords.length > 0) set("ispell-buffer-local-name", e8.bufferName());
  const keyword = String(v("ispell-words-keyword"));
  const casechars = getCasechars();
  for (let m = e8.search(keyword, { from: e8.pointMin(), caseFold: false }); m !== undefined; m = e8.search(keyword, { from: m.end, caseFold: false })) {
    if (v("ispell-buffer-local-name") === null) set("ispell-buffer-local-name", e8.bufferName());
    for (const w of e8.bufferSubstringNoProperties(m.end, e8.lineEndPosition(m.end)).split(" ")) {
      if ([...w].length > 1 && e8.stringMatch(casechars, w) === 0) sendString(`@${w}\n`);
    }
  }
}

/** Sets how the checker parses the buffer, as ispell-buffer-local-parsing. */
function bufferLocalParsing(): void {
  sendString("!\n");
  const mode = String(v("major-mode") ?? "");
  const parser = v("ispell-parser");
  if (!isSym(v("ispell-check-comments"), "exclusive") && ((isSym(parser, "use-mode-name") && /[Tt][Ee][Xx]-mode/.test(mode)) || isSym(parser, "tex"))) {
    sendString("+\n");
    if (!isSym(parser, "tex")) {
      e8.makeLocalVariable("ispell-parser");
      set("ispell-parser", sym("tex"));
    }
  } else sendString("-\n");
  const skipHtml = v("ispell-skip-html");
  if (truthy(skipHtml) && skipHtml !== true) set("ispell-skip-html", /sgml|html|xml/.test(mode.toLowerCase()));
  const extended = getExtendedCharacterMode();
  if (extended !== undefined) sendString(`${extended}\n`);
  const after = afterLastKeyword(String(v("ispell-parsing-keyword")));
  if (after !== undefined) {
    for (const m of allMatches(/ *([^ "]+)/g, after)) {
      const s = m[1].toLowerCase();
      if (s.includes("latex-mode") && !isSym(v("ispell-check-comments"), "exclusive")) sendString("+\n~tex\n");
      else if (s.includes("nroff-mode")) sendString("-\n~nroff\n");
      else if (s.includes("~")) sendString(`${s}\n`);
      else {
        e8.message("Invalid Ispell Parsing argument!");
        e8.sitFor(2);
      }
    }
  }
}

/** Adds a word to the buffer's LocalWords: lines, as ispell-add-per-file-word-list. */
export function addPerFileWordList(word: string): void {
  if (v("ispell-buffer-local-name") === null) set("ispell-buffer-local-name", e8.bufferName());
  const keyword = String(v("ispell-words-keyword"));
  const fillColumn = Number(v("fill-column") ?? 70);
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    let found = false;
    for (;;) {
      const search = e8.search(keyword, { from: e8.point(), caseFold: false });
      let lineOkay = false;
      if (search !== undefined) {
        found = true;
        e8.gotoChar(search.end);
        e8.gotoChar(e8.lineEndPosition());
        lineOkay = [...word].length + 1 + e8.currentColumn() < fillColumn;
      } else e8.gotoChar(e8.lineEndPosition());
      if (search !== undefined && !lineOkay) continue;
      if (search === undefined) {
        if (found) e8.insert("\n");
        else {
          e8.gotoChar(e8.pointMax());
          e8.insert("\n");
          e8.gotoChar(e8.point() - 1);
          e8.insert("\n");
        }
        // ispell.el means to pad the comment start as comment-padright
        // would, but inserts comment-start and a space.
        const commentStart = str("comment-start");
        const commentEnd = str("comment-end");
        if (commentStart !== undefined) e8.insert(`${commentStart} `);
        e8.insert(keyword);
        if (commentEnd !== undefined && commentEnd !== "") {
          e8.saveExcursion(() => {
            e8.insert("\n");
            e8.insert(commentEnd);
          });
        }
      }
      e8.insert(` ${word}`);
      return;
    }
  });
}

// Dictionaries.

/** Changes the dictionary, for this buffer or with `global` for all, as ispell-change-dictionary. */
export function changeDictionary(dictIn: string, global = false, interactive = false): void {
  setSpellcheckerParams();
  if (!global) bufferLocalDict(true);
  const dict = dictIn === "default" ? null : dictIn;
  const current = (!global ? str("ispell-local-dictionary") : undefined) ?? str("ispell-dictionary") ?? "default";
  if (dict === "") {
    internalChangeDictionary();
    e8.message(`Using ${current} dictionary`);
    e8.runHooks("ispell-change-dictionary-hook");
  } else if (dict === current) {
    internalChangeDictionary();
    if (interactive) e8.message(`No change, using ${dict} dictionary`);
  } else {
    addMultiDicIfNamed(dict);
    if (!assoc(dict, list(v("ispell-local-dictionary-alist"))) && !assoc(dict, list(v("ispell-dictionary-alist")))) {
      e8.signal("error", `Undefined dictionary: ${dict}`);
    }
    if (global) {
      e8.setDefault("ispell-dictionary", dict);
    } else {
      set("ispell-local-dictionary", dict);
      set("ispell-local-dictionary-overridden", true);
    }
    internalChangeDictionary();
    set("ispell-buffer-session-localwords", []);
    e8.message(`${global ? "Global" : "Local"} Ispell dictionary set to ${dict ?? "nil"}`);
    e8.runHooks("ispell-change-dictionary-hook");
  }
}

/** Starts the checker afresh if the dictionary or personal dictionary changed, as ispell-internal-change-dictionary. */
function internalChangeDictionary(): void {
  const dict = str("ispell-local-dictionary") ?? str("ispell-dictionary") ?? null;
  const pdict = str("ispell-local-pdict") ?? str("ispell-personal-dictionary");
  const expanded = pdict === undefined ? null : e8.expandFileName(pdict);
  if (v("ispell-current-dictionary") !== dict || v("ispell-current-personal-dictionary") !== expanded) {
    killIspell(true);
    set("ispell-current-dictionary", dict);
    set("ispell-current-personal-dictionary", expanded);
  }
}

// Checking a region.

let regionEnd: e8.Marker | undefined;

function regionEndPosition(): number | undefined {
  return regionEnd === undefined ? undefined : e8.markerPosition(regionEnd);
}

/** A regexp matching a word character or one of `chars`, as ispell--make-\w-expression. */
function wordExpression(chars: string): string {
  const filtered = [...chars].filter((c) => e8.stringMatch("\\w", c) === undefined).join("");
  return `\\(\\w${filtered === "" ? "" : filtered.length === 1 ? `\\|${filtered}` : `\\|[${filtered}]`}\\)`;
}

/** A regexp matching file names, URLs and mail addresses, as ispell--make-filename-or-URL-re. */
function filenameOrUrlRegexp(): string {
  return `\\(/\\w\\|\\(${wordExpression("-_")}+[.:@]\\)\\)${wordExpression("-_")}*\\([.:/@]+${wordExpression("-_~=?&")}+\\)+`;
}

/** A key or region end as an alist holds it: a regexp, or a variable holding one. */
function evalKey(key: e8.Value): string {
  return typeof key === "symbol" ? String(v(e8.symbolName(key)) ?? "") : String(key);
}

function texSkipRegexp(): string {
  const [raw, begin] = list(v("ispell-tex-skip-alists")) as e8.Value[][][];
  return `${(raw ?? []).map((e) => String(e[0])).join("\\|")}\\|${(begin ?? []).map((e) => `\\\\begin[ \t\n]*{[ \t\n]*${String(e[0])}[ \t\n]*}`).join("\\|")}`;
}

/** The regexp of what starts a region to skip, as ispell-begin-skip-region-regexp. */
function beginSkipRegionRegexp(): string {
  const commentStart = str("comment-start");
  const commentEnd = str("comment-end") ?? "";
  const checkComments = v("ispell-check-comments");
  const parts = [
    isSym(v("ispell-parser"), "tex") ? texSkipRegexp() : undefined,
    truthy(v("ispell-skip-html")) ? list(v("ispell-html-skip-alists")).map((e) => evalKey(list(e)[0])).join("\\|") : undefined,
    truthy(v("ispell-skip-tib")) ? String(v("ispell-tib-ref-beginning")) : undefined,
    isSym(checkComments, "exclusive") && commentStart ? (commentEnd === "" ? "^" : regexpQuote(commentEnd)) : undefined,
    !truthy(checkComments) && commentStart ? regexpQuote(commentStart) : undefined,
    list(v("ispell-skip-region-alist")).length > 0 ? list(v("ispell-skip-region-alist")).map((e) => evalKey(list(e)[0])).join("\\|") : undefined,
    filenameOrUrlRegexp(),
  ];
  return parts.filter((p) => p !== undefined).join("\\|");
}

/** The regions to skip in this buffer, as ispell-skip-region-list. */
function skipRegionList(): e8.Value[][] {
  let alist = [[filenameOrUrlRegexp()], ...(list(v("ispell-skip-region-alist")) as e8.Value[][])];
  if (isSym(v("ispell-parser"), "tex")) {
    const [raw, begin] = list(v("ispell-tex-skip-alists")) as e8.Value[][][];
    alist = [...list(raw), ...list(begin), ...alist] as e8.Value[][];
  }
  if (truthy(v("ispell-skip-html"))) alist = [...(list(v("ispell-html-skip-alists")) as e8.Value[][]), ...alist];
  return alist;
}

/** Moves over a TeX command's arguments, as ispell-tex-arg-end. */
function texArgEnd(arg = 1): void {
  try {
    while (e8.lookingAt("[ \t\n]*\\[")) {
      const to = e8.scanSexps(e8.point(), 1);
      if (to === null) throw new Error("no sexp");
      e8.gotoChar(to);
    }
    const to = e8.scanSexps(e8.point(), arg);
    if (to === null) throw new Error("no sexp");
    e8.gotoChar(to);
  } catch {
    e8.message(`Error skipping s-expressions at point ${e8.point()}.`);
    e8.beep();
    e8.sitFor(2);
  }
}
e8.defun("ispell-tex-arg-end", (arg?: number) => texArgEnd(arg ?? 1));

/** Whether a symbol in a skip alist names a function to call rather than a variable holding a regexp. */
function isFunctionName(name: string): boolean {
  return name === "forward-line" || e8.fboundp(name) || e8.commandExists(name);
}

/** Moves past a region to skip that starts with `key`, as ispell-skip-region. */
function skipRegion(key: string): void {
  e8.gotoChar(e8.point() + [...key].length);
  const start = e8.point();
  const commentStart = str("comment-start");
  const commentEnd = str("comment-end") ?? "";
  const checkComments = v("ispell-check-comments");
  const end = regionEndPosition();
  let nullSkip = false;
  const searchString = (s: string, bound?: number) => {
    const m = e8.search(s, { from: e8.point(), ...(bound === undefined ? {} : { bound }) });
    if (m !== undefined) e8.gotoChar(m.end);
    return m;
  };
  if (!truthy(checkComments) && commentStart && key === commentStart) {
    if (commentEnd === "") forwardLine(1);
    else searchString(commentEnd, end);
  } else if (isSym(checkComments, "exclusive") && commentStart && key === commentEnd) {
    if (searchString(commentStart, end) === undefined && end !== undefined) e8.gotoChar(end);
  } else if (truthy(v("ispell-skip-tib")) && e8.stringMatch(String(v("ispell-tib-ref-beginning")), key) !== undefined) {
    e8.reSearchForward(String(v("ispell-tib-ref-end")), { bound: end, noerror: true });
  } else {
    for (const entry of skipRegionList()) {
      if (e8.stringMatch(evalKey(entry[0]), key) === undefined) continue;
      const rest = entry.slice(1);
      if (rest.length === 0) nullSkip = true;
      else if (rest.length === 1 && typeof rest[0] === "string") e8.reSearchForward(rest[0], { noerror: true });
      else if (rest.length === 1 && typeof rest[0] === "symbol" && !isFunctionName(e8.symbolName(rest[0]))) {
        e8.reSearchForward(evalKey(rest[0]), { noerror: true });
      } else {
        nullSkip = true;
        const fn = typeof rest[0] === "symbol" ? e8.symbolName(rest[0]) : String(rest[0]);
        const args = rest.slice(1);
        if (fn === "forward-line") forwardLine(args.length > 0 ? Number(args[0]) : 1);
        else if (e8.fboundp(fn)) e8.funcall(fn, ...args);
        else if (e8.commandExists(fn)) (e8.call as (name: string, ...rest: e8.Value[]) => void)(fn, ...args);
      }
      break;
    }
  }
  if (e8.point() === start && !nullSkip) {
    e8.message(`Matching region end for ‘${key}’ point ${start + 1} not found`);
    e8.beep();
    e8.sitFor(2);
  }
}

/** The next line of text to check, from `start` to `end`, as ispell-get-line. */
function getLine(start: number, end: number, inComment: string | undefined): string | undefined {
  const casechars = getCasechars();
  if (e8.point() === e8.lineEndPosition()) {
    forwardLine(1);
    return undefined;
  }
  if (e8.reSearchForward(casechars, { bound: end, noerror: true }) !== undefined || e8.reSearchForward("[][()${}]", { bound: end, noerror: true }) !== undefined) {
    e8.gotoChar(end);
    return `^${inComment ?? ""}${e8.bufferSubstringNoProperties(start, end)}\n`;
  }
  e8.gotoChar(end);
  return undefined;
}

/** How many bytes UTF-8 takes for a string. */
function utf8Length(s: string): number {
  let n = 0;
  for (const c of s) {
    const code = c.codePointAt(0)!;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

/** The character offset in `line` of a word the checker placed at `offset`, which some checkers count in bytes. */
function alignOffset(line: string, word: string, offset: number): number {
  const chars = [...line];
  if (chars.slice(offset, offset + [...word].length).join("") === word) return offset;
  for (let i = 0; i <= chars.length; i++) if (utf8Length(chars.slice(0, i).join("")) === offset) return i;
  return offset;
}

/** Checks a line, asking about each misspelling in it, as ispell-process-line: returns the shift and the last word asked about. */
function processLine(text: string, shiftIn: number | undefined, bounds: { start: number; end: number }): [number, number | undefined] {
  let shift = typeof shiftIn === "number" ? shiftIn : 0;
  let maxWord: number | undefined;
  const acceptList: string[] = [];
  sendString(text);
  let pending = filter.slice();
  if (pending.length > 0 && pending[pending.length - 1] === "") pending.pop();
  filter = [];
  while (ispellQuit === false && pending.length > 0) {
    const line = pending.shift()!;
    const poss = parseOutput(line, acceptList, shift);
    if (!Array.isArray(poss)) continue;
    const [misspelled, rawOffset, miss, guess] = poss;
    const lineText = text.slice(0);
    const offset = alignOffset(lineText, misspelled, rawOffset - shift) + shift;
    const wordStart = e8.makeMarker(bounds.start - 1 + offset);
    const wordLen = [...misspelled].length;
    const lineEnd = e8.makeMarker(bounds.end);
    const lineStart = e8.makeMarker(bounds.start);
    let recheckRegion = false;
    e8.gotoChar(e8.markerPosition(wordStart)!);
    const at = e8.markerPosition(wordStart)!;
    if (e8.bufferSubstringNoProperties(at, Math.min(e8.pointMax(), at + wordLen)) !== misspelled) {
      for (const m of [wordStart, lineEnd, lineStart]) e8.deleteMarker(m);
      e8.signal("error", `Ispell misalignment: word \`${misspelled}' point ${at + 1}; probably incompatible versions`);
    }
    maxWord = at;
    const ask = () => commandLoop(miss, guess, misspelled, e8.markerPosition(wordStart)!, e8.markerPosition(wordStart)! + wordLen);
    let replace: Replace = truthy(v("ispell-keep-choices-win")) ? ask() : e8.saveWindowExcursion(ask);
    e8.gotoChar(e8.markerPosition(wordStart)!);
    if (Array.isArray(replace) && replace.length === 2) {
      if (isSym(v("ispell-parser"), "tex") && /[\\][\][()]|\\begin|\$/.test(regexpQuote(text))) {
        e8.signal("error", "Don't start query replace on a line with math characters");
      }
      e8.setMarker(lineEnd, e8.point());
      pending = [];
      recheckRegion = true;
    }
    if (replace === null || replace === 0) {
      if (replace === 0) addPerFileWordList(misspelled);
      acceptList.unshift(misspelled);
    } else {
      e8.deleteRegion(e8.point(), e8.point() + wordLen);
      if (typeof replace === "string") {
        e8.insert(replace);
        sendReplacement(misspelled, replace);
        acceptList.unshift(replace);
      } else {
        const replaceWord = replace[0];
        e8.insert(replaceWord);
        sendReplacement(misspelled, replaceWord);
        if (replace.length > 1 && truthy(replace[1])) {
          e8.saveWindowExcursion(() => {
            e8.call("delete-other-windows");
            queryReplace(misspelled, replaceWord, true);
          });
        }
        e8.gotoChar(e8.markerPosition(wordStart)!);
        if (acceptList.includes(replaceWord)) {
          acceptList.unshift(replaceWord);
          replace = replaceWord;
        } else {
          const savedEnd = regionEndPosition();
          const saved = pending;
          pending = [];
          const ws = e8.markerPosition(wordStart)!;
          const result = ispellRegion(ws, ws + [...replaceWord].length, true, 0);
          shift = result === null ? 0 : result;
          if (savedEnd !== undefined) setRegionEnd(savedEnd);
          pending = saved;
          recheckRegion = false;
          replace = replaceWord;
        }
      }
      shift += [...(typeof replace === "string" ? replace : replace[0])].length - wordLen;
    }
    if (ispellQuit === false) {
      e8.message(
        `Continuing spelling check using ${e8.fileNameNondirectory(String(v("ispell-program-name")))} with ${str("ispell-current-dictionary") ?? "default"} dictionary...`,
        { log: false },
      );
    }
    bounds.start = e8.markerPosition(lineStart)!;
    bounds.end = e8.markerPosition(lineEnd)!;
    const ws = e8.markerPosition(wordStart)!;
    if (!recheckRegion && bounds.end < ws + wordLen) bounds.end = ws + wordLen;
    if (ws === regionEndPosition()) setRegionEnd(ws + wordLen);
    for (const m of [wordStart, lineEnd, lineStart]) e8.deleteMarker(m);
  }
  return [shift, maxWord];
}

/** Tells Aspell and Enchant what a misspelling was corrected to, for their suggestions, as ispell-send-replacement. */
function sendReplacement(misspelled: string, replacement: string): void {
  if (v("ispell-really-aspell") !== null || v("ispell-really-enchant") !== null) sendString(`$$ra ${misspelled},${replacement}
`);
}

function setRegionEnd(pos: number | null): void {
  if (pos === null) {
    if (regionEnd !== undefined) e8.deleteMarker(regionEnd);
    regionEnd = undefined;
    return;
  }
  if (regionEnd === undefined) regionEnd = e8.makeMarker(pos);
  else e8.setMarker(regionEnd, pos, e8.currentBuffer());
}

/**
 * Checks the region, asking about each misspelling, as ispell-region:
 * returns null if the session was stopped, else the shift of the last line.
 */
export function ispellRegion(regStartIn: number, regEndIn: number, recheckp = false, shiftIn?: number): number | null {
  let regStart = regStartIn;
  let regEnd = regEndIn;
  let shift = shiftIn;
  setSpellcheckerParams();
  if (!recheckp) acceptBufferLocalDefs();
  const regionType = regStart === e8.pointMin() && regEnd === e8.pointMax() ? e8.bufferName() : "region";
  const program = e8.fileNameNondirectory(String(v("ispell-program-name")));
  const dictionary = str("ispell-current-dictionary") ?? "default";
  let maxWord: number | undefined;
  let skipStart: e8.Marker | undefined;
  const rstart = e8.makeMarker(regStart);
  let result: number | null = null;
  try {
    result = e8.saveExcursion(() => {
      e8.message(`Spell-checking ${regionType} using ${program} with ${dictionary} dictionary...`);
      return e8.saveWindowExcursion(() => {
        e8.gotoChar(regStart);
        let key: string | undefined;
        let inComment: string | undefined;
        const skipRe = beginSkipRegionRegexp();
        if (e8.reSearchForward(skipRe, { bound: regEnd, noerror: true }) !== undefined) {
          key = e8.matchString(0) ?? "";
          skipStart = e8.makeMarker(e8.point() - [...key].length);
          e8.gotoChar(regStart);
        }
        e8.setMarker(rstart, regStart);
        setRegionEnd(regEnd);
        while (ispellQuit === false && e8.point() < (regionEndPosition() ?? e8.point())) {
          if (skipStart !== undefined && e8.markerPosition(skipStart) !== undefined && e8.markerPosition(skipStart)! <= e8.point()) {
            const here = e8.point();
            const commentStart = str("comment-start");
            const commentEnd = str("comment-end") ?? "";
            inComment = undefined;
            if (commentStart && commentEnd === "") {
              const bol = e8.lineBeginningPosition();
              const m = e8.saveExcursion(() => {
                e8.gotoChar(bol);
                return e8.reSearchForward(commentStart, { bound: here, noerror: true });
              });
              if (m !== undefined) inComment = commentStart;
            }
            skipRegion(key!);
            e8.setMarker(rstart, e8.point());
            const end = regionEndPosition()!;
            if (e8.point() < end && e8.reSearchForward(skipRe, { bound: end, noerror: true }) !== undefined) {
              key = e8.matchString(0) ?? "";
              e8.setMarker(skipStart, e8.point() - [...key].length);
              e8.gotoChar(e8.markerPosition(rstart)!);
            } else {
              e8.deleteMarker(skipStart);
              skipStart = undefined;
            }
          }
          const skipAt = skipStart === undefined ? undefined : e8.markerPosition(skipStart);
          regEnd = Math.max(e8.point(), skipAt !== undefined ? Math.min(skipAt, regionEndPosition()!) : regionEndPosition()!);
          const bounds = { start: e8.point(), end: Math.min(e8.lineEndPosition(), regEnd) };
          const addComment = inComment !== undefined && inComment !== "dnl " ? inComment : undefined;
          const text = getLine(bounds.start, bounds.end, addComment);
          if (addComment !== undefined) {
            bounds.start -= [...addComment].length;
            inComment = undefined;
          }
          bounds.end = e8.point();
          if (text !== undefined) {
            const [newShift, word] = processLine(text, recheckp ? shift : undefined, bounds);
            shift = newShift;
            if (word !== undefined) maxWord = word;
          }
          e8.gotoChar(bounds.end);
        }
        return ispellQuit !== false ? null : (shift ?? 0);
      });
    });
  } finally {
    if (!(recheckp && truthy(v("ispell-keep-choices-win"))) && e8.getBuffer(CHOICES) !== undefined) e8.call("kill-buffer", CHOICES);
    if (skipStart !== undefined) e8.deleteMarker(skipStart);
    e8.deleteMarker(rstart);
    if (maxWord !== undefined) e8.pushMark(maxWord);
    if (ispellQuit !== false) {
      if (typeof ispellQuit !== "number") setRegionEnd(null);
      else e8.gotoChar(ispellQuit);
      if (!recheckp) ispellQuit = false;
    } else {
      if (!recheckp) setRegionEnd(null);
      pdictSave(truthy(v("ispell-silently-savep")));
      e8.message(`Spell-checking ${regionType} using ${program} with ${dictionary} dictionary...done`);
    }
  }
  return result;
}

/** Checks the comments and strings in a region, as ispell-comments-and-strings. */
export function commentsAndStrings(start?: number, end?: number): void {
  const stop = end ?? e8.pointMax();
  let pos = start ?? e8.pointMin();
  e8.gotoChar(pos);
  while (pos < stop) {
    // The next comment or string, as parse-partial-sexp stops at one.
    let from: number | undefined;
    for (let p = pos; p < stop; p++) {
      const state = e8.syntaxPpss(p + 1);
      if (state.inString !== null || state.inComment !== null) {
        from = state.start ?? p;
        break;
      }
    }
    if (from === undefined) {
      e8.gotoChar(stop);
      return;
    }
    let to = from + 1;
    while (to < stop) {
      const state = e8.syntaxPpss(to);
      if (state.inString === null && state.inComment === null) break;
      to++;
    }
    const state = e8.syntaxPpss(to);
    if (to >= stop && (state.inString !== null || state.inComment !== null)) e8.signal("error", "Unterminated string or comment");
    const done = e8.saveExcursion(() => ispellRegion(from!, to) === null);
    if (done) return;
    pos = to;
    e8.gotoChar(pos);
  }
}

/** Continues a stopped session from the word at point, as ispell-continue. */
export function ispellContinue(): void {
  const end = regionEndPosition();
  if (end === undefined) {
    e8.message("No session to continue.  Use ‘X’ command when checking!");
    return;
  }
  const buffer = e8.markerBuffer(regionEnd!);
  if (buffer !== e8.bufferName()) {
    e8.message(`Must continue ispell from buffer ${buffer}`);
    return;
  }
  ispellRegion(getWord(true).start, end);
}

// Completing words.

/** Words completing the word at point, from the plain word list, as ispell-completion-at-point. */
export function completionAtPoint(): [number, number, string[]] | null {
  const here = e8.point();
  const [start, end] = e8.saveExcursion(() => {
    e8.skipSyntaxBackward("w");
    const beg = e8.point();
    e8.gotoChar(here);
    e8.skipSyntaxForward("w");
    return [beg, e8.point()];
  });
  if (start === end || !(start < here && here <= end)) return null;
  const word = e8.bufferSubstringNoProperties(start, end);
  const len = [...word].length;
  const all = [word, ...e8.letBind({ "inhibit-message": true }, () => lookupWords(word))];
  const prefixP = (w: string) => w.toLowerCase().startsWith(word.toLowerCase());
  for (let k = 0; k < all.length; k++) {
    if (!all[k].startsWith(word)) all[k] = word + [...all[k]].slice(len).join("");
    while (k + 1 < all.length && !prefixP(all[k + 1])) all.splice(k + 1, 1);
  }
  return [start, end, all.slice(1)];
}

/** Completes the word before point from the plain word list, offering the choices as for a misspelling, as ispell-complete-word. */
export function completeWord(interiorFrag = false): void {
  const found = getWord(false, "\\*");
  const { start, end } = found;
  const word = found.word;
  let possibilities: string[] | true =
    word === ""
      ? true
      : lookupWords(`${interiorFrag ? "*" : ""}${word}${interiorFrag ? "*" : ""}`, str("ispell-complete-word-dict") ?? str("ispell-alternate-dictionary"));
  if (possibilities === true) e8.message("No word to complete");
  else if (possibilities.length === 0) e8.message(`No match for "${word}"`);
  else {
    if (e8.upcase(word) === word) possibilities = possibilities.map((p) => e8.upcase(p));
    else if (e8.upcase(word[0]) === word[0]) possibilities = possibilities.map((p) => (p[0] === word[0] ? p : e8.capitalize(p)));
    const options = possibilities;
    const replacement = e8.saveWindowExcursion(() => commandLoop(options, [], word, start, end));
    if (replacement === 0) addPerFileWordList(word);
    else if (replacement !== null) {
      e8.deleteRegion(start, end);
      e8.gotoChar(start);
      e8.insert(typeof replacement === "string" ? replacement : replacement[0]);
      if (typeof replacement !== "string") ispellWord(false, true);
    }
    if (e8.getBuffer(CHOICES) !== undefined) e8.call("kill-buffer", CHOICES);
  }
  pdictSave(truthy(v("ispell-silently-savep")));
}

// The words a buffer accepts for the session, as flyspell's corrections give them.

/** Accepts a word for the rest of the session, as ispell's @ does. */
export function acceptForSession(word: string): void {
  sendString(`@${word}\n`);
  if (!truthy(v("ispell-pdict-modified-p"))) set("ispell-pdict-modified-p", [v("ispell-pdict-modified-p") ?? null]);
}

/** Puts a word in the personal dictionary and saves it, as flyspell's Save word does. */
export function insertPersonal(word: string): void {
  sendString(`*${word}\n`);
  sendString("#\n");
  set("ispell-pdict-modified-p", [true]);
}

/** Accepts a word for the session in this buffer, as ispell-buffer-session-localwords. */
export function acceptInBuffer(word: string): void {
  const words = list(v("ispell-buffer-session-localwords")).map(String);
  if (!words.includes(word)) set("ispell-buffer-session-localwords", [word, ...words]);
  if (v("ispell-buffer-local-name") === null) set("ispell-buffer-local-name", e8.bufferName());
}

// Commands.

e8.defineCommand({
  name: "ispell-word",
  doc:
    "Check the spelling of the word at point, or before it, and offer corrections in *Choices* if it is wrong.\n\n" +
    "A character picks a correction, SPC leaves the word, i adds it to your personal dictionary, a accepts it for " +
    "this session, A in this file's LocalWords, r types a replacement and R replaces it throughout, l looks words up " +
    "in a word list, x and X stop, and ? says more. With a prefix argument, continue a session X stopped; with the " +
    "region active, check the region.",
  params: [{ name: "resume", kind: "prefix" }],
  run: (prefix: e8.PrefixArg) => {
    ispellWord(truthy(v("ispell-following-word")), truthy(v("ispell-quietly")), prefix !== null, true);
  },
});
e8.bindKey("M-$", "ispell-word");

e8.defineCommand({
  name: "ispell-region",
  doc: "Check the spelling of the region, asking about each misspelling in turn; the mark is left at the last one asked about.",
  params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }],
  run: (start: number, end: number) => {
    ispellRegion(start, end);
  },
});

e8.defineCommand({
  name: "ispell-buffer",
  doc: "Check the spelling of the buffer, asking about each misspelling in turn; the mark is left at the last one asked about.",
  run: () => {
    ispellRegion(e8.pointMin(), e8.pointMax());
  },
});

e8.defineCommand({
  name: "ispell-buffer-with-debug",
  doc: "Check the spelling of the buffer, as ispell-buffer does.",
  params: [{ name: "append", kind: "prefix" }],
  run: () => {
    ispellRegion(e8.pointMin(), e8.pointMax());
  },
});

e8.defineCommand({
  name: "ispell",
  doc: "Check the spelling of the region if it is active, else the buffer.",
  run: () => {
    if (e8.regionActive()) {
      const mark = e8.mark() ?? e8.point();
      ispellRegion(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
    } else ispellRegion(e8.pointMin(), e8.pointMax());
  },
});

e8.defineCommand({
  name: "ispell-continue",
  doc: "Continue a spelling session X stopped, from the word at point.",
  run: () => ispellContinue(),
});

e8.defineCommand({
  name: "ispell-comments-and-strings",
  doc: "Check the spelling of the comments and strings in the buffer, or in the region if it is active.",
  run: () => {
    if (e8.regionActive()) {
      const mark = e8.mark() ?? e8.point();
      commentsAndStrings(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
    } else commentsAndStrings();
  },
});

e8.defineCommand({
  name: "ispell-comment-or-string-at-point",
  doc: "Check the spelling of the comment or string point is in.",
  run: () => {
    e8.saveExcursion(() => {
      const state = e8.syntaxPpss();
      if (state.inString === null && state.inComment === null) e8.userError("Not inside a string or comment");
      const start = state.start!;
      let to = e8.point();
      while (to < e8.pointMax()) {
        const s = e8.syntaxPpss(to);
        if (s.inString === null && s.inComment === null) break;
        to++;
      }
      ispellRegion(start, to);
    });
  },
});

e8.defineCommand({
  name: "ispell-change-dictionary",
  doc:
    "Change the dictionary spelling is checked with, for this buffer, or for all with a prefix argument. " +
    "RET says which it is. Hunspell takes several at once, as en_US,sv_SE, after ispell-hunspell-add-multi-dic.",
  params: [
    {
      name: "dict",
      prompt: "Use new dictionary (RET for current, SPC to complete): ",
      collection: () => validDictionaryList(),
      requireMatch: true,
    },
    { name: "global", kind: "prefix" },
  ],
  run: (dict: string, global: e8.PrefixArg) => changeDictionary(dict, global !== null, e8.thisCommand() === "ispell-change-dictionary"),
});

e8.defineCommand({
  name: "ispell-hunspell-add-multi-dic",
  doc: "Make a combination of Hunspell dictionaries, as en_US,sv_SE, one to choose with ispell-change-dictionary or ispell-dictionary.",
  params: [{ name: "dict", prompt: "Multi-dictionary combination: " }],
  run: (dict: string) => hunspellAddMultiDic(dict),
});

e8.defineCommand({
  name: "ispell-kill-ispell",
  doc: "End the spelling session, forgetting the words accepted in this buffer, so the next check starts afresh.",
  run: () => {
    killIspell(false, true);
  },
});

e8.defineCommand({
  name: "ispell-pdict-save",
  doc: "Save the personal dictionary, asking first unless ispell-silently-savep.",
  run: () => pdictSave(truthy(v("ispell-silently-savep")), true),
});

e8.defineCommand({
  name: "ispell-check-version",
  doc: "Say which spell checker ispell-program-name is and its version.",
  run: () => {
    checkVersion(true);
  },
});
e8.defineCommand({
  name: "check-ispell-version",
  doc: "Say which spell checker ispell-program-name is and its version.",
  run: () => {
    checkVersion(true);
  },
});

e8.defineCommand({
  name: "ispell-help",
  doc: HELP_LONG,
  run: () => e8.call("describe-function", "ispell-help" as never),
});

e8.defineCommand({
  name: "ispell-complete-word",
  doc:
    "Complete the word before point from the plain word list, ispell-complete-word-dict or ispell-alternate-dictionary, " +
    "offering the completions as for a misspelling. With a prefix argument, the word may be part of a longer one.",
  params: [{ name: "interior-frag", kind: "prefix" }],
  run: (prefix: e8.PrefixArg) => completeWord(prefix !== null),
});

e8.defineCommand({
  name: "ispell-complete-word-interior-frag",
  doc: "Complete the characters before point as part of a word from the plain word list.",
  run: () => completeWord(true),
});

e8.defun("ispell-completion-at-point", () => completionAtPoint());
e8.defun("ispell-valid-dictionary-list", () => validDictionaryList());
e8.defun("ispell-set-spellchecker-params", () => setSpellcheckerParams());
e8.defun("ispell-get-word", (following?: boolean, extra?: string) => {
  const w = getWord(truthy(following ?? null), extra);
  return [w.word, w.start, w.end];
});
e8.defun("ispell-correct-p", (following?: boolean) => correctP(truthy(following ?? null)));
e8.defun("ispell-lookup-words", (word: string, dict?: string) => lookupWords(word, dict));
e8.defun("ispell-add-per-file-word-list", (word: string) => addPerFileWordList(word));
e8.defun("ispell-accept-buffer-local-defs", () => acceptBufferLocalDefs());
e8.defun("ispell-init-process", () => initProcess());
e8.defun("ispell-send-string", (s: string) => sendString(s));
e8.defun("ispell-parse-output", (s: string) => parseOutput(s) ?? null);

// Ispell minor mode: SPC and RET check the word before them.

const minorCheck = e8.defineCommand({
  name: "ispell-minor-check",
  doc: "Check the word before point, then do what the key does without ispell-minor-mode.",
  run: () => {
    const last = e8.charBefore(e8.point());
    const keys = e8.thisCommandKeys();
    e8.letBind({ "ispell-minor-mode": false, "ispell-check-only": true }, () => {
      let ran = false;
      for (const map of e8.currentActiveMaps()) {
        const binding = e8.lookupKey(map, keys);
        if (typeof binding === "string" && binding !== "ispell-minor-check" && e8.commandExists(binding)) {
          e8.call(binding as e8.CommandName);
          ran = true;
          break;
        }
      }
      // A character no keymap names inserts itself.
      if (!ran) e8.call("self-insert-command");
      const html = truthy(v("ispell-skip-html"));
      if (!(last === " " || last === "\n" || (html && (last === ">" || last === ";")))) ispellWord(false, true);
    });
  },
});

export const ispellMinorMode = e8.defineMinorMode({
  name: "ispell-minor-mode",
  lighter: " Spell",
  bindings: { SPC: minorCheck, RET: minorCheck },
  doc:
    "Check the word before point when SPC or RET is typed, warning if it is wrong.\n\n" +
    "The buffer's own dictionary and words are not read: M-$ SPC reads them. To check as you type, use flyspell-mode.",
});
