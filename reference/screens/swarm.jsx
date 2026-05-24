// Screen 1: Swarm Command Center
const { useState: useStateS1, useEffect: useEffectS1, useMemo: useMemoS1, useRef: useRefS1 } = React;

function SwarmCanvas({ selectedCluster }) {
  const ref = useRefS1(null);
  const [size, setSize] = useStateS1({ w: 800, h: 600 });

  useEffectS1(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  // Generate clustered nodes
  const { nodes, edges, clusters } = useMemoS1(() => {
    const W = 1000, H = 700;
    function rng(seed) {
      let a = seed;
      return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    const r = rng(424242);
    const clusterDefs = [
      { id: "earnings", name: "Earnings Forensics", x: 0.30, y: 0.35, count: 42, color: "var(--accent)" },
      { id: "macro",    name: "Macro & Rates",      x: 0.68, y: 0.28, count: 36, color: "var(--accent)" },
      { id: "vol",      name: "Vol Surface",        x: 0.84, y: 0.55, count: 22, color: "var(--accent)" },
      { id: "equities", name: "Equities US",        x: 0.22, y: 0.62, count: 48, color: "var(--accent)" },
      { id: "credit",   name: "Credit & HY",        x: 0.50, y: 0.78, count: 26, color: "var(--accent)" },
      { id: "geo",      name: "Geopolitical",       x: 0.78, y: 0.82, count: 20, color: "var(--accent)" },
      { id: "alt",      name: "Alt-Data",           x: 0.52, y: 0.18, count: 32, color: "var(--cyan)" },
      { id: "exec",     name: "Execution",          x: 0.10, y: 0.30, count: 16, color: "var(--cyan)" },
      { id: "risk",     name: "Risk Topology",      x: 0.92, y: 0.30, count: 18, color: "var(--cyan)" },
    ];
    const nodes = [];
    clusterDefs.forEach(c => {
      const cx = c.x * W, cy = c.y * H;
      const radius = 24 + Math.sqrt(c.count) * 7;
      for (let i = 0; i < c.count; i++) {
        const ang = r() * Math.PI * 2;
        const dist = Math.pow(r(), 0.65) * radius;
        nodes.push({
          id: c.id + "-" + i,
          cluster: c.id,
          x: cx + Math.cos(ang) * dist,
          y: cy + Math.sin(ang) * dist,
          r: 1.2 + r() * 1.6,
          color: c.color,
          active: r() < 0.18,
          conv: r(),
        });
      }
    });
    // Inter-cluster signal edges
    const edges = [];
    const clusterMap = {};
    clusterDefs.forEach(c => clusterMap[c.id] = c);
    const links = [
      ["earnings", "equities"], ["earnings", "macro"], ["macro", "vol"],
      ["vol", "risk"], ["alt", "earnings"], ["alt", "macro"],
      ["equities", "credit"], ["credit", "risk"], ["geo", "macro"],
      ["geo", "credit"], ["exec", "equities"], ["exec", "vol"],
      ["alt", "geo"], ["risk", "credit"],
    ];
    links.forEach(([a, b], i) => {
      const A = clusterMap[a], B = clusterMap[b];
      edges.push({
        id: a + "-" + b,
        x1: A.x * W, y1: A.y * H,
        x2: B.x * W, y2: B.y * H,
        delay: (i * 0.7) % 6,
      });
    });
    return { nodes, edges, clusters: clusterDefs };
  }, []);

  // Pulse selection state — periodically pick a node to "fire"
  const [pulse, setPulse] = useStateS1(null);
  useEffectS1(() => {
    const id = setInterval(() => {
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      setPulse({ ...n, key: Date.now() });
    }, 900);
    return () => clearInterval(id);
  }, [nodes]);

  const viewW = 1000, viewH = 700;

  return (
    <div className="swarm-canvas" ref={ref}>
      <div className="hud-tl">SWARM TOPOLOGY · v2.41<br />NODES {nodes.length.toLocaleString()} · EDGES {edges.length}</div>
      <div className="hud-tr">LIVE · 24/7<br /><UTCClock /></div>

      <svg viewBox={`0 0 ${viewW} ${viewH}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="nodeGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nodeGlowC" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* faint grid */}
        <g opacity="0.06" stroke="var(--ink-2)" strokeWidth="0.5">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={"v" + i} x1={i * 50} y1="0" x2={i * 50} y2={viewH} />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={"h" + i} x1="0" y1={i * 50} x2={viewW} y2={i * 50} />
          ))}
        </g>

        {/* edges */}
        {edges.map(e => (
          <g key={e.id}>
            <line
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke="var(--cyan)" strokeOpacity="0.15" strokeWidth="0.6"
              strokeDasharray="2 4"
            />
            <circle r="2.2" fill="var(--cyan)">
              <animateMotion dur="6s" repeatCount="indefinite" begin={`${-e.delay}s`}
                path={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} />
              <animate attributeName="opacity" values="0;1;0" dur="6s" repeatCount="indefinite" begin={`${-e.delay}s`} />
            </circle>
          </g>
        ))}

        {/* cluster halos */}
        {clusters.map(c => {
          const sel = selectedCluster === c.id;
          return (
            <g key={c.id}>
              <circle
                cx={c.x * viewW} cy={c.y * viewH}
                r={28 + Math.sqrt(c.count) * 7}
                fill="none"
                stroke={sel ? "var(--accent)" : "var(--line-strong)"}
                strokeOpacity={sel ? 0.9 : 0.35}
                strokeDasharray="3 5"
                strokeWidth={sel ? 1 : 0.6}
              />
              <text x={c.x * viewW} y={c.y * viewH - (32 + Math.sqrt(c.count) * 7)}
                textAnchor="middle"
                fill={sel ? "var(--ink-0)" : "var(--ink-2)"}
                fontFamily="var(--mono)" fontSize="9"
                letterSpacing="1.6">
                {c.name.toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* nodes */}
        {nodes.map(n => (
          <circle
            key={n.id}
            cx={n.x} cy={n.y} r={n.r}
            fill={n.color}
            opacity={n.active ? 0.95 : 0.55}
          />
        ))}

        {/* periodic pulse */}
        {pulse && (
          <g key={pulse.key}>
            <circle cx={pulse.x} cy={pulse.y} r="4" fill={pulse.color}>
              <animate attributeName="r" from="3" to="22" dur="1.2s" fill="freeze" />
              <animate attributeName="opacity" from="0.8" to="0" dur="1.2s" fill="freeze" />
            </circle>
            <circle cx={pulse.x} cy={pulse.y} r="2.4" fill={pulse.color} opacity="0.95" />
          </g>
        )}
      </svg>

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--accent)" }}></span>RESEARCH AGENTS</span>
        <span><span className="dot" style={{ background: "var(--cyan)" }}></span>INFRASTRUCTURE AGENTS</span>
        <span><span className="dot" style={{ background: "var(--ink-3)" }}></span>IDLE</span>
      </div>
    </div>
  );
}

function SwarmFeed() {
  const seed = window.MD.feedSeed;
  const [items, setItems] = useStateS1(seed.slice(0, 8));
  useEffectS1(() => {
    let i = 8;
    const id = setInterval(() => {
      const next = seed[i % seed.length];
      setItems(prev => [{ ...next, t: "0.1s" }, ...prev.slice(0, 7)]);
      i++;
    }, 3200);
    return () => clearInterval(id);
  }, [seed]);

  return (
    <div className="feed">
      {items.map((it, i) => (
        <div className="feed-item" key={i + "-" + it.a}>
          <div className="top">
            <span style={{ color: "var(--accent)" }}>● {it.c}</span>
            <span style={{ marginLeft: "auto" }}>{it.a}</span>
            <span style={{ color: "var(--ink-4)" }}>{i === 0 ? "live" : it.t}</span>
          </div>
          <div className="msg" dangerouslySetInnerHTML={{ __html: it.msg }} />
        </div>
      ))}
    </div>
  );
}

function SwarmScreen() {
  const clusters = window.MD.clusters;
  const [sel, setSel] = useStateS1("earnings");
  const total = clusters.reduce((s, c) => s + c.agents, 0);
  return (
    <div className="swarm">
      <Panel title="Clusters" meta={`${total.toLocaleString()} agents`} bodyClassName="tight">
        <div className="cluster-list">
          {clusters.map(c => (
            <div key={c.id} className={"cluster " + (c.color === "cyan" ? "cyan " : "") + (sel === c.id ? "sel" : "")}
                 onClick={() => setSel(c.id)}>
              <div className="name">{c.name}</div>
              <div className="meta">{c.agents}</div>
              <div className="meta" style={{ gridColumn: "1 / -1" }}>
                conv <span className="mono" style={{ color: "var(--ink-1)" }}>{c.conv.toFixed(2)}</span>
              </div>
              <div className="bar"><i style={{ width: (c.conv * 100) + "%" }} /></div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="panel" style={{ borderTop: 0, borderBottom: 0 }}>
        <div className="panel-head">
          <span className="title">Swarm Topology</span>
          <span className="meta">{total.toLocaleString()} agents · 14 active threads · 0 anomalies</span>
        </div>
        <div className="panel-body tight" style={{ position: "relative", overflow: "hidden" }}>
          <SwarmCanvas selectedCluster={sel} />
        </div>
      </div>

      <Panel title="Activity Stream" meta="↓ live" bodyClassName="tight">
        <SwarmFeed />
      </Panel>
    </div>
  );
}

window.SwarmScreen = SwarmScreen;
