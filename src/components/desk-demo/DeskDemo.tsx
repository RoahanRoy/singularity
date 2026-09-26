"use client";

import { CSSProperties, FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Theme } from "@/lib/meridian/theme";
import {
  ACTIVE_AGENTS, CLU, DOCS, DemoMarket, DemoMsg, DemoScreen, ENT, EXPO, FACT, FEED, HINTS, HOLD, LINKS,
  MEMO_NOTES, METRICS, MSGS, NAMES, NAVB, PIPES, RANGES, RANGE_STEP_MS, RNG, ROUTES, RULES, SCEN, SCREENS,
  SECT, TICKS, TOPO, TOPO_NODES, TRANS, VENUES, VOTES, exchangeNow, fmtP, spark,
} from "./data";

/**
 * The desk, running on sample data, sized for a fixed 1280×800 frame. The
 * landing page embeds it as the hero preview and zooms into its
 * `data-zoom` regions chapter by chapter. Nothing here touches the live book.
 */

const MONO: CSSProperties = { fontFamily: "var(--f-mono)" };
const H2: CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em" };
const GROUP: CSSProperties = { background: "var(--group)", borderRadius: 14, overflow: "hidden" };
const GLASS: CSSProperties = {
  background: "var(--glass)",
  backdropFilter: "saturate(180%) blur(30px)",
  WebkitBackdropFilter: "saturate(180%) blur(30px)",
};
const CHIP_GLASS: CSSProperties = {
  background: "var(--glass)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  border: "1px solid var(--line)",
};
const BTN_RESET: CSSProperties = { border: 0, font: "inherit", cursor: "pointer" };
const pill = (c: string) => `color-mix(in oklch,${c} 20%,transparent)`;
const signed = (v: number, digits = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);

function Seg<T extends string | number>({
  items,
  value,
  onChange,
  style,
  pad = "5px 0",
}: {
  items: [T, string][];
  value: T;
  onChange: (v: T) => void;
  style?: CSSProperties;
  pad?: string;
}) {
  return (
    <div style={{ display: "flex", background: "var(--seg)", borderRadius: 9, padding: 2, ...style }}>
      {items.map(([id, label]) => {
        const on = id === value;
        return (
          <button
            key={String(id)}
            onClick={() => onChange(id)}
            style={{
              ...BTN_RESET,
              flex: 1,
              borderRadius: 7,
              padding: pad,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              background: on ? "var(--surface)" : "transparent",
              boxShadow: on ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Icon({ name, size = 19, fill = 0, color }: { name: string; size?: number; fill?: number; color?: string }) {
  return (
    <span
      className="msr"
      aria-hidden
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill}`, color }}
    >
      {name}
    </span>
  );
}

function Bold({ text }: { text: string }) {
  return (
    <>
      {text.split("*").map((t, i) => (
        <span key={i} style={{ fontWeight: i % 2 ? 600 : 400 }}>
          {t}
        </span>
      ))}
    </>
  );
}

export function DeskDemo({
  theme,
  onToggleTheme,
  screen: initialScreen = "portfolio",
}: {
  theme: Theme;
  onToggleTheme?: () => void;
  screen?: DemoScreen;
}) {
  const [screen, setScreenState] = useState<DemoScreen>(initialScreen);
  const [market, setMarketState] = useState<DemoMarket>("US");
  const [range, setRange] = useState(2);
  const [hover, setHover] = useState<number | null>(null);
  const [allExpo, setAllExpo] = useState(false);
  const [heat, setHeat] = useState(false);
  const [votes, setVotes] = useState<Record<string, "a" | "d">>({});
  const [openVote, setOpenVote] = useState<string | null>(null);
  const [cluster, setCluster] = useState<string | null>(null);
  const [doc, setDoc] = useState(1);
  const [rtab, setRtab] = useState<"memo" | "transcript" | "entities">("memo");
  const [memo, setMemo] = useState<"accepted" | "revise" | null>(null);
  const [rules, setRules] = useState(() => RULES.map((r) => r[1]));
  const [msgs, setMsgs] = useState<DemoMsg[]>(MSGS);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [auth, setAuth] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // null until mounted, so the server and first client render agree.
  const [now, setNow] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Several desks share the landing page, so gradient ids must be unique.
  const fillId = "mer-fill-" + useId().replace(/:/g, "");

  // Tick once a second, but only while the frame is on screen — the landing
  // page mounts several of these at once.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let iv: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (iv) return;
      setNow(Date.now());
      iv = setInterval(() => {
        setNow(Date.now());
        setTick((t) => t + 1);
      }, 1000);
    };
    const stop = () => {
      if (iv) clearInterval(iv);
      iv = null;
    };
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()));
    io.observe(el);
    return () => {
      io.disconnect();
      stop();
    };
  }, []);

  useEffect(() => () => {
    if (replyTimer.current) clearTimeout(replyTimer.current);
  }, []);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, thinking, screen]);

  const setScreen = (id: DemoScreen) => {
    setScreenState(id);
    setHover(null);
    if (mainRef.current) mainRef.current.scrollTop = 0;
  };
  const setMarket = (m: DemoMarket) => {
    setMarketState(m);
    setCluster(null);
    setHover(null);
  };

  const ask = (text: string) => {
    if (!text.trim() || thinking) return;
    setMsgs((m) => [...m, { u: 1, text }]);
    setDraft("");
    setThinking(true);
    replyTimer.current = setTimeout(() => {
      setMsgs((m) => [
        ...m,
        {
          u: 0,
          name: "Meridian · assistant",
          text: "Noted. I've routed that to the orchestrator and will bring back an action card here once it's ready for your approval.",
        },
      ]);
      setThinking(false);
    }, 900);
  };

  const M = market;
  const feedOff = Math.floor(tick / 3);

  // NAV series for the selected range.
  const chart = useMemo(() => {
    const [, lbl, n, seed, vol] = RANGES[range];
    const r = RNG(seed + (M === "IN" ? 7 : 0));
    const raw = [1];
    for (let i = 1; i < n; i++) raw.push(raw[i - 1] * (1 + (r() - 0.44) * vol));
    const k = NAVB[M] / raw[n - 1];
    const s = raw.map((v) => v * k);
    const mn = Math.min(...s);
    const rg = Math.max(...s) - mn || 1;
    const pts = s.map((y, i) => [(i / (n - 1)) * 600, 200 - ((y - mn) / rg) * 180 - 10]);
    const path = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const vr = RNG(seed * 3 + 1);
    const vols = s.map(() => 18 + vr() * 82);
    return { lbl, n, s, mn, rg, pts, path, vols };
  }, [range, M]);

  const { lbl, n, s, mn, rg, pts, path, vols } = chart;
  const cur = hover == null ? s[n - 1] : s[hover];
  const diff = cur - s[0];
  const up = diff >= 0;
  const cc = up ? "var(--up)" : "var(--down)";
  const cs = M === "IN" ? "₹" : "$";
  const ad = Math.abs(diff);
  const short =
    M === "IN"
      ? ad >= 1e7 ? (ad / 1e7).toFixed(2) + " Cr" : (ad / 1e5).toFixed(2) + " L"
      : ad >= 1e6 ? (ad / 1e6).toFixed(2) + "M" : (ad / 1e3).toFixed(1) + "K";
  const shortV = (v: number) => (M === "IN" ? "₹" + (v / 1e7).toFixed(0) + " Cr" : "$" + (v / 1e9).toFixed(3) + "B");
  const stepMs = RANGE_STEP_MS[RANGES[range][0]];
  const tAt = (i: number) => new Date((now ?? 0) - (n - 1 - i) * stepMs);
  const fmtT = (dt: Date) =>
    RANGES[range][0] === "1D"
      ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const axis = now == null ? ["", "", "", ""] : [0, 0.33, 0.66, 1].map((f) => fmtT(tAt(Math.round(f * (n - 1)))));

  const ex = now == null ? null : exchangeNow(M, new Date(now));
  const statusMap = {
    open: ["Market open", "var(--up)"],
    pre: ["Pre-open", "var(--accent-ink)"],
    after: ["After hours", "var(--accent-ink)"],
    closed: ["Market closed", "var(--ink-2)"],
  } as const;
  const sm = ex ? statusMap[ex.s] : null;
  const exName = M === "IN" ? "NSE" : "NYSE";

  const clus = CLU[M];
  const totalAgents = clus.reduce((a, c) => a + c[2], 0);
  const feedAll = FEED[M];
  const fl = feedAll.length;
  const feed = cluster
    ? feedAll.filter((f) => f[3] === cluster)
    : Array.from({ length: 7 }, (_, i) => feedAll[(feedOff + fl * 10 - i) % fl]);
  const selC = clus.find((c) => c[0] === cluster);
  const tpos = Object.fromEntries(TOPO.map((t) => [t[0], t]));
  const rack = useMemo(() => {
    const r = RNG(20260524);
    return Array.from({ length: 192 }, () => {
      const x = r();
      return x < 0.05
        ? "var(--accent)"
        : x < 0.3 ? "color-mix(in oklch,var(--accent) 55%,transparent)"
        : x < 0.55 ? "color-mix(in oklch,var(--accent) 25%,transparent)"
        : x < 0.85 ? "var(--fill-2)" : "transparent";
    });
  }, []);

  const [title, crumb] = (() => {
    const sc = SCREENS.find((x) => x[0] === screen)!;
    return [sc[1], sc[2]];
  })();

  const pendingCount = M === "IN" ? 0 : VOTES.filter((v) => !votes[v[0]]).length;
  const shellFont = "var(--f-text)";

  return (
    <div
      ref={rootRef}
      className="mx-desk"
      data-theme={theme}
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: shellFont,
        fontSize: 15,
        lineHeight: 1.4,
        letterSpacing: "-0.012em",
        display: "flex",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
          background: `radial-gradient(55% 45% at 72% -5%,color-mix(in oklch,${cc} 16%,transparent),transparent 70%),radial-gradient(40% 40% at 0% 100%,color-mix(in oklch,var(--accent) 8%,transparent),transparent 70%)`,
        }}
      />

      {/* Sidebar */}
      <aside
        className="mx-glass"
        style={{
          ...GLASS,
          position: "relative",
          zIndex: 5,
          flex: "0 0 304px",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 18px 14px" }}>
          <BrandMark size={22} />
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}>Meridian</span>
          <button
            onClick={onToggleTheme}
            aria-label="Toggle appearance"
            style={{
              ...BTN_RESET,
              marginLeft: "auto",
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: "var(--fill)",
              color: "var(--ink-2)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} size={18} />
          </button>
        </div>
        <Seg
          items={[["US", "US"], ["IN", "India"]]}
          value={M}
          onChange={setMarket}
          style={{ margin: "0 16px 12px" }}
        />
        <nav style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 10px" }}>
          {SCREENS.map(([id, label, , icon]) => {
            const on = screen === id;
            return (
              <button
                key={id}
                onClick={() => setScreen(id)}
                style={{
                  ...BTN_RESET,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 14,
                  fontWeight: 500,
                  textAlign: "left",
                  background: on ? "var(--tint)" : "transparent",
                  color: on ? "#fff" : "var(--ink)",
                }}
              >
                <Icon name={icon} fill={on ? 1 : 0} color={on ? "#fff" : "var(--tint)"} />
                {label}
              </button>
            );
          })}
        </nav>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "22px 20px 6px" }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.025em" }}>Holdings</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{M === "IN" ? "India Fund · Kite" : "US Fund · IBKR"}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 10px" }}>
          {HOLD[M].map(([sy, p, dd], i) => {
            const c = dd >= 0 ? "var(--up)" : "var(--down)";
            return (
              <div
                key={sy}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1fr) 64px 84px",
                  gap: 10,
                  alignItems: "center",
                  padding: 10,
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>{sy}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {NAMES[sy] || ""}
                  </div>
                </div>
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: 64, height: 28, overflow: "visible" }}>
                  <line x1="0" x2="100" y1="15" y2="15" stroke="var(--ink-3)" strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
                  <path d={spark(101 + i * 13 + (M === "IN" ? 50 : 0), dd >= 0)} fill="none" stroke={c} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                </svg>
                <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{fmtP(p)}</div>
                  <span style={{ display: "inline-block", marginTop: 3, minWidth: 64, padding: "2px 6px", borderRadius: 6, fontSize: 12, fontWeight: 600, textAlign: "right", background: pill(c), color: c }}>
                    {signed(dd)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg,#8e8e93,#48484a)", color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600 }}>
            KP
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>K. Park</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Portfolio manager</div>
          </div>
          <Link href="/sign-in" style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Sign in
          </Link>
        </div>
      </aside>

      <div ref={mainRef} style={{ position: "relative", zIndex: 1, flex: 1, minWidth: 0, overflowY: "auto" }}>
        <header className="mx-glass" style={{ ...GLASS, position: "sticky", top: 0, zIndex: 10, borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 32px", height: 52 }}>
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>{crumb}</div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
              {sm && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: sm[1], fontWeight: 600 }}>
                  <Ping />
                  {sm[0]} · {exName}
                </span>
              )}
              <span style={{ ...MONO, color: "var(--ink-3)", fontSize: 12 }}>{ex?.clock}</span>
            </div>
          </div>
          <div
            style={{
              overflow: "hidden",
              borderTop: "1px solid var(--line)",
              WebkitMaskImage: "linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)",
              maskImage: "linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)",
            }}
          >
            <div style={{ display: "flex", width: "max-content", animation: "mer-tick 70s linear infinite" }}>
              {[...TICKS[M], ...TICKS[M]].map(([sy, p, dd], i) => (
                <div key={i} style={{ ...MONO, flex: "none", padding: "7px 16px", display: "flex", gap: 7, alignItems: "baseline", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: "var(--ink-2)" }}>{sy}</span>
                  <span>{fmtP(p)}</span>
                  <span style={{ color: dd >= 0 ? "var(--up)" : "var(--down)" }}>{signed(dd)}%</span>
                </div>
              ))}
            </div>
          </div>
        </header>

        <main style={{ padding: "36px 36px 64px" }}>
          <div style={{ maxWidth: 1240, margin: "0 auto" }}>
            {screen === "portfolio" && (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 44, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>
                    {M === "IN" ? "Meridian India Fund" : "Meridian US Fund"}
                  </div>
                  <div style={{ fontFamily: "var(--f-display)", fontSize: 64, fontWeight: 700, letterSpacing: "-0.045em", lineHeight: 1.02, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                    {cs + Math.round(cur).toLocaleString(M === "IN" ? "en-IN" : "en-US")}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontVariantNumeric: "tabular-nums" }}>
                    <span style={{ padding: "3px 9px", borderRadius: 7, fontSize: 15, fontWeight: 700, background: pill(cc), color: cc }}>
                      {signed((diff / s[0]) * 100)}%
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 600, color: cc }}>{(up ? "+" : "−") + cs + short}</span>
                    <span style={{ fontSize: 15, color: "var(--ink-3)" }}>{hover == null || now == null ? lbl : fmtT(tAt(hover))}</span>
                  </div>

                  <div
                    onMouseMove={(e) => {
                      const b = e.currentTarget.getBoundingClientRect();
                      const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / (b.width - 64)) * (n - 1))));
                      if (i !== hover) setHover(i);
                    }}
                    onMouseLeave={() => setHover(null)}
                    style={{ position: "relative", marginTop: 28, cursor: "crosshair", paddingRight: 64 }}
                  >
                    <div style={{ position: "relative", height: 320 }}>
                      {[20, 100, 180].map((y) => (
                        <div key={y} style={{ position: "absolute", left: 0, right: -64, top: y / 2 + "%", borderTop: "1px solid var(--line)" }}>
                          <span style={{ ...MONO, position: "absolute", right: 0, top: -8, fontSize: 11, color: "var(--ink-3)", background: "var(--bg)", paddingLeft: 6 }}>
                            {shortV(mn + ((190 - y) / 180) * rg)}
                          </span>
                        </div>
                      ))}
                      <svg viewBox="0 0 600 200" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
                        <defs>
                          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={cc} stopOpacity="0.32" />
                            <stop offset="100%" stopColor={cc} stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <path d={path + " L600,200 L0,200 Z"} fill={`url(#${fillId})`} />
                        <line x1="0" x2="600" y1={pts[0][1]} y2={pts[0][1]} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="1 4" vectorEffect="non-scaling-stroke" />
                        <path d={path} fill="none" stroke={cc} strokeWidth="2.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                      </svg>
                      <div style={{ position: "absolute", right: -64, top: pts[0][1] / 2 + "%", transform: "translateY(-50%)", fontSize: 10, fontWeight: 600, color: "var(--ink-3)", background: "var(--bg)", paddingLeft: 6 }}>
                        START
                      </div>
                      {hover == null ? (
                        <div style={{ position: "absolute", left: "100%", top: pts[n - 1][1] / 2 + "%", width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", color: cc }}>
                          <Ping size={9} />
                        </div>
                      ) : (
                        <>
                          <div style={{ position: "absolute", top: -14, bottom: -56, left: pts[hover][0] / 6 + "%", width: 1, background: "var(--ink-3)" }} />
                          <div style={{ position: "absolute", left: pts[hover][0] / 6 + "%", top: pts[hover][1] / 2 + "%", width: 11, height: 11, margin: "-5.5px 0 0 -5.5px", borderRadius: "50%", background: cc, boxShadow: "0 0 0 3px var(--bg)" }} />
                        </>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 44, marginTop: 12 }}>
                      {s.map((v, i) => (
                        <span
                          key={i}
                          style={{
                            flex: 1,
                            height: vols[i] + "%",
                            borderRadius: 1,
                            background:
                              hover === i ? cc : i > 0 && v < s[i - 1] ? "color-mix(in oklch,var(--down) 26%,transparent)" : "var(--fill-2)",
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ ...MONO, display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--ink-3)" }}>
                      {axis.map((a, i) => (
                        <span key={i}>{a}</span>
                      ))}
                    </div>
                  </div>

                  <Seg
                    items={RANGES.map((x, i) => [i, x[0]] as [number, string])}
                    value={range}
                    onChange={(i) => {
                      setRange(i);
                      setHover(null);
                    }}
                    pad="6px 0"
                    style={{ marginTop: 18 }}
                  />

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", columnGap: 28, marginTop: 28, borderTop: "1px solid var(--line)" }}>
                    {METRICS.map(([k, v, c]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "11px 0", borderBottom: "1px solid var(--line)", fontVariantNumeric: "tabular-nums" }}>
                        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{k}</span>
                        <span style={{ fontSize: 15, fontWeight: 600, color: c === "up" ? "var(--up)" : c === "down" ? "var(--down)" : "var(--ink)" }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <SectionHead title="Factor exposure" action={allExpo ? "Show less" : "Show all 13 factors"} onAction={() => setAllExpo(!allExpo)} />
                  <div style={{ position: "relative" }}>
                    <div style={{ position: "absolute", top: 0, bottom: 0, left: "calc(120px + (100% - 184px) / 2)", width: 1, background: "var(--line)" }} />
                    {(allExpo ? EXPO : EXPO.slice(0, 6)).map(([name, v]) => {
                      const c = v >= 0 ? "var(--up)" : "var(--down)";
                      return (
                        <div key={name} style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) 64px", alignItems: "center", height: 30, fontSize: 13 }}>
                          <span style={{ color: "var(--ink-2)" }}>{name}</span>
                          <div style={{ position: "relative", height: 14 }}>
                            <div style={{ position: "absolute", top: 0, bottom: 0, left: v >= 0 ? "50%" : 50 - Math.abs(v) * 50 + "%", width: Math.abs(v) * 50 + "%", borderRadius: 3, background: c, opacity: 0.9 }} />
                          </div>
                          <span style={{ textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: c }}>{signed(v * 100, 1)}%</span>
                        </div>
                      );
                    })}
                  </div>

                  <h2 style={{ ...H2, margin: "48px 0 4px" }}>Next 24 hours</h2>
                  <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 10 }}>Outcome odds and book impact · 20,000 simulations</div>
                  {SCEN.map(([name, p, outs, note]) => (
                    <div key={name} style={{ padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                        <span style={{ fontSize: 16, fontWeight: 600 }}>{name}</span>
                        <span style={{ ...MONO, fontSize: 13, color: "var(--ink-3)" }}>{p}</span>
                      </div>
                      <div style={{ display: "flex", gap: 2, height: 10, borderRadius: 5, overflow: "hidden" }}>
                        {outs.map(([on, pp, v]) => (
                          <span key={on} style={{ flex: pp, background: `color-mix(in oklch,${v >= 0 ? "var(--up)" : "var(--down)"} ${Math.round(35 + Math.min(1, Math.abs(v)) * 55)}%,transparent)` }} />
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
                        {outs.map(([on, pp, v]) => (
                          <div key={on} style={{ flex: pp, minWidth: 0, fontSize: 12 }}>
                            <div style={{ color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {on} · {Math.round(pp * 100)}%
                            </div>
                            <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", color: v >= 0 ? "var(--up)" : "var(--down)" }}>{signed(v)}%</div>
                          </div>
                        ))}
                      </div>
                      {note && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{note}</div>}
                    </div>
                  ))}

                  <SectionHead title="Factor × sector" action={heat ? "Hide" : "Show"} onAction={() => setHeat(!heat)} />
                  {heat && (
                    <div style={{ overflowX: "auto" }}>
                      <div style={{ ...MONO, display: "grid", gridTemplateColumns: "60px repeat(11,minmax(40px,1fr))", gap: 2, fontSize: 10, minWidth: 560 }}>
                        <span />
                        {SECT.map((c) => (
                          <span key={c} style={{ textAlign: "center", color: "var(--ink-3)", paddingBottom: 4 }}>{c}</span>
                        ))}
                        {FACT.map((f, i) => (
                          <HeatRow key={f} f={f} i={i} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <aside data-zoom="approvals" style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={GROUP}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "14px 16px 8px" }}>
                      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Needs approval</span>
                      <span style={{ fontSize: 12, fontWeight: 700, minWidth: 20, height: 20, padding: "0 6px", borderRadius: 10, display: "grid", placeItems: "center", background: "var(--down)", color: "#fff" }}>
                        {pendingCount}
                      </span>
                    </div>
                    {M === "IN" && <div style={{ padding: "8px 16px 18px", color: "var(--ink-3)", fontSize: 14 }}>No motions pending on the India book.</div>}
                    {M === "US" &&
                      VOTES.map(([t, side, w, aa, nn, c]) => {
                        const vs = votes[t];
                        const open = openVote === t && !vs;
                        const sc = side === "Add" ? "var(--up)" : side === "Exit" ? "var(--down)" : "var(--accent-ink)";
                        return (
                          <div key={t} style={{ borderTop: "1px solid var(--line)", marginLeft: 16 }}>
                            <button
                              onClick={() => !vs && setOpenVote(openVote === t ? null : t)}
                              style={{ ...BTN_RESET, width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 16px 11px 0", background: "transparent", color: "var(--ink)", textAlign: "left", minHeight: 56 }}
                            >
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 15, fontWeight: 700 }}>
                                  {t}
                                  <span style={{ fontSize: 12, fontWeight: 600, color: sc }}>{side}</span>
                                </span>
                                <span style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>
                                  {aa}/{aa + nn} agents · conviction {c.toFixed(2)}
                                </span>
                              </span>
                              <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, fontWeight: 600, padding: "2px 7px", borderRadius: 6, background: pill(sc), color: sc }}>{w}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: vs === "a" ? "var(--up)" : "var(--ink-3)", minWidth: 14, textAlign: "right" }}>
                                {vs === "a" ? "✓" : vs === "d" ? "✕" : open ? "⌃" : "›"}
                              </span>
                            </button>
                            {open && (
                              <div style={{ padding: "0 16px 14px 0", animation: "mer-in .2s ease" }}>
                                <div style={{ display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
                                  <span style={{ flex: aa, background: "var(--up)" }} />
                                  <span style={{ flex: nn || 0.001, background: "var(--down)" }} />
                                </div>
                                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 12 }}>
                                  {aa} in favour, {nn} dissenting. Cleared the risk overlay and compliance.
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button onClick={() => { setVotes((x) => ({ ...x, [t]: "a" })); setOpenVote(null); }} style={{ ...BTN_RESET, flex: 1, background: "var(--tint)", color: "#fff", borderRadius: 9, padding: "8px 0", fontSize: 14, fontWeight: 600 }}>
                                    Approve
                                  </button>
                                  <button onClick={() => { setVotes((x) => ({ ...x, [t]: "d" })); setOpenVote(null); }} style={{ ...BTN_RESET, flex: 1, background: "var(--seg)", color: "var(--ink)", borderRadius: 9, padding: "8px 0", fontSize: 14, fontWeight: 600 }}>
                                    Decline
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                  <div style={{ background: "var(--group)", borderRadius: 14, padding: "4px 0" }}>
                    {[["Net leverage", "1.42×"], ["VaR (99, 1d)", "1.12%"], ["Cash", "8.4%"], ["Risk", "Within bounds"]].map(([k, v], i) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: i ? "11px 16px 11px 0" : "11px 16px", marginLeft: i ? 16 : 0, borderTop: i ? "1px solid var(--line)" : 0, fontSize: 14 }}>
                        <span style={{ color: "var(--ink-2)" }}>{k}</span>
                        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", color: i === 3 ? "var(--up)" : undefined }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </aside>
              </div>
            )}

            {screen === "swarm" && (
              <>
                <div data-zoom="topology" style={{ position: "relative", margin: "0 0 36px" }}>
                  <svg viewBox="0 0 1000 560" style={{ width: "100%", height: "auto", display: "block" }}>
                    {LINKS.map(([a, b]) => {
                      const hot = !!cluster && (a === cluster || b === cluster);
                      return (
                        <line key={a + b} x1={tpos[a][2] * 1000} y1={tpos[a][3] * 560} x2={tpos[b][2] * 1000} y2={tpos[b][3] * 560} stroke={hot ? "var(--accent)" : "var(--ink-3)"} strokeOpacity={hot ? 0.9 : 0.35} strokeWidth="1" strokeDasharray="2 5" />
                      );
                    })}
                    {TOPO.map(([id, , x, y, cnt]) => {
                      const on = cluster === id;
                      return (
                        <circle key={id} cx={x * 1000} cy={y * 560} r={24 + Math.sqrt(cnt) * 6.5} fill={on ? "color-mix(in oklch,var(--accent) 10%,transparent)" : "transparent"} stroke={on ? "var(--ink)" : "var(--line)"} strokeWidth="1" onClick={() => setCluster(on ? null : id)} style={{ cursor: "pointer" }} />
                      );
                    })}
                    {TOPO_NODES.map((nd, i) => (
                      <circle key={i} cx={nd.x} cy={nd.y} r={nd.r} fill={nd.inf ? "var(--blue)" : "var(--accent)"} opacity={cluster && nd.id !== cluster ? 0.2 : nd.active ? 1 : 0.6} style={{ animation: nd.active ? `mer-pulse 2.4s ${nd.delay}s infinite` : "none", pointerEvents: "none" }} />
                    ))}
                    {TOPO.map(([id, name, x, y, cnt]) => {
                      const on = cluster === id;
                      return (
                        <text key={id} x={x * 1000} y={y * 560 - (24 + Math.sqrt(cnt) * 6.5) - 10} textAnchor="middle" fontSize="14" fontWeight="600" fill={on ? "var(--ink)" : "var(--ink-2)"} style={{ fontFamily: "inherit", cursor: "pointer" }} onClick={() => setCluster(on ? null : id)}>
                          {name}
                        </text>
                      );
                    })}
                  </svg>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                    <Stat label="Agents active" value={(Math.round(totalAgents * 0.742) + (tick % 7)).toLocaleString()} sub={" / " + totalAgents.toLocaleString()} />
                    <Stat label="Threads" value="14" />
                    <Stat label="Anomalies" value="0" color="var(--up)" />
                  </div>
                  <div style={{ ...CHIP_GLASS, position: "absolute", right: 0, bottom: 0, display: "flex", gap: 14, fontSize: 12, color: "var(--ink-2)", borderRadius: 980, padding: "6px 12px" }}>
                    <Legend color="var(--accent)" label="Research" />
                    <Legend color="var(--blue)" label="Infrastructure" />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 44, alignItems: "start" }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ ...H2, margin: "0 0 6px" }}>Clusters</h2>
                    <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr) 64px 120px 40px", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 11, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      <span />
                      <span>Cluster</span>
                      <span style={{ textAlign: "right" }}>Agents</span>
                      <span>Conviction</span>
                      <span />
                    </div>
                    {clus.map(([id, name, ag, cv, infra]) => {
                      const on = cluster === id;
                      const dot = infra ? "var(--blue)" : "var(--accent)";
                      return (
                        <button key={id} onClick={() => setCluster(on ? null : id)} style={{ ...BTN_RESET, width: "100%", display: "grid", gridTemplateColumns: "18px minmax(0,1fr) 64px 120px 40px", gap: 12, alignItems: "center", borderBottom: "1px solid var(--line)", background: on ? "var(--fill)" : "transparent", color: "var(--ink)", textAlign: "left", padding: 0, minHeight: 46 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, marginLeft: 4 }} />
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
                          <span style={{ ...MONO, textAlign: "right", fontSize: 12, color: "var(--ink-2)" }}>{ag.toLocaleString()}</span>
                          <span style={{ height: 4, borderRadius: 2, background: "var(--fill-2)", overflow: "hidden" }}>
                            <span style={{ display: "block", height: "100%", width: cv * 100 + "%", background: dot }} />
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", textAlign: "right", paddingRight: 4 }}>{cv.toFixed(2)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ ...GROUP, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 8px" }}>
                      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Activity</span>
                      {selC && (
                        <button onClick={() => setCluster(null)} style={{ ...BTN_RESET, background: "var(--seg)", color: "var(--ink)", borderRadius: 980, padding: "3px 10px", fontSize: 12 }}>
                          {selC[1]} ✕
                        </button>
                      )}
                    </div>
                    {feed.map((f, i) => (
                      <div key={f[1] + (cluster ? "" : feedOff - i)} style={{ marginLeft: 16, padding: "10px 16px 10px 0", borderTop: "1px solid var(--line)", animation: "mer-in .3s ease" }}>
                        <div style={{ display: "flex", gap: 8, fontSize: 11, marginBottom: 3 }}>
                          <span style={{ fontWeight: 600, color: "var(--accent-ink)" }}>{f[0]}</span>
                          <span style={{ ...MONO, color: "var(--ink-3)" }}>{f[1]}</span>
                          <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>{cluster ? "" : i === 0 ? "now" : i * 3 + 1 + "s"}</span>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.4 }}>{f[2]}</div>
                      </div>
                    ))}
                    {feed.length === 0 && <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 13 }}>Quiet in this cluster right now.</div>}
                  </div>
                </div>
              </>
            )}

            {screen === "research" && (
              <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", gap: 40, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <h2 style={H2}>Inbox</h2>
                    <span style={{ ...MONO, fontSize: 12, color: "var(--ink-3)" }}>2,418/hr</span>
                  </div>
                  {DOCS.map(([src, tk, ttl, when], i) => {
                    const on = i === doc;
                    return (
                      <button key={i} onClick={() => setDoc(i)} style={{ ...BTN_RESET, width: "100%", display: "block", textAlign: "left", borderRadius: 10, padding: "10px 12px", margin: "2px 0", background: on ? "var(--tint)" : "transparent", color: on ? "#fff" : "var(--ink)" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span style={{ fontSize: 14, fontWeight: 700 }}>{tk}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.75, whiteSpace: "nowrap" }}>{src}</span>
                          <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>{when}</span>
                        </div>
                        <div style={{ fontSize: 13, opacity: 0.82, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{ttl}</div>
                      </button>
                    );
                  })}
                </div>

                <article data-zoom="memo" style={{ minWidth: 0 }}>
                  {doc === 1 ? (
                    <>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12 }}>
                        <span style={{ fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "color-mix(in oklch,var(--accent) 22%,transparent)", color: "var(--accent-ink)" }}>Draft memo · v3</span>
                        <span style={{ color: "var(--ink-3)" }}>TSM · Q4 2025 earnings call · 3 agents synthesising</span>
                      </div>
                      <h1 style={{ margin: "10px 0 22px", fontFamily: "var(--f-display)", fontSize: 40, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.08, textWrap: "balance" }}>
                        Q4 print signals softening demand
                      </h1>
                      <div style={{ display: "flex", flexWrap: "wrap", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                        {[["Conviction", "0.74", "var(--accent-ink)"], ["Horizon", "2–6 wks"], ["Size", "0.40%"], ["Sharpe est.", "1.82"]].map(([k, v, c], i) => (
                          <div key={k} style={{ flex: "1 1 110px", padding: i ? "12px 16px" : "12px 16px 12px 0", borderLeft: i ? "1px solid var(--line)" : 0 }}>
                            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{k}</div>
                            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: c }}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <Seg
                        items={[["memo", "Memo"], ["transcript", "Transcript"], ["entities", "Entities"]]}
                        value={rtab}
                        onChange={setRtab}
                        style={{ margin: "22px 0 20px", maxWidth: 340 }}
                      />
                      {rtab === "memo" && (
                        <>
                          <p style={{ margin: "0 0 24px", fontSize: 17, lineHeight: 1.55, maxWidth: 680, textWrap: "pretty" }}>
                            Three independent agents read management&apos;s tone as softening demand. Alt-data shows divergence in North American capex shipments, and TSM 1M options skew is thinning. Suggested trade: long SOXX vs. short a TSM call spread, with a VIX overlay.
                          </p>
                          <div style={{ borderTop: "1px solid var(--line)" }}>
                            {MEMO_NOTES.map(([icon, src, body]) => (
                              <div key={icon} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", gap: 12, padding: "14px 0", borderBottom: "1px solid var(--line)" }}>
                                <span style={{ lineHeight: 1.2 }}>
                                  <Icon name={icon} size={20} color="var(--accent-ink)" />
                                </span>
                                <div>
                                  <div style={{ ...MONO, fontSize: 12, color: "var(--ink-3)" }}>{src}</div>
                                  <div style={{ fontSize: 14, marginTop: 3 }}>{body}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
                            <button onClick={() => setMemo("accepted")} style={{ ...BTN_RESET, background: "var(--tint)", color: "#fff", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 600 }}>
                              {memo === "accepted" ? "Sent to PM ✓" : "Accept thesis"}
                            </button>
                            <button onClick={() => setMemo("revise")} style={{ ...BTN_RESET, background: "var(--seg)", color: "var(--ink)", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 600 }}>
                              {memo === "revise" ? "Sent back for revision ✓" : "Send back"}
                            </button>
                          </div>
                        </>
                      )}
                      {rtab === "transcript" && (
                        <>
                          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--ink-2)", marginBottom: 16 }}>
                            <Legend color="var(--accent)" label="Hedging" bar />
                            <Legend color="var(--blue)" label="Reassurance" bar />
                            <Legend color="var(--down)" label="Deflection" bar />
                          </div>
                          {TRANS.map(([speaker, sg]) => (
                            <div key={speaker} style={{ marginBottom: 20, maxWidth: 680 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>{speaker}</div>
                              <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6 }}>
                                {sg.map(([t, m], i) => {
                                  const c = m === "a" ? "var(--accent)" : m === "b" ? "var(--blue)" : "var(--down)";
                                  return (
                                    <span key={i} style={m ? { background: `color-mix(in oklch,${c} 16%,transparent)`, borderBottom: `2px solid ${c}`, padding: "0 2px" } : undefined}>
                                      {t}
                                    </span>
                                  );
                                })}
                              </p>
                            </div>
                          ))}
                        </>
                      )}
                      {rtab === "entities" &&
                        ENT.map(([name, role, w]) => (
                          <div key={name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 84px minmax(60px,160px) 36px", gap: 14, alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--line)", fontSize: 14 }}>
                            <span style={{ fontWeight: 600 }}>{name}</span>
                            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{role}</span>
                            <span style={{ height: 4, borderRadius: 2, background: "var(--fill-2)" }}>
                              <span style={{ display: "block", height: "100%", borderRadius: 2, width: w * 100 + "%", background: "var(--accent)" }} />
                            </span>
                            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>{w.toFixed(2)}</span>
                          </div>
                        ))}
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {DOCS[doc][0]} · {DOCS[doc][1]} · ingested {DOCS[doc][3]}
                      </div>
                      <h1 style={{ margin: "10px 0 18px", fontFamily: "var(--f-display)", fontSize: 36, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.12, textWrap: "balance" }}>
                        {DOCS[doc][2]}
                      </h1>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", fontSize: 14, color: "var(--ink-2)" }}>
                        <Icon name="task_alt" size={20} color="var(--up)" />
                        Parsed and indexed. Below the conviction threshold, so no memo has been drafted yet.
                      </div>
                    </>
                  )}
                </article>
              </div>
            )}

            {screen === "console" && (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 44, alignItems: "start" }}>
                <section data-zoom="chat" style={{ minWidth: 0, display: "flex", flexDirection: "column", height: 560 }}>
                  <div ref={chatRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, paddingBottom: 12 }}>
                    <div style={{ textAlign: "center", fontSize: 12, color: "var(--ink-3)" }}>Session #2,841 · K. Park (PM) · supervised</div>
                    {msgs.map((m, i) => (
                      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.u ? "flex-end" : "flex-start" }}>
                        <div style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 12px 3px" }}>{m.u ? "You" : m.name}</div>
                        <div style={{ maxWidth: "min(560px,86%)", background: m.u ? "var(--bubble)" : "var(--group-2)", color: m.u ? "var(--bubble-ink)" : "var(--ink)", borderRadius: 20, padding: "10px 15px", fontSize: 15, lineHeight: 1.45 }}>
                          <Bold text={m.text} />
                        </div>
                        {m.quote && (
                          <div style={{ maxWidth: "min(560px,86%)", marginTop: 6, borderLeft: "3px solid var(--accent)", padding: "6px 12px", fontSize: 13, color: "var(--ink-2)" }}>{m.quote}</div>
                        )}
                        {m.card && (
                          <div style={{ ...GROUP, width: "min(560px,86%)", marginTop: 6, borderRadius: 16 }}>
                            <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", borderBottom: "1px solid var(--line)" }}>{m.card}</div>
                            {(m.rows || []).map(([k, v], j) => (
                              <div key={j} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 14px", fontSize: 13, borderBottom: "1px solid var(--line)" }}>
                                <span style={{ color: "var(--ink-2)" }}>{k}</span>
                                <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{v}</span>
                              </div>
                            ))}
                            {m.actions && (
                              <div style={{ display: "flex", gap: 8, padding: "12px 14px" }}>
                                {auth ? (
                                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--up)" }}>{auth}</span>
                                ) : (
                                  <>
                                    <button onClick={() => setAuth("Authorized · routing to 3 venues over 2 sessions")} style={{ ...BTN_RESET, flex: 1, background: "var(--tint)", color: "#fff", borderRadius: 10, padding: "9px 0", fontSize: 14, fontWeight: 600 }}>
                                      Authorize
                                    </button>
                                    <button onClick={() => setAuth("Dissent review spawned · 2 agents re-checking")} style={{ ...BTN_RESET, flex: 1, background: "var(--seg)", color: "var(--ink)", borderRadius: 10, padding: "9px 0", fontSize: 14, fontWeight: 600 }}>
                                      Review dissent
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {thinking && (
                      <div style={{ alignSelf: "flex-start", background: "var(--group-2)", borderRadius: 20, padding: "10px 15px", fontSize: 15, color: "var(--ink-3)", animation: "mer-pulse 1.4s infinite" }}>•••</div>
                    )}
                  </div>
                  <form
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      ask(draft);
                    }}
                    style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}
                  >
                    <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10 }}>
                      {HINTS.map((h) => (
                        <button key={h} type="button" onClick={() => ask(h)} style={{ ...BTN_RESET, flex: "none", background: "var(--seg)", color: "var(--ink)", borderRadius: 980, padding: "6px 12px", fontSize: 13 }}>
                          {h}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", border: "1px solid var(--line)", background: "var(--field)", borderRadius: 22, padding: "3px 3px 3px 16px" }}>
                      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message Meridian" aria-label="Message Meridian" style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 15, height: 36 }} />
                      <button type="submit" aria-label="Send" style={{ ...BTN_RESET, width: 34, height: 34, borderRadius: "50%", background: "var(--tint)", color: "#fff", opacity: draft.trim() ? 1 : 0.4, display: "grid", placeItems: "center" }}>
                        <Icon name="arrow_upward" size={20} />
                      </button>
                    </div>
                  </form>
                </section>

                <aside style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ background: "var(--group)", borderRadius: 14, padding: 16, display: "flex", alignItems: "center", gap: 16 }}>
                    <svg viewBox="0 0 100 100" style={{ width: 84, height: 84, flex: "none", transform: "rotate(-90deg)" }}>
                      <circle cx="50" cy="50" r="42" fill="none" stroke="var(--fill-2)" strokeWidth="9" />
                      <circle cx="50" cy="50" r="42" fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" strokeDasharray={(0.257 * 263.9).toFixed(1) + " 263.9"} />
                    </svg>
                    <div>
                      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>Session spend</div>
                      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>$1,284</div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>of $5,000 cap · 7 orders pending</div>
                    </div>
                  </div>
                  <div style={GROUP}>
                    <div style={{ padding: "14px 16px 6px", fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Guardrails</div>
                    {RULES.map(([text], i) => (
                      <button
                        key={text}
                        role="switch"
                        aria-checked={rules[i]}
                        onClick={() => setRules((x) => x.map((v, j) => (j === i ? !v : v)))}
                        style={{ ...BTN_RESET, width: "calc(100% - 16px)", marginLeft: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--line)", background: "transparent", color: "var(--ink)", textAlign: "left", padding: "9px 16px 9px 0", fontSize: 14, minHeight: 46 }}
                      >
                        <span>{text}</span>
                        <span style={{ flex: "none", width: 46, height: 28, borderRadius: 14, background: rules[i] ? "var(--up)" : "var(--fill-2)", position: "relative", transition: "background .2s" }}>
                          <span style={{ position: "absolute", top: 2, left: rules[i] ? 20 : 2, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 4px rgba(0,0,0,0.25)", transition: "left .2s" }} />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div style={GROUP}>
                    <div style={{ padding: "14px 16px 6px", fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Active agents</div>
                    <div style={{ ...MONO, fontSize: 12 }}>
                      {ACTIVE_AGENTS.map(([id, what, c]) => (
                        <div key={id} style={{ display: "flex", gap: 8, marginLeft: 16, padding: "9px 16px 9px 0", borderTop: "1px solid var(--line)" }}>
                          <span style={{ color: `var(--${c})` }}>●</span>
                          {id}
                          <span style={{ marginLeft: "auto", color: "var(--ink-3)", fontFamily: "var(--f-text)" }}>{what}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              </div>
            )}

            {screen === "compute" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                  {[
                    ["Inference / sec", (48221 + ((tick * 137) % 900) - 450).toLocaleString(), "", "rolling 60s"],
                    ["Tokens / day", "1.84B", "", "research + synthesis"],
                    ["Plan → execute", "612", " ms", "p50 latency"],
                    ["Vector store", "38.1", " TB", "4.2M entities"],
                  ].map(([k, v, unit, sub], i) => (
                    <div key={k} style={{ padding: i ? "18px 20px" : "18px 20px 18px 0", borderLeft: i ? "1px solid var(--line)" : 0 }}>
                      <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{k}</div>
                      <div style={{ fontFamily: "var(--f-display)", fontSize: 40, fontWeight: 700, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>
                        {v}
                        {unit && <span style={{ fontSize: 17, color: "var(--ink-3)", fontWeight: 600 }}>{unit}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8, margin: "40px 0 14px" }}>
                  <h2 style={H2}>GPU fabric · DC-EAST</h2>
                  <span style={{ ...MONO, fontSize: 12, color: "var(--ink-3)" }}>2,304 H100/B200 · 86.4% util · 41.2°C</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(14px,1fr))", gap: 3 }}>
                  {rack.map((bg, i) => (
                    <span key={i} style={{ aspectRatio: "1", borderRadius: 3, background: bg }} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 12, color: "var(--ink-3)", alignItems: "center" }}>
                  <span>Load</span>
                  <span style={{ width: 120, height: 6, borderRadius: 3, background: "linear-gradient(90deg,var(--fill-2),color-mix(in oklch,var(--accent) 30%,transparent),var(--accent))" }} />
                  <span>Idle → hot</span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 44, marginTop: 44 }}>
                  <div>
                    <ListHead title="Model routing" meta="last 60s" />
                    {ROUTES.map(([m, p, ms, q]) => (
                      <div key={m} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 70px 50px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ ...MONO, display: "block", fontSize: 13, fontWeight: 600 }}>{m}</span>
                          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{q}</span>
                        </span>
                        <span style={{ height: 4, borderRadius: 2, background: "var(--fill-2)" }}>
                          <span style={{ display: "block", height: "100%", borderRadius: 2, width: p * 100 + "%", background: "var(--blue)" }} />
                        </span>
                        <span style={{ textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>{ms} ms</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <ListHead title="Pipelines" meta="10 healthy" metaColor="var(--up)" />
                    {PIPES.map(([name, e]) => (
                      <StatusRow key={name} name={name} meta={e} mono />
                    ))}
                  </div>
                  <div>
                    <ListHead title="Venues" meta="13 connected" />
                    {VENUES.map(([name, l]) => (
                      <StatusRow key={name} name={name} meta={l} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export function BrandMark({ size = 18, ring = "var(--ink)" }: { size?: number; ring?: string }) {
  const dot = Math.round(size / 3);
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${ring}`, display: "grid", placeItems: "center", flex: "none" }}>
      <span style={{ width: dot, height: dot, borderRadius: "50%", background: "var(--accent)" }} />
    </span>
  );
}

function Ping({ size = 7 }: { size?: number }) {
  return (
    <span style={{ position: "relative", width: size, height: size, display: "inline-block" }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "currentColor" }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "currentColor", animation: "mer-ping 2s ease-out infinite" }} />
    </span>
  );
}

function SectionHead({ title, action, onAction }: { title: string; action: string; onAction: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "48px 0 14px" }}>
      <h2 style={H2}>{title}</h2>
      <button onClick={onAction} style={{ ...BTN_RESET, background: "transparent", color: "var(--tint)", fontSize: 14 }}>
        {action}
      </button>
    </div>
  );
}

function HeatRow({ f, i }: { f: string; i: number }) {
  return (
    <>
      <span style={{ color: "var(--ink-3)", display: "flex", alignItems: "center" }}>{f}</span>
      {SECT.map((c, j) => {
        const v = ((((i * 31 + j * 17) % 100) / 100) - 0.5) * 2;
        const pct = Math.round(12 + Math.abs(v) * 55);
        return (
          <span key={c} style={{ height: 26, display: "grid", placeItems: "center", background: `color-mix(in oklch,${v >= 0 ? "var(--up)" : "var(--down)"} ${pct}%,transparent)`, color: "var(--ink)" }}>
            {v.toFixed(1)}
          </span>
        );
      })}
    </>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ ...CHIP_GLASS, borderRadius: 12, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums", color }}>
        {value}
        {sub && <span style={{ fontSize: 13, color: "var(--ink-3)", fontWeight: 500, letterSpacing: 0 }}>{sub}</span>}
      </div>
    </div>
  );
}

function Legend({ color, label, bar }: { color: string; label: string; bar?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={bar ? { width: 14, height: 4, borderRadius: 2, background: color } : { width: 7, height: 7, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function ListHead({ title, meta, metaColor }: { title: string; meta: string; metaColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
      <h2 style={H2}>{title}</h2>
      <span style={{ fontSize: 12, color: metaColor ?? "var(--ink-3)", fontWeight: metaColor ? 600 : 400 }}>{meta}</span>
    </div>
  );
}

function StatusRow({ name, meta, mono }: { name: string; meta: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--up)" }} />
      <span style={mono ? MONO : { fontWeight: 500 }}>{name}</span>
      <span style={{ ...(mono ? {} : MONO), marginLeft: "auto", color: "var(--ink-3)", fontSize: 12 }}>{meta}</span>
    </div>
  );
}
