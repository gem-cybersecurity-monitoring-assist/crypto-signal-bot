import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runBitgetV3ReadOnlyCertification,
  type BitgetV3ReadOnlyCertificationClient,
} from '../src/live/adapters/bitget/v3/v3-certification.ts'
import { assertBitgetV3ReadOnlyAuthorities } from '../src/live/adapters/bitget/v3/read-only-client-v3.ts'
import type { BitgetV3ReadOnlyEndpoint } from '../src/live/adapters/bitget/v3/read-only-client-v3.ts'

const INFO_FIXTURE = {
  code: '00000', data: { userId: '6682030769', permType: 'read-only', permissions: ['uta_trade', 'uta_mgt'] },
}
const ORDER_HISTORY_FIXTURE = {
  code: '00000', data: { list: [{ category: 'SPOT', orderId: 'test-order-1', symbol: 'BTCUSDT' }] },
}
const SETTINGS_FIXTURE = {
  code: '00000',
  msg: 'success',
  requestTime: 1746687063471,
  data: {
    uid: '6682030769',
    accountMode: 'hybrid',
    accountLevel: 'basic',
    assetMode: 'multi_assets',
    holdMode: 'one_way_mode',
  },
}

const ASSETS_FIXTURE = {
  code: '00000',
  msg: 'success',
  requestTime: 1746687063471,
  data: {
    accountEquity: '0.33',
    usdtEquity: '0.33',
    btcEquity: '0.000003',
    unrealisedPnl: '0',
    usdtUnrealisedPnl: '0',
    btcUnrealizedPnl: '0',
    effEquity: '0.33',
    mmr: '0',
    imr: '0',
    mgnRatio: '0',
    positionMgnRatio: '0',
    positionValue: '0',
    leverage: '1',
    assets: [
      {
        coin: 'BTC',
        equity: '0.000003',
        usdValue: '0.33',
        balance: '0.000003',
        available: '0.000003',
        debt: '0',
        locked: '0',
        bonus: '0',
      },
    ],
  },
}

const POSITIONS_FIXTURE = {
  code: '00000',
  msg: 'success',
  requestTime: 1753103840140,
  data: {
    list: [
      {
        category: 'USDT-FUTURES',
        symbol: 'BTCUSDT',
        marginCoin: 'USDT',
        holdMode: 'hedge_mode',
        posSide: 'long',
        marginMode: 'crossed',
        positionBalance: '100',
        available: '0.001',
        frozen: '0',
        total: '0.001',
        leverage: '3',
        curRealisedPnl: '0',
        avgPrice: '108674',
        positionStatus: 'normal',
        unrealisedPnl: '1.5',
        liquidationPrice: '43099.9',
        mmr: '0.015',
        profitRate: '0.01',
        markPrice: '118097',
        breakEvenPrice: '109208.6',
        totalFunding: '0',
        openFeeTotal: '0',
        closeFeeTotal: '0',
        cashDividend: '0',
        createdTime: '1736378720620',
        updatedTime: '1753102803148',
      },
    ],
  },
}

const INSTRUMENTS_FIXTURE = {
  code: '00000',
  msg: 'success',
  requestTime: 1734766810918,
  data: [
    {
      symbol: 'BTCUSDT',
      category: 'SPOT',
      baseCoin: 'BTC',
      quoteCoin: 'USDT',
      status: 'online',
      pricePrecision: '2',
      quantityPrecision: '6',
      quotePrecision: '6',
      minOrderQty: '0.00001',
      maxOrderQty: '',
      minOrderAmount: '1',
    },
  ],
}

function mockClient(overrides: Partial<Record<string, unknown>> = {}): BitgetV3ReadOnlyCertificationClient {
  return {
    async verifyReadOnlyPermissions() {
      return assertBitgetV3ReadOnlyAuthorities(
        overrides.settings ?? SETTINGS_FIXTURE,
        overrides.accountInfo ?? INFO_FIXTURE,
      )
    },
    async getAccountAssets() {
      return overrides.assets ?? ASSETS_FIXTURE
    },
    async getCurrentPositions() {
      return overrides.positions ?? POSITIONS_FIXTURE
    },
    async getInstruments() {
      return overrides.instruments ?? INSTRUMENTS_FIXTURE
    },
    async getOrderHistory() {
      return overrides.orderHistory ?? ORDER_HISTORY_FIXTURE
    },
    async request(_endpoint: BitgetV3ReadOnlyEndpoint) {
      throw new Error('not used by mock client')
    },
  }
}

function baseInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: 'v3-cert-mock-001',
    exchangeAccountId: 'BITGET:UTA:6682030769',
    productId: 'BTC-USDT',
    observedAt: '2026-10-05T10:30:00.000Z',
    productExpiresAt: '2026-10-06T10:30:00.000Z',
    evaluatedAt: '2026-10-05T10:35:00.000Z',
    client: mockClient(overrides),
  }
}

test('V3 certification passes against doc-shaped mock fixtures', async () => {
  const result = await runBitgetV3ReadOnlyCertification(baseInput())
  assert.equal(result.status, 'PASSED')
  assert.equal(result.provider, 'BITGET')
  assert.equal(result.apiVersion, 'V3')
  assert.deepEqual(
    result.checks.map((check) => check.name),
    [
      'READ_ONLY_PERMISSIONS',
      'ACCOUNT_ASSETS_CONTRACT',
      'POSITION_CONTRACT',
      'INSTRUMENTS_CONTRACT',
      'ORDER_HISTORY_CONTRACT',
      'READ_ONLY_ENFORCEMENT',
    ],
  )
  for (const check of result.checks) {
    assert.equal(check.status, 'PASS')
    assert.match(check.evidenceHash, /^[a-f0-9]{64}$/)
    assert.ok(check.latencyMs >= 0)
  }
  assert.equal(result.positionCount, 1)
  assert.equal(result.productCount, 1)
  assert.ok(result.unifiedAccountSnapshot)
  assert.equal(result.unifiedAccountSnapshot?.accountEquityUsd, '0.33')
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/)
})

test('V3 certification never certifies for live execution', async () => {
  const result = await runBitgetV3ReadOnlyCertification(baseInput())
  assert.equal(result.certifiedForLive, false)
  assert.equal(result.providerMutationAllowed, false)
  assert.equal(result.automaticRetryAllowed, false)
  assert.equal(result.transferAllowed, false)
  assert.equal(result.withdrawalAllowed, false)
  assert.equal(result.executionAllowed, false)
  assert.equal(result.credentialsPersisted, false)
})

test('V3 certification fails closed on malformed assets', async () => {
  const result = await runBitgetV3ReadOnlyCertification(
    baseInput({ assets: { code: '00000', data: { assets: 'nope' } } }),
  )
  assert.equal(result.status, 'FAILED')
  const assetsCheck = result.checks.find((check) => check.name === 'ACCOUNT_ASSETS_CONTRACT')
  assert.equal(assetsCheck?.status, 'FAIL')
  assert.ok(assetsCheck?.reason)
})

test('V3 certification fails closed on non-unified account mode', async () => {
  const result = await runBitgetV3ReadOnlyCertification(
    baseInput({
      settings: { code: '00000', data: { uid: 'user-1', accountMode: 'classic' } },
    }),
  )
  assert.equal(result.status, 'FAILED')
  const permissionsCheck = result.checks.find(
    (check) => check.name === 'READ_ONLY_PERMISSIONS',
  )
  assert.equal(permissionsCheck?.status, 'FAIL')
})

test('V3 certification requires runId and exchangeAccountId', async () => {
  await assert.rejects(
    runBitgetV3ReadOnlyCertification({ ...baseInput(), runId: '  ' }),
    /runId is required/,
  )
})

test('invalid UTA API permissions prevent every account-data call, including concurrent reads', async () => {
  const called: string[] = []
  const healthy = mockClient()
  const client: BitgetV3ReadOnlyCertificationClient = {
    ...healthy,
    async verifyReadOnlyPermissions() {
      called.push('verify')
      await Promise.resolve()
      throw new Error('invalid or write-enabled API key')
    },
    async getAccountAssets() { called.push('assets'); return ASSETS_FIXTURE },
    async getCurrentPositions() { called.push('positions'); return POSITIONS_FIXTURE },
    async getInstruments() { called.push('instruments'); return INSTRUMENTS_FIXTURE },
    async getOrderHistory() { called.push('history'); return ORDER_HISTORY_FIXTURE },
  }
  const result = await runBitgetV3ReadOnlyCertification({ ...baseInput(), client })
  assert.deepEqual(called, ['verify'])
  assert.equal(result.status, 'FAILED')
  assert.equal(result.checks[0].status, 'FAIL')
  assert.deepEqual(result.checks.slice(1).map((check) => check.status), Array(5).fill('BLOCKED'))
  assert.ok(result.checks.slice(1).every((check) =>
    check.reason === 'READ_ONLY_PERMISSIONS_NOT_VERIFIED'
      && check.latencyMs === 0
      && /^[a-f0-9]{64}$/.test(check.evidenceHash),
  ))
  assert.equal(result.unifiedAccountSnapshot, null)
  assert.equal(result.positionCount, 0)
  assert.equal(result.productCount, 0)
  assert.equal(result.certifiedForLive, false)
  assert.equal(result.executionAllowed, false)
})

test('fabricated client permissions fail closed before any balance or order-history read', async () => {
  for (const bad of [
    { userId: '', readOnly: true, permissionsVerified: true, accountMode: 'hybrid', authorities: ['uta_trade'] },
    { userId: 'some-id', readOnly: false, permissionsVerified: true, accountMode: 'hybrid', authorities: ['uta_trade'] },
    { userId: 'some-id', readOnly: true, permissionsVerified: true, accountMode: 'hybrid', authorities: ['uta_trade', 'withdraw'] },
    { userId: 'some-id', readOnly: true, permissionsVerified: false, accountMode: 'unified', authorities: ['uta_trade'] },
    { userId: 'some-id', readOnly: true, permissionsVerified: true, accountMode: 'hybrid', authorities: [] },
  ]) {
    let reads = 0
    const client: BitgetV3ReadOnlyCertificationClient = {
      ...mockClient(),
      async verifyReadOnlyPermissions() { return bad as never },
      async getAccountAssets() { reads++; return ASSETS_FIXTURE },
      async getCurrentPositions() { reads++; return POSITIONS_FIXTURE },
      async getInstruments() { reads++; return INSTRUMENTS_FIXTURE },
      async getOrderHistory() { reads++; return ORDER_HISTORY_FIXTURE },
    }
    const result = await runBitgetV3ReadOnlyCertification({ ...baseInput(), client })
    assert.equal(reads, 0)
    assert.equal(result.status, 'FAILED')
    assert.equal(result.checks.filter(c => c.status === 'BLOCKED').length, 5)
  }
})

test('valid permission verification precedes all UTA account reads', async () => {
  const called: string[] = []
  const client: BitgetV3ReadOnlyCertificationClient = {
    ...mockClient(),
    async verifyReadOnlyPermissions() {
      called.push('verify')
      await Promise.resolve()
      return assertBitgetV3ReadOnlyAuthorities(SETTINGS_FIXTURE, INFO_FIXTURE)
    },
    async getAccountAssets() { called.push('assets'); return ASSETS_FIXTURE },
    async getCurrentPositions() { called.push('positions'); return POSITIONS_FIXTURE },
    async getInstruments() { called.push('instruments'); return INSTRUMENTS_FIXTURE },
    async getOrderHistory() { called.push('history'); return ORDER_HISTORY_FIXTURE },
  }
  const result = await runBitgetV3ReadOnlyCertification({ ...baseInput(), client })
  assert.equal(result.status, 'PASSED')
  assert.equal(called[0], 'verify')
  assert.deepEqual(new Set(called.slice(1)), new Set(['assets','positions','instruments','history']))
})

test('UTA certification requires the requested active Spot product and scopes order history to it', async () => {
  const observed: string[] = []
  const client: BitgetV3ReadOnlyCertificationClient = {
    ...mockClient(),
    async getInstruments(category, symbol) {
      observed.push(`instruments:${category}:${String(symbol)}`)
      return INSTRUMENTS_FIXTURE
    },
    async getOrderHistory(symbol) {
      observed.push(`history:${String(symbol)}`)
      return ORDER_HISTORY_FIXTURE
    },
  }
  const result = await runBitgetV3ReadOnlyCertification({ ...baseInput(), client })
  assert.equal(result.status, 'PASSED')
  assert.deepEqual(new Set(observed), new Set(['instruments:SPOT:BTCUSDT', 'history:BTCUSDT']))
})

test('UTA certification refuses wrong, missing, inactive, or non-Spot instruments', async () => {
  for (const instrument of [
    null,
    { ...INSTRUMENTS_FIXTURE.data[0], symbol: 'ETHUSDT', baseCoin: 'ETH' },
    { ...INSTRUMENTS_FIXTURE.data[0], status: 'offline' },
    { ...INSTRUMENTS_FIXTURE.data[0], category: 'MARGIN' },
  ]) {
    const data = instrument ? [instrument] : []
    const result = await runBitgetV3ReadOnlyCertification(baseInput({
      instruments: { code: '00000', data },
    }))
    assert.equal(result.status, 'FAILED')
    assert.equal(result.checks.find(c => c.name === 'INSTRUMENTS_CONTRACT')?.status, 'FAIL')
    assert.equal(result.certifiedForLive, false)
  }
})

test('UTA certification refuses cross-symbol order-history rows but allows an empty valid list', async () => {
  const wrong = await runBitgetV3ReadOnlyCertification(baseInput({
    orderHistory: { code: '00000', data: { list: [{ orderId: 'test-order-2', category: 'SPOT', symbol: 'ETHUSDT' }] } },
  }))
  assert.equal(wrong.status, 'FAILED')
  assert.equal(wrong.checks.find(c => c.name === 'ORDER_HISTORY_CONTRACT')?.status, 'FAIL')
  const empty = await runBitgetV3ReadOnlyCertification(baseInput({
    orderHistory: { code: '00000', data: { list: [] } },
  }))
  assert.equal(empty.status, 'PASSED')
})

test('UTA certification rejects an invalid or self-paired product before provider reads', async () => {
  let reads = 0
  const client: BitgetV3ReadOnlyCertificationClient = {
    ...mockClient(),
    async verifyReadOnlyPermissions() { reads++; return assertBitgetV3ReadOnlyAuthorities(SETTINGS_FIXTURE, INFO_FIXTURE) },
  }
  for (const productId of [' ', 'BTCBTC', 'BTC-BTC', 'btc-usdt', 'BTC-USD-T']) {
    await assert.rejects(
      runBitgetV3ReadOnlyCertification({ ...baseInput(), client, productId }),
      /productId/,
    )
  }
  assert.equal(reads, 0)
})
