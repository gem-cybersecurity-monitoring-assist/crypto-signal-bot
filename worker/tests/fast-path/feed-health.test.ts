import { describe, expect, it } from 'vitest'
import { FeedHealthRegistry } from '../../src/fast-path/feed-health'
import { DEFAULT_FAST_PATH_THRESHOLDS } from '../../src/fast-path/types'
import { eventFixture, heartbeatFixture } from './fixtures'

const key = 'coinbase:l2_data:BTC-USD'

describe('FeedHealthRegistry', () => {
  it('requires heartbeat before reporting a healthy feed', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    registry.ingest(eventFixture(), 1_010)
    expect(registry.get(key, 1_010)?.integrityState).toBe('degraded')

    registry.ingest(heartbeatFixture(), 1_020)
    const state = registry.get(key, 1_020)
    expect(state?.heartbeatState).toBe('healthy')
    expect(state?.integrityState).toBe('healthy')
    expect(state?.freshnessClass).toBe('green')
  })

  it('rejects duplicate event ids without advancing state', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    const event = eventFixture()
    expect(registry.ingest(event).accepted).toBe(true)
    const duplicate = registry.ingest(event)
    expect(duplicate.accepted).toBe(false)
    expect(duplicate.reason).toBe('duplicate')
    expect(duplicate.state.duplicateCount).toBe(1)
    expect(duplicate.state.lastSequence).toBe(1)
  })

  it('detects a skipped sequence and enters resyncing state', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    registry.ingest(eventFixture({ sequenceStart: 1, sequenceEnd: 1 }))
    registry.ingest(heartbeatFixture())
    const result = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:3',
      sequenceStart: 3,
      sequenceEnd: 3,
      receivedTsMs: 1_030,
    }), 1_030)

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('sequence_gap')
    expect(result.state.integrityState).toBe('resyncing')
    expect(result.state.gapCount).toBe(1)
  })

  it('rejects out-of-order sequences', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    registry.ingest(eventFixture({ sequenceStart: 5, sequenceEnd: 5 }))
    const result = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:4',
      sequenceStart: 4,
      sequenceEnd: 4,
    }))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('out_of_order')
    expect(result.state.outOfOrderCount).toBe(1)
  })

  it('marks stalled recovery unavailable after timeout', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    registry.ingest(eventFixture({ sequenceStart: 1, sequenceEnd: 1 }), 1_010)
    registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:3',
      sequenceStart: 3,
      sequenceEnd: 3,
      receivedTsMs: 1_030,
    }), 1_030)

    const expired = registry.get(key, 1_030 + DEFAULT_FAST_PATH_THRESHOLDS.recoveryTimeoutMs + 1)
    expect(expired?.recoveryState).toBe('unavailable')
    expect(expired?.integrityState).toBe('unavailable')
    expect(expired?.lastErrorCode).toBe('RECOVERY_TIMEOUT')
  })

  it('marks a heartbeat stale after the configured timeout', () => {
    const registry = new FeedHealthRegistry({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    registry.ingest(eventFixture(), 1_010)
    registry.ingest(heartbeatFixture(), 1_020)
    const stale = registry.get(key, 1_020 + DEFAULT_FAST_PATH_THRESHOLDS.heartbeatTimeoutMs + 1)
    expect(stale?.heartbeatState).toBe('stale')
    expect(stale?.integrityState).toBe('degraded')
    expect(stale?.freshnessClass).toBe('red')
  })
})

describe('rejected evidence cannot refresh a market observation', () => {
  it('retains the prior accepted timestamp after a sequence gap', () => {
    const registry = new FeedHealthRegistry()
    registry.ingest(eventFixture(), 1010)
    registry.ingest(heartbeatFixture(), 1020)
    const gap = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:3', sequenceStart: 3, sequenceEnd: 3,
      exchangeTsMs: 2000, receivedTsMs: 2010,
    }), 2010)
    expect(gap.accepted).toBe(false)
    expect(gap.state.lastExchangeTsMs).toBe(1000)
    expect(gap.state.lastReceivedTsMs).toBe(1010)
    const late = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:2', sequenceStart: 2, sequenceEnd: 2,
      exchangeTsMs: 2020, receivedTsMs: 2030,
    }), 2030)
    expect(late.accepted).toBe(false)
    expect(late.state.integrityState).toBe('resyncing')
    expect(late.state.lastSequence).toBe(1)
    expect(registry.markRecoveryHealthy(key, 3, 2040)?.eventAgeMs).toBeNull()
  })

  it('rejects future and malformed observations, latching unavailable state', () => {
    const registry = new FeedHealthRegistry()
    registry.ingest(eventFixture(), 1010)
    registry.ingest(heartbeatFixture(), 1020)
    const future = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:2', sequenceStart: 2, sequenceEnd: 2,
      exchangeTsMs: 3000, receivedTsMs: 3010,
    }), 2000)
    expect(future.accepted).toBe(false)
    expect(future.state.integrityState).toBe('unavailable')
    expect(future.state.lastExchangeTsMs).toBe(1000)
    const next = registry.ingest(eventFixture({
      eventId: 'coinbase:l2_data:BTC-USD:level2:3', sequenceStart: 3, sequenceEnd: 3,
      exchangeTsMs: 2000, receivedTsMs: 2010,
    }), 2010)
    expect(next.accepted).toBe(false)
    expect(next.state.integrityState).toBe('unavailable')
  })

  it('does not substitute heartbeat timestamp for accepted market data', () => {
    const registry = new FeedHealthRegistry()
    registry.ingest(eventFixture(), 1010)
    registry.ingest(heartbeatFixture({ exchangeTsMs: 3015, receivedTsMs: 3020 }), 3020)
    expect(registry.get(key, 3020)?.lastExchangeTsMs).toBe(1000)
    expect(registry.get(key, 3020)?.freshnessClass).toBe('red')
  })

  it('rejects noncanonical identities and missing market sequences', () => {
    for (const event of [
      eventFixture({ eventId: 'different-source' }),
      eventFixture({ eventId: 'coinbase:l2_data:BTC-USD:level2:1000', sequenceStart: undefined, sequenceEnd: undefined }),
    ]) {
      const registry = new FeedHealthRegistry()
      expect(registry.ingest(event).accepted).toBe(false)
      expect(registry.get(key)?.lastExchangeTsMs).toBeNull()
    }
  })
})
