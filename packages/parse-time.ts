// Reading dates and times written by people, after parse-time.el.

import { type DecodedTime, iso8601Parse } from "iso8601";

/** Month names and their numbers, as parse-time-months has them. */
export const PARSE_TIME_MONTHS: [string, number][] = [
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
];

/** Day names and their numbers in the week, Sunday 0, as parse-time-weekdays has them. */
export const PARSE_TIME_WEEKDAYS: [string, number][] = [
  ["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6],
  ["sunday", 0], ["monday", 1], ["tuesday", 2], ["wednesday", 3], ["thursday", 4], ["friday", 5], ["saturday", 6],
];

const ZONES = ["z", "ut", "gmt", "pst", "pdt", "mst", "mdt", "cst", "cdt", "est", "edt"];

/**
 * A string's runs of lowercase letters, digits, signs and colons, as
 * parse-time-tokenize splits it: a run of digits alone is a number.
 */
export function parseTimeTokenize(s: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of s.match(/[a-z0-9+\-:]+/g) ?? []) {
    out.push(/^[0-9]+$/.test(m) ? Number(m) : m);
  }
  return out;
}

/** The number in part of a token, as cl-parse-integer reads it, failing as it does on anything else. */
function integerIn(token: string, start: number, end: number): number {
  const part = token.slice(start, end);
  if (!/^\s*[+-]?[0-9]+\s*$/.test(part)) throw new Error(`Not an integer string: ‘${token}’`);
  return Number(part);
}

const timeOf = (t: string, ...cuts: [number, number][]): number[] => cuts.map(([a, b]) => integerIn(t, a, b));

/**
 * The time a string says, taken apart, as parse-time-string does: an ISO
 * 8601 string whole, or else each word put where the first of
 * parse-time-rules that takes it says, each field once. What the string
 * does not say is undefined.
 */
export function parseTimeString(s: string): DecodedTime {
  const iso = iso8601Parse(s);
  if (iso) return iso;
  const t: (number | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  const unset = (slot: number): boolean => t[slot] === undefined;
  const num = (e: string | number, lo: number, hi?: number): e is number => typeof e === "number" && lo <= e && (hi === undefined || e <= hi);
  for (const e of parseTimeTokenize(s.toLowerCase())) {
    const str = typeof e === "string" ? e : undefined;
    if (unset(6) && str !== undefined && PARSE_TIME_WEEKDAYS.some(([n]) => n === str)) {
      t[6] = PARSE_TIME_WEEKDAYS.find(([n]) => n === str)![1];
    } else if (unset(3) && num(e, 1, 31)) {
      t[3] = e;
    } else if (unset(4) && str !== undefined && PARSE_TIME_MONTHS.some(([n]) => n === str)) {
      t[4] = PARSE_TIME_MONTHS.find(([n]) => n === str)![1];
    } else if (unset(5) && num(e, 100)) {
      t[5] = e;
    } else if (unset(2) && str?.length === 8 && str[2] === ":" && str[5] === ":") {
      [t[2], t[1], t[0]] = timeOf(str, [0, 2], [3, 5], [6, 8]);
    } else if (unset(8) && str !== undefined && ZONES.includes(str)) {
      t[8] = 0;
    } else if (unset(8) && str?.length === 5 && (str[0] === "+" || str[0] === "-")) {
      // An offset, +HHMM, its numbers read as Emacs reads them, failing as it does.
      timeOf(str, [3, 5], [1, 3]);
      t[8] = 0;
    } else if (unset(5) && str?.length === 10 && str[4] === "-" && str[7] === "-") {
      [t[5], t[4], t[3]] = timeOf(str, [0, 4], [5, 7], [8, 10]);
    } else if (unset(2) && str?.length === 5 && str[2] === ":") {
      [t[2], t[1]] = timeOf(str, [0, 2], [3, 5]);
      t[0] = 0;
    } else if (unset(2) && str?.length === 4 && str[1] === ":") {
      [t[2], t[1]] = timeOf(str, [0, 1], [2, 4]);
      t[0] = 0;
    } else if (unset(2) && str?.length === 7 && str[1] === ":") {
      [t[2], t[1], t[0]] = timeOf(str, [0, 1], [2, 4], [5, 7]);
    } else if (unset(5) && num(e, 50, 110)) {
      t[5] = 1900 + e;
    } else if (unset(5) && num(e, 0, 49)) {
      t[5] = 2000 + e;
    }
  }
  return t.slice(0, 7) as DecodedTime;
}
