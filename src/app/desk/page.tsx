"use client";

import type { ReactNode } from "react";
import "./desk.css";
import { Shell, useDesk, type ScreenId } from "@/components/meridian/Shell";
import { AuthGate } from "@/components/meridian/AuthGate";
import { MarketProvider } from "@/components/meridian/MarketContext";
import { TodayScreen } from "@/components/meridian/desk/Today";
import { AuditLogScreen } from "@/components/meridian/desk/AuditLog";
import { SwarmScreen } from "@/components/meridian/screens/Swarm";
import { ResearchScreen } from "@/components/meridian/screens/Research";
import { QuantScreen } from "@/components/meridian/screens/Quant";
import { BookScreen } from "@/components/meridian/desk/Book";
import { RiskScreen } from "@/components/meridian/desk/Risk";
import { ConsoleScreen } from "@/components/meridian/screens/Console";
import { ComputeScreen } from "@/components/meridian/screens/Compute";

// A screen not yet moved to the v2 layout keeps its own panel styles in a box.
function Legacy({ children }: { children: ReactNode }) {
  return (
    <div className="meridian-root mx-desk m-legacy" data-theme="dark">
      <div className="main">{children}</div>
    </div>
  );
}

function ResearchTabs() {
  const { researchView, setResearchView } = useDesk();
  return (
    <>
      <div className="m-seg sm" role="group" aria-label="Research view" style={{ marginBottom: 16 }}>
        <button aria-pressed={researchView === "filings"} onClick={() => setResearchView("filings")}>
          Filings &amp; memos
        </button>
        <button aria-pressed={researchView === "quant"} onClick={() => setResearchView("quant")}>
          Quant
        </button>
      </div>
      <Legacy>{researchView === "quant" ? <QuantScreen /> : <ResearchScreen />}</Legacy>
    </>
  );
}

function Screen({ id }: { id: ScreenId }) {
  switch (id) {
    case "today":
      return <TodayScreen />;
    case "book":
      return <BookScreen />;
    case "risk":
      return <RiskScreen />;
    case "research":
      return <ResearchTabs />;
    case "agents":
      return (
        <>
          <Legacy><SwarmScreen /></Legacy>
          <div style={{ height: 24 }} />
          <Legacy><ComputeScreen /></Legacy>
        </>
      );
    case "console":
      return <Legacy><ConsoleScreen /></Legacy>;
    case "log":
      return <AuditLogScreen />;
  }
}

export default function Desk() {
  return (
    <AuthGate>
      <MarketProvider>
        <Shell>{(screen) => <Screen id={screen} />}</Shell>
      </MarketProvider>
    </AuthGate>
  );
}
