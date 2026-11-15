//! Time as Emacs's timefns.c has it (ADR 0099). Each expectation is what
//! Emacs 30.2 gives for the same calls, but that E8's times are seconds:
//! where Emacs gives (26903 50992), E8 gives 1763166000.

use e8_core::Editor;
use e8_script::Scripting;

/// 2025-11-15 00:20:00 UTC.
const T: &str = "1763166000";
/// 2025-07-01 00:00:00 UTC, in summer.
const SUMMER: &str = "1751328000";

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let code = code.replace("$T", T).replace("$SUMMER", SUMMER);
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

#[test]
fn times_are_formatted_as_emacs_formats_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(
        r(r#"return e8.formatTimeString("%Y-%m-%d %H:%M:%S %a %A %b %B %j %u %w %y %C %e|%k|%l %I %p %Z %z %s", $T, true);"#),
        r#""2025-11-15 00:20:00 Sat Saturday Nov November 319 6 6 25 20 15| 0|12 12 AM UTC +0000 1763166000""#
    );
    assert_eq!(r(r#"return e8.formatTimeString("%F %T %R %D %G %g %V %U %W %h %n%t%%", $T, true);"#), r#""2025-11-15 00:20:00 00:20 11/15/25 2025 25 46 45 45 Nov \n\t%""#);
    assert_eq!(r(r#"return e8.formatTimeString("%-d %_m %05Y %^a %#Z %3N %N %:z %::z %:::z", $T, true);"#), r#""15 11 02025 SAT utc 000 000000000 +00:00 +00:00:00 +00""#);
    assert_eq!(r(r#"return [e8.formatTimeString("%c", $T, true), e8.formatTimeString("%x", $T, true), e8.formatTimeString("%X", $T, true), e8.formatTimeString("%r", $T, true)];"#), r#"["Sat Nov 15 00:20:00 2025","11/15/25","00:20:00","12:20:00 AM"]"#);
    assert_eq!(r(r#"return e8.currentTimeString($T, true);"#), r#""Sat Nov 15 00:20:00 2025""#);
}

#[test]
fn zones_are_named_ruled_and_fixed() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return e8.formatTimeString("%Y-%m-%d %H:%M %Z %z", $T, "Europe/Stockholm");"#), r#""2025-11-15 01:20 CET +0100""#);
    assert_eq!(r(r#"return e8.formatTimeString("%Y-%m-%d %H:%M %Z %z", $T, "America/New_York");"#), r#""2025-11-14 19:20 EST -0500""#);
    assert_eq!(r(r#"return e8.formatTimeString("%H:%M %Z %z", $SUMMER, "Europe/Stockholm");"#), r#""02:00 CEST +0200""#);
    assert_eq!(r(r#"return [e8.formatTimeString("%H:%M %Z %z", $T, "EST5EDT"), e8.formatTimeString("%H:%M %Z %z", $SUMMER, "EST5EDT,M3.2.0,M11.1.0")];"#), r#"["19:20 EST -0500","20:00 EDT -0400"]"#);
    assert_eq!(r(r#"return [e8.formatTimeString("%H:%M %Z %z", $T, 3600), e8.formatTimeString("%H:%M %Z %z", $T, [-18000, "XST"])];"#), r#"["01:20 +01 +0100","19:20 XST -0500"]"#);
    assert_eq!(r(r#"return [e8.currentTimeZone($T, "Europe/Stockholm"), e8.currentTimeZone($T, true)];"#), r#"[[3600,"CET"],[0,"UTC"]]"#);
    // The editor's own zone, as set-time-zone-rule sets it.
    assert_eq!(r(r#"e8.setTimeZoneRule("Europe/Stockholm"); return e8.formatTimeString("%H:%M %Z", $T);"#), r#""01:20 CET""#);
    assert_eq!(r(r#"e8.setTimeZoneRule(true); return e8.formatTimeString("%H:%M %Z", $T);"#), r#""00:20 UTC""#);
}

#[test]
fn times_are_decoded_and_encoded() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return e8.decodeTime($T, true);"), "[0,20,0,15,11,2025,6,false,0]");
    assert_eq!(r(r#"return e8.decodeTime($T, "Europe/Stockholm");"#), "[0,20,1,15,11,2025,6,false,3600]");
    assert_eq!(r(r#"return e8.decodeTime($SUMMER, "EST5EDT,M3.2.0,M11.1.0");"#), "[0,0,20,30,6,2025,1,true,-14400]");
    assert_eq!(r("return e8.encodeTime([0, 20, 0, 15, 11, 2025, null, null, true]);"), T);
    assert_eq!(r(r#"return e8.encodeTime([0, 20, 1, 15, 11, 2025, null, -1, "Europe/Stockholm"]);"#), T);
    assert_eq!(r("return e8.encodeTime(0, 20, 0, 15, 11, 2025, true);"), T);
    // Fields past their range carry over: the 32nd of October is November 1st.
    assert_eq!(r("return e8.decodeTime(e8.encodeTime([0, 60, 23, 32, 10, 2025, null, null, true]), true).slice(0, 6);"), "[0,0,0,2,11,2025]");
    assert_eq!(r("return e8.decodeTime(e8.encodeTime([0, 0, 0, 1, 13, 2025, null, null, true]), true).slice(3, 6);"), "[1,1,2026]");
}

#[test]
fn times_are_added_compared_and_converted() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return [e8.timeAdd($T, 60), e8.timeSubtract([0, 10], 2.5), e8.floatTime([0, 3, 500000])];"), "[1763166060,7.5,3.5]");
    assert_eq!(r("return [e8.timeLessP(1, 2), e8.timeEqualP(3, [0, 3]), e8.timeLessP(2, 1)];"), "[true,true,false]");
    assert_eq!(r(r#"return [e8.timeConvert($T, "list"), e8.timeConvert($T, "integer"), e8.timeConvert(1.5, true)];"#), "[[26903,50992,0,0],1763166000,[6755399441055744,4503599627370496]]");
    assert_eq!(r("return [e8.floatTime([6755399441055744, 4503599627370496]), Math.abs(e8.currentTime() - Date.now() / 1000) < 5];"), "[1.5,true]");
    assert_eq!(r("const [ticks, hz] = e8.currentCpuTime(); return [ticks > 0, hz];"), "[true,1000000]");
}
