import { describe, expect, it } from 'vitest'
import { DepthObservationSession } from '../../src/fast-path/depth-observation-session'
import { FeedHealthRegistry } from '../../src/fast-path/feed-health'
import { normalizeBinanceMessage } from '../../src/fast-path/normalizers/binance'
import { DEFAULT_FAST_PATH_THRESHOLDS } from '../../src/fast-path/types'

const now = 1_700_000_000_000
function delta(start: number, end = start, offset = 10, symbol = 'BTCUSDT') {
  return normalizeBinanceMessage({
    e: 'depthUpdate', s: symbol, E: now + offset, U: start, u: end,
    b: [['100', '1']], a: [['101', '1']],
  }, now + offset)[0]
}

function setup() {
  const registry = new FeedHealthRegistry()
  const session = new DepthObservationSession('BTC-USDT', registry)
  const attempt = session.begin(now)
  const snapshot = { source: 'binance' as const, symbol: 'BTC-USDT', attempt, receivedAtMs: now + 20, lastUpdateId: 100 }
  return { registry, session, snapshot }
}

describe('depth observation session', () => {
  it('joins normalization, snapshot recovery and subsequent observations without publishing snapshot timestamps', () => {
    const { session, snapshot } = setup()
    expect(session.receive(delta(101), now+10)).toBe('buffered')
    expect(session.status(now+10).feed?.lastExchangeTsMs).toBeNull()
    expect(session.applySnapshot(snapshot, now+20)).toBe(true)
    const recovered = session.status(now+20)
    expect(recovered.feed?.lastSequence).toBe(101)
    expect(recovered.feed?.lastExchangeTsMs).toBeNull()
    expect(recovered.feed?.integrityState).toBe('degraded')
    expect(recovered.executionAuthorized).toBe(false)
    expect(session.receive(delta(102,102,30), now+30)).toBe('observed')
    expect(session.status(now+30).feed?.lastExchangeTsMs).toBe(now+30)
  })

  it('invalidates previous observation during a sequence gap and starts another recovery', () => {
    const { session, snapshot } = setup()
    session.receive(delta(101), now+10)
    session.applySnapshot(snapshot, now+20)
    session.receive(delta(102,102,30), now+30)
    expect(session.receive(delta(104,104,40), now+40)).toBe('buffered')
    const status = session.status(now+40)
    expect(status.phase).toBe('recovering')
    expect(status.attempt).toBe(2)
    expect(status.feed?.lastExchangeTsMs).toBeNull()
    expect(session.applySnapshot(snapshot, now+45)).toBe(false)
    expect(session.status(now+45).phase).toBe('recovering')
    expect(session.applySnapshot({...snapshot, attempt:2, lastUpdateId:103, receivedAtMs:now+50},now+50)).toBe(true)
    expect(session.status(now+50).feed?.lastSequence).toBe(104)
  })

  it('rejects cross-symbol events and snapshots', () => {
    const a = setup()
    expect(a.session.receive(delta(101,101,10,'ETHUSDT'),now+10)).toBe('rejected')
    expect(a.session.status(now+10).phase).toBe('unavailable')
    const b = setup()
    b.session.receive(delta(101),now+10)
    expect(b.session.applySnapshot({...b.snapshot,symbol:'ETH-USDT'},now+20)).toBe(false)
    expect(b.session.status(now+20).feed?.lastSequence).toBeNull()
  })

  it('rejects stale attempt evidence without invalidating a new attempt', () => {
    const { session, snapshot } = setup()
    const next = session.begin(now+5)
    session.receive(delta(101),now+10)
    expect(session.applySnapshot(snapshot,now+20)).toBe(false)
    expect(session.applySnapshot({...snapshot,attempt:next},now+20)).toBe(true)
    expect(session.status(now+20).providerAuthenticityVerified).toBe(false)
  })

  it('does not publish partial recovery or allow late events after timeout', () => {
    const { session, snapshot } = setup()
    session.receive(delta(101),now+10)
    session.receive(delta(103,103,15),now+15)
    expect(session.applySnapshot(snapshot,now+20)).toBe(false)
    expect(session.status(now+20).feed?.lastExchangeTsMs).toBeNull()
    expect(session.receive(delta(104,104,30),now+30)).toBe('rejected')
    session.begin(now+40)
    const expired = now+40+DEFAULT_FAST_PATH_THRESHOLDS.recoveryTimeoutMs+1
    expect(session.status(expired).phase).toBe('unavailable')
  })
})
