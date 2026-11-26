/** Isolated replay read model. No production binding or trading authority. */
import { canonicalHash, canonicalJson } from '../live/canonical-json.ts'
import { asSignedDecimalString } from '../live/decimal.ts'
import { assertReplayConservation } from '../durable-objects/replay-accounting-invariant.ts'
import type { PortfolioSnapshot, ReplayOutboxEvent } from '../durable-objects/PortfolioState.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/
const HASH = /^[a-f0-9]{64}$/
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }
export async function projectReplayEvent(db: D1Database, event: ReplayOutboxEvent) {
  // Copy the source before awaits, then hash precisely the validated copy.
  const record = structuredClone(event)
  let state: PortfolioSnapshot
  if (record.type === 'replay_fill') {
    const r = record.receipt
    if (!r || r.executionAuthorized !== false || r.providerMutationAllowed !== false ||
        !HASH.test(r.id) || !HASH.test(r.inputHash) || !validId(r.eventId) ||
        r.portfolioId !== r.state?.portfolioId || r.version !== r.state?.version || r.state.halted !== false) {
      throw new Error('Invalid replay receipt')
    }
    if (r.id !== await canonicalHash({portfolioId:r.portfolioId,eventId:r.eventId})) {
      throw new Error('Replay receipt identity mismatch')
    }
    if (typeof r.realizedPnl !== 'string' || r.realizedPnl.length > 120) throw new Error('Invalid replay receipt P&L')
    asSignedDecimalString(r.realizedPnl)
    state = r.state
  } else if (record.type === 'replay_valuation') {
    const r = record.receipt
    if (!r || r.executionAuthorized !== false || !validId(r.eventId) || !HASH.test(r.inputHash) ||
        !r.state?.valuation || r.id !== await canonicalHash({portfolioId:r.state.portfolioId,eventId:r.eventId,kind:'valuation'})) {
      throw new Error('Invalid replay valuation receipt')
    }
    state = r.state
  } else if (record.type === 'replay_halted' && record.executionAuthorized === false && record.state?.halted === true) {
    state = record.state
  } else throw new Error('Invalid replay event')
  if (state.version < 1) throw new Error('Invalid replay event version')
  const bookValue = assertReplayConservation(state)
  const json = canonicalJson(record)
  if (json.length > 65536) throw new Error('Replay projection payload too large')
  const hash = await canonicalHash(record)
  // A single guarded statement; duplicate identity and contiguous ordering
  // are enforced by SQLite itself, including concurrent deliveries.
  const inserted = await db.prepare(`
    INSERT INTO isolated_replay_portfolio_events
      (portfolio_id, version, event_hash, event_type, event_json, book_value)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE ? = COALESCE((SELECT MAX(version)+1 FROM isolated_replay_portfolio_events WHERE portfolio_id=?),1)
    ON CONFLICT(portfolio_id,version) DO NOTHING
  `).bind(state.portfolioId,state.version,hash,record.type,json,bookValue,state.version,state.portfolioId).run()
  if (!inserted.success) throw new Error('Replay projection unavailable')
  const existing = await db.prepare(`
    SELECT event_hash FROM isolated_replay_portfolio_events WHERE portfolio_id=? AND version=?
  `).bind(state.portfolioId,state.version).first<{event_hash:string}>()
  if (!existing) throw new Error('Replay projection sequence gap')
  if (existing.event_hash !== hash) throw new Error('Replay projection identity conflict')
  return {portfolioId:state.portfolioId,version:state.version,eventHash:hash,
    replayed: inserted.meta.changes === 0, bookValue, executionAuthorized:false as const}
}
