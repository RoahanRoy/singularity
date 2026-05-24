# MERIDIAN — Autonomous Capital Intelligence

An interactive prototype of an AI-native hedge fund operating system. Visualizes a future where a small team of human operators supervises thousands of specialized AI agents that read filings, parse earnings, generate trade theses, construct portfolios, and execute trades autonomously.

Codename: **MERIDIAN**. Concept for an AI-native hedge fund (YC Spring 2026 brief).

## Two entry points

- `index.html` — **Operator view.** Full 5-screen cockpit: Swarm Command, Research Engine, Portfolio OS, Operator Console, Compute Layer. Live-ticking data, agent activity streams, dense information architecture.
- `Guided.html` — **Guided tour.** Simplified, one-idea-at-a-time walkthrough with plain-English explanations. Hover any underlined term (NAV, Sharpe, VaR, alpha, factor exposure, etc.) for an inline glossary tooltip.

## Running

No build step. Open `index.html` or `Guided.html` directly in a modern browser, or serve the directory:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000/.

## Stack

- React 18 via UMD + Babel Standalone (in-browser JSX transform)
- Vanilla CSS, no bundler
- Newsreader (serif), Geist (UI), JetBrains Mono (data) via Google Fonts

## Design system

- Matte graphite surfaces (`#08090b` base, `#11141a` panels)
- Sodium-amber accent for alpha/conviction signals
- Cool cyan for AI reasoning paths
- Otherwise monochrome — no gradients, no glow

## Files

- `index.html`, `app.jsx`, `components.jsx`, `tweaks-panel.jsx` — operator shell
- `screens/` — the five operator screens (swarm, research, portfolio, console, compute)
- `Guided.html`, `guided.jsx`, `guided.css`, `glossary.js` — guided tour + term definitions
- `data.js` — mock agent / portfolio / market data
- `styles.css` — operator view styles
- `DESIGN_README.md` — original handoff bundle README from Claude Design
