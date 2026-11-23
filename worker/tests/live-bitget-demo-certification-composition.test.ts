import assert from 'node:assert/strict'
import test from 'node:test'

import { asDecimalString } from '../src/live/decimal.ts'
import type { ProductRules } from '../src/live/domain.ts'
import {
  BitgetDemoCertificationCompositionError,
  runComposedBitgetDemoPlaceCertification,
  requireReviewedDemoAccountFamily,
  type BitgetDemoCertificationCompositionDependencies,
} from '../src/live/adapters/bitget/demo-certification-composition.ts'
import {
  buildBitgetCancelOrderCandidate,
  buildBitgetPlaceOrderCandidate,
} from '../src/live/adapters/bitget/execution-candidate.ts'

const BUILT_AT = '2026-07-19T10:00:00.000Z'
const EXPIRES_AT = '2026-07-19T10:02:00.000Z'

function productRules(): ProductRules {
  return {
    productId: 'BTC-USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    baseIncrement: asDecimalString('0.00000001'),
    quoteIncrement: asDecimalString('0.01'),
    priceIncrement: asDecimalString('0.01'),
    minimumBaseSize: asDecimalString('0.0001'),
    maximumBaseSize: asDecimalString('10'),
    minimumQuoteSize: asDecimalString('5'),
    tradingEnabled: true,
    supportedOrderTypes: ['MARKET', 'LIMIT'],
    observedAt: '2026-07-19T09:59:00.000Z',
    expiresAt: EXPIRES_AT,
  }
}

function dependencies(overrides: Partial<BitgetDemoCertificationCompositionDependencies<string>> = {}) {
  const events: string[] = []
  const value: BitgetDemoCertificationCompositionDependencies<string> = {
    accountFamilyEvidenceSource: {
      async loadVerified() {
        events.push('account-family')
        return null
      },
    },
    serializer: {
      async run<T>(_accountId: string, operation: () => Promise<T>): Promise<T> {
        events.push('serializer')
        return operation()
      },
    },
    credentialLeaseSource: {
      async withLease<T>(_accountId, use): Promise<T> {
        events.push('credential')
        return use(Object.freeze({ apiKey: 'demo', secretKey: 'demo', passphrase: 'demo' }))
      },
    },
    rateLimitNamespace: {
      idFromName(name) {
        events.push(`rate-id:${name}`)
        return name
      },
      get() {
        return {
          async fetch() {
            events.push('rate-fetch')
            return new Response('{}', { status: 409 })
          },
        }
      },
    },
    recoveryLookupSource: {
      async lookup() {
        events.push('recovery')
        throw new Error('not expected')
      },
    },
    fetcher: async () => {
      events.push('fetch')
      throw new Error('not expected')
    },
    clock: {
      now: () => new Date('2026-07-19T10:00:30.000Z'),
    },
    ...overrides,
  }
  return { value, events }
}

function envThatMustNotBeRead(): { DB: D1Database } {
  return {
    DB: {
      prepare() {
        throw new Error('D1 must not be read for a rejected composition')
      },
    } as unknown as D1Database,
  }
}

const controlBinding = Object.freeze({
  bindingId: 'demo-control-binding-0001',
  assessmentId: 'assessment-demo-place-0001',
  idempotencyOperationId: 'idempotency-operation-0001',
  guardianScopes: Object.freeze([
    { scopeType: 'GLOBAL' as const, scopeKey: 'global' },
    { scopeType: 'ENVIRONMENT' as const, scopeKey: 'BITGET_DEMO' },
    { scopeType: 'EXCHANGE' as const, scopeKey: 'BITGET' },
    { scopeType: 'ACCOUNT' as const, scopeKey: 'bitget-demo-account-0001' },
    { scopeType: 'SYMBOL' as const, scopeKey: 'BTCUSDT' },
    { scopeType: 'ORDER_TYPE' as const, scopeKey: 'MARKET' },
  ]),
})

test('composition rejects cancel candidates before D1, credentials, rate authority, recovery or fetch', async () => {
  const cancel = await buildBitgetCancelOrderCandidate({
    productId: 'BTC-USDT',
    identity: { orderId: 'demo-order-0001', clientOrderId: null },
    builtAt: BUILT_AT,
    expiresAt: EXPIRES_AT,
  })
  const injected = dependencies()
  await assert.rejects(
    runComposedBitgetDemoPlaceCertification(
      envThatMustNotBeRead(),
      {
        authorizationId: 'demo-authorization-0001',
        dispatchAttemptId: 'demo-attempt-0001',
        candidate: cancel,
        controlBinding,
      },
      injected.value,
    ),
    (error: unknown) => (
      error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'PLACE_ONLY'
    ),
  )
  assert.deepEqual(injected.events, [])
})

test('composition requires every dependency before reading D1 or using credentials', async () => {
  const place = await buildBitgetPlaceOrderCandidate({
    request: {
      productId: 'BTC-USDT',
      side: 'BUY',
      orderType: 'MARKET',
      baseQuantity: null,
      quoteNotional: asDecimalString('100'),
      limitPrice: null,
      stopPrice: null,
    },
    productRules: productRules(),
    clientOrderId: 'demo-place-composition-0001',
    previewHash: '1'.repeat(64),
    force: 'gtc',
    builtAt: BUILT_AT,
    expiresAt: EXPIRES_AT,
  })
  const injected = dependencies({ serializer: null as never })
  await assert.rejects(
    runComposedBitgetDemoPlaceCertification(
      envThatMustNotBeRead(),
      {
        authorizationId: 'demo-authorization-0001',
        dispatchAttemptId: 'demo-attempt-0001',
        candidate: place,
        controlBinding,
      },
      injected.value,
    ),
    (error: unknown) => (
      error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'SERIALIZER_REQUIRED'
    ),
  )
  assert.deepEqual(injected.events, [])
})

test('composition rejects an invalid injected clock before any authority is touched', async () => {
  const place = await buildBitgetPlaceOrderCandidate({
    request: {
      productId: 'BTC-USDT',
      side: 'BUY',
      orderType: 'MARKET',
      baseQuantity: null,
      quoteNotional: asDecimalString('100'),
      limitPrice: null,
      stopPrice: null,
    },
    productRules: productRules(),
    clientOrderId: 'demo-place-composition-0002',
    previewHash: '2'.repeat(64),
    force: 'gtc',
    builtAt: BUILT_AT,
    expiresAt: EXPIRES_AT,
  })
  const injected = dependencies({ clock: { now: () => new Date(Number.NaN) } })
  await assert.rejects(
    runComposedBitgetDemoPlaceCertification(
      envThatMustNotBeRead(),
      {
        authorizationId: 'demo-authorization-0001',
        dispatchAttemptId: 'demo-attempt-0001',
        candidate: place,
        controlBinding,
      },
      injected.value,
    ),
    (error: unknown) => (
      error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'CLOCK_INVALID'
    ),
  )
  assert.deepEqual(injected.events, [])
})

async function familyReviewCandidate() {
  return buildBitgetPlaceOrderCandidate({
    request: {
      productId: 'BTC-USDT',
      side: 'BUY',
      orderType: 'MARKET',
      baseQuantity: null,
      quoteNotional: asDecimalString('100'),
      limitPrice: null,
      stopPrice: null,
    },
    productRules: productRules(),
    clientOrderId: 'demo-family-gate-0001',
    previewHash: 'a'.repeat(64),
    force: 'gtc',
    builtAt: BUILT_AT,
    expiresAt: EXPIRES_AT,
  })
}

function mockFamilyEvidence(overrides: Record<string, unknown> = {}) {
  return {
    exchangeAccountId: 'bitget-demo-account-0001',
    declaredFamily: 'CLASSIC_SPOT_V2' as const,
    observedFamily: 'CLASSIC_SPOT_V2' as const,
    observedAt: '2026-07-19T10:00:29.000Z',
    reviewedContractRef: 'demo-family-review-1',
    externallyVerifiedFamily: true,
    externalEvidenceHash: 'c'.repeat(64),
    ...overrides,
  }
}

test('matching independently supplied Classic Spot fixture passes only the source-only family boundary', async () => {
  const candidate = await familyReviewCandidate()
  const observed: Array<Record<string, string>> = []
  await requireReviewedDemoAccountFamily(candidate, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z', {
    async loadVerified(request) {
      observed.push(request)
      return mockFamilyEvidence()
    },
  })
  assert.deepEqual(observed, [{
    exchangeAccountId: 'bitget-demo-account-0001',
    candidateHash: candidate.candidateHash,
    evaluatedAt: '2026-07-19T10:00:30.000Z',
  }])
})

test('incompatible family and stale or mismatched evidence block before signing or any D1 write', async () => {
  const candidate = await familyReviewCandidate()
  for (const override of [
    { declaredFamily: 'UTA_SPOT_V3', observedFamily: 'UTA_SPOT_V3' },
    { declaredFamily: 'UNKNOWN', observedFamily: 'UNKNOWN' },
    { exchangeAccountId: 'wrong-account' },
    { observedAt: '2026-07-19T09:40:00.000Z' },
    { externalEvidenceHash: 'not-a-hash' },
    { externallyVerifiedFamily: false },
  ]) {
    await assert.rejects(
      requireReviewedDemoAccountFamily(
        candidate, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z',
        { async loadVerified() { return mockFamilyEvidence(override) as never } },
      ),
      (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
        && error.code === 'ACCOUNT_FAMILY_REVIEW_BLOCKED',
    )
  }
})

test('missing family evidence, missing source and source exception always fail closed', async () => {
  const candidate = await familyReviewCandidate()
  await assert.rejects(
    requireReviewedDemoAccountFamily(candidate, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z',
      { async loadVerified() { return null } }),
    (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'ACCOUNT_FAMILY_REVIEW_BLOCKED',
  )
  await assert.rejects(
    requireReviewedDemoAccountFamily(candidate, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z',
      null as never),
    (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'ACCOUNT_FAMILY_SOURCE_REQUIRED',
  )
  await assert.rejects(
    requireReviewedDemoAccountFamily(candidate, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z',
      { async loadVerified() { throw new Error('private upstream secret must not be exposed') } }),
    (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'ACCOUNT_FAMILY_EVIDENCE_UNAVAILABLE'
      && !error.message.includes('private upstream secret'),
  )
})

test('tampered candidate cannot inherit an otherwise compatible account-family fixture', async () => {
  const candidate = await familyReviewCandidate()
  await assert.rejects(
    requireReviewedDemoAccountFamily({
      ...candidate,
      unsignedBody: { ...candidate.unsignedBody, size: '1000000' },
    }, 'bitget-demo-account-0001', '2026-07-19T10:00:30.000Z',
    { async loadVerified() { return mockFamilyEvidence() } }),
    (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'ACCOUNT_FAMILY_REVIEW_BLOCKED',
  )
})

test('composition rejects missing family evidence-source before D1, credentials or network', async () => {
  const candidate = await familyReviewCandidate()
  const injected = dependencies({ accountFamilyEvidenceSource: null as never })
  await assert.rejects(
    runComposedBitgetDemoPlaceCertification(envThatMustNotBeRead(), {
      authorizationId: 'demo-auth-gate-001', dispatchAttemptId: 'demo-attempt-gate-001',
      candidate, controlBinding,
    }, injected.value),
    (error: unknown) => error instanceof BitgetDemoCertificationCompositionError
      && error.code === 'ACCOUNT_FAMILY_SOURCE_REQUIRED',
  )
  assert.deepEqual(injected.events, [])
})
