// Undoing and redoing changes to the windows, after Emacs's winner.el:
// winner-mode keeps, for each frame, a ring of the window configurations it
// has had, taken after the commands that change them, and C-c <left>
// (winner-undo) goes back through it, C-c <right> (winner-redo) undoing
// the undo. Preloaded, as Emacs autoloads winner-mode.

import { withSelectedFrame } from "subr";
import { deleteWindow } from "window";

e8.defineVariable({ name: "winner-dont-bind-my-keys", doc: "Non-nil means do not bind keys in Winner mode.", value: null });
e8.defineVariable({ name: "winner-ring-size", doc: "Maximum number of stored window configurations per frame.", value: 200 });
e8.defineVariable({
  name: "winner-boring-buffers",
  doc: "List of buffer names whose windows winner-undo will not restore. You may want to include buffer names such as *Help*, *Apropos*, *Buffer List*, *info* and *Compile-Log*.",
  value: ["*Completions*"],
});
e8.defineVariable({ name: "winner-boring-buffers-regexp", doc: "winner-undo will not restore windows with buffers matching this regexp.", value: null });

const nil = (v: unknown): boolean => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0);

// A ring as ring.el's: the newest first, holding at most its size.

interface Ring<T> {
  size: number;
  items: T[];
}
const makeRing = <T>(size: number): Ring<T> => ({ size: Math.max(1, size), items: [] });
function ringInsert<T>(ring: Ring<T>, item: T): void {
  ring.items.unshift(item);
  if (ring.items.length > ring.size) ring.items.length = ring.size;
}
const ringRef = <T>(ring: Ring<T>, index: number): T => ring.items[((index % ring.items.length) + ring.items.length) % ring.items.length];
function ringRemove<T>(ring: Ring<T>, index: number): T {
  const i = ((index % ring.items.length) + ring.items.length) % ring.items.length;
  return ring.items.splice(i, 1)[0];
}

/** What winner compares configurations by: each window's edges and buffer, in order of their edges, as winner-win-data. */
type WinData = [[number, number, number, number], string][];
/** A configuration, and its windows' edges and buffers, as winner-conf. */
type Conf = [e8.WindowConfiguration, WinData];

/** The selected frame's windows, ordered by their edges, left then top, as winner-sorted-window-list. */
function winnerSortedWindowList(): e8.Window[] {
  const windows = e8.windowList().filter((w) => w !== e8.minibufferWindow());
  const edges = new Map(windows.map((w) => [w, e8.windowEdges(w)]));
  return windows.sort((x, y) => {
    const a = edges.get(x)!;
    const b = edges.get(y)!;
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
}

const winnerWinData = (): WinData => winnerSortedWindowList().map((w) => [e8.windowEdges(w), e8.windowBuffer(w) ?? ""]);
const winnerConf = (): Conf => [e8.currentWindowConfiguration(), winnerWinData()];
const winData = (a: WinData): string => JSON.stringify(a);

/** Each frame's configuration after the last command, as winner-currents. */
const winnerCurrents = new Map<e8.Frame, Conf>();

const winnerRemember = (): void => {
  winnerCurrents.set(e8.selectedFrame(), winnerConf());
};

const winnerConfiguration = (frame: e8.Frame = e8.selectedFrame()): Conf => winnerCurrents.get(frame) ?? withSelectedFrame(frame, winnerConf);

/** Each frame's ring of configurations, as winner-ring-alist. */
const winnerRingAlist = new Map<e8.Frame, Ring<Conf>>();

function winnerRing(frame: e8.Frame): Ring<Conf> {
  let ring = winnerRingAlist.get(frame);
  if (ring === undefined) {
    ring = makeRing(Number(e8.variable("winner-ring-size") ?? 200));
    ringInsert(ring, winnerConfiguration(frame));
    winnerRingAlist.set(frame, ring);
  }
  return ring;
}

let winnerLastCommand: string | undefined;
let winnerLastFrames: e8.Frame[] = [];

/** Whether two configurations show the same windows with the same buffers, as winner-equal. */
const winnerEqual = (a: Conf, b: Conf): boolean => winData(a[1]) === winData(b[1]);

function winnerInsertIfNew(frame: e8.Frame): void {
  if (winnerLastFrames.includes(frame) || e8.thisCommand() === "winner-redo") return;
  const conf = winnerConfiguration(frame);
  const ring = winnerRing(frame);
  // When the previous configuration was very similar, keep only the latest.
  if (ring.items.length > 0 && winnerEqual(conf, ringRef(ring, 0))) ringRemove(ring, 0);
  ringInsert(ring, conf);
  winnerLastFrames.push(frame);
}

/** The frames whose windows changed since winner last looked, as winner-modified-list. */
let winnerModifiedList: e8.Frame[] = [];

function winnerChangeFun(): void {
  winnerModifiedList = winnerModifiedList.filter((f) => e8.frameLiveP(f));
  const frame = e8.selectedFrame();
  if (!winnerModifiedList.includes(frame) && e8.minibufferDepth() === 0) winnerModifiedList.unshift(frame);
}

function winnerSaveOldConfigurations(): void {
  if (e8.minibufferDepth() !== 0) return;
  if (e8.thisCommand() !== winnerLastCommand) {
    winnerLastFrames = [];
    winnerLastCommand = e8.thisCommand();
  }
  for (const frame of winnerModifiedList) if (e8.frameLiveP(frame)) winnerInsertIfNew(frame);
  winnerModifiedList = [];
  winnerRemember();
}

function winnerSaveUnconditionally(): void {
  if (e8.thisCommand() !== winnerLastCommand) {
    winnerLastFrames = [];
    winnerLastCommand = e8.thisCommand();
  }
  winnerInsertIfNew(e8.selectedFrame());
  winnerRemember();
}

function winnerSaveConditionally(): void {
  if (e8.minibufferDepth() === 0) winnerSaveUnconditionally();
}

/** Puts a configuration back, keeping the selected window if it is still there, as winner-set-conf. */
function winnerSetConf(winconf: e8.WindowConfiguration): void {
  const chosen = e8.selectedWindow();
  e8.setWindowConfiguration(winconf);
  if (e8.windowLiveP(chosen)) e8.selectWindow(chosen);
  else if (e8.selectedWindow() === e8.minibufferWindow()) e8.call("other-window", 1);
}

/** For each buffer, its mark and whether its region was active, and its point in each window, as winner-point-alist. */
type PointEntry = { buffer: string; mark: [number | undefined, boolean]; points: [e8.Window | null, number][] };
let winnerPointAlist: PointEntry[] = [];

function winnerMakePointAlist(): PointEntry[] {
  const alist: PointEntry[] = [];
  for (const win of e8.windowList().filter((w) => w !== e8.minibufferWindow())) {
    const buffer = e8.windowBuffer(win) ?? "";
    let entry = alist.find((e) => e.buffer === buffer);
    if (entry === undefined) {
      entry = { buffer, mark: e8.withCurrentBuffer(buffer, () => [e8.mark(), e8.regionActive()]), points: [] };
      alist.unshift(entry);
    }
    entry.points.unshift([win, e8.windowPoint(win)]);
  }
  return alist;
}

/** Where to put a window's point in a buffer, as winner-get-point: undefined if the buffer is gone. */
function winnerGetPoint(buffer: string, win: e8.Window | null): number | undefined {
  if (!e8.bufferLiveP(e8.getBuffer(buffer))) return undefined;
  const entry = winnerPointAlist.find((e) => e.buffer === buffer);
  if (entry !== undefined) {
    const here = entry.points.find(([w]) => w === win) ?? entry.points.find(([w]) => w === null);
    if (here !== undefined) return here[1];
    const point = e8.withCurrentBuffer(buffer, () => e8.point());
    entry.points.unshift([null, point]);
    return point;
  }
  const [mark, active, point] = e8.withCurrentBuffer(buffer, () => [e8.mark(), e8.regionActive(), e8.point()] as const);
  winnerPointAlist.unshift({ buffer, mark: [mark, active], points: [[null, point]] });
  return point;
}

function boring(buffer: string): boolean {
  const names = e8.variable("winner-boring-buffers");
  if (Array.isArray(names) && names.includes(buffer)) return true;
  const regexp = e8.variable("winner-boring-buffers-regexp");
  return typeof regexp === "string" && e8.stringMatch(regexp, buffer) !== undefined;
}

/**
 * Puts a configuration back, as winner-set: each window's point where it
 * was, and the windows whose buffers are gone or boring deleted. False if
 * that leaves the configuration impossible, only one window being left.
 */
function winnerSet(conf: Conf): boolean {
  const buffers: string[] = [];
  const alive: (number | undefined)[] = conf[1].map(([, buffer]) => {
    const pos = winnerGetPoint(buffer, null);
    if (pos !== undefined && !buffers.includes(buffer)) buffers.unshift(buffer);
    return pos;
  });
  winnerSetConf(conf[0]);
  const xwins: e8.Window[] = [];
  for (const win of winnerSortedWindowList()) {
    const buffer = e8.windowBuffer(win) ?? "";
    let keep = alive.shift() !== undefined;
    if (keep) {
      const point = winnerGetPoint(buffer, win);
      if (point === undefined) keep = false;
      else e8.setWindowPoint(win, point);
    }
    if (!keep || boring(buffer)) xwins.unshift(win);
  }
  // Marks, as select-enable-primary is nil.
  if (nil(e8.variable("select-enable-primary"))) {
    for (const buffer of buffers) {
      const entry = winnerPointAlist.find((e) => e.buffer === buffer);
      if (entry === undefined) continue;
      e8.withCurrentBuffer(buffer, () => {
        e8.setMark(entry.mark[0] ?? null);
        if (entry.mark[1]) e8.activateMark();
        else e8.deactivateMark();
      });
    }
  }
  if (xwins.length === 0) return true;
  for (const win of xwins.slice(1)) deleteWindow(win);
  const oneWindow = e8.windowList().filter((w) => w !== e8.minibufferWindow()).length === 1;
  if (oneWindow) return false;
  deleteWindow(xwins[0]);
  return true;
}

let winnerUndoFrame: e8.Frame | undefined;
let winnerPendingUndoRing: Ring<Conf> = makeRing(1);
let winnerUndoCounter = 0;
let winnerUndoneData: string[] = [];

/** Puts back the next configuration back that differs from those undone through, as winner-undo-this. */
function winnerUndoThis(): boolean {
  for (;;) {
    if (winnerUndoCounter >= winnerPendingUndoRing.items.length) {
      e8.message("No further window configuration undo information");
      return false;
    }
    if (winnerSet(ringRef(winnerPendingUndoRing, winnerUndoCounter))) {
      const data = winData(winnerWinData());
      if (!winnerUndoneData.includes(data)) {
        winnerUndoneData.unshift(data);
        return true;
      }
    }
    ringRemove(winnerPendingUndoRing, winnerUndoCounter);
  }
}

const winnerUndo = e8.defineCommand({
  name: "winner-undo",
  doc: "Switch back to an earlier window configuration saved by Winner mode. In other words, undo changes in window configuration.",
  run: () => {
    if (nil(e8.variable("winner-mode"))) e8.signal("error", "Winner mode is turned off");
    if (!(e8.lastCommand() === "winner-undo" && winnerUndoFrame === e8.selectedFrame())) {
      winnerSaveConditionally();
      winnerUndoFrame = e8.selectedFrame();
      winnerPointAlist = winnerMakePointAlist();
      winnerPendingUndoRing = winnerRing(e8.selectedFrame());
      winnerUndoCounter = 0;
      winnerUndoneData = [winData(winnerWinData())];
    }
    winnerUndoCounter++;
    if (winnerUndoThis() && e8.selectedWindow() !== e8.minibufferWindow()) {
      e8.message(`Winner undo (${winnerUndoCounter} / ${winnerPendingUndoRing.items.length - 1})`);
    }
  },
});

const winnerRedo = e8.defineCommand({
  name: "winner-redo",
  doc: "Restore a more recent window configuration saved by Winner mode.",
  run: () => {
    if (e8.lastCommand() !== "winner-undo") e8.userError("Previous command was not a ‘winner-undo’");
    winnerSet(e8.minibufferDepth() === 0 ? ringRemove(winnerPendingUndoRing, 0) : ringRef(winnerPendingUndoRing, 0));
    if (e8.selectedWindow() !== e8.minibufferWindow()) e8.message("Winner undid undo");
  },
});

e8.defineMinorMode({
  name: "winner-mode",
  global: true,
  doc:
    "Toggle Winner mode, which records the changes in the window configuration so that they can be undone with " +
    "winner-undo, C-c <left>. Changing your mind while undoing, C-c <right> (winner-redo) undoes the undo.",
  bindings: { "C-c <left>": winnerUndo, "C-c <right>": winnerRedo },
  onChange: (enabled) => {
    if (enabled) {
      // Emacs reads winner-dont-bind-my-keys as winner.el loads, before
      // init.ts here, as winner is preloaded: so as the mode turns on.
      const bind = nil(e8.variable("winner-dont-bind-my-keys"));
      e8.defineKey("winner-mode-map", "C-c <left>", bind ? winnerUndo : null);
      e8.defineKey("winner-mode-map", "C-c <right>", bind ? winnerRedo : null);
      e8.addHook("window-configuration-change-hook", winnerChangeFun);
      e8.addHook("post-command-hook", winnerSaveOldConfigurations);
      e8.addHook("minibuffer-setup-hook", winnerSaveUnconditionally);
      winnerModifiedList = e8.frameList();
      winnerSaveOldConfigurations();
    } else {
      e8.removeHook("window-configuration-change-hook", winnerChangeFun);
      e8.removeHook("post-command-hook", winnerSaveOldConfigurations);
      e8.removeHook("minibuffer-setup-hook", winnerSaveUnconditionally);
    }
  },
});

// winner-repeat-map, for repeat-mode, which E8 does not have yet.
e8.defineKeymap("winner-repeat-map");
e8.defineKey("winner-repeat-map", "<left>", winnerUndo);
e8.defineKey("winner-repeat-map", "<right>", winnerRedo);
e8.put("winner-undo", "repeat-map", "winner-repeat-map");
e8.put("winner-redo", "repeat-map", "winner-repeat-map");
