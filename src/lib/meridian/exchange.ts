/**
 * Real-time session state for the active desk's primary exchange.
 *
 * NYSE: 09:30–16:00 ET (UTC-5 std / UTC-4 DST — approximated as fixed −4 here
 * since the status pill doesn't need calendar-grade accuracy). NSE: 09:15–15:30
 * IST (UTC+5:30). Both close on Sat/Sun; holidays are not modelled.
 */
export type ExchangeStatus = "open" | "pre" | "after" | "closed";

function exchangeOffsetMin(market: "US" | "IN"): number {
  if (market === "IN") return 5 * 60 + 30;
  // NYSE in DST (most of the year); a 60-min miss at the DST boundary is fine
  // for a UI pill but documented here so it doesn't surprise a reader.
  return -4 * 60;
}

export function exchangeStatus(market: "US" | "IN", now = new Date()): ExchangeStatus {
  const local = new Date(now.getTime() + exchangeOffsetMin(market) * 60_000);
  const day = local.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return "closed";
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const [open, close, preStart] = market === "IN"
    ? [9 * 60 + 15, 15 * 60 + 30, 9 * 60]
    : [9 * 60 + 30, 16 * 60,       8 * 60];
  const afterEnd = market === "IN" ? 16 * 60 : 20 * 60;
  if (mins >= open && mins < close) return "open";
  if (mins >= preStart && mins < open) return "pre";
  if (mins >= close && mins < afterEnd) return "after";
  return "closed";
}
