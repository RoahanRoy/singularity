"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import { ticker, tickerIN, yahooSymbols, type Tick } from "@/lib/meridian/data";
import { useMarket } from "./MarketContext";

export function Panel({
  title,
  meta,
  children,
  className = "",
  bodyClassName = "",
  style,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={"panel " + className} style={style}>
      <div className="panel-head">
        <span className="title">{title}</span>
        {meta != null && <span className="meta">{meta}</span>}
      </div>
      <div className={"panel-body " + bodyClassName}>{children}</div>
    </div>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "amber" | "cyan" | "green" | "red" }) {
  return <span className={"tag " + (tone ?? "")}>{children}</span>;
}

export function UTCClock() {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!t) return <span suppressHydrationWarning>00:00:00 UTC</span>;
  const z = (n: number) => String(n).padStart(2, "0");
  return (
    <span suppressHydrationWarning>
      {z(t.getUTCHours())}:{z(t.getUTCMinutes())}:{z(t.getUTCSeconds())} UTC
    </span>
  );
}

/**
 * Real-time session state for the active desk's primary exchange.
 *
 * NYSE: 09:30–16:00 ET (UTC-5 std / UTC-4 DST — approximated as fixed −4 here
 * since the marquee doesn't need calendar-grade accuracy). NSE: 09:15–15:30
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

/** Local exchange clock — UTC for US (NYSE), IST for India (NSE). */
export function ExchangeClock({ market }: { market: "US" | "IN" }) {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (market !== "IN") return <UTCClock />;
  if (!t) return <span suppressHydrationWarning>00:00:00 IST</span>;
  // IST is UTC+5:30 — derive from the UTC epoch so it's locale-independent.
  const ist = new Date(t.getTime() + (5 * 60 + 30) * 60 * 1000);
  const z = (n: number) => String(n).padStart(2, "0");
  return (
    <span suppressHydrationWarning>
      {z(ist.getUTCHours())}:{z(ist.getUTCMinutes())}:{z(ist.getUTCSeconds())} IST
    </span>
  );
}

export function Sparkline({
  data,
  color = "var(--ink-1)",
  height = 28,
  fill = false,
  last = true,
}: {
  data: number[];
  color?: string;
  height?: number;
  fill?: boolean;
  last?: boolean;
}) {
  const w = 100, h = 100;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * h] as const);
  const d = pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2)).join(" ");
  const dFill = d + ` L${w},${h} L0,${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
      {fill && <path d={dFill} fill={color} opacity={0.15} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="1.6" fill={color} />}
    </svg>
  );
}

type Quote = { price: number; changePct: number };

export function MarketTicker() {
  const { market } = useMarket();
  const seed = market === "IN" ? tickerIN : ticker;
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [live, setLive] = useState(false);

  // Yahoo symbols for the symbols on the active desk that have a mapping.
  const symbolParam = useMemo(
    () => seed.map((t) => yahooSymbols[t.s]).filter(Boolean).join(","),
    [seed],
  );

  useEffect(() => {
    if (!symbolParam) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch(`/api/market?symbols=${encodeURIComponent(symbolParam)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { quotes: Record<string, Quote> };
        if (cancelled) return;
        setQuotes(data.quotes ?? {});
        if (Object.keys(data.quotes ?? {}).length > 0) setLive(true);
      } catch {
        /* keep last good / seed values */
      }
    };
    pull();
    const id = setInterval(pull, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbolParam]);

  // Merge live quotes over the seed list; symbols without a live quote keep seed.
  const merged: Tick[] = seed.map((t) => {
    const q = quotes[yahooSymbols[t.s]];
    return q ? { s: t.s, p: q.price, d: q.changePct } : t;
  });

  const items = [...merged, ...merged];
  return (
    <div className="ticker marquee-wrap" title={live ? "Live — Yahoo Finance" : "Indicative seed prices"}>
      <span className={"ticker-live" + (live ? " on" : "")} aria-hidden />
      <div className="marquee">
        {items.map((it, i) => (
          <span className="item" key={i}>
            <span className="sym">{it.s}</span>
            <span className="mono">{it.p.toFixed(it.p < 100 ? 3 : 2)}</span>
            <span className={it.d >= 0 ? "up" : "down"}>{(it.d >= 0 ? "+" : "") + it.d.toFixed(2)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
