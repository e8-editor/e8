//! Time as Emacs's timefns.c has it (ADR 0099): decoding a time into its
//! calendar fields in a zone, encoding fields back, and formatting a time
//! as `format-time-string` does. Zones are read the way the C library
//! reads them, from the system's TZif files and POSIX TZ rules, but here,
//! so no environment variable changes under other threads, and the editor
//! can have a zone of its own, as `set-time-zone-rule` gives it.
//!
//! Times are seconds since the epoch, as E8's times are numbers.

use crate::vfs as fs;

/// Where a zone's offset from UTC changes, and what it is from then on.
#[derive(Clone, Debug, PartialEq)]
struct Kind {
    offset: i64,
    dst: bool,
    abbr: String,
}

/// A POSIX TZ rule's day of change.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Day {
    /// `Jn`: day 1 to 365, February 29th never counted.
    Julian(u32),
    /// `n`: day 0 to 365, February 29th counted in leap years.
    Zero(u32),
    /// `Mm.w.d`: day `d` (0 is Sunday) of week `w` (5 the last) of month `m`.
    Month(u32, u32, u32),
}

/// A POSIX TZ string's rule: standard time, and daylight saving time with
/// when it starts and ends, each at seconds into the local day.
#[derive(Clone, Debug, PartialEq)]
struct Posix {
    std: Kind,
    dst: Option<(Kind, Change, Change)>,
}

/// When a POSIX rule changes: a day, and seconds into it in local time.
type Change = (Day, i64);

/// A time zone, as a ZONE argument names one.
#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    /// Changes from the TZif file, each with its time.
    transitions: Vec<(i64, Kind)>,
    /// The kind before the first change.
    first: Option<Kind>,
    /// The rule after the last change, or for all time.
    rule: Option<Posix>,
}

impl Zone {
    /// UTC itself.
    pub fn utc() -> Zone {
        Zone::fixed(0, Some("UTC".into()))
    }

    /// A fixed offset east of UTC in seconds, with an abbreviation, or one
    /// made of the offset as Emacs makes it, `+01` or `-0530`.
    pub fn fixed(offset: i64, abbr: Option<String>) -> Zone {
        let abbr = abbr.unwrap_or_else(|| numeric_abbr(offset));
        Zone { transitions: Vec::new(), first: None, rule: Some(Posix { std: Kind { offset, dst: false, abbr }, dst: None }) }
    }

    /// A zone from a TZ string: a name from the system's zone files, as
    /// `Europe/Stockholm`, or a POSIX rule, as `EST5EDT,M3.2.0,M11.1.0`.
    /// `None` for a string that is neither.
    pub fn named(tz: &str) -> Option<Zone> {
        let tz = tz.strip_prefix(':').unwrap_or(tz);
        if matches!(tz, "UTC" | "UTC0" | "GMT" | "GMT0" | "Z") {
            return Some(Zone::utc());
        }
        if !tz.contains("..")
            && let Some(zone) = zone_dirs().iter().find_map(|d| fs::read(format!("{d}/{tz}")).ok()).and_then(|b| parse_tzif(&b))
        {
            return Some(zone);
        }
        // A rule with no daylight saving time lacks the rules for when it
        // starts, which POSIX makes the US's; one must at least have an offset.
        parse_posix(tz).map(|rule| Zone { transitions: Vec::new(), first: None, rule: Some(rule) })
    }

    /// The machine's own zone: TZ's, else the system's, else UTC.
    pub fn system() -> Zone {
        if let Ok(tz) = std::env::var("TZ")
            && !tz.is_empty()
            && let Some(zone) = Zone::named(&tz)
        {
            return zone;
        }
        fs::read("/etc/localtime").ok().and_then(|b| parse_tzif(&b)).unwrap_or_else(Zone::utc)
    }

    fn kind_at(&self, t: i64) -> Kind {
        let i = self.transitions.partition_point(|(at, _)| *at <= t);
        if i == 0 {
            if let Some(first) = &self.first {
                return first.clone();
            }
        } else if i < self.transitions.len() || self.rule.is_none() {
            return self.transitions[i - 1].1.clone();
        }
        match &self.rule {
            Some(rule) => rule.kind_at(t),
            None => self.transitions.last().map_or(Kind { offset: 0, dst: false, abbr: "UTC".into() }, |(_, k)| k.clone()),
        }
    }

    /// The offset east of UTC in seconds at a time, its abbreviation, and
    /// whether it is daylight saving time.
    pub fn at(&self, t: i64) -> (i64, String, bool) {
        let k = self.kind_at(t);
        (k.offset, k.abbr, k.dst)
    }

    /// The time a local date and time is in this zone, as mktime finds it:
    /// with `dst` known, the offset with that daylight saving; a time that
    /// happens twice takes the first, and one skipped, the offset before.
    pub fn local_to_time(&self, local: i64, dst: Option<bool>) -> i64 {
        // The offsets in use near the time are the candidates.
        let mut candidates: Vec<(i64, bool)> = Vec::new();
        for probe in [local - 86400, local, local + 86400] {
            let k = self.kind_at(probe);
            if !candidates.contains(&(k.offset, k.dst)) {
                candidates.push((k.offset, k.dst));
            }
        }
        let fits = |offset: i64| {
            let t = local - offset;
            self.kind_at(t).offset == offset
        };
        if let Some(dst) = dst
            && let Some(&(offset, _)) = candidates.iter().find(|&&(o, d)| d == dst && fits(o))
        {
            return local - offset;
        }
        let mut fitting: Vec<i64> = candidates.iter().filter(|&&(o, _)| fits(o)).map(|&(o, _)| local - o).collect();
        fitting.sort_unstable();
        match fitting.first() {
            Some(&t) => t,
            None => local - candidates[0].0,
        }
    }
}

/// Where the system keeps its zone files.
fn zone_dirs() -> [&'static str; 3] {
    ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo", "/usr/lib/zoneinfo"]
}

/// An abbreviation made of an offset, as Emacs makes one for a zone that
/// has none: `+01`, `-05`, `+0530`.
pub fn numeric_abbr(offset: i64) -> String {
    let sign = if offset < 0 { '-' } else { '+' };
    let (h, m, s) = (offset.abs() / 3600, offset.abs() / 60 % 60, offset.abs() % 60);
    match (m, s) {
        (0, 0) => format!("{sign}{h:02}"),
        (_, 0) => format!("{sign}{h:02}{m:02}"),
        _ => format!("{sign}{h:02}{m:02}{s:02}"),
    }
}

/// A TZif file, version 2 or later's 64-bit data if there is any.
fn parse_tzif(bytes: &[u8]) -> Option<Zone> {
    let header = |b: &[u8]| -> Option<[usize; 6]> {
        if b.get(..4)? != b"TZif" {
            return None;
        }
        let n = |i: usize| -> Option<usize> { Some(u32::from_be_bytes(b.get(20 + 4 * i..24 + 4 * i)?.try_into().ok()?) as usize) };
        Some([n(0)?, n(1)?, n(2)?, n(3)?, n(4)?, n(5)?])
    };
    let [isutc, isstd, leap, time, typ, chars] = header(bytes)?;
    let version = *bytes.get(4)?;
    let v1_len = 44 + time * 5 + typ * 6 + chars + leap * 8 + isstd + isutc;
    let (data, wide) = if version >= b'2' { (bytes.get(v1_len..)?, true) } else { (bytes, false) };
    let [isutc, isstd, leap, time, typ, chars] = header(data)?;
    let size = if wide { 8 } else { 4 };
    let mut at = 44;
    let mut take = |n: usize| -> Option<&[u8]> {
        let s = data.get(at..at + n)?;
        at += n;
        Some(s)
    };
    let times: Vec<i64> = take(time * size)?
        .chunks(size)
        .map(|c| if wide { i64::from_be_bytes(c.try_into().unwrap()) } else { i64::from(i32::from_be_bytes(c.try_into().unwrap())) })
        .collect();
    let indices = take(time)?.to_vec();
    let infos: Vec<(i64, bool, usize)> = take(typ * 6)?.chunks(6).map(|c| (i64::from(i32::from_be_bytes([c[0], c[1], c[2], c[3]])), c[4] != 0, c[5] as usize)).collect();
    let abbrs = take(chars)?.to_vec();
    take(leap * (size + 4))?;
    take(isstd + isutc)?;
    let abbr = |i: usize| -> String {
        let rest = abbrs.get(i..).unwrap_or(&[]);
        let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
        String::from_utf8_lossy(&rest[..end]).into_owned()
    };
    let kind = |i: usize| -> Option<Kind> {
        let (offset, dst, a) = *infos.get(i)?;
        Some(Kind { offset, dst, abbr: abbr(a) })
    };
    let transitions = times.iter().zip(&indices).filter_map(|(&t, &i)| Some((t, kind(i as usize)?))).collect();
    // The first standard-time kind stands before the first change, as TZif says.
    let first = infos.iter().position(|i| !i.1).or(if infos.is_empty() { None } else { Some(0) }).and_then(kind);
    let footer = if wide {
        let rest = data.get(at..)?;
        let text = String::from_utf8_lossy(rest);
        text.trim_matches('\n').lines().next().and_then(parse_posix)
    } else {
        None
    };
    Some(Zone { transitions, first, rule: footer })
}

/// A POSIX TZ string: `std offset [dst [offset] [,start[/time],end[/time]]]`.
fn parse_posix(s: &str) -> Option<Posix> {
    let mut chars = s.chars().peekable();
    let name = |chars: &mut std::iter::Peekable<std::str::Chars>| -> Option<String> {
        let mut out = String::new();
        if chars.peek() == Some(&'<') {
            chars.next();
            for c in chars.by_ref() {
                if c == '>' {
                    return Some(out);
                }
                out.push(c);
            }
            return None;
        }
        while let Some(&c) = chars.peek() {
            if !c.is_ascii_alphabetic() {
                break;
            }
            out.push(c);
            chars.next();
        }
        (out.len() >= 3).then_some(out)
    };
    // `[+-]hh[:mm[:ss]]`, seconds.
    let clock = |chars: &mut std::iter::Peekable<std::str::Chars>| -> Option<i64> {
        let sign = match chars.peek() {
            Some('-') => {
                chars.next();
                -1
            }
            Some('+') => {
                chars.next();
                1
            }
            _ => 1,
        };
        let mut parts = [0i64; 3];
        for (i, part) in parts.iter_mut().enumerate() {
            if i > 0 {
                if chars.peek() != Some(&':') {
                    break;
                }
                chars.next();
            }
            let mut digits = String::new();
            while let Some(&c) = chars.peek() {
                if !c.is_ascii_digit() {
                    break;
                }
                digits.push(c);
                chars.next();
            }
            *part = digits.parse().ok()?;
        }
        Some(sign * (parts[0] * 3600 + parts[1] * 60 + parts[2]))
    };
    let std_name = name(&mut chars)?;
    // POSIX offsets are west of UTC.
    let std_offset = -clock(&mut chars)?;
    let std = Kind { offset: std_offset, dst: false, abbr: std_name };
    if chars.peek().is_none() {
        return Some(Posix { std, dst: None });
    }
    let dst_name = name(&mut chars)?;
    let dst_offset = match chars.peek() {
        Some(',') | None => std_offset + 3600,
        _ => -clock(&mut chars)?,
    };
    let dst = Kind { offset: dst_offset, dst: true, abbr: dst_name };
    let day = |chars: &mut std::iter::Peekable<std::str::Chars>| -> Option<(Day, i64)> {
        let number = |chars: &mut std::iter::Peekable<std::str::Chars>| -> Option<u32> {
            let mut digits = String::new();
            while let Some(&c) = chars.peek() {
                if !c.is_ascii_digit() {
                    break;
                }
                digits.push(c);
                chars.next();
            }
            digits.parse().ok()
        };
        let d = match chars.peek() {
            Some('J') => {
                chars.next();
                Day::Julian(number(chars)?)
            }
            Some('M') => {
                chars.next();
                let m = number(chars)?;
                (chars.next() == Some('.')).then_some(())?;
                let w = number(chars)?;
                (chars.next() == Some('.')).then_some(())?;
                Day::Month(m, w, number(chars)?)
            }
            _ => Day::Zero(number(chars)?),
        };
        let time = if chars.peek() == Some(&'/') {
            chars.next();
            clock(chars)?
        } else {
            7200
        };
        Some((d, time))
    };
    let (start, end) = if chars.peek() == Some(&',') {
        chars.next();
        let start = day(&mut chars)?;
        (chars.next() == Some(',')).then_some(())?;
        (start, day(&mut chars)?)
    } else {
        // The US's rules since 2007, as POSIX's default.
        ((Day::Month(3, 2, 0), 7200), (Day::Month(11, 1, 0), 7200))
    };
    Some(Posix { std, dst: Some((dst, start, end)) })
}

impl Posix {
    fn kind_at(&self, t: i64) -> Kind {
        let Some((dst, start, end)) = &self.dst else { return self.std.clone() };
        let year = civil_from_days((t + self.std.offset).div_euclid(86400)).0;
        // The changes, in UTC: the start in standard time, the end in daylight time.
        let starts = rule_day(year, start.0) * 86400 + start.1 - self.std.offset;
        let ends = rule_day(year, end.0) * 86400 + end.1 - dst.offset;
        let in_dst = if starts < ends { t >= starts && t < ends } else { t >= starts || t < ends };
        if in_dst { dst.clone() } else { self.std.clone() }
    }
}

/// The day, counted from the epoch, a rule's day of change falls on in a year.
fn rule_day(year: i64, day: Day) -> i64 {
    let jan1 = days_from_civil(year, 1, 1);
    match day {
        Day::Julian(n) => {
            let n = i64::from(n);
            jan1 + n - 1 + i64::from(is_leap(year) && n >= 60)
        }
        Day::Zero(n) => jan1 + i64::from(n),
        Day::Month(m, w, d) => {
            let first = days_from_civil(year, m as i64, 1);
            // 1970-01-01 was a Thursday.
            let weekday = (first + 4).rem_euclid(7);
            let mut day = first + (i64::from(d) - weekday).rem_euclid(7) + 7 * (i64::from(w) - 1);
            let next = if m == 12 { days_from_civil(year + 1, 1, 1) } else { days_from_civil(year, m as i64 + 1, 1) };
            while day >= next {
                day -= 7;
            }
            day
        }
    }
}

pub fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Days since the epoch of a date, as Howard Hinnant's days_from_civil.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The date of a day since the epoch, as civil_from_days.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A time's calendar fields in a zone, as `decode-time` gives them.
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub second: i64,
    /// The fraction of a second, from 0 to 1.
    pub fraction: f64,
    pub minute: i64,
    pub hour: i64,
    pub day: i64,
    pub month: i64,
    pub year: i64,
    /// 0 is Sunday.
    pub weekday: i64,
    pub dst: bool,
    pub offset: i64,
    pub abbr: String,
    /// Day of the year, 0 for January 1st.
    pub yday: i64,
}

/// Decodes a time in a zone.
pub fn decode(t: f64, zone: &Zone) -> Decoded {
    let whole = t.floor() as i64;
    let (offset, abbr, dst) = zone.at(whole);
    let local = whole + offset;
    let days = local.div_euclid(86400);
    let secs = local.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    Decoded {
        second: secs % 60,
        fraction: t - t.floor(),
        minute: secs / 60 % 60,
        hour: secs / 3600,
        day,
        month,
        year,
        weekday: (days + 4).rem_euclid(7),
        dst,
        offset,
        abbr,
        yday: days - days_from_civil(year, 1, 1),
    }
}

/// The time calendar fields stand for in a zone, as `encode-time`: fields
/// out of their range carry into the next, as mktime's do.
/// `fields` are the minute, hour, day, month and year.
pub fn encode(second: f64, fields: [i64; 5], dst: Option<bool>, zone: &Zone) -> f64 {
    let [minute, hour, day, month, year] = fields;
    let (y, m) = (year + (month - 1).div_euclid(12), (month - 1).rem_euclid(12) + 1);
    let days = days_from_civil(y, m, 1) + day - 1;
    let local = days * 86400 + hour * 3600 + minute * 60;
    let whole = second.floor();
    zone.local_to_time(local + whole as i64, dst) as f64 + (second - whole)
}

const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// The ISO 8601 week-based year and week of a date.
fn iso_week(d: &Decoded) -> (i64, i64) {
    let wday = (d.weekday + 6) % 7; // Monday is 0
    let week = (d.yday - wday + 10) / 7;
    let weeks_in = |y: i64| {
        let p = |y: i64| (y + y / 4 - y / 100 + y / 400) % 7;
        if p(y) == 4 || p(y - 1) == 3 { 53 } else { 52 }
    };
    if week < 1 {
        (d.year - 1, weeks_in(d.year - 1))
    } else if week > weeks_in(d.year) {
        (d.year + 1, 1)
    } else {
        (d.year, week)
    }
}

/// A time formatted as `format-time-string` formats it: `%` directives
/// with flags `-` (no padding), `_` (spaces), `0` (zeros), `^` (upper
/// case) and `#` (other case), a width, and for `%z` colons.
pub fn format(fmt: &str, t: f64, zone: &Zone) -> String {
    let d = decode(t, zone);
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        let mut pad: Option<char> = None;
        let (mut upper, mut swap) = (false, false);
        while let Some(&c) = chars.get(i) {
            match c {
                '-' | '_' | '0' => pad = Some(c),
                '^' => upper = true,
                '#' => swap = true,
                _ => break,
            }
            i += 1;
        }
        let mut width = String::new();
        while let Some(&c) = chars.get(i).filter(|c| c.is_ascii_digit()) {
            width.push(c);
            i += 1;
        }
        let width: Option<usize> = width.parse().ok();
        let mut colons = 0;
        while chars.get(i) == Some(&':') {
            colons += 1;
            i += 1;
        }
        let Some(&c) = chars.get(i) else {
            out.push('%');
            break;
        };
        i += 1;
        // A number padded to its natural width with zeros, or spaces.
        let num = |n: i64, natural: usize, space: bool| -> String {
            let pad_char = match pad {
                Some('-') => None,
                Some('_') => Some(' '),
                Some('0') => Some('0'),
                _ => Some(if space { ' ' } else { '0' }),
            };
            let w = width.unwrap_or(natural);
            let digits = n.abs().to_string();
            let sign = if n < 0 { "-" } else { "" };
            match pad_char {
                None => format!("{sign}{digits}"),
                Some(p) => {
                    let len = digits.len() + sign.len();
                    if len >= w {
                        format!("{sign}{digits}")
                    } else if p == '0' {
                        format!("{sign}{}{digits}", "0".repeat(w - len))
                    } else {
                        format!("{}{sign}{digits}", " ".repeat(w - len))
                    }
                }
            }
        };
        // Text padded to the width asked for.
        let fit = |s: String| -> String {
            match width {
                Some(w) if s.chars().count() < w => {
                    let fill = if pad == Some('0') { '0' } else { ' ' };
                    format!("{}{s}", fill.to_string().repeat(w - s.chars().count()))
                }
                _ => s,
            }
        };
        let text = |s: String| -> String {
            let s = if upper { s.to_uppercase() } else if swap { if s.chars().all(|c| !c.is_lowercase()) { s.to_lowercase() } else { s.to_uppercase() } } else { s };
            fit(s)
        };
        let hour12 = if d.hour % 12 == 0 { 12 } else { d.hour % 12 };
        let piece = match c {
            'Y' => num(d.year, 4, false),
            'y' => num(d.year.rem_euclid(100), 2, false),
            'C' => num(d.year.div_euclid(100), 2, false),
            'G' => num(iso_week(&d).0, 4, false),
            'g' => num(iso_week(&d).0.rem_euclid(100), 2, false),
            'm' => num(d.month, 2, false),
            'd' => num(d.day, 2, false),
            'e' => num(d.day, 2, true),
            'j' => num(d.yday + 1, 3, false),
            'H' => num(d.hour, 2, false),
            'k' => num(d.hour, 2, true),
            'I' => num(hour12, 2, false),
            'l' => num(hour12, 2, true),
            'M' => num(d.minute, 2, false),
            'S' => num(d.second, 2, false),
            'u' => num(if d.weekday == 0 { 7 } else { d.weekday }, 1, false),
            'w' => num(d.weekday, 1, false),
            'U' => num((d.yday + 7 - d.weekday) / 7, 2, false),
            'W' => num((d.yday + 7 - (d.weekday + 6) % 7) / 7, 2, false),
            'V' => num(iso_week(&d).1, 2, false),
            's' => num(t.floor() as i64, 1, false),
            'a' => text(DAYS[d.weekday as usize][..3].to_string()),
            'A' => text(DAYS[d.weekday as usize].to_string()),
            'b' | 'h' => text(MONTHS[d.month as usize - 1][..3].to_string()),
            'B' => text(MONTHS[d.month as usize - 1].to_string()),
            'p' => text(if d.hour < 12 { "AM" } else { "PM" }.to_string()),
            'P' => text(if d.hour < 12 { "am" } else { "pm" }.to_string()),
            // `#` gives the abbreviation in lower case.
            'Z' => fit(if upper { d.abbr.to_uppercase() } else if swap { d.abbr.to_lowercase() } else { d.abbr.clone() }),
            'z' => {
                let o = d.offset;
                let sign = if o < 0 { '-' } else { '+' };
                let (h, m, s) = (o.abs() / 3600, o.abs() / 60 % 60, o.abs() % 60);
                text(match colons {
                    0 => format!("{sign}{h:02}{m:02}"),
                    1 => format!("{sign}{h:02}:{m:02}"),
                    2 => format!("{sign}{h:02}:{m:02}:{s:02}"),
                    _ if s != 0 => format!("{sign}{h:02}:{m:02}:{s:02}"),
                    _ if m != 0 => format!("{sign}{h:02}:{m:02}"),
                    _ => format!("{sign}{h:02}"),
                })
            }
            'N' => {
                let nanos = ((d.fraction * 1e9).round() as i64).min(999_999_999);
                let digits = format!("{nanos:09}");
                digits[..width.unwrap_or(9).clamp(1, 9)].to_string()
            }
            'c' => format!("{} {} {:>2} {:02}:{:02}:{:02} {}", &DAYS[d.weekday as usize][..3], &MONTHS[d.month as usize - 1][..3], d.day, d.hour, d.minute, d.second, d.year),
            'x' | 'D' => format!("{:02}/{:02}/{:02}", d.month, d.day, d.year.rem_euclid(100)),
            'X' | 'T' => format!("{:02}:{:02}:{:02}", d.hour, d.minute, d.second),
            'F' => format!("{}-{:02}-{:02}", num(d.year, 4, false), d.month, d.day),
            'R' => format!("{:02}:{:02}", d.hour, d.minute),
            'r' => format!("{:02}:{:02}:{:02} {}", hour12, d.minute, d.second, if d.hour < 12 { "AM" } else { "PM" }),
            'n' => "\n".to_string(),
            't' => "\t".to_string(),
            '%' => "%".to_string(),
            other => format!("%{other}"),
        };
        out.push_str(&piece);
    }
    out
}

thread_local! {
    /// The zone `set-time-zone-rule` gave the editor, if any, else the system's.
    static LOCAL: std::cell::RefCell<Option<Zone>> = const { std::cell::RefCell::new(None) };
}

/// The editor's own zone: what `set-time-zone-rule` set, else the system's.
pub fn local_zone() -> Zone {
    LOCAL.with(|l| l.borrow().clone()).unwrap_or_else(Zone::system)
}

/// Sets the editor's zone, or with none goes back to the system's, as `set-time-zone-rule`.
pub fn set_local_zone(zone: Option<Zone>) {
    LOCAL.with(|l| *l.borrow_mut() = zone);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_round_trip() {
        for days in [-719468, -1, 0, 1, 20407, 2932896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(20407), (2025, 11, 15));
    }

    #[test]
    fn posix_rules_change_on_their_days() {
        let zone = Zone::named("EST5EDT,M3.2.0,M11.1.0").unwrap();
        assert_eq!(zone.at(1763166000), (-18000, "EST".into(), false));
        assert_eq!(zone.at(1751328000), (-14400, "EDT".into(), true));
    }
}
