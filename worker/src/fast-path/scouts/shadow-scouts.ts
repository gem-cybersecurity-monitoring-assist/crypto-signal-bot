import type { ShadowFeatureSnapshot } from '../features/shadow-feature-engine'

export const SHADOW_SCOUT_VERSION = 'phase3-shadow-scout-v1' as const
export type ShadowScoutName =
  | 'momentum' | 'order_book_imbalance' | 'spread_liquidity'
  | 'realized_volatility' | 'short_reversal' | 'feed_disagreement' | 'signed_trade_flow'

export interface ShadowScoutObservation {
  readonly scout: ShadowScoutName
  readonly symbol: string
  readonly eventId: string
  readonly featureVersion: string
  readonly ruleVersion: typeof SHADOW_SCOUT_VERSION
  readonly sourceAgeMs: number
  readonly score: number | null
  readonly confidence: number
  readonly reasonCodes: readonly string[]
  readonly evidenceOnly: true
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

export function evaluateShadowScouts(features: ShadowFeatureSnapshot): ShadowScoutObservation[] {
  const build = (
    scout: ShadowScoutName,
    score: number | null,
    reason: string,
    confidence = score === null ? 0 : 1,
  ): ShadowScoutObservation => ({
    scout, symbol: features.symbol, eventId: features.eventId,
    featureVersion: features.featureVersion, ruleVersion: SHADOW_SCOUT_VERSION,
    sourceAgeMs: features.sourceAgeMs,
    score, confidence, reasonCodes: [reason], evidenceOnly: true,
  })
  return [
    build('momentum',
      features.momentumBps === null ? null : clamp(features.momentumBps / 20),
      features.momentumBps === null ? 'MOMENTUM_NOT_REPORTED' : 'MOMENTUM_EWMA'),
    build('order_book_imbalance',
      features.imbalance === null ? null : clamp(features.imbalance),
      features.imbalance === null ? 'DEPTH_NOT_REPORTED' : 'BEST_LEVEL_IMBALANCE'),
    build('spread_liquidity',
      Number.isFinite(features.spreadBps) ? clamp((10 - features.spreadBps) / 10) : null,
      'TOP_OF_BOOK_SPREAD'),
    build('realized_volatility',
      features.realizedVolatilityBps === null ? null : -clamp(features.realizedVolatilityBps / 100),
      features.realizedVolatilityBps === null ? 'VOLATILITY_NOT_REPORTED' : 'REALIZED_VOLATILITY_EWMA'),
    build('short_reversal', null, 'REVERSAL_NOT_REPORTED'),
    build('feed_disagreement', null, 'INDEPENDENT_FEED_NOT_REPORTED'),
    build('signed_trade_flow', null, 'SIGNED_TRADE_FLOW_NOT_REPORTED'),
  ]
}
