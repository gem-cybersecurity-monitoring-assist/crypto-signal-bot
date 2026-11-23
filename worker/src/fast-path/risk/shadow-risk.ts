import { authorizeMarketAction } from '../freshness'
import type { MarketAuthorizationInput } from '../types'
import type { ShadowFeatureSnapshot } from '../features/shadow-feature-engine'
import type { ShadowCandidate } from '../fusion/shadow-fusion'

export const SHADOW_RISK_VERSION = 'phase3-shadow-risk-v1' as const

/** Supplied by a separately authorized portfolio snapshot; never fetched or mutated here. */
export interface ShadowRiskLimits {
  readonly nowMs: number
  readonly guardian: 'CLEAR' | 'HALTED' | 'NOT_REPORTED'
  readonly cooldownUntilMs: number
  readonly drawdownFraction: number
  readonly maxDrawdownFraction: number
  readonly reusableCash: number
  readonly protectedReserve: number
  readonly symbolExposure: number
  readonly totalExposure: number
  readonly maxSymbolExposure: number
  readonly maxTotalExposure: number
  readonly maxOrderNotional: number
  readonly minShadowNotional: number
}

export interface ShadowRiskAssessment {
  readonly candidateOnly: true
  readonly ruleVersion: typeof SHADOW_RISK_VERSION
  readonly eventId: string
  readonly symbol: string
  readonly status: 'BLOCKED' | 'SHADOW_ELIGIBLE'
  readonly simulatedNotional: number
  readonly executionAllowed: false
  readonly reasonCodes: readonly string[]
}

/**
 * Source-only shadow sizing authority. Its output cannot be used as a
 * provider order: there is no account, order side, key, transport, or write API.
 */
export function assessShadowRisk(
  features: ShadowFeatureSnapshot,
  candidate: ShadowCandidate,
  market: MarketAuthorizationInput,
  limits: ShadowRiskLimits,
): ShadowRiskAssessment {
  const reasons: string[] = []
  if (candidate.candidateOnly !== true || candidate.eventId !== features.eventId
    || candidate.symbol !== features.symbol || candidate.intent !== 'CONSIDER_LONG'
    || candidate.score === null || !Number.isFinite(candidate.score)
    || candidate.score <= 0.1) reasons.push('CANDIDATE_NOT_ELIGIBLE')

  if (market.action !== 'entry') reasons.push('ENTRY_ONLY')
  const authorization = authorizeMarketAction(market)
  if (!authorization.allowed) reasons.push(authorization.code)
  if (!Number.isFinite(limits.nowMs) || features.sourceAgeMs < 0
    || features.sourceAgeMs > 500) reasons.push('SOURCE_NOT_FRESH')
  if (limits.guardian !== 'CLEAR') reasons.push('GUARDIAN_NOT_CLEAR')
  if (!Number.isFinite(limits.cooldownUntilMs)
    || limits.nowMs < limits.cooldownUntilMs) reasons.push('COOLDOWN_ACTIVE')

  const money = [
    limits.reusableCash, limits.protectedReserve, limits.symbolExposure,
    limits.totalExposure, limits.maxSymbolExposure, limits.maxTotalExposure,
    limits.maxOrderNotional, limits.minShadowNotional,
  ]
  if (!money.every((n) => Number.isFinite(n) && n >= 0)
    || limits.maxSymbolExposure < limits.symbolExposure
    || limits.maxTotalExposure < limits.totalExposure
    || limits.minShadowNotional === 0) reasons.push('INVALID_FINANCIAL_LIMITS')
  if (!Number.isFinite(limits.drawdownFraction)
    || !Number.isFinite(limits.maxDrawdownFraction)
    || limits.drawdownFraction < 0 || limits.maxDrawdownFraction < 0
    || limits.drawdownFraction > limits.maxDrawdownFraction) reasons.push('DRAWDOWN_LIMIT')
  if (!Number.isFinite(features.spreadBps)
    || features.spreadBps > 15) reasons.push('SPREAD_LIMIT')
  if (features.realizedVolatilityBps === null
    || !Number.isFinite(features.realizedVolatilityBps)
    || features.realizedVolatilityBps > 50) reasons.push('VOLATILITY_UNVERIFIED_OR_HIGH')
  if (features.bestBidQuantity === null || features.bestAskQuantity === null
    || features.bestBidQuantity <= 0 || features.bestAskQuantity <= 0) {
    reasons.push('LIQUIDITY_NOT_REPORTED')
  }

  let simulatedNotional = 0
  if (!reasons.length) {
    // The protected reserve is explicitly excluded; only reusableCash enters this calculation.
    const ceiling = Math.min(
      limits.reusableCash * 0.02, limits.maxOrderNotional,
      limits.reusableCash, limits.maxSymbolExposure - limits.symbolExposure,
      limits.maxTotalExposure - limits.totalExposure,
    )
    simulatedNotional = Math.floor(ceiling * 100) / 100
    if (simulatedNotional < limits.minShadowNotional) {
      reasons.push('INSUFFICIENT_REUSABLE_CASH_OR_EXPOSURE_HEADROOM')
      simulatedNotional = 0
    }
  }
  return {
    candidateOnly: true, ruleVersion: SHADOW_RISK_VERSION,
    symbol: features.symbol, eventId: features.eventId,
    status: reasons.length ? 'BLOCKED' : 'SHADOW_ELIGIBLE',
    simulatedNotional, executionAllowed: false,
    reasonCodes: reasons.length ? reasons : ['SIMULATION_ONLY_NO_EXECUTION'],
  }
}
