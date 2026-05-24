// Shared HUD components for MERIDIAN
// Exposed via window for cross-file scope.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ---------- Sparkline ---------- */
function Sparkline({ data, color = "var(--ink-1)", height = 28, fill = false, last = true }) {
  const w = 100, h = 100;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * h]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const dFill = d + ` L${w},${h} L0,${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
      {fill && <path d={dFill} fill={color} opacity={0.15} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="1.6" fill={color} />}
    </svg>
  );
}

/* ---------- Live clock (UTC) ---------- */
function UTCClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const z = n => String(n).padStart(2, "0");
  return (
    <span>{z(t.getUTCHours())}:{z(t.getUTCMinutes())}:{z(t.getUTCSeconds())} UTC</span>
  );
}

/* ---------- Animated counter ---------- */
function Drift({ value, decimals = 2, step = 0.02, sign = false, color }) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setInterval(() => {
      setV(prev => prev + (Math.random() - 0.5) * step * Math.abs(prev || 1));
    }, 1400);
    return () => clearInterval(id);
  }, [step]);
  const txt = (sign && v > 0 ? "+" : "") + v.toFixed(decimals);
  return <span style={{ color }}>{txt}</span>;
}

/* ---------- Top ticker (marquee) ---------- */
function MarketTicker() {
  const items = window.MD.ticker;
  const row = (
    <div className="marquee">
      {[...items, ...items].map((it, i) => (
        <span className="item" key={i}>
          <span className="sym">{it.s}</span>
          <span className="mono">{it.p.toFixed(it.p < 100 ? 3 : 2)}</span>
          <span className={it.d >= 0 ? "up" : "down"}>{(it.d >= 0 ? "+" : "") + it.d.toFixed(2)}%</span>
        </span>
      ))}
    </div>
  );
  return <div className="ticker marquee-wrap">{row}</div>;
}

/* ---------- Panel ---------- */
function Panel({ title, meta, children, className = "", bodyClassName = "" }) {
  return (
    <div className={"panel " + className}>
      <div className="panel-head">
        <span className="title">{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      <div className={"panel-body " + bodyClassName}>{children}</div>
    </div>
  );
}

/* ---------- Tag ---------- */
function Tag({ children, tone }) {
  return <span className={"tag " + (tone || "")}>{children}</span>;
}

/* ---------- Status pill (dot + label) ---------- */
function StatusDot({ ok = true, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: ok ? "var(--green)" : "var(--red)",
      }} />
      <span>{label}</span>
    </span>
  );
}

Object.assign(window, {
  Sparkline, UTCClock, Drift, MarketTicker, Panel, Tag, StatusDot,
  React_use_state: useState, React_use_effect: useEffect,
});
