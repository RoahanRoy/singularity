/**
 * Market-hours awareness for the desk loops.
 *
 * The loops otherwise run cycles 24/7 — burning tokens on closed markets and
 * booking paper fills at stale previous-close quotes. This gates trading to the
 * desk's real regular session: weekday, inside the session window (in the
 * market's own timezone, DST-correct via Intl), and not an exchange holiday.
 *
 * Sessions (regular, ignores pre/post):
 *   US  — 09:30–16:00 America/New_York (NYSE/Nasdaq)
 *   IN  — 09:15–15:30 Asia/Kolkata     (NSE)
 *
 * Holiday lists are best-effort and MUST be reviewed each year — weekends and
 * the session window are the primary gate; holidays are a refinement.
 */
type Market = "US" | "IN";

type Session = { tz: string; open: number; close: number; holidays: Set<string> };

// Minutes-since-midnight bounds in the exchange's local time.
const HHMM = (h: number, m: number) => h * 60 + m;

// YYYY-MM-DD holiday dates. Review/extend annually.
const US_HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed — Jul 4 is a Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas Day
];

// NSE trading holidays — representative; verify against the official calendar.
const IN_HOLIDAYS_2026 = [
  "2026-01-26", // Republic Day
  "2026-03-06", // Holi
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-08-15", // Independence Day
  "2026-10-02", // Gandhi Jayanti
  "2026-11-09", // Diwali (approx — confirm Muhurat/holiday dates)
  "2026-12-25", // Christmas
];

const SESSIONS: Record<Market, Session> = {
  US: { tz: "America/New_York", open: HHMM(9, 30), close: HHMM(16, 0), holidays: new Set(US_HOLIDAYS_2026) },
  IN: { tz: "Asia/Kolkata", open: HHMM(9, 15), close: HHMM(15, 30), holidays: new Set(IN_HOLIDAYS_2026) },
};

/** Wall-clock parts in a given timezone. */
function partsIn(tz: string, at: Date): { weekday: number; minutes: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const wdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl can emit "24" for midnight under hour12:false; normalise to 0.
  const hour = Number(p.hour) % 24;
  return {
    weekday: wdays[p.weekday as string] ?? 0,
    minutes: hour * 60 + Number(p.minute),
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

export type MarketState = { open: boolean; label: string };

/** Is the desk's regular session open right now (or at `at`)? */
export function marketState(market: Market, at: Date = new Date()): MarketState {
  const s = SESSIONS[market];
  const { weekday, minutes, ymd } = partsIn(s.tz, at);

  if (weekday === 0 || weekday === 6) return { open: false, label: "weekend" };
  if (s.holidays.has(ymd)) return { open: false, label: `holiday ${ymd}` };
  if (minutes < s.open) return { open: false, label: "pre-market" };
  if (minutes >= s.close) return { open: false, label: "after-hours" };
  return { open: true, label: "open" };
}

export function isMarketOpen(market: Market, at: Date = new Date()): boolean {
  return marketState(market, at).open;
}
