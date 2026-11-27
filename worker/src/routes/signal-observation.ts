/** Dedicated read-only observation contract; no provider or execution calls. */
export const SIGNAL_OBSERVATION_PATH = '/v2/signals/observation'
export type SignalObservationEnv = { DB: D1Database; SIGNAL_OBSERVATION_READ_KEY?: string }

type Row = { id: number; symbol: string; timeframe: string; side: string; confidence: number; created_at: string }
const symbolPattern = /^[A-Z0-9]{2,12}$/
const framePattern = /^[1-9][0-9]{0,2}[mhdw]$/
const utcSqlTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

async function authorized(expected: string | undefined, supplied: string | null) {
  if (!expected || expected.length < 32 || expected.length > 256 || !supplied || supplied.length > 256) return false
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([expected, supplied].map(async key =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)))))
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function handleSignalObservation(request: Request, env: SignalObservationEnv, now = Date.now()): Promise<Response> {
  const respond = (status: number, body: object) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } })
  if (request.method !== 'GET') return respond(405, { error: 'method_not_allowed' })
  if (!await authorized(env.SIGNAL_OBSERVATION_READ_KEY, request.headers.get('X-Signal-Observation-Key'))) {
    return respond(401, { error: 'unauthorized' })
  }
  const symbol = new URL(request.url).searchParams.get('symbol') ?? ''
  if (!symbolPattern.test(symbol)) return respond(400, { error: 'invalid_symbol' })
  const base = {
    version: '1.0', source: 'worker_d1_signal_history', symbol,
    observed_at_ms: now, event_time_verified: false,
    sequence_verified: false, execution_authorized: false,
  }
  try {
    const row = await env.DB.prepare(
      'SELECT id, symbol, timeframe, side, confidence, created_at FROM signals WHERE symbol = ? ORDER BY id DESC LIMIT 1',
    ).bind(symbol).first<Row>()
    if (!row) return respond(200, { ...base, status: 'not_reported', observation: null })
    const recorded = typeof row.created_at === 'string' && utcSqlTime.test(row.created_at)
      ? Date.parse(row.created_at.replace(' ', 'T') + 'Z') : NaN
    if (!Number.isSafeInteger(row.id) || row.id < 1 || row.symbol !== symbol ||
        typeof row.timeframe !== 'string' || !framePattern.test(row.timeframe) ||
        !['BUY', 'SELL', 'HOLD', 'FLAT'].includes(row.side) ||
        typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) ||
        row.confidence < 0 || row.confidence > 1 || !Number.isFinite(recorded) ||
        new Date(recorded).toISOString().slice(0, 19).replace('T', ' ') !== row.created_at ||
        recorded > now) {
      return respond(200, { ...base, status: 'unverified', observation: null })
    }
    return respond(200, { ...base, status: 'historical', observation: {
      id: 'signal:' + symbol + ':' + row.id, row_id: row.id, timeframe: row.timeframe,
      side: row.side, confidence: row.confidence, recorded_at_ms: recorded,
    } })
  } catch {
    return respond(503, { ...base, status: 'unavailable', observation: null })
  }
}
