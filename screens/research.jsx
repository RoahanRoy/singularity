// Screen 2: Autonomous Research Engine
const { useState: useStateS2, useEffect: useEffectS2 } = React;

const docs = [
  { src: "10-K", tk: "NVDA",  ttl: "Annual Report — segment commentary on China-restricted SKUs and supply mix.", when: "0.4s", sel: false },
  { src: "EARNINGS CALL", tk: "TSM", ttl: "Q4 2025 transcript — capex language softens; mgmt deflects two questions on inventory.", when: "12s", sel: true },
  { src: "8-K",   tk: "AVGO", ttl: "Executive departure disclosure — CFO transition, no successor named.", when: "1m 4s", sel: false },
  { src: "13F",   tk: "BX",   ttl: "Reported holdings reveal -$340M reduction in semiconductor names.", when: "3m 12s", sel: false },
  { src: "S-1",   tk: "—",    ttl: "Newly filed: vertical-AI infra company, lead investors include sovereign vehicle.", when: "8m", sel: false },
  { src: "NEWS",  tk: "ASML", ttl: "Reuters wire — export-license clarification scheduled next month.", when: "11m", sel: false },
  { src: "PATENT", tk: "GOOG", ttl: "Granted: distillation method for sub-300B parameter models.", when: "23m", sel: false },
  { src: "ALT",   tk: "AMZN", ttl: "Truck-stop diesel throughput dataset — -2.4% w/w, NA corridors.", when: "31m", sel: false },
  { src: "REG",   tk: "JPM",  ttl: "Fed exam letter referenced in proxy; mention of liquidity stress overlay.", when: "47m", sel: false },
];

function DocList({ sel, setSel }) {
  return (
    <div>
      {docs.map((d, i) => (
        <div key={i} className={"doc " + (i === sel ? "sel" : "")} onClick={() => setSel(i)}>
          <div className="row">
            <span className="src">{d.src}</span>
            <span className="tk mono">{d.tk}</span>
          </div>
          <div className="ttl">{d.ttl}</div>
          <div className="when">ingested {d.when} ago</div>
        </div>
      ))}
    </div>
  );
}

function TranscriptView() {
  return (
    <div style={{ position: "relative", padding: "0 0 40px" }}>
      <div className="transcript">
        <div className="speaker">CFO · prepared remarks · 14:22 elapsed</div>
        <p>
          We continue to see <mark>solid demand</mark> across high-performance compute, with N-3 utilization remaining near
          historical peaks. However, our customers in the AI-accelerator segment are <mark className="cyan">re-pacing certain
          orders</mark> as they reconcile build schedules with downstream platform readiness. We view this as a
          timing matter, not a demand matter.
        </p>

        <div className="speaker">Analyst — Morgan Stanley</div>
        <p>
          Could you help us understand the magnitude of that re-pacing? Specifically, is this concentrated in any
          customer or geography, and how should we think about Q1?
        </p>

        <div className="speaker">CFO</div>
        <p>
          We are <mark className="red">not in a position to disaggregate that today.</mark> What I can say is that the
          overall picture for the year remains consistent with the framework we shared in October.
          We expect <mark>capital expenditures in 2026 to be roughly in line with 2025</mark>, with some flex around
          equipment delivery timing.
        </p>

        <div className="speaker">CEO</div>
        <p>
          I want to add — we are extremely confident in the long-term trajectory. The conversations we are having
          with our largest customers are <mark className="cyan">as constructive as they have ever been.</mark>
        </p>
      </div>

      {/* Callouts */}
      <div className="callout" style={{ right: 14, top: 88 }}>
        <span className="lbl">Forensic · earnings/4f-118</span>
        <div>Phrase <span className="amber">"solid demand"</span> appears 14× this call vs. mean 4.1×. Hedging detected vs. last 8 prints. Confidence <b>0.82</b>.</div>
      </div>

      <div className="callout" style={{ right: 14, top: 240 }}>
        <span className="lbl">Tone delta · vs. Q2 2025</span>
        <div>Management certainty score <span className="amber">−0.31σ</span>. Two question deflections logged. Cross-ref TSM, ASML supply commentary.</div>
      </div>

      <div className="callout" style={{ right: 14, top: 380 }}>
        <span className="lbl">Trade thesis · auto-generated</span>
        <div>Pair: long <span className="amber">SOXX</span> / short <span className="amber">TSM 1M ATM call spread</span>. Sized 0.4% NAV. Awaits PM review.</div>
      </div>
    </div>
  );
}

function EntityPanel() {
  const entities = [
    { name: "Taiwan Semiconductor (TSM)", role: "subject",     w: 1.00 },
    { name: "Apple (AAPL)",              role: "customer",    w: 0.78 },
    { name: "NVIDIA (NVDA)",             role: "customer",    w: 0.74 },
    { name: "ASML Holding (ASML)",       role: "supplier",    w: 0.63 },
    { name: "Samsung Foundry",           role: "competitor",  w: 0.55 },
    { name: "Intel Foundry",             role: "competitor",  w: 0.44 },
    { name: "Mediatek (2454.TW)",        role: "peer",        w: 0.41 },
    { name: "Sumco Corporation",         role: "input",       w: 0.33 },
  ];
  return (
    <div>
      <div className="memo">
        <Tag tone="amber">DRAFT MEMO · v3</Tag>
        <h4 style={{ marginTop: 6 }}>TSM — Q4 print, demand softness signal</h4>
        <div className="ks">
          <span className="k">Conviction</span><span className="v">0.74</span>
          <span className="k">Horizon</span><span className="v">2-6 weeks</span>
          <span className="k">Size (NAV)</span><span className="v">0.40%</span>
          <span className="k">Sharpe (est.)</span><span className="v">1.82</span>
        </div>
        <p>
          Three independent agents converged on a softening-demand interpretation of management's tone, supported
          by alt-data divergence in NA capex shipments and a thinning options skew on TSM 1M. Suggested expression:
          long SOXX vs. short TSM call spread. Risk-managed via VIX overlay.
        </p>
      </div>

      <div style={{ padding: "6px 12px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
        Entity Graph
      </div>
      {entities.map((e, i) => (
        <div key={i} className="entity">
          <div className="name">{e.name}</div>
          <div className="row">
            <span style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{e.role}</span>
            <div className="bar"><i style={{ width: (e.w * 100) + "%" }} /></div>
            <span style={{ color: "var(--ink-1)" }}>{e.w.toFixed(2)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResearchScreen() {
  const [sel, setSel] = useStateS2(1);
  return (
    <div className="research">
      <Panel title="Ingest Queue" meta="2,418 / hr" bodyClassName="tight">
        <DocList sel={sel} setSel={setSel} />
      </Panel>

      <div className="panel" style={{ borderTop: 0, borderBottom: 0 }}>
        <div className="panel-head">
          <span className="title">TSM · Q4 2025 Earnings Call · Reasoning Overlay</span>
          <span className="meta">3 agents synthesizing · 0.74 conv.</span>
        </div>
        <div className="panel-body" style={{ position: "relative" }}>
          <TranscriptView />
        </div>
      </div>

      <Panel title="Synthesis" meta="auto" bodyClassName="tight">
        <EntityPanel />
      </Panel>
    </div>
  );
}

window.ResearchScreen = ResearchScreen;
