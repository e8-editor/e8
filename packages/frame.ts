// What frame.el asks the display, over the primitives each window system
// answers for itself (ADR 0081). A window frame asks the window system,
// a terminal its own screen, as frame.el's own wrappers split.

/** The display's width in pixels, or the frame's columns on a terminal (display-pixel-width). */
export function displayPixelWidth(): number {
  return e8.displayIsAWindow() ? e8.xDisplayPixelWidth() : e8.frameWidth();
}

/** The display's height in pixels, or the frame's lines on a terminal (display-pixel-height). */
export function displayPixelHeight(): number {
  return e8.displayIsAWindow() ? e8.xDisplayPixelHeight() : e8.frameHeight();
}

/** The display's width in millimetres, or undefined where nothing says (display-mm-width). */
export function displayMmWidth(): number | undefined {
  return e8.displayIsAWindow() ? e8.xDisplayMmWidth() : undefined;
}

/** The display's height in millimetres, or undefined where nothing says (display-mm-height). */
export function displayMmHeight(): number | undefined {
  return e8.displayIsAWindow() ? e8.xDisplayMmHeight() : undefined;
}

/** How many bits a pixel has, 0 on a terminal (display-planes). */
export function displayPlanes(): number {
  return e8.displayIsAWindow() ? e8.xDisplayPlanes() : Math.max(1, Math.round(Math.log2(displayColorCells())));
}

/** How many colours the display shows (display-color-cells). */
export function displayColorCells(): number {
  return e8.displayIsAWindow() ? e8.xDisplayColorCells() : e8.ttyDisplayColorCells();
}

/** Whether the display shows colour (display-color-p). */
export function displayColorP(): boolean {
  return e8.displayIsAWindow() ? e8.xwDisplayColorP() : e8.ttyDisplayColorP();
}

/** Whether it shows shades of grey but no colour (display-grayscale-p). */
export function displayGrayscaleP(): boolean {
  return displayColorP() ? false : displayColorCells() > 2;
}

/** How many screens the display has: one (display-screens). */
export function displayScreens(): number {
  return 1;
}

/** How the display holds colours (display-visual-class). */
export function displayVisualClass(): string {
  return e8.displayIsAWindow() ? e8.xDisplayVisualClass() : displayColorP() ? "static-color" : "static-gray";
}

/** Each monitor the display is made of, as an alist each (display-monitor-attributes-list). */
export function displayMonitorAttributesList(): [string, e8.Value][][] {
  return e8.displayMonitorAttributesList();
}

/** The monitor a frame is on, the selected frame's by default (frame-monitor-attributes). */
export function frameMonitorAttributes(frame?: e8.FrameLike | null): [string, e8.Value][] | undefined {
  const wanted = e8.frameLiveP(frame ?? e8.selectedFrame()) ? (frame ?? e8.selectedFrame()) : undefined;
  if (wanted === undefined) return undefined;
  for (const monitor of displayMonitorAttributesList()) {
    const frames = monitor.find(([name]) => name === "frames")?.[1] as e8.Value[] | undefined;
    if (frames?.some((f) => e8.frameLiveP(f as e8.FrameLike) && e8.frameParameter(f as e8.FrameLike, "name") === e8.frameParameter(wanted, "name"))) {
      return monitor;
    }
  }
  return displayMonitorAttributesList()[0];
}

/** One attribute of the monitor a frame is on (frame-monitor-attribute). */
export function frameMonitorAttribute(attribute: string, frame?: e8.FrameLike | null): e8.Value | undefined {
  return frameMonitorAttributes(frame)?.find(([name]) => name === attribute)?.[1] ?? undefined;
}

/** The whole of a frame's window on the screen: left, top, width, height (frame-monitor-geometry). */
export function frameMonitorGeometry(frame?: e8.FrameLike | null): e8.Value | undefined {
  return frameMonitorAttribute("geometry", frame);
}

/** What is left of a frame's monitor once the system's own bars are off (frame-monitor-workarea). */
export function frameMonitorWorkarea(frame?: e8.FrameLike | null): e8.Value | undefined {
  return frameMonitorAttribute("workarea", frame);
}

/** The width of the window the system draws around a frame (frame-outer-width). */
export function frameOuterWidth(frame?: e8.FrameLike | null): number {
  return e8.frameOuterWidth(frame);
}

/** Its height, title bar and all (frame-outer-height). */
export function frameOuterHeight(frame?: e8.FrameLike | null): number {
  return e8.frameOuterHeight(frame);
}

/** A frame's edges on the screen: left, top, right, bottom (frame-edges). */
export function frameEdges(frame?: e8.FrameLike | null, which?: "outer-edges" | "native-edges" | "inner-edges" | null): number[] {
  return e8.frameEdges(frame, which);
}

// The names Lisp calls these by, so code that has not imported them can
// reach them with e8.funcall, as Emacs's frame.el functions are symbols.
e8.defun("display-pixel-width", displayPixelWidth);
e8.defun("display-pixel-height", displayPixelHeight);
e8.defun("display-mm-width", displayMmWidth);
e8.defun("display-mm-height", displayMmHeight);
e8.defun("display-planes", displayPlanes);
e8.defun("display-color-cells", displayColorCells);
e8.defun("display-color-p", displayColorP);
e8.defun("display-grayscale-p", displayGrayscaleP);
e8.defun("display-screens", displayScreens);
e8.defun("display-visual-class", displayVisualClass);
e8.defun("display-monitor-attributes-list", displayMonitorAttributesList);
e8.defun("frame-monitor-attributes", frameMonitorAttributes);
e8.defun("frame-monitor-attribute", frameMonitorAttribute);
e8.defun("frame-monitor-geometry", frameMonitorGeometry);
e8.defun("frame-monitor-workarea", frameMonitorWorkarea);
e8.defun("frame-outer-width", frameOuterWidth);
e8.defun("frame-outer-height", frameOuterHeight);
e8.defun("frame-edges", frameEdges);
