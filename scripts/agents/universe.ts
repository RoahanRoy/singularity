/**
 * Tech-sector universe for the MVP loop. Hand-picked liquid US large-caps.
 * One ticker is selected per run (round-robin via cursor file) so the loop
 * stays cheap on tokens.
 */
import fs from "node:fs";
import path from "node:path";

export const TECH_UNIVERSE = [
  "AAPL", "MSFT", "GOOGL", "NVDA", "META",
  "AMZN", "TSLA", "AVGO", "AMD",  "CRM",
] as const;

const CURSOR = path.resolve(".agents-cursor");

export function nextTicker(): string {
  let i = 0;
  if (fs.existsSync(CURSOR)) i = (Number(fs.readFileSync(CURSOR, "utf8")) + 1) % TECH_UNIVERSE.length;
  fs.writeFileSync(CURSOR, String(i));
  return TECH_UNIVERSE[i];
}
