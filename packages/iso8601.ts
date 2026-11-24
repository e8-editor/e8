// ISO 8601 dates and times, after iso8601.el: enough to read the
// strings parse-time-string reads through iso8601-parse.

/**
 * A time taken apart, as decode-time gives it: second, minute, hour, day,
 * month, year and weekday, each undefined where the text did not say.
 */
export type DecodedTime = [
  second: number | undefined,
  minute: number | undefined,
  hour: number | undefined,
  day: number | undefined,
  month: number | undefined,
  year: number | undefined,
  weekday: number | undefined,
];

const YEAR = "[+-]?[0-9][0-9][0-9][0-9]";
const FULL_DATE = `(${YEAR})-?([0-9][0-9])-?([0-9][0-9])`;
const WITHOUT_DAY = `(${YEAR})-([0-9][0-9])`;
const OUTDATED_DATE = "--([0-9][0-9])-?([0-9][0-9])";
const OUTDATED_REDUCED = "---?([0-9][0-9])";
const WEEK_DATE = `(${YEAR})-?W([0-9][0-9])-?([0-9])?`;
const ORDINAL_DATE = `(${YEAR})-?([0-9][0-9][0-9])`;
const TIME = "([0-9][0-9]):?([0-9][0-9])?:?([0-9][0-9])?[.,]?([0-9]*)";
const ZONE = "(Z|([+-])([0-9][0-9]):?([0-9][0-9])?)";

/** The alternatives without their groups, as iso8601--concat-regexps joins them. */
const ungrouped = (re: string): string => `(?:${re.replace(/\((?!\?)/g, "(?:")})`;
const DATE = [YEAR, FULL_DATE, WITHOUT_DAY, OUTDATED_DATE, OUTDATED_REDUCED, WEEK_DATE, ORDINAL_DATE].map(ungrouped).join("|");
const COMBINED = `(${DATE})(?:T(${TIME.replace(/\((?!\?)/g, "(?:")})(${ZONE.replace(/\((?!\?)/g, "(?:")})?)?`;

/**
 * The whole of a string matched, as iso8601--match does it; whatever the
 * case, as string-match with case-fold-search, as it is in Org's buffers.
 */
function whole(re: string, s: string): RegExpExecArray | null {
  return new RegExp(`^(?:${re})$`, "i").exec(s);
}

const leapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The month and day of a year's day, counted from 1, as date-ordinal-to-time gives them. */
function ordinalToDate(year: number, ordinal: number): [number, number] {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(year, 0, ordinal);
  return [t.getUTCMonth() + 1, t.getUTCDate()];
}

function weekdayOf(year: number, month: number, day: number): number {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(year, month - 1, day);
  return t.getUTCDay();
}

const empty = (): DecodedTime => [undefined, undefined, undefined, undefined, undefined, undefined, undefined];

/** A date's text taken apart, as iso8601-parse-date does. */
function parseDatePart(s: string): DecodedTime {
  const t = empty();
  let m: RegExpExecArray | null;
  if (whole(YEAR, s)) t[5] = Number(s);
  else if ((m = whole(FULL_DATE, s))) [t[5], t[4], t[3]] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = whole(WITHOUT_DAY, s))) [t[5], t[4]] = [Number(m[1]), Number(m[2])];
  else if ((m = whole(OUTDATED_DATE, s))) [t[4], t[3]] = [Number(m[1]), Number(m[2])];
  else if ((m = whole(WEEK_DATE, s))) {
    let year = Number(m[1]);
    const week = Number(m[2]);
    const dayOfWeek = m[3] === undefined ? 0 : Number(m[3]);
    const janStart = weekdayOf(year, 1, 4);
    const correction = (janStart === 0 ? 7 : janStart) + 3;
    let ordinal = week * 7 + dayOfWeek - correction;
    // Monday 29 December 2008 is 2009-W01-1; Sunday 3 January 2010 is 2009-W53-7.
    if (ordinal < 1) {
      year -= 1;
      ordinal += leapYear(year) ? 366 : 365;
    } else if (ordinal > (leapYear(year) ? 366 : 365)) {
      ordinal -= leapYear(year) ? 366 : 365;
      year += 1;
    }
    const [month, day] = ordinalToDate(year, ordinal);
    [t[5], t[4], t[3]] = [year, month, day];
  } else if ((m = whole(ORDINAL_DATE, s))) {
    const year = Number(m[1]);
    const [month, day] = ordinalToDate(year, Number(m[2]));
    [t[5], t[4], t[3]] = [year, month, day];
  } else if ((m = whole("--([0-9][0-9])", s))) t[4] = Number(m[1]);
  else if ((m = whole("---([0-9][0-9])", s))) t[3] = Number(m[1]);
  return t;
}

/**
 * An ISO 8601 date, with a time after T if any, taken apart, as
 * iso8601-parse does, or undefined if the string is not one, where it
 * signals wrong-type-argument. The zone is read but left out.
 */
export function iso8601Parse(s: string): DecodedTime | undefined {
  const m = whole(COMBINED, s);
  if (!m) return undefined;
  const t = parseDatePart(m[1]);
  if (m[2] !== undefined) {
    const time = whole(TIME, m[2]) as RegExpExecArray;
    t[2] = Number(time[1]);
    t[1] = time[2] === undefined ? 0 : Number(time[2]);
    t[0] = time[3] === undefined ? 0 : Number(time[3]);
  }
  return t;
}
