// MERIDIAN — Guided variant
// Simpler surface + hoverable explanations of finance/AI terms.

const { useState: useS, useEffect: useE, useRef: useR, useMemo: useM } = React;

/* ---------- Term + Tooltip ---------- */
const TooltipCtx = React.createContext(null);

function TooltipProvider({ children }) {
  const [tip, setTip] = useS(null); // { title, body, x, y }
  return (
    <TooltipCtx.Provider value={setTip}>
      {children}
      {tip && (
        <div
          className="tooltip"
          data-show="true"
          style={{
            left: Math.min(window.innerWidth - 340, Math.max(12, tip.x + 14)),
            top: Math.min(window.innerHeight - 160, Math.max(12, tip.y + 18)),
          }}
        >
          <div className="ttl">{tip.title}</div>
          <div className="body">{tip.body}</div>
        </div>
      )}
    </TooltipCtx.Provider>
  );
}

function Term({ k, children }) {
  const setTip = React.useContext(TooltipCtx);
  const key = (k || (typeof children === "string" ? children : "")).toLowerCase().trim();
  const entry = window.GLOSSARY[key];
  const onMove = e => {
    if (!entry) return;
    setTip({ title: entry.title, body: entry.body, x: e.clientX, y: e.clientY });
  };
  const onLeave = () => setTip(null);
  if (!entry) return <span>{children}</span>;
  return (
    <span
      className="term"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {children}
    </span>
  );
}

/* ---------- Swarm canvas (simpler) ---------- */
function GSwarm() {
  const { nodes, edges, clusters } = useM(() => {
    function rng(s) { let a = s; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const r = rng(7711);
    const cs = [
      { id: "earnings", name: "Earnings",      x: 0.30, y: 0.40, count: 30, color: "var(--accent)" },
      { id: "macro",    name: "Macro & Rates", x: 0.68, y: 0.28, count: 26, color: "var(--accent)" },
      { id: "equities", name: "Equities",      x: 0.20, y: 0.66, count: 34, color: "var(--accent)" },
      { id: "vol",      name: "Volatility",    x: 0.82, y: 0.60, count: 18, color: "var(--accent)" },
      { id: "alt",      name: "Alt-Data",      x: 0.52, y: 0.18, count: 22, color: "var(--cyan)" },
      { id: "risk",     name: "Risk",          x: 0.55, y: 0.82, count: 18, color: "var(--cyan)" },
    ];
    const nodes = [];
    cs.forEach(c => {
      const cx = c.x * 1000, cy = c.y * 460;
      const rad = 30 + Math.sqrt(c.count) * 7;
      for (let i = 0; i < c.count; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.pow(r(), 0.6) * rad;
        nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 1.4 + r() * 1.6, color: c.color });
      }
    });
    const links = [["earnings","equities"],["earnings","macro"],["macro","vol"],["alt","earnings"],["vol","risk"],["equities","risk"],["alt","macro"]];
    const cmap = {}; cs.forEach(c => cmap[c.id] = c);
    const edges = links.map(([a, b], i) => ({ x1: cmap[a].x * 1000, y1: cmap[a].y * 460, x2: cmap[b].x * 1000, y2: cmap[b].y * 460, d: (i * 0.6) % 4 }));
    return { nodes, edges, clusters: cs };
  }, []);

  return (
    <div className="g-swarm-canvas">
      <div className="hud">3,118 AGENTS · 6 CLUSTERS · LIVE</div>
      <svg viewBox="0 0 1000 460" preserveAspectRatio="xMidYMid meet">
        {edges.map((e, i) => (
          <g key={i}>
            <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="var(--cyan)" strokeOpacity="0.18" strokeWidth="0.7" strokeDasharray="3 5" />
            <circle r="2.6" fill="var(--cyan)">
              <animateMotion dur="4s" repeatCount="indefinite" begin={`${-e.d}s`}
                path={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} />
              <animate attributeName="opacity" values="0;1;0" dur="4s" repeatCount="indefinite" begin={`${-e.d}s`} />
            </circle>
          </g>
        ))}
        {clusters.map(c => (
          <g key={c.id}>
            <circle cx={c.x * 1000} cy={c.y * 460} r={32 + Math.sqrt(c.count) * 7}
                    fill="none" stroke="var(--line-strong)" strokeOpacity="0.4" strokeDasharray="3 5" strokeWidth="0.7" />
            <text x={c.x * 1000} y={c.y * 460 - (38 + Math.sqrt(c.count) * 7)}
                  textAnchor="middle" fill="var(--ink-2)" fontFamily="var(--mono)" fontSize="10" letterSpacing="2">
              {c.name.toUpperCase()}
            </text>
          </g>
        ))}
        {nodes.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity="0.75" />
        ))}
      </svg>
      <div className="legend">
        <span><span className="dot" style={{ background: "var(--accent)" }} />Research</span>
        <span><span className="dot" style={{ background: "var(--cyan)" }} />Infrastructure</span>
      </div>
    </div>
  );
}

/* ---------- Portfolio chart (simpler) ---------- */
function GPnL() {
  const data = useM(() => {
    const a = [0];
    for (let i = 1; i < 120; i++) a.push(a[i - 1] + (Math.random() - 0.46) * 0.16);
    return a;
  }, []);
  const w = 600, h = 160;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 20) - 10]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 160 }}>
      <defs>
        <linearGradient id="gPnlFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={d + ` L${w},${h} L0,${h} Z`} fill="url(#gPnlFill)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill="var(--accent)" />
    </svg>
  );
}

/* ---------- Screen 1: Overview / Swarm ---------- */
function SOverview() {
  return (
    <>
      <div>
        <div className="g-eyebrow">01 · Intelligence Layer</div>
        <h1 className="g-h1">A small team of humans supervises thousands of <Term>AI agents</Term>.</h1>
        <p className="g-lede">
          Each <Term>agent</Term> is a specialist — one reads <Term>10-K</Term> filings, another monitors <Term>macro</Term> conditions,
          another listens to <Term>earnings calls</Term>. Together they form a <Term>swarm</Term> that surfaces the highest-conviction
          trade ideas to humans for review. Hover any underlined term to see what it means.
        </p>
      </div>

      <GSwarm />

      <div className="g-grid-3">
        <div className="stat">
          <span className="k">Total agents</span>
          <span className="v">4,552</span>
          <span className="d">currently active across 12 specialist clusters</span>
        </div>
        <div className="stat">
          <span className="k">Ideas surfaced today</span>
          <span className="v">312</span>
          <span className="d">of which 7 escalated to operator review</span>
        </div>
        <div className="stat">
          <span className="k">Inter-agent <Term>dissent</Term></span>
          <span className="v">14</span>
          <span className="d">unresolved · 2 awaiting human ruling</span>
        </div>
      </div>

      <div className="g-card">
        <h3>What you're looking at</h3>
        <ul className="bullets" style={{ padding: 0, margin: 0 }}>
          <li><span className="ix">A</span><span>Each dot is one <Term>agent</Term>. Clusters group agents by what they specialize in — earnings forensics, <Term>macro</Term>, <Term>volatility</Term> surface, <Term>risk</Term>, and so on.</span></li>
          <li><span className="ix">B</span><span>The moving particles between clusters are signals propagating — an earnings finding nudging the macro view, or a risk warning re-rating the equities book.</span></li>
          <li><span className="ix">C</span><span>Humans don't research stocks. Humans set policy, allocate compute budget, and approve large trades. Everything below that line happens on its own.</span></li>
        </ul>
      </div>
    </>
  );
}

/* ---------- Screen 2: Research ---------- */
function SResearch() {
  return (
    <>
      <div>
        <div className="g-eyebrow">02 · Research</div>
        <h1 className="g-h1">Reading every filing, transcript, and patent — at machine speed.</h1>
        <p className="g-lede">
          Below is a live <Term>earnings call</Term> being read by three agents at once. Each one highlights different things:
          changes in tone, hedge words, evasions, contradictions vs. prior calls. The findings stack up on the right.
        </p>
      </div>

      <div className="g-research">
        <div className="g-doc">
          <div className="meta">
            <span className="pill amber">EARNINGS CALL</span>
            <span>TSM · Q4 2025</span>
            <span style={{ marginLeft: "auto" }}>14:22 elapsed · 3 agents reading</span>
          </div>
          <h2>TSM Q4 2025 — Prepared Remarks &amp; Q&amp;A</h2>

          <p><span style={{ color: "var(--ink-3)" }}>CFO:</span> "We continue to see <mark>solid demand</mark> across high-performance compute, with N-3 utilization remaining near historical peaks. However, our customers in the AI-accelerator segment are <mark>re-pacing certain orders</mark> as they reconcile build schedules with downstream platform readiness."</p>

          <p><span style={{ color: "var(--ink-3)" }}>Analyst:</span> "Could you help us understand the magnitude of that re-pacing? Specifically, is this concentrated in any customer or geography?"</p>

          <p><span style={{ color: "var(--ink-3)" }}>CFO:</span> "We are <mark>not in a position to disaggregate that today.</mark> What I can say is that the overall picture for the year remains consistent with the framework we shared in October. We expect <Term>capex</Term> in 2026 to be roughly in line with 2025."</p>

          <p><span style={{ color: "var(--ink-3)" }}>CEO:</span> "I want to add — we are extremely confident in the long-term trajectory. The conversations we are having with our largest customers are as constructive as they have ever been."</p>
        </div>

        <div>
          <div className="finding">
            <h4>Hedge-word density</h4>
            <p>"Solid demand" appears 14× this call vs. mean 4.1×. Cushioning language elevated. Pattern flagged.</p>
            <div className="meta">Agent · earnings/4f-118</div>
          </div>
          <div className="finding">
            <h4>Management tone delta</h4>
            <p>Certainty score −0.31σ vs. Q2. Two question deflections logged. Cross-references <Term>ASML</Term> supply commentary from earlier today.</p>
            <div className="meta">Agent · earnings/4f-9</div>
          </div>
          <div className="finding">
            <h4>Auto-generated <Term>thesis</Term></h4>
            <p>
              Pair trade: <Term>long</Term> SOXX / <Term>short</Term> TSM 1-month call spread. Sized 0.4% NAV.
              Expected <Term>Sharpe</Term> 1.8. Awaiting operator review.
            </p>
            <div className="meta">Synthesis · 3-agent consensus · <Term>conviction</Term> 0.74</div>
          </div>
        </div>
      </div>

      <div className="g-card">
        <h3>What changed here</h3>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink-1)" }}>
          Three independent agents read this call. None were told what to look for; they each ran their own playbook
          and surfaced patterns the human ear would miss — a word appearing three times more than usual, a tonal half-step
          down from last quarter, a refusal to answer a specific question. The system then proposed a trade. A human still
          has to say yes.
        </p>
      </div>
    </>
  );
}

/* ---------- Screen 3: Portfolio ---------- */
function SPortfolio() {
  return (
    <>
      <div>
        <div className="g-eyebrow">03 · Portfolio</div>
        <h1 className="g-h1">One book. Constantly rebalancing itself.</h1>
        <p className="g-lede">
          The portfolio is the output of every agent's work — sized, hedged, and stress-tested in real time.
          Humans set the constraints; the system finds the best portfolio that fits inside them.
        </p>
      </div>

      <div className="g-grid-4">
        <div className="stat"><span className="k"><Term>NAV</Term></span><span className="v">$1.28B</span><span className="d up">+$10.45M today</span></div>
        <div className="stat"><span className="k">YTD Return</span><span className="v">+18.4%</span><span className="d">vs. SPX +6.1%</span></div>
        <div className="stat"><span className="k"><Term>Sharpe</Term> ratio</span><span className="v">2.41</span><span className="d">trailing 12-month</span></div>
        <div className="stat"><span className="k">Max <Term>drawdown</Term></span><span className="v">−4.18%</span><span className="d down">peak-to-trough</span></div>
      </div>

      <div className="g-grid-2">
        <div className="g-pnl-card">
          <div className="head">
            <span className="nav">$1,284,902,144</span>
            <span className="delta">+0.82% today</span>
            <span className="sub"><Term>P&L</Term> · 120 sessions</span>
          </div>
          <GPnL />
          <div className="g-explain">
            Daily mark-to-market. Each tick is one trading day's profit or loss. Smooth, gradually rising lines are what
            you want — they signal alpha that isn't dependent on market direction.
          </div>
        </div>

        <div className="g-card">
          <h3><Term>Factor Exposure</Term></h3>
          <div className="g-exposures">
            {[
              ["US Large-cap", 0.72],
              ["Europe", 0.34],
              ["Japan", 0.21],
              ["Emerging Mkts", -0.12],
              ["Investment-grade credit", 0.46],
              ["Rates 2-5Y", -0.31],
              ["Gold", 0.41],
              ["Oil / Energy", -0.16],
            ].map(([k, v]) => (
              <div className="g-exposure-row" key={k}>
                <span className="label">{k}</span>
                <div className="bar">
                  <span className="z" />
                  {v >= 0 ? <i className="pos" style={{ width: (Math.abs(v) * 50) + "%" }} /> : <i className="neg" style={{ width: (Math.abs(v) * 50) + "%" }} />}
                </div>
                <span className="v" style={{ color: v >= 0 ? "var(--green)" : "var(--red)" }}>
                  {(v >= 0 ? "+" : "") + (v * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
          <div className="g-explain">
            Each row is one source of return the portfolio is tilted toward (or away from). Negative bars mean the
            book is <Term>short</Term> that factor — it profits if that exposure declines.
          </div>
        </div>
      </div>

      <div className="g-grid-3">
        <div className="stat"><span className="k"><Term>VaR</Term> (99, 1-day)</span><span className="v">1.12%</span><span className="d">worst-1% expected daily loss</span></div>
        <div className="stat"><span className="k">Net <Term>leverage</Term></span><span className="v">2.14×</span><span className="d">policy ceiling 2.8×</span></div>
        <div className="stat"><span className="k">Cash</span><span className="v">4.8%</span><span className="d">held in T-bills</span></div>
      </div>
    </>
  );
}

/* ---------- Screen 4: Console ---------- */
function SConsole() {
  return (
    <>
      <div>
        <div className="g-eyebrow">04 · Operator Console</div>
        <h1 className="g-h1">Humans direct the system in plain language.</h1>
        <p className="g-lede">
          No keyboard shortcuts to memorize, no menus three levels deep. The operator types a request, the
          <Term>orchestrator</Term> figures out which agents to wake up, runs the work, and proposes actions.
          Nothing executes without human approval above defined thresholds.
        </p>
      </div>

      <div className="g-console">
        <div className="g-chat">
          <div className="msg">
            <div className="av">KP</div>
            <div>
              <div className="who">Operator</div>
              <div className="body">Reduce our China-linked semiconductor exposure by 15%. Preserve idiosyncratic <Term>alpha</Term>. Run it through the new <Term>risk</Term> overlay before showing me anything.</div>
            </div>
          </div>

          <div className="msg ai">
            <div className="av">M</div>
            <div>
              <div className="who">Meridian</div>
              <div className="body">
                Modeled three paths. Recommending <span className="h">Path B</span> — staged over 2 sessions to avoid book-internal hedging cost.
                Preserves <span className="h">87%</span> of idiosyncratic alpha. Reduces exposure from 9.4% to 8.0%.
                Risk overlay passes. <span style={{ color: "var(--accent)" }}>2 of 28 agents dissented</span> and asked for human review of the pacing schedule.
              </div>
            </div>
          </div>

          <div className="msg">
            <div className="av">KP</div>
            <div>
              <div className="who">Operator</div>
              <div className="body">Show me the dissent first. Then we'll decide.</div>
            </div>
          </div>

          <div className="msg ai">
            <div className="av">M</div>
            <div>
              <div className="who">Meridian</div>
              <div className="body">
                "Risk/topology-04: the proposed unwind is correlated with our SOXX <Term>long</Term>. Pacing it across two days
                vs. one reduces market impact <Term>slippage</Term> by an estimated <Term>2.4 bp</Term> but exposes us to one
                additional overnight session of the original risk."
              </div>
            </div>
          </div>

          <div className="composer-simple">
            <div className="bar">
              <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}>›</span>
              <input placeholder="Ask the system to do anything — in plain English." />
              <button className="send">↵ send</button>
            </div>
          </div>
        </div>

        <div>
          <div className="g-card" style={{ marginBottom: 16 }}>
            <h3>Active rules</h3>
            <div style={{ fontSize: 13.5, lineHeight: 1.95, color: "var(--ink-1)" }}>
              <div>● Max single-name ≤ 1.2% <Term>NAV</Term></div>
              <div>● China-linked semi ≤ 10.0%</div>
              <div>● Net <Term>leverage</Term> ≤ 2.8×</div>
              <div>● <Term>VaR</Term> (99,1d) ≤ 1.8% NAV</div>
              <div>● Auto-execute &lt; $5M notional</div>
              <div>● 2+ <Term>dissent</Term> → human review</div>
            </div>
          </div>

          <div className="g-card">
            <h3>How decisions move</h3>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-1)" }}>
              Small trades execute on their own. Anything large, anything that would brush a policy boundary, anything an
              agent disagrees with — escalates here. The operator's job is to read context and rule on the edge cases.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- Screen 5: Compute ---------- */
function SCompute() {
  const units = useM(() => {
    const out = [];
    for (let i = 0; i < 120; i++) {
      const r = Math.random();
      let cls;
      if (r < 0.06) cls = "hot";
      else if (r < 0.34) cls = "warm";
      else if (r < 0.62) cls = "cool";
      else cls = "idle";
      out.push(cls);
    }
    return out;
  }, []);
  return (
    <>
      <div>
        <div className="g-eyebrow">05 · Compute</div>
        <h1 className="g-h1">The machine that makes the whole thing possible.</h1>
        <p className="g-lede">
          Below is the system's nervous system — GPUs that run the AI models, the <Term>vector store</Term> that holds the firm's
          memory, the pipelines that ingest filings and news, and the network of <Term>venues</Term> where trades actually fill.
        </p>
      </div>

      <div className="g-grid-4">
        <div className="stat"><span className="k"><Term>Inference</Term> / sec</span><span className="v">48,221</span><span className="d">rolling 60s</span></div>
        <div className="stat"><span className="k">Tokens / day</span><span className="v">1.84 B</span><span className="d">research &amp; synthesis</span></div>
        <div className="stat"><span className="k">Memory · <Term>vector store</Term></span><span className="v">38.1 TB</span><span className="d">4.2M entities · 38M edges</span></div>
        <div className="stat"><span className="k">Plan → execute <Term>latency</Term></span><span className="v">612 ms</span><span className="d"><Term>p50</Term> · p99 1.84 s</span></div>
      </div>

      <div className="g-card">
        <h3>GPU Fabric · DC-EAST</h3>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>2,304 GPUs · 86% utilization · each tile below is a node.</p>
        <div className="g-rack">
          {units.map((u, i) => <div key={i} className={"u " + u} />)}
        </div>
        <div className="caption">amber = hot · pale-cyan = serving · grey = idle</div>
      </div>

      <div className="g-grid-2">
        <div className="g-card">
          <h3>Ingestion pipelines</h3>
          <div style={{ fontSize: 13.5, lineHeight: 2, color: "var(--ink-1)" }}>
            <div>● Filings ingestion <span style={{ color: "var(--ink-3)" }}>· 12.4K/h</span></div>
            <div>● Earnings transcription <span style={{ color: "var(--ink-3)" }}>· 18 active calls</span></div>
            <div>● News, multilingual <span style={{ color: "var(--ink-3)" }}>· 2.4K stories/h</span></div>
            <div>● <Term>Alt-data</Term> fusion <span style={{ color: "var(--ink-3)" }}>· 84 streams</span></div>
            <div>● Patent graph <span style={{ color: "var(--ink-3)" }}>· rebuild every 22m</span></div>
            <div>● Compliance watch <span style={{ color: "var(--ink-3)" }}>· 0 alerts</span></div>
          </div>
        </div>

        <div className="g-card">
          <h3>Execution <Term>venues</Term></h3>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, lineHeight: 2, color: "var(--ink-1)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto" }}><span>NYSE · NASDAQ · ARCA</span><span style={{ color: "var(--ink-3)" }}>~0.4ms</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto" }}><span>CME · ICE · CBOE</span><span style={{ color: "var(--ink-3)" }}>~0.6ms</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto" }}><span>LSE · Eurex</span><span style={{ color: "var(--ink-3)" }}>~1.1ms</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto" }}><span>TSE · HKEX · SGX</span><span style={{ color: "var(--ink-3)" }}>~2.0ms</span></div>
          </div>
          <div className="g-explain">
            <Term>Latency</Term> shown is median round-trip from the system to each venue. Microseconds matter when
            you're trying to get filled at the price you saw.
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- Screens registry ---------- */
const G_SCREENS = [
  { id: "overview",  num: "01", label: "Overview",     comp: SOverview },
  { id: "research",  num: "02", label: "Research",     comp: SResearch },
  { id: "portfolio", num: "03", label: "Portfolio",    comp: SPortfolio },
  { id: "console",   num: "04", label: "Console",      comp: SConsole },
  { id: "compute",   num: "05", label: "Compute",      comp: SCompute },
];

function GuidedApp() {
  const [active, setActive] = useS("overview");
  const idx = G_SCREENS.findIndex(s => s.id === active);
  const Screen = G_SCREENS[idx].comp;
  const next = () => setActive(G_SCREENS[Math.min(idx + 1, G_SCREENS.length - 1)].id);
  const prev = () => setActive(G_SCREENS[Math.max(idx - 1, 0)].id);

  return (
    <TooltipProvider>
      <div className="guided">
        <aside className="g-rail">
          <div className="brand">
            <div className="mark" />
            <div>
              <div className="name">MERIDIAN</div>
              <div className="sub">GUIDED TOUR</div>
            </div>
          </div>

          <nav className="g-nav">
            {G_SCREENS.map(s => (
              <button key={s.id} className={active === s.id ? "active" : ""} onClick={() => setActive(s.id)}>
                <span className="num">{s.num}</span>
                <span className="label">{s.label}</span>
              </button>
            ))}
          </nav>

          <div className="hint">
            <div className="k">Tip</div>
            Hover any underlined word for a plain-English explanation. The full operator view lives at
            <br /><br />
            <a href="index.html" style={{ color: "var(--accent)", textDecoration: "none" }}>→ open full UI</a>
          </div>
        </aside>

        <header className="g-top" data-screen-label="header">
          <div className="step">
            Step <span className="cur">{G_SCREENS[idx].num}</span> of {G_SCREENS.length} · {G_SCREENS[idx].label}
          </div>
          <div className="pager">
            <button onClick={prev} disabled={idx === 0}>← Previous</button>
            <button className="primary" onClick={next} disabled={idx === G_SCREENS.length - 1}>
              {idx === G_SCREENS.length - 1 ? "End of tour" : "Next →"}
            </button>
          </div>
        </header>

        <main className="g-main" data-screen-label={`${G_SCREENS[idx].num} ${G_SCREENS[idx].label}`}>
          <Screen />
        </main>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<GuidedApp />);
