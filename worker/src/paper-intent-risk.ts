export interface PaperIntentRiskInput {
  side: string;
  signalSide: string;
  guardianHalted: boolean;
  drawdownPct: number;
  maxDrawdownPct?: number;
  positionCount: number;
  equityUsdt: number;
  requestedNotionalUsdt: number;
}

export interface PaperIntentRiskDecision {
  approved: boolean;
  decision: "ENTER" | "HOLD";
  risk_score: number;
  position_size_fraction: number;
  position_notional_usdt: number;
  reasoning: string;
}

export function evaluatePaperIntentRisk(input: PaperIntentRiskInput): PaperIntentRiskDecision {
  const side = input.side.trim().toUpperCase();
  const equity = Number.isFinite(input.equityUsdt) ? input.equityUsdt : 0;
  const drawdown = Number.isFinite(input.drawdownPct) ? input.drawdownPct : 0;
  const maxDrawdown = Number.isFinite(input.maxDrawdownPct) && (input.maxDrawdownPct ?? 0) > 0 ? input.maxDrawdownPct! : 15;
  const positionCount = Number.isFinite(input.positionCount) ? input.positionCount : 0;
  const riskScore = Math.min(100, Math.max(0, drawdown * 4 + positionCount * 5));
  const cap = Math.round(Math.min(equity, Math.max(0, equity * 0.02)) * 100) / 100;

  let reason = "";
  if (side !== "BUY" && side !== "SELL") reason = "Invalid paper order side.";
  else if (input.guardianHalted) reason = "Guardian kill switch is active — paper rehearsal blocked.";
  else if (drawdown >= maxDrawdown) reason = `Drawdown ${drawdown.toFixed(2)}% reached the Guardian limit of ${maxDrawdown.toFixed(2)}%.`;
  else if (riskScore >= 80) reason = `Risk score ${riskScore} is at or above the 80 block threshold.`;
  else if (equity <= 0) reason = "Paper portfolio equity is not positive.";
  else if (side === "BUY" && input.signalSide.trim().toUpperCase() !== "BUY") reason = "A new Buy requires a current BUY signal; HOLD/SELL signals cannot open a long position.";
  else if (side === "BUY" && (!Number.isFinite(input.requestedNotionalUsdt) || input.requestedNotionalUsdt <= 0)) reason = "A positive paper notional is required.";
  else if (side === "BUY" && input.requestedNotionalUsdt > cap + 0.01) reason = `Requested Buy exceeds the ${cap.toFixed(2)} USDT risk limit.`;

  const approved = reason === "";
  return {
    approved,
    decision: approved ? "ENTER" : "HOLD",
    risk_score: riskScore,
    position_size_fraction: approved ? 0.02 : 0,
    position_notional_usdt: approved ? cap : 0,
    reasoning: approved ? `Approved for paper rehearsal: risk score ${riskScore}, maximum Buy size ${cap.toFixed(2)} USDT.` : reason,
  };
}
