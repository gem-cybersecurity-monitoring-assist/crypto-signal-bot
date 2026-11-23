import { describe, expect, it } from 'vitest'
import { buildSignalFreshnessMetadata } from '../../src/signals/freshness'

const now = Date.parse('2026-10-31T12:00:00.000Z')

describe('signal freshness metadata', () => {
  it('gives a recent persisted signal a stable event id but does not invent market-data time', () => {
    const result = buildSignalFreshnessMetadata({ sourceKind: 'persisted', symbol: 'BTC', signalId: 42, signalCreatedAt: '2026-10-31T11:55:00.000Z' }, now)
    expect(result.event_id).toBe('signal:BTC:42')
    expect(result.source_kind).toBe('persisted')
    expect(result.market_data_as_of).toBeNull()
    expect(result.market_snapshot_price).toBeNull()
    expect(result.market_data_stale).toBeNull()
    expect(result.stale).toBe(true)
    expect(result.decision_grade).toBe(false)
    expect(result.provenance_status).toBe('PERSISTED_SIGNAL')
  })

  it('marks old persisted signals stale', () => {
    const result = buildSignalFreshnessMetadata({ sourceKind: 'persisted', symbol: 'BTC', signalId: 42, signalCreatedAt: '2026-10-31T11:00:00.000Z' }, now)
    expect(result.stale).toBe(true)
  })

  it('marks a derived signal fresh only when a recent live-source snapshot matches', () => {
    const result = buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', side: 'BUY', priceSource: 'coinbase', entryPrice: 100, priceIsStale: false, snapshot: { id: 88, price: 100, source: 'coinbase', stale: 0, created_at: '2026-10-31T11:59:00.000Z' } }, now)
    expect(result.event_id).toBe('ema:BTC:88:BUY')
    expect(result.market_data_as_of).toBe('2026-10-31T11:59:00.000Z')
    expect(result.market_snapshot_price).toBe(100)
    expect(result.market_data_stale).toBe(false)
    expect(result.stale).toBe(false)
    expect(result.decision_grade).toBe(true)
    expect(result.provenance_status).toBe('DERIVED_WORKER_SIGNAL')
  })

  it('marks cache, fallback, mismatched, stale, and missing snapshots stale', () => {
    const snapshot = { id: 88, price: 100, source: 'coinbase', stale: 0, created_at: '2026-10-31T11:59:00.000Z' }
    for (const priceSource of ['cache:coinbase', 'fallback', 'binance']) {
      expect(buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', priceSource, entryPrice: 100, priceIsStale: false, snapshot }, now).stale).toBe(true)
    }
    expect(buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', priceSource: 'coinbase', entryPrice: 100, priceIsStale: false, snapshot: { ...snapshot, stale: 1 } }, now).stale).toBe(true)
    expect(buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', priceSource: 'coinbase', entryPrice: 100, priceIsStale: false }, now).stale).toBe(true)
  })

  it('requires the signal entry price to match the timestamped market snapshot', () => {
    const snapshot = { id: 91, price: 100, source: 'coinbase', stale: 0, created_at: '2026-10-31T11:59:00.000Z' }
    const mismatch = buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', priceSource: 'coinbase', entryPrice: 101, priceIsStale: false, snapshot }, now)
    const staleFeed = buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', priceSource: 'coinbase', entryPrice: 100, priceIsStale: true, snapshot }, now)
    expect(mismatch.stale).toBe(true)
    expect(mismatch.decision_grade).toBe(false)
    expect(staleFeed.stale).toBe(true)
    expect(staleFeed.decision_grade).toBe(false)
  })

  it('expires derived metadata when the market snapshot is old', () => {
    const result = buildSignalFreshnessMetadata({ sourceKind: 'derived', symbol: 'BTC', side: 'SELL', priceSource: 'binance', entryPrice: 100, priceIsStale: false, snapshot: { id: 90, price: 100, source: 'binance', stale: 0, created_at: '2026-10-31T11:00:00.000Z' } }, now)
    expect(result.stale).toBe(true)
    expect(result.event_id).toBe('ema:BTC:90:SELL')
  })

  it('marks even slightly future-dated market snapshots stale', () => {
    const result = buildSignalFreshnessMetadata({
      sourceKind: 'derived', symbol: 'BTC', side: 'BUY',
      priceSource: 'coinbase', entryPrice: 100, priceIsStale: false,
      snapshot: { id: 92, price: 100, source: 'coinbase', stale: 0, created_at: '2026-10-31T12:01:00.000Z' },
    }, now)
    expect(result.stale).toBe(true)
    expect(result.decision_grade).toBe(false)
    expect(result.market_data_stale).toBe(true)
  })
})