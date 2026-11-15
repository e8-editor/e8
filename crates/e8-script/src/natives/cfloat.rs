//! floatfns.c's arithmetic as Lisp has it (ADR 0103): rounding to the
//! even neighbour and with a divisor, the float forms of rounding, a
//! float's parts, and alloc.c's questions about memory.

use crate::*;
use crate::natives::{Opt, natives};

fn arith_error() -> Error {
    Error::signal("arith-error", "Arithmetic error", Vec::new())
}

/// A number divided by an optional divisor, as rounding_driver takes them.
fn quotient(number: f64, divisor: &Opt<EditorValue>) -> Result<f64> {
    match divisor.0.as_ref().and_then(EditorValue::as_number) {
        None => Ok(number),
        Some(d) if d == 0.0 => Err(arith_error()),
        Some(d) => Ok(number / d),
    }
}

/// Rounds to the nearest whole number, halves to the even one, as Emacs's round.
fn round_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 { r - x.signum() } else { r }
}

/// A whole result, or an overflow error for one past what a number holds exactly.
fn whole(x: f64) -> Result<f64> {
    if !x.is_finite() {
        return Err(Error::signal("overflow-error", "Arithmetic overflow error", Vec::new()));
    }
    Ok(x)
}

natives! {
    /// The nearest whole number to a number, or to its quotient by `divisor`, halves to the even one, as round.
    #[ts = "(number: number, divisor?: number | null): number"]
    pub fn round(_ed, number: f64, divisor: Opt<EditorValue>) -> f64 {
        whole(round_even(quotient(number, &divisor)?))
    }

    /// The largest whole number not above a number or its quotient by `divisor`, as floor.
    #[ts = "(number: number, divisor?: number | null): number"]
    pub fn floor(_ed, number: f64, divisor: Opt<EditorValue>) -> f64 {
        whole(quotient(number, &divisor)?.floor())
    }

    /// The smallest whole number not below a number or its quotient by `divisor`, as ceiling.
    #[ts = "(number: number, divisor?: number | null): number"]
    pub fn ceiling(_ed, number: f64, divisor: Opt<EditorValue>) -> f64 {
        whole(quotient(number, &divisor)?.ceil())
    }

    /// A number or its quotient by `divisor` towards zero, as truncate.
    #[ts = "(number: number, divisor?: number | null): number"]
    pub fn truncate(_ed, number: f64, divisor: Opt<EditorValue>) -> f64 {
        whole(quotient(number, &divisor)?.trunc())
    }

    /// A float rounded to the nearest whole value, halves to the even one, as fround.
    #[ts = "(number: number): number"]
    pub fn fround(_ed, number: f64) -> f64 {
        Ok(round_even(number))
    }

    /// A float rounded down, as ffloor.
    #[ts = "(number: number): number"]
    pub fn ffloor(_ed, number: f64) -> f64 {
        Ok(number.floor())
    }

    /// A float rounded up, as fceiling.
    #[ts = "(number: number): number"]
    pub fn fceiling(_ed, number: f64) -> f64 {
        Ok(number.ceil())
    }

    /// A float rounded towards zero, as ftruncate.
    #[ts = "(number: number): number"]
    pub fn ftruncate(_ed, number: f64) -> f64 {
        Ok(number.trunc())
    }

    /// A number's significand, from 0.5 to 1, and exponent, as frexp: [significand, exponent].
    #[ts = "(x: number): [significand: number, exponent: number]"]
    pub fn frexp(_ed, x: f64) -> Vec<f64> {
        if x == 0.0 || !x.is_finite() {
            return Ok(vec![x, 0.0]);
        }
        let exponent = x.abs().log2().floor() as i32 + 1;
        let mut significand = x / 2f64.powi(exponent);
        let mut exponent = exponent;
        // log2 can be a hair off for powers of two; keep the significand in [0.5, 1).
        if significand.abs() >= 1.0 {
            significand /= 2.0;
            exponent += 1;
        } else if significand.abs() < 0.5 {
            significand *= 2.0;
            exponent -= 1;
        }
        Ok(vec![significand, f64::from(exponent)])
    }

    /// A significand times 2 to an exponent, as ldexp.
    #[ts = "(significand: number, exponent: number): number"]
    pub fn ldexp(_ed, significand: f64, exponent: f64) -> f64 {
        Ok(significand * 2f64.powi(exponent as i32))
    }

    /// A number's binary exponent, as logb.
    #[ts = "(x: number): number"]
    pub fn logb(_ed, x: f64) -> f64 {
        if x == 0.0 {
            return Ok(f64::NEG_INFINITY);
        }
        Ok(x.abs().log2().floor())
    }

    /// A number with the sign of another, as copysign.
    #[ts = "(x1: number, x2: number): number"]
    pub fn copysign(_ed, x1: f64, x2: f64) -> f64 {
        Ok(x1.copysign(x2))
    }

    /// Whether a number is not a number, as isnan.
    #[ts = "(x: number): boolean"]
    pub fn isnan(_ed, x: f64) -> bool {
        Ok(x.is_nan())
    }

    /// A number to a power, as expt: whole for a whole number to a power not below 0.
    #[ts = "(base: number, power: number): number"]
    pub fn expt(_ed, base: f64, power: f64) -> f64 {
        Ok(base.powf(power))
    }

    /// The machine's memory, as memory-info: [total, free, swap total, swap free] in KiB from /proc/meminfo on Linux; undefined elsewhere, as Emacs's is on macOS.
    #[ts = "(): [total: number, free: number, swapTotal: number, swapFree: number] | undefined"]
    pub fn memoryInfo(_ed) -> Option<Vec<f64>> {
        let Ok(text) = e8_core::vfs::read_to_string("/proc/meminfo") else { return Ok(None) };
        let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)?.trim().split_whitespace().next()?.parse::<f64>().ok());
        let free = field("MemAvailable:").or_else(|| field("MemFree:"));
        Ok(match (field("MemTotal:"), free, field("SwapTotal:"), field("SwapFree:")) {
            (Some(t), Some(f), Some(st), Some(sf)) => Some(vec![t, f, st, sf]),
            _ => None,
        })
    }

    /// How many Lisp objects have been made, as memory-use-counts: E8's script engine keeps its own, so seven zeros.
    #[ts = "(): number[]"]
    pub fn memoryUseCounts(_ed) -> Vec<f64> {
        Ok(vec![0.0; 7])
    }

    /// Collect garbage soon if much was made since the last time, as garbage-collect-maybe: E8's engine collects when it judges, so undefined.
    #[ts = "(factor: number): undefined"]
    pub fn garbageCollectMaybe(_ed, factor: f64) -> Option<bool> {
        if factor < 1.0 {
            return Err(e8_core::xfaces::wrong_type("wholenump", &EditorValue::Number(factor)));
        }
        Ok(None)
    }

    /// The natural logarithm of a number, or with `base` the logarithm in that base, as Lisp's log, whose name e8.log has for writing to the log.
    #[ts = "(arg: number, base?: number | null): number"]
    pub fn logarithm(_ed, arg: f64, base: Opt<EditorValue>) -> f64 {
        Ok(match base.0.as_ref().and_then(EditorValue::as_number) {
            Some(10.0) => arg.log10(),
            Some(2.0) => arg.log2(),
            Some(b) => arg.ln() / b.ln(),
            None => arg.ln(),
        })
    }

    /// e to a power, as exp.
    #[ts = "(arg: number): number"]
    pub fn exp(_ed, arg: f64) -> f64 {
        Ok(arg.exp())
    }

    /// A number's square root, as sqrt.
    #[ts = "(arg: number): number"]
    pub fn sqrt(_ed, arg: f64) -> f64 {
        Ok(arg.sqrt())
    }

    /// A number's absolute value, as abs.
    #[ts = "(arg: number): number"]
    pub fn abs(_ed, arg: f64) -> f64 {
        Ok(arg.abs())
    }

    /// A number as a float, as float: the same number, as E8's numbers are floats already.
    #[ts = "(arg: number): number"]
    pub fn float(_ed, arg: f64) -> f64 {
        Ok(arg)
    }

    /// The sine of an angle in radians, as sin.
    #[ts = "(arg: number): number"]
    pub fn sin(_ed, arg: f64) -> f64 {
        Ok(arg.sin())
    }

    /// The cosine of an angle in radians, as cos.
    #[ts = "(arg: number): number"]
    pub fn cos(_ed, arg: f64) -> f64 {
        Ok(arg.cos())
    }

    /// The tangent of an angle in radians, as tan.
    #[ts = "(arg: number): number"]
    pub fn tan(_ed, arg: f64) -> f64 {
        Ok(arg.tan())
    }

    /// The arcsine of a number, as asin.
    #[ts = "(arg: number): number"]
    pub fn asin(_ed, arg: f64) -> f64 {
        Ok(arg.asin())
    }

    /// The arccosine of a number, as acos.
    #[ts = "(arg: number): number"]
    pub fn acos(_ed, arg: f64) -> f64 {
        Ok(arg.acos())
    }

    /// The arctangent of `y`, or with `x` of y/x in the right quadrant, as atan.
    #[ts = "(y: number, x?: number | null): number"]
    pub fn atan(_ed, y: f64, x: Opt<EditorValue>) -> f64 {
        Ok(match x.0.as_ref().and_then(EditorValue::as_number) {
            Some(x) => y.atan2(x),
            None => y.atan(),
        })
    }
}
