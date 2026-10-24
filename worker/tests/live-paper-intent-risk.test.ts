import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePaperIntentRisk } from "../src/paper-intent-risk.ts";

const base = {
  side: "BUY",
  signalSide: "BUY",
  guardianHalted: false,
  drawdownPct: 0,
  positionCount: 0,
  equityUsdt: 10_000,
  requestedNotionalUsdt: 200,
};

test("approves a Buy matching a current signal within the 2% paper cap", () => {
  const decision = evaluatePaperIntentRisk(base);
  assert.equal(decision.approved, true);
  assert.equal(decision.position_notional_usdt, 200);
});

test("blocks a Buy when the signal is HOLD or SELL", () => {
  assert.equal(evaluatePaperIntentRisk({ ...base, signalSide: "HOLD" }).approved, false);
  assert.equal(evaluatePaperIntentRisk({ ...base, signalSide: "SELL" }).approved, false);
});

test("blocks a Buy above the server-calculated paper cap", () => {
  const decision = evaluatePaperIntentRisk({ ...base, requestedNotionalUsdt: 201 });
  assert.equal(decision.approved, false);
  assert.match(decision.reasoning, /exceeds/);
});

test("blocks every intent when Guardian is halted or the risk score reaches the threshold", () => {
  assert.equal(evaluatePaperIntentRisk({ ...base, guardianHalted: true }).approved, false);
  assert.equal(evaluatePaperIntentRisk({ ...base, drawdownPct: 20 }).approved, false);
});

test("allows risk-approved Sell-to-close intents without applying the entry-size cap", () => {
  const decision = evaluatePaperIntentRisk({ ...base, side: "SELL", signalSide: "HOLD", requestedNotionalUsdt: 50_000 });
  assert.equal(decision.approved, true);
});
