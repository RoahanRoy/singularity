/**
 * The seven MVP agent nodes for the Tech-sector loop.
 *
 * Each node is a pure function: (ctx) => Promise<ctx>. The orchestrator chains
 * them. Side effects (Appwrite writes, console logs) happen inline so the UI
 * lights up step by step.
 */
import { ask, extractJson } from "./llm";
import { db, DB, ID, emit, setStatus, ensureAgent } from "./appwrite";

export type Ctx = {
  ticker: string;
  filing?: { form_type: string; filed_at: string; source_url: string; summary: string };
  memo?: { title: string; thesis: string; conviction: number };
  critique?: { score: number; concerns: string[]; verdict: "pass" | "revise" | "reject" };
  size?: { qty: number; weight_pct: number; reasoning: string };
  risk?: { approved: boolean; var_pct: number; notes: string };
  compliance?: { approved: boolean; flags: string[] };
  trade?: { id: string; status: "filled" | "rejected" };
  agentIds: Record<string, string>;
};

// 1. Filing Parser ----------------------------------------------------------
export async function parser(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.parser;
  await setStatus(id, "thinking");
  await emit(id, "thought", `Pulling latest filing for ${ctx.ticker}`);

  const raw = await ask({
    model: "haiku",
    system: "You simulate the SEC EDGAR ingestion agent. Respond ONLY with JSON.",
    user: `For ${ctx.ticker}, invent a plausible most-recent SEC filing as if you just parsed it.
Return JSON: { "form_type": "10-Q"|"10-K"|"8-K", "filed_at": ISO date in last 30 days,
"source_url": "https://www.sec.gov/...", "summary": "2-3 sentences of the most material disclosure" }.`,
  });
  const filing = extractJson<NonNullable<Ctx["filing"]>>(raw);

  await db.createDocument(DB, "filings", ID.unique(), {
    ticker: ctx.ticker,
    form_type: filing.form_type,
    filed_at: filing.filed_at,
    source_url: filing.source_url,
    status: "indexed",
    vector_id: null,
  });
  await emit(id, "tool_call", `Indexed ${filing.form_type} for ${ctx.ticker}`, filing);
  await setStatus(id, "idle");
  return { ...ctx, filing };
}

// 2. Tech Analyst -----------------------------------------------------------
export async function analyst(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.analyst;
  await setStatus(id, "thinking");
  await emit(id, "thought", `Writing memo on ${ctx.ticker}`);

  const raw = await ask({
    model: "sonnet",
    system: "You are a sell-side tech equity analyst. Be skeptical and specific. Respond ONLY with JSON.",
    user: `Ticker: ${ctx.ticker}
Latest filing summary: ${ctx.filing?.summary ?? "n/a"}

Write a tight investment memo. JSON shape:
{ "title": "8-12 word headline",
  "thesis": "3-4 sentence thesis with one concrete catalyst and one quantified risk",
  "conviction": 0.0-1.0 }`,
  });
  const memo = extractJson<NonNullable<Ctx["memo"]>>(raw);

  const doc = await db.createDocument(DB, "memos", ID.unique(), {
    title: memo.title,
    ticker: ctx.ticker,
    thesis: memo.thesis,
    conviction: memo.conviction,
    author_agent_id: id,
    status: "review",
    vector_id: null,
  });
  await emit(id, "memo", `${memo.title} (conv ${memo.conviction.toFixed(2)})`, { memo_id: doc.$id });
  await setStatus(id, "idle");
  return { ...ctx, memo };
}

// 3. Critic / Red Team ------------------------------------------------------
export async function critic(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.critic;
  await setStatus(id, "thinking");
  await emit(id, "thought", `Stress-testing memo for ${ctx.ticker}`);

  const raw = await ask({
    model: "sonnet",
    system: "You are an adversarial red-team analyst. Attack the thesis. Respond ONLY with JSON.",
    user: `Memo: ${JSON.stringify(ctx.memo)}

Return: { "score": 0.0-1.0 (how robust),
"concerns": ["2-4 specific weaknesses"],
"verdict": "pass" | "revise" | "reject" }`,
  });
  const critique = extractJson<NonNullable<Ctx["critique"]>>(raw);
  await emit(id, "thought", `Verdict ${critique.verdict} (score ${critique.score?.toFixed(2)})`, critique);
  await setStatus(id, "idle");
  return { ...ctx, critique };
}

// 4. PM (Position Manager) --------------------------------------------------
export async function pm(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.pm;
  if (ctx.critique?.verdict === "reject") {
    await emit(id, "alert", `Skipping ${ctx.ticker} — critic rejected thesis`);
    return ctx;
  }
  await setStatus(id, "thinking");
  const raw = await ask({
    model: "sonnet",
    system: "You are the PM sizing positions from conviction-weighted memos. Respond ONLY with JSON.",
    user: `Memo: ${JSON.stringify(ctx.memo)}
Critic score: ${ctx.critique?.score}
NAV: $100,000,000. Max single-name weight 5%.

Return: { "qty": integer share count, "weight_pct": 0-5,
"reasoning": "1-2 sentences" }`,
  });
  const size = extractJson<NonNullable<Ctx["size"]>>(raw);
  await emit(id, "thought", `Sizing ${ctx.ticker} at ${size.weight_pct?.toFixed(2)}% (${size.qty} sh)`, size);
  await setStatus(id, "idle");
  return { ...ctx, size };
}

// 5. Risk -------------------------------------------------------------------
export async function risk(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.risk;
  if (!ctx.size) return ctx;
  await setStatus(id, "thinking");
  const raw = await ask({
    model: "haiku",
    system: "Risk officer. Approve only if 1-day 95% VaR < 1.5% of NAV. Respond ONLY with JSON.",
    user: `Sizing: ${JSON.stringify(ctx.size)}
Ticker: ${ctx.ticker} (tech, beta ~1.3, 30d vol ~35%).

Return: { "approved": bool, "var_pct": 0-5, "notes": "1 sentence" }`,
  });
  const r = extractJson<NonNullable<Ctx["risk"]>>(raw);
  await emit(id, r.approved ? "thought" : "alert",
    `Risk ${r.approved ? "APPROVED" : "BLOCKED"} ${ctx.ticker} (VaR ${r.var_pct?.toFixed(2)}%)`, r);
  await setStatus(id, "idle");
  return { ...ctx, risk: r };
}

// 6. Compliance -------------------------------------------------------------
export async function compliance(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.compliance;
  if (!ctx.risk?.approved) return ctx;
  await setStatus(id, "thinking");

  const raw = await ask({
    model: "haiku",
    system: "Compliance officer. Check restricted list, position limits, wash sale, Reg SHO. Respond ONLY with JSON.",
    user: `Trade: BUY ${ctx.size?.qty} ${ctx.ticker}. No restricted list. No prior position.

Return: { "approved": bool, "flags": ["any flags raised"] }`,
  });
  const c = extractJson<NonNullable<Ctx["compliance"]>>(raw);

  await db.createDocument(DB, "governance_events", ID.unique(), {
    kind: c.approved ? "approval" : "block",
    actor: "compliance-agent",
    target: ctx.ticker,
    reason: c.flags?.join("; ") || "Pre-trade checks passed",
    occurred_at: new Date().toISOString(),
  });
  await emit(id, c.approved ? "thought" : "alert",
    `Compliance ${c.approved ? "OK" : "BLOCK"} ${ctx.ticker}`, c);
  await setStatus(id, "idle");
  return { ...ctx, compliance: c };
}

// 7. Paper Broker -----------------------------------------------------------
export async function broker(ctx: Ctx): Promise<Ctx> {
  const id = ctx.agentIds.broker;
  if (!ctx.compliance?.approved) return ctx;
  await setStatus(id, "executing");

  const price = 100 + Math.random() * 400; // stub fill price
  const trade = await db.createDocument(DB, "trades", ID.unique(), {
    ticker: ctx.ticker,
    side: "buy",
    qty: ctx.size!.qty,
    price: Number(price.toFixed(2)),
    venue: "paper-IBKR",
    agent_id: id,
    status: "filled",
    filled_at: new Date().toISOString(),
  });
  await emit(id, "trade", `FILL BUY ${ctx.size!.qty} ${ctx.ticker} @ ${price.toFixed(2)}`, { trade_id: trade.$id });
  await setStatus(id, "idle");
  return { ...ctx, trade: { id: trade.$id, status: "filled" } };
}

// Bootstrap -----------------------------------------------------------------
export async function bootstrapAgents(): Promise<Ctx["agentIds"]> {
  return {
    parser:     await ensureAgent("Filing Parser",   "research"),
    analyst:    await ensureAgent("Tech Analyst",    "research"),
    critic:     await ensureAgent("Red Team Critic", "research"),
    pm:         await ensureAgent("PM",              "ops"),
    risk:       await ensureAgent("Risk Officer",    "risk"),
    compliance: await ensureAgent("Compliance",      "ops"),
    broker:     await ensureAgent("Paper Broker",    "execution"),
  };
}
