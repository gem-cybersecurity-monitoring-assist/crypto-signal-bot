import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAuthenticatedCloudflareAccount,
  verifyAuthenticatedCloudflareAccount,
} from './verify-cloudflare-token-scope.mjs'
import { CANONICAL_WORKER_ACCOUNT_ID } from './verify-worker-deployment-target.mjs'

const canonical = CANONICAL_WORKER_ACCOUNT_ID
const env = {
  CLOUDFLARE_ACCOUNT_ID: canonical,
  CLOUDFLARE_API_TOKEN: 'FAKE_TOKEN_NEVER_LOG',
}
const good = { loggedIn: true, accounts: [{ id: canonical, name: 'ignored' }] }

test('accepts only the authenticated canonical account', () => {
  assert.deepEqual(verifyAuthenticatedCloudflareAccount(good, env), {
    verified: true, accountId: canonical,
  })
  assert.deepEqual(checkAuthenticatedCloudflareAccount(env, () => ({
    status: 0, stdout: JSON.stringify(good),
  })), { verified: true, accountId: canonical })
})

test('wrong account is blocked without leaking IDs, token, or user information', () => {
  const result = { loggedIn: true, accounts: [{ id: '11112222333344445555666677778888', name: 'private-name' }] }
  assert.throws(
    () => checkAuthenticatedCloudflareAccount(env, () => ({
      status: 0, stdout: JSON.stringify(result),
    })),
    (error) => {
      assert.match(error.message, /cannot access the canonical/)
      assert.doesNotMatch(error.message, /11112222|FAKE_TOKEN|private-name/)
      return true
    },
  )
})

test('fails closed when authenticated account evidence is not available', () => {
  for (const response of [
    null, {}, { loggedIn: false, accounts: [] },
    { loggedIn: true }, { loggedIn: true, accounts: {} },
    { loggedIn: true, accounts: ['untyped-account'] },
  ]) {
    assert.throws(() => verifyAuthenticatedCloudflareAccount(response, env))
  }
})

test('missing token and wrong configured account reject before calling Wrangler', () => {
  for (const badEnv of [
    { ...env, CLOUDFLARE_API_TOKEN: '' },
    { ...env, CLOUDFLARE_ACCOUNT_ID: '11112222333344445555666677778888' },
  ]) {
    let called = false
    assert.throws(() => checkAuthenticatedCloudflareAccount(badEnv, () => {
      called = true
      return { status: 0, stdout: JSON.stringify(good) }
    }))
    assert.equal(called, false)
  }
})

test('nonzero, malformed and credential-bearing errors never reach deployment logs', () => {
  for (const outcome of [
    { status: 1, stdout: 'FAKE_TOKEN_NEVER_LOG', stderr: 'user@example.com' },
    { status: 0, stdout: 'not-json FAKE_TOKEN_NEVER_LOG' },
    { status: null, error: new Error('FAKE_TOKEN_NEVER_LOG'), stdout: '{}' },
  ]) {
    assert.throws(() => checkAuthenticatedCloudflareAccount(env, () => outcome), (error) => {
      assert.match(error.message, /Cloudflare deployment blocked:/)
      assert.doesNotMatch(error.message, /FAKE_TOKEN|user@example.com/)
      return true
    })
  }
})

test('rejects malformed or duplicate account evidence even when canonical account is present', () => {
  for (const accounts of [
    [{ id: canonical }, { id: canonical }],
    [{ id: canonical }, { id: 'not-a-cloudflare-id' }],
    [{ id: canonical }, null],
    [{ id: canonical }, { id: 123 }],
    [{ id: canonical }, ['unexpected-array']],
  ]) {
    assert.throws(() => verifyAuthenticatedCloudflareAccount({ loggedIn: true, accounts }, env),
      /Cloudflare deployment blocked:/)
  }
})
