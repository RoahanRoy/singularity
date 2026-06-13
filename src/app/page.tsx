import type { Metadata } from "next";
import LandingClient from "@/components/landing/LandingClient";

export const metadata: Metadata = {
  title: "Meridian · Autonomous Capital Intelligence",
  description:
    "An AI-native hedge fund operating system. A swarm of agents researches, allocates, and executes across global markets — supervised by a small team of humans.",
  openGraph: {
    title: "Meridian · Autonomous Capital Intelligence",
    description:
      "Autonomous capital, intelligently deployed. Markets move in microseconds — so does Meridian.",
    type: "website",
  },
};

export default function LandingPage() {
  return <LandingClient />;
}
