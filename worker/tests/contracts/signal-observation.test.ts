import { describe, expect, it, vi } from 'vitest'
import { handleSignalObservation } from '../../src/routes/signal-observation'
const key = 'test-read-only-key-that-is-long-enough'
const now = Date.parse('2026-11-25T23:00:00Z')
const row = { id: 42, symbol: 'BTC', timeframe: '5m', side: 'BUY', confidence: 0.7, created_at: '2026-11-25 22:59:59' }
const request = (symbol = 'BTC', token = key, method = 'GET') =>
  new Request('https://worker.example/v2/signals/observation?symbol=' + encodeURIComponent(symbol),
    { method, headers: { 'X-Signal-Observation-Key': token } })
function env(value: unknown = row, fail = false) {
  const first = vi.fn(async () => { if (fail) throw new Error('private database detail'); return value })
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))
  return { DB: { prepare } as unknown as D1Database, SIGNAL_OBSERVATION_READ_KEY: key, prepare, bind, first }
}
describe('persisted signal observation', () => {
  it('uses one fixed SELECT and marks row identity historical, never executable', async () => {
    const e = env()
    const response = await handleSignalObservation(request(), e, now)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(e.prepare).toHaveBeenCalledExactlyOnceWith('SELECT id, symbol, timeframe, side, confidence, created_at FROM signals WHERE symbol = ? ORDER BY id DESC LIMIT 1')
    expect(e.bind).toHaveBeenCalledExactlyOnceWith('BTC')
    expect(await response.json()).toMatchObject({ status: 'historical', event_time_verified: false,
      sequence_verified: false, execution_authorized: false, observation: { id: 'signal:BTC:42', row_id: 42 } })
  })
  it.each(['', 'wrong'])('denies missing or incorrect key without querying', async token => {
    const e = env()
    expect((await handleSignalObservation(request('BTC', token), e, now)).status).toBe(401)
    expect(e.prepare).not.toHaveBeenCalled()
  })
  it('fails closed when binding absent', async () => {
    const e = env()
    expect((await handleSignalObservation(request(), { DB: e.DB }, now)).status).toBe(401)
    expect(e.prepare).not.toHaveBeenCalled()
  })
  it('rejects non-GET and malformed symbol', async () => {
    const e = env()
    expect((await handleSignalObservation(request('BTC', key, 'POST'), e, now)).status).toBe(405)
    expect((await handleSignalObservation(request("BTC' OR 1=1"), e, now)).status).toBe(400)
    expect(e.prepare).not.toHaveBeenCalled()
  })
  it.each([{ id: 0 }, { symbol: 'ETH' }, { confidence: NaN }, { confidence: 2 },
    { created_at: '2026-11-25 23:00:01' }, { created_at: '2026-02-30 12:00:00' },
    { created_at: 'invalid' }, { side: 'UNKNOWN' }])('rejects malformed row %j', async override => {
    expect(await (await handleSignalObservation(request(), env({ ...row, ...override }), now)).json())
      .toMatchObject({ status: 'unverified', observation: null })
  })
  it('distinguishes no row and failed storage', async () => {
    expect(await (await handleSignalObservation(request(), env(null), now)).json()).toMatchObject({ status: 'not_reported', observation: null })
    const failed = await handleSignalObservation(request(), env(row, true), now)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ status: 'unavailable', observation: null })
  })
})
