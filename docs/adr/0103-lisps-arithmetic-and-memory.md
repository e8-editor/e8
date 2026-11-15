# 0103. Lisp's arithmetic and memory

Status: accepted · 2026-11-15

## Context

floatfns.c's functions look like JavaScript's `Math`, and ported Lisp often calls them with Lisp's meanings, which `Math` does not have:

- `round` goes to the even neighbour at a half, where `Math.round` goes up;
- `floor`, `ceiling`, `round` and `truncate` take a divisor;
- `frexp`, `ldexp` and `logb` take a float apart, which JavaScript cannot do without arithmetic of its own;
- `log` takes a base, and `atan` a second argument.

alloc.c's `memory-info`, `memory-use-counts` and `garbage-collect-maybe` are asked by packages that report on the machine.

## Decision

Each is written as floatfns.c and alloc.c do it (`natives/cfloat.rs`).

- **Rounding.**
  - Halves go to the even neighbour.
  - A divisor of 0 signals `arith-error`, and a result that is no finite number `overflow-error`.
  - The float forms (`fround`, `ffloor`, `fceiling`, `ftruncate`) round alike.
- **A float's parts.** `frexp` gives a significand from 0.5 to 1 and an exponent; `ldexp` puts them together; `logb` gives the binary exponent.
- **The rest:**
  - `copysign` and `isnan`;
  - `expt`;
  - `log` with a base, exact for 2 and 10, as `e8.logarithm`, as `e8.log` writes to the log, with a defun of `log`;
  - `exp`, `sqrt`, `abs` and `float`;
  - the trigonometric functions, `atan` with two arguments in the right quadrant.
- **Memory.**
  - `memory-info` reads `/proc/meminfo` on Linux. Elsewhere it is nil, as Emacs's is on macOS.
  - `memory-use-counts` gives seven zeros, as the script engine counts its own objects.
  - `garbage-collect-maybe` leaves collecting to the engine.

## Consequences

- **What it unblocks.** Ported Lisp that rounds, divides or takes floats apart as Lisp does gives the same numbers.
- **Recorded in [differences.md](../differences.md):**
  - E8's numbers are doubles, so `float` changes nothing and whole results are not integers of their own type;
  - `memory-use-counts` is zeros.
