import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { CURRENT_ROLES_SQL } from '../src/management.ts'
import { evaluatePaperTraderAccess } from '../src/paper-trader-access.ts'

const activeProfile = { actor_id: 'actor-1', status: 'ACTIVE' }
const globalTrader = { role: 'TRADER', scope_type: 'GLOBAL', scope_key: 'global' }

test('an active profile with a current GLOBAL TRADER grant may enter paper execution', () => {
  const access = evaluatePaperTraderAccess({ access_allowed: true, profile: activeProfile, roles: [globalTrader] })
  assert.deepEqual(access, { allowed: true, actorId: 'actor-1' })
})

test('a missing identity payload is rejected as inactive', () => {
  const access = evaluatePaperTraderAccess(null)
  assert.equal(access.allowed, false)
  assert.equal(access.allowed === false && access.code, 'ACCOUNT_INACTIVE')
})

test('suspended or access-denied profiles are rejected even with a TRADER grant', () => {
  for (const identity of [
    { access_allowed: true, profile: { actor_id: 'actor-1', status: 'SUSPENDED' }, roles: [globalTrader] },
    { access_allowed: false, profile: activeProfile, roles: [globalTrader] },
  ]) {
    const access = evaluatePaperTraderAccess(identity)
    assert.equal(access.allowed === false && access.code, 'ACCOUNT_INACTIVE')
  }
})

test('an authenticated active user without any grant is told the TRADER role is required', () => {
  const access = evaluatePaperTraderAccess({ access_allowed: true, profile: activeProfile, roles: [] })
  assert.equal(access.allowed === false && access.code, 'TRADER_ROLE_REQUIRED')
  assert.equal(access.allowed === false && access.status, 403)
})

test('other roles, including RELEASE_ADMIN, do not imply paper trading authority', () => {
  for (const role of ['VIEWER', 'RISK_ADMIN', 'AUDITOR', 'RELEASE_ADMIN']) {
    const access = evaluatePaperTraderAccess({
      access_allowed: true,
      profile: activeProfile,
      roles: [{ role, scope_type: 'GLOBAL', scope_key: 'global' }],
    })
    assert.equal(access.allowed === false && access.code, 'TRADER_ROLE_REQUIRED', role)
  }
})

test('exchange, account or mis-keyed TRADER grants are not GLOBAL authority', () => {
  for (const scoped of [
    { role: 'TRADER', scope_type: 'EXCHANGE', scope_key: 'bitget' },
    { role: 'TRADER', scope_type: 'ACCOUNT', scope_key: 'portfolio-1' },
    { role: 'TRADER', scope_type: 'GLOBAL', scope_key: 'GLOBAL' },
  ]) {
    const access = evaluatePaperTraderAccess({ access_allowed: true, profile: activeProfile, roles: [scoped] })
    assert.equal(access.allowed === false && access.code, 'TRADER_ROLE_REQUIRED', JSON.stringify(scoped))
  }
})

test('the current-roles query excludes revoked and expired grants', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE live_actor_roles (
    actor_id TEXT NOT NULL, role TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL,
    granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
    PRIMARY KEY (actor_id, role, scope_type, scope_key)
  )`)
  const insert = db.prepare(`INSERT INTO live_actor_roles
    (actor_id, role, scope_type, scope_key, granted_by, granted_at, expires_at, revoked_at)
    VALUES (?, ?, 'GLOBAL', 'global', 'admin-1', '2026-10-01T00:00:00.000Z', ?, ?)`)
  insert.run('current', 'TRADER', null, null)
  insert.run('future-expiry', 'TRADER', '2099-01-01T00:00:00.000Z', null)
  insert.run('revoked', 'TRADER', null, '2026-10-20T00:00:00.000Z')
  insert.run('expired', 'TRADER', '2026-10-15T00:00:00.000Z', null)

  const now = '2026-10-28T00:00:00.000Z'
  const current = (actor: string) => db.prepare(CURRENT_ROLES_SQL).all(actor, now) as Array<{ role: string }>

  assert.equal(current('current').length, 1)
  assert.equal(current('future-expiry').length, 1)
  for (const actor of ['revoked', 'expired']) {
    const roles = current(actor)
    assert.equal(roles.length, 0, actor)
    const access = evaluatePaperTraderAccess({ access_allowed: true, profile: { actor_id: actor, status: 'ACTIVE' }, roles })
    assert.equal(access.allowed === false && access.code, 'TRADER_ROLE_REQUIRED', actor)
  }
})
