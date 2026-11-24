import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import {
  interpretBitgetV3OrderWriteAcknowledgement,
  prepareBitgetV3OrderWriteRequest,
} from '../src/live/adapters/bitget/v3/order-write-protocol-v3.ts'
import { asDecimalString } from '../src/live/decimal.ts'
import { canonicalHash } from '../src/live/canonical-json.ts'
import type { ProductRules } from '../src/live/domain.ts'
import {
  BITGET_V3_ORDER_CANDIDATE_ENDPOINTS,
  buildBitgetV3UnsignedPlaceCandidate,
  buildBitgetV3UnsignedCancelCandidate,
} from '../src/live/adapters/bitget/v3/unsigned-candidate-v3.ts'

function productRules(): ProductRules {
  return {
    productId: 'BTC-USDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    baseIncrement: asDecimalString('0.00000001'),
    quoteIncrement: asDecimalString('0.01'), priceIncrement: asDecimalString('0.01'),
    minimumBaseSize: asDecimalString('0.0001'), maximumBaseSize: asDecimalString('10'),
    minimumQuoteSize: asDecimalString('5'), tradingEnabled: true,
    supportedOrderTypes: ['MARKET','LIMIT'],
    observedAt: '2026-07-17T14:00:00.000Z',
    expiresAt: '2026-07-17T14:10:00.000Z',
  }
}
function place() {
  return {
    request: {
      productId: 'BTC-USDT', side: 'BUY' as const, orderType: 'MARKET' as const,
      baseQuantity: null, quoteNotional: asDecimalString('100'),
      limitPrice: null, stopPrice: null,
    },
    productRules: productRules(),
    clientOrderId: 'candidate-v3-001', previewHash: 'a'.repeat(64),
    accountFamilyReviewHash: 'b'.repeat(64), timeInForce: null,
    builtAt: '2026-07-17T14:05:00.000Z',
    expiresAt: '2026-07-17T14:06:00.000Z',
  }
}
function assertLocked(result: Awaited<ReturnType<typeof buildBitgetV3UnsignedPlaceCandidate>>) {
  assert.equal(result.method, 'POST_EVIDENCE_ONLY')
  assert.equal(result.transportSelected, false)
  assert.equal(result.signingMaterialPresent, false)
  assert.equal(result.providerMutationAllowed, false)
  assert.equal(result.executionAllowed, false)
  assert.equal(result.mainnetAllowed, false)
  assert.equal(result.withdrawalAllowed, false)
  assert.equal(result.automaticRetryAllowed, false)
  assert.equal(result.recoveryLookups.length, 1)
  assert.equal(result.recoveryLookups[0].method, 'GET')
  assert.equal(result.recoveryLookups[0].endpoint, BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.orderInfo)
  assert.equal(result.accountFamily, 'UTA_SPOT_V3')
  assert.equal(result.category, 'SPOT')
  assert.equal(result.warnings.includes('independent_account_family_certification_required'), true)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.unsignedBody), true)
  assert.match(result.candidateHash, /^[a-f0-9]{64}$/)
}

test('V3 market-buy remains quote-sized and omits futures, price and time-in-force fields', async () => {
  const result = await buildBitgetV3UnsignedPlaceCandidate(place())
  assertLocked(result)
  assert.equal(result.endpoint, BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.placeOrder)
  assert.deepEqual(result.unsignedBody, {
    category: 'SPOT', symbol: 'BTCUSDT', side: 'buy', orderType: 'market',
    qty: '100', clientOid: 'candidate-v3-001',
  })
  assert.deepEqual(result.recoveryLookups[0].query, { clientOid: 'candidate-v3-001' })
  const { candidateHash, ...evidence } = result
  assert.equal(await canonicalHash(evidence), candidateHash)
})

test('V3 LIMIT spot BUY uses base quantity, price and explicit time-in-force', async () => {
  const input = place()
  const result = await buildBitgetV3UnsignedPlaceCandidate({
    ...input,
    request: {
      ...input.request, orderType: 'LIMIT' as const,
      quoteNotional: null, baseQuantity: asDecimalString('0.002'),
      limitPrice: asDecimalString('50000'),
    },
    timeInForce: 'gtc',
  })
  assertLocked(result)
  assert.deepEqual(result.unsignedBody, {
    category: 'SPOT', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit',
    qty: '0.002', clientOid: 'candidate-v3-001', price: '50000',
    timeInForce: 'gtc',
  })
})

test('V3 MARKET SELL is base-sized, unlike quote-sized MARKET BUY', async () => {
  const input = place()
  const result = await buildBitgetV3UnsignedPlaceCandidate({
    ...input,
    request: {
      ...input.request, side: 'SELL' as const,
      quoteNotional: null, baseQuantity: asDecimalString('0.002'),
    },
  })
  assert.equal(result.unsignedBody.qty, '0.002')
  assert.equal(result.unsignedBody.side, 'sell')
  assertLocked(result)
})

test('rejects missing, stale, wrong-product or non-trading product rules', async () => {
  const original = place()
  for (const rules of [
    { ...productRules(), tradingEnabled: false },
    { ...productRules(), productId: 'ETH-USDT' },
    { ...productRules(), expiresAt: '2026-07-17T14:04:00.000Z' },
  ]) {
    await assert.rejects(buildBitgetV3UnsignedPlaceCandidate({ ...original, productRules: rules }))
  }
})

test('rejects wrong quantity semantics, invalid preview evidence and unsupported trigger orders', async () => {
  const input = place()
  const invalid = [
    { ...input, request: { ...input.request, baseQuantity: asDecimalString('0.002') } },
    { ...input, request: { ...input.request, quoteNotional: null } },
    { ...input, request: { ...input.request, limitPrice: asDecimalString('50000') } },
    { ...input, request: { ...input.request, stopPrice: asDecimalString('48000') } },
    { ...input, previewHash: 'not-a-hash' },
    { ...input, accountFamilyReviewHash: 'no-review' },
    { ...input, clientOrderId: 'invalid id' },
    { ...input, request: { ...input.request, productId: 'BTC-BTC' } },
    { ...input, timeInForce: 'gtc' },
  ]
  for (const value of invalid) await assert.rejects(buildBitgetV3UnsignedPlaceCandidate(value as never))
})

test('rejects LIMIT orders without a reviewed price and explicit time-in-force', async () => {
  const input = place()
  const request = {
    ...input.request, orderType: 'LIMIT' as const,
    quoteNotional: null, baseQuantity: asDecimalString('0.002'),
    limitPrice: asDecimalString('50000'),
  }
  await assert.rejects(buildBitgetV3UnsignedPlaceCandidate({ ...input, request, timeInForce: null }))
  await assert.rejects(buildBitgetV3UnsignedPlaceCandidate({
    ...input, request: { ...request, limitPrice: null }, timeInForce: 'gtc',
  }))
})

test('rejects expired, malformed, reversed or overlong candidate windows', async () => {
  const input = place()
  const windows = [
    { expiresAt: input.builtAt },
    { expiresAt: '2026-07-17T14:07:01.000Z' },
    { builtAt: 'not-a-date' },
    { builtAt: '2026-07-17T14:05:00Z' },
    { expiresAt: '2026-07-17T14:04:00.000Z' },
  ]
  for (const changes of windows) {
    await assert.rejects(buildBitgetV3UnsignedPlaceCandidate({ ...input, ...changes }))
  }
})

test('candidate evidence hashes are deterministic, identity-specific and immutable', async () => {
  const input = place()
  const first = await buildBitgetV3UnsignedPlaceCandidate(input)
  const again = await buildBitgetV3UnsignedPlaceCandidate(input)
  const different = await buildBitgetV3UnsignedPlaceCandidate({
    ...input, clientOrderId: 'candidate-v3-002',
  })
  assert.equal(first.candidateHash, again.candidateHash)
  assert.notEqual(first.candidateHash, different.candidateHash)
  assert.notEqual(first.unsignedBody.clientOid, different.unsignedBody.clientOid)
})

test('V3 cancellation candidate requires one identity, sends only category plus orderId/clientOid', async () => {
  const common = {
    productId: 'BTC-USDT', accountFamilyReviewHash: 'b'.repeat(64),
    builtAt: '2026-07-17T14:05:00.000Z', expiresAt: '2026-07-17T14:06:00.000Z',
  }
  const byId = await buildBitgetV3UnsignedCancelCandidate({
    ...common, orderId: '12345678900001', clientOrderId: null,
  })
  const byClient = await buildBitgetV3UnsignedCancelCandidate({
    ...common, orderId: null, clientOrderId: 'candidate-v3-001',
  })
  assert.equal(byId.operation, 'CANCEL')
  assert.equal(byId.endpoint, BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.cancelOrder)
  assert.deepEqual(byId.unsignedBody, { category: 'SPOT', orderId: '12345678900001' })
  assert.deepEqual(byClient.unsignedBody, { category:'SPOT', clientOid: 'candidate-v3-001' })
  assert.deepEqual(byId.recoveryLookups[0].query, { orderId: '12345678900001' })
  assert.deepEqual(byClient.recoveryLookups[0].query, { clientOid: 'candidate-v3-001' })
  assertLocked(byId as never)
  assertLocked(byClient as never)
})

test('V3 cancellation rejects missing, dual, fabricated or unsafe order identities', async () => {
  const common = {
    productId: 'BTC-USDT', accountFamilyReviewHash: 'b'.repeat(64),
    builtAt: '2026-07-17T14:05:00.000Z', expiresAt: '2026-07-17T14:06:00.000Z',
  }
  for (const identity of [
    { orderId: null, clientOrderId: null },
    { orderId: '123', clientOrderId: 'candidate-1' },
    { orderId: 'untrusted-alpha', clientOrderId: null },
    { orderId: null, clientOrderId: 'unsafe value' },
  ]) {
    await assert.rejects(buildBitgetV3UnsignedCancelCandidate({ ...common, ...identity }))
  }
})

const signingFixture = { apiKey: 'fixture-key', secretKey: 'fixture-secret', passphrase: 'fixture-pass' }

test('UTA Spot place and cancel sign the exact wire body for their pinned endpoints', async () => {
  const input = place()
  const timestamp = Date.parse(input.builtAt)
  const candidates = [
    await buildBitgetV3UnsignedPlaceCandidate(input),
    await buildBitgetV3UnsignedCancelCandidate({
      productId: input.request.productId,
      orderId: '1234567890',
      clientOrderId: null,
      accountFamilyReviewHash: input.accountFamilyReviewHash,
      builtAt: input.builtAt,
      expiresAt: input.expiresAt,
    }),
  ]
  for (const candidate of candidates) {
    const request = await prepareBitgetV3OrderWriteRequest(candidate, candidate.candidateHash, signingFixture, timestamp)
    const endpoint = candidate.operation === 'PLACE' ? '/api/v3/trade/place-order' : '/api/v3/trade/cancel-order'
    assert.equal(request.url, `https://api.bitget.com${endpoint}`)
    assert.equal(request.method, 'POST')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.get('paptrading'), null)
    assert.equal(request.headers.get('ACCESS-TIMESTAMP'), String(timestamp))
    assert.equal(request.headers.get('ACCESS-KEY'), signingFixture.apiKey)
    assert.equal(request.headers.get('ACCESS-PASSPHRASE'), signingFixture.passphrase)
    const body = await request.text()
    assert.deepEqual(JSON.parse(body), candidate.unsignedBody)
    const expected = createHmac('sha256', signingFixture.secretKey)
      .update(`${timestamp}POST${endpoint}${body}`).digest('base64')
    assert.equal(request.headers.get('ACCESS-SIGN'), expected)
  }
})

test('UTA Spot signing rejects expired, unadmitted and altered order evidence', async () => {
  const candidate = await buildBitgetV3UnsignedPlaceCandidate(place())
  const timestamp = Date.parse(candidate.builtAt)
  const sign = (order = candidate, hash = candidate.candidateHash, now = timestamp) =>
    prepareBitgetV3OrderWriteRequest(order, hash, signingFixture, now)
  await assert.rejects(sign(candidate, candidate.candidateHash, Date.parse(candidate.expiresAt)), /signing window/)
  await assert.rejects(sign(candidate, candidate.candidateHash, timestamp - 1), /signing window/)
  await assert.rejects(sign(candidate, 'c'.repeat(64)), /admitted Spot operation/)
  await assert.rejects(sign({ ...candidate, endpoint: '/api/v3/trade/cancel-order' }), /admitted Spot operation/)
  await assert.rejects(sign({ ...candidate, unsignedBody: { ...candidate.unsignedBody, qty: '999' } }), /evidence changed/)
})

test('UTA Spot order ACKs require the original order identity and uncertain results require lookup', async () => {
  const input = place()
  const opened = await buildBitgetV3UnsignedPlaceCandidate(input)
  const canceled = await buildBitgetV3UnsignedCancelCandidate({
    productId: input.request.productId,
    orderId: '1234567890',
    clientOrderId: null,
    accountFamilyReviewHash: input.accountFamilyReviewHash,
    builtAt: input.builtAt,
    expiresAt: input.expiresAt,
  })
  const data = { clientOid: input.clientOrderId, orderId: '1234567890' }
  const payload = { code: '00000', data }
  const accepted = { state: 'ACKNOWLEDGED', orderId: data.orderId }
  const unknown = { state: 'UNKNOWN_REQUIRES_LOOKUP' }
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(opened, 200, payload), accepted)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(canceled, 200, payload), accepted)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(opened, 429, payload), unknown)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(opened, 200, { ...payload, code: '40725' }), unknown)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(opened, 200, { ...payload, data: null }), unknown)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(opened, 200, {
    ...payload, data: { ...data, clientOid: 'other' },
  }), unknown)
  assert.deepEqual(interpretBitgetV3OrderWriteAcknowledgement(canceled, 200, {
    ...payload, data: { ...data, orderId: '9876543210' },
  }), unknown)
})
