import type { Metadata } from "next";
import HowItWorksClient from "@/components/howitworks/HowItWorksClient";

export const metadata: Metadata = {
  title: "How it works · Meridian",
  description:
    "Every agent and loop inside Meridian — what it does, why, and when — plus the decision pipeline, the guardrails, and what a human operator actually has to do.",
  openGraph: {
    title: "How Meridian works",
    description:
      "The honest map of the agent swarm: the 16-stage decision pipeline, the long-running loops, the model tiers, the guardrails, and the operator runbook.",
    type: "article",
  },
};

export default function HowItWorksPage() {
  return <HowItWorksClient />;
}
