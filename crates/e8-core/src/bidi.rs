//! Bidirectional text, as Emacs's bidi.c reorders it for display
//! ([ADR 0047]): the Unicode Bidirectional Algorithm (UAX#9) with paired
//! brackets and isolates, its explicit controls kept in the text as Emacs
//! keeps them ("X9/Retaining"), on Emacs's own tables of each character's
//! bidi class, mirror and bracket, from `bidi_data.rs`.
//!
//! Emacs resolves levels one character at a time as its display iterator
//! asks; here a line's levels are resolved together, which gives the same
//! levels. As in Emacs, a newline ends the explicit embeddings, a
//! paragraph's direction comes from the first strong character of the
//! paragraph Emacs's `bidi-paragraph-start-re` delimits, and a line is
//! reordered whole before it is broken into screen lines, not each screen
//! line on its own as UAX#9 says.
//!
//! [ADR 0047]: ../../../docs/adr/0047-bidirectional-text.md

use crate::bidi_data::{BIDI_CLASS, BRACKETS, CLASS_NAMES, MIRRORED, MIRRORING};

/// A character's bidirectional class, Emacs's `bidi-class` property.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidiClass {
    L,
    R,
    AL,
    EN,
    ES,
    ET,
    AN,
    CS,
    NSM,
    BN,
    B,
    S,
    WS,
    ON,
    LRE,
    LRO,
    RLE,
    RLO,
    PDF,
    LRI,
    RLI,
    FSI,
    PDI,
}

use BidiClass::*;

/// The classes in the order the generated table numbers them.
const CLASSES: [BidiClass; 23] = [L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON, LRE, LRO, RLE, RLO, PDF, LRI, RLI, FSI, PDI];

impl BidiClass {
    /// Its name, as `get-char-code-property` gives it.
    pub fn name(self) -> &'static str {
        CLASS_NAMES[self as usize]
    }

    fn isolate(self) -> bool {
        matches!(self, LRI | RLI | FSI | PDI)
    }

    fn initiator(self) -> bool {
        matches!(self, LRI | RLI | FSI)
    }

    fn explicit(self) -> bool {
        matches!(self, LRE | LRO | RLE | RLO | PDF)
    }

    fn neutral(self) -> bool {
        matches!(self, B | S | WS | ON) || self.isolate()
    }
}

/// The bidi class of a character.
pub fn bidi_class(c: char) -> BidiClass {
    let u = c as u32;
    let i = BIDI_CLASS.partition_point(|&(from, _, _)| from <= u) - 1;
    CLASSES[BIDI_CLASS[i].2 as usize]
}

/// The character shown for `c` where it is right to left, Emacs's
/// `mirroring` property.
pub fn mirror(c: char) -> Option<char> {
    let u = c as u32;
    MIRRORING.binary_search_by_key(&u, |&(from, _)| from).ok().and_then(|i| char::from_u32(MIRRORING[i].1))
}

/// A bracket's pair and whether it opens, Emacs's `paired-bracket` and
/// `bracket-type` properties.
pub fn paired_bracket(c: char) -> Option<(char, bool)> {
    let u = c as u32;
    let i = BRACKETS.binary_search_by_key(&u, |&(from, _, _)| from).ok()?;
    Some((char::from_u32(BRACKETS[i].1)?, BRACKETS[i].2))
}

/// Whether a character's `mirrored` property is Y.
pub fn mirrored(c: char) -> bool {
    let u = c as u32;
    let i = MIRRORED.partition_point(|&(from, _)| from <= u);
    i > 0 && u <= MIRRORED[i - 1].1
}

/// What every character with no run of its own has, and the runs of those
/// that have one, of a Unicode property.
pub type PropertyRuns = (crate::variables::Value, Vec<(u32, u32, crate::variables::Value)>);

/// A Unicode property's values, for the char-table
/// `unicode-property-table-internal` hands out, or `None` for a property
/// E8 holds no data for. `mirrored` and `bracket-type` cover every
/// character, as Emacs's tables do; the others leave out what has no
/// value, which is nil.
pub fn property_runs(property: &str) -> Option<PropertyRuns> {
    use crate::variables::Value;
    let str = |s: &str| Value::Str(s.to_string());
    let one = |c: u32, v: Value| (c, c, v);
    Some(match property {
        "bidi-class" => (Value::Null, BIDI_CLASS.iter().map(|&(from, to, class)| (from, to, str(CLASS_NAMES[class as usize]))).collect()),
        "mirroring" => (Value::Null, MIRRORING.iter().map(|&(from, to)| one(from, Value::Number(to as f64))).collect()),
        "mirrored" => (str("N"), MIRRORED.iter().map(|&(from, to)| (from, to, str("Y"))).collect()),
        "paired-bracket" => (Value::Null, BRACKETS.iter().map(|&(from, pair, _)| one(from, Value::Number(pair as f64))).collect()),
        "bracket-type" => (str("n"), BRACKETS.iter().map(|&(from, _, opens)| one(from, str(if opens { "o" } else { "c" }))).collect()),
        _ => return None,
    })
}

/// Whether text may need reordering in a left-to-right paragraph: whether
/// it has a right-to-left character, an Arabic digit, or a directional
/// control. Text without any of them, which is all text below U+0590,
/// shows in the order it is in.
pub fn needs_reordering(text: &str) -> bool {
    // UTF-8 for U+0590 and above starts with a byte from 0xD6. Looking for
    // one 64 bytes at a time lets the compiler use vector instructions.
    let high = text.as_bytes().chunks(64).any(|c| c.iter().fold(0u8, |m, &b| m.max(b)) >= 0xD6);
    high && text.chars().any(reorders)
}

/// Whether a character is right to left, an Arabic number or a control.
pub fn reorders(c: char) -> bool {
    let u = c as u32;
    if u < 0x590 || (0x900..0x200E).contains(&u) || (0x2070..0xFB1D).contains(&u) {
        return false;
    }
    matches!(bidi_class(c), R | AL | AN | LRE | LRO | RLE | RLO | PDF | LRI | RLI | FSI | PDI)
}

/// A paragraph's direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    LeftToRight,
    RightToLeft,
}

impl Direction {
    /// Its name, as `current-bidi-paragraph-direction` gives it.
    pub fn name(self) -> &'static str {
        match self {
            Direction::LeftToRight => "left-to-right",
            Direction::RightToLeft => "right-to-left",
        }
    }

    /// The paragraph's embedding level.
    pub fn level(self) -> u8 {
        match self {
            Direction::LeftToRight => 0,
            Direction::RightToLeft => 1,
        }
    }
}

/// The direction the first strong character gives text, as rules P2 and
/// P3 find it: skipping what isolates enclose, and stopping at a PDI that
/// closes an isolate the text is inside of when `in_isolate`. `None` if
/// there is no strong character.
pub fn first_strong(chars: impl IntoIterator<Item = char>, in_isolate: bool) -> Option<Direction> {
    let mut depth = 0usize;
    for c in chars {
        match bidi_class(c) {
            LRI | RLI | FSI => depth += 1,
            PDI if depth > 0 => depth -= 1,
            PDI if in_isolate => return None,
            L if depth == 0 => return Some(Direction::LeftToRight),
            R | AL if depth == 0 => return Some(Direction::RightToLeft),
            _ => {}
        }
    }
    None
}

/// The levels UAX#9 resolves for a line of characters, and their types
/// after resolving, which say which are mirrored: those whose type is R,
/// as Emacs mirrors them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub levels: Vec<u8>,
    pub types: Vec<BidiClass>,
}

/// The deepest embedding level, as in UAX#9 and bidi.c.
const MAX_DEPTH: u8 = 125;

/// Resolves the levels of a line of characters in a paragraph at `base`
/// level, 0 or 1, with paired brackets resolved unless `bpa` is false, as
/// Emacs's `bidi-inhibit-bpa` turns them off. Text a display property
/// covers comes as U+FFFC, and a `(space ...)` spec as U+2029, as bidi.c
/// sees them. A paragraph separator in the line ends its embeddings.
pub fn resolve(chars: &[char], base: u8, bpa: bool) -> Resolved {
    let classes: Vec<BidiClass> = chars.iter().map(|&c| bidi_class(c)).collect();
    let mut out = Resolved { levels: vec![base; chars.len()], types: classes.clone() };
    let mut start = 0;
    for i in 0..=chars.len() {
        if i == chars.len() || classes[i] == B {
            if i > start {
                Paragraph::new(chars, &classes, base, bpa, &mut out).resolve(start, i);
            }
            if i < chars.len() {
                out.levels[i] = base;
            }
            start = i + 1;
        }
    }
    // L1: separators and segment separators, and the whitespace and
    // isolates before them or the line's end, go back to the paragraph's
    // level. As in bidi.c, an embedding control among them goes back only
    // when what follows was looked for from a character before it, which
    // whitespace, isolates and BNs inside an embedding do.
    let mut next_for_ws: Option<(usize, BidiClass)> = None;
    for j in 0..chars.len() {
        let class = classes[j];
        let looks = class == WS || class.isolate() || (class == BN && out.levels[j] != base);
        if looks && next_for_ws.is_none_or(|(p, _)| p < j) {
            let mut k = j + 1;
            while k < chars.len() && matches!(classes[k], WS | BN) || k < chars.len() && (classes[k].isolate() || classes[k].explicit()) {
                k += 1;
            }
            next_for_ws = Some((k, if k < chars.len() { classes[k] } else { B }));
        }
        let before_separator = next_for_ws.is_some_and(|(_, t)| matches!(t, B | S));
        if matches!(class, B | S) || (matches!(class, WS | BN) || class.isolate() || class.explicit()) && before_separator {
            out.levels[j] = base;
        }
    }
    out
}

/// One paragraph's worth of a line, between separators, being resolved.
struct Paragraph<'a> {
    chars: &'a [char],
    classes: &'a [BidiClass],
    base: u8,
    bpa: bool,
    out: &'a mut Resolved,
    /// Which characters a directional override made L or R.
    overridden: Vec<bool>,
    /// The embedding level at the paragraph's end, before its separator.
    end_level: u8,
    /// The levels X1 to X8 give, which the rules after them start from.
    explicit: Vec<u8>,
    /// Each isolate initiator with its matching PDI.
    isolates: Vec<(usize, usize)>,
}

/// An entry of the directional status stack (X1).
#[derive(Clone, Copy)]
struct Status {
    level: u8,
    over: Option<BidiClass>,
    isolate: bool,
}

impl<'a> Paragraph<'a> {
    fn new(chars: &'a [char], classes: &'a [BidiClass], base: u8, bpa: bool, out: &'a mut Resolved) -> Paragraph<'a> {
        let n = chars.len();
        Paragraph { chars, classes, base, bpa, out, overridden: vec![false; n], end_level: base, explicit: Vec::new(), isolates: Vec::new() }
    }

    fn resolve(&mut self, from: usize, to: usize) {
        let matching = self.match_isolates(from, to);
        self.isolates = matching.iter().enumerate().filter_map(|(k, m)| m.map(|p| (from + k, p))).collect();
        self.explicit(from, to, &matching);
        for seq in self.sequences(from, to, &matching) {
            self.resolve_sequence(&seq, from, to);
        }
    }

    /// Each isolate initiator's matching PDI, as BD9 matches them.
    fn match_isolates(&self, from: usize, to: usize) -> Vec<Option<usize>> {
        let mut matching = vec![None; to - from];
        let mut open = Vec::new();
        for i in from..to {
            match self.classes[i] {
                LRI | RLI | FSI => open.push(i),
                PDI => {
                    if let Some(o) = open.pop() {
                        matching[o - from] = Some(i);
                    }
                }
                _ => {}
            }
        }
        matching
    }

    /// Rules X1 to X8: the explicit levels and overrides, the controls
    /// kept with the levels Emacs gives them: an embedding or override
    /// initiator and its PDF the level inside, an isolate initiator and its
    /// PDI the level outside.
    fn explicit(&mut self, from: usize, to: usize, matching: &[Option<usize>]) {
        let mut stack = vec![Status { level: self.base, over: None, isolate: false }];
        let (mut overflow_isolates, mut overflow_embeddings, mut valid_isolates) = (0usize, 0usize, 0usize);
        for i in from..to {
            let top = *stack.last().expect("the stack has its base");
            let class = self.classes[i];
            let overridden = |s: &Status, t: BidiClass| s.over.unwrap_or(t);
            self.overridden[i] = top.over.is_some();
            match class {
                RLE | LRE | RLO | LRO => {
                    let rtl = matches!(class, RLE | RLO);
                    let level = if rtl { (top.level + 1) | 1 } else { (top.level + 2) & !1 };
                    if level <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                        let over = match class {
                            RLO => Some(R),
                            LRO => Some(L),
                            _ => None,
                        };
                        stack.push(Status { level, over, isolate: false });
                    } else if overflow_isolates == 0 {
                        overflow_embeddings += 1;
                    }
                    let now = stack.last().expect("pushed or not");
                    self.out.levels[i] = now.level;
                    self.out.types[i] = overridden(now, BN);
                    self.overridden[i] = now.over.is_some();
                }
                PDF => {
                    self.out.levels[i] = top.level;
                    self.out.types[i] = overridden(&top, BN);
                    if overflow_isolates > 0 {
                    } else if overflow_embeddings > 0 {
                        overflow_embeddings -= 1;
                    } else if !top.isolate && stack.len() >= 2 {
                        stack.pop();
                    }
                }
                RLI | LRI | FSI => {
                    let rtl = match class {
                        RLI => true,
                        LRI => false,
                        _ => {
                            let end = matching[i - from].unwrap_or(to);
                            first_strong(self.chars[i + 1..end].iter().copied(), false) == Some(Direction::RightToLeft)
                        }
                    };
                    self.out.levels[i] = top.level;
                    self.out.types[i] = overridden(&top, if rtl { RLI } else { LRI });
                    let level = if rtl { (top.level + 1) | 1 } else { (top.level + 2) & !1 };
                    if level <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                        valid_isolates += 1;
                        stack.push(Status { level, over: None, isolate: true });
                    } else {
                        overflow_isolates += 1;
                    }
                }
                PDI => {
                    if overflow_isolates > 0 {
                        overflow_isolates -= 1;
                    } else if valid_isolates > 0 {
                        overflow_embeddings = 0;
                        while stack.last().is_some_and(|s| !s.isolate) {
                            stack.pop();
                        }
                        stack.pop();
                        valid_isolates -= 1;
                    }
                    let now = *stack.last().expect("the base stays");
                    self.out.levels[i] = now.level;
                    self.out.types[i] = overridden(&now, PDI);
                    self.overridden[i] = now.over.is_some();
                }
                _ => {
                    self.out.levels[i] = top.level;
                    self.out.types[i] = overridden(&top, class);
                }
            }
        }
        self.end_level = stack.last().expect("the base stays").level;
        self.explicit = self.out.levels.clone();
    }

    /// The isolating run sequences (BD13): runs of one level, those an
    /// isolate splits joined again.
    fn sequences(&self, from: usize, to: usize, matching: &[Option<usize>]) -> Vec<Vec<usize>> {
        let levels = &self.out.levels;
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut start = from;
        for i in from + 1..=to {
            if i == to || levels[i] != levels[start] {
                runs.push((start, i));
                start = i;
            }
        }
        let run_starting = |i: usize| runs.iter().position(|r| r.0 == i);
        let matched_pdi: Vec<bool> = {
            let mut m = vec![false; to - from];
            for p in matching.iter().flatten() {
                m[p - from] = true;
            }
            m
        };
        let mut seqs = Vec::new();
        for &(s, e) in &runs {
            if self.classes[s] == PDI && matched_pdi[s - from] {
                continue;
            }
            let mut seq: Vec<usize> = (s..e).collect();
            let mut last = e - 1;
            while self.classes[last].initiator()
                && let Some(pdi) = matching[last - from]
                && let Some(r) = run_starting(pdi)
            {
                let (rs, re) = runs[r];
                seq.extend(rs..re);
                last = re - 1;
            }
            seqs.push(seq);
        }
        seqs
    }

    /// A sequence's level and its sos and eos (X10).
    fn bounds(&self, seq: &[usize], from: usize, to: usize) -> (u8, BidiClass, BidiClass) {
        let level = self.explicit[seq[0]];
        let first = seq[0];
        let last = *seq.last().expect("not empty");
        let before = if first > from { self.explicit[first - 1] } else { self.base };
        // After an isolate left open, bidi.c's eos is the level the
        // paragraph ends at, inside the isolate.
        // Inside an isolate, where its PDI ends the sequence, bidi.c takes
        // the direction the isolate's initiator resolved to.
        if let Some(&(initiator, _)) = self.isolates.iter().find(|&&(_, pdi)| pdi == last + 1)
            && matches!(self.out.types[initiator], L | R)
        {
            return (level, direction_of(level.max(before)), self.out.types[initiator]);
        }
        let after = if self.classes[last].initiator() {
            self.end_level.max(self.base)
        } else if last + 1 >= to {
            self.base
        } else {
            self.explicit[last + 1]
        };
        (level, direction_of(level.max(before)), direction_of(level.max(after)))
    }

    /// Rules W1 to I2 on one isolating run sequence.
    fn resolve_sequence(&mut self, seq: &[usize], from: usize, to: usize) {
        let (level, sos, eos) = self.bounds(seq, from, to);
        let dir = direction_of;
        self.weak(seq, to, level, sos);
        let embedding = dir(level);
        if self.bpa {
            self.brackets(seq, sos, embedding);
        }
        let types = &mut self.out.types;

        // N1 and N2: neutrals take the direction around them, or the
        // embedding's. BNs count as neutrals, as bidi.c resolves them,
        // except BNs alone at the end of the sequence, which keep theirs.
        let strong_of = |t: BidiClass| match t {
            L => Some(L),
            R | EN | AN => Some(R),
            _ => None,
        };
        let marks: Vec<bool> = seq.iter().map(|&i| types[i].neutral() || types[i] == BN).collect();
        let mut k = 0;
        while k < seq.len() {
            if !marks[k] {
                k += 1;
                continue;
            }
            let start = k;
            while k < seq.len() && marks[k] {
                k += 1;
            }
            if k == seq.len() && seq[start..].iter().all(|&i| types[i] == BN) {
                continue;
            }
            let prev = seq[..start].iter().rev().map(|&j| types[j]).find(|&t| t != BN).and_then(strong_of).unwrap_or(sos);
            let next = seq[k..].iter().map(|&j| types[j]).find(|&t| t != BN).and_then(strong_of).unwrap_or(eos);
            let resolved = if prev == next { prev } else { embedding };
            for &i in &seq[start..k] {
                types[i] = resolved;
            }
        }

        // I1 and I2: the implicit levels.
        for &i in seq {
            let l = &mut self.out.levels[i];
            match (*l % 2, types[i]) {
                (0, R) => *l += 1,
                (0, AN | EN) => *l += 2,
                (1, L | EN | AN) => *l += 1,
                _ => {}
            }
        }
    }

    /// Rules W1 to W7, as bidi.c's `bidi_resolve_weak` applies them one
    /// character at a time: the character before is the last one not BN in
    /// the level run, a separator looks at the very next character, and a
    /// terminator at what the last search forward found, as bidi.c caches it.
    fn weak(&mut self, seq: &[usize], to: usize, level: u8, sos: BidiClass) {
        let classes = self.classes;
        // The type a character has after X9, before any override.
        let xtype = |j: usize| if classes[j].explicit() { BN } else { classes[j] };
        let mut prev: Option<(BidiClass, BidiClass)> = None;
        let mut last_strong: Option<BidiClass> = None;
        let (mut next_en_pos, mut next_en_type): (isize, Option<BidiClass>) = (0, None);
        let mut run_level = level;
        for (k, &i) in seq.iter().enumerate() {
            let here = self.explicit[i];
            if k > 0 && (here != run_level || seq[k - 1] + 1 != i) {
                // A new level run of the sequence, after an isolate.
                prev = None;
            }
            run_level = here;
            if next_en_pos >= 0 && i as isize >= next_en_pos {
                next_en_pos = 0;
                next_en_type = None;
            }
            let orig = classes[i];
            let mut t = self.out.types[i];
            let mut after_wn = None;
            if matches!(t, S | WS | BN | AL) {
                after_wn = Some(t);
            }
            if !self.overridden[i] {
                if t == NSM {
                    t = match prev {
                        None | Some((B, _)) => sos,
                        Some((p, _)) if p.isolate() => ON,
                        Some((p, _)) => p,
                    };
                }
                // What follows, as bidi.c looks at it: its own class.
                let next_type = || if i + 1 < to { classes[i + 1] } else { B };
                if t == EN && last_strong == Some(AL) {
                    t = AN;
                } else if t == AL {
                    t = R;
                } else if (t == ES && prev == Some((EN, EN))) || (t == CS && (prev == Some((EN, EN)) || prev.is_some_and(|p| p.0 == AN))) {
                    let next = next_type();
                    if t == ES && next == EN && last_strong != Some(AL) {
                        t = EN;
                    } else if t == CS {
                        if prev.is_some_and(|p| p.0 == AN) && (next == AN || (next == EN && last_strong == Some(AL))) {
                            t = AN;
                        } else if prev.is_some_and(|p| p.0 == EN) && next == EN && last_strong != Some(AL) {
                            t = EN;
                        }
                    }
                } else if t == ET || t == BN {
                    if prev.is_some_and(|p| p.0 == EN) {
                        t = EN;
                    } else if next_en_pos > i as isize && next_en_type != Some(BN) {
                        if next_en_type == Some(EN) {
                            t = EN;
                        }
                    } else if t == BN && here == 0 && !orig.explicit() && (last_strong == Some(L) || (last_strong.is_none() && sos == L)) {
                        t = L;
                    } else if next_en_pos >= 0 {
                        let mut en_pos = i + 1;
                        let mut type_of_next = next_type();
                        if i + 1 < to && (type_of_next == ET || type_of_next == BN || classes[i + 1].explicit()) {
                            let mut j = i + 1;
                            while j < to && self.explicit[j] == here && matches!(xtype(j), BN | ET) {
                                type_of_next = xtype(j);
                                j += 1;
                            }
                            if t == BN && j == i + 1 {
                                en_pos = i;
                                type_of_next = t;
                            } else {
                                en_pos = j;
                            }
                        }
                        next_en_pos = en_pos as isize;
                        if type_of_next == EN {
                            if last_strong == Some(AL) {
                                type_of_next = AN;
                            } else if t == BN {
                                t = ON;
                            } else {
                                t = EN;
                            }
                        } else if type_of_next == B {
                            next_en_pos = -1;
                        }
                        next_en_type = Some(type_of_next);
                    }
                }
                if matches!(t, ES | ET | CS) || (t == BN && prev.is_some_and(|p| matches!(p.0, CS | ES | ET))) {
                    t = ON;
                }
            }
            let after_wn = after_wn.unwrap_or(t);
            if !self.overridden[i] && t == EN && (last_strong == Some(L) || (last_strong.is_none() && sos == L)) {
                t = L;
            }
            self.out.types[i] = t;
            if after_wn != BN && t != BN {
                prev = Some((after_wn, orig));
            }
            if matches!(after_wn, L | R | AL) {
                last_strong = Some(after_wn);
            }
        }
    }

    /// Rule N0: paired brackets take the direction of what they enclose,
    /// or of what comes before them.
    fn brackets(&mut self, seq: &[usize], sos: BidiClass, embedding: BidiClass) {
        let types = &mut self.out.types;
        let canonical = |c: char| match c {
            '\u{2329}' => '\u{3008}',
            '\u{232A}' => '\u{3009}',
            c => c,
        };
        // BD16: the pairs, by the opening bracket's place in the sequence.
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        let mut stack: Vec<(char, usize)> = Vec::new();
        for (k, &i) in seq.iter().enumerate() {
            if types[i] != ON {
                continue;
            }
            let c = canonical(self.chars[i]);
            match paired_bracket(c) {
                Some((pair, true)) => {
                    if stack.len() >= 63 {
                        break;
                    }
                    stack.push((canonical(pair), k));
                }
                Some((_, false)) => {
                    if let Some(at) = stack.iter().rposition(|&(close, _)| close == c) {
                        pairs.push((stack[at].1, k));
                        stack.truncate(at);
                    }
                }
                None => {}
            }
        }
        pairs.sort_unstable();
        let strong_of = |t: BidiClass| match t {
            L => Some(L),
            R | EN | AN => Some(R),
            _ => None,
        };
        for (open, close) in pairs {
            let inside: Vec<BidiClass> = seq[open + 1..close].iter().filter_map(|&i| strong_of(types[i])).collect();
            let resolved = if inside.contains(&embedding) {
                Some(embedding)
            } else if let Some(&opposite) = inside.first() {
                let before = seq[..open].iter().rev().find_map(|&i| strong_of(types[i])).unwrap_or(sos);
                Some(if before == opposite { opposite } else { embedding })
            } else {
                None
            };
            if let Some(t) = resolved {
                for at in [open, close] {
                    types[seq[at]] = t;
                    // Marks after a bracket take its new type.
                    for &i in &seq[at + 1..] {
                        if self.classes[i] == NSM {
                            types[i] = t;
                        } else if types[i] != BN {
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// L for an even level, R for an odd one.
fn direction_of(level: u8) -> BidiClass {
    if level % 2 == 1 { R } else { L }
}

/// The first of a line's characters whose direction an override,
/// embedding or isolate changed in a way that could mislead, in a
/// paragraph at `base` level, as bidi.c's `bidi_find_first_overridden`
/// looks for them: strong characters overridden to the other direction,
/// and characters raised above the levels their type would have.
pub fn first_overridden(chars: &[char], base: u8) -> Option<usize> {
    let classes: Vec<BidiClass> = chars.iter().map(|&c| bidi_class(c)).collect();
    let mut out = Resolved { levels: vec![base; chars.len()], types: classes.clone() };
    let mut p = Paragraph::new(chars, &classes, base, true, &mut out);
    let (from, to) = (0, chars.iter().position(|&c| bidi_class(c) == B).unwrap_or(chars.len()));
    if to == 0 {
        return None;
    }
    let matching = p.match_isolates(from, to);
    p.isolates = matching.iter().enumerate().filter_map(|(k, m)| m.map(|q| (from + k, q))).collect();
    p.explicit(from, to, &matching);
    for seq in p.sequences(from, to, &matching) {
        let (level, sos, _) = p.bounds(&seq, from, to);
        p.weak(&seq, to, level, sos);
    }
    let (max_l2r, max_r2l, max_weak) = if base == 0 { (0, 1, 1) } else { (2, 1, 2) };
    (from..to).find(|&i| {
        let (t, orig, level) = (p.out.types[i], classes[i], p.explicit[i]);
        (t == R && orig == L)
            || (t == L && matches!(orig, R | AL))
            || (matches!(orig, L | EN) && level > max_l2r)
            || (matches!(orig, R | AL) && level > max_r2l)
            || (matches!(orig, EN | ES | ET | AN | CS | NSM | BN | ON) && level > max_weak)
    })
}

/// The visual order of a line's characters, left to right, by rule L2:
/// from the highest level to the lowest odd one, each run at that level
/// or higher reversed. Index `k` of the result is the logical index of
/// the `k`th character from the left.
pub fn visual_order(levels: &[u8]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..levels.len()).collect();
    let Some(&max) = levels.iter().max() else { return order };
    let Some(min_odd) = levels.iter().copied().filter(|l| l % 2 == 1).min() else { return order };
    for level in (min_odd..=max).rev() {
        let mut k = 0;
        while k < order.len() {
            if levels[order[k]] < level {
                k += 1;
                continue;
            }
            let start = k;
            while k < order.len() && levels[order[k]] >= level {
                k += 1;
            }
            order[start..k].reverse();
        }
    }
    order
}

/// Text reordered for display in a paragraph of a direction, as a
/// string's characters show left to right, mirrored where right to left.
pub fn reorder_string(text: &str, direction: Direction, bpa: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let resolved = resolve(&chars, direction.level(), bpa);
    visual_order(&resolved.levels)
        .into_iter()
        .map(|i| if resolved.types[i] == R { mirror(chars[i]).unwrap_or(chars[i]) } else { chars[i] })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(text: &str, base: u8) -> Vec<u8> {
        resolve(&text.chars().collect::<Vec<_>>(), base, true).levels
    }

    #[test]
    fn classes_mirrors_and_brackets_are_emacs_s() {
        assert_eq!(bidi_class('a'), L);
        assert_eq!(bidi_class('א'), R);
        assert_eq!(bidi_class('ع'), AL);
        assert_eq!(bidi_class('1'), EN);
        assert_eq!(bidi_class('\u{663}'), AN);
        assert_eq!(bidi_class('\n'), B);
        assert_eq!(bidi_class('\t'), S);
        assert_eq!(bidi_class('\u{2067}'), RLI);
        assert_eq!(mirror('('), Some(')'));
        assert_eq!(mirror('«'), Some('»'));
        assert_eq!(mirror('a'), None);
        assert_eq!(paired_bracket('['), Some((']', true)));
        assert_eq!(paired_bracket('}'), Some(('{', false)));
        assert!(mirrored('<') && !mirrored('a'));
    }

    #[test]
    fn the_quick_check_finds_every_character_that_reorders() {
        for &(from, to, class) in BIDI_CLASS {
            if matches!(CLASSES[class as usize], R | AL | AN | LRE | LRO | RLE | RLO | PDF | LRI | RLI | FSI | PDI) {
                for u in from..=to {
                    if let Some(c) = char::from_u32(u) {
                        assert!(reorders(c), "U+{u:04X}");
                    }
                }
            }
        }
    }

    #[test]
    fn levels_as_emacs_resolves_them() {
        // From bidi-resolved-levels in Emacs 30.2.
        assert_eq!(levels("hello שלום עולם world", 0), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(levels("שלום world עולם", 1), [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
    }

    #[test]
    fn lines_reorder_and_mirror() {
        assert_eq!(reorder_string("abc אבג def", Direction::LeftToRight, true), "abc גבא def");
        assert_eq!(reorder_string("שלום (abc) עולם", Direction::RightToLeft, true), "םלוע (abc) םולש");
        assert_eq!(reorder_string("א<ב>ג", Direction::RightToLeft, true), "ג<ב>א");
    }
}
