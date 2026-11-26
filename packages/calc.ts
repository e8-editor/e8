// The part of Emacs's Calc that Org's table formulas use: calc-eval, which
// reads an algebraic formula as Calc's algebraic entry does, works it out
// with Calc's numbers, and writes the result as Calc displays it
// ([ADR 0115](../docs/adr/0115-table-formulas-on-a-part-of-calc.md)).
//
// Numbers are Calc's: integers of any size, fractions, and decimal floats
// of `calc-internal-prec` digits, rounded as math-make-float rounds them,
// so 1/3 is 0.333333333333 inside and 0.33333333 shown in Org's float 8
// format. A formula with words in it stays a formula, as `abc + 1`, and so
// does a function Calc has that this part lacks, as Calc leaves a function
// it cannot apply. Dates are Calc's date forms, days since December 31,
// 1 BC, read from and written as <2024-01-05 Fri 10:30>.
//
// Not here: complex numbers, intervals, error and modulo forms, HMS forms,
// units, matrices beyond a dot product, and Calc's algebra beyond
// collecting what it does as it computes.

/** A fraction, reduced, its denominator above 1. */
interface Frac {
  k: "frac";
  n: bigint;
  d: bigint;
}

/** A decimal float, mantissa times ten to the exponent, as Calc's (float M E). */
interface Flt {
  k: "float";
  m: bigint;
  e: number;
}

interface Vec {
  k: "vec";
  xs: Expr[];
}

/** A date form: days since December 31, 1 BC, the fraction the time of day. */
interface DateForm {
  k: "date";
  v: Real;
}

interface Var {
  k: "var";
  name: string;
}

/**
 * A formula Calc leaves as it is: an operator, as "+", "neg" or "lt", or a
 * function, by its name without calcFunc-.
 */
interface Call {
  k: "call";
  f: string;
  args: Expr[];
}

type Real = bigint | Frac | Flt;
export type Expr = Real | Vec | DateForm | Var | Call;

/** Calc's modes for one evaluation, from the plist Org passes to calc-eval. */
export interface CalcModes {
  prec: number;
  floatFormat: ["float" | "fix" | "sci" | "eng", number];
  angle: "deg" | "rad";
  preferFrac: boolean;
  symbolic: boolean;
}

export const defaultModes: CalcModes = {
  prec: 12,
  floatFormat: ["float", 0],
  angle: "deg",
  preferFrac: false,
  symbolic: false,
};

let modes: CalcModes = defaultModes;
/** The reason Calc gives when it cannot do something, as calc-next-why. */
let why: string | undefined;

class CalcSyntax extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

/** A function that cannot apply to its arguments, which then stay as they are. */
class Reject extends Error {}

function reject(message?: string): never {
  if (message && why === undefined) why = message.replace(/^\*/, "");
  throw new Reject(message);
}

// ---------------------------------------------------------------- Numbers

const isInt = (a: Expr): a is bigint => typeof a === "bigint";
const isFrac = (a: Expr): a is Frac => typeof a === "object" && a.k === "frac";
const isFloat = (a: Expr): a is Flt => typeof a === "object" && a.k === "float";
const isReal = (a: Expr): a is Real => isInt(a) || isFrac(a) || isFloat(a);
const isRat = (a: Expr): a is bigint | Frac => isInt(a) || isFrac(a);
const isVec = (a: Expr): a is Vec => typeof a === "object" && a.k === "vec";
const isDate = (a: Expr): a is DateForm => typeof a === "object" && a.k === "date";
const isVar = (a: Expr, name?: string): a is Var => typeof a === "object" && a.k === "var" && (name === undefined || a.name === name);
const isCall = <F extends string = string>(a: Expr, f?: F): a is Call & { f: F } => typeof a === "object" && a.k === "call" && (f === undefined || a.f === f);

const babs = (a: bigint): bigint => (a < 0n ? -a : a);
const bgcd = (a: bigint, b: bigint): bigint => {
  a = babs(a);
  b = babs(b);
  while (b) [a, b] = [b, a % b];
  return a;
};
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** How many decimal digits an integer has, 0 for 0, as math-numdigs. */
function numdigs(a: bigint): number {
  return a === 0n ? 0 : babs(a).toString().length;
}

/** A times ten to the N, rounding when N is negative, as math-scale-rounding. */
function scaleRounding(a: bigint, n: number): bigint {
  if (n >= 0) return a * pow10(n);
  if (a < 0n) return -scaleRounding(-a, n);
  return n === -1 ? (a + 5n) / 10n : (a / pow10(-1 - n) + 5n) / 10n;
}

/** A float of `prec` digits at most, as math-make-float rounds it. */
function makeFloat(m: bigint, e: number): Flt {
  if (m === 0n) return { k: "float", m: 0n, e: 0 };
  const ldiff = modes.prec - numdigs(m);
  if (ldiff < 0) {
    m = scaleRounding(m, ldiff);
    e -= ldiff;
  }
  while (m % 10n === 0n) {
    m /= 10n;
    e++;
  }
  return { k: "float", m, e };
}

function makeFrac(n: bigint, d: bigint): bigint | Frac {
  if (d === 0n) reject("*Division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bgcd(n, d);
  if (g > 1n) {
    n /= g;
    d /= g;
  }
  return d === 1n ? n : { k: "frac", n, d };
}

function toFloat(a: Real): Flt {
  if (isInt(a)) return makeFloat(a, 0);
  if (isFrac(a)) return divFloat(makeFloat(a.n, 0), makeFloat(a.d, 0));
  return a;
}

function divFloat(a: Flt, b: Flt): Flt {
  if (b.m === 0n) reject("*Division by zero");
  const ldiff = Math.max(modes.prec + 1 - (numdigs(a.m) - numdigs(b.m)), 0);
  return makeFloat((a.m * pow10(ldiff)) / b.m, a.e - b.e - ldiff);
}

function addFloat(a: Flt, b: Flt): Flt {
  let ediff = a.e - b.e;
  if (ediff >= 0) {
    if (ediff >= 2 * modes.prec) return a;
    return makeFloat(b.m + a.m * pow10(ediff), b.e);
  }
  ediff = -ediff;
  if (ediff >= 2 * modes.prec) return b;
  return makeFloat(a.m + b.m * pow10(ediff), a.e);
}

const isZero = (a: Expr): boolean => (isInt(a) ? a === 0n : isFloat(a) && a.m === 0n);

function sign(a: Real): number {
  if (isInt(a)) return a < 0n ? -1 : a > 0n ? 1 : 0;
  if (isFrac(a)) return a.n < 0n ? -1 : 1;
  return a.m < 0n ? -1 : a.m > 0n ? 1 : 0;
}

/** Compares two reals: -1, 0 or 1. */
function compareReal(a: Real, b: Real): number {
  if (isInt(a) && isInt(b)) return a < b ? -1 : a > b ? 1 : 0;
  if (isRat(a) && isRat(b)) {
    const [an, ad] = isInt(a) ? [a, 1n] : [a.n, a.d];
    const [bn, bd] = isInt(b) ? [b, 1n] : [b.n, b.d];
    const l = an * bd;
    const r = bn * ad;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return sign(realSub(a, b));
}

function realAdd(a: Real, b: Real): Real {
  if (isInt(a) && isInt(b)) return a + b;
  if (isZero(a)) return isFloat(a) && isRat(b) ? toFloat(b) : b;
  if (isZero(b)) return isFloat(b) && isRat(a) ? toFloat(a) : a;
  if (isRat(a) && isRat(b)) {
    const [an, ad] = isInt(a) ? [a, 1n] : [a.n, a.d];
    const [bn, bd] = isInt(b) ? [b, 1n] : [b.n, b.d];
    return makeFrac(an * bd + bn * ad, ad * bd);
  }
  return addFloat(toFloat(a), toFloat(b));
}

function realNeg(a: Real): Real {
  if (isInt(a)) return -a;
  if (isFrac(a)) return { k: "frac", n: -a.n, d: a.d };
  return { k: "float", m: -a.m, e: a.e };
}

const realSub = (a: Real, b: Real): Real => realAdd(a, realNeg(b));

function realMul(a: Real, b: Real): Real {
  if (isInt(a) && isInt(b)) return a * b;
  if (isZero(a)) return isFloat(b) && isRat(a) ? toFloat(a) : a;
  if (isZero(b)) return isFloat(a) && isRat(b) ? toFloat(b) : b;
  if (isRat(a) && isRat(b)) {
    const [an, ad] = isInt(a) ? [a, 1n] : [a.n, a.d];
    const [bn, bd] = isInt(b) ? [b, 1n] : [b.n, b.d];
    return makeFrac(an * bn, ad * bd);
  }
  const fa = toFloat(a);
  const fb = toFloat(b);
  return makeFloat(fa.m * fb.m, fa.e + fb.e);
}

function realDiv(a: Real, b: Real): Real {
  if (isZero(b)) reject("*Division by zero");
  if (isZero(a)) return isFloat(b) && isRat(a) ? toFloat(a) : a;
  if (isInt(a) && isInt(b)) {
    if (a % b === 0n) return a / b;
    return modes.preferFrac ? makeFrac(a, b) : divFloat(makeFloat(a, 0), makeFloat(b, 0));
  }
  if (isRat(a) && isRat(b)) {
    const [an, ad] = isInt(a) ? [a, 1n] : [a.n, a.d];
    const [bn, bd] = isInt(b) ? [b, 1n] : [b.n, b.d];
    return makeFrac(an * bd, ad * bn);
  }
  return divFloat(toFloat(a), toFloat(b));
}

/** The largest integer not above a real, as math-floor. */
function realFloor(a: Real): bigint {
  if (isInt(a)) return a;
  if (isFrac(a)) {
    const q = a.n / a.d;
    return a.n < 0n && q * a.d !== a.n ? q - 1n : q;
  }
  if (a.e >= 0) return a.m * pow10(a.e);
  const d = pow10(-a.e);
  const q = a.m / d;
  return a.m < 0n && q * d !== a.m ? q - 1n : q;
}

const realCeil = (a: Real): bigint => -realFloor(realNeg(a));
const realTrunc = (a: Real): bigint => (sign(a) < 0 ? realCeil(a) : realFloor(a));

/** Rounds half away from zero to an integer, as math-round. */
function realRound(a: Real): bigint {
  if (isInt(a)) return a;
  if (sign(a) < 0) return -realRound(realNeg(a));
  return realFloor(realAdd(a, { k: "frac", n: 1n, d: 2n }));
}

/** A real as a JavaScript number, for the functions computed in doubles. */
function realToNumber(a: Real): number {
  if (isInt(a)) return Number(a);
  if (isFrac(a)) return Number(a.n) / Number(a.d);
  return Number(`${a.m}e${a.e}`);
}

/** A double as a Calc float of the current precision. */
function numberToFloat(x: number): Flt {
  if (!Number.isFinite(x)) reject("*Floating-point overflow occurred");
  if (x === 0) return makeFloat(0n, 0);
  const [mant, exp] = x.toExponential(Math.min(modes.prec, 17) - 1).split("e");
  const digits = mant.replace(".", "");
  return makeFloat(BigInt(digits), Number(exp) - (digits.replace("-", "").length - 1));
}

/** Rounds a float to the current precision, as math-normalize does after extra precision. */
function normalize(a: Expr): Expr {
  if (isFloat(a)) return makeFloat(a.m, a.e);
  if (isVec(a)) return { k: "vec", xs: a.xs.map(normalize) };
  if (isDate(a)) return { k: "date", v: normalize(a.v) as Real };
  return a;
}

/** Runs `f` with `extra` more digits, rounding its result back, as math-with-extra-prec. */
function withExtraPrec(extra: number, f: () => Expr): Expr {
  const saved = modes;
  modes = { ...modes, prec: modes.prec + extra };
  let r: Expr;
  try {
    r = f();
  } finally {
    modes = saved;
  }
  return normalize(r);
}

// --------------------------------------------------------- Special values

const INF: Var = { k: "var", name: "inf" };
const UINF: Var = { k: "var", name: "uinf" };
const NAN: Var = { k: "var", name: "nan" };
const NEG_INF: Call = { k: "call", f: "neg", args: [INF] };

const call = (f: string, ...args: Expr[]): Call => ({ k: "call", f, args });

/** Whether an expression is an infinity or nan, as math-infinitep. */
function infinitep(a: Expr): boolean {
  while (isCall(a, "neg") || isCall(a, "*") || isCall(a, "/")) a = (a as Call).args[0];
  return isVar(a) && (a.name === "inf" || a.name === "uinf" || a.name === "nan");
}

/** Whether a value is a constant, as math-constp: a number, or a vector of them. */
function constp(a: Expr): boolean {
  if (isReal(a)) return true;
  if (isVec(a)) return a.xs.every(constp);
  return false;
}

// --------------------------------------------------------------- Arithmetic

function add(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) return realAdd(a, b);
  if (isZero(a) && !isVec(b)) return isFloat(a) && isRat(b) ? toFloat(b) : b;
  if (isZero(b) && !isVec(a)) return isFloat(b) && isRat(a) ? toFloat(a) : a;
  if (isVec(a) && isVec(b)) {
    if (a.xs.length !== b.xs.length) reject("*Dimension error");
    return { k: "vec", xs: a.xs.map((x, i) => add(x, b.xs[i])) };
  }
  if (isVec(a) && constp(b) && !isVec(b)) return { k: "vec", xs: a.xs.map((x) => add(x, b)) };
  if (isVec(b) && constp(a) && !isVec(a)) return { k: "vec", xs: b.xs.map((x) => add(a, x)) };
  if (isDate(a) && isReal(b)) return { k: "date", v: realAdd(a.v, b) };
  if (isDate(b) && isReal(a)) return { k: "date", v: realAdd(a, b.v) };
  if (isDate(a) || isDate(b)) reject("*Wrong type of argument");
  return addSymbolic(a, b);
}

function addSymbolic(a: Expr, b: Expr): Expr {
  if (isVar(a, "nan") || isVar(b, "nan")) return NAN;
  if (infinitep(a) || infinitep(b)) {
    const ia = infinitep(a);
    const ib = infinitep(b);
    if (ia && ib) return equal(a, b) ? a : NAN;
    return ia ? a : b;
  }
  // Sums lean left and subtract what they can, as math-add-symb-fancy arranges them.
  if (isCall(b, "neg")) return sub(a, b.args[0]);
  if (isReal(b) && sign(b) < 0) return call("-", a, realNeg(b));
  if (isCall(a, "neg") && !isCall(b, "neg")) return sub(b, a.args[0]);
  if (isCall(b, "+")) return add(add(a, b.args[0]), b.args[1]);
  if (isCall(b, "-")) return sub(add(a, b.args[0]), b.args[1]);
  return call("+", a, b);
}

function neg(a: Expr): Expr {
  if (isReal(a)) return realNeg(a);
  if (isVec(a)) return { k: "vec", xs: a.xs.map(neg) };
  if (isCall(a, "neg")) return a.args[0];
  if (isCall(a, "-")) return call("-", a.args[1], a.args[0]);
  if (isCall(a, "+")) return call("-", neg(a.args[0]), a.args[1]);
  if (isVar(a, "nan") || isVar(a, "uinf")) return a;
  return call("neg", a);
}

function sub(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) return realSub(a, b);
  if (isDate(a) && isDate(b)) return realSub(a.v, b.v);
  if (isDate(a) && isReal(b)) return { k: "date", v: realSub(a.v, b) };
  if (!isReal(b) && !isVec(a) && !isVec(b) && !isDate(a) && !isDate(b) && !infinitep(a) && !infinitep(b) && !isCall(b, "neg") && !isCall(b, "+") && !isCall(b, "-")) {
    if (isZero(a)) return neg(b);
    return call("-", a, b);
  }
  return add(a, neg(b));
}

function mul(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) return realMul(a, b);
  if (isZero(a) && !isVec(b) && !infinitep(b)) return isFloat(b) && isRat(a) ? toFloat(a) : a;
  if (isZero(b) && !isVec(a) && !infinitep(a)) return isFloat(a) && isRat(b) ? toFloat(b) : b;
  if (isVec(a) && isVec(b)) {
    // Two vectors' dot product, as Calc multiplies them.
    if (a.xs.length !== b.xs.length) reject("*Dimension error");
    if (a.xs.length === 0) return 0n;
    return a.xs.map((x, i) => mul(x, b.xs[i])).reduce((s, x) => add(s, x));
  }
  if (isVec(a) && !isVec(b)) return { k: "vec", xs: a.xs.map((x) => mul(x, b)) };
  if (isVec(b) && !isVec(a)) return { k: "vec", xs: b.xs.map((x) => mul(a, x)) };
  if (isDate(a) || isDate(b)) reject("*Wrong type of argument");
  if (isVar(a, "nan") || isVar(b, "nan")) return NAN;
  if (a === 1n) return b;
  if (b === 1n) return a;
  if (a === -1n) return neg(b);
  if (b === -1n) return neg(a);
  // A number goes first, as Calc writes 2 abc.
  if (isReal(b) && !isReal(a)) return call("*", b, a);
  return call("*", a, b);
}

function div(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) {
    if (isZero(b)) {
      why ??= "Division by zero";
      return call("/", a, b);
    }
    return realDiv(a, b);
  }
  if (isVec(a) && !isVec(b)) return { k: "vec", xs: a.xs.map((x) => div(x, b)) };
  if (isDate(a) || isDate(b) || isVec(b)) reject("*Wrong type of argument");
  if (isVar(a, "nan") || isVar(b, "nan")) return NAN;
  if (b === 1n) return a;
  if (isZero(a) && !infinitep(b)) return a;
  if (isReal(a) && infinitep(b) && !isVar(b, "nan")) return 0n;
  return call("/", a, b);
}

/** The remainder with the divisor's sign, as Calc's %. */
function mod(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) {
    if (isZero(b)) reject("*Division by zero");
    if (isInt(a) && isInt(b)) {
      const r = a % b;
      return r !== 0n && r < 0n !== b < 0n ? r + b : r;
    }
    return realSub(a, realMul(b, realFloor(realDiv(a, b))));
  }
  return call("%", a, b);
}

/** Integer division rounding down, as Calc's \. */
function idiv(a: Expr, b: Expr): Expr {
  if (isReal(a) && isReal(b)) {
    if (isZero(b)) reject("*Division by zero");
    return realFloor(realDiv(a, b));
  }
  return call("idiv", a, b);
}

function pow(a: Expr, b: Expr): Expr {
  if (isVec(a) || isVec(b) || isDate(a) || isDate(b)) reject("*Wrong type of argument");
  if (!isReal(a) || !isReal(b)) {
    if (b === 1n) return a;
    if (b === 0n) return 1n;
    return call("^", a, b);
  }
  if (isInt(b)) {
    if (b === 0n) return isFloat(a) ? makeFloat(1n, 0) : 1n;
    if (b < 0n) {
      if (isZero(a)) reject("*Division by zero");
      return realDiv(isFloat(a) ? makeFloat(1n, 0) : 1n, pow(a, -b) as Real);
    }
    if (isInt(a)) return a ** b;
    if (isFrac(a)) return makeFrac(a.n ** b, a.d ** b);
    const n = Number(b);
    return makeFloat(a.m ** b, a.e * n);
  }
  // A square root, exactly when it can be.
  if (isFrac(b) && b.n === 1n && b.d === 2n) return sqrt(a);
  if (isFloat(b) && b.m === 5n && b.e === -1) return sqrt(a);
  if (modes.symbolic) reject("*Inexact result");
  const x = realToNumber(a);
  if (x < 0) return call("^", a, b);
  return numberToFloat(x ** realToNumber(b));
}

/** The integer square root of a non-negative integer, rounding down. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

function sqrt(a: Expr): Expr {
  if (!isReal(a)) return call("sqrt", a);
  if (sign(a) < 0) return call("sqrt", a);
  if (isInt(a)) {
    const r = isqrt(a);
    if (r * r === a) return r;
  } else if (isFrac(a)) {
    const n = isqrt(a.n);
    const d = isqrt(a.d);
    if (n * n === a.n && d * d === a.d) return makeFrac(n, d);
  }
  if (modes.symbolic) reject("*Inexact result");
  // Digits enough, from an integer square root, as math-sqrt-float computes.
  const f = toFloat(a);
  let m = f.m;
  let e = f.e;
  const want = 2 * (modes.prec + 2);
  const shift = Math.max(0, want - numdigs(m));
  m *= pow10(shift);
  e -= shift;
  if (e % 2 !== 0) {
    m *= 10n;
    e -= 1;
  }
  return makeFloat(isqrt(m), e / 2);
}

function equal(a: Expr, b: Expr): boolean {
  if (isReal(a) && isReal(b)) return compareReal(a, b) === 0;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a.k !== b.k) return false;
  if (isVar(a) && isVar(b)) return a.name === b.name;
  if (isDate(a) && isDate(b)) return compareReal(a.v, b.v) === 0;
  if (isVec(a) && isVec(b)) return a.xs.length === b.xs.length && a.xs.every((x, i) => equal(x, b.xs[i]));
  if (isCall(a) && isCall(b)) return a.f === b.f && a.args.length === b.args.length && a.args.every((x, i) => equal(x, b.args[i]));
  return false;
}

/** Compares two values: -1, 0, 1, or 2 when they cannot be compared, as math-compare. */
function compare(a: Expr, b: Expr): number {
  if (isReal(a) && isReal(b)) return compareReal(a, b);
  if (isDate(a) && isDate(b)) return compareReal(a.v, b.v);
  if (equal(a, b)) return 0;
  const inf = (x: Expr): number => (isVar(x, "inf") ? 1 : equal(x, NEG_INF) ? -1 : 0);
  if (inf(a) && (isReal(b) || isDate(b))) return inf(a);
  if (inf(b) && (isReal(a) || isDate(a))) return -inf(b);
  return 2;
}

/** Whether a value is a true condition, as math-is-true: a nonzero number. */
function isTrue(a: Expr): boolean {
  return isReal(a) ? !isZero(a) : false;
}

// ---------------------------------------------------------------- Functions

/** The elements of the arguments, vectors flattened, as math-flatten-many-vecs. */
function flatten(args: Expr[]): Expr[] {
  const out: Expr[] = [];
  const walk = (x: Expr): void => {
    if (isVec(x)) x.xs.forEach(walk);
    else if (isReal(x) || isDate(x) || infinitep(x)) out.push(x);
    else reject("*Expected a number or vector");
  };
  args.forEach(walk);
  return out;
}

/**
 * Reduces the arguments' elements with `f`, keeping any that are not
 * numbers apart as Calc does: `whole` of them, combined with the rest.
 */
function reduceMany(f: (a: Expr, b: Expr) => Expr, whole: string, args: Expr[], ident: Expr): Expr {
  let constPart: Expr | undefined;
  const symb: Expr[] = [];
  const saved = modes;
  modes = { ...modes, prec: modes.prec + 2 };
  try {
    for (const a of args) {
      if (isVec(a)) {
        const xs = [...(constPart === undefined ? [] : [constPart]), ...flatVector(a)];
        constPart = xs.length === 0 ? ident : xs.reduce((s, x) => f(s, x));
      } else if (isReal(a) || isDate(a) || infinitep(a)) constPart = constPart === undefined ? a : f(constPart, a);
      else symb.push(a);
    }
  } finally {
    modes = saved;
  }
  if (constPart !== undefined) {
    constPart = normalize(constPart);
    return symb.length ? f(constPart, call(whole, ...symb)) : constPart;
  }
  return symb.length ? call(whole, ...symb) : ident;
}

function flatVector(v: Vec): Expr[] {
  return v.xs.flatMap((x) => (isVec(x) ? flatVector(x) : [x]));
}

function max2(a: Expr, b: Expr): Expr {
  const c = compare(a, b);
  if (c === 2) return call("max", a, b);
  if (c === 0 && isFloat(b) && !isFloat(a)) return b;
  return c < 0 ? b : a;
}

function min2(a: Expr, b: Expr): Expr {
  const c = compare(a, b);
  if (c === 2) return call("min", a, b);
  if (c === 0 && isFloat(b) && !isFloat(a)) return b;
  return c > 0 ? b : a;
}

function lessp(a: Expr, b: Expr): boolean {
  const c = compare(a, b);
  if (c === 2) reject("*Wrong type of argument");
  return c < 0;
}

/** The sample (or population) variance, as math-covariance computes it. */
function variance(args: Expr[], population: boolean): Expr {
  return withExtraPrec(2, () => {
    const xs = flatten(args);
    if (xs.length < (population ? 1 : 2)) reject(population ? "*Must be at least 1 argument" : "*Must be at least 2 arguments");
    const mean = div(xs.reduce((s, x) => add(s, x)), BigInt(-xs.length));
    const diffs = xs.map((x) => add(x, mean));
    const sum = diffs.map((d) => mul(d, d)).reduce((s, x) => add(s, x));
    return div(sum, BigInt(population ? xs.length : xs.length - 1));
  });
}

/** Maps a function of one real over a vector's elements, as Calc's functions map. */
function mapReal(name: string, f: (a: Real) => Expr): (args: Expr[]) => Expr {
  const g = (a: Expr): Expr => {
    if (isVec(a)) return { k: "vec", xs: a.xs.map(g) };
    if (isReal(a)) return f(a);
    return call(name, a);
  };
  return (args) => {
    if (args.length !== 1) reject("*Wrong number of arguments");
    return g(args[0]);
  };
}

/** A function computed in doubles, giving a float, unless its result is exact. */
function inexact(f: (x: number) => number, exact?: (a: Real) => Expr | undefined): (a: Real) => Expr {
  return (a) => {
    const e = exact?.(a);
    if (e !== undefined) return e;
    if (modes.symbolic) reject("*Inexact result");
    const x = f(realToNumber(a));
    if (Number.isNaN(x)) reject("*Argument out of range");
    return numberToFloat(x);
  };
}

const toRadians = (x: number): number => (modes.angle === "deg" ? (x * Math.PI) / 180 : x);
const fromRadians = (x: number): number => (modes.angle === "deg" ? (x * 180) / Math.PI : x);

/** log10 of an exact power of ten is exact, as Calc gives it. */
function exactLog10(a: Real): Expr | undefined {
  if (!isInt(a) || a <= 0n) return undefined;
  const s = a.toString();
  return /^10*$/.test(s) ? BigInt(s.length - 1) : undefined;
}

function roundTo(a: Expr, digits: Expr): Expr {
  if (!isInt(digits)) reject("*Expected an integer");
  if (isVec(a)) return { k: "vec", xs: a.xs.map((x) => roundTo(x, digits)) };
  if (!isReal(a)) return call("round", a, digits);
  const n = Number(digits);
  if (n <= 0) {
    // To tens or hundreds, an integer.
    const scale = pow10(-n);
    return realRound(realDiv(a, scale)) * scale;
  }
  if (isInt(a)) return a;
  if (isFrac(a)) a = toFloat(a);
  const f = a as Flt;
  if (f.e >= -n) return f;
  // Round the mantissa at the digit wanted, half away from zero.
  return makeFloat(scaleRounding(f.m, f.e + n), -n);
}

/** The gamma function, by Lanczos's approximation, for factorials of non-integers. */
function gamma(x: number): number {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a;
}

function factorial(a: Expr): Expr {
  if (isReal(a) && !isInt(a) && sign(a) >= 0) {
    if (modes.symbolic) return call("fact", a);
    return numberToFloat(gamma(realToNumber(a) + 1));
  }
  if (!isInt(a) || a < 0n) return call("fact", a);
  let r = 1n;
  for (let i = 2n; i <= a; i++) r *= i;
  return r;
}

function lt(a: Expr, b: Expr, f: string, want: (c: number) => boolean): Expr {
  const c = compare(a, b);
  if (c === 2) return call(f, a, b);
  return want(c) ? 1n : 0n;
}

/** Calc's functions this part has, by name. Others stay as they are. */
const functions: Record<string, (args: Expr[]) => Expr> = {
  add: ([a, b]) => add(a, b),
  sub: ([a, b]) => sub(a, b),
  mul: ([a, b]) => mul(a, b),
  div: ([a, b]) => div(a, b),
  mod: ([a, b]) => mod(a, b),
  pow: ([a, b]) => pow(a, b),
  neg: ([a]) => neg(a),
  idiv: ([a, b]) => idiv(a, b),
  vsum: (args) => reduceMany(add, "vsum", args, 0n),
  vprod: (args) => reduceMany(mul, "vprod", args, 1n),
  vmax: (args) => reduceMany(max2, "vmax", args, NEG_INF),
  vmin: (args) => reduceMany(min2, "vmin", args, INF),
  max: (args) => (args.length ? args.reduce(max2) : NEG_INF),
  min: (args) => (args.length ? args.reduce(min2) : INF),
  vcount: (args) => {
    let n = 0;
    for (const a of args) {
      if (isVec(a)) n += flatVector(a).length;
      else if (isReal(a) || isDate(a)) n++;
      else reject("*Expected a number or vector");
    }
    return BigInt(n);
  },
  vmean: (args) => {
    const xs = flatten(args);
    if (xs.length === 0) reject("*Must be at least 1 argument");
    return withExtraPrec(2, () => div(xs.reduce((s, x) => add(s, x)), BigInt(xs.length)));
  },
  vmedian: (args) => {
    const xs = flatten(args);
    if (xs.length === 0) reject("*Must be at least 1 argument");
    for (const x of xs) if (!isReal(x)) reject("*Expected a real number");
    const sorted = [...xs].sort((a, b) => (lessp(a, b) ? -1 : lessp(b, a) ? 1 : 0));
    const h = Math.floor(xs.length / 2);
    return xs.length % 2 === 0 ? div(add(sorted[h - 1], sorted[h]), 2n) : sorted[h];
  },
  vvar: (args) => variance(args, false),
  vpvar: (args) => variance(args, true),
  vsdev: (args) => sqrt(variance(args, false)),
  vpsdev: (args) => sqrt(variance(args, true)),
  vgmean: (args) => {
    const xs = flatten(args);
    if (xs.length === 0) reject("*Must be at least 1 argument");
    return withExtraPrec(2, () => {
      const p = xs.reduce((s, x) => mul(s, x));
      return xs.length === 2 ? sqrt(p) : pow(p, makeFrac(1n, BigInt(xs.length)));
    });
  },
  vhmean: (args) => {
    const xs = flatten(args);
    if (xs.length === 0) reject("*Must be at least 1 argument");
    return withExtraPrec(2, () => div(BigInt(xs.length), xs.map((x) => div(1n, x)).reduce((s, x) => add(s, x))));
  },
  vlen: ([a]) => (isVec(a) ? BigInt(a.xs.length) : 0n),
  rev: ([a]) => (isVec(a) ? { k: "vec", xs: [...a.xs].reverse() } : reject("*Expected a vector")),
  sort: ([a]) => (isVec(a) ? { k: "vec", xs: [...a.xs].sort((x, y) => (lessp(x, y) ? -1 : lessp(y, x) ? 1 : 0)) } : reject("*Expected a vector")),
  rsort: ([a]) => (isVec(a) ? { k: "vec", xs: [...a.xs].sort((x, y) => (lessp(y, x) ? -1 : lessp(x, y) ? 1 : 0)) } : reject("*Expected a vector")),
  abs: mapReal("abs", (a) => (sign(a) < 0 ? realNeg(a) : a)),
  sign: mapReal("sign", (a) => BigInt(sign(a))),
  floor: mapReal("floor", (a) => realFloor(a)),
  ceil: mapReal("ceil", (a) => realCeil(a)),
  trunc: mapReal("trunc", (a) => realTrunc(a)),
  ffloor: mapReal("ffloor", (a) => (isFloat(a) ? makeFloat(realFloor(a), 0) : realFloor(a))),
  fceil: mapReal("fceil", (a) => (isFloat(a) ? makeFloat(realCeil(a), 0) : realCeil(a))),
  round: (args) => {
    if (args.length === 2) return roundTo(args[0], args[1]);
    return mapReal("round", (a) => realRound(a))(args);
  },
  fround: mapReal("fround", (a) => (isFloat(a) ? makeFloat(realRound(a), 0) : realRound(a))),
  sqrt: ([a]) => sqrt(a),
  sqr: ([a]) => mul(a, a),
  inv: ([a]) => div(1n, a),
  exp: mapReal("exp", inexact(Math.exp, (a) => (isZero(a) && isInt(a) ? 1n : a === 1n && modes.symbolic ? { k: "var", name: "e" } : undefined))),
  ln: mapReal("ln", inexact(Math.log, (a) => (a === 1n ? 0n : undefined))),
  log10: mapReal("log10", inexact(Math.log10, exactLog10)),
  log: (args) => {
    if (args.length === 1) return functions.ln(args);
    const [a, b] = args;
    if (!isReal(a) || !isReal(b)) return call("log", a, b);
    if (isInt(a) && isInt(b) && a > 0n && b > 1n) {
      let n = 0n;
      let p = 1n;
      while (p < a) {
        p *= b;
        n++;
      }
      if (p === a) return n;
    }
    if (modes.symbolic) reject("*Inexact result");
    return numberToFloat(Math.log(realToNumber(a)) / Math.log(realToNumber(b)));
  },
  sin: mapReal("sin", inexact((x) => Math.sin(toRadians(x)), (a) => (isZero(a) ? a : undefined))),
  cos: mapReal("cos", inexact((x) => Math.cos(toRadians(x)), (a) => (a === 0n ? 1n : undefined))),
  tan: mapReal("tan", inexact((x) => Math.tan(toRadians(x)), (a) => (isZero(a) ? a : undefined))),
  arcsin: mapReal("arcsin", inexact((x) => fromRadians(Math.asin(x)), (a) => (isZero(a) ? a : undefined))),
  arccos: mapReal("arccos", inexact((x) => fromRadians(Math.acos(x)))),
  arctan: mapReal("arctan", inexact((x) => fromRadians(Math.atan(x)), (a) => (isZero(a) ? a : undefined))),
  sinh: mapReal("sinh", inexact(Math.sinh)),
  cosh: mapReal("cosh", inexact(Math.cosh)),
  tanh: mapReal("tanh", inexact(Math.tanh)),
  fact: ([a]) => factorial(a),
  percent: ([a]) => div(a, 100n),
  lt: ([a, b]) => lt(a, b, "lt", (c) => c < 0),
  gt: ([a, b]) => lt(a, b, "gt", (c) => c > 0),
  leq: ([a, b]) => lt(a, b, "leq", (c) => c <= 0),
  geq: ([a, b]) => lt(a, b, "geq", (c) => c >= 0),
  eq: ([a, b]) => lt(a, b, "eq", (c) => c === 0),
  neq: ([a, b]) => lt(a, b, "neq", (c) => c !== 0),
  land: ([a, b]) => (isZero(a) ? a : isZero(b) ? b : isTrue(a) ? b : isTrue(b) ? a : call("land", a, b)),
  lor: ([a, b]) => (isZero(a) ? b : isZero(b) ? a : isTrue(a) ? a : isTrue(b) ? b : call("lor", a, b)),
  lnot: ([a]) => (isZero(a) ? 1n : isTrue(a) ? 0n : call("lnot", a)),
  date: (args) => {
    if (args.length === 1) {
      const [a] = args;
      if (isDate(a)) return a.v;
      if (isReal(a)) return { k: "date", v: a };
      return call("date", a);
    }
    const [y, m, d] = args;
    if (!isInt(y) || !isInt(m) || !isInt(d)) return call("date", ...args);
    return { k: "date", v: BigInt(absoluteDay(Number(y), Number(m), Number(d))) };
  },
  year: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).year) : call("year", a)),
  month: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).month) : call("month", a)),
  day: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).day) : call("day", a)),
  weekday: ([a]) => (isDate(a) ? mod(realFloor(a.v), 7n) : call("weekday", a)),
  hour: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).hour) : call("hour", a)),
  minute: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).minute) : call("minute", a)),
  second: ([a]) => (isDate(a) ? BigInt(dateToDt(a.v).second) : call("second", a)),
  if: ([c, a, b]) => (isZero(c) ? b : isTrue(c) ? a : call("if", c, a, b)),
};

/** The operators' functions, as math-normalize maps them. */
const operators: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "^": "pow",
  neg: "neg",
};

/** Works out a formula, as math-normalize does: its arguments, then the function, or the formula as it is if the function cannot apply. */
function evaluate(a: Expr): Expr {
  if (isFloat(a)) return makeFloat(a.m, a.e);
  if (!isCall(a) && !isVec(a)) return a;
  if (isVec(a)) return { k: "vec", xs: a.xs.map(evaluate) };
  if (a.f === "if" && a.args.length === 3) {
    // Only the branch the condition picks, as Calc evaluates if.
    const c = evaluate(a.args[0]);
    if (isZero(c)) return evaluate(a.args[2]);
    if (isTrue(c)) return evaluate(a.args[1]);
    return call("if", c, evaluate(a.args[1]), evaluate(a.args[2]));
  }
  const args = a.args.map(evaluate);
  const f = functions[operators[a.f] ?? a.f];
  if (!f) return call(a.f, ...args);
  try {
    return f(args);
  } catch (e) {
    if (e instanceof Reject) return call(a.f, ...args);
    throw e;
  }
}

// -------------------------------------------------------------------- Dates

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const leapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function dayInYear(y: number, m: number, d: number): number {
  const days = [31, leapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days.slice(0, m - 1).reduce((s, x) => s + x, 0) + d;
}

/** The day of a Gregorian date, counting from December 31, 1 BC, as math-absolute-from-gregorian-dt. */
function absoluteDay(y: number, m: number, d: number): number {
  const y1 = (y > 0 ? y : y + 1) - 1;
  return y1 * 365 + Math.floor(y1 / 4) - Math.floor(y1 / 100) + Math.floor(y1 / 400) + dayInYear(y, m, d);
}

interface Dt {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  hasTime: boolean;
}

/** A date form's day and time, as math-date-to-dt. */
function dateToDt(v: Real): Dt {
  const date = realFloor(v);
  const time = realRound(realMul(realSub(v, date), 86400n));
  let n = Number(date);
  let year = Math.floor(n / 365.2425) + 1;
  while (absoluteDay(year, 1, 1) > n) year--;
  while (absoluteDay(year + 1, 1, 1) <= n) year++;
  let month = 1;
  while (month < 12 && absoluteDay(year, month + 1, 1) <= n) month++;
  const day = n - absoluteDay(year, month, 1) + 1;
  n = Number(time);
  return { year, month, day, hour: Math.floor(n / 3600), minute: Math.floor(n / 60) % 60, second: n % 60, hasTime: !isInt(v) };
}

/** A date as Org's calc-date-format writes it: YYYY-MM-DD Www, and hh:mm when it has a time. */
function formatDate(v: Real): string {
  const dt = dateToDt(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = dt.year > 0 && dt.year < 100 ? `+${dt.year}` : String(dt.year);
  const weekday = WEEKDAYS[Number(mod(realFloor(v), 7n))].slice(0, 3);
  return `${year}-${pad(dt.month)}-${pad(dt.day)} ${weekday}${dt.hasTime ? ` ${pad(dt.hour)}:${pad(dt.minute)}` : ""}`;
}

/** Reads a date as Org writes one, 2024-01-05 Fri 10:30, with the weekday and time optional. */
function parseDate(s: string): DateForm | undefined {
  const m = /^\s*(\d{1,4})-(\d{1,2})-(\d{1,2})(?:\s+([A-Za-z]+)\.?)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  if (m[4] && !WEEKDAYS.some((w) => w.toLowerCase().startsWith(m[4].toLowerCase())) && !MONTHS.some((w) => w.toLowerCase().startsWith(m[4].toLowerCase()))) return undefined;
  const day = BigInt(absoluteDay(y, mo, d));
  if (m[5] === undefined) return { k: "date", v: day };
  const secs = BigInt(Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7] ?? 0));
  return { k: "date", v: realAdd(day, realDiv(secs, 86400n)) };
}

// ------------------------------------------------------------------ Reading

/** The operators, as math-standard-ops lists them with multiplication's precedence: left and right precedences, -1 for none. */
const OPERS: [string, string, number, number][] = [
  ["*", "*", 196, 195],
  ["2x", "*", 196, 195],
  ["_", "subscr", 1200, 1201],
  ["%", "percent", 1100, -1],
  ["u!", "lnot", -1, 1000],
  ["!!", "dfact", 210, -1],
  ["!", "fact", 210, -1],
  ["^", "^", 201, 200],
  ["**", "^", 201, 200],
  ["u+", "ident", -1, 197],
  ["u-", "neg", -1, 197],
  ["/", "/", 190, 191],
  ["%", "%", 190, 191],
  ["\\", "idiv", 190, 191],
  ["+", "+", 180, 181],
  ["-", "-", 180, 181],
  ["|", "|", 170, 171],
  ["<", "lt", 160, 161],
  [">", "gt", 160, 161],
  ["<=", "leq", 160, 161],
  [">=", "geq", 160, 161],
  ["=", "eq", 160, 161],
  ["==", "eq", 160, 161],
  ["!=", "neq", 160, 161],
  ["&&", "land", 110, 111],
  ["||", "lor", 100, 101],
  ["?", "if", 91, 90],
];

const findOp = (data: string, from = 0): number => OPERS.findIndex((o, i) => i >= from && o[0] === data);

type TokenKind = "number" | "symbol" | "punc" | "string" | "end";

class Reader {
  pos = 0;
  oldPos = 0;
  kind: TokenKind = "end";
  data = "";

  private s: string;

  constructor(s: string) {
    this.s = s;
    this.next();
  }

  next(): void {
    const s = this.s;
    while (this.pos < s.length && " \n\t".includes(s[this.pos])) this.pos++;
    this.oldPos = this.pos;
    if (this.pos >= s.length) {
      this.kind = "end";
      this.data = "\0";
      return;
    }
    const rest = s.slice(this.pos);
    let m: RegExpExecArray | null;
    const ch = s[this.pos];
    if (/[a-zA-Zα-ωΑ-Ω]/.test(ch)) {
      m = /^[a-zA-Zα-ωΑ-Ω0-9'#]*/.exec(rest)!;
      this.kind = "symbol";
      this.data = m[0].replace(/[#_]/g, "-");
    } else if (/[0-9]/.test(ch) || /^\.[0-9]/.test(rest)) {
      m = /^(?:\d+#[0-9a-zA-Z.:]+|\d+:[\d:]+|[0-9.]+(?:[eE][-+_]?[0-9]+)?)/.exec(rest)!;
      this.kind = "number";
      this.data = m[0];
    } else if ((m = /^(?:~=|<=|>=|<>|\/=|\+\/-|\\dots|\\ldots|\*\*|<<|>>|==|!=|&&&|\|\|\||!!!|&&|\|\||!!|:=|::|=>)/.exec(rest))) {
      this.kind = "punc";
      this.data = m[0];
    } else if (ch === '"' && (m = /^"((?:[^"\\]|\\.)*)("|$)/.exec(rest))) {
      this.kind = "string";
      this.data = m[1];
    } else {
      this.kind = "punc";
      this.data = ch;
      m = [ch] as unknown as RegExpExecArray;
    }
    this.pos += m[0].length;
  }

  /** Whether the current token is `t`; a method, so TypeScript does not narrow the token across next(). */
  is(t: string): boolean {
    return this.data === t;
  }

  isEnd(): boolean {
    return this.kind === "end";
  }

  fail(message: string): never {
    throw new CalcSyntax(message, this.oldPos);
  }

  /** Whether a factor follows the current token, as math-factor-after looks. */
  factorAfter(): boolean {
    const saved = { pos: this.pos, oldPos: this.oldPos, kind: this.kind, data: this.data };
    this.next();
    const r =
      this.kind === "number" ||
      this.kind === "symbol" ||
      this.kind === "string" ||
      (["-", "+", "!", "|", "/"].includes(this.data) && findOp(`u${this.data}`) >= 0) ||
      (findOp(this.data) >= 0 && OPERS[findOp(this.data)][2] === -1) ||
      ["(", "[", "{"].includes(this.data);
    Object.assign(this, saved);
    return r;
  }

  exprList(): Expr[] {
    const xs = [this.level(0)];
    while (this.is(",")) {
      this.next();
      xs.push(this.level(0));
    }
    return xs;
  }

  level(prec: number, term?: string): Expr {
    let x = this.factor();
    for (;;) {
      let i = findOp(this.data);
      let op = i >= 0 ? OPERS[i] : undefined;
      if (op && op[2] !== -1) {
        const j = findOp(this.data, i + 1);
        if (j >= 0) {
          const op2 = OPERS[j];
          if ((op[3] === -1) === (op2[3] !== -1) && (op2[3] === -1) === !this.factorAfter()) op = op2;
        }
      } else if ((this.kind === "number" || this.kind === "symbol" || this.is("(") || this.is("[")) && !(op && op[2] === -1)) {
        // Two factors side by side multiply.
        op = OPERS[findOp("2x")];
      } else op = undefined;
      if (!op || (term !== undefined && this.data === term) || op[2] < prec) return x;
      if (op[0] !== "2x") this.next();
      if (op[1] === "if") {
        const then = this.level(0);
        if (!this.is(":")) this.fail("Expected `:'");
        this.next();
        x = call("if", x, then, this.level(op[3]));
      } else if (op[3] === -1) x = op[1] === "ident" ? x : call(op[1], x);
      else x = call(op[1], x, this.level(op[3], term));
    }
  }

  factor(): Expr {
    if (this.kind === "number") {
      const n = readNumber(this.data);
      if (n === undefined) {
        this.oldPos = this.pos;
        this.fail("Bad format");
      }
      this.next();
      return n;
    }
    if (["-", "+", "!", "|", "/"].includes(this.data) && this.kind === "punc") {
      const i = findOp(`u${this.data}`);
      if (i < 0) this.fail("Expected a number");
      const op = OPERS[i];
      this.next();
      const val = this.level(op[3]);
      if (op[1] === "ident") return val;
      if (op[0] === "u-" && isReal(val)) return realNeg(val);
      return call(op[1], val);
    }
    if (this.kind === "symbol") {
      const name = this.data;
      this.next();
      if (this.is("(")) {
        this.next();
        const args = this.is(")") || this.isEnd() ? [] : this.exprList();
        if (!this.is(")") && !this.isEnd()) this.fail("Expected `)'");
        this.next();
        return call(name, ...args);
      }
      return { k: "var", name };
    }
    if (this.is("(")) {
      this.next();
      let x = this.level(0);
      if (this.is(",")) this.fail("Complex numbers are not supported");
      if (!this.is(")") && !this.isEnd()) this.fail("Expected `)'");
      this.next();
      return x;
    }
    if (this.kind === "string") {
      const codes = [...this.data.replace(/\\(.)/g, "$1")].map((c) => BigInt(c.codePointAt(0)!));
      this.next();
      return { k: "vec", xs: codes };
    }
    if (this.is("[")) {
      this.next();
      let xs: Expr[] = [];
      if (!this.is("]")) {
        xs = this.exprList();
        if (this.is(";")) {
          // Rows of a matrix.
          const rows: Expr[] = [{ k: "vec", xs }];
          while (this.is(";")) {
            this.next();
            rows.push({ k: "vec", xs: this.exprList() });
          }
          xs = rows;
        }
      }
      if (!this.is("]")) this.fail("Expected `]'");
      this.next();
      return { k: "vec", xs };
    }
    if (this.is("<")) {
      const close = this.s.indexOf(">", this.pos);
      const d = parseDate(this.s.slice(this.pos, close < 0 ? undefined : close));
      if (!d) this.fail("Expected a date");
      this.pos = close < 0 ? this.s.length : close + 1;
      this.next();
      return d;
    }
    this.fail("Expected a number");
  }
}

/** Reads a number token, as math-read-number. */
function readNumber(s: string): Expr | undefined {
  let m: RegExpExecArray | null;
  if (/^\d+$/.test(s)) return BigInt(s);
  if ((m = /^(\d*):(\d*):(\d*)$/.exec(s))) {
    const int = m[1] ? BigInt(m[1]) : 0n;
    const num = m[2] ? BigInt(m[2]) : 1n;
    const den = m[2] ? BigInt(m[3] || "0") : 1n;
    return den === 0n ? undefined : makeFrac(num + int * den, den);
  }
  if ((m = /^(\d*):(\d*)$/.exec(s))) {
    const num = m[1] ? BigInt(m[1]) : 1n;
    const den = m[1] ? BigInt(m[2] || "0") : 1n;
    return den === 0n ? undefined : makeFrac(num, den);
  }
  if ((m = /^(\d+)#([0-9a-zA-Z]+)$/.exec(s))) {
    const radix = Number(m[1]);
    if (radix < 2 || radix > 36) return undefined;
    let n = 0n;
    for (const c of m[2].toLowerCase()) {
      const d = parseInt(c, 36);
      if (d >= radix) return undefined;
      n = n * BigInt(radix) + BigInt(d);
    }
    return n;
  }
  if ((m = /^(\d*)\.(\d*)$/.exec(s))) {
    if (!m[1] && !m[2]) return undefined;
    return makeFloat(BigInt((m[1] || "0") + m[2]), -m[2].length);
  }
  if ((m = /^(.*)[eE]([-+_]?\d+)$/.exec(s))) {
    const mant = m[1] ? readNumber(m[1]) : 1n;
    const exp = Number(m[2].replace("_", "-"));
    if (mant === undefined || !isReal(mant) || Math.abs(exp) >= 4000000) return undefined;
    const f = toFloat(mant);
    return makeFloat(f.m, f.e + exp);
  }
  return undefined;
}

// ------------------------------------------------------------------ Writing

/** Writes a number, as math-format-number does in the float format of the modes. */
function formatNumber(a: Real): string {
  if (isInt(a)) return a.toString();
  if (isFrac(a)) return `${a.n}:${a.d}`;
  if (a.m < 0n) return `-${formatNumber({ k: "float", m: -a.m, e: a.e })}`;
  let { m: mant, e: exp } = a;
  const [fmt, figs0] = modes.floatFormat;
  let figs = figs0;
  const point = ".";
  if (fmt === "fix" && (figs < 0 ? ((figs = -figs), true) : exp + numdigs(mant) > -figs)) {
    mant = scaleRounding(mant, exp + figs);
    let str = mant.toString();
    if (str.length <= figs) str = "0".repeat(figs + 1 - str.length) + str;
    return figs > 0 ? `${str.slice(0, str.length - figs)}${point}${str.slice(str.length - figs)}` : `${str}${point}`;
  }
  if (figs < 0) figs += modes.prec;
  if (figs > 0) {
    const adj = figs - numdigs(mant);
    if (adj < 0) {
      mant = scaleRounding(mant, adj);
      exp -= adj;
    }
  }
  let str = mant.toString();
  const len = str.length;
  const dpos = exp + len;
  if (fmt === "float" && dpos <= modes.prec && dpos >= -3 + 2) {
    if (dpos === 0) return `0${point}${str}`;
    if (exp <= 0 && dpos > 0) return `${str.slice(0, dpos)}${point}${str.slice(dpos)}`;
    if (exp > 0) return `${str}${"0".repeat(exp)}${point}`;
    return `0${point}${"0".repeat(-dpos)}${str}`;
  }
  const eadj = exp + len;
  const scale = fmt === "eng" ? 1 + (((eadj + 300002) % 3) + 3) % 3 : 1;
  if (scale > str.length) str += "0".repeat(scale - str.length);
  if (scale < str.length) str = `${str.slice(0, scale)}${point}${str.slice(scale)}`;
  return `${str}e${eadj - scale}`;
}

const NAMED_OPS: Record<string, [string, number, number]> = {
  "^": ["^", 201, 200],
  "*": ["*", 196, 195],
  "/": ["/", 190, 191],
  "%": ["%", 190, 191],
  idiv: ["\\", 190, 191],
  "+": ["+", 180, 181],
  "-": ["-", 180, 181],
  "|": ["|", 170, 171],
  lt: ["<", 160, 161],
  gt: [">", 160, 161],
  leq: ["<=", 160, 161],
  geq: [">=", 160, 161],
  eq: ["=", 160, 161],
  neq: ["!=", 160, 161],
  land: ["&&", 110, 111],
  lor: ["||", 100, 101],
};

/** The integer-valued numbers, for writing n/0 without spaces, as math-num-integerp. */
function numIntegerp(a: Expr): boolean {
  if (isInt(a)) return true;
  return isFloat(a) && (a.e >= 0 || a.m % pow10(-a.e) === 0n);
}

/** The first and last terms of a product, as math-prod-first-term and math-prod-last-term. */
function prodLast(x: Expr): Expr {
  while (isCall(x, "*")) x = x.args[1];
  return x;
}

/** Writes a value as Calc's flat language composes it, at precedence `prec`. */
function compose(a: Expr, prec: number, divArg = false): string {
  if (isReal(a)) return formatNumber(a);
  if (isVar(a)) return a.name;
  if (isDate(a)) return `<${formatDate(a.v)}>`;
  if (isVec(a)) return `[${a.xs.map((x) => compose(x, 0)).join(", ")}]`;
  const paren = (s: string) => `(${s})`;
  if (a.f === "if" && a.args.length === 3) {
    if (prec > 90) return paren(compose(a, 0));
    return `${compose(a.args[0], 91)} ? ${compose(a.args[1], 0)} : ${compose(a.args[2], 90)}`;
  }
  const op = NAMED_OPS[a.f];
  if (op && a.args.length === 2) {
    const [sym, left, right] = op;
    if (prec > Math.min(left, right) || (divArg && a.f === "*")) return paren(compose(a, 0));
    let lhs = compose(a.args[0], left);
    const rhs = compose(a.args[1], right, a.f === "/");
    if (sym === "^" && lhs.startsWith("-")) lhs = paren(lhs);
    if (a.f === "*") {
      const nextc = rhs[0];
      if (/[a-zA-Zα-ωΑ-Ω0-9._#([{]/.test(nextc) && !(isVar(prodLast(a.args[0])) && nextc === "(")) return `${lhs} ${rhs}`;
      return `${lhs}*${rhs}`;
    }
    if (sym === "^" || (a.f === "/" && numIntegerp(a.args[0]) && isInt(a.args[1]))) return `${lhs}${sym}${rhs}`;
    return `${lhs} ${sym} ${rhs}`;
  }
  if (a.f === "neg" && a.args.length === 1) {
    if (prec > 197) return paren(compose(a, 0));
    return `-${compose(a.args[0], 197)}`;
  }
  if (a.f === "lnot" && a.args.length === 1) {
    if (prec > 1000) return paren(compose(a, 0));
    return `!${compose(a.args[0], 1000)}`;
  }
  if ((a.f === "percent" || a.f === "fact") && a.args.length === 1) {
    const [sym, p] = a.f === "percent" ? ["%", 1100] : ["!", 210];
    if (prec > p) return paren(compose(a, 0));
    return `${compose(a.args[0], p)}${sym}`;
  }
  const names: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod", "^": "pow", neg: "neg", "|": "vconcat" };
  return `${names[a.f] ?? a.f}(${a.args.map((x) => compose(x, 0)).join(", ")})`;
}

// ------------------------------------------------------------------ calc-eval

/**
 * Evaluates a formula as calc-eval does, returning its result as Calc
 * writes it, or for a formula Calc cannot read, the position and message
 * of the error. With `num`, a result that is not a number is an error too,
 * as calc-eval's num separator makes it.
 */
export function calcEval(formula: string, m: Partial<CalcModes> = {}, num = false): string | [number, string] {
  const saved = modes;
  modes = { ...defaultModes, ...m };
  why = undefined;
  try {
    let exprs: Expr[];
    try {
      const r = new Reader(formula);
      exprs = r.exprList();
      if (r.kind !== "end") r.fail("Syntax error");
    } catch (e) {
      if (e instanceof CalcSyntax) return [e.pos, e.message];
      throw e;
    }
    const results = exprs.map(evaluate);
    if (num) {
      if (results.length !== 1) return [0, "Single value expected"];
      if (!constp(results[0])) return [0, why ?? "Number expected"];
    }
    return results.map((x) => compose(x, 0)).join(", ");
  } finally {
    modes = saved;
  }
}

/** Calc's modes from a plist of mode variables and values, as calc-eval takes them after the formula. */
export function modesFromPlist(plist: e8.Value[]): Partial<CalcModes> {
  const m: Partial<CalcModes> = {};
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const name = String(plist[i]);
    const v = plist[i + 1];
    if (name === "calc-internal-prec" && typeof v === "number") m.prec = Math.max(3, Math.trunc(v));
    else if (name === "calc-float-format" && Array.isArray(v) && ["float", "fix", "sci", "eng"].includes(String(v[0]))) {
      m.floatFormat = [String(v[0]) as CalcModes["floatFormat"][0], Number(v[1] ?? 0)];
    } else if (name === "calc-angle-mode") m.angle = String(v) === "rad" ? "rad" : "deg";
    else if (name === "calc-prefer-frac") m.preferFrac = v !== null && v !== false;
    else if (name === "calc-symbolic-mode") m.symbolic = v !== null && v !== false;
  }
  return m;
}

// calc-eval for code, as Org calls it: the formula alone, or a list of it
// and Calc's modes as a plist; with the separator num, only a number will
// do. An error comes back as a list of its position and message.
e8.defun("calc-eval", (str: e8.Value, separator?: e8.Value) => {
  const [formula, plist] = Array.isArray(str) ? [String(str[0]), str.slice(1)] : [String(str), []];
  const r = calcEval(formula, modesFromPlist(plist), separator === "num");
  return typeof r === "string" ? r : [r[0], r[1]];
});
