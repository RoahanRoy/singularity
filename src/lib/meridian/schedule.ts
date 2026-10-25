/**
 * When each desk's cloud routine runs: the weekday Claude routines that call
 * scripts/cloud-run.sh (India trig_017Rq5tWuTCXcjPupHFfpjrG `0 5 * * 1-5`, US
 * trig_012CRFUQyxs7gm5fczyhkzs2 `0 16 * * 1-5`, both UTC). Change these with
 * the routines. A run sweeps approved orders, so it is also when an approval
 * fills.
 */
import type { Market } from "./format";

const RUN_UTC: Record<Market, { hour: number; minute: number }> = {
  IN: { hour: 5, minute: 0 },
  US: { hour: 16, minute: 0 },
};

/** The next scheduled run of the desk's routine after `now`. */
export function nextDeskRun(market: Market, now = new Date()): Date {
  const { hour, minute } = RUN_UTC[market];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** "Mon 21:30" in the viewer's zone, or "today 21:30" / "tomorrow 21:30". */
export function runLabel(d: Date, now = new Date()): string {
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => x.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(d) === day(now)) return `today ${time}`;
  if (day(d) === day(tomorrow)) return `tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
