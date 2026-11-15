//! Time as Emacs's timefns.c gives it to Lisp (ADR 0099): times are
//! seconds since the epoch, as E8's times are numbers, and a time Emacs
//! writes as a list, `(HIGH LOW USEC PSEC)` or `(TICKS . HZ)`, is taken
//! too. Zones are nil for the editor's own, true for UTC, a number of
//! seconds east of UTC, `[offset, abbreviation]`, or a TZ string.

use crate::*;
use crate::natives::{Opt, Rest, natives};
use e8_core::timefns::{self, Zone};

/// The time a value stands for, now for none, as lisp_time_argument takes it.
fn time_of(value: Option<&EditorValue>) -> Result<f64> {
    let now = || e8_core::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    let wrong = |v: &EditorValue| Error::signal("error", "Invalid time specification", vec![v.clone()]);
    match value {
        None | Some(EditorValue::Null) => Ok(now()),
        Some(EditorValue::Number(n)) => Ok(*n),
        Some(EditorValue::List(items)) => {
            let n = |i: usize| items.get(i).and_then(EditorValue::as_number);
            match items.len() {
                // (TICKS . HZ) when the second is past what LOW can be.
                2 if n(1).is_some_and(|hz| hz >= 65536.0) => Ok(n(0).ok_or_else(|| wrong(value.unwrap()))? / n(1).unwrap()),
                2..=4 => {
                    let (high, low) = (n(0).ok_or_else(|| wrong(value.unwrap()))?, n(1).ok_or_else(|| wrong(value.unwrap()))?);
                    Ok(high * 65536.0 + low + n(2).unwrap_or(0.0) / 1e6 + n(3).unwrap_or(0.0) / 1e12)
                }
                _ => Err(wrong(value.unwrap())),
            }
        }
        Some(other) => Err(wrong(other)),
    }
}

/// The zone a value names, as decode_time_zone.
fn zone_of(value: Option<&EditorValue>) -> Result<Zone> {
    Ok(match value {
        None | Some(EditorValue::Null) => timefns::local_zone(),
        Some(EditorValue::Bool(true)) => Zone::utc(),
        Some(EditorValue::Number(n)) => Zone::fixed(*n as i64, None),
        Some(EditorValue::List(pair)) if pair.len() == 2 => {
            let offset = pair[0].as_number().ok_or_else(|| Error::signal("error", "Invalid time zone specification", vec![pair[0].clone()]))?;
            Zone::fixed(offset as i64, pair[1].as_str().map(str::to_string))
        }
        Some(v) => match v.as_str() {
            Some("wall") => timefns::local_zone(),
            Some(tz) => Zone::named(tz).unwrap_or_else(|| Zone::fixed(0, Some(tz.chars().take_while(char::is_ascii_alphabetic).collect::<String>()).filter(|a| !a.is_empty()))),
            None => return Err(Error::signal("error", "Invalid time zone specification", vec![v.clone()])),
        },
    })
}

/// A time as `(HIGH LOW USEC PSEC)`.
fn as_list(t: f64) -> EditorValue {
    let secs = t.floor();
    let frac = t - secs;
    let (usec, psec) = ((frac * 1e6).floor(), ((frac * 1e12).round() % 1e6).floor());
    let n = EditorValue::Number;
    EditorValue::List(vec![n((secs / 65536.0).floor()), n(secs.rem_euclid(65536.0)), n(usec), n(psec)])
}

/// A time as `(TICKS . HZ)`, exactly for a number with a binary fraction, as time_convert does.
fn as_ticks(t: f64, hz: Option<f64>) -> EditorValue {
    let n = EditorValue::Number;
    if let Some(hz) = hz {
        return EditorValue::List(vec![n((t * hz).floor()), n(hz)]);
    }
    if t.fract() == 0.0 {
        return EditorValue::List(vec![n(t), n(1.0)]);
    }
    // All 53 bits of the mantissa as ticks, as time_convert scales a float
    // by 2 to the power of DBL_MANT_DIG less its exponent.
    let exponent = t.abs().log2().floor() as i32 + 1;
    let hz = 2f64.powi((53 - exponent).max(0));
    EditorValue::List(vec![n(t * hz), n(hz)])
}

/// Decoded fields as decode-time gives them: (SEC MIN HOUR DAY MON YEAR DOW DST UTCOFF).
fn decoded_value(d: &timefns::Decoded, fraction: bool) -> EditorValue {
    let n = EditorValue::Number;
    let second = if fraction && d.fraction != 0.0 { as_ticks(d.second as f64 + d.fraction, None) } else { n(d.second as f64) };
    EditorValue::List(vec![
        second,
        n(d.minute as f64),
        n(d.hour as f64),
        n(d.day as f64),
        n(d.month as f64),
        n(d.year as f64),
        n(d.weekday as f64),
        EditorValue::Bool(d.dst),
        n(d.offset as f64),
    ])
}

natives! {
    /// The time now, in seconds since the epoch, as current-time and float-time with no time give it.
    #[ts = "(): number"]
    pub fn currentTime(_ed) -> f64 {
        time_of(None)
    }

    /// A time in seconds, now for none, as float-time.
    #[ts = "(time?: Value): number"]
    pub fn floatTime(_ed, time: Opt<EditorValue>) -> f64 {
        time_of(time.0.as_ref())
    }

    /// The sum of two times, as time-add.
    #[ts = "(a: Value, b: Value): number"]
    pub fn timeAdd(_ed, a: EditorValue, b: EditorValue) -> f64 {
        Ok(time_of(Some(&a))? + time_of(Some(&b))?)
    }

    /// One time less another, as time-subtract.
    #[ts = "(a: Value, b: Value): number"]
    pub fn timeSubtract(_ed, a: EditorValue, b: EditorValue) -> f64 {
        Ok(time_of(Some(&a))? - time_of(Some(&b))?)
    }

    /// Whether a time is before another, as time-less-p; null is now.
    #[ts = "(a: Value, b: Value): boolean"]
    pub fn timeLessP(_ed, a: EditorValue, b: EditorValue) -> bool {
        Ok(time_of(Some(&a))? < time_of(Some(&b))?)
    }

    /// Whether two times are the same, as time-equal-p.
    #[ts = "(a: Value, b: Value): boolean"]
    pub fn timeEqualP(_ed, a: EditorValue, b: EditorValue) -> bool {
        Ok(time_of(Some(&a))? == time_of(Some(&b))?)
    }

    /// A time in another form, as time-convert: "list" for (HIGH LOW USEC PSEC), "integer" for whole seconds, true or a number of ticks a second for [ticks, hz], else seconds.
    #[ts = "(time: Value, form?: \"list\" | \"integer\" | true | number | null): Value"]
    pub fn timeConvert(_ed, time: EditorValue, form: Opt<EditorValue>) -> EditorValue {
        let t = time_of(Some(&time))?;
        Ok(match form.0 {
            Some(EditorValue::Bool(true)) => as_ticks(t, None),
            Some(EditorValue::Number(hz)) => as_ticks(t, Some(hz)),
            Some(v) if v.as_str() == Some("list") => as_list(t),
            Some(v) if v.as_str() == Some("integer") => EditorValue::Number(t.floor()),
            _ => EditorValue::Number(t),
        })
    }

    /// A time formatted as format-time-string does: %Y, %m, %d, %H, %M, %S, %Z, %z and the rest, with Emacs's flags and widths, in a zone.
    #[ts = "(format: string, time?: Value, zone?: Value): string"]
    pub fn formatTimeString(_ed, format: String, time: Opt<EditorValue>, zone: Opt<EditorValue>) -> String {
        Ok(timefns::format(&format, time_of(time.0.as_ref())?, &zone_of(zone.0.as_ref())?))
    }

    /// A time's calendar fields in a zone, as decode-time: [sec, min, hour, day, month, year, weekday, dst, utcoff], the seconds as [ticks, hz] where they have a fraction and form is true.
    #[ts = "(time?: Value, zone?: Value, form?: Value): Value[]"]
    pub fn decodeTime(_ed, time: Opt<EditorValue>, zone: Opt<EditorValue>, form: Opt<EditorValue>) -> EditorValue {
        let d = timefns::decode(time_of(time.0.as_ref())?, &zone_of(zone.0.as_ref())?);
        Ok(decoded_value(&d, matches!(form.0, Some(EditorValue::Bool(true)))))
    }

    /// The time calendar fields stand for, as encode-time: a list as decode-time gives, its zone last, or the old form of second, minute, hour, day, month, year and zone; fields past their range carry over.
    #[ts = "(time: Value[] | number, ...rest: Value[]): number"]
    pub fn encodeTime(_ed, time: EditorValue, rest: Rest<EditorValue>) -> f64 {
        let fields: Vec<EditorValue> = match time {
            EditorValue::List(items) => items,
            first => std::iter::once(first).chain(rest.0).collect(),
        };
        let int = |i: usize| -> Result<i64> {
            fields.get(i).and_then(EditorValue::as_number).map(|n| n as i64).ok_or_else(|| Error::signal("error", "Invalid time specification", vec![fields.get(i).cloned().unwrap_or(EditorValue::Null)]))
        };
        let second = match fields.first() {
            Some(v @ EditorValue::List(_)) => time_of(Some(v))?,
            Some(v) => v.as_number().ok_or_else(|| Error::signal("error", "Invalid time specification", vec![v.clone()]))?,
            None => return Err(Error::signal("wrong-number-of-arguments", "Wrong number of arguments", Vec::new())),
        };
        // The list form puts DOW and DST before the zone; the old form the zone right after the year.
        let (dst, zone) = if fields.len() >= 9 {
            let dst = match &fields[7] {
                EditorValue::Bool(b) => Some(*b),
                EditorValue::Number(n) if *n < 0.0 => None,
                v if v.is_nil() => Some(false),
                _ => Some(true),
            };
            (dst, fields.get(8))
        } else {
            (None, fields.get(6))
        };
        Ok(timefns::encode(second, [int(1)?, int(2)?, int(3)?, int(4)?, int(5)?], dst, &zone_of(zone)?))
    }

    /// A time as text, "Sat Nov 15 00:20:00 2025", as current-time-string.
    #[ts = "(time?: Value, zone?: Value): string"]
    pub fn currentTimeString(_ed, time: Opt<EditorValue>, zone: Opt<EditorValue>) -> String {
        Ok(timefns::format("%a %b %e %H:%M:%S %Y", time_of(time.0.as_ref())?, &zone_of(zone.0.as_ref())?))
    }

    /// A zone's offset east of UTC in seconds and its abbreviation at a time, as current-time-zone.
    #[ts = "(time?: Value, zone?: Value): [offset: number, abbreviation: string]"]
    pub fn currentTimeZone(_ed, time: Opt<EditorValue>, zone: Opt<EditorValue>) -> Vec<EditorValue> {
        let (offset, abbr, _) = zone_of(zone.0.as_ref())?.at(time_of(time.0.as_ref())?.floor() as i64);
        Ok(vec![EditorValue::Number(offset as f64), EditorValue::Str(abbr)])
    }

    /// Set the editor's own zone, or go back to the system's with null or "wall", as set-time-zone-rule.
    #[ts = "(zone: Value): undefined"]
    pub fn setTimeZoneRule(_ed, zone: EditorValue) -> Option<bool> {
        let zone = match &zone {
            v if v.is_nil() || v.as_str() == Some("wall") => None,
            v => Some(zone_of(Some(v))?),
        };
        timefns::set_local_zone(zone);
        Ok(None)
    }

    /// The processor time E8 has used, as current-cpu-time: [ticks, ticks a second].
    #[ts = "(): [ticks: number, hz: number]"]
    pub fn currentCpuTime(_ed) -> Vec<f64> {
        Ok(vec![(e8_core::clock::run_time() * 1e6).round(), 1e6])
    }
}
