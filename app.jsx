// MERIDIAN — main app shell
const { useState: useStateApp, useEffect: useEffectApp } = React;

const SCREENS = [
  { id: "swarm",     num: "01", label: "Swarm Command",        comp: () => window.SwarmScreen },
  { id: "research",  num: "02", label: "Research Engine",      comp: () => window.ResearchScreen },
  { id: "portfolio", num: "03", label: "Portfolio OS",         comp: () => window.PortfolioScreen },
  { id: "console",   num: "04", label: "Operator Console",     comp: () => window.ConsoleScreen },
  { id: "compute",   num: "05", label: "Compute Layer",        comp: () => window.ComputeScreen },
];

const CRUMBS = {
  swarm:     ["Intelligence", "Swarm Command"],
  research:  ["Intelligence", "Research Engine"],
  portfolio: ["Capital", "Portfolio OS"],
  console:   ["Operator", "Console"],
  compute:   ["System", "Compute Layer"],
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "brandName": "MERIDIAN",
  "brandTagline": "AUTONOMOUS CAPITAL INTELLIGENCE",
  "accent": "#e8a64d",
  "density": "default",
  "showGrid": true
}/*EDITMODE-END*/;

function Rail({ active, setActive, brand, tagline }) {
  return (
    <aside className="rail" data-screen-label="rail">
      <div className="rail-brand">
        <div className="mark" />
        <div>
          <div className="name">{brand}</div>
          <div className="sub">{tagline}</div>
        </div>
      </div>

      <div className="rail-section">Workspaces</div>
      <nav className="rail-nav">
        {SCREENS.map(s => (
          <button key={s.id} className={active === s.id ? "active" : ""} onClick={() => setActive(s.id)}>
            <span className="dot" />
            <span>{s.label}</span>
            <span className="num">{s.num}</span>
          </button>
        ))}
      </nav>

      <div className="rail-section">Books</div>
      <div style={{ padding: "4px 16px 0", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-2)", letterSpacing: "0.04em", lineHeight: 1.95 }}>
        <div><span className="amber">●</span> Flagship · $1.28B</div>
        <div><span className="amber">●</span> Macro Overlay · $0.41B</div>
        <div><span className="amber">●</span> Vol Arbitrage · $0.18B</div>
        <div style={{ color: "var(--ink-4)" }}>+ 2 paused</div>
      </div>

      <div className="rail-section">Posture</div>
      <div style={{ padding: "4px 16px 14px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-2)", lineHeight: 1.95 }}>
        <div>Net leverage <span style={{ color: "var(--ink-0)" }}>2.14×</span></div>
        <div>VaR (99,1d) <span style={{ color: "var(--ink-0)" }}>1.12%</span></div>
        <div>Cash <span style={{ color: "var(--ink-0)" }}>4.8%</span></div>
      </div>

      <div className="rail-foot">
        <div className="avatar">KP</div>
        <div className="who">
          <div className="name">K. Park</div>
          <div className="role">Portfolio Manager</div>
        </div>
      </div>
    </aside>
  );
}

function TopBar({ active }) {
  const crumbs = CRUMBS[active] || ["", ""];
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>{crumbs[0]}</span>
        <span className="sep">/</span>
        <span className="cur">{crumbs[1]}</span>
      </div>
      <MarketTicker />
      <div className="topbar-right">
        <span className="pill"><span className="pulse" />MARKETS OPEN · NYSE</span>
        <span className="mono"><UTCClock /></span>
      </div>
    </header>
  );
}

function StatusBar() {
  return (
    <footer className="status">
      <div className="cell"><span className="k">Session</span><span className="v mono">#2,841</span></div>
      <div className="cell"><span className="k">Operator</span><span className="v">K. Park</span></div>
      <div className="cell"><span className="k">Net</span><span className="v mono">+$10.45M</span><span className="ok">▲ 0.82%</span></div>
      <div className="cell"><span className="k">Agents</span><span className="v mono">4,552 / 6,128</span></div>
      <div className="cell"><span className="k">Inference</span><span className="v mono">48,221 /s</span></div>
      <div className="cell"><span className="k">Risk</span><span className="ok">●</span><span className="v">within bounds</span></div>
      <div className="cell"><span className="k">Build</span><span className="v mono">v4.7.21 · stable</span></div>
    </footer>
  );
}

function App() {
  const [active, setActive] = useStateApp("swarm");
  const t = window.useTweaks ? window.useTweaks(TWEAK_DEFAULTS) : null;
  const tweaks = t ? t[0] : TWEAK_DEFAULTS;
  const setTweak = t ? t[1] : () => {};

  // Apply accent live
  useEffectApp(() => {
    if (tweaks.accent) {
      document.documentElement.style.setProperty("--accent", tweaks.accent);
    }
  }, [tweaks.accent]);

  // Apply density (font scale)
  useEffectApp(() => {
    const root = document.documentElement;
    if (tweaks.density === "compact") root.style.fontSize = "12px";
    else if (tweaks.density === "comfortable") root.style.fontSize = "14px";
    else root.style.fontSize = "13px";
  }, [tweaks.density]);

  const Screen = SCREENS.find(s => s.id === active).comp();

  return (
    <>
      <div className="app">
        <Rail active={active} setActive={setActive} brand={tweaks.brandName} tagline={tweaks.brandTagline} />
        <TopBar active={active} />
        <main className="main" data-screen-label={`0${SCREENS.findIndex(s => s.id === active) + 1} ${SCREENS.find(s => s.id === active).label}`}>
          {Screen ? <Screen /> : <div style={{ padding: 40, color: "var(--ink-3)" }}>Loading…</div>}
        </main>
        <StatusBar />
      </div>

      {window.TweaksPanel && (
        <window.TweaksPanel title="Tweaks">
          <window.TweakSection title="Brand">
            <window.TweakText label="Codename" value={tweaks.brandName} onChange={v => setTweak("brandName", v)} />
            <window.TweakText label="Tagline" value={tweaks.brandTagline} onChange={v => setTweak("brandTagline", v)} />
          </window.TweakSection>
          <window.TweakSection title="Accent">
            <window.TweakColor
              label="Conviction signal"
              value={tweaks.accent}
              onChange={v => setTweak("accent", v)}
              options={["#e8a64d", "#d97757", "#8fb8c9", "#9caf88", "#c8b87a"]}
            />
          </window.TweakSection>
          <window.TweakSection title="Density">
            <window.TweakRadio
              label="UI scale"
              value={tweaks.density}
              onChange={v => setTweak("density", v)}
              options={[
                { label: "Compact", value: "compact" },
                { label: "Default", value: "default" },
                { label: "Comfort", value: "comfortable" },
              ]}
            />
          </window.TweakSection>
        </window.TweaksPanel>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
