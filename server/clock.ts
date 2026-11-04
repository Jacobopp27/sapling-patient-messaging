// Scenario clock. "Now" is a setting (never the machine clock) so the walkthrough can change it.
// Dates are plain "YYYY-MM-DD" strings in clinic time; date math is done in UTC to avoid DST surprises.

export const CLINIC_TZ = 'America/Los_Angeles';
export const DEFAULT_NOW = '2026-11-04T10:00:00-08:00';

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export type DayWindow = 'morning' | 'afternoon' | 'any';
export const WINDOWS: Record<Exclude<DayWindow, 'any'>, { from: string; to: string }> = {
  morning: { from: '00:00', to: '12:00' },
  afternoon: { from: '12:00', to: '23:59' },
};

export interface LocalNow { date: string; weekday: number; time: string }

/** Clinic-local date, weekday (0 = Sunday) and HH:MM for an ISO timestamp. */
export function localNow(nowIso: string): LocalNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(nowIso)).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, weekday: weekdayOf(date), time: `${parts.hour}:${parts.minute}` };
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export function weekdayOf(date: string): number {
  return utc(date).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a weekday name to a date after `today`.
 * With an `anchor` (a date Alex already asked for), "Thursday instead" means the Thursday in the
 * anchor's Mon–Sun week, not tomorrow: Tue Nov 10 → Thu Nov 12. Falls back to the next occurrence
 * if that day is already past.
 */
export function resolveWeekday(today: string, weekday: number, anchor?: string): string {
  if (anchor) {
    const monday = addDays(anchor, -((weekdayOf(anchor) + 6) % 7));
    const candidate = addDays(monday, (weekday + 6) % 7);
    if (candidate > today) return candidate;
  }
  const ahead = (weekday - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

export function windowOf(time: string): DayWindow {
  return time < WINDOWS.morning.to ? 'morning' : 'afternoon';
}

export function inWindow(time: string, window: DayWindow): boolean {
  if (window === 'any') return true;
  return time >= WINDOWS[window].from && time < WINDOWS[window].to;
}

/** "Tuesday, Nov 10" (add the year when it isn't the current one). */
export function formatDate(date: string, today?: string): string {
  const withYear = today !== undefined && date.slice(0, 4) !== today.slice(0, 4);
  return utc(date).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** "14:00" → "2:00 p.m." */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

// --- clinic calendar ----------------------------------------------------------
// The FAQ says the clinic is "closed weekends and federal holidays". The federal holidays are set by
// law (5 U.S.C. 6103), so they are computed, not guessed. A holiday on a Saturday is observed on the
// Friday before and one on a Sunday on the Monday after, as for federal offices.

/** The nth (1-based) weekday of a month, or the last one when n = -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  if (n > 0) return addDays(first, ((weekday - weekdayOf(first) + 7) % 7) + (n - 1) * 7);
  const last = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1);
  return addDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

function observed(date: string): string {
  const wd = weekdayOf(date);
  return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, 1) : date;
}

export function federalHolidays(year: number): Record<string, string> {
  const fixed = (m: number, d: number) => observed(`${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return {
    [fixed(1, 1)]: "New Year's Day",
    [nthWeekday(year, 1, 1, 3)]: 'Martin Luther King Jr. Day',
    [nthWeekday(year, 2, 1, 3)]: "Washington's Birthday",
    [nthWeekday(year, 5, 1, -1)]: 'Memorial Day',
    [fixed(6, 19)]: 'Juneteenth',
    [fixed(7, 4)]: 'Independence Day',
    [nthWeekday(year, 9, 1, 1)]: 'Labor Day',
    [nthWeekday(year, 10, 1, 2)]: 'Columbus Day',
    [fixed(11, 11)]: 'Veterans Day',
    [nthWeekday(year, 11, 4, 4)]: 'Thanksgiving Day',
    [fixed(12, 25)]: 'Christmas Day',
  };
}

/** The federal holiday observed on a date ("Veterans Day"), if any. */
export function federalHoliday(date: string): string | undefined {
  const year = Number(date.slice(0, 4));
  // Jan 1 falling on a Saturday is observed on Dec 31 of the year before.
  return federalHolidays(year)[date] ?? federalHolidays(year + 1)[date];
}
