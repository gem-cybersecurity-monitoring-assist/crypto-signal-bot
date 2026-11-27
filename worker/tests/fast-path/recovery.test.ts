import { describe, expect, it } from 'vitest'
import { BinanceDepthRecovery } from '../../src/fast-path/recovery'
import { DEFAULT_FAST_PATH_THRESHOLDS } from '../../src/fast-path/types'
import { eventFixture } from './fixtures'

function binanceDelta(start: number, end: number) {
  return eventFixture({
    eventId: `binance:diff_depth:BTC-USDT:level2:${end}`,
    source: 'binance',
    channel: 'diff_depth',
    symbol: 'BTC-USDT',
    sequenceStart: start,
    sequenceEnd: end,
  })
}

describe('BinanceDepthRecovery', () => {
  it('returns healthy after a valid snapshot bridge', () => {
    const recovery = new BinanceDepthRecovery({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    recovery.begin(1_000)
    recovery.bufferDelta(binanceDelta(101, 102), 1_010)
    recovery.bufferDelta(binanceDelta(103, 104), 1_020)

    const result = recovery.applySnapshot(100, 1_030)
    expect(result.state).toBe('healthy')
    expect(result.lastSequence).toBe(104)
    expect(result.accepted).toHaveLength(2)
    expect(result.errorCode).toBeNull()
  })

  it('rejects buffered events older than the snapshot', () => {
    const recovery = new BinanceDepthRecovery({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    recovery.begin(1_000)
    recovery.bufferDelta(binanceDelta(90, 99), 1_010)
    recovery.bufferDelta(binanceDelta(101, 101), 1_020)

    const result = recovery.applySnapshot(100, 1_030)
    expect(result.state).toBe('healthy')
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
  })

  it('hard-resyncs when continuity breaks after the bridge', () => {
    const recovery = new BinanceDepthRecovery({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    recovery.begin(1_000)
    recovery.bufferDelta(binanceDelta(101, 101), 1_010)
    recovery.bufferDelta(binanceDelta(103, 103), 1_020)

    const result = recovery.applySnapshot(100, 1_030)
    expect(result.state).toBe('resyncing')
    expect(result.errorCode).toBe('SEQUENCE_GAP')
    expect(result.lastSequence).toBe(101)
  })

  it('becomes unavailable after recovery timeout', () => {
    const recovery = new BinanceDepthRecovery({ ...DEFAULT_FAST_PATH_THRESHOLDS })
    recovery.begin(1_000)
    recovery.bufferDelta(binanceDelta(101, 101), 1_010)

    const now = 1_000 + DEFAULT_FAST_PATH_THRESHOLDS.recoveryTimeoutMs + 1
    expect(recovery.tick(now)).toBe('unavailable')
    const result = recovery.applySnapshot(100, now)
    expect(result.state).toBe('unavailable')
    expect(result.errorCode).toBe('RECOVERY_TIMEOUT')
  })
})

describe('recovery evidence isolation', () => {
  it('rejects a different market symbol instead of bridging unrelated deltas', () => {
    const recovery = new BinanceDepthRecovery()
    recovery.bufferDelta(binanceDelta(101, 101), 1010)
    expect(recovery.bufferDelta({
      ...binanceDelta(102, 102), symbol: 'ETH-USDT',
      eventId: 'binance:diff_depth:ETH-USDT:level2:102',
    }, 1020)).toBe('unavailable')
    const result = recovery.applySnapshot(100, 1030)
    expect(result.errorCode).toBe('RECOVERY_SYMBOL_MISMATCH')
    expect(result.accepted).toEqual([])
  })

  it('latches buffer overflow rather than silently dropping history', () => {
    const recovery = new BinanceDepthRecovery({ ...DEFAULT_FAST_PATH_THRESHOLDS, maxBufferedEvents: 1 })
    recovery.bufferDelta(binanceDelta(101, 101), 1010)
    expect(recovery.bufferDelta(binanceDelta(102, 102), 1020)).toBe('unavailable')
    expect(recovery.applySnapshot(101, 1030).errorCode).toBe('RECOVERY_BUFFER_OVERFLOW')
    recovery.begin(2000)
    recovery.bufferDelta(binanceDelta(101, 101), 2010)
    expect(recovery.applySnapshot(100, 2020).state).toBe('healthy')
  })

  it.each([
    { source: 'coinbase' as const },
    { sequenceStart: undefined },
    { exchangeTsMs: 3000 },
    { eventId: 'invalid' },
  ])('rejects invalid recovery evidence %j', override => {
    const recovery = new BinanceDepthRecovery()
    expect(recovery.bufferDelta({ ...binanceDelta(101, 101), ...override }, 1010)).toBe('unavailable')
    expect(recovery.applySnapshot(100, 1020).errorCode).toBe('INVALID_RECOVERY_EVENT')
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid snapshot sequence %s', sequence => {
    const recovery = new BinanceDepthRecovery()
    recovery.bufferDelta(binanceDelta(101, 101), 1010)
    expect(recovery.applySnapshot(sequence, 1020).errorCode).toBe('INVALID_SNAPSHOT_SEQUENCE')
  })

  it('does not expose a partial bridge as an applicable batch', () => {
    const recovery = new BinanceDepthRecovery()
    recovery.bufferDelta(binanceDelta(101, 101), 1010)
    recovery.bufferDelta(binanceDelta(103, 103), 1020)
    const result = recovery.applySnapshot(100, 1030)
    expect(result.state).toBe('resyncing')
    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(2)
  })

  it('isolates buffered observations from later caller mutation', () => {
    const recovery = new BinanceDepthRecovery()
    const event = binanceDelta(101, 101)
    recovery.bufferDelta(event, 1010)
    event.sequenceEnd = 900
    const result = recovery.applySnapshot(100, 1020)
    expect(result.state).toBe('healthy')
    expect(result.lastSequence).toBe(101)
    expect(result.accepted[0].sequenceEnd).toBe(101)
  })
})
