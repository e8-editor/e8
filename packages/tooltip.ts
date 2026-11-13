// Tooltips, after Emacs's tooltip.el: a small box of text shown over the
// frame, where the pointer is, until it is hidden or its time is up.
// E8 draws it itself, as it draws menus, so a terminal has tooltips too.
// Unlike Emacs, nothing shows one by itself from a `help-echo` property;
// a package shows one by calling tooltipShow (docs/differences.md).

import { truthy } from "subr";

for (const [name, value, doc] of [
  ["tooltip-mode", true, "Whether tooltips are shown at all. The command tooltip-mode turns them on and off."],
  ["tooltip-delay", 0.7, "How long the pointer rests before a tooltip shows."],
  ["tooltip-short-delay", 0.1, "How long the pointer rests before the next tooltip of a run shows."],
  ["tooltip-hide-delay", 10, "How long a tooltip stays before it goes by itself."],
  ["tooltip-x-offset", 1, "How far right of the pointer a tooltip goes, in columns, where Emacs counts pixels."],
  ["tooltip-y-offset", 1, "How far below the pointer a tooltip goes, in lines, where Emacs counts pixels."],
  ["tooltip-recent-seconds", 1, "How soon after a tooltip went the next one shows after tooltip-short-delay rather than tooltip-delay."],
  ["tooltip-hide-time", null, "When the last tooltip went, in seconds since the epoch."],
] as const) {
  e8.defineVariable({ name, value, doc });
}

/**
 * Show `text` as a tooltip where the pointer is, as tooltip-show does.
 * With `useEchoArea`, or with tooltip-mode off, it goes to the echo area
 * instead, as Emacs's does.
 */
export function tooltipShow(text: string, useEchoArea?: boolean): void {
  if (useEchoArea || !truthy(e8.variable("tooltip-mode"))) {
    e8.message(text);
    return;
  }
  const number = (name: string, fallback: number) => {
    const value = e8.variable(name);
    return typeof value === "number" ? value : fallback;
  };
  e8.xShowTip(text, null, number("tooltip-hide-delay", 10), [number("tooltip-x-offset", 1), number("tooltip-y-offset", 1)]);
}

/** Take the tooltip away, as tooltip-hide does; true if one was showing. */
export function tooltipHide(): boolean {
  const was = truthy(e8.xHideTip());
  if (was) {
    e8.setVariable("tooltip-hide-time", Date.now() / 1000);
  }
  return was;
}

e8.defineMinorMode({
  name: "tooltip-mode",
  doc: "Show tooltips. With it off, what would be a tooltip goes to the echo area, as in Emacs.",
  global: true,
  onChange: (enabled) => {
    if (enabled) {
      // A tooltip goes as soon as anything is typed, as tooltip-mode
      // puts tooltip-hide on pre-command-hook.
      e8.addHook("pre-command-hook", tooltipHide);
    } else {
      e8.removeHook("pre-command-hook", tooltipHide);
      e8.xHideTip();
    }
  },
});

e8.addHook("pre-command-hook", tooltipHide);

e8.defineCommand({
  name: "tooltip-show-at-point",
  doc: "Show some text as a tooltip where point is.",
  params: [{ name: "text", kind: "string", prompt: "Tooltip: " }],
  run: (text: string) => {
    const hide = e8.variable("tooltip-hide-delay");
    e8.xShowTip(text, "point", typeof hide === "number" ? hide : null);
  },
});
