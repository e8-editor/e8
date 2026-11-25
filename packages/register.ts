// Registers, after Emacs's register.el: places, text, numbers, rectangles
// and window configurations kept under a character, on C-x r.

import { keyChar } from "simple";
import { insertRectangle, lastKilledRectangle } from "rect";

/** What a register holds. */
export type RegisterValue =
  | { kind: "position"; marker: e8.Marker }
  | { kind: "text"; text: string | e8.PropertizedString }
  | { kind: "number"; value: number }
  | { kind: "rectangle"; lines: string[] }
  | { kind: "window"; configuration: e8.WindowConfiguration; marker: e8.Marker };

/** The registers, by name, as register-alist. */
const registers = new Map<string, RegisterValue>();

/** Stores a value in a register, freeing the marker of what it held, as nothing else keeps it. */
function setRegister(r: string, value: RegisterValue): void {
  const old = registers.get(r);
  if (old?.kind === "position" || old?.kind === "window") e8.deleteMarker(old.marker);
  // A window configuration keeps markers of its own for each window.
  if (old?.kind === "window") e8.freeWindowConfiguration(old.configuration);
  registers.set(r, value);
}

/** The registers and what each holds, as register-alist, for packages such as consult to list. */
export function registerAlist(): [string, RegisterValue][] {
  return [...registers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reads a register's name, a character typed after the prompt, as register-read-with-preview does traditionally. */
async function readRegister(prompt: string): Promise<string> {
  const key = await e8.readKey(prompt);
  const c = keyChar(key);
  if (c === undefined) throw new Error("Non-character input-event");
  return c!;
}

/** A register's name as single-key-description writes it. */
const describe = (r: string): string => (r === " " ? "SPC" : r);

e8.defineCommand({
  name: "point-to-register",
  doc: "Store point's position in a register, to go back to with C-x r j.",
  run: async () => {
    const r = await readRegister("Point to register: ");
    setRegister(r, { kind: "position", marker: e8.makeMarker(e8.point()) });
  },
});

e8.defineCommand({
  name: "window-configuration-to-register",
  doc: "Store the frame's windows and what they show in a register, to restore with C-x r j.",
  run: async () => {
    const r = await readRegister("Window configuration to register: ");
    setRegister(r, { kind: "window", configuration: e8.currentWindowConfiguration(), marker: e8.makeMarker(e8.point()) });
  },
});

e8.defineCommand({
  name: "jump-to-register",
  doc: "Go to the position or restore the window configuration stored in a register.",
  run: async () => {
    const r = await readRegister("Jump to register: ");
    const val = registers.get(r);
    if (val?.kind === "position") {
      const buffer = e8.markerBuffer(val.marker);
      if (buffer === undefined) e8.userError("That register’s buffer no longer exists");
      e8.call("switch-to-buffer", buffer!);
      const pos = e8.markerPosition(val.marker)!;
      if (e8.point() !== pos && e8.lastCommand() !== "jump-to-register") e8.pushMark(e8.point());
      e8.gotoChar(pos);
    } else if (val?.kind === "window") {
      e8.setWindowConfiguration(val.configuration);
      const pos = e8.markerPosition(val.marker);
      if (pos !== undefined) e8.gotoChar(pos);
    } else {
      e8.userError("Register doesn’t contain a buffer position or configuration");
    }
  },
});

/** The region's text into a register, deleted with `del`, joined onto what it holds with `join`. */
function textToRegister(r: string, start: number, end: number, del: boolean, join?: "append" | "prepend"): void {
  const text = e8.bufferSubstring(start, end);
  const old = registers.get(r);
  if (join === undefined || old === undefined) {
    setRegister(r, { kind: "text", text });
  } else if (old.kind === "text") {
    const [a, b] = join === "append" ? [String(old.text), String(text)] : [String(text), String(old.text)];
    setRegister(r, { kind: "text", text: a + b });
  } else {
    e8.userError("Register does not contain text");
  }
  if (del) e8.deleteRegion(start, end);
  e8.deactivateMark();
}

const region = [
  { name: "start", kind: "region-beginning" },
  { name: "end", kind: "region-end" },
  { name: "del", kind: "prefix" },
] as const;

for (const [name, doc, prompt, join] of [
  ["copy-to-register", "Copy the region's text into a register, to insert with C-x r i; with a prefix argument, delete it too.", "Copy to register: ", undefined],
  ["append-to-register", "Add the region's text to the end of the text in a register; with a prefix argument, delete it too.", "Append to register: ", "append"],
  ["prepend-to-register", "Add the region's text to the start of the text in a register; with a prefix argument, delete it too.", "Prepend to register: ", "prepend"],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [...region],
    run: async (start: number, end: number, del: e8.PrefixArg) => {
      const r = await readRegister(prompt);
      textToRegister(r, start, end, del !== null, join);
    },
  });
}

e8.defineCommand({
  name: "copy-rectangle-to-register",
  doc: "Copy the rectangle between point and the mark into a register, to insert with C-x r i; with a prefix argument, delete it too.",
  params: [...region],
  run: async (start: number, end: number, del: e8.PrefixArg) => {
    const r = await readRegister("Copy rectangle to register: ");
    e8.saveExcursion(() => {
      e8.call(del !== null ? "kill-rectangle" : "copy-rectangle-as-kill", start, end);
    });
    setRegister(r, { kind: "rectangle", lines: lastKilledRectangle() ?? [] });
    e8.deactivateMark();
  },
});

e8.defineCommand({
  name: "number-to-register",
  doc: "Store a number in a register: the prefix argument, or else the number after point, which point moves past.",
  params: [{ name: "number", kind: "prefix" }],
  run: async (number: e8.PrefixArg) => {
    const r = await readRegister("Number to register: ");
    let value = 0;
    if (number !== null) {
      value = e8.prefixNumericValue(number);
    } else if (e8.lookingAt("\\s-*-?[0-9]+")) {
      value = parseInt(e8.matchString(0)!.trim(), 10);
      e8.gotoChar(e8.matchEnd(0)!);
    }
    setRegister(r, { kind: "number", value });
  },
});

e8.defineCommand({
  name: "increment-register",
  doc: "Add the prefix argument, 1 by default, to the number in a register; to one with text, or none, add the region's text.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: async (prefix: e8.PrefixArg) => {
    const r = await readRegister("Increment register: ");
    const val = registers.get(r);
    if (val?.kind === "number") {
      setRegister(r, { kind: "number", value: val.value + e8.prefixNumericValue(prefix) });
    } else if (val === undefined || val.kind === "text") {
      // The region only now, as a number needs none.
      const mark = e8.mark();
      if (mark === undefined) e8.userError("The mark is not set now, so there is no region");
      textToRegister(r, Math.min(mark!, e8.point()), Math.max(mark!, e8.point()), prefix !== null, "append");
    }
    else e8.userError("Register does not contain a number or text");
  },
});

e8.defineCommand({
  name: "insert-register",
  barfIfReadOnly: true,
  doc: "Insert what a register holds, leaving point before it and the mark after; with a prefix argument, point after it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: #<buffer ${e8.bufferName()}>`);
    const r = await readRegister("Insert register: ");
    e8.pushMark(e8.point());
    const val = registers.get(r);
    if (val?.kind === "text") e8.insertForYank(val.text);
    else if (val?.kind === "number") e8.insert(String(val.value));
    else if (val?.kind === "rectangle") insertRectangle(val.lines);
    else if (val?.kind === "position" && e8.markerPosition(val.marker) !== undefined) e8.insert(String(e8.markerPosition(val.marker)! + 1));
    else e8.userError("Register does not contain text");
    if (arg === null) e8.call("exchange-point-and-mark");
  },
});

e8.defineCommand({
  name: "view-register",
  doc: "Say what a register holds.",
  run: async () => {
    const r = await readRegister("View register: ");
    const val = registers.get(r);
    if (val === undefined) {
      e8.message(`Register ${describe(r)} is empty`);
      return;
    }
    let text = `Register ${describe(r)} contains `;
    if (val.kind === "number") text += `${val.value}`;
    else if (val.kind === "text") text += `text:\n${String(val.text)}`;
    else if (val.kind === "rectangle") text += `the rectangle:\n${val.lines.join("\n")}`;
    else if (val.kind === "window") text += "a window configuration.";
    else text += `a buffer position:\nbuffer ${e8.markerBuffer(val.marker) ?? "(killed)"}, position ${(e8.markerPosition(val.marker) ?? 0) + 1}`;
    e8.showHelp(text);
  },
});

for (const [keys, command] of [
  ["C-x r SPC", "point-to-register"],
  ["C-x r C-SPC", "point-to-register"],
  ["C-x r C-@", "point-to-register"],
  ["C-x r j", "jump-to-register"],
  ["C-x r s", "copy-to-register"],
  ["C-x r x", "copy-to-register"],
  ["C-x r i", "insert-register"],
  ["C-x r g", "insert-register"],
  ["C-x r r", "copy-rectangle-to-register"],
  ["C-x r n", "number-to-register"],
  ["C-x r +", "increment-register"],
  ["C-x r w", "window-configuration-to-register"],
] as const) {
  e8.bindKey(keys, command);
}
