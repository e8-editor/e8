// Date trees, after Org's org-datetree.el: headings for a year, its months
// or ISO weeks, and their days, kept in order, found or made for a date, as
// capture files entries under them.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { blankBeforeHeading, headings, subtreeRegion } from "org";
import { lineAt } from "org-macs";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Day {
  year: number;
  month: number;
  day: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** A date's ISO week and the year it belongs to, as calendar-iso-from-absolute gives them. */
export function isoWeek(d: Day): { year: number; week: number } {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const weekday = date.getUTCDay() || 7;
  // The Thursday of the week decides its year.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return { year, week: Math.ceil(((date.getTime() - start) / 86400000 + 1) / 7) };
}

/**
 * Inserts a date tree heading at point, as org-datetree-insert-line: the
 * blank lines before point go, and the heading goes on a line of its own at
 * `level`. Point ends at its start.
 */
function insertLine(level: number, title: string): void {
  let p = e8.point();
  let q = p;
  while (q > e8.pointMin() && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
  if (q < p) {
    e8.deleteRegion(q, p);
    p = q;
  }
  e8.gotoChar(p);
  if (blankBeforeHeading(false)) e8.insert("\n");
  e8.insert(`\n${"*".repeat(level)} ${title}\n`);
  e8.gotoChar(e8.point() - 1);
  e8.gotoChar(e8.lineStart(lineAt()));
}

/**
 * Finds the heading among those from point-min that `re` matches, its
 * group 1 the number to compare with `n`, or makes one in order, as
 * org-datetree--find-create. Returns where the heading starts.
 */
function findCreate(re: RegExp, n: number, level: number, title: string): number {
  const all = headings().filter((h) => h.start >= e8.pointMin() && h.start < e8.pointMax());
  let found: (typeof all)[number] | undefined;
  for (const h of all) {
    const m = re.exec(h.title);
    if (!m) continue;
    found = h;
    if (Number(m[1]) >= n) break;
    found = undefined;
  }
  if (found === undefined) {
    e8.gotoChar(e8.pointMax());
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    insertLine(level, title);
  } else if (Number(re.exec(found.title)![1]) === n) {
    e8.gotoChar(found.start);
  } else {
    e8.gotoChar(found.start);
    insertLine(level, title);
  }
  return e8.point();
}

/** Narrows to the subtree of the heading at point, as org-narrow-to-subtree. */
function narrowToSubtree(): void {
  const all = headings();
  const i = all.findIndex((h) => h.start === e8.point());
  const [start, end] = subtreeRegion(all, i);
  e8.narrowToRegion(start, end);
}

/**
 * Finds or makes the heading for a date in the date tree between start and
 * end, its year headings at `base`, as org-datetree-find-date-create does
 * by day, org-datetree-find-month-create by month and
 * org-datetree-find-iso-week-create by week. Each level below is `step`
 * stars deeper, two with org-odd-levels-only, as org-do-demote makes it.
 * Returns where it starts.
 */
export function findDateCreate(d: Day, grouping: "day" | "month" | "week", base: number, start: number, end: number, step = 1): number {
  return e8.saveRestriction(() => {
    e8.narrowToRegion(start, end);
    e8.gotoChar(e8.pointMin());
    if (grouping === "week") {
      const { year, week } = isoWeek(d);
      findCreate(/^([12][0-9]{3})$/, year, base, String(year));
      narrowToSubtree();
      findCreate(new RegExp(`^${year}-W([0-5][0-9])$`), week, base + step, `${year}-W${two(week)}`);
      narrowToSubtree();
    } else {
      findCreate(/^([12][0-9]{3})$/, d.year, base, String(d.year));
      narrowToSubtree();
      const first = new Date(Date.UTC(d.year, d.month - 1, 1));
      findCreate(new RegExp(`^${d.year}-([01][0-9]) \\w+$`), d.month, base + step, `${d.year}-${two(d.month)} ${MONTHS[first.getUTCMonth()]}`);
      if (grouping === "month") return e8.point();
      narrowToSubtree();
    }
    const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    return findCreate(new RegExp(`^${d.year}-${two(d.month)}-([0123][0-9]) \\w+$`), d.day, base + 2 * step, `${d.year}-${two(d.month)}-${two(d.day)} ${DAYS[weekday]}`);
  });
}
