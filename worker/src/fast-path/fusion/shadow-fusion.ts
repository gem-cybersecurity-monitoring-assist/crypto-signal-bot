import type { ShadowFeatureSnapshot } from '../features/shadow-feature-engine'
import type { ShadowScoutObservation } from '../scouts/shadow-scouts'

export const SHADOW_FUSION_VERSION = 'phase3-shadow-fusion-v1' as const

export interface ShadowCandidate {
  readonly candidateOnly: true
  readonly ruleVersion: typeof SHADOW_FUSION_VERSION
  readonly symbol: string
  readonly eventId: string
  readonly intent: 'WATCH' | 'CONSIDER_LONG'
  readonly score: number | null
  readonly proposedNotional: null
  readonly reasonCodes: readonly string[]
}

/** Deterministic watch/consider classification. Never creates an order or decides size. */
export function fuseShadowScouts(
  features: ShadowFeatureSnapshot,
  observations: readonly ShadowScoutObservation[],
): ShadowCandidate {
  const reasons: string[] = []
  const byName = (name: ShadowScoutObservation['scout']) =>
    observations.find((o) => o.scout === name
      && o.eventId === features.eventId
      && o.symbol === features.symbol
      && o.featureVersion === features.featureVersion
      && o.evidenceOnly === true && o.confidence > 0 && o.confidence <= 1
      && o.score !== null && Number.isFinite(o.score)
      && o.score >= -1 && o.score <= 1)
  const momentum = byName('momentum')
  const imbalance = byName('order_book_imbalance')
  let score: number | null = null
  if (!momentum || !imbalance) reasons.push('INSUFFICIENT_INDEPENDENT_SIGNALS')
  else {
    const numerator = 0.55 * momentum.score! * momentum.confidence
      + 0.45 * imbalance.score! * imbalance.confidence
    const denominator = 0.55 * momentum.confidence + 0.45 * imbalance.confidence
    score = numerator / denominator
  }
  if (features.sourceAgeMs > 500 || features.sourceAgeMs < 0) reasons.push('STALE_SOURCE')
  if (!Number.isFinite(features.spreadBps) || features.spreadBps > 15) reasons.push('WIDE_SPREAD')
  if (features.realizedVolatilityBps === null
    || features.realizedVolatilityBps > 50) reasons.push('VOLATILITY_UNVERIFIED_OR_HIGH')
  if (score === null || score <= 0.1) reasons.push('NO_POSITIVE_CONSENSUS')
  const intent = reasons.length === 0 ? 'CONSIDER_LONG' : 'WATCH'
  return {
    candidateOnly: true, ruleVersion: SHADOW_FUSION_VERSION,
    symbol: features.symbol, eventId: features.eventId, intent,
    score, proposedNotional: null,
    reasonCodes: reasons.length ? reasons : ['SHADOW_CONSENSUS_ONLY'],
  }
}
