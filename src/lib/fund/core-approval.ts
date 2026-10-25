/**
 * The operator's approval of the fund's index-core rebalance (core.ts), made
 * from the Book's construction plan and filled by the next desk run.
 *
 * An approval is for the trade the operator saw: one side, at most that many
 * shares. The run re-sizes the trade on the book as it is then; it fills the
 * smaller of the two on the same side, and holds if the plan has turned to
 * the other side. Kept in `agent_state` (one document per desk), written by
 * /api/core/approve and the desk loop.
 *
 * Pure: no Appwrite client here, so the Next route and the loop share it.
 */
import type { Market } from "../meridian/format";

export type CoreApproval = {
  /** approved: waiting for a run · filled: a run traded it · spent: the core was already at target · withdrawn: undone. */
  status: "approved" | "filled" | "spent" | "withdrawn";
  ticker: string;
  side: "buy" | "sell";
  /** The shares the operator saw on the plan; the most a run may trade. */
  max_shares: number;
  plan_id: string;
  plan_session: string;
  approved_at: string;
  /** Set when the status leaves "approved". */
  done_at?: string;
  detail?: string;
};

export const CORE_APPROVAL_COLLECTION = "agent_state";
export const coreApprovalId = (market: Market) => `core-approval-${market}`;

export function parseCoreApproval(json: unknown): CoreApproval | null {
  if (typeof json !== "string") return null;
  try {
    const a = JSON.parse(json) as CoreApproval;
    return a && typeof a === "object" && typeof a.ticker === "string" && a.max_shares > 0 ? a : null;
  } catch {
    return null;
  }
}

/**
 * The shares a run may trade under an approval: the computed trade's side must
 * match, and it fills at most the approved shares. 0 shares means nothing to trade.
 */
export function capToApproval(shares: number, a: Pick<CoreApproval, "side" | "max_shares">): { shares: number } | { hold: string } {
  if (shares === 0) return { shares: 0 };
  const side = shares > 0 ? "buy" : "sell";
  if (side !== a.side) return { hold: `the plan now ${side}s the core; the approval was to ${a.side}, so approve again` };
  return { shares: Math.sign(shares) * Math.min(Math.abs(shares), a.max_shares) };
}
