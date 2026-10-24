"use client";

import { useState, type ReactNode } from "react";

export type Point = { t: string; v: number };

const W = 600;
const H = 200;

/** A second series drawn dashed over the first, in its units: one value per point, null where it has none. */
export type Compare = { name: string; values: (number | null)[]; color: string };

/**
 * The design's line chart: a filled line with a dashed baseline at the first
 * point, and a hover rule that reports the point under the pointer. A
 * `compare` series (the index) draws dashed on the same scale, with a legend.
 */
export function LineChart({
  points,
  color,
  height = 240,
  label,
  name,
  compare,
}: {
  points: Point[];
  color: string;
  height?: number;
  /** What the hovered point reads as, under the chart. */
  label: (p: Point, first: Point, i: number) => ReactNode;
  /** The main line's name in the legend; only shown beside a compare line. */
  name?: string;
  compare?: Compare;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const cmp = compare && compare.values.some((v) => v != null) ? compare : null;
  const vs = [...points.map((p) => p.v), ...(cmp?.values.filter((v): v is number => v != null) ?? [])];
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const fill = `${path}L${W},${H}L0,${H}Z`;
  // A gap in the compare series lifts the pen rather than bridging it.
  const cmpPath = cmp
    ? cmp.values
        .map((v, i) => (v == null ? "" : `${i && cmp.values[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
        .join("")
    : "";
  const baseY = y(points[0].v);
  const axis = [0, 1 / 3, 2 / 3, 1].map((f) => points[Math.round(f * (points.length - 1))]);
  const h = hover == null ? null : points[hover];
  const hc = hover == null || !cmp ? null : cmp.values[hover];

  return (
    <div>
      {cmp && (
        <div className="m-meta" style={{ display: "flex", gap: 16, marginTop: 18 }}>
          <Swatch color={color}>{name ?? "Book"}</Swatch>
          <Swatch color={cmp.color} dashed>
            {cmp.name}
          </Swatch>
        </div>
      )}
      <div
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          setHover(Math.round(f * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
        style={{ position: "relative", height, marginTop: cmp ? 10 : 18, cursor: "crosshair" }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          aria-hidden
        >
          <path d={fill} fill={color} fillOpacity={0.06} />
          <line x1={0} x2={W} y1={baseY} y2={baseY} stroke="var(--line-2)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          {cmp && (
            <path d={cmpPath} fill="none" stroke={cmp.color} strokeWidth={1.3} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          )}
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
            {cmp && hc != null && (
              <div
                style={{
                  position: "absolute",
                  left: `${(x(hover) / W) * 100}%`,
                  top: `${(y(hc) / H) * 100}%`,
                  width: 8,
                  height: 8,
                  margin: "-4px 0 0 -4px",
                  borderRadius: "50%",
                  background: cmp.color,
                  border: "2px solid var(--bg)",
                }}
              />
            )}
          </>
        )}
      </div>
      <div
        className="m-meta"
        style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontVariantNumeric: "tabular-nums" }}
      >
        {h && hover != null ? (
          <span>{label(h, points[0], hover)}</span>
        ) : (
          axis.map((p, i) => <span key={i}>{shortDate(p.t)}</span>)
        )}
      </div>
    </div>
  );
}

function Swatch({ color, dashed, children }: { color: string; dashed?: boolean; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <svg width={18} height={6} aria-hidden>
        <line x1={0} x2={18} y1={3} y2={3} stroke={color} strokeWidth={1.6} strokeDasharray={dashed ? "5 3" : undefined} />
      </svg>
      {children}
    </span>
  );
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
}
