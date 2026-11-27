//! Org's inline images, as org-display-inline-images shows them: the Emacs
//! oracle runs in batch, which cannot show images, so these are E8's own.
//! The frame's metrics are those of `images.rs`, 7 pixels to a column.

use std::sync::Arc;

use e8_core::Editor;
use e8_core::layout::{FontSpec, TextMetrics};
use e8_script::Scripting;

struct Graphical;

impl TextMetrics for Graphical {
    fn advance(&self, font: &FontSpec, _c: char) -> f32 {
        7.0 * font.scale
    }
    fn line_height(&self, font: &FontSpec) -> f32 {
        14.0 * font.scale
    }
    fn char_width(&self) -> f32 {
        7.0
    }
    fn char_height(&self) -> f32 {
        14.0
    }
    fn ascent(&self, font: &FontSpec) -> f32 {
        11.0 * font.scale
    }
    fn font_size(&self) -> f32 {
        12.0
    }
    fn images(&self) -> bool {
        true
    }
}

/// The test images, 32 by 16 pixels for red-blue.png and 8 by 8 for dot.png.
fn image(name: &str) -> String {
    format!("{}/../e8-core/tests/images/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// An Org buffer holding TEXT, `{red}` and `{dot}` standing for the test images' file names.
fn org(text: &str, graphical: bool) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    if graphical {
        ed.set_text_metrics(Arc::new(Graphical));
    }
    ed.set_frame_size(100, 40);
    ed.type_text(&text.replace("{red}", &image("red-blue.png")).replace("{dot}", &image("dot.png")));
    ed.call("org-mode", vec![]).unwrap();
    ed.press("M-<").unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

/// The image overlays, each as the text it covers and its image's :width, ";" between them.
fn shown(ed: &mut Editor, s: &Scripting) -> String {
    eval(
        ed,
        s,
        r#"e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "org-image-overlay")).sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b)).map((o) => {
            const spec = e8.overlayGet(o, "display");
            const i = spec.findIndex((v) => typeof v === "symbol" && v.description === ":width");
            const text = e8.bufferText(e8.overlayStart(o), e8.overlayEnd(o)).replace(/\/[^\][]*\/images\//g, "");
            return text + " " + String(spec[i + 1] ?? "nil");
        }).join(";")"#,
    )
}

/// C-c C-x C-v shows the links to images without a description, and says
/// how many; again, it stops showing them.
#[test]
fn toggling_shows_and_hides_the_images() {
    let (mut ed, s) = org("* Pictures\n[[file:{red}]]\nText [[{dot}]] and [[file:{red}][a description]].\n", true);
    ed.press("C-c C-x C-v").unwrap();
    assert_eq!(ed.echo(), Some("2 images displayed inline"));
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] nil;[[dot.png]] nil");
    ed.redisplay();
    let rows = ed.window_rows(3, true);
    assert!(rows[1].segments.iter().any(|seg| seg.image.is_some()), "{:?}", rows[1]);
    ed.press("C-c C-x C-v").unwrap();
    assert_eq!(ed.echo(), Some("Inline image display turned off"));
    assert_eq!(shown(&mut ed, &s), "");
    // With a prefix argument, the link with a description too.
    ed.press("C-u C-c C-x C-v").unwrap();
    assert_eq!(ed.echo(), Some("3 images displayed inline"));
}

/// Nothing shows on a terminal, or when no link is to an image.
#[test]
fn no_images_on_a_terminal_or_without_links() {
    let (mut ed, s) = org("[[file:{red}]]\n", false);
    ed.press("C-c C-x C-v").unwrap();
    assert_eq!(ed.echo(), Some("No images to display inline"));
    assert_eq!(shown(&mut ed, &s), "");
    let (mut ed, _s) = org("[[file:nowhere.png]] [[file:notes.org]] [[https://example.com/a.png]]\n", true);
    ed.press("C-c C-x C-v").unwrap();
    assert_eq!(ed.echo(), Some("No images to display inline"));
}

/// A link whose description is a plain or angle file link to an image
/// shows that image; links in code, verbatim text and comments do not show.
#[test]
fn descriptions_that_are_image_links_and_where_links_are_not() {
    let (mut ed, s) = org(
        "[[https://example.com][file:{dot}]]\n[[https://example.com][<file:{dot}>]]\n[[https://example.com][see file:{dot}]]\n=[[file:{red}]]=\n# [[file:{red}]]\n#+begin_src text\n[[file:{red}]]\n#+end_src\n",
        true,
    );
    ed.call("org-display-inline-images", vec![]).unwrap();
    let got = shown(&mut ed, &s);
    assert_eq!(got.matches(";").count(), 1, "{got}");
    assert!(got.starts_with("[[https://example.com][file:"), "{got}");
}

/// The overlay covers the blanks after a link that ends its line, and
/// changing its text takes the image away.
#[test]
fn trailing_blanks_are_covered_and_edits_remove_the_image() {
    let (mut ed, s) = org("[[file:{red}]]\n[[file:{dot}]]  text\n", true);
    // Blanks typed before RET would be deleted.
    ed.press("C-e").unwrap();
    ed.type_text("   ");
    ed.press("M-<").unwrap();
    ed.call("org-display-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]]    nil;[[file:dot.png]] nil");
    ed.press("C-f").unwrap();
    ed.type_text("x");
    assert_eq!(shown(&mut ed, &s), "[[file:dot.png]] nil");
}

/// org-image-actual-width: a number of pixels for every image; nil or a
/// list takes a #+ATTR_ORG: or other back-end's :width first, a percentage
/// or a fraction of the text's width, then the list's number.
#[test]
fn widths_from_the_option_and_attributes() {
    let text = "#+ATTR_HTML: :width 50\n#+ATTR_ORG: :width 120\n[[file:{red}]]\n\n#+ATTR_LATEX: :width 0.5\\textwidth\n[[file:{red}]]\n\n#+ATTR_HTML: :width 10%\n[[file:{red}]]\n\n#+ATTR_ORG: :width x :height 4\n#+ATTR_HTML: :width 40\n[[file:{red}]]\n\n[[file:{red}]]\n";
    let (mut ed, s) = org(text, true);
    eval(&mut ed, &s, "e8.setVariable('org-image-actual-width', 64)");
    ed.call("org-display-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), ["[[file:red-blue.png]] 64"; 5].join(";"));
    eval(&mut ed, &s, "e8.setVariable('org-image-actual-width', [300])");
    ed.call("org-redisplay-inline-images", vec![]).unwrap();
    // Half and a tenth of a 100-column window's text, 7 pixels to a column.
    let got = shown(&mut ed, &s);
    let widths: Vec<&str> = got.split(';').map(|o| o.rsplit(' ').next().unwrap()).collect();
    assert_eq!(widths[0], "120");
    assert!(widths[1].parse::<f64>().unwrap() > 300.0, "{got}");
    assert!(widths[2].parse::<f64>().unwrap() < widths[1].parse::<f64>().unwrap(), "{got}");
    assert_eq!(&widths[3..], ["40", "300"]);
    // t, its own width.
    eval(&mut ed, &s, "e8.setVariable('org-image-actual-width', true)");
    ed.call("org-redisplay-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), ["[[file:red-blue.png]] nil"; 5].join(";"));
}

/// An entry's own ORG-IMAGE-ACTUAL-WIDTH property says the width of its
/// images, not inherited, as org-property-or-variable-value reads it.
#[test]
fn the_width_property_of_an_entry() {
    let (mut ed, s) = org("* A\n:PROPERTIES:\n:ORG-IMAGE-ACTUAL-WIDTH: 90\n:END:\n[[file:{red}]]\n** B\n[[file:{red}]]\n", true);
    ed.call("org-display-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] 90;[[file:red-blue.png]] nil");
}

/// Widths are read as string-to-number reads them: a number then text is
/// the number, a quoted one is no width, and a float only with a point.
#[test]
fn widths_read_as_numbers() {
    let (mut ed, s) = org("#+ATTR_LATEX: :width 1\\linewidth\n[[file:{red}]]\n\n#+ATTR_HTML: :width 12em\n[[file:{red}]]\n\n#+ATTR_ORG: :width \"200\"\n[[file:{red}]]\n", true);
    eval(&mut ed, &s, "e8.setVariable('org-image-actual-width', null)");
    ed.call("org-display-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] 1;[[file:red-blue.png]] 12;[[file:red-blue.png]] nil");
}

/// A link in a caption shows, as Org's parser reads a caption's value, and
/// FILE: is file:, as Org searches ignoring case; not one in a title.
#[test]
fn captions_and_link_types_in_any_case() {
    let (mut ed, s) = org("#+TITLE: [[file:{red}]]\n#+CAPTION: [[file:{dot}]]\nx\n[[FILE:{red}]]\n", true);
    ed.call("org-display-inline-images", vec![]).unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:dot.png]] nil;[[FILE:red-blue.png]] nil");
}

/// #+STARTUP: inlineimages shows them when Org mode starts.
#[test]
fn startup_shows_the_images() {
    let (mut ed, s) = org("#+STARTUP: inlineimages\n[[file:{red}]]\n", true);
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] nil");
    let (mut ed, s) = org("#+STARTUP: noinlineimages\n[[file:{red}]]\n", true);
    assert_eq!(shown(&mut ed, &s), "");
    // In any case, and set for the buffer.
    let (mut ed, s) = org("#+STARTUP: InlineImages\n[[file:{red}]]\n", true);
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] nil");
    assert_eq!(eval(&mut ed, &s, "String(e8.localVariableP('org-startup-with-inline-images'))"), "true");
}

/// An image alone in its paragraph is centred or put at the right, as
/// org-image-align or its #+ATTR_ORG: :align says; one among text is not.
#[test]
fn alignment_of_an_image_alone_in_its_paragraph() {
    let (mut ed, s) = org("#+ATTR_ORG: :align right\n[[file:{red}]]\n\n#+ATTR_HTML: :center t\n[[file:{red}]]\n\nSee [[file:{red}]]\n\n[[file:{red}]]\n\n#+ATTR_ORG: :width 100\n#+ATTR_ORG: :align center\n[[file:{red}]]\n", true);
    ed.call("org-display-inline-images", vec![]).unwrap();
    let before = |ed: &mut Editor, s: &Scripting| {
        eval(
            ed,
            s,
            r#"e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "org-image-overlay")).sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b)).map((o) => {
                const b = e8.overlayGet(o, "before-string");
                if (b === undefined || b === null) return "-";
                const spec = b.properties[0][2].display;
                return String(spec[2]);
            }).join(",")"#,
        )
    };
    // Images 32 pixels, 5 columns, wide, in 100 columns less the fringes'.
    let got = before(&mut ed, &s);
    let cols: Vec<&str> = got.split(',').collect();
    // Only a back-end's first line says how to align, as Org takes its car.
    assert_eq!(cols.len(), 5, "{got}");
    assert_eq!(cols[4], "-", "{got}");
    assert!(cols[0].parse::<i64>().unwrap() > 90, "{got}");
    assert!((40..55).contains(&cols[1].parse::<i64>().unwrap()), "{got}");
    assert_eq!(&cols[2..4], ["-", "-"]);
    eval(&mut ed, &s, "e8.setVariable('org-image-align', Symbol.for('center'))");
    ed.call("org-redisplay-inline-images", vec![]).unwrap();
    let got = before(&mut ed, &s);
    let cols: Vec<&str> = got.split(',').collect();
    assert!(cols[0].parse::<i64>().unwrap() > 90, "{got}");
    assert_eq!(cols[2], "-", "{got}");
    assert!((40..55).contains(&cols[3].parse::<i64>().unwrap()), "{got}");
}

/// With org-cycle-inline-images-display, TAB showing a subtree's children
/// shows the images above its first child, showing all of it shows them
/// all, and folding it takes them away.
#[test]
fn cycling_shows_and_hides_a_subtrees_images() {
    let (mut ed, s) = org("* A\n[[file:{red}]]\n** B\n[[file:{dot}]]\n* C\n[[file:{red}]]\n", true);
    eval(&mut ed, &s, "e8.setVariable('org-cycle-inline-images-display', true)");
    ed.press("S-TAB").unwrap();
    ed.press("M-< TAB").unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] nil");
    ed.press("TAB").unwrap();
    assert_eq!(shown(&mut ed, &s), "[[file:red-blue.png]] nil;[[file:dot.png]] nil");
    ed.press("TAB").unwrap();
    assert_eq!(shown(&mut ed, &s), "");
}

