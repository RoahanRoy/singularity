"use client";

import { ReactNode, useEffect, useState } from "react";
import { ticker, tickerIN } from "@/lib/meridian/data";
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

export function MarketTicker() {
  const { market } = useMarket();
  const src = market === "IN" ? tickerIN : ticker;
  const items = [...src, ...src];
  return (
    <div className="ticker marquee-wrap">
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
