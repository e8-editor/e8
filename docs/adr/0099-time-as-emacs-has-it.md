# 0099. Time as Emacs has it

Status: accepted · 2026-11-15

## Context

timefns.c's primitives are how Lisp handles calendar time:

- `format-time-string`, with its `%` directives, flags, widths and zones;
- `decode-time` and `encode-time`;
- `current-time-string` and `current-time-zone`;
- `time-add`, `time-subtract`, `time-less-p`, `time-equal-p` and `time-convert`;
- `set-time-zone-rule`.

E8 had none of them. Its packages used JavaScript's `Date`, which knows only the machine's zone and UTC and formats nothing as Emacs does, so each package that needed a date worked it out again (org-clock, org-datetree, dired-aux).

A zone in Emacs is any of: nil for local time, t for UTC, a number of seconds east, `(OFFSET ABBR)`, or a TZ string such as `Europe/Stockholm` or `EST5EDT,M3.2.0,M11.1.0`. Emacs converts through the C library with a zone object per call (gnulib's `localtime_rz`). The C library otherwise takes its zone from the `TZ` environment variable, which a multi-threaded program cannot safely change.

## Options considered

1. **The C library, setting `TZ` around each call.** That changes the environment under the editor's other threads, and processes started meanwhile would see it. It has no web build either.
2. **A crate with the zone database**, such as `chrono-tz`: a new dependency whose zones go stale with the crate's releases, not the system's.
3. **Reading the system's zone files**, as the C library does: TZif files from `/usr/share/zoneinfo` and POSIX TZ rules, parsed here.

## Decision

Option 3, in `e8-core/src/timefns.rs`. It has no new dependency, and its zones are the system's, as Emacs's are.

- **Zones.**
  - TZif files are read with their 64-bit data and footer rule.
  - POSIX rules are parsed with their `Jn`, `n` and `Mm.w.d` days and times; one without dates gets POSIX's default, the US's.
  - A fixed offset gets an abbreviation made of itself (`+01`), as Emacs makes one.
- **The local zone** is `TZ`'s, else `/etc/localtime`'s, else UTC. `set-time-zone-rule` gives the editor a zone of its own without changing the environment.
- **Decoding** works out the calendar fields with Howard Hinnant's civil-date algorithms.
- **Encoding** finds the time a local time stands for as mktime does: daylight saving time as asked, the earlier of a time that happens twice, and fields past their range carrying over.
- **`format-time-string`** has Emacs's directives:
  - every one GNU's strftime has, in the C locale;
  - `%N` with a width, `%z` with colons;
  - the flags `-`, `_`, `0`, `^` and `#`, and widths.
- **Times are seconds** since the epoch, as E8's times are numbers.
  - Functions take Emacs's list forms too: `(HIGH LOW USEC PSEC)`, and `(TICKS . HZ)` where the second number is too large to be a LOW.
  - `time-convert` gives each form when asked, ticks for a float scaled to its 53 bits as Emacs scales them.
  - `encode-time` takes both its list form and its older form of separate fields.

## Consequences

- **What it unblocks.** Packages can format and decode times as Lisp does, in any zone the system has, without `Date`.
- **Recorded in [differences.md](../differences.md):**
  - times come back as numbers of seconds, not lists;
  - the names of days and months are English, as in the C locale;
  - on the web there are no zone files, so named zones are UTC.
- **Later.** The packages that work dates out with `Date` can move to these, a change of their own.
