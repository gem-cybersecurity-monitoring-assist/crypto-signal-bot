import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBitgetCancelOrderCandidate } from '../src/live/adapters/bitget/execution-candidate.ts'
import { assessBitgetSpotFamily } from '../src/live/adapters/bitget/spot-family-review.ts'

const AT = '2026-11-23T10:00:00.000Z'

async function input() {
  const candidate = await buildBitgetCancelOrderCandidate({
    productId: 'BTC-USDT', identity: { orderId: null, clientOrderId: 'review-cancel-1' },
    builtAt: '2026-11-23T09:59:00.000Z',
    expiresAt: '2026-11-23T10:01:00.000Z',
  })
  return {
    expectedExchangeAccountId: 'bitget-test-account-1',
    candidate,
    account: {
      exchangeAccountId: 'bitget-test-account-1',
      declaredFamily: 'CLASSIC_SPOT_V2' as const,
      observedFamily: 'CLASSIC_SPOT_V2' as const,
      observedAt: '2026-11-23T09:59:30.000Z',
      reviewedContractRef: 'contract-review-20261123',
      externallyVerifiedFamily: true,
      externalEvidenceHash: 'a'.repeat(64),
    },
    evaluatedAt: AT,
  }
}

test('review compatibility proves only source-level Classic endpoint consistency, not live authority', async () => {
  const result = await assessBitgetSpotFamily(await input())
  assert.equal(result.status, 'REVIEW_COMPATIBLE')
  assert.equal(result.approvedEndpoint, '/api/v2/spot/trade/cancel-order')
  assert.equal(result.sourceOnly, true)
  assert.equal(result.executionAllowed, false)
  assert.equal(result.providerMutationAllowed, false)
  assert.equal(result.mainnetAllowed, false)
  assert.equal(result.automaticRetryAllowed, false)
  assert.equal(result.withdrawalAllowed, false)
})

test('UTA v3 account never inherits Classic v2 mutation candidate', async () => {
  const data = await input()
  const result = await assessBitgetSpotFamily({
    ...data,
    account: { ...data.account, declaredFamily: 'UTA_SPOT_V3', observedFamily: 'UTA_SPOT_V3' },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.approvedEndpoint, null)
  assert.ok(result.reasonCodes.includes('UTA_V3_REQUIRES_SEPARATE_REVIEWED_ADAPTER'))
  assert.ok(result.reasonCodes.includes('CANDIDATE_ENDPOINT_FAMILY_MISMATCH'))
})

test('unknown, mismatched, and unverified account family fails closed', async () => {
  const data = await input()
  const cases = [
    { ...data.account, declaredFamily: 'UNKNOWN' as const, observedFamily: 'UNKNOWN' as const },
    { ...data.account, declaredFamily: 'UTA_SPOT_V3' as const },
    { ...data.account, exchangeAccountId: 'other-account' },
    { ...data.account, externallyVerifiedFamily: false },
    { ...data.account, externalEvidenceHash: 'not-a-hash' },
    { ...data.account, reviewedContractRef: '' },
  ]
  for (const account of cases) {
    const result = await assessBitgetSpotFamily({ ...data, account })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.approvedEndpoint, null)
  }
})

test('stale or future-dated external account evidence fails closed', async () => {
  const data = await input()
  const cases = ['2026-11-23T09:53:00.000Z', '2026-11-23T10:00:01.000Z', 'not-a-date']
  for (const observedAt of cases) {
    const result = await assessBitgetSpotFamily({
      ...data, account: { ...data.account, observedAt },
    })
    assert.equal(result.status, 'BLOCKED')
    assert.ok(result.reasonCodes.includes('ACCOUNT_FAMILY_EVIDENCE_NOT_CURRENT'))
  }
})

test('candidate hash tampering cannot inherit reviewed family compatibility', async () => {
  const data = await input()
  const candidate = {
    ...data.candidate,
    unsignedBody: { ...data.candidate.unsignedBody, symbol: 'ETHUSDT' },
  }
  const result = await assessBitgetSpotFamily({ ...data, candidate })
  assert.equal(result.status, 'BLOCKED')
  assert.ok(result.reasonCodes.includes('CANDIDATE_INTEGRITY_INVALID'))
  assert.equal(result.executionAllowed, false)
})

test('fabricated v3 endpoint or unsafe candidate method never becomes authorized', async () => {
  const data = await input()
  const mismatched = await assessBitgetSpotFamily({
    ...data,
    candidate: { ...data.candidate, endpoint: '/api/v3/trade/cancel-order' },
  })
  assert.equal(mismatched.status, 'BLOCKED')
  const unsafeMethod = await assessBitgetSpotFamily({
    ...data,
    candidate: { ...data.candidate, method: 'POST' as never },
  })
  assert.equal(unsafeMethod.status, 'BLOCKED')
  assert.equal(unsafeMethod.providerMutationAllowed, false)
})

test('expired and future-created candidate windows fail closed despite intact candidate hashes', async () => {
  const data = await input()
  const windows = [
    ['2026-11-23T09:50:00.000Z', '2026-11-23T09:59:59.000Z'],
    ['2026-11-23T10:00:01.000Z', '2026-11-23T10:01:00.000Z'],
  ]
  for (const [builtAt, expiresAt] of windows) {
    const candidate = await buildBitgetCancelOrderCandidate({
      productId: 'BTC-USDT', identity: { orderId: null, clientOrderId: 'review-cancel-1' },
      builtAt, expiresAt,
    })
    const result = await assessBitgetSpotFamily({ ...data, candidate })
    assert.equal(result.status, 'BLOCKED')
    assert.ok(result.reasonCodes.includes('CANDIDATE_VALIDITY_WINDOW_INACTIVE'))
    assert.equal(result.approvedEndpoint, null)
  }
})
