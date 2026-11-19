// Asking for one of several answers by a key, after Emacs's rmc.el:
// read-multiple-choice shows the choices in the echo area, each named
// with its key marked, and takes a key, showing help on ? or C-h.

import { truthy } from "subr";

e8.defineFace({
  name: "read-multiple-choice-face",
  doc: "Face for the symbol name in `read-multiple-choice' output.",
  attributes: { inherit: ["help-key-binding", "underline"], weight: "bold" },
});

/**
 * A choice: the key that picks it, as a key description ("y", "SPC"), its
 * name, and a description for the help.
 */
export type Choice = [key: string, name: string, description?: string];

const SPECIAL = ["ESC", "TAB", "RET", "DEL", "SPC"];

/**
 * A choice's name with its key shown, as rmc--add-key-description: the key
 * marked where the name has it, else before it; in brackets and upper
 * case on a display without faces, as Emacs's batch mode is.
 */
function withKey([key, name]: Choice): string | e8.PropertizedString {
  const graphical = !truthy(e8.variable("noninteractive"));
  const pos = key.length === 1 ? name.indexOf(key) : -1;
  if (pos < 0 || SPECIAL.includes(key)) {
    return e8.concat(e8.propertize(key, { face: graphical ? "read-multiple-choice-face" : "help-key-binding" }), ` ${name}`);
  }
  if (graphical) return e8.concat(name.slice(0, pos), e8.propertize(name.slice(pos, pos + 1), { face: "read-multiple-choice-face" }), name.slice(pos + 1));
  return `${name.slice(0, pos)}[${name.slice(pos, pos + 1).toUpperCase()}]${name.slice(pos + 1)}`;
}

const plain = (s: string | e8.PropertizedString) => (typeof s === "string" ? s : s.string);

/** Shows the help: helpString in a buffer of its own, or the choices and their descriptions, as rmc--show-help. */
function showHelp(prompt: string, helpString: string | undefined, bufferName: string, choices: Choice[]): string {
  const buffer = e8.getBufferCreate(bufferName);
  e8.withCurrentBuffer(buffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      if (helpString !== undefined) e8.insert(helpString);
      else {
        e8.insert(`${prompt}\n\n`);
        for (const c of choices) e8.insert(`${c[0]}: ${plain(withKey(c))}\n${c[2] ? `${c[2]}\n` : ""}`);
      }
      e8.gotoChar(e8.pointMin());
    });
    if (e8.variable("major-mode") !== "help-mode") e8.call("help-mode");
  });
  e8.call("display-buffer", bufferName);
  return bufferName;
}

/**
 * Asks for one of `choices` by its key, prompting with `prompt` and the
 * choices' names, and gives back the choice picked, as read-multiple-choice
 * does with short answers. ? and C-h show the help, `helpString` or the
 * choices' descriptions, in `showHelp` if a string, else *Multiple Choice
 * Help*; with `showHelp` the help shows at once. C-l, C-v and M-v
 * recenter and scroll, C-r edits recursively, and another key rings the
 * bell and shows the help. The windows are put back afterwards.
 */
export function readMultipleChoice(prompt: string, choices: Choice[], helpString?: string, show?: boolean | string): Choice {
  const promptChoices: Choice[] = show ? choices : [...choices, ["?", "?"]];
  const full = `${prompt} (${promptChoices.map((c) => plain(withKey(c))).join(", ")}): `;
  const bufferName = typeof show === "string" ? show : "*Multiple Choice Help*";
  let shown: string | undefined;
  try {
    return e8.saveWindowExcursion(() =>
      e8.saveExcursion(() => {
        if (show) shown = showHelp(prompt, helpString, bufferName, choices);
        let wrong = false;
        for (;;) {
          e8.message(`${wrong ? "Invalid choice.  " : ""}${full}`);
          const key = e8.readEvent();
          wrong = false;
          const actions: Record<string, () => void> = {
            "C-l": () => e8.call("recenter"),
            "C-v": () => e8.conditionCase(() => e8.call("scroll-up-command"), { error: () => undefined }),
            "M-v": () => e8.conditionCase(() => e8.call("scroll-down-command"), { error: () => undefined }),
            "C-M-v": () => e8.conditionCase(() => e8.call("scroll-other-window"), { error: () => undefined }),
            "C-M-S-v": () => e8.conditionCase(() => e8.call("scroll-other-window-down"), { error: () => undefined }),
            "C-r": () => {
              e8.message("Recursive edit; type C-M-c to return to help screen");
              e8.recursiveEdit();
            },
          };
          if (actions[key]) {
            actions[key]();
            continue;
          }
          const choice = choices.find((c) => c[0] === key);
          if (choice) return choice;
          wrong = key !== "?" && key !== "C-h";
          if (wrong) e8.ding();
          shown = showHelp(prompt, helpString, bufferName, choices);
        }
      }),
    );
  } finally {
    if (shown !== undefined && e8.getBuffer(shown) !== undefined) e8.call("kill-buffer", shown);
  }
}
