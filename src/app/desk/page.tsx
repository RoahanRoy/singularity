"use client";

import { useState } from "react";
import { Shell, type ScreenId } from "@/components/meridian/Shell";
import { AuthGate } from "@/components/meridian/AuthGate";
import { MarketProvider } from "@/components/meridian/MarketContext";
import { SwarmScreen } from "@/components/meridian/screens/Swarm";
import { ResearchScreen } from "@/components/meridian/screens/Research";
import { PortfolioScreen } from "@/components/meridian/screens/Portfolio";
import { ConsoleScreen } from "@/components/meridian/screens/Console";
import { ComputeScreen } from "@/components/meridian/screens/Compute";

const SCREENS = {
  swarm: SwarmScreen,
  research: ResearchScreen,
  portfolio: PortfolioScreen,
  console: ConsoleScreen,
  compute: ComputeScreen,
} as const;

export default function Desk() {
  const [active, setActive] = useState<ScreenId>("swarm");
  const Screen = SCREENS[active];
  return (
    <AuthGate>
      <MarketProvider>
        <Shell active={active} setActive={setActive}>
          <Screen />
        </Shell>
      </MarketProvider>
    </AuthGate>
  );
}
