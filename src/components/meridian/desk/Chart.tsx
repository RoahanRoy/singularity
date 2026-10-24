"use client";

import { useState, type ReactNode } from "react";

export type Point = { t: string; v: number };

const W = 600;
const H = 200;

/**
 * The design's line chart: a filled line with a dashed baseline at the first
 * point, and a hover rule that reports the point under the pointer.
 */
export function LineChart({
  points,
  color,
  height = 240,
  label,
}: {
  points: Point[];
  color: string;
  height?: number;
  /** What the hovered point reads as, under the chart. */
  label: (p: Point, first: Point) => ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const fill = `${path}L${W},${H}L0,${H}Z`;
  const baseY = y(points[0].v);
  const axis = [0, 1 / 3, 2 / 3, 1].map((f) => points[Math.round(f * (points.length - 1))]);
  const h = hover == null ? null : points[hover];

  return (
    <div>
      <div
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          setHover(Math.round(f * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
        style={{ position: "relative", height, marginTop: 18, cursor: "crosshair" }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          aria-hidden
        >
          <path d={fill} fill={color} fillOpacity={0.06} />
          <line x1={0} x2={W} y1={baseY} y2={baseY} stroke="var(--line-2)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          <path d={path} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        </svg>
        {h && hover != null && (
          <>
            <div
              style={{ position: "absolute", top: 0, bottom: 0, left: `${(x(hover) / W) * 100}%`, width: 1, background: "var(--line-2)" }}
            />
            <div
              style={{
                position: "absolute",
                left: `${(x(hover) / W) * 100}%`,
                top: `${(y(h.v) / H) * 100}%`,
                width: 10,
                height: 10,
                margin: "-5px 0 0 -5px",
                borderRadius: "50%",
                background: color,
                border: "2px solid var(--bg)",
              }}
            />
          </>
        )}
      </div>
      <div
        className="m-meta"
        style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontVariantNumeric: "tabular-nums" }}
      >
        {h ? (
          <span>{label(h, points[0])}</span>
        ) : (
          axis.map((p, i) => <span key={i}>{shortDate(p.t)}</span>)
        )}
      </div>
    </div>
  );
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
}
