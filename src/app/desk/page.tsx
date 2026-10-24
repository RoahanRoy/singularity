"use client";

import "./desk.css";
import { Shell, useDesk, type ScreenId } from "@/components/meridian/Shell";
import { AuthGate } from "@/components/meridian/AuthGate";
import { MarketProvider } from "@/components/meridian/MarketContext";
import { TodayScreen } from "@/components/meridian/desk/Today";
import { AuditLogScreen } from "@/components/meridian/desk/AuditLog";
import { AgentsScreen } from "@/components/meridian/desk/Agents";
import { FilingsView } from "@/components/meridian/desk/Research";
import { QuantView } from "@/components/meridian/desk/Quant";
import { BookScreen } from "@/components/meridian/desk/Book";
import { RiskScreen } from "@/components/meridian/desk/Risk";
import { ConsoleScreen } from "@/components/meridian/desk/Console";

function ResearchTabs() {
  const { researchView, setResearchView } = useDesk();
  return (
    <>
      <div className="m-tabs" role="tablist" aria-label="Research views" style={{ margin: "-8px 0 28px" }}>
        <button role="tab" aria-selected={researchView === "filings"} onClick={() => setResearchView("filings")}>
          Filings &amp; memos
        </button>
        <button role="tab" aria-selected={researchView === "quant"} onClick={() => setResearchView("quant")}>
          Quant
        </button>
      </div>
      {researchView === "quant" ? <QuantView /> : <FilingsView />}
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
      return <AgentsScreen />;
    case "console":
      return <ConsoleScreen />;
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
