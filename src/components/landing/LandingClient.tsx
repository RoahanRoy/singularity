"use client";

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTheme } from "@/lib/meridian/theme";
import { BrandMark, DeskDemo } from "@/components/desk-demo/DeskDemo";
import type { DemoScreen } from "@/components/desk-demo/data";

type Chapter = {
  id: string;
  num: string;
  eyebrow: string;
  screen: DemoScreen;
  zoom: "approvals" | "memo" | "topology" | "chat";
  ah: string;
  ap: string;
  bh: string;
  bp: string;
};

// Each chapter pins a live desk frame, then zooms into one region of it as the
// reader scrolls, swapping the caption from the "a" beat to the "b" beat.
const CHAPTERS: Chapter[] = [
  {
    id: "portfolio", num: "01", eyebrow: "Portfolio", screen: "portfolio", zoom: "approvals",
    ah: "Your whole book, on one screen.",
    ap: "Live value across every IBKR and Kite account you connect, with P&L, Sharpe, drawdown and factor exposure underneath.",
    bh: "Nothing trades until you say so.",
    bp: "Every position the agents propose lands here with its vote count and conviction. Approve or decline in one tap. Auto-approve exists, but it's off by default.",
  },
  {
    id: "research", num: "02", eyebrow: "Research", screen: "research", zoom: "memo",
    ah: "It reads the filing before you've seen the headline.",
    ap: "10-Ks, 8-Ks, 13Fs and earnings calls are parsed within seconds of release and scored against the company's own history.",
    bh: "Then it writes the memo.",
    bp: "TSM's Q4 call: “solid demand” said 14 times against a 4.1 average, two questions deflected, certainty down 0.31σ. Three agents agreed. Draft thesis at conviction 0.74.",
  },
  {
    id: "swarm", num: "03", eyebrow: "Swarm", screen: "swarm", zoom: "topology",
    ah: "Twelve specialist teams, working at once.",
    ap: "Macro, earnings forensics, volatility, credit, alt-data, execution and risk. Each reads its own sources and reports into one feed.",
    bh: "Disagreement is shown, not averaged away.",
    bp: "When agents converge, conviction rises. When two of them dissent, the trade stops and waits for a human.",
  },
  {
    id: "console", num: "04", eyebrow: "Console", screen: "console", zoom: "chat",
    ah: "Tell it what you want in a sentence.",
    ap: "“Reduce China-linked semi exposure 15%. Keep the idiosyncratic alpha.”",
    bh: "It comes back with a plan and a button.",
    bp: "Three execution paths modelled. Path B keeps 87% of alpha, cuts exposure from 9.4% to 8.0% and passes the risk overlay. Authorize it, or send it back.",
  },
];

type Role = "research" | "decision" | "gate" | "execution" | "post";
const STAGES: [string, string, Role][] = [
  ["00", "Budget", "gate"], ["01", "Filing parser", "research"], ["02", "Earnings reviewer", "research"],
  ["03", "Sector analyst", "research"], ["04", "Quant", "research"], ["05", "Red-team critic", "gate"],
  ["06", "Valuation", "research"], ["07", "Committee", "gate"], ["08", "Portfolio manager", "decision"],
  ["09", "Treasury", "decision"], ["10", "Risk officer", "gate"], ["11", "Risk overlay", "gate"],
  ["12", "Compliance", "gate"], ["13", "Router", "execution"], ["14", "Broker", "execution"],
  ["15", "TCA", "post"], ["16", "Recon", "post"],
];
const ROLE: Record<Role, string> = {
  research: "color-mix(in oklch,var(--tint) 70%,transparent)",
  decision: "var(--accent)",
  gate: "color-mix(in oklch,var(--down) 70%,transparent)",
  execution: "var(--up)",
  post: "var(--group-2)",
};
const ROLE_KEY: [Role, string][] = [
  ["research", "Research"], ["decision", "Decision"], ["gate", "Gate"], ["execution", "Execution"], ["post", "Post-trade"],
];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

type Region = { x: number; y: number; w: number; h: number };
type Size = { w: number; h: number };

const DISPLAY: CSSProperties = { fontFamily: "var(--f-display)", fontWeight: 700, textWrap: "balance" };
const PRIMARY_CTA: CSSProperties = {
  background: "var(--tint)",
  color: "#fff",
  padding: "12px 22px",
  borderRadius: 980,
  fontSize: 17,
  fontWeight: 500,
  textDecoration: "none",
};

export default function LandingClient() {
  const [theme, toggleTheme] = useTheme("dark");
  const [reduce, setReduce] = useState(false);
  const [navEdge, setNavEdge] = useState(false);
  const [wide, setWide] = useState(true);
  const [fw, setFw] = useState(1240);
  const [tilt, setTilt] = useState(14);
  const [prog, setProg] = useState<number[]>(() => CHAPTERS.map(() => 0));
  const [stage, setStage] = useState<Size[]>(() => CHAPTERS.map(() => ({ w: 800, h: 500 })));
  const [regions, setRegions] = useState<(Region | null)[]>(() => CHAPTERS.map(() => null));

  const frameRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<(HTMLElement | null)[]>([]);
  const stageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMq = () => setReduce(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => mq.removeEventListener("change", onMq);
  }, []);

  // Find each chapter's zoom target inside its (unscaled, 1280×800) desk.
  const measure = useCallback(() => {
    setStage(stageRefs.current.map((el) => (el ? { w: el.clientWidth, h: el.clientHeight } : { w: 800, h: 500 })));
    setRegions(
      CHAPTERS.map((c, i) => {
        const st = stageRefs.current[i];
        const desk = st?.querySelector<HTMLElement>("[data-desk]");
        const tg = desk?.querySelector<HTMLElement>(`[data-zoom="${c.zoom}"]`);
        if (!desk || !tg) return null;
        const dr = desk.getBoundingClientRect();
        const tr = tg.getBoundingClientRect();
        const k = dr.width / 1280 || 1;
        let x = (tr.left - dr.left) / k;
        let y = (tr.top - dr.top) / k;
        let w = tr.width / k;
        let h = tr.height / k;
        if (c.zoom === "memo") h = Math.min(h, 330);
        if (c.zoom === "approvals") h = Math.min(h, 420);
        if (c.zoom === "chat") {
          const hh = Math.min(h, 440);
          y = y + h - hh;
          h = hh;
        }
        if (c.zoom === "topology") {
          const cw = Math.min(w, 620);
          const ch = Math.min(h, 380);
          x = x + (w - cw) / 2;
          y = y + Math.max(0, (h - ch) / 2 - 40);
          w = cw;
          h = ch;
        }
        return { x: x - 12, y: y - 12, w: w + 24, h: h + 24 };
      }),
    );
    setWide(window.innerWidth >= 900);
    setFw(frameRef.current?.clientWidth ?? 1240);
  }, []);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const vh = window.innerHeight;
        const el = frameRef.current;
        if (el) {
          const top = el.getBoundingClientRect().top;
          setTilt(Math.round(clamp01((top - vh * 0.15) / (vh * 0.7)) * 140) / 10);
        }
        const next = secRefs.current.map((s) => {
          if (!s) return 0;
          const b = s.getBoundingClientRect();
          return clamp01(-b.top / (b.height - vh || 1));
        });
        setProg((p) => (next.every((v, i) => Math.abs(v - p[i]) < 0.002) ? p : next));
        setNavEdge(window.scrollY > 4);
      });
    };
    measure();
    onScroll();
    // Re-measure once fonts and the embedded desks have settled.
    const t1 = setTimeout(measure, 900);
    const t2 = setTimeout(measure, 2500);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
    };
  }, [measure]);

  const sc = fw / 1280;

  return (
    <div
      className="mx-land"
      data-theme={theme}
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--f-text)",
        fontSize: 17,
        lineHeight: 1.47,
        letterSpacing: "-0.01em",
        transition: "background-color .35s ease,color .35s ease",
      }}
    >
      <nav
        className="mx-glass"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          height: 48,
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "0 max(20px,calc((100% - 1040px)/2))",
          background: "var(--glass)",
          backdropFilter: "saturate(180%) blur(24px)",
          WebkitBackdropFilter: "saturate(180%) blur(24px)",
          boxShadow: `0 1px 0 ${navEdge ? "var(--line)" : "transparent"}`,
          transition: "box-shadow .3s ease",
        }}
      >
        <a href="#top" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink)", fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em", textDecoration: "none" }}>
          <BrandMark />
          Meridian
        </a>
        {wide && (
          <div style={{ display: "flex", gap: 24, fontSize: 12, fontWeight: 500, letterSpacing: 0 }}>
            {CHAPTERS.map((c) => (
              <a key={c.id} href={`#${c.id}`} style={{ color: "var(--ink-2)" }}>
                {c.eyebrow}
              </a>
            ))}
            <Link href="/how-it-works" style={{ color: "var(--ink-2)" }}>
              How it works
            </Link>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={toggleTheme}
            aria-label="Toggle appearance"
            className="mx-press"
            style={{ width: 28, height: 28, borderRadius: "50%", border: 0, background: "var(--seg)", color: "var(--ink-2)", cursor: "pointer", display: "grid", placeItems: "center" }}
          >
            <span className="msr" aria-hidden style={{ fontSize: 17 }}>
              {theme === "dark" ? "light_mode" : "dark_mode"}
            </span>
          </button>
          <Link href="/sign-in" style={{ fontSize: 12, color: "var(--ink)" }}>
            Sign in
          </Link>
          <Link href="/desk" className="mx-press" style={{ fontSize: 12, fontWeight: 500, color: "#fff", background: "var(--tint)", padding: "5px 12px", borderRadius: 980, textDecoration: "none" }}>
            Open the desk
          </Link>
        </div>
      </nav>

      <header id="top" style={{ textAlign: "center", padding: "clamp(72px,11vw,132px) 20px 0" }}>
        <h1 style={{ ...DISPLAY, margin: "0 auto", maxWidth: 900, fontSize: "clamp(46px,7.6vw,92px)", lineHeight: 1.02, letterSpacing: "-0.05em" }}>
          A hedge fund run by agents. Supervised by you.
        </h1>
        <p style={{ margin: "24px auto 0", fontSize: "clamp(19px,2.1vw,23px)", lineHeight: 1.38, color: "var(--ink-2)", maxWidth: 620, textWrap: "pretty" }}>
          Meridian reads every filing, drafts the thesis, sizes the trade and checks the risk. You approve what goes to market.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "center", marginTop: 32 }}>
          <Link href="/desk" className="mx-press" style={PRIMARY_CTA}>
            Open the desk
          </Link>
          <Link href="/guided" style={{ fontSize: 17 }}>
            Take the guided tour ›
          </Link>
        </div>

        <div ref={frameRef} style={{ position: "relative", maxWidth: 1240, margin: "clamp(48px,7vw,88px) auto 0", height: Math.round(830 * sc), perspective: 2400 }}>
          <div style={{ width: 1280, transformOrigin: "top left", transform: `scale(${sc.toFixed(4)})` }}>
            <div
              style={{
                transformOrigin: "50% 0%",
                transform: `rotateX(${reduce ? 0 : tilt}deg)`,
                borderRadius: 16,
                overflow: "hidden",
                background: "var(--frame)",
                boxShadow: "0 0 0 1px var(--line),0 40px 120px rgba(0,0,0,0.45)",
              }}
            >
              <div style={{ height: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: "1px solid var(--line)" }}>
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
                <span style={{ margin: "0 auto", fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--f-mono)" }}>meridian.fund/desk</span>
              </div>
              <div style={{ height: 800, textAlign: "left" }}>
                <DeskDemo theme={theme} onToggleTheme={toggleTheme} />
              </div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 18, fontSize: 14, color: "var(--ink-3)" }}>The real desk, running on sample data. Click around.</div>
      </header>

      <div style={{ height: "clamp(80px,10vw,140px)" }} />

      {CHAPTERS.map((c, i) => {
        const p = prog[i];
        const { w: W, h: H } = stage[i];
        const s0 = Math.min(W / 1280, H / 800);
        const tx0 = (W - 1280 * s0) / 2;
        const ty0 = (H - 800 * s0) / 2;
        const r = regions[i] ?? { x: 880, y: 100, w: 380, h: 420 };
        const s1 = Math.min(W / r.w, H / r.h, 2.4);
        const tx1 = W / 2 - (r.x + r.w / 2) * s1;
        const ty1 = H / 2 - (r.y + r.h / 2) * s1;
        const z = reduce ? (p >= 0.45 ? 1 : 0) : ease(clamp01((p - 0.28) / 0.4));
        const s = s0 + (s1 - s0) * z;
        const tx = tx0 + (tx1 - tx0) * z;
        const ty = ty0 + (ty1 - ty0) * z;
        const fa = reduce ? (p < 0.45 ? 1 : 0) : 1 - clamp01((p - 0.36) / 0.1);
        const fb = reduce ? (p < 0.45 ? 0 : 1) : clamp01((p - 0.44) / 0.1);
        const k = clamp01((p - 0.3) / 0.3);
        const beats = [
          { h: c.ah, p: c.ap, op: fa, y: reduce ? 0 : -(1 - fa) * 14 },
          { h: c.bh, p: c.bp, op: fb, y: reduce ? 0 : (1 - fb) * 14 },
        ];
        return (
          <section
            key={c.id}
            id={c.id}
            ref={(el) => {
              secRefs.current[i] = el;
            }}
            style={{ position: "relative", height: wide ? "260vh" : "220vh", borderTop: "1px solid var(--line)" }}
          >
            <div
              style={{
                position: "sticky",
                top: 48,
                height: "calc(100vh - 48px)",
                display: "flex",
                flexDirection: wide ? "row" : "column",
                alignItems: "center",
                gap: "clamp(20px,4vw,56px)",
                maxWidth: 1240,
                margin: "0 auto",
                padding: "clamp(16px,3vw,40px) 20px",
              }}
            >
              <div style={{ position: "relative", flex: `0 0 ${wide ? "360px" : "auto"}`, width: "100%", minHeight: wide ? 370 : 250 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-ink)", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "var(--f-mono)", color: "var(--ink-3)" }}>{c.num}</span>
                  {c.eyebrow}
                </div>
                <div style={{ position: "relative", marginTop: 14, height: wide ? 300 : 230 }}>
                  {beats.map((b, j) => (
                    <div
                      key={j}
                      aria-hidden={b.op < 0.5}
                      style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: b.op.toFixed(3), transform: `translateY(${b.y.toFixed(1)}px)`, willChange: "opacity,transform" }}
                    >
                      <h2 style={{ ...DISPLAY, margin: 0, fontSize: "clamp(30px,3.6vw,46px)", lineHeight: 1.06, letterSpacing: "-0.045em" }}>{b.h}</h2>
                      <p style={{ margin: "16px 0 0", fontSize: "clamp(17px,1.5vw,19px)", color: "var(--ink-2)", textWrap: "pretty" }}>{b.p}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ width: (22 - k * 16).toFixed(1) + "px", height: 6, borderRadius: 3, background: `color-mix(in oklch,var(--ink) ${Math.round(100 - k * 70)}%,transparent)` }} />
                  <span style={{ width: (6 + k * 16).toFixed(1) + "px", height: 6, borderRadius: 3, background: `color-mix(in oklch,var(--ink) ${Math.round(30 + k * 70)}%,transparent)` }} />
                </div>
              </div>
              <div
                ref={(el) => {
                  stageRefs.current[i] = el;
                }}
                aria-hidden
                style={{
                  position: "relative",
                  flex: "1 1 0",
                  minWidth: 0,
                  width: "100%",
                  height: wide ? "min(78vh,720px)" : "48vh",
                  borderRadius: 20,
                  overflow: "hidden",
                  background: "var(--frame)",
                  boxShadow: "0 0 0 1px var(--line)",
                }}
              >
                <div
                  data-desk="1"
                  inert
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 1280,
                    height: 800,
                    transformOrigin: "0 0",
                    transform: `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) scale(${s.toFixed(4)})`,
                    pointerEvents: "none",
                  }}
                >
                  <DeskDemo theme={theme} screen={c.screen} />
                </div>
              </div>
            </div>
          </section>
        );
      })}

      <section style={{ borderTop: "1px solid var(--line)" }}>
        <div
          style={{
            maxWidth: 1040,
            margin: "0 auto",
            padding: "clamp(96px,12vw,150px) 20px",
            display: "grid",
            gridTemplateColumns: wide ? "minmax(0,1.2fr) minmax(0,1fr)" : "minmax(0,1fr)",
            gap: 40,
            alignItems: "end",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-ink)" }}>Under the hood</div>
            <h2 style={{ ...DISPLAY, margin: "12px 0 0", fontSize: "clamp(34px,4.6vw,56px)", lineHeight: 1.04, letterSpacing: "-0.045em" }}>
              Sixteen hand-offs between a filing and a fill.
            </h2>
          </div>
          <div>
            <p style={{ margin: 0, color: "var(--ink-2)", textWrap: "pretty" }}>
              Budget check, parsing, sector analysis, red-team critique, valuation, committee, sizing, treasury, risk, compliance, routing, execution, cost analysis and reconciliation. Each stage does one job and can&apos;t do another&apos;s.
            </p>
            <Link href="/how-it-works" style={{ display: "inline-block", marginTop: 16 }}>
              See the full pipeline ›
            </Link>
          </div>
        </div>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 20px", display: "flex", gap: 3 }}>
          {STAGES.map(([n, name, role]) => (
            <div key={n} title={name} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ height: 44, borderRadius: 4, background: ROLE[role] }} />
              <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 6, fontFamily: "var(--f-mono)" }}>{n}</div>
            </div>
          ))}
        </div>
        <div style={{ maxWidth: 1040, margin: "14px auto 0", padding: "0 20px", display: "flex", flexWrap: "wrap", gap: 18, fontSize: 12, color: "var(--ink-2)" }}>
          {ROLE_KEY.map(([k, label]) => (
            <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: ROLE[k] }} />
              {label}
            </span>
          ))}
        </div>
      </section>

      <section style={{ textAlign: "center", padding: "clamp(110px,14vw,180px) 20px" }}>
        <h2 style={{ ...DISPLAY, margin: "0 auto", maxWidth: 820, fontSize: "clamp(40px,6.4vw,80px)", lineHeight: 1.02, letterSpacing: "-0.05em" }}>
          Connect a brokerage. Watch it work.
        </h2>
        <p style={{ margin: "20px auto 0", fontSize: 19, color: "var(--ink-2)", maxWidth: 560 }}>
          Works with Interactive Brokers for US equities and Zerodha Kite for NSE. Read-only until you approve a trade.
        </p>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", marginTop: 32, alignItems: "center" }}>
          <Link href="/desk" className="mx-press" style={PRIMARY_CTA}>
            Open the desk
          </Link>
          <Link href="/guided">Take the guided tour ›</Link>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--line)" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 20px 40px", display: "flex", flexWrap: "wrap", gap: "12px 28px", fontSize: 12, color: "var(--ink-3)" }}>
          <span style={{ marginRight: "auto" }}>© 2026 Meridian Capital Intelligence</span>
          <Link href="/how-it-works" style={{ color: "var(--ink-2)" }}>How it works</Link>
          <Link href="/guided" style={{ color: "var(--ink-2)" }}>Guided tour</Link>
          <Link href="/sign-in" style={{ color: "var(--ink-2)" }}>Operator sign-in</Link>
          <a href="mailto:hello@meridian.fund" style={{ color: "var(--ink-2)" }}>hello@meridian.fund</a>
        </div>
      </footer>
    </div>
  );
}
