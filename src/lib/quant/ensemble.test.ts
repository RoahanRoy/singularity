import { test } from "node:test";
import assert from "node:assert/strict";
import { combine, anchorToComposite, upsideScore, directionOf, ENSEMBLE_RULES, VALUATION_AGENTS, T_FULL, type EnsembleInput } from "./ensemble";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const inp = (agent: string, score: number | null, extra: Partial<EnsembleInput> = {}): EnsembleInput => ({ agent, label: agent, score, ...extra });
const row = (r: ReturnType<typeof combine>, agent: string) => r.inputs.find((x) => x.agent === agent)!;

test("priors sum to one (valuation counted once) and every rule is well formed", () => {
  let total = 0;
  for (const [agent, rule] of Object.entries(ENSEMBLE_RULES)) {
    if (rule.kind === "prior") total += (VALUATION_AGENTS as readonly string[]).includes(agent) ? rule.weight / VALUATION_AGENTS.length : rule.weight;
    else if (rule.kind === "gated") total += rule.prior;
    else assert.ok(rule.cap > 0 && rule.cap <= 1);
  }
  close(total, 1, 1e-9);
});

test("priors only: a weighted average, contributions add up to it", () => {
  const r = combine([inp("fundamentals-screener", 50), inp("sentiment-analyst", -20), inp("moat-analyst", 80)]);
  const expected = (0.08 * 50 + 0.06 * -20 + 0.04 * 80) / 0.18;
  assert.equal(r.composite, Math.round(expected));
  close(r.inputs.reduce((a, x) => a + x.contribution, 0), expected, 1e-9);
  close(r.totalWeight, 0.18, 1e-12);
  assert.equal(r.validatedWeight, 0);
  assert.ok(r.notes.some((n) => n.startsWith("no model passed")));
  // Agreement: |Σws| / Σw|s|.
  close(r.agreement, Math.abs(0.08 * 50 - 0.06 * 20 + 0.04 * 80) / (0.08 * 50 + 0.06 * 20 + 0.04 * 80), 1e-12);
  close(r.confidence, Math.round(100 * 0.5 * 0.18 * r.agreement) / 100, 1e-12, "priors count half toward confidence");
});

test("models earn min(1, t/4) of their cap when validated and nothing when they fail", () => {
  const r = combine([
    inp("linear-ml-modeler", 60, { evidence: { passed: true, t: 2, test: "walk-forward IC" } }),
    inp("tree-ensemble-modeler", -90, { evidence: { passed: false, t: 1.1, test: "walk-forward IC" } }),
    inp("rl-trader", 40, { evidence: { passed: true, t: 9, test: "timing alpha" } }),
    inp("arima-forecaster", 100),
  ]);
  close(row(r, "linear-ml-modeler").weight, 0.5 * (2 / T_FULL), 1e-12);
  assert.equal(row(r, "tree-ensemble-modeler").weight, 0);
  assert.match(row(r, "tree-ensemble-modeler").basis, /^failed walk-forward IC \(t 1\.10\)/);
  close(row(r, "rl-trader").weight, 0.4, 1e-12, "t beyond 4 is capped");
  assert.equal(row(r, "arima-forecaster").weight, 0, "a model with no test gets nothing");
  assert.equal(r.composite, Math.round((0.25 * 60 + 0.4 * 40) / 0.65));
  close(r.validatedWeight, 0.65, 1e-12);
  assert.ok(!r.notes.some((n) => n.startsWith("no model passed")));
});

test("gates: failed technicals drop out, failed momentum keeps its prior, a strong backtest lifts both", () => {
  const failed = { passed: false, t: 0.5, test: "backtest" };
  const strong = { passed: true, t: 6, test: "backtest" };
  const f = combine([inp("technical-analyst", 50, { evidence: failed }), inp("momentum-analyst", 50, { evidence: failed })]);
  assert.equal(row(f, "technical-analyst").weight, 0);
  assert.equal(row(f, "momentum-analyst").weight, 0.15);
  assert.match(row(f, "momentum-analyst").basis, /time-series half/);
  const s = combine([inp("technical-analyst", 50, { evidence: strong }), inp("momentum-analyst", 50, { evidence: strong })]);
  assert.equal(row(s, "technical-analyst").weight, 0.4);
  assert.equal(row(s, "momentum-analyst").weight, 0.5);
  const weak = combine([inp("momentum-analyst", 50, { evidence: { passed: true, t: 2.1, test: "backtest" } })]);
  assert.equal(row(weak, "momentum-analyst").weight, Math.max(0.15, 0.5 * (2.1 / 4)), "never below its prior");
  const none = combine([inp("technical-analyst", 50)]);
  assert.equal(row(none, "technical-analyst").weight, 0.05, "no backtest: the prior");
});

test("valuation models split one prior by blend weight; no-opinion and unknown agents carry nothing", () => {
  const r = combine([
    inp("dcf-modeler", 100, { share: 0.6 }),
    inp("multiples-analyst", -100, { share: 0.4 }),
    inp("ddm-modeler", null, { share: 0 }),
    inp("garch-forecaster", 70),
  ]);
  close(row(r, "dcf-modeler").weight, 0.15, 1e-12);
  close(row(r, "multiples-analyst").weight, 0.1, 1e-12);
  assert.equal(r.composite, 20);
  assert.equal(row(r, "ddm-modeler").basis, "no opinion");
  assert.equal(row(r, "garch-forecaster").basis, "not a voting agent");
  assert.equal(r.inputs[0].agent, "dcf-modeler", "largest contribution first");
});

test("edge cases: nothing to combine is neutral; disagreement lowers confidence; direction bands", () => {
  const empty = combine([]);
  assert.deepEqual([empty.composite, empty.direction, empty.confidence], [0, "neutral", 0]);
  assert.ok(empty.notes[0].startsWith("no input carried weight"));
  const split = combine([inp("fundamentals-screener", 80), inp("dcf-modeler", -80, { share: 0.32 })]);
  assert.ok(split.agreement < 0.3 && split.notes.some((n) => n.startsWith("inputs disagree")));
  const agree = combine([inp("fundamentals-screener", 80), inp("dcf-modeler", 80, { share: 0.32 })]);
  close(agree.agreement, 1, 1e-12);
  assert.ok(agree.confidence > split.confidence);
  assert.deepEqual([directionOf(20), directionOf(19), directionOf(-20), directionOf(-19)], ["long", "neutral", "short", "neutral"]);
  assert.equal(combine([inp("moat-analyst", 400)]).composite, 100, "scores are clamped to ±100");
});

test("anchoring and the upside scale", () => {
  assert.equal(anchorToComposite(90, 30), 50);
  assert.equal(anchorToComposite(-90, 30), 10);
  assert.equal(anchorToComposite(35, 30), 35);
  assert.equal(anchorToComposite(NaN, 30), 30);
  assert.equal(anchorToComposite(100, 95), 100, "never past ±100");
  assert.equal(upsideScore(5), 0, "middle of the fair band is neutral");
  assert.equal(upsideScore(30), 100);
  assert.equal(upsideScore(-20), -100);
  assert.equal(upsideScore(17.5), 50);
});
