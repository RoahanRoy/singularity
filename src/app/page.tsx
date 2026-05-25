"use client";

import { useState } from "react";
import { Shell, type ScreenId } from "@/components/meridian/Shell";
import { SwarmScreen } from "@/components/meridian/screens/Swarm";
import { ResearchScreen } from "@/components/meridian/screens/Research";

export default function Home() {
  const [active, setActive] = useState<ScreenId>("swarm");
  return (
    <Shell active={active} setActive={setActive}>
      {active === "swarm" && <SwarmScreen />}
      {active === "research" && <ResearchScreen />}
      {active !== "swarm" && active !== "research" && (
        <div style={{ padding: 40, color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
          screen :: {active} — loading…
        </div>
      )}
    </Shell>
  );
}
