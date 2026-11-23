import { describe, expect, it } from 'vitest'
import type { FeedUpdateResult, MarketAuthorizationInput, NormalizedMarketEvent } from '../../src/fast-path/types'
import { FeedHealthRegistry } from '../../src/fast-path/feed-health'
import { normalizeCoinbaseMessage } from '../../src/fast-path/normalizers/coinbase'
import { eventFixture } from './fixtures'
import { ShadowFeatureEngine } from '../../src/fast-path/features/shadow-feature-engine'
import { evaluateShadowScouts } from '../../src/fast-path/scouts/shadow-scouts'
import { fuseShadowScouts, type ShadowCandidate } from '../../src/fast-path/fusion/shadow-fusion'
import { assessShadowRisk, type ShadowRiskLimits } from '../../src/fast-path/risk/shadow-risk'

function book(sequence: number, bid = 100, ask = 100.04): NormalizedMarketEvent {
  return eventFixture({
    eventId: `coinbase:l2_data:BTC-USD:level2:${sequence}`,
    sequenceStart: sequence, sequenceEnd: sequence,
    exchangeTsMs: 1000 + sequence * 10,
    receivedTsMs: 1000 + sequence * 10 + 1,
    bid, ask, updates: [
      { side: 'bid', price: bid, quantity: 3 },
      { side: 'ask', price: ask, quantity: 1 },
    ],
  })
}

function accepted(event: NormalizedMarketEvent): FeedUpdateResult {
  return {
    accepted: true, reason: 'accepted', eventId: event.eventId,
    state: {
      source: event.source, channel: event.channel, symbol: event.symbol,
      connectionState: 'connected', integrityState: 'healthy',
      sequenceState: 'continuous', heartbeatState: 'healthy',
      recoveryState: 'healthy', lastSequence: event.sequenceEnd ?? 0,
      lastExchangeTsMs: event.exchangeTsMs,
      lastReceivedTsMs: event.receivedTsMs, lastHeartbeatTsMs: event.receivedTsMs,
      eventAgeMs: 5, freshnessClass: 'green', gapCount: 0,
      duplicateCount: 0, outOfOrderCount: 0, acceptedEventCount: 1,
      rejectedEventCount: 0, recoveryStartedAtMs: null,
      recoveryCompletedAtMs: null, lastErrorCode: null, ephemeral: true,
    },
  }
}

function featuresForTwo() {
  const engine = new ShadowFeatureEngine()
  const first = book(1)
  const second = book(2, 100.02, 100.06)
  expect(engine.observe(first, accepted(first), 'live', first.receivedTsMs)).not.toBeNull()
  const features = engine.observe(second, accepted(second), 'live', second.receivedTsMs)
  expect(features).not.toBeNull()
  return features!
}

const validMarket: MarketAuthorizationInput = {
  action: 'entry', freshnessClass: 'green', integrityState: 'healthy',
  sequenceState: 'continuous', heartbeatState: 'healthy',
  priceOrigin: 'live', secondaryConfirmed: false,
}
const validLimits: ShadowRiskLimits = {
  nowMs: 1040, guardian: 'CLEAR', cooldownUntilMs: 0,
  drawdownFraction: 0, maxDrawdownFraction: 0.1,
  reusableCash: 2000, protectedReserve: 100000,
  symbolExposure: 0, totalExposure: 0,
  maxSymbolExposure: 200, maxTotalExposure: 1000,
  maxOrderNotional: 100, minShadowNotional: 10,
}

describe('Phase 3 replay through the feed integrity gate', () => {
  it('produces deterministic shadow decisions and stops on stale data or a sequence gap', () => {
    function replay() {
      const epoch = 1_700_000_000_000
      const registry = new FeedHealthRegistry()
      const engine = new ShadowFeatureEngine()

      function ingest(payload: unknown, receivedOffsetMs: number) {
        const receivedTsMs = epoch + receivedOffsetMs
        const [event] = normalizeCoinbaseMessage(payload, receivedTsMs)
        const feed = registry.ingest(event, receivedTsMs)
        const features = engine.observe(event, feed, 'live', receivedTsMs)
        const decision = features && assessShadowRisk(
          features,
          fuseShadowScouts(features, evaluateShadowScouts(features)),
          {
            ...validMarket,
            freshnessClass: feed.state.freshnessClass,
            integrityState: feed.state.integrityState,
            sequenceState: feed.state.sequenceState,
            heartbeatState: feed.state.heartbeatState,
          },
          { ...validLimits, nowMs: receivedTsMs },
        )
        return { feed: feed.reason, decision }
      }

      function update(sequence: number, receivedTsMs: number) {
        const bid = 100 + sequence / 50
        return ingest({
          channel: 'l2_data',
          timestamp: epoch + sequence * 10 + 1_000,
          sequence_num: sequence,
          events: [{
            type: 'update',
            product_id: 'BTC-USD',
            updates: [
              { side: 'bid', price_level: String(bid), new_quantity: '3' },
              { side: 'offer', price_level: String(bid + 0.04), new_quantity: '1' },
            ],
          }],
        }, receivedTsMs)
      }

      const beforeHeartbeat = update(1, 1010)
      ingest({ channel: 'heartbeats', timestamp: epoch + 1011, sequence_num: 1 }, 1011)
      return {
        beforeHeartbeat,
        warmup: update(2, 1020),
        eligible: update(3, 1030),
        stale: update(4, 1541),
        gap: update(60, 1601),
        afterGap: update(61, 1611),
      }
    }

    const result = replay()
    expect(replay()).toEqual(result)
    expect(result.beforeHeartbeat.decision).toBeNull()
    expect(result.warmup.decision?.status).toBe('BLOCKED')
    expect(result.eligible.decision).toMatchObject({
      status: 'SHADOW_ELIGIBLE',
      simulatedNotional: 40,
      executionAllowed: false,
    })
    expect(result.stale).toEqual({ feed: 'accepted', decision: null })
    expect(result.gap).toEqual({ feed: 'sequence_gap', decision: null })
    expect(result.afterGap.decision).toBeNull()
  })
})

describe('Phase 3 shadow features — no execution boundary', () => {
  it('computes top-of-book measures without inventing unavailable trade or feed values', () => {
    const features = featuresForTwo()
    expect(features.candidateOnly).toBe(true)
    expect(features.sampleCount).toBe(2)
    expect(features.spreadBps).toBeGreaterThan(0)
    expect(features.bestBidQuantity).toBe(3)
    expect(features.bestAskQuantity).toBe(1)
    expect(features.imbalance).toBe(0.5)
    expect(features.momentumBps).toBeGreaterThan(0)
    expect(features.realizedVolatilityBps).toBeGreaterThan(0)
    expect(features.signedTradeFlow).toBeNull()
    expect(features.shortReversalBps).toBeNull()
    expect(features.independentSourceDisagreementBps).toBeNull()
  })

  it('fails closed for stale, synthetic, invalid sequence, and source mismatches', () => {
    const cases: Array<{ origin: 'live' | 'cache', change?: Partial<FeedUpdateResult['state']>, now: number }> = [
      { origin: 'live', now: 1800 },
      { origin: 'cache', now: 1030 },
      { origin: 'live', change: { sequenceState: 'gap' }, now: 1030 },
      { origin: 'live', change: { heartbeatState: 'stale' }, now: 1030 },
      { origin: 'live', change: { integrityState: 'degraded' }, now: 1030 },
      { origin: 'live', change: { source: 'binance' }, now: 1030 },
    ]
    for (const sample of cases) {
      const event = book(1)
      const feed = accepted(event)
      Object.assign(feed.state, sample.change)
      const engine = new ShadowFeatureEngine()
      expect(engine.observe(event, feed, sample.origin, sample.now)).toBeNull()
      expect(engine.trackedStreamCount).toBe(0)
    }
  })

  it('rejects healthy feed acceptance for a different event on the same stream', () => {
    const first = book(1)
    const second = book(2)
    const engine = new ShadowFeatureEngine()
    expect(engine.observe(second, accepted(first), 'live', second.receivedTsMs)).toBeNull()
  })

  it('resets prior momentum after unhealthy data and refuses crossed books or duplicate identifiers', () => {
    const engine = new ShadowFeatureEngine()
    const first = book(1)
    expect(engine.observe(first, accepted(first), 'live', 1020)).not.toBeNull()
    expect(engine.observe(first, accepted(first), 'live', 1020)).toBeNull()
    const crossed = book(2, 101, 100)
    expect(engine.observe(crossed, accepted(crossed), 'live', 1030)).toBeNull()
    const recovered = book(3)
    const snapshot = engine.observe(recovered, accepted(recovered), 'live', 1040)!
    expect(snapshot.sampleCount).toBe(1)
    expect(snapshot.momentumBps).toBeNull()
  })

  it('bounds per-stream memory and reports missing depth as unknown, not zero', () => {
    const engine = new ShadowFeatureEngine(2)
    for (let i = 0; i < 50; i += 1) {
      const event = book(i + 1)
      event.symbol = `SYM${i}-USD`
      event.eventId = `event-${i}`
      event.updates = undefined
      const snapshot = engine.observe(event, accepted(event), 'live', event.receivedTsMs)!
      expect(snapshot.imbalance).toBeNull()
      expect(snapshot.bestBidQuantity).toBeNull()
      expect(engine.trackedStreamCount).toBeLessThanOrEqual(2)
    }
  })

  it('replays identical events to byte-identical snapshots and decisions', () => {
    const run = () => {
      const engine = new ShadowFeatureEngine()
      return Array.from({ length: 30 }, (_, i) => {
        const event = book(i + 1, 100 + i / 100, 100.04 + i / 100)
        const features = engine.observe(event, accepted(event), 'live', event.receivedTsMs)!
        const scouts = evaluateShadowScouts(features)
        return { features, scouts, candidate: fuseShadowScouts(features, scouts) }
      })
    }
    expect(run()).toEqual(run())
  })
})

describe('Phase 3 scouts, fusion, and simulated risk', () => {
  it('rejects a snapshot that expires before the risk decision', () => {
    const features = featuresForTwo()
    const candidate = fuseShadowScouts(features, evaluateShadowScouts(features))
    expect(assessShadowRisk(features, candidate, validMarket, validLimits).status)
      .toBe('SHADOW_ELIGIBLE')
    const expired = assessShadowRisk(features, candidate, validMarket, {
      ...validLimits,
      nowMs: features.exchangeTsMs + 501,
    })
    expect(expired.status).toBe('BLOCKED')
    expect(expired.simulatedNotional).toBe(0)
    expect(expired.reasonCodes).toContain('SOURCE_NOT_FRESH')
  })

  it('scouts abstain when data is not present and never emit an order or size', () => {
    const event = book(1)
    event.updates = undefined
    const features = new ShadowFeatureEngine().observe(event, accepted(event), 'live', 1020)!
    const scouts = evaluateShadowScouts(features)
    expect(scouts).toHaveLength(7)
    expect(scouts.every((s) => s.evidenceOnly)).toBe(true)
    expect(scouts.find((s) => s.scout === 'order_book_imbalance')?.score).toBeNull()
    expect(scouts.find((s) => s.scout === 'signed_trade_flow')?.score).toBeNull()
    const candidate = fuseShadowScouts(features, scouts)
    expect(candidate.intent).toBe('WATCH')
    expect(candidate.proposedNotional).toBeNull()
  })

  it('requires valid, independent evidence for positive fusion', () => {
    const features = featuresForTwo()
    const scouts = evaluateShadowScouts(features)
    const positive = fuseShadowScouts(features, scouts)
    expect(positive.intent).toBe('CONSIDER_LONG')
    expect(positive.candidateOnly).toBe(true)
    expect(fuseShadowScouts(features, scouts.slice(1)).intent).toBe('WATCH')
    expect(fuseShadowScouts(features, scouts.map((s) =>
      s.scout === 'momentum' ? { ...s, eventId: 'untrusted-event' } : s,
    )).intent).toBe('WATCH')
  })

  it('risk alone calculates a simulated notional, excluding protected reserve', () => {
    const features = featuresForTwo()
    const candidate = fuseShadowScouts(features, evaluateShadowScouts(features))
    const result = assessShadowRisk(features, candidate, validMarket, validLimits)
    expect(result.status).toBe('SHADOW_ELIGIBLE')
    expect(result.simulatedNotional).toBe(40)
    expect(result.executionAllowed).toBe(false)
    expect(result.candidateOnly).toBe(true)
  })

  it.each([
    ['stale', { ...validMarket, freshnessClass: 'red' }, validLimits],
    ['cache', { ...validMarket, priceOrigin: 'cache' }, validLimits],
    ['heartbeat', { ...validMarket, heartbeatState: 'missing' }, validLimits],
    ['guardian', validMarket, { ...validLimits, guardian: 'HALTED' }],
    ['cooldown', validMarket, { ...validLimits, cooldownUntilMs: 1200 }],
    ['drawdown', validMarket, { ...validLimits, drawdownFraction: 0.2 }],
    ['exposure', validMarket, { ...validLimits, symbolExposure: 200 }],
    ['reserve only', validMarket, { ...validLimits, reusableCash: 0 }],
  ] as const)('blocks %s without allocating capital', (_name, market, limits) => {
    const features = featuresForTwo()
    const candidate = fuseShadowScouts(features, evaluateShadowScouts(features))
    const result = assessShadowRisk(features, candidate, market, limits)
    expect(result.status).toBe('BLOCKED')
    expect(result.simulatedNotional).toBe(0)
    expect(result.executionAllowed).toBe(false)
  })

  it('cannot approve an untrusted WATCH candidate or a scale-in action', () => {
    const features = featuresForTwo()
    const candidate: ShadowCandidate = {
      candidateOnly: true, ruleVersion: 'phase3-shadow-fusion-v1',
      symbol: features.symbol, eventId: features.eventId,
      intent: 'WATCH', score: 1, proposedNotional: null, reasonCodes: [],
    }
    expect(assessShadowRisk(features, candidate, validMarket, validLimits).status).toBe('BLOCKED')
    const eligible = fuseShadowScouts(features, evaluateShadowScouts(features))
    expect(assessShadowRisk(features, eligible, { ...validMarket, action: 'scale_in' }, validLimits).status).toBe('BLOCKED')
  })
})

describe('Phase 3 shadow local latency budget', () => {
  it('measures p95 of feature, scouts, fusion, and risk under 15 ms', () => {
    const engine = new ShadowFeatureEngine()
    const samples: number[] = []
    for (let i = 0; i < 2000; i += 1) {
      const event = book(i + 1, 100 + i / 10000, 100.04 + i / 10000)
      const start = performance.now()
      const features = engine.observe(event, accepted(event), 'live', event.receivedTsMs)!
      const scouts = evaluateShadowScouts(features)
      const candidate = fuseShadowScouts(features, scouts)
      assessShadowRisk(features, candidate, validMarket, validLimits)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(0.95 * (samples.length - 1))]
    console.log('PHASE3_SHADOW_LOCAL_BENCHMARK', JSON.stringify({
      sampleCount: samples.length, p95Ms: Number(p95.toFixed(4)),
      environment: 'local Vitest runner; excludes network, provider and platform latency',
    }))
    expect(p95).toBeLessThanOrEqual(15)
  })
})

describe('Phase 2 feed integrity -> Phase 3 shadow handoff', () => {
  it('accepts only a heartbeat-healthy continuous feed and clears history on a sequence gap', async () => {
    const { FeedHealthRegistry } = await import('../../src/fast-path/feed-health')
    const { heartbeatFixture } = await import('./fixtures')
    const feed = new FeedHealthRegistry()
    const engine = new ShadowFeatureEngine()
    const e1 = book(1)
    expect(engine.observe(e1, feed.ingest(e1, e1.receivedTsMs), 'live', e1.receivedTsMs)).toBeNull()
    feed.ingest(heartbeatFixture({ exchangeTsMs: 1020, receivedTsMs: 1020 }), 1020)
    const e2 = book(2)
    const acceptedTwo = feed.ingest(e2, e2.receivedTsMs)
    expect(acceptedTwo.state.integrityState).toBe('healthy')
    expect(engine.observe(e2, acceptedTwo, 'live', e2.receivedTsMs)?.sampleCount).toBe(1)
    const skipped = book(4)
    const gap = feed.ingest(skipped, skipped.receivedTsMs)
    expect(gap.reason).toBe('sequence_gap')
    expect(engine.observe(skipped, gap, 'live', skipped.receivedTsMs)).toBeNull()
    expect(engine.trackedStreamCount).toBe(0)
  })
})
