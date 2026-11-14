# 0044. Faces as Emacs's

Status: accepted · 2026-10-31

## Context

E8's faces set a foreground, a background, a height and a family, and bold, italic, underline and strike-through were on or off. Colours were E8's palette names or `#rrggbb`. A `face` property could only name faces. Emacs's packages and themes rely on more, all of it from xfaces.c and faces.el:

- **Attributes:**
  - weights and slants by name;
  - coloured and wavy underlines, overlines, boxes and inverse video;
  - backgrounds that `:extend` past a line's end, as `hl-line` and Org's blocks use;
  - `:inherit` from a list of faces.
- **Colours:** the colour names Emacs knows, such as "dark slate gray", and its colour specs.
- **Anonymous faces:** a plist of attributes as a `face` property, which ansi-color, Org's emphasis and many modes put on text.
- **Primitives:** `face-attribute`, `set-face-attribute` with `unspecified`, `color-values` and `color-distance`, and the faces.el functions and commands built on them.

[docs/plan.md](../plan.md) counted none of xfaces.c's 30 primitives as there.

## Options considered

1. **Keep each attribute as a typed field, with Emacs's values, and the attribute names and value forms Emacs reads and gives.** Resolving a face stays a merge of fields, as fast as before, and front ends draw the resolved `Style`.
2. **Keep a face as a map of attribute names to Lisp values, as Emacs's face vectors are.** Closest to xfaces.c, but every redisplay would read values out of the map and parse them again.

## Decision

Option 1.

- **Attributes.** `FaceAttrs` has every attribute Emacs's faces have:
  - `:family`, `:foundry`, `:width`, `:height`, `:weight` and `:slant`;
  - `:foreground`, `:distant-foreground` and `:background`;
  - `:underline`, `:overline` and `:strike-through`, each off or on in a colour and a style;
  - `:box`, with a width, colour and style;
  - `:inverse-video`, `:extend`, `:stipple`, `:font`, and `:inherit` as a list.

  `FaceAttrs::set` and `get` read and give each in Emacs's form, `unspecified` unsetting it. Inheritance merges the faces `:inherit` names, earlier ones winning.
- **Colours.** `Color::parse` takes E8's palette names, the 657 names Emacs knows (`color-name-rgb-alist`, generated into `colors_data.rs` by `tests/emacs/colors.el`), and Emacs's colour specs, `#RGB` to `#RRRRGGGGBBBB`, `rgb:` and `rgbi:`. `color_distance` and `color_gray_p` are xfaces.c's.
- **Anonymous faces.** A plist in a `face` property, alone or in a list with names, stands for an anonymous face. Each different plist is given a name of its own once, so rows, styles and their caches treat it as a named face.
- **Drawing.** `Style` gains the underline's colour and wave, the overline, the strike-through's colour, the box, and `:extend`; inverse video swaps the colours when a style is resolved. A row records its newline's style when it extends.
  - The terminal draws coloured underlines and fills an extending background to the edge.
  - The GUI draws coloured underlines and strike-throughs, wavy underlines, overlines, boxes and extending backgrounds.
- **Script API.**
  - `faceAttribute`, `setFaceAttribute` (as an object or Emacs's plist), `faceList`, `facep`, `makeFace` and `copyFace`.
  - `colorValues`, `colorValuesFromColorSpec`, `colorDefinedP`, `colorSupportedP`, `definedColors`, `colorDistance` and `colorGrayP`.
- **faces.ts**, after faces.el:
  - `face-foreground`, `face-background`, `face-bold-p`, `face-italic-p`, `face-underline-p`, `face-inverse-video-p` and `face-extend-p`;
  - `face-equal`, `face-differs-from-default-p`, `face-attribute-relative-p`, `merge-face-attribute` and `read-color`;
  - the commands `set-face-foreground`, `set-face-background`, `set-face-underline`, `set-face-inverse-video`, `set-face-extend`, `make-face-bold` and its kin, `invert-face` and `list-faces-display`;
  - facemenu.el's `list-colors-display`.

`tests/faces.rs` in e8-core and `tests/face_attributes.rs` in e8-script check colour specs and names, attributes and inheritance against Emacs 30.2's values. Batch Emacs answers `color-distance` and `color-gray-p` for a terminal's few colours, so those follow xfaces.c's code instead. A snapshot shows the decorations drawn.

## Consequences

- Themes and packages can set faces as Emacs's do, with colour names, and put attribute lists on text.
- Merging faces now copies twice as many fields, so a resolved style is kept per list of faces and background until any face changes (`Editor::style_cache`), where before every redisplay worked each out again. An anonymous face costs a lookup by its plist each time it is met, which is rare outside ansi-color's output.
- Not yet:
  - font primitives (`face-font`, `x-list-fonts`, `x-family-fonts`), since given by [ADR 0048](0048-overlay-arrows-fringe-indicators-and-fonts.md) and [ADR 0085](0085-face-and-font-internals-as-emacs-has-them.md), which also gives xfaces.c's Lisp-face primitives;
  - stipples;
  - the double, dotted and dashed underline styles, which draw as plain lines;
  - the raised and pressed box styles, which draw as plain boxes;
  - `:distant-foreground`, which is kept but not used to choose a colour.

  The terminal draws no overline, box or wave, as Emacs on a terminal does not. [docs/differences.md](../differences.md) lists these.

## Dependencies introduced

None.
