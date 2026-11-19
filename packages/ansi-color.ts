// ANSI colours in program output, after Emacs's ansi-color.el: the SGR
// sequences a program writes to colour its output, ESC [ ... m, become
// faces on the text, and other control sequences are removed, in strings
// (ansi-color-apply) and in a buffer's text (ansi-color-apply-on-region),
// as comint, shell and compilation buffers use them.

const truthy = (v: e8.Value | undefined) => v !== null && v !== undefined && v !== false;

/** Emacs's ansi-color faces: the attributes, then the doc. */
const FACES: [string, e8.FaceAttributes, string][] = [
  ["ansi-color-bold", { inherit: "bold" }, "Face used to render bold text."],
  ["ansi-color-faint", { weight: "light" }, "Face used to render faint text."],
  ["ansi-color-italic", { inherit: "italic" }, "Face used to render italic text."],
  ["ansi-color-underline", { inherit: "underline" }, "Face used to render underlined text."],
  ["ansi-color-slow-blink", { box: { lineWidth: -1 } }, "Face used to render slowly blinking text."],
  ["ansi-color-fast-blink", { box: { lineWidth: -1 } }, "Face used to render rapidly blinking text."],
  ["ansi-color-inverse", { inverseVideo: true }, "Face used to render inverted video text."],
];

/** The eight colours and their bright forms, as Emacs's faces name them. */
const COLOURS: [string, string, string][] = [
  ["black", "black", "gray30"],
  ["red", "red3", "red2"],
  ["green", "green3", "green2"],
  ["yellow", "yellow3", "yellow2"],
  ["blue", "blue2", "blue1"],
  ["magenta", "magenta3", "magenta2"],
  ["cyan", "cyan3", "cyan2"],
  ["white", "grey90", "white"],
];

for (const [name, attributes, doc] of FACES) e8.defineFace({ name, doc, attributes });
for (const [name, normal, bright] of COLOURS) {
  e8.defineFace({ name: `ansi-color-${name}`, doc: `Face used to render ${name} color code.`, attributes: { foreground: normal, background: normal } });
  e8.defineFace({ name: `ansi-color-bright-${name}`, doc: `Face used to render bright ${name} color code.`, attributes: { foreground: bright, background: bright } });
}

for (const [name, doc, value, local] of [
  ["ansi-color-for-comint-mode", "What comint does with SGR control sequences in output: t translates them into faces, filter removes them, nil leaves them.", true, false],
  ["ansi-color-for-compilation-mode", "What ansi-color-compilation-filter does with compilation output: t translates SGR control sequences into faces, filter removes them, nil leaves them.", true, false],
  ["ansi-color-bold-is-bright", "Whether bold with a colour gives the colour's bright form.", false, false],
  ["ansi-color-apply-face-function", "The function ansi-color-apply-on-region puts a face on text with: given the start, the end and the face, or nil for none.", "ansi-color-apply-overlay-face", false],
  [
    "ansi-color-basic-faces-vector",
    "The faces for SGR parameters 0 to 7: default, bold, faint, italic, underlined, slowly blinking, rapidly blinking and negative image.",
    [null, ...FACES.map(([n]) => n)],
    false,
  ],
  ["ansi-color-normal-colors-vector", "The faces whose colours SGR parameters 30 to 37 and 40 to 47 set.", COLOURS.map(([n]) => `ansi-color-${n}`), false],
  ["ansi-color-bright-colors-vector", "The faces whose colours SGR parameters 90 to 97 and 100 to 107 set.", COLOURS.map(([n]) => `ansi-color-bright-${n}`), false],
  [
    "ansi-color-context",
    "What the last ansi-color-apply ended with: (FACE-VEC FRAGMENT), FACE-VEC the bold, faint and other basic faces in force and the foreground and background colour codes, FRAGMENT the start of an escape sequence not yet ended. Set it to nil to start afresh.",
    null,
    true,
  ],
  [
    "ansi-color-context-region",
    "What the last ansi-color-apply-on-region ended with: (FACE-VEC MARKER), FACE-VEC as in ansi-color-context, MARKER where to start next time, as within an escape sequence not yet ended. Set it to nil to start afresh.",
    null,
    true,
  ],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value, local });
}

/** The basic faces in force and the foreground and background colour codes, as Emacs's FACE-VEC. */
type FaceVec = [boolean[], number | null, number | null];

/** ECMA-48's control sequences, and the start of one cut off at the end. */
const CONTROL_SEQ = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const FRAGMENT_AT_END = /(?:\x1b\[[\x30-\x3f]*[\x20-\x2f]*|\x1b)$/;
const PARAMETER = /([0-9]*)[m;]/g;

const newFaceVec = (): FaceVec => [Array<boolean>(8).fill(false), null, null];

/** A context's FACE-VEC, from a variable's value, sound or not. */
function faceVecOf(v: e8.Value | undefined): FaceVec {
  if (!Array.isArray(v) || !Array.isArray(v[0])) return newFaceVec();
  const basic = Array.from({ length: 8 }, (_, i) => truthy((v[0] as e8.Value[])[i]));
  const code = (x: e8.Value | undefined) => (typeof x === "number" ? x : null);
  return [basic, code(v[1]), code(v[2])];
}

/**
 * Applies the codes the iterator gives to a FACE-VEC, as
 * ansi-color--update-face-vec: 1 to 7 set a basic face, 21 to 27 unset
 * them, 30 to 37 and 90 to 97 set the foreground, 40 to 47 and 100 to 107
 * the background, 39 and 49 unset them, 38 and 48 take a 256-colour or RGB
 * colour from the codes after them, and anything else clears it all.
 */
function updateFaceVec(faceVec: FaceVec, next: () => number | undefined): void {
  const basic = faceVec[0];
  let code: number | undefined;
  while ((code = next()) !== undefined) {
    const q = Math.floor(code / 10);
    let clear = false;
    if (q === 0) {
      if (code === 0 || code === 8 || code === 9) clear = true;
      else basic[code] = true;
    } else if (q === 2) {
      if ([20, 26, 28, 29].includes(code)) clear = true;
      else {
        basic[code - 20] = false;
        basic[code === 22 ? 1 : code === 25 ? 6 : 0] = false;
      }
    } else if (q === 3 || q === 4 || q === 9 || q === 10) {
      const r = code % 10;
      const cell = q === 3 || q === 9 ? 1 : 2;
      if (r === 8) {
        const mode = next();
        if (mode === 5) {
          const c = next();
          faceVec[cell] = c ?? null;
          clear = c === undefined || c >= 256;
        } else if (mode === 2) {
          const red = next();
          const green = next();
          const blue = next();
          const rgb = red !== undefined && green !== undefined && blue !== undefined ? red * 0x10000 + green * 0x100 + blue : undefined;
          if (rgb !== undefined && rgb <= 0xffffff) faceVec[cell] = 256 + rgb;
          else clear = true;
        } else clear = true;
      } else if (r === 9) faceVec[cell] = null;
      else faceVec[cell] = (q === 3 || q === 4 ? 0 : 8) + r;
    } else clear = true;
    if (clear) {
      basic.fill(false);
      faceVec[1] = null;
      faceVec[2] = null;
    }
  }
}

const hex6 = (n: number) => `#${n.toString(16).toUpperCase().padStart(6, "0")}`;

/**
 * A colour code as #RRGGBB, as ansi-color--code-as-hex: 16 to 255 from the
 * xterm palette's cube and greys, 256 and over a 24-bit colour; undefined
 * for the sixteen named colours.
 */
function codeAsHex(color: number): string | undefined {
  if (color < 16) return undefined;
  if (color >= 256) return hex6(color - 256);
  if (color >= 232) return hex6(0x010101 * (8 + 10 * (color - 232)));
  const c = color - 16;
  let res = 0;
  for (let frac = 36; frac >= 1; frac = Math.floor(frac / 6)) {
    res *= 0x100;
    const n = Math.floor(c / frac) % 6;
    if (n !== 0) res += 0x37 + 0x28 * n;
  }
  return hex6(res);
}

/** A face's colour, or the default face's where it sets none, as face-foreground with INHERIT 'default. */
function faceColour(face: string, attribute: ":foreground" | ":background"): e8.Value {
  const own = e8.faceAttribute(face, attribute, true);
  return typeof own === "string" && own !== "unspecified" ? own : e8.faceAttribute("default", attribute);
}

/** A vector of faces from a variable, nil as undefined. */
const listVar = (name: string): (string | undefined)[] => ((e8.variable(name) ?? []) as e8.Value[]).map((f) => (typeof f === "string" ? f : undefined));

/**
 * The face for a FACE-VEC, as ansi-color--face-vec-face: the basic faces in
 * order, then the background and the foreground as attribute lists, one
 * face alone, or undefined for none.
 */
function faceVecFace(faceVec: FaceVec): e8.Value | undefined {
  const [basic, fg, bg] = faceVec;
  const bright = truthy(e8.variable("ansi-color-bold-is-bright")) && basic[1];
  const faces: e8.Value[] = [];
  const colour = (code: number, attribute: ":foreground" | ":background") => {
    const vectorName = bright || code >= 8 ? "ansi-color-bright-colors-vector" : "ansi-color-normal-colors-vector";
    return codeAsHex(code) ?? faceColour(listVar(vectorName)[code % 8]!, attribute);
  };
  const basicFaces = listVar("ansi-color-basic-faces-vector");
  for (let i = 0; i < 8; i++) if (basic[i] && basicFaces[i]) faces.push(basicFaces[i]!);
  if (bg !== null) faces.push([":background", colour(bg, ":background")]);
  if (fg !== null) faces.push([":foreground", colour(fg, ":foreground")]);
  return faces.length === 0 ? undefined : faces.length === 1 ? faces[0] : faces;
}

/** The parameters of an SGR sequence, from its start, as ansi-color-parameter-regexp finds them. */
function parameters(text: string, from: number, to: number): () => number | undefined {
  PARAMETER.lastIndex = from;
  return () => {
    const m = PARAMETER.exec(text);
    if (m === null || PARAMETER.lastIndex > to) {
      PARAMETER.lastIndex = text.length + 1;
      return undefined;
    }
    return Number(m[1]) || 0;
  };
}

/** The current buffer's string context, made if it has none, as ansi-color--ensure-context. */
function stringContext(): [FaceVec, string] {
  const v = e8.variable("ansi-color-context");
  return Array.isArray(v) ? [faceVecOf(v[0]), typeof v[1] === "string" ? v[1] : ""] : [newFaceVec(), ""];
}

/** Code points to UTF-16 offsets in a string and back, as strings' properties count characters. */
const chars = (s: string, offset: number) => [...s.slice(0, offset)].length;

/**
 * Removes the control sequences from a string, keeping the start of one
 * cut off at its end in ansi-color-context for the next string, as
 * ansi-color-filter-apply.
 */
export function filterApply(stringIn: string): string {
  const [faceVec, fragment] = stringContext();
  const string = fragment + stringIn;
  CONTROL_SEQ.lastIndex = 0;
  let result = string.replace(CONTROL_SEQ, "");
  const cut = FRAGMENT_AT_END.exec(result);
  let rest = "";
  if (cut !== null) {
    rest = cut[0];
    result = result.slice(0, cut.index);
  }
  e8.setVariable("ansi-color-context", [faceVec, rest] as e8.Value);
  return result;
}

/**
 * A string with its SGR sequences made into `font-lock-face' properties and
 * other control sequences removed, as ansi-color-apply. The faces in force
 * and the start of a sequence cut off at the end carry on, in
 * ansi-color-context, to the next string.
 */
export function apply(stringIn: string): string | e8.PropertizedString {
  const [faceVec, fragment] = stringContext();
  const string = fragment + stringIn;
  const pieces: string[] = [];
  const runs: [number, number, { [name: string]: e8.Value }][] = [];
  let length = 0;
  const add = (text: string) => {
    const face = faceVecFace(faceVec);
    const n = [...text].length;
    if (face !== undefined && n > 0) runs.push([length, length + n, { "font-lock-face": face }]);
    pieces.push(text);
    length += n;
  };
  let start = 0;
  CONTROL_SEQ.lastIndex = 0;
  for (let m = CONTROL_SEQ.exec(string); m !== null; m = CONTROL_SEQ.exec(string)) {
    const escEnd = m.index + m[0].length;
    add(string.slice(start, m.index));
    start = escEnd;
    if (m[0].endsWith("m")) {
      const saved = CONTROL_SEQ.lastIndex;
      updateFaceVec(faceVec, parameters(string, m.index, escEnd));
      CONTROL_SEQ.lastIndex = saved;
    }
  }
  let rest = string.slice(start);
  const cut = FRAGMENT_AT_END.exec(rest);
  let next = "";
  if (cut !== null) {
    next = cut[0];
    rest = rest.slice(0, cut.index);
  }
  add(rest);
  e8.setVariable("ansi-color-context", [faceVec, next] as e8.Value);
  const text = pieces.join("");
  return runs.length === 0 ? text : new e8.PropertizedString(text, runs);
}

/**
 * The current buffer's region context, made if it has none, its marker
 * put at `position` if it points nowhere, as ansi-color--ensure-context.
 */
function regionContext(position: number): [FaceVec, e8.Marker] {
  const v = e8.variable("ansi-color-context-region");
  let marker = Array.isArray(v) && v[1] instanceof e8.Marker ? v[1] : undefined;
  if (marker === undefined || e8.markerBuffer(marker) !== e8.bufferName()) marker = e8.makeMarker(position);
  else if (e8.markerPosition(marker) === undefined) e8.setMarker(marker, position);
  return [Array.isArray(v) ? faceVecOf(v[0]) : newFaceVec(), marker];
}

const applyFace = (beg: number, end: number, face: e8.Value | undefined) => {
  e8.funcall(String(e8.variable("ansi-color-apply-face-function") ?? "ansi-color-apply-overlay-face"), beg, end, face ?? null);
};

/** Where the start of a control sequence cut off at `end` begins, searching from `from`, as the fragment regexp's last match. */
function fragmentBefore(from: number, end: number): { start: number; end: number } | undefined {
  const text = e8.bufferText(from, end);
  const m = FRAGMENT_AT_END.exec(text);
  if (m === null) return undefined;
  return { start: from + chars(text, m.index), end };
}

/**
 * Makes the SGR sequences from begin to end into faces, through
 * ansi-color-apply-face-function, and deletes them and the other control
 * sequences, or with preserveSequences hides them, as
 * ansi-color-apply-on-region. The faces in force carry on, in
 * ansi-color-context-region, to the next region, which starts where this
 * one stopped, as within a sequence cut off at its end.
 */
export function applyOnRegion(begin: number, end: number, preserveSequences = false): void {
  const [faceVec, startMarker] = regionContext(begin);
  const endMarker = e8.makeMarker(end);
  e8.saveExcursion(() => {
    let point = e8.markerPosition(startMarker)!;
    for (;;) {
      const limit = e8.markerPosition(endMarker)!;
      const text = e8.bufferText(point, limit);
      CONTROL_SEQ.lastIndex = 0;
      const m = CONTROL_SEQ.exec(text);
      if (m === null) break;
      const escBeg = point + chars(text, m.index);
      const escEnd = escBeg + [...m[0]].length;
      const from = e8.markerPosition(startMarker)!;
      e8.setMarker(startMarker, escEnd);
      applyFace(from, escBeg, faceVecFace(faceVec));
      if (m[0].endsWith("m")) updateFaceVec(faceVec, parameters(m[0], 0, m[0].length));
      if (preserveSequences) {
        e8.overlayPut(e8.makeOverlay(escBeg, escEnd), "invisible", true);
        point = escEnd;
      } else {
        e8.deleteRegion(escBeg, escEnd);
        point = escBeg;
      }
    }
    const endPos = e8.markerPosition(endMarker)!;
    const fragment = fragmentBefore(point, endPos);
    // Emacs's last search leaves point after the last fragment; only one at the end counts.
    const after = fragment?.end ?? point;
    if (fragment !== undefined && after !== e8.markerPosition(startMarker) && after === endPos) {
      applyFace(e8.markerPosition(startMarker)!, fragment.start, faceVecFace(faceVec));
      e8.setMarker(startMarker, fragment.start);
    } else {
      const face = faceVecFace(faceVec);
      applyFace(e8.markerPosition(startMarker)!, endPos, face);
      // Kept only while codes are in force, so text before it later is not coloured.
      e8.setMarker(startMarker, face === undefined ? null : endPos);
    }
  });
  e8.deleteMarker(endMarker);
  e8.setVariable("ansi-color-context-region", [faceVec, startMarker] as e8.Value);
}

/**
 * Deletes the control sequences from begin to end, stopping before the
 * start of one cut off at the end, which the next call starts from, as
 * ansi-color-filter-region.
 */
export function filterRegion(begin: number, end: number): void {
  const [faceVec, start] = regionContext(begin);
  const endMarker = e8.makeMarker(end);
  e8.saveExcursion(() => {
    let point = e8.markerPosition(start)!;
    for (;;) {
      const text = e8.bufferText(point, e8.markerPosition(endMarker)!);
      CONTROL_SEQ.lastIndex = 0;
      const m = CONTROL_SEQ.exec(text);
      if (m === null) break;
      const at = point + chars(text, m.index);
      e8.deleteRegion(at, at + [...m[0]].length);
      point = at;
    }
    e8.setMarker(start, point);
    const endPos = e8.markerPosition(endMarker)!;
    const fragment = fragmentBefore(point, endPos);
    if (fragment !== undefined && fragment.end !== point && fragment.end === endPos) e8.setMarker(start, fragment.start);
    else e8.setMarker(start, null);
  });
  e8.deleteMarker(endMarker);
  e8.setVariable("ansi-color-context-region", [faceVec, start] as e8.Value);
}

/** Keeps an overlay from growing over text inserted at its end, as ansi-color-freeze-overlay. */
const freezeOverlay = e8.defun("ansi-color-freeze-overlay", (overlay: number, isAfter: e8.Value, begin: number, end: number, len?: number) => {
  if (truthy(isAfter) && len === 0 && end === e8.overlayEnd(overlay)) e8.moveOverlay(overlay, e8.overlayStart(overlay)!, begin);
});

/** An overlay from `from` to `to` that goes with its text and does not grow, as ansi-color-make-extent. */
export function makeExtent(from: number, to: number): number {
  return e8.makeOverlay(from, to, { evaporate: true, "modification-hooks": [freezeOverlay], "insert-behind-hooks": [freezeOverlay] });
}

e8.defun("ansi-color-make-extent", (from: number, to: number) => makeExtent(from, to));
e8.defun("ansi-color-apply-overlay-face", (beg: number, end: number, face: e8.Value) => {
  // An empty overlay that evaporates goes at once, as in Emacs.
  if (truthy(face) && beg < end) e8.overlayPut(makeExtent(beg, end), "face", face);
});
e8.defun("ansi-color-apply-text-property-face", (beg: number, end: number, face: e8.Value) => {
  if (truthy(face)) e8.putTextProperty(beg, end, "font-lock-face", face);
});
e8.defun("ansi-color-apply", (string: string) => apply(string));
e8.defun("ansi-color-filter-apply", (string: string) => filterApply(string));
e8.defun("ansi-color-apply-on-region", (begin: number, end: number, preserve?: e8.Value) => applyOnRegion(begin, end, truthy(preserve)));
e8.defun("ansi-color-filter-region", (begin: number, end: number) => filterRegion(begin, end));

/**
 * Colours comint's last output, from comint-last-output-start to the
 * process mark, or only removes its sequences, as ansi-color-for-comint-mode
 * says, as ansi-color-process-output does on comint-output-filter-functions.
 */
export const processOutput = (_ignored?: e8.Value): void => {
  const process = e8.getBufferProcess(e8.bufferName());
  if (process === undefined) return;
  const mode = e8.variable("ansi-color-for-comint-mode");
  if (!truthy(mode)) return;
  const startVar = e8.variable("comint-last-output-start");
  const start = startVar instanceof e8.Marker && e8.markerBuffer(startVar) === e8.bufferName() ? e8.markerPosition(startVar) : undefined;
  const end = e8.markerPosition(e8.processMark(process)!)!;
  if (mode === "filter") filterRegion(start ?? e8.pointMin(), end);
  else applyOnRegion(start ?? e8.pointMin(), end);
};
e8.defun("ansi-color-process-output", processOutput);

/**
 * Colours what compilation output was just inserted, from
 * compilation-filter-start to point, or only removes its sequences, as
 * ansi-color-for-compilation-mode says; for compilation-filter-hook.
 */
e8.defun("ansi-color-compilation-filter", () => {
  const mode = e8.variable("ansi-color-for-compilation-mode");
  if (!truthy(mode)) return;
  const start = Number(e8.variable("compilation-filter-start") ?? e8.point());
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (mode === "filter") filterRegion(start, e8.point());
    else applyOnRegion(start, e8.point());
  });
});

for (const [name, value, doc] of [
  ["ansi-color-for-comint-mode-on", true, "Set `ansi-color-for-comint-mode' to t."],
  ["ansi-color-for-comint-mode-off", null, "Set `ansi-color-for-comint-mode' to nil."],
  ["ansi-color-for-comint-mode-filter", "filter", "Set `ansi-color-for-comint-mode' to symbol `filter'."],
] as const) {
  e8.defineCommand({ name, doc, run: () => e8.setDefault("ansi-color-for-comint-mode", value) });
}
