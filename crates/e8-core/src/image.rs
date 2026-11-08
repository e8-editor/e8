//! Images, as Emacs's image.c gives them ([ADR 0046]): image specs,
//! `(image :type png :file "x.png" ...)`, are lists, as in Emacs, and an
//! image cache keeps what each spec loaded, keyed by the spec.
//!
//! The core knows each image's size, because where rows break and how
//! tall they are depend on it: a spec's `:width`, `:height`, `:max-width`,
//! `:max-height`, `:scale` and `:rotation` are worked out as image.c's
//! `compute_image_size` does, on the size read from the file's header. Its
//! pixels are decoded only when a front end asks to draw it
//! ([`Editor::image_rgba`]): PNG, JPEG and GIF with the `image` crate, SVG
//! with `resvg`.
//!
//! Only a frame that can show images shows them, as only Emacs's graphical
//! frames do: the front end's metrics say so ([`TextMetrics::images`]).
//! Elsewhere, as on a text terminal, the text an image's display property
//! is on shows instead.
//!
//! [ADR 0046]: ../../../docs/adr/0046-images.md
//! [`TextMetrics::images`]: crate::layout::TextMetrics::images

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::cell::{OnceCell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::faces::{Color, Style};
use crate::layout::FontSpec;
use crate::rows::{Margin, Row, Segment};
use crate::variables::{Value, Variable};

/// The image types E8 can show, in the order Emacs's `image-types` lists them.
pub const IMAGE_TYPES: &[&str] = &["svg", "png", "gif", "jpeg"];

/// The size Emacs gives an image it could not load and draws as an empty box.
const FAILED_IMAGE_SIZE: f32 = 30.0;

/// The character a row holds for an image, which front ends never draw.
pub const IMAGE_CHAR: char = '\u{FFFC}';

/// How high an image sits on its row's baseline: a percentage of its
/// height above it, or centred on the text's font, as `:ascent` says.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImageAscent {
    Percent(f32),
    Center,
}

/// An image as a row shows it: which image, by the id front ends key their
/// textures on, its size in the metrics' units after scaling and rotation,
/// the margins and relief round it, how it sits on the baseline, and the
/// part of it shown, which is all of it unless a `(slice X Y W H)` spec
/// says otherwise.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageGlyph {
    pub id: u64,
    pub width: f32,
    pub height: f32,
    /// Space either side and above and below, its relief included.
    pub hmargin: f32,
    pub vmargin: f32,
    /// The relief's width, drawn as a raised (positive) or sunken frame.
    pub relief: f32,
    pub ascent: ImageAscent,
    /// The part shown, as x, y, width and height within the image.
    pub slice: [f32; 4],
    /// Whether it could not be loaded, so it shows as an empty box.
    pub failed: bool,
    /// The `:background` its transparent parts are filled with.
    pub background: Option<Color>,
}

impl ImageGlyph {
    /// Whether the slice starts at the image's left or top, and ends at its right or bottom.
    fn edges(&self) -> [bool; 4] {
        let [x, y, w, h] = self.slice;
        [x <= 0.0, y <= 0.0, x + w >= self.width, y + h >= self.height]
    }

    /// How wide the glyph is: the slice, and the margins on the sides where
    /// it meets the image's edge, as `produce_image_glyph` measures it.
    pub fn advance(&self) -> f32 {
        let [left, _, right, _] = self.edges();
        self.slice[2] + if left { self.hmargin } else { 0.0 } + if right { self.hmargin } else { 0.0 }
    }

    /// The glyph's ascent and descent on a row whose text's font has the
    /// given ascent and descent, as Emacs's `image_ascent` and
    /// `produce_image_glyph` work them out, in whole units.
    pub fn ascent_descent(&self, font_ascent: f32, font_descent: f32) -> (f32, f32) {
        let [_, top, _, bottom] = self.edges();
        let slice_height = self.slice[3];
        let height = if slice_height >= self.height {
            self.height + self.vmargin
        } else if top {
            slice_height + self.vmargin
        } else {
            slice_height
        };
        let ascent = match self.ascent {
            ImageAscent::Center => ((height + font_ascent - font_descent + 1.0) / 2.0).floor(),
            ImageAscent::Percent(p) => (height * p / 100.0).floor(),
        };
        let mut descent = slice_height - ascent;
        if top {
            descent += self.vmargin;
        }
        if bottom {
            descent += self.vmargin;
        }
        (ascent, descent.max(0.0))
    }

    /// Where the image's pixels go in the glyph's box: their offset from
    /// its left and top, which are its margins where the slice meets the
    /// image's edge.
    pub fn image_offset(&self) -> (f32, f32) {
        let [left, top, ..] = self.edges();
        (if left { self.hmargin } else { 0.0 }, if top { self.vmargin } else { 0.0 })
    }
}

/// An image's pixels, unpremultiplied RGBA rows, as a front end uploads them.
#[derive(Clone, Debug, PartialEq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// The kinds of image E8 decodes.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Png,
    Jpeg,
    Gif,
    Svg,
}

impl Kind {
    fn of(name: &str) -> Option<Kind> {
        match name {
            "png" => Some(Kind::Png),
            "jpeg" => Some(Kind::Jpeg),
            "gif" => Some(Kind::Gif),
            "svg" => Some(Kind::Svg),
            _ => None,
        }
    }
}

/// Where an image's bytes come from.
#[derive(Clone, Debug)]
enum Source {
    File(PathBuf),
    Data(Arc<[u8]>),
}

impl Source {
    fn bytes(&self) -> Option<Arc<[u8]>> {
        match self {
            Source::File(path) => crate::vfs::read(path).ok().map(Arc::from),
            Source::Data(data) => Some(data.clone()),
        }
    }
}

/// What the cache keeps for a spec: how it shows, and how to decode it.
pub(crate) struct Loaded {
    glyph: ImageGlyph,
    kind: Kind,
    source: Option<Source>,
    /// Quarter turns clockwise.
    quarter_turns: u32,
    flip: bool,
    /// The GIF frame shown, as `:index` says.
    index: usize,
    /// Decoded pixels, by the scale an SVG was drawn at (1 for others).
    pixels: RefCell<HashMap<u32, Option<Arc<Rgba>>>>,
    metadata: OnceCell<Value>,
    mask: bool,
    /// The file it was read from, for `clear-image-cache` to find.
    file: Option<String>,
    /// Whether its size depends on `image-scaling-factor` being `auto`.
    auto: bool,
}

/// One spec's entry in the cache.
struct Entry {
    hash: u64,
    spec: Value,
    image: Rc<Loaded>,
}

/// The images loaded so far, as a frame's image cache in Emacs, with the
/// messages loading them left for the log.
#[derive(Default)]
pub(crate) struct ImageCache {
    entries: Vec<Entry>,
    next_id: u64,
    messages: Vec<String>,
}

/// Defines image.c's variables.
pub(crate) fn define_variables(ed: &mut Editor) {
    let symbols = |names: &[&str]| Value::List(names.iter().map(|n| Value::Symbol(n.to_string())).collect());
    for var in [
        Variable::new(
            "image-types",
            "List of potentially supported image types.\nEach element of the list is a symbol for an image type, like `jpeg' or `png'.\nTo check whether it is really supported, use `image-type-available-p'.",
            symbols(IMAGE_TYPES),
        ),
        Variable::new(
            "max-image-size",
            "Maximum size of images.\nEmacs will not load an image into memory if its pixel width or pixel height exceeds this limit.\n\nIf the value is an integer, it directly specifies the maximum image height and width, measured in pixels. If it is a floating point number, it specifies the maximum image height and width as a ratio to the frame height and width. If the value is non-numeric, there is no explicit limit on the size of images.",
            10.0,
        ),
        Variable::new(
            "image-scaling-factor",
            "When displaying images, apply this scaling factor before displaying.\nThe value is either a floating point number (where numbers higher than 1 means to increase the size and lower means to shrink the size), or the symbol `auto', which will compute a scaling factor based on the font pixel size.",
            Value::Symbol("auto".into()),
        ),
        Variable::new("x-bitmap-file-path", "List of directories to search for window system bitmap files.", Value::List(vec![Value::Str("/usr/include/X11/bitmaps".into())])),
        Variable::new(
            "image-cache-eviction-delay",
            "Maximum time after which images are removed from the cache.\nThe value can also be nil, meaning the cache is never cleared.\n\nThe function `clear-image-cache' disregards this variable.",
            300.0,
        ),
    ] {
        ed.define_variable(var);
    }
}

/// A spec's properties, after the `image` that starts it.
fn spec_props(spec: &Value) -> Option<&[Value]> {
    match spec {
        Value::List(items) if items.first().and_then(Value::as_str) == Some("image") => Some(&items[1..]),
        _ => None,
    }
}

/// The value of a property in an image spec, as Emacs's `image_spec_value`.
fn spec_value<'a>(props: &'a [Value], key: &str) -> Option<&'a Value> {
    props.chunks(2).find(|pair| pair[0].as_str() == Some(key)).and_then(|pair| pair.get(1))
}

/// Whether a value is an image spec, `(image ...)`, as Emacs's `IMAGEP`.
pub(crate) fn is_image(value: &Value) -> bool {
    spec_props(value).is_some()
}

fn is_nil(value: &Value) -> bool {
    matches!(value, Value::Null | Value::Bool(false)) || matches!(value, Value::Symbol(s) if s == "nil") || matches!(value, Value::List(l) if l.is_empty())
}

fn natural(value: &Value) -> Option<f64> {
    value.as_number().filter(|n| *n >= 0.0 && n.fract() == 0.0)
}

/// Whether a value is an image spec E8 can show, as Emacs's
/// `valid_image_p`: a known `:type`, exactly one of `:file` and `:data`, as
/// strings, and the properties every type checks well formed. Properties
/// a type does not know are ignored, as Emacs ignores them.
pub fn valid_image_p(spec: &Value) -> bool {
    let Some(props) = spec_props(spec) else { return false };
    let Some(kind) = spec_value(props, ":type").and_then(Value::as_str).and_then(Kind::of) else { return false };
    if props.len() % 2 != 0 || props.chunks(2).any(|pair| !matches!(pair[0], Value::Symbol(_) | Value::Str(_))) {
        return false;
    }
    let mut seen: Vec<&str> = Vec::new();
    for pair in props.chunks(2) {
        let key = pair[0].as_str().unwrap_or_default();
        let value = &pair[1];
        let ok = match key {
            ":file" | ":data" => matches!(value, Value::Str(_) | Value::Text(_)),
            ":ascent" => value.as_str() == Some("center") || natural(value).is_some_and(|n| n <= 100.0),
            ":margin" => match value {
                Value::List(pair) => pair.len() == 2 && pair.iter().all(|v| natural(v).is_some()),
                other => natural(other).is_some(),
            },
            ":relief" => value.as_number().is_some_and(|n| n.fract() == 0.0),
            ":background" | ":foreground" => is_nil(value) || matches!(value, Value::Str(_) | Value::Text(_)),
            ":index" => kind == Kind::Gif && natural(value).is_some() || kind != Kind::Gif,
            _ => true,
        };
        let known = matches!(key, ":type" | ":file" | ":data" | ":ascent" | ":margin" | ":relief" | ":background" | ":foreground" | ":index" | ":conversion" | ":mask" | ":heuristic-mask");
        if !ok || (known && seen.contains(&key)) {
            return false;
        }
        seen.push(key);
    }
    let file = spec_value(props, ":file").is_some();
    let data = spec_value(props, ":data").is_some();
    file != data
}

/// A display property's image, if it shows one: an image spec, a list of
/// display specs holding one and perhaps a `(slice X Y W H)`, or an image
/// in a margin, `((margin left-margin) IMAGE)`.
pub(crate) struct ImageDisplay<'a> {
    pub image: &'a Value,
    pub slice: Option<&'a [Value]>,
    pub margin: Option<Margin>,
}

pub(crate) fn image_display(value: &Value) -> Option<ImageDisplay<'_>> {
    if is_image(value) {
        return Some(ImageDisplay { image: value, slice: None, margin: None });
    }
    let Value::List(items) = value else { return None };
    let Some(Value::List(first)) = items.first() else { return None };
    if first.first().and_then(Value::as_str) == Some("margin") {
        let side = match first.get(1).and_then(Value::as_str) {
            Some("left-margin") => Margin::Left,
            Some("right-margin") => Margin::Right,
            _ => return None,
        };
        let image = items.get(1).filter(|v| is_image(v))?;
        return Some(ImageDisplay { image, slice: None, margin: Some(side) });
    }
    // A list of display specs, as `insert-image` gives a slice with its image.
    let image = items.iter().find(|v| is_image(v))?;
    let slice = items.iter().find_map(|v| match v {
        Value::List(spec) if spec.first().and_then(Value::as_str) == Some("slice") => Some(&spec[1..]),
        _ => None,
    });
    Some(ImageDisplay { image, slice, margin: None })
}

/// Hashes a spec as Emacs's `sxhash` does, looking at no more than the
/// start and end of long strings, such as an image's `:data`.
fn hash_value(value: &Value, h: &mut impl Hasher) {
    match value {
        Value::Null => 0u8.hash(h),
        Value::Bool(b) => b.hash(h),
        Value::Number(n) => n.to_bits().hash(h),
        Value::Str(s) | Value::Symbol(s) => hash_str(s, h),
        Value::Text(t) => hash_str(&t.string, h),
        Value::List(items) => {
            items.len().hash(h);
            items.iter().for_each(|v| hash_value(v, h));
        }
        _ => 1u8.hash(h),
    }
}

fn hash_str(s: &str, h: &mut impl Hasher) {
    s.len().hash(h);
    if s.len() <= 1024 {
        s.hash(h);
    } else {
        let start = s.char_indices().nth(512).map_or(s.len(), |(i, _)| i);
        let end = s.char_indices().rev().nth(511).map_or(0, |(i, _)| i);
        s[..start].hash(h);
        s[end..].hash(h);
    }
}

fn spec_hash(spec: &Value) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    hash_value(spec, &mut h);
    h.finish()
}

/// A value as Emacs's `princ` prints it, for messages naming a spec.
pub(crate) fn princ(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => "nil".into(),
        Value::Bool(true) => "t".into(),
        Value::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", *n as i64),
        Value::Number(n) => format!("{n}"),
        Value::Str(s) | Value::Symbol(s) => s.clone(),
        Value::Text(t) => t.string.clone(),
        Value::List(items) => format!("({})", items.iter().map(princ).collect::<Vec<_>>().join(" ")),
        other => format!("{other:?}"),
    }
}

/// A `:data` string's bytes: a unibyte string's characters are its bytes,
/// raw bytes their own, and other text stands for its UTF-8.
fn data_bytes(s: &str) -> Vec<u8> {
    let byte = |c: char| if (c as u32) < 0x100 { Some(c as u8) } else { crate::coding::char_raw_byte(c) };
    if s.chars().all(|c| byte(c).is_some()) {
        s.chars().filter_map(byte).collect()
    } else {
        s.as_bytes().to_vec()
    }
}

/// `SIZE * MULTIPLIER / DIVISOR` rounded up, as image.c's `scale_image_size`.
fn scale_size(size: f64, divisor: f64, multiplier: f64) -> f64 {
    if divisor == 0.0 { f64::from(i32::MAX) } else { (size * multiplier / divisor).ceil() }
}

impl Editor {
    /// Whether this frame shows images: the front end's metrics say so, as
    /// a graphical frame does in Emacs.
    pub fn images_shown(&self) -> bool {
        self.metrics.images()
    }

    /// Signals Emacs's error for image functions on a frame without images.
    fn check_window_system(&self) -> Result<()> {
        if self.metrics.images() { Ok(()) } else { Err(Error::new("Window system frame should be used")) }
    }

    /// The image a spec loads, from the cache or loaded now, as Emacs's
    /// `lookup_image`. Images that fail to load are kept too, as empty boxes.
    pub(crate) fn lookup_image(&self, spec: &Value) -> Rc<Loaded> {
        let hash = spec_hash(spec);
        if let Some(entry) = self.images.borrow().entries.iter().find(|e| e.hash == hash && &e.spec == spec) {
            return entry.image.clone();
        }
        let mut cache = self.images.borrow_mut();
        cache.next_id += 1;
        let id = cache.next_id;
        let (image, messages) = self.load_image(spec, id);
        let image = Rc::new(image);
        cache.messages.extend(messages);
        cache.entries.push(Entry { hash, spec: spec.clone(), image: image.clone() });
        image
    }

    /// Reads an image's size from its spec and its file's or data's header,
    /// as image.c's loaders and `image_set_transform` do, with the messages
    /// Emacs logs when that fails.
    fn load_image(&self, spec: &Value, id: u64) -> (Loaded, Vec<String>) {
        let props = spec_props(spec).unwrap_or_default();
        let kind = spec_value(props, ":type").and_then(Value::as_str).and_then(Kind::of).unwrap_or(Kind::Png);
        let index = spec_value(props, ":index").and_then(natural).unwrap_or(0.0) as usize;
        let file = spec_value(props, ":file").and_then(Value::as_str).map(str::to_string);
        let mut messages = Vec::new();
        let source = match (&file, spec_value(props, ":data").and_then(Value::as_str)) {
            (Some(name), _) => self.find_image_file(name).map(Source::File),
            (None, Some(data)) => Some(Source::Data(Arc::from(data_bytes(data)))),
            _ => None,
        };
        let natural_size = source.as_ref().and_then(|s| natural_size(kind, s));
        let mut loaded = Loaded {
            glyph: ImageGlyph {
                id,
                width: FAILED_IMAGE_SIZE,
                height: FAILED_IMAGE_SIZE,
                hmargin: 0.0,
                vmargin: 0.0,
                relief: 0.0,
                ascent: ImageAscent::Percent(50.0),
                slice: [0.0, 0.0, FAILED_IMAGE_SIZE, FAILED_IMAGE_SIZE],
                failed: true,
                background: None,
            },
            kind,
            source: None,
            quarter_turns: 0,
            flip: false,
            index,
            pixels: RefCell::new(HashMap::new()),
            metadata: OnceCell::new(),
            mask: spec_value(props, ":mask").is_some_and(|m| !is_nil(m) && m.as_str() != Some("none")),
            file: file.clone(),
            auto: false,
        };
        let Some((width, height)) = natural_size.filter(|&(w, h)| self.image_size_ok(w, h, &mut messages)) else {
            // As Emacs: a box :width by :height, or 30 by 30 points.
            let fixed = |key: &str| spec_value(props, key).and_then(Value::as_number).filter(|n| n.fract() == 0.0).map(|n| n as f32);
            loaded.glyph.width = fixed(":width").unwrap_or(FAILED_IMAGE_SIZE);
            loaded.glyph.height = fixed(":height").unwrap_or(FAILED_IMAGE_SIZE);
            loaded.glyph.slice = [0.0, 0.0, loaded.glyph.width, loaded.glyph.height];
            if natural_size.is_none() {
                messages.push(match (kind, &file) {
                    (Kind::Svg, Some(name)) if source.is_none() => format!("Cannot find image file \u{2018}{name}\u{2019}"),
                    (Kind::Svg, _) => "Error parsing SVG image".to_string(),
                    _ => format!("Unable to load image {}", princ(spec)),
                });
            }
            return (loaded, messages);
        };
        let (mut w, mut h, auto) = self.compute_image_size(props, width as f64, height as f64);
        loaded.auto = auto;
        // Rotation by quarter turns, as Emacs's native transforms do.
        if let Some(rotation) = spec_value(props, ":rotation") {
            match rotation.as_number() {
                Some(r) => {
                    let r = r.rem_euclid(360.0);
                    if r.fract() == 0.0 && (r as u32).is_multiple_of(90) {
                        loaded.quarter_turns = r as u32 / 90;
                    } else {
                        messages.push(format!("No native support for rotation by {} degrees", princ(&Value::Number(r))));
                    }
                }
                None => messages.push("Invalid image \u{2018}:rotation\u{2019} parameter".to_string()),
            }
        }
        if loaded.quarter_turns % 2 == 1 {
            std::mem::swap(&mut w, &mut h);
        }
        loaded.flip = spec_value(props, ":flip").is_some_and(|f| !is_nil(f));
        let g = &mut loaded.glyph;
        g.width = w as f32;
        g.height = h as f32;
        g.slice = [0.0, 0.0, g.width, g.height];
        g.failed = false;
        match spec_value(props, ":ascent") {
            Some(v) if v.as_str() == Some("center") => g.ascent = ImageAscent::Center,
            Some(v) => g.ascent = ImageAscent::Percent(v.as_number().unwrap_or(50.0) as f32),
            None => {}
        }
        match spec_value(props, ":margin") {
            Some(Value::List(pair)) if pair.len() == 2 => {
                g.hmargin = pair[0].as_number().unwrap_or(0.0) as f32;
                g.vmargin = pair[1].as_number().unwrap_or(0.0) as f32;
            }
            Some(v) => {
                let m = v.as_number().unwrap_or(0.0) as f32;
                (g.hmargin, g.vmargin) = (m, m);
            }
            None => {}
        }
        if let Some(relief) = spec_value(props, ":relief").and_then(Value::as_number) {
            g.relief = relief as f32;
            g.hmargin += g.relief.abs();
            g.vmargin += g.relief.abs();
        }
        g.background = spec_value(props, ":background").and_then(Value::as_str).and_then(|c| Color::parse(c, true));
        loaded.source = source;
        (loaded, messages)
    }

    /// Whether a size is within `max-image-size`, logging Emacs's message if not.
    fn image_size_ok(&self, width: u32, height: u32, messages: &mut Vec<String>) -> bool {
        // Scripts cannot write 10.0 apart from 10, so a number below 100,
        // which would be a uselessly small limit in pixels, is a ratio.
        let limit = match self.variable("max-image-size") {
            Some(Value::Number(n)) if n.fract() == 0.0 && n >= 100.0 => Some((n, n)),
            Some(Value::Number(n)) => {
                let (columns, lines) = (self.frame_cells().0 as f64, self.frame_lines() as f64);
                Some((n * columns * f64::from(self.metrics.char_width()), n * lines * f64::from(self.metrics.char_height())))
            }
            _ => None,
        };
        let ok = limit.is_none_or(|(w, h)| f64::from(width) <= w && f64::from(height) <= h);
        if !ok {
            messages.push("Invalid image size (see \u{2018}max-image-size\u{2019})".to_string());
        }
        ok
    }

    /// Where an image file is: an absolute name as it is; a relative one in
    /// `data-directory`'s `images` or a directory of `x-bitmap-file-path`,
    /// as Emacs's `image_find_image_fd` looks, never the default directory.
    fn find_image_file(&self, name: &str) -> Option<PathBuf> {
        if name.starts_with('/') || name.starts_with('~') {
            let path = crate::files::expand_file_name_in(name, Path::new("/"));
            return crate::vfs::path_is_file(&path).then_some(path);
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(dir) = self.variable("data-directory").as_ref().and_then(Value::as_str) {
            dirs.push(Path::new(dir).join("images"));
        }
        if let Some(Value::List(path)) = self.variable("x-bitmap-file-path") {
            dirs.extend(path.iter().filter_map(Value::as_str).map(PathBuf::from));
        }
        dirs.into_iter().map(|dir| dir.join(name)).find(|p| crate::vfs::path_is_file(p))
    }

    /// The size a spec shows an image of natural size `width` by `height`
    /// at, as image.c's `compute_image_size`, and whether `image-scaling-factor`
    /// being `auto` decided it.
    fn compute_image_size(&self, props: &[Value], width: f64, height: f64) -> (f64, f64, bool) {
        let mut scale = 1.0;
        let mut auto = false;
        match spec_value(props, ":scale") {
            Some(v) if v.as_str() == Some("default") => match self.variable("image-scaling-factor") {
                Some(Value::Number(n)) => scale = n,
                _ => {
                    auto = true;
                    let column = f64::from(self.metrics.char_width());
                    scale = if column > 10.0 { column / 10.0 } else { 1.0 };
                }
            },
            Some(Value::Number(n)) if *n >= 0.0 => scale = *n,
            _ => {}
        }
        let dimension = |key: &str| -> Option<f64> {
            match spec_value(props, key)? {
                Value::Number(n) if *n >= 0.0 && n.fract() == 0.0 => Some(*n),
                Value::List(pair) if pair.len() == 2 => {
                    let n = pair[0].as_number()?;
                    let unit = match pair[1].as_str()? {
                        "em" => f64::from(self.metrics.font_size()),
                        "ch" => f64::from(self.metrics.char_height()),
                        "cw" => f64::from(self.metrics.char_width()),
                        _ => return None,
                    };
                    Some(scale_size(unit, 1.0, n))
                }
                _ => None,
            }
        };
        let (mut want_width, mut want_height) = (dimension(":width"), dimension(":height"));
        let max_width = if want_width.is_none() { dimension(":max-width") } else { None };
        let max_height = if want_height.is_none() { dimension(":max-height") } else { None };
        want_width = want_width.map(|w| scale_size(w, 1.0, scale));
        want_height = want_height.map(|h| scale_size(h, 1.0, scale));
        let (mut w, mut h) = match (want_width, want_height) {
            (Some(w), Some(h)) => return (w, h, auto),
            (Some(w), None) => (w, scale_size(w, width, height)),
            (None, Some(h)) => (scale_size(h, height, width), h),
            (None, None) => (scale_size(width, 1.0, scale), scale_size(height, 1.0, scale)),
        };
        if let Some(max) = max_width.filter(|&m| m < w) {
            w = max;
            h = scale_size(w, width, height);
        }
        if let Some(max) = max_height.filter(|&m| m < h) {
            h = max;
            w = scale_size(h, height, width);
        }
        (w, h, auto)
    }

    /// The glyph a display spec's image shows as, its slice applied.
    pub(crate) fn image_glyph(&self, display: &ImageDisplay) -> ImageGlyph {
        let mut glyph = self.lookup_image(display.image).glyph.clone();
        if let Some(slice) = display.slice {
            let (w, h) = (glyph.width, glyph.height);
            let part = |i: usize, whole: f32, default: f32| match slice.get(i).and_then(Value::as_number) {
                // A float is a fraction of the image; an integer, units.
                Some(n) if n.fract() != 0.0 || (n > 0.0 && n < 1.0) => (n as f32 * whole).floor(),
                Some(n) => n as f32,
                None => default,
            };
            let mut x = part(0, w, 0.0).min(w);
            let mut y = part(1, h, 0.0).min(h);
            let mut sw = part(2, w, w);
            let mut sh = part(3, h, h);
            if x + sw >= w {
                sw = w - x;
            }
            if y + sh > h {
                sh = h - y;
            }
            x = x.max(0.0);
            y = y.max(0.0);
            glyph.slice = [x, y, sw.max(0.0), sh.max(0.0)];
        }
        glyph
    }

    /// The segment an image shows as in a row, standing for the text from
    /// `pos` to `covers`, or at `pos` for a string's, in a style.
    pub(crate) fn image_segment(&self, pos: usize, display: &ImageDisplay, covers: Option<usize>, style: Style) -> Segment {
        let glyph = self.image_glyph(display);
        Segment {
            string: true,
            covers,
            margin: display.margin,
            image: Some(Arc::new(glyph)),
            ..Segment::text(pos, IMAGE_CHAR.to_string(), style)
        }
    }

    /// The default font's ascent and descent for a style, in the metrics' units.
    fn font_ascent_descent(&self, style: &Style) -> (f32, f32) {
        let font = if style.scale == 1.0 && !style.proportional() { FontSpec::default_font() } else { FontSpec::of(style) };
        let height = self.metrics.line_height(&font);
        let ascent = self.metrics.ascent(&font);
        (ascent, height - ascent)
    }

    /// A row's ascent and descent when it shows an image, in the metrics'
    /// units, as Emacs's redisplay makes a row as tall as its tallest
    /// glyph above the baseline and below it, the default face's font
    /// included. `None` for a row without images, which the usual
    /// measures cover.
    pub fn row_ascent_descent(&self, b: &Buffer, row: &Row) -> Option<(f32, f32)> {
        let has_image = |segs: &[Segment]| segs.iter().any(|s| s.image.is_some());
        if !has_image(&row.segments) && !row.margins.iter().any(|m| has_image(m)) {
            return None;
        }
        let default = self.style_for_in(b, &[], true);
        let (mut ascent, mut descent) = self.font_ascent_descent(&default);
        for seg in row.segments.iter().chain(row.margins.iter().flatten()) {
            let (a, d) = match &seg.image {
                Some(image) => {
                    let (fa, fd) = self.font_ascent_descent(&seg.style);
                    image.ascent_descent(fa, fd)
                }
                None if seg.text.is_empty() => continue,
                None => self.font_ascent_descent(&seg.style),
            };
            ascent = ascent.max(a);
            descent = descent.max(d);
        }
        Some((ascent, descent))
    }

    /// How tall a row with an image is, in default lines, or `None` for a row without.
    pub(crate) fn image_row_height(&self, b: &Buffer, row: &Row) -> Option<f32> {
        let (ascent, descent) = self.row_ascent_descent(b, row)?;
        Some((ascent + descent) / self.metrics.char_height())
    }

    /// What a `display` property with an image shows at `pos`: `None` if it
    /// holds no image; `Some(None)` if it does but this frame shows no
    /// images, so the text shows, as on Emacs's terminals; else the image
    /// and where the text it stands for ends.
    pub(crate) fn image_display_at(&self, b: &Buffer, pos: usize, line_end: usize, value: &Value, style: Style) -> Option<Option<(usize, Vec<Segment>)>> {
        let display = image_display(value)?;
        if !self.metrics.images() || !valid_image_p(display.image) {
            return Some(None);
        }
        let mut end = pos;
        while end < line_end && b.char_property(end, "display") == Some(value) {
            end = b.next_char_property_change(end).min(line_end).max(end + 1);
        }
        Some(Some((end, vec![self.image_segment(pos, &display, Some(end), style)])))
    }

    /// The segment a string's character shows as when its `display` is an
    /// image, if this frame shows images.
    pub(crate) fn image_string_segment(&self, pos: usize, value: &Value, covers: Option<usize>, style: impl FnOnce() -> Style) -> Option<Segment> {
        if !self.metrics.images() {
            return None;
        }
        let display = image_display(value).filter(|d| valid_image_p(d.image))?;
        Some(self.image_segment(pos, &display, covers, style()))
    }

    /// Logs the messages loading images left, as Emacs's `image_error` adds them to *Messages*.
    pub(crate) fn flush_image_messages(&mut self) {
        let messages = std::mem::take(&mut self.images.borrow_mut().messages);
        for message in messages {
            self.log_message(&message, false);
        }
    }

    /// An image's pixels, decoded the first time a front end asks, `scale`
    /// times its size for an SVG, which is drawn at the size it shows at.
    /// `None` for an image that could not be loaded, which shows as an
    /// empty box.
    pub fn image_rgba(&self, id: u64, scale: f32) -> Option<Arc<Rgba>> {
        let image = self.images.borrow().entries.iter().find(|e| e.image.glyph.id == id).map(|e| e.image.clone())?;
        if image.glyph.failed {
            return None;
        }
        let key = if image.kind == Kind::Svg { scale.max(1.0).to_bits() } else { 1.0f32.to_bits() };
        if let Some(pixels) = image.pixels.borrow().get(&key) {
            return pixels.clone();
        }
        let decoded = decode(&image, scale).map(Arc::new);
        image.pixels.borrow_mut().insert(key, decoded.clone());
        decoded
    }

    /// `image-size`: an image's size, its margins included, in pixels or in
    /// the frame's columns and lines.
    pub fn image_size(&mut self, spec: &Value, pixels: bool) -> Result<(f64, f64)> {
        if !valid_image_p(spec) {
            return Err(Error::new("Invalid image specification"));
        }
        self.check_window_system()?;
        let g = self.lookup_image(spec).glyph.clone();
        self.flush_image_messages();
        let (w, h) = (f64::from(g.width + 2.0 * g.hmargin), f64::from(g.height + 2.0 * g.vmargin));
        Ok(if pixels { (w, h) } else { (w / f64::from(self.metrics.char_width()), h / f64::from(self.metrics.char_height())) })
    }

    /// `image-mask-p`: whether an image has a mask. As on Emacs's Mac port,
    /// transparency is kept in the image itself, so only a `:mask` makes one.
    pub fn image_mask_p(&mut self, spec: &Value) -> Result<bool> {
        if !valid_image_p(spec) {
            return Err(Error::new("Invalid image specification"));
        }
        self.check_window_system()?;
        let image = self.lookup_image(spec);
        self.flush_image_messages();
        Ok(!image.glyph.failed && image.mask)
    }

    /// `image-metadata`: for a GIF of several frames, `(delay SECONDS count FRAMES)`.
    pub fn image_metadata(&mut self, spec: &Value) -> Result<Value> {
        if !valid_image_p(spec) {
            return Ok(Value::Null);
        }
        self.check_window_system()?;
        let image = self.lookup_image(spec);
        self.flush_image_messages();
        Ok(image.metadata.get_or_init(|| metadata(&image)).clone())
    }

    /// `image-flush`: forgets a spec's image, so it is read again when next shown.
    pub fn image_flush(&mut self, spec: &Value) -> Result<()> {
        if !valid_image_p(spec) {
            return Err(Error::new("Invalid image specification"));
        }
        self.check_window_system()?;
        self.images.borrow_mut().entries.retain(|e| &e.spec != spec);
        Ok(())
    }

    /// `clear-image-cache`: forgets every image, or with a file name (or
    /// `auto`) only those it names, as Emacs's FILTER.
    pub fn clear_image_cache(&mut self, filter: &Value) -> Result<()> {
        self.check_window_system()?;
        let mut cache = self.images.borrow_mut();
        match filter {
            Value::Str(name) => {
                let name = crate::files::expand_file_name(name);
                cache.entries.retain(|e| e.image.file.as_ref().is_none_or(|f| crate::files::expand_file_name(f) != name));
            }
            Value::Symbol(s) if s == "auto" => cache.entries.retain(|e| !e.image.auto),
            _ => cache.entries.clear(),
        }
        Ok(())
    }

    /// `image-transforms-p`: the transforms a frame's images can have.
    pub fn image_transforms(&self) -> Vec<&'static str> {
        if self.metrics.images() { vec!["scale", "rotate90"] } else { Vec::new() }
    }

    /// `image-cache-size`: how many bytes the decoded images take.
    pub fn image_cache_size(&self) -> usize {
        self.images
            .borrow()
            .entries
            .iter()
            .flat_map(|e| e.image.pixels.borrow().values().flatten().map(|p| p.pixels.len()).collect::<Vec<_>>())
            .sum()
    }

    /// `init-image-library`: whether E8 can show images of a type.
    pub fn init_image_library(&self, kind: &str) -> bool {
        Kind::of(kind).is_some()
    }

    /// The row's ascent in the metrics' units, for a front end placing a
    /// row with images on its baseline; `None` for other rows.
    pub fn row_ascent(&self, b: &Buffer, row: &Row) -> Option<f32> {
        self.row_ascent_descent(b, row).map(|(a, _)| a)
    }

    /// How far below the top of a row with images a glyph's box starts:
    /// the row's ascent less the glyph's own.
    pub fn image_top(&self, b: &Buffer, row: &Row, segment: &Segment) -> f32 {
        let row_ascent = self.row_ascent(b, row).unwrap_or(0.0);
        match &segment.image {
            Some(image) => {
                let (fa, fd) = self.font_ascent_descent(&segment.style);
                row_ascent - image.ascent_descent(fa, fd).0
            }
            None => row_ascent - self.font_ascent_descent(&segment.style).0,
        }
    }
}

/// An image's width and height as its header gives them.
fn natural_size(kind: Kind, source: &Source) -> Option<(u32, u32)> {
    match kind {
        Kind::Svg => {
            let tree = svg_tree(&source.bytes()?)?;
            let size = tree.size();
            Some((size.width().ceil() as u32, size.height().ceil() as u32))
        }
        _ => {
            let reader = match source {
                Source::File(path) => image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_dimensions(),
                Source::Data(data) => image::ImageReader::new(std::io::Cursor::new(&data[..])).with_guessed_format().ok()?.into_dimensions(),
            };
            reader.ok().filter(|&(w, h)| w > 0 && h > 0)
        }
    }
}

fn svg_tree(bytes: &[u8]) -> Option<resvg::usvg::Tree> {
    resvg::usvg::Tree::from_data(bytes, &resvg::usvg::Options::default()).ok()
}

/// Decodes an image's pixels, its frame chosen, turned and flipped as its
/// spec says, and its transparency filled with its `:background`.
fn decode(image: &Loaded, scale: f32) -> Option<Rgba> {
    let bytes = image.source.as_ref()?.bytes()?;
    let mut rgba = match image.kind {
        Kind::Svg => {
            let tree = svg_tree(&bytes)?;
            // Drawn at the size it shows at, before turning.
            let (w, h) = if image.quarter_turns % 2 == 1 { (image.glyph.height, image.glyph.width) } else { (image.glyph.width, image.glyph.height) };
            let scale = scale.max(1.0);
            let (pw, ph) = ((w * scale).ceil().max(1.0) as u32, (h * scale).ceil().max(1.0) as u32);
            let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph)?;
            let size = tree.size();
            let transform = resvg::tiny_skia::Transform::from_scale(pw as f32 / size.width(), ph as f32 / size.height());
            resvg::render(&tree, transform, &mut pixmap.as_mut());
            let pixels = pixmap.pixels().iter().flat_map(|p| {
                let c = p.demultiply();
                [c.red(), c.green(), c.blue(), c.alpha()]
            });
            image::RgbaImage::from_raw(pw, ph, pixels.collect())?
        }
        Kind::Gif if image.index > 0 => {
            use image::AnimationDecoder;
            let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(&bytes[..])).ok()?;
            decoder.into_frames().nth(image.index)?.ok()?.into_buffer()
        }
        _ => image::load_from_memory(&bytes).ok()?.to_rgba8(),
    };
    rgba = match image.quarter_turns {
        1 => image::imageops::rotate90(&rgba),
        2 => image::imageops::rotate180(&rgba),
        3 => image::imageops::rotate270(&rgba),
        _ => rgba,
    };
    if image.flip {
        rgba = image::imageops::flip_horizontal(&rgba);
    }
    if let Some(bg) = image.glyph.background {
        for p in rgba.pixels_mut() {
            let a = u32::from(p[3]);
            let mix = |c: u8, b: u8| ((u32::from(c) * a + u32::from(b) * (255 - a)) / 255) as u8;
            *p = image::Rgba([mix(p[0], bg.r), mix(p[1], bg.g), mix(p[2], bg.b), 255]);
        }
    }
    let (width, height) = rgba.dimensions();
    Some(Rgba { width, height, pixels: rgba.into_raw() })
}

/// What `image-metadata` gives for an image: a GIF's frames and the delay
/// of the one shown, as Emacs's Mac port gives them.
fn metadata(image: &Loaded) -> Value {
    if image.kind != Kind::Gif {
        return Value::Null;
    }
    use image::AnimationDecoder;
    let Some(bytes) = image.source.as_ref().and_then(Source::bytes) else { return Value::Null };
    let Ok(decoder) = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(&bytes[..])) else { return Value::Null };
    let delays: Vec<f64> = decoder
        .into_frames()
        .filter_map(|f| f.ok())
        .map(|f| {
            let (num, den) = f.delay().numer_denom_ms();
            f64::from(num) / f64::from(den.max(1)) / 1000.0
        })
        .collect();
    if delays.len() < 2 {
        return Value::Null;
    }
    let delay = delays.get(image.index).copied().unwrap_or(0.0);
    // A frame without a delay waits a fifteenth of a second, as GIF's default.
    let delay = if delay > 0.0 { delay } else { 1.0 / 15.0 };
    Value::List(vec![Value::Symbol("delay".into()), Value::Number(delay), Value::Symbol("count".into()), Value::Number(delays.len() as f64)])
}
