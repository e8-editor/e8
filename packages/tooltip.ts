// Tooltips, after Emacs's tooltip.el: a small box of text shown over the
// frame, where the pointer is, until it is hidden or its time is up.
// E8 draws it itself, as it draws menus, so a terminal has tooltips too.
// Unlike Emacs, nothing shows one by itself from a `help-echo` property;
// a package shows one by calling tooltipShow (docs/differences.md).

for (const [name, value, doc] of [
  ["tooltip-mode", true, "Whether tooltips are shown at all. The command tooltip-mode turns them on and off."],
  ["tooltip-delay", 0.7, "How long the pointer rests before a tooltip shows."],
  ["tooltip-short-delay", 0.1, "How long the pointer rests before the next tooltip of a run shows."],
  ["tooltip-hide-delay", 10, "How long a tooltip stays before it goes by itself."],
  ["tooltip-x-offset", 5, "How far right of the pointer a tooltip goes, in columns."],
  ["tooltip-y-offset", 1, "How far below the pointer a tooltip goes, in lines."],
] as const) {
  e8.defineVariable({ name, value, doc });
}

/** Show `text` as a tooltip where the pointer is, as tooltip-show does. */
export function tooltipShow(text: string): void {
  if (!e8.variable("tooltip-mode")) {
    e8.message(text);
    return;
  }
  const hide = e8.variable("tooltip-hide-delay");
  e8.xShowTip(text, null, typeof hide === "number" ? hide : null);
}

/** Take the tooltip away, as tooltip-hide does. */
export function tooltipHide(): void {
  e8.xHideTip();
}

e8.defineMinorMode({
  name: "tooltip-mode",
  doc: "Show tooltips. With it off, what would be a tooltip goes to the echo area, as in Emacs.",
  global: true,
  onChange: (enabled) => {
    if (!enabled) {
      e8.xHideTip();
    }
  },
});

e8.defineCommand({
  name: "tooltip-show-at-point",
  doc: "Show some text as a tooltip where point is.",
  params: [{ name: "text", kind: "string", prompt: "Tooltip: " }],
  run: (text: string) => {
    const posn = e8.posnAtPoint();
    const hide = e8.variable("tooltip-hide-delay");
    e8.xShowTip(text, posn ? [posn.col + 1, posn.row + 1] : null, typeof hide === "number" ? hide : null);
  },
});
