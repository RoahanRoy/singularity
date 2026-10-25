import { test } from "node:test";
import assert from "node:assert/strict";
import { capToApproval, parseCoreApproval } from "./core-approval";

test("a run fills the approved side, at most the approved shares", () => {
  assert.deepEqual(capToApproval(13, { side: "buy", max_shares: 13 }), { shares: 13 });
  assert.deepEqual(capToApproval(20, { side: "buy", max_shares: 13 }), { shares: 13 });
  assert.deepEqual(capToApproval(9, { side: "buy", max_shares: 13 }), { shares: 9 });
  assert.deepEqual(capToApproval(-5, { side: "sell", max_shares: 3 }), { shares: -3 });
});

test("a plan that turned to the other side holds for a new approval", () => {
  assert.ok("hold" in capToApproval(-4, { side: "buy", max_shares: 13 }));
  assert.ok("hold" in capToApproval(4, { side: "sell", max_shares: 13 }));
});

test("nothing to trade stays nothing", () => {
  assert.deepEqual(capToApproval(0, { side: "buy", max_shares: 13 }), { shares: 0 });
});

test("only a well-formed approval parses", () => {
  const ok = { status: "approved", ticker: "SPY", side: "buy", max_shares: 13, plan_id: "p", plan_session: "2026-10-23", approved_at: "x" };
  assert.equal(parseCoreApproval(JSON.stringify(ok))?.max_shares, 13);
  assert.equal(parseCoreApproval(JSON.stringify({ ...ok, max_shares: 0 })), null);
  assert.equal(parseCoreApproval("not json"), null);
  assert.equal(parseCoreApproval(null), null);
});
