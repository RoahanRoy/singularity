import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import type { Market } from "@/lib/appwrite/schema";
import { getMandate, upsertMandate, isRiskPosture, POSTURE_CAPS } from "@/lib/fund/mandate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build-a-portfolio-from-scratch onboarding.
 *
 * GET  -> current mandates for both desks (null where not onboarded).
 * POST -> create or update a desk's mandate. Onboarding a new desk seeds
 *         cash = capital_base (nothing deployed yet); re-onboarding updates the
 *         posture/caps/capital base but preserves already-deployed cash — it
 *         never resets the book (that's a separate, explicit operator action).
 *
 * POST { market: "US"|"IN", capital_base: number,
 *        risk_posture: "conservative"|"balanced"|"aggressive", note?: string }
 */
type Body = { market?: string; capital_base?: unknown; risk_posture?: string; note?: string };

function isMarket(v: unknown): v is Market {
  return v === "US" || v === "IN";
}

export async function GET() {
  const { databases } = createAdminClient();
  const [us, inn] = await Promise.all([
    getMandate(databases, DATABASE_ID, "US"),
    getMandate(databases, DATABASE_ID, "IN"),
  ]);
  return Response.json({ ok: true, mandates: { US: us, IN: inn }, postures: POSTURE_CAPS });
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const market = body.market;
  const posture = body.risk_posture;
  const capital = Number(body.capital_base);

  if (!isMarket(market)) {
    return Response.json({ error: `market must be "US" or "IN", got ${JSON.stringify(body.market)}` }, { status: 400 });
  }
  if (!isRiskPosture(posture)) {
    return Response.json({ error: `risk_posture must be conservative|balanced|aggressive, got ${JSON.stringify(body.risk_posture)}` }, { status: 400 });
  }
  if (!Number.isFinite(capital) || capital <= 0) {
    return Response.json({ error: `capital_base must be a positive number, got ${JSON.stringify(body.capital_base)}` }, { status: 400 });
  }

  const { databases } = createAdminClient();
  const { mandate, created } = await upsertMandate(databases, DATABASE_ID, {
    market,
    capital_base: capital,
    risk_posture: posture,
    note: typeof body.note === "string" ? body.note.slice(0, 512) : undefined,
  });

  return Response.json({ ok: true, created, mandate });
}
