// Themes, after Emacs's custom.el: a theme is a package named NAME-theme,
// found along load-path as e8.require finds packages, that names itself
// with e8.deftheme, gives faces their attributes with
// e8.customThemeSetFaces and says it is done with e8.provideTheme.
// M-x load-theme loads one and enables it, which gives each face the
// theme's attributes in place of its own; disable-theme gives them back.
// The theme enabled last wins where two give a face.

import { truthy } from "subr";

e8.defineVariable({
  name: "custom-enabled-themes",
  doc: "The themes enabled, the one enabled last first, whose faces win.",
  value: [],
});
e8.defineVariable({
  name: "custom-safe-themes",
  doc: 'The themes load-theme loads without asking whether to run their code: names, or t for all. "default" stands for the ones E8 ships.',
  value: ["default"],
});
e8.defineHook("enable-theme-functions", "Functions called with a theme's name after it is enabled.");
e8.defineHook("disable-theme-functions", "Functions called with a theme's name after it is disabled.");

/** What a theme gives, as its definitions in custom.el's theme-settings. */
interface Theme {
  doc: string;
  faces: [string, e8.FaceAttributes][];
  variables: [string, e8.Value][];
  provided: boolean;
}

const themes = new Map<string, Theme>();
/** Each face's own attributes before the first theme gave it some, to give back when the last goes. */
const saved = new Map<string, string>();

/** The attributes a theme's face replaces: all but the font's, which a theme leaves to the face. */
const REPLACED = [
  "foreground", "background", "distantForeground", "weight", "slant", "width", "underline", "overline", "strikeThrough", "box",
  "inverseVideo", "extend", "inherit",
] as const;

/** Names a theme, as deftheme. */
export function deftheme(name: string, doc = ""): void {
  themes.set(name, { doc, faces: [], variables: [], provided: false });
}

function theme(name: string): Theme {
  const t = themes.get(name);
  if (!t) e8.signal("error", `Undefined Custom theme ${name}`);
  return t;
}

/** Gives a theme's faces their attributes, as custom-theme-set-faces: each [face, attributes]. */
export function customThemeSetFaces(name: string, specs: [string, e8.FaceAttributes][]): void {
  const t = theme(name);
  for (const [face, attrs] of specs) {
    t.faces = t.faces.filter(([f]) => f !== face);
    t.faces.push([face, attrs]);
  }
}

/** Gives a theme's variables their values, as custom-theme-set-variables: each [variable, value]. */
export function customThemeSetVariables(name: string, specs: [string, e8.Value][]): void {
  const t = theme(name);
  for (const [variable, value] of specs) {
    t.variables = t.variables.filter(([v]) => v !== variable);
    t.variables.push([variable, value]);
  }
}

/** Says a theme is complete, as provide-theme. */
export function provideTheme(name: string): void {
  theme(name).provided = true;
}

/**
 * The documentation, faces and variables a loaded theme gives, as its
 * theme-documentation and theme-settings properties hold them in Emacs,
 * or undefined if it is not loaded: for showing a theme without enabling
 * it, as a theme chooser does.
 */
export function customThemeSettings(
  name: string,
): { doc: string; faces: [string, e8.FaceAttributes][]; variables: [string, e8.Value][] } | undefined {
  const t = themes.get(name);
  return t?.provided ? { doc: t.doc, faces: t.faces.map(([f, a]) => [f, { ...a }]), variables: [...t.variables] } : undefined;
}

/** The themes there are to load, sorted: each NAME-theme.ts along load-path, and those loaded, as custom-available-themes. */
export function customAvailableThemes(): string[] {
  const names = new Set([...themes.keys()].filter((t) => themes.get(t)!.provided));
  const dirs = e8.variable("load-path");
  for (const dir of Array.isArray(dirs) ? dirs.map((d) => e8.expandFileName(String(d))) : []) {
    if (!e8.fileDirectoryP(dir)) continue;
    for (const file of e8.directoryFiles(dir, { match: "-theme\\.ts\\'" })) names.add(file.replace(/-theme\.ts$/, ""));
  }
  return [...names].sort();
}

const enabled = (): string[] => (Array.isArray(e8.variable("custom-enabled-themes")) ? (e8.variable("custom-enabled-themes") as string[]) : []);

/** Gives each face of the enabled themes the attributes of the last one to give it, the face's own where none does, as custom-theme-recalc-face. */
function recalcFaces(faces: Iterable<string>): void {
  const order = [...enabled()].reverse();
  for (const face of faces) {
    let attrs: e8.FaceAttributes | undefined;
    for (const name of order) {
      const spec = themes.get(name)?.faces.find(([f]) => f === face);
      if (spec) attrs = spec[1];
    }
    if (attrs === undefined) {
      // No theme gives it now: its own attributes again.
      const copy = saved.get(face);
      if (copy !== undefined) {
        e8.copyFace(copy, face);
        saved.delete(face);
      }
      continue;
    }
    if (!saved.has(face)) {
      const copy = ` e8-theme-saved-${face}`;
      if (e8.facep(face)) e8.copyFace(face, copy);
      else e8.makeFace(copy);
      saved.set(face, copy);
    }
    const reset: e8.FaceAttributes = {};
    for (const key of REPLACED) (reset as Record<string, unknown>)[key] = "unspecified";
    e8.setFaceAttribute(face, { ...reset, ...attrs });
  }
}

/** Enables a theme that is loaded, as enable-theme: its faces and variables win over those of the themes enabled before. */
export function enableTheme(name: string): void {
  const t = theme(name);
  e8.setVariable("custom-enabled-themes", [name, ...enabled().filter((n) => n !== name)]);
  recalcFaces(t.faces.map(([f]) => f));
  for (const [variable, value] of t.variables) e8.setDefault(variable, value);
  e8.runHooks("enable-theme-functions", name);
}

/** Disables a theme, as disable-theme: its faces go back to what the other themes, or the faces themselves, give. */
export function disableTheme(name: string): void {
  if (!enabled().includes(name)) return;
  e8.setVariable(
    "custom-enabled-themes",
    enabled().filter((n) => n !== name),
  );
  recalcFaces((themes.get(name)?.faces ?? []).map(([f]) => f));
  e8.runHooks("disable-theme-functions", name);
}

/** Whether a theme can be loaded without asking, as custom-safe-themes says. */
function safe(name: string): boolean {
  const list = e8.variable("custom-safe-themes");
  return list === true || (Array.isArray(list) && list.includes(name));
}

/**
 * Loads a theme's package, NAME-theme, unless it is loaded, and enables it
 * unless `noEnable`, as load-theme. Unless `noConfirm` or the theme is in
 * custom-safe-themes, asks first, as loading it runs its code.
 */
export function loadTheme(name: string, noConfirm = false, noEnable = false): void {
  if (!themes.get(name)?.provided) {
    if (!noConfirm && !safe(name) && !e8.yOrNP("Loading a theme can run Lisp code.  Really load? ")) e8.userError("Theme not loaded");
    e8.require(`${name}-theme`);
    if (!themes.get(name)?.provided) e8.signal("error", `Unable to find theme file for '${name}'`);
  }
  if (!noEnable) enableTheme(name);
}

e8.defineCommand({
  name: "load-theme",
  doc: "Load a theme, NAME-theme along load-path, and enable it. A theme's code runs, so E8 asks first unless custom-safe-themes names it.",
  params: [
    { name: "theme", prompt: "Load custom theme: ", collection: () => customAvailableThemes() },
    { name: "noConfirm", kind: "prefix" },
  ],
  run: (name, noConfirm) => loadTheme(name, truthy(noConfirm as e8.Value)),
});
e8.defineCommand({
  name: "enable-theme",
  doc: "Enable a theme that is loaded, its faces winning over the other themes'.",
  params: [{ name: "theme", prompt: "Enable custom theme: ", collection: () => [...themes.keys()].filter((t) => themes.get(t)!.provided), requireMatch: true }],
  run: (name) => enableTheme(name),
});
e8.defineCommand({
  name: "disable-theme",
  doc: "Disable a theme, its faces going back to what they were.",
  params: [{ name: "theme", prompt: "Disable custom theme: ", collection: () => enabled(), requireMatch: true }],
  run: (name) => disableTheme(name),
});

e8.defun("deftheme", (name: string, doc?: string) => deftheme(name, doc));
e8.defun("custom-theme-set-faces", (name: string, specs: [string, e8.FaceAttributes][]) => customThemeSetFaces(name, specs));
e8.defun("custom-theme-set-variables", (name: string, specs: [string, e8.Value][]) => customThemeSetVariables(name, specs));
e8.defun("provide-theme", (name: string) => provideTheme(name));
e8.defun("custom-available-themes", () => customAvailableThemes());
