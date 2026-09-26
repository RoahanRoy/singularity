import type { Metadata } from "next";
import LandingClient from "@/components/landing/LandingClient";

export const metadata: Metadata = {
  title: "Meridian — A hedge fund run by agents, supervised by you",
  description:
    "Meridian reads every filing, drafts the thesis, sizes the trade and checks the risk. You approve what goes to market.",
  openGraph: {
    title: "Meridian — A hedge fund run by agents, supervised by you",
    description:
      "Meridian reads every filing, drafts the thesis, sizes the trade and checks the risk. You approve what goes to market.",
    type: "website",
  },
};

export default function LandingPage() {
  return <LandingClient />;
}
