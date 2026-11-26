import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/index', () => ({
  default: { fetch: vi.fn(), scheduled: vi.fn() },
  requireApiKey: vi.fn(() => false),
  checkRateLimit: vi.fn(async () => true),
}))
import worker from '../../src/index_with_d1'
import type { Env } from '../../src/index'

describe('Guardian read status fails closed', () => {
  it.each(['missing', 'prepare-error', 'query-error', 'malformed'])('reports %s evidence as halted', async (mode) => {
    const DB = {
      prepare(sql: string) {
        if (sql.includes('guardian_state')) {
          if (mode === 'prepare-error') throw new Error('private storage detail')
          return { async first() {
            if (mode === 'query-error') throw new Error('private storage detail')
            return mode === 'malformed' ? { triggered: 8 } : null
          } }
        }
        return { async first() { return { ok: 1 } } }
      },
    }
    const response = await worker.fetch(new Request('https://worker.example/v2/infrastructure/status'),
      { DB } as unknown as Env, {} as ExecutionContext)
    const body = await response.json()
    expect(body.guardian.halted).toBe(true)
    expect(body.guardian.reason).toBe('GUARDIAN_STATE_UNAVAILABLE')
    expect(JSON.stringify(body)).not.toContain('private storage detail')
  })
})

describe('Guardian persisted record provenance', () => {
  it.each([
    ['2025-01-01 00:00:00', 'recorded', '2025-01-01T00:00:00.000Z'],
    ['2025-02-30 00:00:00', 'invalid_timestamp', null],
    ['2099-01-01 00:00:00', 'invalid_timestamp', null],
    [null, 'invalid_timestamp', null],
  ])('reports original row time without inventing a risk cycle: %s', async (updated_at, row_status, state_updated_at) => {
    const DB = {
      prepare(sql: string) {
        if (sql.includes('guardian_state')) {
          expect(sql).toContain('updated_at')
          return { async first() { return {triggered: 1, reason: 'TEST_HALT', drawdown_pct: 5, updated_at} } }
        }
        return { async first() { return {ok: 1} } }
      },
    }
    const response = await worker.fetch(new Request('https://worker.example/v2/infrastructure/status'),
      {DB} as unknown as Env, {} as ExecutionContext)
    expect((await response.json()).guardian).toMatchObject({
      halted: true, state_source: 'legacy_d1_global_flag', row_status, state_updated_at,
      risk_cycle_verified: false, shared_clearance_verified: false,
    })
  })
})
