import { describe, expect, it } from 'vitest'
import { buildSignalProvenance, SIGNAL_MAX_AGE_MS } from '../../src/signal-provenance'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')

describe('read-only signal provenance', () => {
  it('marks a persisted signal decision-grade only with fresh signal and market timestamps', () => {
    const result = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'persisted',
      signalId: 42,
      signalCreatedAt: '2026-10-31 11:59:00',
      marketDataAsOf: '2026-10-31 11:59:30',
      priceSource: 'coinbase',
      marketSnapshotStale: false,
      nowMs: NOW,
    })

    expect(result.event_id).toBe('persisted:42')
    expect(result.provenance_status).toBe('PERSISTED_SIGNAL')
    expect(result.stale).toBe(false)
    expect(result.decision_grade).toBe(true)
  })

  it('gives derived signals a stable identity tied to their source snapshot', () => {
    const result = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'derived',
      signalCreatedAt: '2026-10-31T12:00:00.000Z',
      marketSnapshotId: 77,
      marketDataAsOf: '2026-10-31T11:59:45.000Z',
      priceSource: 'binance',
      nowMs: NOW,
    })

    expect(result.event_id).toBe('derived:BTC:77:BUY')
    expect(result.provenance_status).toBe('DERIVED_WORKER_SIGNAL')
    expect(result.decision_grade).toBe(true)
  })

  it('rejects static fallback prices and cached prices as decision-grade', () => {
    for (const priceSource of ['fallback', 'cache:coinbase']) {
      const result = buildSignalProvenance({
        symbol: 'BTC',
        side: 'HOLD',
        sourceKind: 'derived',
        marketSnapshotId: 10,
        marketDataAsOf: '2026-10-31T11:59:00.000Z',
        priceSource,
        nowMs: NOW,
      })
      expect(result.stale).toBe(true)
      expect(result.decision_grade).toBe(false)
    }
  })

  it('rejects missing identities, missing timestamps, and stale snapshots', () => {
    const missing = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'derived',
      priceSource: 'coinbase',
      nowMs: NOW,
    })
    expect(missing.event_id).toBeNull()
    expect(missing.decision_grade).toBe(false)

    const stale = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'derived',
      marketSnapshotId: 11,
      marketDataAsOf: new Date(NOW - SIGNAL_MAX_AGE_MS - 1).toISOString(),
      priceSource: 'coinbase',
      nowMs: NOW,
    })
    expect(stale.stale).toBe(true)
    expect(stale.decision_grade).toBe(false)
  })

  it('rejects a recent persisted signal when its market snapshot is stale', () => {
    const result = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'persisted',
      signalId: 91,
      signalCreatedAt: '2026-10-31T11:59:00.000Z',
      marketDataAsOf: '2026-10-31T11:00:00.000Z',
      priceSource: 'coinbase',
      nowMs: NOW,
    })
    expect(result.stale).toBe(true)
    expect(result.decision_grade).toBe(false)
  })

  it('rejects unsupported signal sides', () => {
    const result = buildSignalProvenance({
      symbol: 'BTC',
      side: 'OPEN_LONG',
      sourceKind: 'derived',
      signalCreatedAt: new Date(NOW).toISOString(),
      marketSnapshotId: 14,
      marketDataAsOf: new Date(NOW - 1_000).toISOString(),
      priceSource: 'coinbase',
      nowMs: NOW,
    })
    expect(result.decision_grade).toBe(false)
  })

  it('rejects future-dated source timestamps and explicitly stale snapshots', () => {
    const future = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'derived',
      marketSnapshotId: 12,
      marketDataAsOf: new Date(NOW + 60_000).toISOString(),
      priceSource: 'coinbase',
      nowMs: NOW,
    })
    const flagged = buildSignalProvenance({
      symbol: 'BTC',
      side: 'BUY',
      sourceKind: 'derived',
      marketSnapshotId: 13,
      marketDataAsOf: new Date(NOW - 1_000).toISOString(),
      priceSource: 'coinbase',
      marketSnapshotStale: true,
      nowMs: NOW,
    })
    expect(future.decision_grade).toBe(false)
    expect(flagged.decision_grade).toBe(false)
  })
})
