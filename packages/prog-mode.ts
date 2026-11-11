// The mode programming modes are built on, after Emacs's prog-mode.el.

import { defineGuide } from "help-guide";

e8.defineMajorMode({
  name: "prog-mode",
  modeName: "Prog",
  doc:
    "The major mode programming language modes are built on.\n\n" +
    "Put what you want in every programming mode on prog-mode-hook, which runs before each mode's own hook.",
  // As prog-mode.el: source files end in a newline.
  setup: () => e8.setVariable("require-final-newline", e8.variable("mode-require-final-newline") ?? true),
});

// What C-h h shows in a programming mode, which takes it as its own unless it gives one (ADR 0068).
defineGuide("prog-mode", {
  title: "Prog mode",
  summary: "The mode every programming language's mode is built on, with the keys they share.",
  keys: [
    [
      "Writing code",
      [
        ["indent-for-tab-command", "Indent the line, or complete what is before point"],
        ["completion-at-point", "Complete the name before point"],
        ["comment-dwim", "Comment the selection out, or add a comment to the line"],
      ],
    ],
    [
      "Finding your way",
      [
        ["xref-find-definitions", "Go to the definition of the name at point"],
        ["xref-go-back", "Come back from it"],
        ["xref-find-references", "List where the name is used"],
        ["beginning-of-defun", "Go to the start of the function"],
        ["forward-sexp", "Move over a balanced expression: brackets, a string"],
      ],
    ],
    [
      "The project",
      [
        ["project-find-file", "Open a file of the project, by name"],
        ["project-find-regexp", "Search every file of the project"],
        ["compile", "Build or test it; the errors become links"],
        ["next-error", "Go to the next error or match"],
      ],
    ],
  ],
  tryNow: [
    "Put point on a function's name and press \\[xref-find-definitions], then \\[xref-go-back] to come back.",
    "Select a few lines and press \\[comment-dwim] to comment them out; again to bring them back.",
  ],
  learnNext: [
    "\\[eglot] starts a language server, when one is installed, for completion and errors as you type.",
    "\\[describe-mode] lists every key of the mode you are in.",
  ],
});
