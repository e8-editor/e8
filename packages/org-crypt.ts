// Org Crypt, after Org's org-crypt.el: the text of an entry encrypted
// with GnuPG, through epg.ts, its heading, planning line and property
// drawer left readable. Entries whose tags match org-crypt-tag-matcher,
// "crypt" by default, are encrypted by org-encrypt-entries, and before
// each save once org-crypt-use-before-save-magic has run, as a config
// does (e8.require("org-crypt"); e8.funcall("org-crypt-use-before-save-magic")).
// The key is org-crypt-key, or the entry's CRYPTKEY property, matched
// against gpg's keys; with none, or with org-crypt-key nil, encryption is
// symmetric, with a passphrase. Decrypted text keeps the encrypted text
// it came from, so saving it unchanged encrypts nothing again.
//
// Not loaded at startup: its commands are autoloaded from org-loaddefs.ts.

import { epgDecryptString, epgEncryptString, epgListKeys, epgMakeContext, type EpgContext, type EpgKey } from "epg";
import { firstHeadingFrom, type Heading, headingIndex, headings, makeTagsMatcher, matchContexts, selectiveGetter, subtreeEnd, subtreeRegion } from "org";
import { flag, startupVisibility } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt } from "org-macs";

e8.defineVariable({
  name: "org-crypt-tag-matcher",
  value: "crypt",
  doc: 'The tag matcher used to find headings whose contents should be encrypted, as the Org manual\'s "Match syntax" has it.',
});
e8.defineVariable({
  name: "org-crypt-key",
  value: "",
  doc:
    "The default key to use when encrypting the contents of a heading. If nil, always use symmetric encryption. " +
    "Otherwise the string is matched against all keys in the key ring; the empty string matches no key. If no key is " +
    "found, epa-file-encrypt-to is looked at, and encryption is symmetric in the end. The CRYPTKEY property overrides it.",
});
e8.defineVariable({
  name: "org-crypt-disable-auto-save",
  value: e8.intern("ask"),
  doc:
    "What org-decrypt-entry does if auto-save-mode is on: t turns it off for the buffer before decrypting; nil leaves it " +
    "on, which may write decrypted text to disk; ask asks whether to turn it off; encrypt leaves it on but encrypts " +
    "every decrypted entry again before each auto-save, which works only for entries org-crypt-tag-matcher matches.",
});

const v = (name: string): e8.Value => e8.variable(name) ?? null;
const truthy = (x: e8.Value | undefined): boolean => x !== null && x !== undefined && x !== false;
const named = (x: e8.Value, name: string): boolean => x === name || (typeof x === "symbol" && e8.symbolName(x) === name);

/** Runs `f` with the buffer widened, point kept, as org-with-wide-buffer. */
function withWideBuffer<T>(f: () => T): T {
  return e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      return f();
    }),
  );
}

/** The heading point is under, as org-back-to-heading finds it, or Org's error before the first. */
function backToHeading(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) e8.userError(`Before first headline at position ${e8.lineStart(lineAt()) + 1} in buffer ${e8.bufferName()}`);
  return [all, i];
}

/** The encrypted text between two positions, its indentation taken off, as org-crypt--encrypted-text. */
function encryptedText(beg: number, end: number): string {
  return e8.bufferSubstringNoProperties(beg, end).replace(/^[ \t]*/gm, "");
}

/**
 * Where the current entry's encrypted text starts and ends, if it is
 * encrypted, as org-at-encrypted-entry-p: a PGP message's first line
 * after the planning line and property drawer, and its last line before
 * any heading, to the start of the line after it.
 */
export function atEncryptedEntryP(): [number, number] | undefined {
  return withWideBuffer(() => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i === undefined) return undefined;
    const start = endOfMetaData(all[i], "logbook");
    if (start >= e8.bufferSize() || !/^[ \t]*-----BEGIN PGP MESSAGE-----$/.test(e8.lineText(lineAt(start)))) return undefined;
    for (let l = lineAt(start) + 1; l < e8.lineCount(); l++) {
      const text = e8.lineText(l);
      if (/^[ \t]*-----END PGP MESSAGE-----$/.test(text)) return [start, l + 1 < e8.lineCount() ? e8.lineStart(l + 1) : e8.bufferSize()];
      if (/^\*+ /.test(text)) return undefined;
    }
    return undefined;
  });
}

/** Re-encrypts the decrypted entries before an auto-save, as org-crypt's lambda on auto-save-hook. */
function reencryptBeforeAutoSave(): void {
  e8.message("org-crypt: Re-encrypting all decrypted entries due to auto-save.");
  encryptEntries();
}

/**
 * Decides what to do about auto-saving before an entry is decrypted, as
 * org-crypt-check-auto-save, as org-crypt-disable-auto-save says.
 */
function checkAutoSave(): void {
  const autoSaveName = v("buffer-auto-save-file-name");
  if (!truthy(autoSaveName) && !e8.autoSaving()) return;
  const how = v("org-crypt-disable-auto-save");
  if (
    how === true ||
    (named(how, "ask") && e8.yOrNP("`org-decrypt': auto-save-mode may cause leakage.  Disable it for current buffer? "))
  ) {
    e8.message(`org-decrypt: Disabling auto-save-mode for ${e8.bufferFileName() ?? e8.bufferName()}`);
    e8.setAutoSave(false);
  } else if (!truthy(how)) {
    e8.message("org-decrypt: Decrypting entry with auto-save-mode enabled.  This may cause leakage.");
  } else if (named(how, "encrypt")) {
    e8.message("org-decrypt: Enabling re-encryption on auto-save.");
    e8.addHook("auto-save-hook", reencryptBeforeAutoSave, { local: true });
  }
}

/**
 * The keys to encrypt the heading point is under to, as
 * org-crypt-key-for-heading: those matching its CRYPTKEY property, or
 * org-crypt-key, else epa-file-encrypt-to's; undefined for symmetric
 * encryption.
 */
function keyForHeading(context: EpgContext): EpgKey[] | undefined {
  const defaultKey = v("org-crypt-key");
  if (!truthy(defaultKey)) return undefined;
  const all = headings();
  const i = headingIndex(all, lineAt());
  const property = i === undefined ? undefined : selectiveGetter(true)(all[i], "CRYPTKEY");
  const name = property === "nil" ? "" : (property ?? (typeof defaultKey === "string" ? defaultKey : ""));
  const keys = epgListKeys(context, name);
  if (keys.length > 0) return keys;
  // A list of keys to encrypt files to, as epa-file has it, if the buffer sets one.
  const encryptTo = e8.boundp("epa-file-encrypt-to") ? v("epa-file-encrypt-to") : null;
  if (typeof encryptTo === "string" || (Array.isArray(encryptTo) && encryptTo.length > 0)) {
    const named = epgListKeys(context, Array.isArray(encryptTo) ? encryptTo.map(String) : encryptTo);
    if (named.length > 0) return named;
  }
  e8.message("No crypt key set, using symmetric encryption.");
  return undefined;
}

/** Keys as a text property keeps them, to be compared with equal. */
function keyValue(keys: EpgKey[] | undefined): string | null {
  return keys === undefined ? null : JSON.stringify(keys);
}

/** A string's property at its first character, as (get-text-property 0 PROP STRING). */
function propertyAtStart(s: e8.PropertizedString, name: string): e8.Value {
  for (const [start, end, props] of s.properties) if (start <= 0 && end > 0 && name in props) return props[name] ?? null;
  return null;
}

/** Folds the subtree of the heading at a position, as org-fold-subtree. */
function foldSubtreeAt(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i !== undefined) flag(e8.lineEnd(all[i].line), subtreeEnd(all, i), true);
}

/** The heading org-previous-visible-heading goes to from a position. */
function previousVisibleHeading(pos: number): number {
  return e8.saveExcursion(() => {
    e8.gotoChar(pos);
    e8.call("org-previous-visible-heading");
    return e8.point();
  });
}

/**
 * Where org-back-over-empty-lines goes from POS: back over whitespace, to
 * the start of the line after it, but never past POS.
 */
function backOverEmptyLines(pos: number): number {
  let p = pos;
  while (p > e8.pointMin() && /[ \t\n\r]/.test(e8.bufferText(p - 1, p))) p--;
  const line = lineAt(p);
  const next = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.pointMax();
  return Math.min(next, pos);
}

/** Encrypts the contents of the heading point is under, as org-encrypt-entry. */
export function encryptEntry(): void {
  if (atEncryptedEntryP()) return;
  const context = epgMakeContext(null, true, true);
  withWideBuffer(() => {
    const [all, i] = backToHeading();
    const startHeading = all[i].start;
    e8.gotoChar(startHeading);
    const cryptKey = keyForHeading(context);
    const folded = e8.invisibleAt(startHeading);
    const beg = endOfMetaData(all[i], "logbook");
    const foldedHeading = folded ? previousVisibleHeading(beg) : undefined;
    const end = backOverEmptyLines(Math.min(subtreeRegion(all, i)[1], e8.pointMax()));
    // As delete-and-extract-region, which takes its ends in either order.
    const [from, to] = beg <= end ? [beg, end] : [end, beg];
    const contents = e8.deleteAndExtractRegion(from, to);
    e8.gotoChar(from);
    const plain = contents.string;
    const key = propertyAtStart(contents, "org-crypt-key");
    const checksum = propertyAtStart(contents, "org-crypt-checksum");
    try {
      // Text and key have to be the same, else it is encrypted again.
      if (keyValue(cryptKey) === key && checksum === e8.secureHash("sha1", plain)) e8.insert(String(propertyAtStart(contents, "org-crypt-text")));
      else e8.insert(epgEncryptString(context, plain, cryptKey));
    } catch (err) {
      // If encryption failed, the entry's contents go back.
      e8.insert(contents);
      if (e8.errorConditions(err).length === 0) throw err;
      e8.signal("error", e8.errorMessageString(err as e8.SignalledError));
    }
    if (foldedHeading !== undefined) foldSubtreeAt(foldedHeading);
  });
}

/** Decrypts the contents of the heading point is under, if they are encrypted, as org-decrypt-entry. */
export function decryptEntry(): void {
  const found = atEncryptedEntryP();
  if (!found) return;
  const [beg, end] = found;
  const context = epgMakeContext(null, true, true);
  e8.saveExcursion(() => {
    e8.gotoChar(beg);
    checkAutoSave();
    const foldedHeading = e8.invisibleAt(e8.point()) ? previousVisibleHeading(e8.point()) : undefined;
    const all = headings();
    const level = all[headingIndex(all, lineAt())!].level;
    const encrypted = encryptedText(beg, end);
    const decrypted = epgDecryptString(context, encrypted);
    // From just before point, as the outline property starts at the heading's newline.
    e8.deleteRegion(e8.point() - 1, end);
    const origin = e8.makeMarker(e8.point());
    const headline = new RegExp(`^\\*{1,${level}} `, "gm");
    const found = decrypted.match(headline);
    if (found) {
      // Headings in the decrypted text at the entry's level or above go below it.
      const minLevel = Math.min(level, ...found.map((m) => m.length - 1));
      e8.insert("\n" + decrypted.replace(/^\*+ /gm, (m) => "*".repeat(1 + level - minLevel) + m));
    } else {
      // The checksum and the encrypted text are kept, so that the same
      // text encrypted with the same key is not encrypted again.
      e8.insert(
        e8.concat(
          "\n",
          e8.propertize(decrypted, {
            "org-crypt-checksum": e8.secureHash("sha1", decrypted),
            "org-crypt-key": keyValue(keyForHeading(context)),
            "org-crypt-text": encrypted,
          }),
        ),
      );
    }
    // The entry's initial visibility, but the fold it was in kept.
    e8.saveRestriction(() => {
      e8.narrowToRegion(e8.markerPosition(origin)!, e8.point());
      e8.deleteMarker(origin);
      startupVisibility();
    });
    if (foldedHeading !== undefined) foldSubtreeAt(foldedHeading);
  });
}

/**
 * Calls `action` at each heading org-crypt-tag-matcher matches, from the
 * top, as org-scan-tags does for org-encrypt-entries: the headings are
 * found again after each call, which changes the text after the heading.
 */
function scanCryptTags(action: () => void): void {
  const matcher = makeTagsMatcher(String(v("org-crypt-tag-matcher") ?? "crypt"));
  const sublevels = truthy(v("org-tags-match-list-sublevels"));
  e8.saveExcursion(() => {
    let from = e8.pointMin();
    for (;;) {
      const all = e8.saveRestriction(() => (e8.widen(), headings()));
      const contexts = matchContexts(all);
      let i = firstHeadingFrom(all, from);
      while (i < all.length && all[i].start < e8.pointMax() && !matcher.test(contexts(i))) i++;
      if (i >= all.length || all[i].start >= e8.pointMax()) return;
      const start = e8.makeMarker(all[i].start);
      e8.gotoChar(all[i].start);
      try {
        e8.saveExcursion(action);
        const at = e8.markerPosition(start)!;
        if (sublevels) from = at + 1;
        else {
          const now = e8.saveRestriction(() => (e8.widen(), headings()));
          const k = headingIndex(now, lineAt(at));
          from = k === undefined ? at + 1 : subtreeEnd(now, k);
        }
      } finally {
        e8.deleteMarker(start);
      }
    }
  });
}

/** Encrypts every entry org-crypt-tag-matcher matches, as org-encrypt-entries. */
export function encryptEntries(): void {
  scanCryptTags(encryptEntry);
}

/** Decrypts every entry org-crypt-tag-matcher matches, as org-decrypt-entries. */
export function decryptEntries(): void {
  scanCryptTags(decryptEntry);
}

e8.defineCommand({ name: "org-encrypt-entry", doc: "Encrypt the content of the current headline.", run: () => encryptEntry() });
e8.defineCommand({ name: "org-decrypt-entry", doc: "Decrypt the content of the current headline.", run: () => decryptEntry() });
e8.defineCommand({ name: "org-encrypt-entries", doc: "Encrypt all top-level entries in the current buffer.", run: () => encryptEntries() });
e8.defineCommand({ name: "org-decrypt-entries", doc: "Decrypt all entries in the current buffer.", run: () => decryptEntries() });

/** What org-crypt-use-before-save-magic puts on org-mode-hook: entries encrypted before each save of an Org buffer. */
function encryptBeforeSave(): void {
  e8.addHook("before-save-hook", "org-encrypt-entries", { local: true });
}

/** Adds a hook to encrypt entries before an Org file is saved, as org-crypt-use-before-save-magic. */
export function useBeforeSaveMagic(): void {
  e8.addHook("org-mode-hook", encryptBeforeSave);
}

e8.defun("org-crypt-use-before-save-magic", useBeforeSaveMagic);
e8.defun("org-at-encrypted-entry-p", () => {
  const found = atEncryptedEntryP();
  return found ? [found[0], found[1]] : null;
});

// Decrypted when org-fold-reveal shows it, as org-crypt adds to its hook.
e8.addHook("org-fold-reveal-start-hook", "org-decrypt-entry");
