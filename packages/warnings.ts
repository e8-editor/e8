// Warnings, after Emacs's warnings.el: display-warning logs a message in
// *Warnings*, and shows the buffer, unless the warning's level or type
// says not to; warn and lwarn format the message first.

import { fillRegion } from "fill";
import { readMultipleChoice } from "rmc";
import { getBufferWindow } from "subr";

e8.defineVariable({
  name: "warning-levels",
  doc:
    "The severity levels of display-warning, most severe first: each a list of the level, the text before the message, " +
    "with %s where the type goes, and a function to get the user's attention, or none.",
  value: [
    [e8.intern(":emergency"), "Emergency%s: ", e8.intern("ding")],
    [e8.intern(":error"), "Error%s: "],
    [e8.intern(":warning"), "Warning%s: "],
    [e8.intern(":debug"), "Debug%s: "],
  ],
});
e8.defineVariable({
  name: "warning-minimum-level",
  doc: "The least severe level of warning shown in a window: :emergency, :error, :warning or :debug.",
  value: e8.intern(":warning"),
});
e8.defineVariable({
  name: "warning-minimum-log-level",
  doc: "The least severe level of warning logged in *Warnings*: :emergency, :error, :warning or :debug.",
  value: e8.intern(":warning"),
});
e8.defineVariable({
  name: "warning-suppress-log-types",
  doc: "Warning types not logged at all: each a list of a type's symbols, or of its first ones, to leave out its subtypes too.",
  value: [],
});
e8.defineVariable({
  name: "warning-suppress-types",
  doc: "Warning types logged but not shown in a window: each a list of a type's symbols, or of its first ones.",
  value: [],
});
e8.defineVariable({
  name: "warning-display-at-bottom",
  doc: "Whether *Warnings* is shown at the bottom of the frame, scrolled to its last warning.",
  value: true,
});
e8.defineVariable({
  name: "warning-prefix-function",
  doc: "A function of the level and its entry in warning-levels, called in *Warnings* where the warning starts, which may insert text and gives the entry to use.",
  value: null,
});
e8.defineVariable({ name: "warning-type-format", doc: "How the warning's type is written in its level's text.", value: " (%s)" });
e8.defineVariable({ name: "warning-fill-prefix", doc: "The fill prefix to fill each warning with, or nil not to fill it.", value: null });
e8.defineVariable({ name: "warning-fill-column", doc: "The fill column warnings are filled to, with warning-fill-prefix.", value: 78 });

/** A level or type's name, from a symbol or a string. */
const nameOf = (v: e8.Value | undefined): string => (typeof v === "symbol" ? e8.symbolName(v) : typeof v === "string" ? v : e8.prin1ToString(v ?? null));

/** Old names of levels, as warning-level-aliases maps them. */
const ALIASES: Record<string, string> = {
  emergency: ":emergency",
  error: ":error",
  warning: ":warning",
  notice: ":warning",
  info: ":warning",
  critical: ":emergency",
  alarm: ":emergency",
};

function levels(): e8.Value[][] {
  const v = e8.variable("warning-levels");
  return Array.isArray(v) ? (v.filter((x) => Array.isArray(x)) as e8.Value[][]) : [];
}

/** How severe a level is, as warning-numeric-level: more for more severe, 0 for one not in warning-levels. */
export function warningNumericLevel(level: e8.Value): number {
  const all = levels();
  const i = all.findIndex((x) => nameOf(x[0]) === nameOf(level));
  return i < 0 ? 0 : all.length - i;
}
e8.defun("warning-numeric-level", (level: e8.Value) => warningNumericLevel(level));

/**
 * Whether a warning of TYPE is left out by SUPPRESS, as warning-suppress-p:
 * a symbol by a list of just it, a list of symbols by a list it starts with.
 */
export function warningSuppressP(type: e8.Value, suppress: e8.Value): boolean {
  const list = Array.isArray(suppress) ? suppress : [];
  return list.some((elt) => {
    if (!Array.isArray(type)) return Array.isArray(elt) && elt.length === 1 && nameOf(elt[0]) === nameOf(type);
    const prefix = Array.isArray(elt) ? elt : [elt];
    return prefix.every((s, i) => nameOf(s) === nameOf(type[i]));
  });
}
e8.defun("warning-suppress-p", (type: e8.Value, suppress: e8.Value) => warningSuppressP(type, suppress));

/** Asks whether to stop logging or showing warnings of TYPE, as warnings-suppress, the warning's button. */
function warningsSuppress(type: e8.Value): void {
  const name = Array.isArray(type) ? e8.prin1ToString(type) : nameOf(type);
  const [key] = readMultipleChoice(`Suppress \`${name}' warnings? `, [
    ["y", `yes, ignore \`${name}' warnings completely`],
    ["n", "no, just disable showing them"],
    ["q", "quit and do nothing"],
  ]);
  const entry = Array.isArray(type) ? type : [type];
  if (key === "y") e8.setVariable("warning-suppress-log-types", [entry, ...((e8.variable("warning-suppress-log-types") as e8.Value[]) ?? [])]);
  else if (key === "n") e8.setVariable("warning-suppress-types", [entry, ...((e8.variable("warning-suppress-types") as e8.Value[]) ?? [])]);
  else e8.message("Exiting");
}

/** The button's map: RET or a click asks whether to suppress the warning's type, which the text holds. */
const suppressMap = e8.defineKeymap("warnings-suppress-button-map");
const suppressHere = e8.defineCommand({
  name: "warnings-suppress-at-point",
  doc: "Ask whether to stop logging or showing warnings of the type of the warning at point.",
  run: () => {
    // The type, as the warning's text holds it printed.
    const printed = e8.getTextProperty(e8.point(), "warning-type");
    warningsSuppress(typeof printed === "string" ? e8.readFromString(printed)[0] : null);
  },
});
e8.defineKey(suppressMap, "RET", suppressHere);
e8.defineKey(suppressMap, "<mouse-1>", suppressHere);

/**
 * Logs a warning in BUFFER-NAME, *Warnings* by default, and shows it, as
 * display-warning does: unless its LEVEL (:warning by default) is less
 * severe than warning-minimum-log-level or its TYPE is in
 * warning-suppress-log-types; shown unless less severe than
 * warning-minimum-level or in warning-suppress-types. In batch, its text
 * goes to the echo area and standard error instead.
 */
export function displayWarning(type: e8.Value, message: string, level: e8.Value = e8.intern(":warning"), bufferName = "*Warnings*"): void {
  let lvl = level ?? e8.intern(":warning");
  const alias = ALIASES[nameOf(lvl)];
  if (alias !== undefined) {
    warn(`Warning level ‘${nameOf(lvl)}’ is obsolete; use ‘${alias}’ instead`);
    lvl = e8.intern(alias);
  }
  if (warningNumericLevel(lvl) < warningNumericLevel(e8.variable("warning-minimum-log-level") ?? null)) return;
  if (warningSuppressP(type, e8.variable("warning-suppress-log-types") ?? null)) return;
  const typename = Array.isArray(type) ? type[0] : type;
  const old = e8.getBuffer(bufferName);
  const buffer = e8.bufferName(old ?? e8.getBufferCreate(bufferName)) as string;
  let levelInfo = levels().find((x) => nameOf(x[0]) === nameOf(lvl)) ?? [lvl, "%s: "];
  const batch = e8.variable("noninteractive") === true;
  const [start, end] = e8.withCurrentBuffer(buffer, () => {
    // A new buffer is read-only, as special-mode makes it, and keeps no undo.
    if (!old) {
      e8.call("special-mode");
      e8.setVariable("buffer-read-only", true);
      e8.setVariable("buffer-undo-list", true);
    }
    e8.gotoChar(e8.pointMax());
    return e8.letBind({ "inhibit-read-only": true }, () => {
      if (e8.point() !== e8.lineStart(e8.lineOf(e8.point()))) e8.insert("\n");
      const s = e8.point();
      if (!batch && !(typeof type === "symbol" && e8.symbolName(type) === "bytecomp")) {
        e8.insert(e8.propertize("⛔", { face: "button", keymap: suppressMap, "mouse-face": "highlight", "warning-type": e8.prin1ToString(type), "help-echo": "Click to suppress this warning type" }));
        e8.insert(" ");
      }
      const prefix = e8.variable("warning-prefix-function");
      if (prefix !== null && prefix !== undefined && prefix !== false) {
        const r = e8.funcall(prefix as string, lvl, levelInfo);
        if (Array.isArray(r)) levelInfo = r;
      }
      const head = e8.format(String(levelInfo[1] ?? "%s: "), e8.format(String(e8.variable("warning-type-format") ?? " (%s)"), nameOf(typename)));
      e8.insert(`${head}${message}\n`);
      const fillPrefix = e8.variable("warning-fill-prefix");
      if (typeof fillPrefix === "string" && !message.includes("\n") && !batch) {
        e8.letBind({ "fill-prefix": fillPrefix, "fill-column": e8.variable("warning-fill-column") ?? 78 }, () => {
          fillRegion(s, e8.point());
          e8.gotoChar(e8.pointMax());
        });
      }
      return [s, e8.point()];
    });
  });
  // A level's function, such as :emergency's ding.
  const attention = levelInfo[2];
  if (attention !== undefined && attention !== null && attention !== false) {
    // ding is native here, as it is C in Emacs.
    if (nameOf(attention) === "ding" && !e8.fboundp("ding")) e8.ding();
    else e8.funcall(nameOf(attention));
  }
  if (batch) {
    // Its text, without the last newline, as batch Emacs prints it.
    const text = e8.withCurrentBuffer(buffer, () => e8.bufferSubstringNoProperties(start, end));
    e8.message(text.replace(/\n$/, ""));
    return;
  }
  if (warningNumericLevel(lvl) < warningNumericLevel(e8.variable("warning-minimum-level") ?? null)) return;
  if (warningSuppressP(type, e8.variable("warning-suppress-types") ?? null)) return;
  e8.call("display-buffer", buffer);
  // Scrolled to the last warning, as warning-display-at-bottom has it.
  if (e8.variable("warning-display-at-bottom") !== false && e8.variable("warning-display-at-bottom") !== null) {
    const window = getBufferWindow(buffer);
    if (window) e8.setWindowPoint(window, e8.withCurrentBuffer(buffer, () => e8.lineStart(Math.max(0, e8.lineOf(e8.pointMax()) - 1))));
  }
}
e8.defun("display-warning", (type: e8.Value, message: string, level?: e8.Value, bufferName?: string | null) =>
  displayWarning(type, String(message), level ?? e8.intern(":warning"), bufferName ?? "*Warnings*"),
);

/** Logs a warning of TYPE and LEVEL made with format-message, as lwarn. */
export function lwarn(type: e8.Value, level: e8.Value, format: string, ...args: e8.Value[]): void {
  displayWarning(type, e8.formatMessage(format, ...args), level);
}
e8.defun("lwarn", (type: e8.Value, level: e8.Value, format: string, ...args: e8.Value[]) => lwarn(type, level, format, ...args));

/** Logs a warning made with format-message, of type emacs and level :warning, as warn. */
export function warn(format: string, ...args: e8.Value[]): void {
  displayWarning(e8.intern("emacs"), e8.formatMessage(format, ...args));
}
e8.defun("warn", (format: string, ...args: e8.Value[]) => warn(format, ...args));
