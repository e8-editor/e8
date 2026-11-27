// Images, after Emacs's image.el: making image specs with create-image,
// finding an image's type from its bytes or its file's name, putting
// images in a buffer (insert-image, put-image, insert-sliced-image,
// remove-images), and the commands that change the image at point; with
// a minimal image-mode, after image-mode.el, which shows an image file
// visited. The primitives (imagep, imageSize, imageFlush and the rest)
// are the core's, as image.c's are (ADR 0046).
//
// An image spec is a list, as in Emacs: [image :type png :file "x.png" ...],
// its keywords and symbol values JavaScript symbols.

import { truthy } from "subr";

const S = (name: string): symbol => Symbol.for(name);
const nameOf = (v: e8.Value | undefined): string | undefined => (typeof v === "symbol" ? v.description : typeof v === "string" ? v : undefined);

/** Image specs, as lists starting with the symbol `image`. */
export type Image = e8.Value[];

e8.defineError("unknown-image-type", "error");

e8.defineVariable({
  name: "image-type-header-regexps",
  doc:
    "Alist of (REGEXP . IMAGE-TYPE) pairs used to auto-detect image types.\n" +
    "When the first bytes of an image file match REGEXP, it is assumed to be of image type IMAGE-TYPE.",
  value: [
    ["\\`/[\t\n\r ]*\\*.*XPM.\\*/", S("xpm")],
    ["\\`GIF8[79]a", S("gif")],
    ["\\`\x89PNG\r\n\x1a\n", S("png")],
    ["\\`\\(?:MM\0\\*\\|II\\*\0\\)", S("tiff")],
    ["\\`[\t\n\r ]*%!PS", S("postscript")],
    ["\\`\xff\xd8", S("jpeg")],
    ["\\`RIFF[^z-a][^z-a][^z-a][^z-a]WEBPVP8", S("webp")],
    [
      "\\(?:<\\?xml[ \t\r\n]+[^>]*>\\)?[ \t\r\n]*<\\(?:!--\\(?:[^-]\\|-[^-]\\)*-->[ \t\r\n]*<\\)*" +
        "\\(?:!DOCTYPE[ \t\r\n]+[^>]*>[ \t\r\n]*<[ \t\r\n]*\\(?:!--\\(?:[^-]\\|-[^-]\\)*-->[ \t\r\n]*<\\)*\\)?[Ss][Vv][Gg]",
      S("svg"),
    ],
  ],
});

e8.defineVariable({
  name: "image-type-file-name-regexps",
  doc: "Alist of (REGEXP . IMAGE-TYPE) pairs used to identify image files.\nWhen the name of an image file match REGEXP, it is assumed to be of image type IMAGE-TYPE.",
  value: [
    ["\\.png\\'", S("png")],
    ["\\.gif\\'", S("gif")],
    ["\\.jpe?g\\'", S("jpeg")],
    ["\\.webp\\'", S("webp")],
    ["\\.bmp\\'", S("bmp")],
    ["\\.xpm\\'", S("xpm")],
    ["\\.pbm\\'", S("pbm")],
    ["\\.xbm\\'", S("xbm")],
    ["\\.ps\\'", S("postscript")],
    ["\\.tiff?\\'", S("tiff")],
    ["\\.svgz?\\'", S("svg")],
    ["\\.hei[cf]s?\\'", S("heic")],
  ],
});

e8.defineVariable({
  name: "image-load-path",
  doc:
    "List of locations in which to search for image files.\n" +
    "If an element is a string, it defines a directory to search. If an element is a variable symbol whose value is a string, " +
    "that value defines a directory to search; whose value is a list, the value is used as a list of directories to search.",
  value: [S("data-directory"), S("load-path")],
});

e8.defineVariable({
  name: "image-recompute-map-p",
  doc: "Recompute image map when scaling, rotating, or flipping an image.",
  value: true,
});

/** Runs `f` in a buffer of its own, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, f);
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** A string's characters as bytes, raw bytes as the bytes they stand for, as a unibyte string holds them. */
function unibyte(s: string): string {
  let out = "";
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    out += cp >= 0x10ff80 ? String.fromCharCode(cp - 0x10ff00) : c;
  }
  return out;
}

/** The type the first bytes of image data say it is, as image-type-from-data, or undefined. */
export function imageTypeFromData(data: string): symbol | undefined {
  const types = e8.variable("image-type-header-regexps");
  for (const entry of Array.isArray(types) ? types : []) {
    if (!Array.isArray(entry)) continue;
    const [regexp, type] = entry;
    if (typeof regexp === "string" && typeof type === "symbol" && e8.stringMatch(regexp, data) !== undefined) return type;
  }
  return undefined;
}

/** The type of image the current buffer holds, as image-type-from-buffer: only one in image-types. */
export function imageTypeFromBuffer(): symbol | undefined {
  const end = Math.min(e8.pointMax(), e8.pointMin() + 8192);
  const type = imageTypeFromData(unibyte(e8.bufferSubstringNoProperties(e8.pointMin(), end)));
  const known = e8.variable("image-types");
  return type && Array.isArray(known) && known.includes(type) ? type : undefined;
}

/** The type of an image file from its first bytes, as image-type-from-file-header. */
export function imageTypeFromFileHeader(file: string): symbol | undefined {
  let found: string | undefined = file;
  if (!e8.fileReadableP(file) && !file.startsWith("/")) found = imageSearchLoadPath(file);
  if (found === undefined || !e8.fileReadableP(found)) return undefined;
  const path = found;
  return withTempBuffer(() => {
    e8.letBind({ "coding-system-for-read": "no-conversion" }, () => e8.insertFileContents(path, { beg: 0, end: 8192 }));
    return imageTypeFromBuffer();
  });
}

/** The type of image a file's name says, if E8 can show it, as image-supported-file-p. */
export function imageSupportedFileP(file: string): symbol | undefined {
  const regexps = e8.variable("image-type-file-name-regexps");
  for (const entry of Array.isArray(regexps) ? regexps : []) {
    if (!Array.isArray(entry)) continue;
    const [regexp, type] = entry;
    if (typeof regexp === "string" && typeof type === "symbol" && e8.stringMatch(regexp, file, { caseFold: true }) !== undefined && imageTypeAvailableP(type)) {
      return type;
    }
  }
  return undefined;
}

/**
 * An image's type, as image-type: `type` if given, else from the data's
 * first bytes, or a file's first bytes and then its name. Signals
 * unknown-image-type if none is found, and an error for a type E8 does
 * not know.
 */
export function imageType(source: string, type?: string | symbol, dataP?: boolean): symbol {
  let found: symbol | undefined = type === undefined || type === null ? undefined : S(nameOf(type) ?? "");
  if (found === undefined) {
    found = dataP ? imageTypeFromData(source) : (imageTypeFromFileHeader(source) ?? imageSupportedFileP(source));
    if (found === undefined) e8.signal("unknown-image-type", "Cannot determine image type", ["Cannot determine image type"]);
  }
  const known = e8.variable("image-types");
  if (!(Array.isArray(known) && known.includes(found as symbol))) e8.signal("error", `Invalid image type \u2018${nameOf(found)}\u2019`);
  return found as symbol;
}

/** Whether images of a type can be shown, as image-type-available-p. */
export function imageTypeAvailableP(type: string | symbol): boolean {
  return e8.initImageLibrary(type);
}

/** A plist's value for a key, keys compared by name. */
function plistGet(plist: e8.Value[], key: string): e8.Value | undefined {
  for (let i = 0; i + 1 < plist.length; i += 2) if (nameOf(plist[i]) === key) return plist[i + 1];
  return undefined;
}

function plistMember(plist: e8.Value[], key: string): boolean {
  for (let i = 0; i < plist.length; i += 2) if (nameOf(plist[i]) === key) return true;
  return false;
}

/** A plist without some keys. */
function withoutKeys(plist: e8.Value[], keys: string[]): e8.Value[] {
  const out: e8.Value[] = [];
  for (let i = 0; i + 1 < plist.length; i += 2) if (!keys.includes(nameOf(plist[i]) ?? "")) out.push(plist[i], plist[i + 1]);
  return out;
}

/** Keywords given as strings become symbols, as Lisp's keywords are. */
function keywords(props: e8.Value[]): e8.Value[] {
  return props.map((v, i) => (i % 2 === 0 && typeof v === "string" ? S(v) : v));
}

/**
 * An image spec for a file or for image data, as create-image: its type
 * found as image-type finds it, `:scale default` unless the props give a
 * scale. `props` is a plist, keywords as symbols or ":name" strings.
 * Undefined if E8 cannot show images of the type.
 */
export function createImage(fileOrData: string, type?: string | symbol | null, dataP?: boolean, ...props: e8.Value[]): Image | undefined {
  const plist = keywords(props);
  let found: symbol | undefined;
  try {
    found = imageType(fileOrData, type ?? undefined, dataP);
  } catch (e) {
    if (!e8.errorConditions(e).includes("unknown-image-type")) throw e;
  }
  if (found === undefined || !imageTypeAvailableP(found)) return undefined;
  const image: Image = [S("image"), S(":type"), found, S(dataP ? ":data" : ":file"), fileOrData];
  if (!truthy(plistGet(plist, ":scale"))) image.push(S(":scale"), S("default"));
  image.push(...plist);
  return image;
}

/** An image's property, as image-property. */
export function imageProperty(image: Image, property: string): e8.Value | undefined {
  return plistGet(image.slice(1), property);
}

/** An image with a property set, or removed when the value is undefined, as (setf (image-property ...)). The image is changed in place and returned. */
export function setImageProperty(image: Image, property: string, value: e8.Value | undefined): Image {
  for (let i = 1; i < image.length; i += 2) {
    if (nameOf(image[i]) === property) {
      if (value === undefined || value === null) image.splice(i, 2);
      else image[i + 1] = value;
      return image;
    }
  }
  if (value !== undefined && value !== null) image.push(S(property), value);
  return image;
}

/** The factor images are scaled by, as image-compute-scaling-factor. */
export function imageComputeScalingFactor(scaling?: e8.Value): number {
  const value = scaling ?? e8.variable("image-scaling-factor");
  if (typeof value === "number") return value;
  if (nameOf(value) === "auto") {
    const width = e8.defaultFontWidth();
    return width < 10 ? 1 : width / 10;
  }
  return e8.signal("error", `Invalid scaling factor ${String(nameOf(value) ?? value)}`);
}

function checkImage(image: e8.Value, area?: string | symbol | null): void {
  if (!(Array.isArray(image) && nameOf(image[0]) === "image")) e8.signal("error", `Not an image: ${String(image)}`);
  const where = nameOf(area ?? undefined);
  if (where !== undefined && where !== "left-margin" && where !== "right-margin") e8.signal("error", `Invalid area ${where}`);
}

const imageSliceMap = e8.defineKeymap("image-slice-map");
export const imageMap = e8.defineKeymap("image-map", "image-slice-map");

/**
 * Puts an image in front of a position, as put-image: an overlay there
 * whose before-string, "x" by default, shows the image, in a margin if
 * `area` says. Returns the overlay, marked `put-image` for remove-images.
 */
export function putImage(image: Image, pos: number, string = "x", area?: string | symbol | null): number {
  checkImage(image, area);
  const where = nameOf(area ?? undefined);
  const prop = where === undefined ? image : [[S("margin"), S(where)], image];
  const overlay = e8.makeOverlay(pos, pos);
  e8.overlayPut(overlay, "put-image", true);
  e8.overlayPut(overlay, "before-string", e8.propertize(string, { display: prop }));
  e8.overlayPut(overlay, "keymap", imageMap);
  return overlay;
}

/**
 * Inserts an image at point, as insert-image: `string`, a space by
 * default, whose display property is the image, or a slice of it, `[X Y
 * WIDTH HEIGHT]`, in a margin if `area` says.
 */
export function insertImage(image: Image, string = " ", area?: string | symbol | null, slice?: e8.Value[], inhibitIsearch?: boolean): void {
  checkImage(image, area);
  const where = nameOf(area ?? undefined);
  const spec: e8.Value = where !== undefined ? [[S("margin"), S(where)], image] : [...image];
  const start = e8.point();
  e8.insert(string);
  const end = e8.point();
  e8.putTextProperty(start, end, "display", slice ? [[S("slice"), ...slice], spec] : spec);
  e8.putTextProperty(start, end, "rear-nonsticky", true);
  e8.putTextProperty(start, end, "inhibit-isearch", inhibitIsearch ? true : null);
  e8.putTextProperty(start, end, "keymap", slice ? imageSliceMap : imageMap);
}

/** Inserts an image cut into `rows` by `cols` slices, a row of them a line, as insert-sliced-image. */
export function insertSlicedImage(image: Image, string = " ", area?: string | symbol | null, rows = 1, cols = 1): void {
  checkImage(image, area);
  const where = nameOf(area ?? undefined);
  const spec: e8.Value = where !== undefined ? [[S("margin"), S(where)], image] : [...image];
  const dx = 1.0001 / (cols || 1);
  const dy = 1.0001 / (rows || 1);
  for (let y = 0.0; y < 1.0; y += dy) {
    for (let x = 0.0; x < 1.0; x += dx) {
      const start = e8.point();
      e8.insert(string);
      // Floats, so they are read as fractions of the image.
      e8.putTextProperty(start, e8.point(), "display", [[S("slice"), x, y, dx, dy], spec]);
      e8.putTextProperty(start, e8.point(), "rear-nonsticky", [S("display"), S("keymap")]);
      e8.putTextProperty(start, e8.point(), "keymap", imageSliceMap);
    }
    e8.insert(e8.propertize("\n", { "line-height": true }));
  }
}

/** Removes the images put-image put between two positions, as remove-images. */
export function removeImages(start: number, end: number): void {
  for (const overlay of e8.overlaysIn(start, end)) {
    if (truthy(e8.overlayGet(overlay, "put-image"))) e8.deleteOverlay(overlay);
  }
}

/** Where a file is along a path of directories, `image-load-path` by default, as image-search-load-path. */
export function imageSearchLoadPath(file: string, path?: e8.Value): string | undefined {
  const dirs = path ?? e8.variable("image-load-path");
  for (const element of Array.isArray(dirs) ? dirs : []) {
    if (typeof element === "string") {
      const name = e8.expandFileName(file, element);
      if (e8.fileReadableP(name)) return name;
    } else if (typeof element === "symbol") {
      const value = e8.variable(element.description ?? "");
      if (typeof value === "string") {
        const name = e8.expandFileName(file, value);
        if (e8.fileReadableP(name)) return name;
      } else if (Array.isArray(value)) {
        const found = imageSearchLoadPath(file, value);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * The first image of a list of specs, each a plist with `:file` or
 * `:data`, that E8 can show and whose file is found along
 * image-load-path, as find-image; undefined if none.
 */
export function findImage(specs: e8.Value[][]): Image | undefined {
  for (const raw of specs) {
    const spec = keywords(raw);
    const type = nameOf(plistGet(spec, ":type"));
    const file = plistGet(spec, ":file");
    const data = plistGet(spec, ":data");
    const rest = withoutKeys(spec, [":type", ":file", ":data"]);
    let image: Image | undefined;
    try {
      if (typeof file === "string") {
        const found = imageSearchLoadPath(file);
        if (found !== undefined) image = createImage(found, undefined, false, ...rest);
      } else if (typeof data === "string") {
        image = createImage(data, undefined, true, ...rest);
      }
    } catch {
      image = undefined;
    }
    if (image && type !== undefined && nameOf(imageProperty(image, ":type")) !== type) image = undefined;
    if (image) return image;
  }
  return undefined;
}

/** Whether two values are equal, as Lisp's `equal`. */
function equal(a: e8.Value | undefined, b: e8.Value | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return a === b;
}

/** Where the image at a position comes from: the display value, and how to put a changed one back. */
interface Found {
  image: Image;
  replace: (image: Image) => void;
}

/** The image a display value shows: an image spec, or the image of a list of specs such as a slice's. */
function imageOf(display: e8.Value | undefined): Image | undefined {
  if (!Array.isArray(display)) return undefined;
  if (nameOf(display[0]) === "image") return display;
  if (Array.isArray(display[0])) {
    const image = display.find((v) => Array.isArray(v) && nameOf(v[0]) === "image");
    return image as Image | undefined;
  }
  return undefined;
}

/** The image at a position, point by default, and how to change it, as image--get-image finds it. */
function imageAt(position?: number): Found {
  const pos = position ?? e8.point();
  // An overlay's display first, as get-char-property looks.
  for (const overlay of e8.overlaysAt(pos)) {
    const display = e8.overlayGet(overlay, "display");
    const image = imageOf(display);
    if (image) {
      return { image: [...image], replace: (changed) => e8.overlayPut(overlay, "display", swap(display as e8.Value[], image, changed)) };
    }
  }
  const display = e8.getTextProperty(pos, "display");
  const image = imageOf(display);
  if (!image) return e8.signal("error", "No recognizable image under point");
  // The text showing it: as far either way as the property is the same.
  let start = pos;
  while (start > e8.pointMin() && equal(e8.getTextProperty(start - 1, "display"), display)) start--;
  let end = pos + 1;
  while (end < e8.pointMax() && equal(e8.getTextProperty(end, "display"), display)) end++;
  return {
    image: [...image],
    replace: (changed) => e8.withSilentModifications(() => e8.putTextProperty(start, end, "display", swap(display as e8.Value[], image, changed))),
  };
}

/** A display value with its image replaced. */
function swap(display: e8.Value[], image: Image, changed: Image): e8.Value {
  return display === image ? changed : display.map((v) => (v === image ? changed : v));
}

/** Whether there is an image at point, as image-at-point-p. */
export function imageAtPointP(): boolean {
  try {
    imageAt();
    return true;
  } catch {
    return false;
  }
}

/** The image at a position, for changing: an error where images cannot be changed, as on a terminal. */
function changeableImage(position?: number): Found {
  if (e8.imageTransformsP() === undefined) e8.signal("error", "Cannot rescale images on this terminal");
  const found = imageAt(position);
  e8.imageFlush(found.image);
  return found;
}

const sizeKeys = [":scale", ":width", ":height", ":max-width", ":max-height"];

/** Scales the image at a position by a factor of its size as shown, as image--change-size. */
function changeSize(factor: number, position?: number): void {
  const { image, replace } = changeableImage(position);
  const plain = [image[0], ...withoutKeys(image.slice(1), sizeKeys)];
  const scale = e8.imageSize(image, true)[0] / e8.imageSize(plain, true)[0];
  const changed = setImageProperty(plain, ":scale", scale * factor);
  replace(changed);
}

/** Lets +, - and r go on adjusting the image, as image--repeat-map does after each change. */
function repeatAdjustments(): void {
  e8.setTransientMap({ "+": "image-increase-size", "-": "image-decrease-size", r: "image-rotate" });
  e8.message("Use +, -, r for further adjustments");
}

e8.defineCommand({
  name: "image-increase-size",
  doc: "Increase the image size at point by a factor of 1 plus N divided by 10, 20% without a prefix argument.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n) => {
    changeSize(n === null || n === undefined ? 1.2 : 1 + e8.prefixNumericValue(n) / 10);
    repeatAdjustments();
  },
});

e8.defineCommand({
  name: "image-decrease-size",
  doc: "Decrease the image size at point by a factor of 1 minus N divided by 10, 20% without a prefix argument.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n) => {
    changeSize(n === null || n === undefined ? 0.8 : 1 - e8.prefixNumericValue(n) / 10);
    repeatAdjustments();
  },
});

/** Rotates the image at point by an angle, clockwise, as image-rotate. */
export function imageRotate(angle = 90): void {
  const { image, replace } = changeableImage();
  const rotation = imageProperty(image, ":rotation");
  const turned = ((((typeof rotation === "number" ? rotation : 0) + angle) % 360) + 360) % 360;
  replace(setImageProperty(image, ":rotation", turned));
}

e8.defineCommand({
  name: "image-rotate",
  doc: "Rotate the image under point by 90 degrees clockwise, or with a prefix argument counter-clockwise.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    imageRotate(arg === null || arg === undefined ? 90 : -90);
    repeatAdjustments();
  },
});

e8.defineCommand({
  name: "image-flip-horizontally",
  doc: "Horizontally flip the image under point.",
  params: [],
  run: () => {
    const { image, replace } = changeableImage();
    replace(setImageProperty(image, ":flip", truthy(imageProperty(image, ":flip")) ? undefined : true));
  },
});

e8.defineCommand({
  name: "image-flip-vertically",
  doc: "Vertically flip the image under point.",
  params: [],
  run: () => {
    imageRotate(180);
    const { image, replace } = changeableImage();
    replace(setImageProperty(image, ":flip", truthy(imageProperty(image, ":flip")) ? undefined : true));
  },
});

e8.bindKey("i +", "image-increase-size", imageSliceMap);
e8.bindKey("i -", "image-decrease-size", imageSliceMap);
e8.bindKey("i r", "image-rotate", imageMap);
e8.bindKey("i h", "image-flip-horizontally", imageMap);
e8.bindKey("i v", "image-flip-vertically", imageMap);

// image-mode, after image-mode.el: a visited image file shows as its image.

e8.defineMajorMode({
  name: "image-mode",
  modeName: "Image",
  doc:
    "Show the image a visited file holds, made smaller to fit the window if it is larger. " +
    "+ and - change its size, r rotates it, h and v flip it, and q quits the window.",
  bindings: {
    "+": "image-increase-size",
    "-": "image-decrease-size",
    r: "image-rotate",
    h: "image-flip-horizontally",
    v: "image-flip-vertically",
    q: "quit-window",
  },
  setup: () => {
    const file = e8.bufferFileName();
    const type = file === undefined ? imageTypeFromBuffer() : (imageTypeFromFileHeader(file) ?? imageSupportedFileP(file));
    if (type === undefined) return;
    e8.setVariable("mode-name", `Image[${(type.description ?? "").toUpperCase()}]`);
    if (!e8.displayImagesP()) {
      e8.message("Cannot display image on this terminal");
      return;
    }
    // Made smaller to fit the window, as image-auto-resize's default does.
    const size = e8.windowSize();
    const props: e8.Value[] = [];
    if (size) props.push(S(":max-width"), size.width * e8.defaultFontWidth(), S(":max-height"), size.height * e8.defaultFontHeight());
    const image = file === undefined
      ? createImage(unibyte(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())), type, true, ...props)
      : createImage(file, type, false, ...props);
    if (!image || e8.pointMax() === e8.pointMin()) return;
    const modified = e8.bufferModified();
    e8.withSilentModifications(() => {
      e8.letBind({ "inhibit-read-only": true }, () => {
        const start = e8.pointMin();
        e8.putTextProperty(start, start + 1, "display", image);
        e8.putTextProperty(start, start + 1, "keymap", imageMap);
        // The rest of the bytes, newlines too, are hidden behind the image.
        if (start + 1 < e8.pointMax()) e8.putTextProperty(start + 1, e8.pointMax(), "invisible", true);
      });
    });
    e8.setBufferModified(modified);
    e8.setReadOnly(true);
    e8.gotoChar(e8.pointMin());
  },
});

// Image files open in image-mode, as auto-mode-alist has them.
const alist = e8.defaultValue("auto-mode-alist");
e8.setDefault("auto-mode-alist", [
  ...(Array.isArray(alist) ? alist : []),
  ["\\.\\(?:png\\|PNG\\|gif\\|GIF\\|jpe?g\\|JPE?G\\|svgz?\\|SVGZ?\\)\\'", "image-mode"],
]);
