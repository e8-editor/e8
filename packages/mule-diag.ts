// Describing coding systems, after Emacs's mule-diag.el: C-h C shows what a
// coding system is, in Emacs's words for it, and with no name, the coding
// systems in use now.

import { readCodingSystem } from "mule";

/** The table's entry for a coding system without its end-of-line suffix, by its name or any alias. */
function entry(name: string): [string, string[], string, string] | undefined {
  return DESCRIPTIONS[name] ?? Object.values(DESCRIPTIONS).find(([, aliases]) => aliases.includes(name));
}

const EOL_NAMES = ["unix", "dos", "mac"];

/**
 * A coding system's name without the end-of-line suffix it was named with,
 * and the conversion that suffix gives, if it has one.
 */
function splitEol(coding: string): [string, number | undefined] {
  const m = /^(.*)-(unix|dos|mac)$/.exec(coding);
  if (m !== null && entry(m[1]!) !== undefined) return [m[1]!, EOL_NAMES.indexOf(m[2]!)];
  return [coding, undefined];
}

/** A coding system's names, its own first, with the suffix it was named with, as coding-system-aliases. */
function aliasesOf(coding: string): string[] {
  const [name, eol] = splitEol(coding);
  const aliases = entry(name)?.[1] ?? [name];
  return eol === undefined ? aliases : aliases.map((a) => `${a}-${EOL_NAMES[eol]}`);
}

/**
 * The coding system's mnemonic and name, and its aliases or what it is an
 * alias of, as print-coding-system-briefly: "U -- utf-8 (alias: mule-utf-8 cp65001)".
 */
export function codingSystemBriefly(coding: string | undefined): string {
  if (coding === undefined) return "nil\n";
  const mnemonic = entry(splitEol(coding)[0])?.[0] ?? String(e8.codingSystemMnemonic(coding));
  let line = `${mnemonic} -- ${coding}`;
  const aliases = aliasesOf(coding);
  if (coding === aliases[0]) {
    if (aliases.length > 1) line += ` (alias: ${aliases.slice(1).join(" ")})`;
  } else if (aliases.includes(coding)) {
    line += ` (alias of ${aliases[0]})`;
  }
  // An empty line after it, as when print-coding-system-briefly is not told to be tight.
  return `${line}\n\n`;
}

/** What describe-coding-system shows for `coding`. */
export function describeCodingSystemText(coding: string): string {
  const [name, eol] = splitEol(coding);
  const known = entry(name);
  if (known === undefined) return codingSystemBriefly(coding);
  const [, aliases, before, after] = known;
  const eolType = e8.codingSystemEolType(coding);
  const eolLine = Array.isArray(eolType)
    ? `EOL type: Automatic selection from:\n\t[${EOL_NAMES.map((e) => `${aliases[0]}-${e}`).join(" ")}]\n`
    : `EOL type: ${["LF", "CRLF", "CR"][eol ?? (eolType as number)]}\n`;
  return `${codingSystemBriefly(coding)}${before.slice(1)}${eolLine}${after}`;
}

e8.defineVariable({ name: "selection-coding-system", doc: "The coding system for text cut and pasted between programs, or nil for the default.", value: null });

/** What describe-current-coding-system shows: the coding systems in use now. */
function describeCurrentText(): string {
  const value = (v: e8.Value | undefined) => (typeof v === "string" ? v : undefined);
  let text = "Coding system for saving this buffer:\n  ";
  text += e8.isLocalVariable("buffer-file-coding-system")
    ? codingSystemBriefly(value(e8.variable("buffer-file-coding-system")))
    : "Not set locally, use the default.\n";
  text += "Default coding system (for new files):\n  " + codingSystemBriefly(value(e8.defaultValue("buffer-file-coding-system")));
  text += "Coding system for keyboard input:\n  " + codingSystemBriefly("utf-8-unix");
  text += "Coding system for terminal output:\n  " + codingSystemBriefly("utf-8-unix");
  text += "Coding system for inter-client cut and paste:\n  " + codingSystemBriefly(value(e8.variable("selection-coding-system")));
  const proc = e8.getBufferProcess(e8.bufferName());
  if (proc !== undefined) {
    const [decoding, encoding] = e8.processCodingSystem(proc) ?? [undefined, undefined];
    text += "Coding systems for process I/O:\n";
    text += "  encoding input to the process: " + codingSystemBriefly(encoding);
    text += "  decoding output from the process: " + codingSystemBriefly(decoding);
  }
  const defaults = e8.variable("default-process-coding-system");
  const [decoding, encoding] = Array.isArray(defaults) ? defaults.map(value) : [undefined, undefined];
  text += "Defaults for subprocess I/O:\n  decoding: " + codingSystemBriefly(decoding) + "  encoding: " + codingSystemBriefly(encoding);
  text += "\nPriority order for recognizing coding systems when reading files:\n";
  e8.codingSystemPriorityList().forEach((coding, i) => {
    text += `  ${i + 1}. ${coding} `;
    const aliases = aliasesOf(coding);
    if (aliases[0] === coding) {
      if (aliases.length > 1) text += `(alias: ${aliases.slice(1).join(" ")})`;
    } else text += `(alias of ${aliases[0]})`;
    text += "\n";
  });
  text +=
    "\n  Other coding systems cannot be distinguished automatically\n  from these, and therefore cannot be recognized automatically\n  with the present coding system priorities.\n\n";
  text += "Particular coding systems specified for certain file names:\n\n";
  text += "  OPERATION\tTARGET PATTERN\t\tCODING SYSTEM(s)\n";
  text += "  ---------\t--------------\t\t----------------\n";
  const list = (name: string) => {
    const v = e8.variable(name);
    return Array.isArray(v) ? (v as e8.Value[][]) : [];
  };
  text += alistLines("File I/O", [...list("auto-coding-alist"), ...list("file-coding-system-alist")]);
  text += alistLines("Process I/O", list("process-coding-system-alist"));
  text += alistLines("Network I/O", list("network-coding-system-alist"));
  return text;
}

/** A string as prin1 writes it: in double quotes, backslashes and quotes escaped. */
const prin1String = (s: string): string => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** A line grown to `column` with tabs and then spaces, as indent-to does with indent-tabs-mode. */
function indentTo(line: string, column: number): string {
  let col = [...line.split("\n").pop()!].reduce((c, ch) => (ch === "\t" ? Math.floor(c / 8) * 8 + 8 : c + 1), 0);
  if (col >= column) return line;
  let out = line;
  while (Math.floor(col / 8) * 8 + 8 <= column) {
    out += "\t";
    col = Math.floor(col / 8) * 8 + 8;
  }
  return out + " ".repeat(column - col);
}

/** What an alist entry's codings print as: a coding, (DECODING . ENCODING), or (DECODING) when encoding is nil. */
function codingsOf(entry: e8.Value[]): string {
  const [, decode, ...rest] = entry;
  const name = (v: e8.Value | undefined) => (typeof v === "symbol" ? ((v as symbol).description ?? "") : String(v));
  if (rest.length === 0) return name(decode);
  const encode = rest[0];
  return encode === null || encode === undefined || encode === false ? `(${name(decode)})` : `(${name(decode)} . ${name(encode)})`;
}

/** One operation's lines of the table, as describe-current-coding-system writes them. */
function alistLines(operation: string, alist: e8.Value[][]): string {
  let text = `  ${operation}`;
  if (alist.length === 0) return `${text}\tnothing specified\n`;
  for (const entry of alist) {
    text = indentTo(text, 16);
    text += typeof entry[0] === "string" ? prin1String(entry[0]) : String(entry[0]);
    const current = text.split("\n").pop()!;
    if ([...current].reduce((c, ch) => (ch === "\t" ? Math.floor(c / 8) * 8 + 8 : c + 1), 0) >= 40) text += "\n";
    text = indentTo(text, 40);
    text += `${codingsOf(entry)}\n`;
  }
  return text;
}

e8.defineCommand({
  name: "describe-current-coding-system",
  doc: "Show the coding systems in use now: for saving the buffer, for new files, for the keyboard and terminal, and for processes.",
  run: () => e8.showHelp(describeCurrentText()),
});

e8.defineCommand({
  name: "describe-coding-system",
  doc:
    "Show what a coding system is: its mnemonic, aliases, documentation, type, line ends and the charsets it can write.\n\n" +
    "With no name, show the coding systems in use now, as describe-current-coding-system.",
  run: async () => {
    const coding = await readCodingSystem("Describe coding system (default current choices): ", { asTyped: true });
    e8.showHelp(coding === undefined ? describeCurrentText() : describeCodingSystemText(coding));
  },
});
e8.bindKey("C-h C", "describe-coding-system");

// The table below is written by tests/emacs/mule-diag.el.
/** For each coding system: its mnemonic, its aliases, and Emacs's description before and after the line on its end-of-line conversion. */
const DESCRIPTIONS: Record<string, [string, string[], string, string]> = {
  "undecided": ["-", ["undecided"], "\nNo conversion on encoding, automatic conversion on decoding.\nType: undecided (do automatic conversion)\n", "This coding system encodes the following charsets:\n  ascii\n"],
  "prefer-utf-8": ["-", ["prefer-utf-8"], "\nLike ‘undecided’ but prefer UTF-8 when appropriate.\nOn decoding, if the source contains 8-bit codes and they all\nare valid UTF-8 sequences, detect the source as UTF-8 encoding\nregardless of the coding priority.\nOn encoding, if the source contains non-ASCII characters, encode them\nby UTF-8.\nType: undecided (do automatic conversion)\n", "This coding system encodes the following charsets:\n  emacs\n"],
  "utf-8": ["U", ["utf-8", "mule-utf-8", "cp65001"], "\nUTF-8 (no signature (BOM))\nType: utf-8 (UTF-8: Emacs internal multibyte form)\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-8-with-signature": ["U", ["utf-8-with-signature"], "\nUTF-8 (with signature (BOM))\nType: utf-8 (UTF-8: Emacs internal multibyte form)\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-8-auto": ["U", ["utf-8-auto"], "\nUTF-8 (auto-detect signature (BOM))\nType: utf-8 (UTF-8: Emacs internal multibyte form)\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-8-emacs": ["U", ["utf-8-emacs"], "\nSupport for all Emacs characters (including non-Unicode characters).\nType: utf-8 (UTF-8: Emacs internal multibyte form)\n", "This coding system encodes the following charsets:\n  emacs\n"],
  "utf-16": ["U", ["utf-16"], "\nUTF-16 (detect endian on decoding, use big endian on encoding with BOM).\nType: utf-16\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-16le": ["U", ["utf-16le"], "\nUTF-16LE (little endian, no signature (BOM)).\nType: utf-16\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-16be": ["U", ["utf-16be"], "\nUTF-16BE (big endian, no signature (BOM)).\nType: utf-16\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-16le-with-signature": ["U", ["utf-16le-with-signature", "utf-16-le"], "\nUTF-16 (little endian, with signature (BOM)).\nType: utf-16\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "utf-16be-with-signature": ["U", ["utf-16be-with-signature", "utf-16-be"], "\nUTF-16 (big endian, with signature (BOM)).\nType: utf-16\n", "This coding system encodes the following charsets:\n  unicode\n"],
  "us-ascii": ["-", ["us-ascii", "iso-safe", "ascii"], "\nEncode ASCII as-is and encode non-ASCII characters to ‘?’.\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii\n"],
  "iso-latin-1": ["1", ["iso-latin-1", "iso-8859-1", "latin-1"], "\nISO 2022 based 8-bit encoding for Latin-1 (MIME:ISO-8859-1).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-1\n"],
  "iso-latin-2": ["2", ["iso-latin-2", "iso-8859-2", "latin-2"], "\nISO 2022 based 8-bit encoding for Latin-2 (MIME:ISO-8859-2).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-2\n"],
  "iso-latin-3": ["3", ["iso-latin-3", "iso-8859-3", "latin-3"], "\nISO 2022 based 8-bit encoding for Latin-3 (MIME:ISO-8859-3).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-3\n"],
  "iso-latin-4": ["4", ["iso-latin-4", "iso-8859-4", "latin-4"], "\nISO 2022 based 8-bit encoding for Latin-4 (MIME:ISO-8859-4).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-4\n"],
  "cyrillic-iso-8bit": ["5", ["cyrillic-iso-8bit", "iso-8859-5"], "\nISO 2022 based 8-bit encoding for Cyrillic script (MIME:ISO-8859-5).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-5\n"],
  "greek-iso-8bit": ["7", ["greek-iso-8bit", "iso-8859-7"], "\nISO 2022 based 8-bit encoding for Greek (MIME:ISO-8859-7).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-7\n"],
  "hebrew-iso-8bit": ["8", ["hebrew-iso-8bit", "iso-8859-8", "iso-8859-8-e", "iso-8859-8-i"], "\nISO 2022 based 8-bit encoding for Hebrew (MIME:ISO-8859-8).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-8\n"],
  "iso-latin-5": ["9", ["iso-latin-5", "iso-8859-9", "latin-5"], "\nISO 2022 based 8-bit encoding for Latin-5 (MIME:ISO-8859-9).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-9\n"],
  "iso-latin-6": ["9", ["iso-latin-6", "iso-8859-10", "latin-6"], "\nISO 2022 based 8-bit encoding for Latin-6 (MIME:ISO-8859-10).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-10\n"],
  "thai-tis620": ["T", ["thai-tis620", "th-tis620", "tis620", "tis-620"], "\n8-bit encoding for ASCII (MSB=0) and Thai TIS620 (MSB=1).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  tis620-2533\n"],
  "iso-8859-11": ["*", ["iso-8859-11"], "\nISO/IEC 8859/11 (Latin/Thai)\nThis is the same as ‘thai-tis620’ with the addition of no-break-space.\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-11\n"],
  "iso-latin-7": ["9", ["iso-latin-7", "iso-8859-13", "latin-7"], "\nISO 2022 based 8-bit encoding for Latin-7 (MIME:ISO-8859-13).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-13\n"],
  "iso-latin-8": ["W", ["iso-latin-8", "iso-8859-14", "latin-8"], "\nISO 2022 based 8-bit encoding for Latin-8 (MIME:ISO-8859-14).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-14\n"],
  "iso-latin-9": ["0", ["iso-latin-9", "iso-8859-15", "latin-9", "latin-0"], "\nISO 2022 based 8-bit encoding for Latin-9 (MIME:ISO-8859-15).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-15\n"],
  "iso-latin-10": ["*", ["iso-latin-10", "iso-8859-16", "latin-10"], "\nISO 2022 based 8-bit encoding for Latin-10.\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  iso-8859-16\n"],
  "windows-1250": ["*", ["windows-1250", "cp1250"], "\nwindows-1250 (Central European) encoding (MIME: WINDOWS-1250)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1250\n"],
  "windows-1251": ["b", ["windows-1251", "cp1251"], "\nwindows-1251 8-bit encoding for Cyrillic (MIME: WINDOWS-1251)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1251\n"],
  "windows-1252": ["*", ["windows-1252", "cp1252"], "\nwindows-1252 (Western European) encoding (MIME: WINDOWS-1252)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1252\n"],
  "windows-1253": ["g", ["windows-1253", "cp1253"], "\nwindows-1253 encoding for Greek\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1253\n"],
  "windows-1254": ["*", ["windows-1254", "cp1254"], "\nwindows-1254 (Turkish) encoding (MIME: WINDOWS-1254)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1254\n"],
  "windows-1255": ["h", ["windows-1255", "cp1255"], "\nwindows-1255 (Hebrew) encoding (MIME: WINDOWS-1255)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1255\n"],
  "windows-1256": ["A", ["windows-1256", "cp1256"], "\nwindows-1256 (Arabic) encoding (MIME: WINDOWS-1256)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1256\n"],
  "windows-1257": ["*", ["windows-1257", "cp1257"], "\nwindows-1257 (Baltic) encoding (MIME: WINDOWS-1257)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1257\n"],
  "windows-1258": ["*", ["windows-1258", "cp1258"], "\nwindows-1258 encoding for Vietnamese (MIME: WINDOWS-1258)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  windows-1258\n"],
  "cp874": ["D", ["cp874", "ibm874"], "\nDOS codepage 874 (Thai)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  cp874\n"],
  "cp866": ["*", ["cp866"], "\nCP866 encoding for Cyrillic.\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ibm866\n"],
  "cyrillic-koi8": ["R", ["cyrillic-koi8", "koi8-r", "koi8", "cp878"], "\nKOI8 8-bit encoding for Cyrillic (MIME: KOI8-R).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  koi8\n"],
  "koi8-u": ["У", ["koi8-u"], "\nKOI8-U 8-bit encoding for Cyrillic (MIME: KOI8-U)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  koi8-u\n"],
  "mac-roman": ["M", ["mac-roman", "macintosh"], "\nMac Roman Encoding (MIME:MACINTOSH).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  mac-roman\n"],
  "japanese-shift-jis": ["S", ["japanese-shift-jis", "shift_jis", "sjis"], "\nShift-JIS 8-bit encoding for Japanese (MIME:SHIFT_JIS)\nType: shift-jis (Shift-JIS, MS-KANJI)\n", "This coding system encodes the following charsets:\n  ascii katakana-jisx0201 japanese-jisx0208\n"],
  "japanese-cp932": ["S", ["japanese-cp932", "cp932"], "\nCP932 (Microsoft shift-jis)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii katakana-sjis cp932-2-byte\n"],
  "japanese-iso-8bit": ["E", ["japanese-iso-8bit", "euc-japan-1990", "euc-japan", "euc-jp"], "\nISO 2022 based EUC encoding for Japanese (MIME:EUC-JP).\nType: iso-2022 (variant of ISO-2022)\nInitial designations:\n  G0 -- ascii:ASCII (ISO646 IRV)\n  G1 -- japanese-jisx0208:JISX0208.1983/1990 Japanese Kanji: ISO-IR-87\n  G2 -- katakana-jisx0201:Katakana Part of JISX0201.1976\n  G3 -- japanese-jisx0212:JISX0212 Japanese supplement: ISO-IR-159\nOther specifications: \n  short ascii-at-eol ascii-at-cntl single-shift\n\n", "This coding system encodes the following charsets:\n  ascii latin-jisx0201 japanese-jisx0208 katakana-jisx0201 japanese-jisx0212 japanese-jisx0208-1978\n"],
  "iso-2022-jp": ["J", ["iso-2022-jp", "junet"], "\nISO 2022 based 7bit encoding for Japanese (MIME:ISO-2022-JP).\nType: iso-2022 (variant of ISO-2022)\nInitial designations:\n  G0 -- ascii:ASCII (ISO646 IRV), and also used by the following:\n\tjapanese-jisx0208-1978:JISX0208.1978 Japanese Kanji (so called \"old JIS\"): ISO-IR-42\n\tjapanese-jisx0208:JISX0208.1983/1990 Japanese Kanji: ISO-IR-87\n\tlatin-jisx0201:Roman Part of JISX0201.1976\n  G1 -- never used\n  G2 -- never used\n  G3 -- never used\nOther specifications: \n  short ascii-at-eol ascii-at-cntl 7-bit designation\n\n", "This coding system encodes the following charsets:\n  ascii japanese-jisx0208 japanese-jisx0208-1978 latin-jisx0201\n"],
  "iso-2022-7bit": ["J", ["iso-2022-7bit"], "\nISO 2022 based 7-bit encoding using only G0.\nType: iso-2022 (variant of ISO-2022)\nInitial designations:\n  G0 -- ascii:ASCII (ISO646 IRV), and also used by the following:\n\tany other charsets\n  G1 -- never used\n  G2 -- never used\n  G3 -- never used\nOther specifications: \n  short ascii-at-eol ascii-at-cntl 7-bit designation composition\n\n", "This coding system can encode all ISO 2022 charsets.\n"],
  "chinese-iso-8bit": ["c", ["chinese-iso-8bit", "cn-gb-2312", "euc-china", "euc-cn", "cn-gb", "gb2312"], "\nISO 2022 based EUC encoding for Chinese GB2312 (MIME:GB2312).\nType: iso-2022 (variant of ISO-2022)\nInitial designations:\n  G0 -- ascii:ASCII (ISO646 IRV)\n  G1 -- chinese-gb2312:GB2312 Chinese simplified: ISO-IR-58\n  G2 -- never used\n  G3 -- never used\n\n", "This coding system encodes the following charsets:\n  ascii chinese-gb2312\n"],
  "chinese-gbk": ["c", ["chinese-gbk", "gbk", "cp936", "windows-936"], "\nGBK encoding for Chinese (MIME:GBK).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii chinese-gbk\n"],
  "chinese-gb18030": ["c", ["chinese-gb18030", "gb18030"], "\nGB18030 encoding for Chinese (MIME:GB18030).\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii gb18030-2-byte gb18030-4-byte-bmp gb18030-4-byte-smp gb18030-4-byte-ext-1 gb18030-4-byte-ext-2\n"],
  "chinese-big5": ["B", ["chinese-big5", "big5", "cn-big5", "cp950"], "\nBIG5 8-bit encoding for Chinese (MIME:Big5)\nType: big5\n", "This coding system encodes the following charsets:\n  ascii big5\n"],
  "chinese-big5-hkscs": ["B", ["chinese-big5-hkscs", "big5-hkscs", "cn-big5-hkscs"], "\nBIG5-HKSCS 8-bit encoding for Chinese, Hong Kong supplement (MIME:Big5-HKSCS)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii big5-hkscs\n"],
  "korean-iso-8bit": ["K", ["korean-iso-8bit", "euc-kr", "euc-korea", "ks_c_5601-1987"], "\nISO 2022 based EUC encoding for Korean KSC5601 (MIME:EUC-KR).\nType: iso-2022 (variant of ISO-2022)\nInitial designations:\n  G0 -- ascii:ASCII (ISO646 IRV)\n  G1 -- korean-ksc5601:KSC5601 Korean Hangul and Hanja: ISO-IR-149\n  G2 -- never used\n  G3 -- never used\n\n", "This coding system encodes the following charsets:\n  ascii korean-ksc5601\n"],
  "korean-cp949": ["K", ["korean-cp949", "cp949"], "\nCP949 (Microsoft Unified Hangul Code)\nType: charset (charset)\n", "This coding system encodes the following charsets:\n  ascii cp949\n"],
  "raw-text": ["t", ["raw-text"], "\nRaw text, which means text contains random 8-bit codes.\nEncoding text with this coding system produces the actual byte\nsequence of the text in buffers and strings.  An exception is made for\ncharacters from the ‘eight-bit’ character set.  Each of them is encoded\ninto a single byte.\n\nWhen you visit a file with this coding, the file is read into a\nunibyte buffer as is (except for EOL format), thus each byte of a file\nis treated as a character.\nType: raw-text (text with random binary characters)\n", ""],
  "no-conversion": ["=", ["no-conversion", "binary"], "\nDo no conversion.\n\nWhen you visit a file with this coding, the file is read into a\nunibyte buffer as is, thus each byte of a file is treated as a\ncharacter.\nType: raw-text (text with random binary characters)\n", ""],
  "no-conversion-multibyte": ["=", ["no-conversion-multibyte"], "\nLike ‘no-conversion’ but don’t read a file into a unibyte buffer.\nType: raw-text (text with random binary characters)\n", ""],
};
