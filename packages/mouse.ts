// Mouse commands, after Emacs's mouse.el. Front ends turn presses, clicks
// and drags into keys such as <down-mouse-1>, <mouse-1> and <drag-mouse-1>,
// and e8.lastMouseEvent() says where they happened.

function lastEvent() {
  const event = e8.lastMouseEvent();
  if (event === undefined) {
    throw new Error("This command must be bound to a mouse event");
  }
  return event;
}

/** Selects the event's window and moves point to where the mouse is. */
function goToEvent(event: { window: e8.Window; position?: number }) {
  e8.selectWindow(event.window);
  if (event.position !== undefined) {
    e8.gotoChar(event.position);
  }
}

const dragRegion = e8.defineCommand({
  name: "mouse-drag-region",
  doc:
    "Start selecting with the mouse: select the window clicked in and move point there.\n\n" +
    "Dragging then sets the region, with <drag-mouse-1>.",
  run: () => {
    goToEvent(lastEvent());
    e8.deactivateMark();
  },
});

const setPoint = e8.defineCommand({
  name: "mouse-set-point",
  doc: "Move point to where the mouse was clicked, selecting that window.",
  run: () => {
    goToEvent(lastEvent());
    e8.deactivateMark();
  },
});

const setRegion = e8.defineCommand({
  name: "mouse-set-region",
  doc:
    "Set the region to the text the mouse was dragged over.\n\n" +
    "The mark goes where the drag started and point where it ended, and the region is active.",
  run: () => {
    const event = lastEvent();
    const start = event.start?.window === event.window ? event.start.position : undefined;
    goToEvent(event);
    if (start !== undefined) {
      e8.setMark(start);
      e8.activateMark();
    }
  },
});

/** Which kind of character, for selecting a run of the same kind. */
function charClass(c: string): string {
  if (/[\p{L}\p{N}_]/u.test(c)) return "word";
  if (/\s/u.test(c)) return "space";
  return c;
}

const selectWord = e8.defineCommand({
  name: "mouse-select-word",
  doc:
    "Select the word double-clicked on, or the run of spaces or the character.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts two clicks; E8 binds it to <double-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = e8.lineOf(event.position);
    const start = e8.lineStart(line);
    const chars = Array.from(e8.lineText(line));
    let i = event.position - start;
    if (i >= chars.length) return;
    const kind = charClass(chars[i]);
    let j = i + 1;
    if (kind === "word" || kind === "space") {
      while (i > 0 && charClass(chars[i - 1]) === kind) i--;
      while (j < chars.length && charClass(chars[j]) === kind) j++;
    }
    e8.setMark(start + i);
    e8.gotoChar(start + j);
    e8.activateMark();
  },
});

const selectLine = e8.defineCommand({
  name: "mouse-select-line",
  doc:
    "Select the line triple-clicked on, with its newline.\n\n" +
    "Emacs does this inside mouse-drag-region when it counts three clicks; E8 binds it to <triple-mouse-1>.",
  run: () => {
    const event = lastEvent();
    goToEvent(event);
    if (event.position === undefined) return;
    const line = e8.lineOf(event.position);
    e8.setMark(e8.lineStart(line));
    e8.gotoChar(line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.lineEnd(line));
    e8.activateMark();
  },
});

const extendRegion = e8.defineCommand({
  name: "mouse-extend-region",
  doc:
    "Extend the region to where the mouse was clicked, setting the mark at point first if the region is not active.\n\n" +
    "Emacs binds S-<down-mouse-1> to a menu of fonts; E8 binds S-<mouse-1> to this, as most editors do.",
  run: () => {
    const event = lastEvent();
    if (event.window !== e8.selectedWindow()) {
      goToEvent(event);
      return;
    }
    if (!e8.regionActive()) {
      e8.pushMark(e8.point());
    }
    goToEvent(event);
    e8.activateMark();
  },
});

e8.bindKey("<down-mouse-1>", dragRegion);
e8.bindKey("<mouse-1>", setPoint);
e8.bindKey("<drag-mouse-1>", setRegion);
e8.bindKey("<double-mouse-1>", selectWord);
e8.bindKey("<triple-mouse-1>", selectLine);
e8.bindKey("S-<mouse-1>", extendRegion);
e8.bindKey("S-<down-mouse-1>", "ignore");
