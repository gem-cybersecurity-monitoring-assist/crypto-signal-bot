import assert from 'node:assert/strict'
import test from 'node:test'
import { routePrivateBitgetCertification, type PrivateCertificationEnv } from '../src/live/bitget-private-certification-service.ts'
import { canonicalHash } from '../src/live/canonical-json.ts'
import { BITGET_V3_ENDPOINTS } from '../src/live/adapters/bitget/v3/endpoints-v3.ts'

const TOKEN = 'internal-uta-certification-token-123456789'
const AT = Date.parse('2026-11-23T12:50:00.000Z')
const UID = 'test-uta-identity-123'
type FixtureOptions = { permType?: string; permissions?: string[]; settingsMode?: string; infoUserId?: string; history?: unknown; apiCode?: string; responseTime?: unknown; orderInfo?: unknown }
function fixture(options: FixtureOptions = {}) {
  const reads = { key: 0, secret: 0, passphrase: 0 }
  const paths: string[] = [], methods: string[] = []
  const env: PrivateCertificationEnv = {
    CERTIFICATION_RUNNER_TOKEN: TOKEN,
    BITGET_CERT_API_KEY: { async get() { reads.key++; return 'TEST_ONLY_KEY' } },
    BITGET_CERT_API_SECRET: { async get() { reads.secret++; return 'TEST_ONLY_SECRET' } },
    BITGET_CERT_API_PASSPHRASE: { async get() { reads.passphrase++; return 'TEST_ONLY_PASSPHRASE' } },
  }
  const dependencies = {
    clock: () => AT, timeoutMs: 1000, secretTimeoutMs: 1000, bodyTimeoutMs: 1000,
    async fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const path = new URL(String(input)).pathname
      paths.push(path); methods.push(String(init?.method ?? ''))
      let data: unknown
      if (path === BITGET_V3_ENDPOINTS.accountInfo) {
        data = { userId: options.infoUserId ?? UID, permType: options.permType ?? 'read-only',
          permissions: options.permissions ?? ['uta_trade', 'uta_mgt'] }
      } else if (path === BITGET_V3_ENDPOINTS.accountSettings) {
        data = { uid: UID, accountMode: options.settingsMode ?? 'hybrid',
          assetMode: 'multi_assets', holdMode: 'one_way_mode' }
      } else if (path === BITGET_V3_ENDPOINTS.accountAssets) {
        data = { accountEquity: '0.33', effEquity: '0.33', assets: [
          { coin: 'BTC', available: '0.000003', locked: '0' },
        ] }
      } else if (path === BITGET_V3_ENDPOINTS.currentPositions) {
        data = { list: [] }
      } else if (path === BITGET_V3_ENDPOINTS.instruments) {
        data = [{ symbol: 'BTCUSDT', category: 'SPOT', baseCoin: 'BTC', quoteCoin: 'USDT',
          status: 'online', pricePrecision: '2', quantityPrecision: '6', quotePrecision: '6',
          minOrderQty: '0.00001', minOrderAmount: '1' }]
      } else if (path === BITGET_V3_ENDPOINTS.orderHistory) {
        data = options.history ?? { list: [{ orderId: 'fake-history-1', category: 'SPOT', symbol: 'BTCUSDT' }] }
      } else if (path === BITGET_V3_ENDPOINTS.orderInfo) {
        data = options.orderInfo ?? {
          category:'SPOT', symbol:'BTCUSDT',
          orderId:'1234567890123', clientOid:'candidate-v3-001',
          side:'buy', orderType:'market', orderStatus:'filled',
          qty:'0', amount:'100', cumExecQty:'0.002', cumExecValue:'100',
        }
      } else throw new Error('unexpected request path')
      return Response.json({ code: options.apiCode ?? '00000', requestTime: options.responseTime === undefined ? AT : options.responseTime, data })
    },
  }
  return { env, dependencies, reads, paths, methods }
}
function request(route: 'inspect'|'certify'|'order-info', body?: unknown, token = TOKEN) {
  return new Request('https://private-service/internal/bitget/uta/' + route, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function command(uid = UID) {
  return { runId: 'uta-readonly-test-1', exchangeAccountId: 'test-uta-account-1',
    productId: 'BTC-USDT', expectedAccountRefHash: await canonicalHash(uid) }
}
async function body(response: Response): Promise<Record<string, any>> { return response.json() }
function assertRedacted(value: unknown) {
  const json = JSON.stringify(value)
  for (const secret of ['TEST_ONLY_KEY', 'TEST_ONLY_SECRET', 'TEST_ONLY_PASSPHRASE',
    TOKEN, UID, 'fake-history-1', '0.000003']) assert.equal(json.includes(secret), false, secret)
}

test('UTA inspection proves read-only key permissions and account model without leaking identity or credentials', async () => {
  const f = fixture()
  const response = await routePrivateBitgetCertification(request('inspect'), f.env, f.dependencies)
  const result = await body(response)
  assert.equal(response.status, 200)
  assert.equal(result.contract, 'BITGET_UTA_V3')
  assert.equal(result.accountModelVerified, true)
  assert.equal(result.accountModel, 'UTA_HYBRID')
  assert.equal(result.permissionsVerified, true)
  assert.equal(result.accountRefHash, await canonicalHash(UID))
  assert.equal(result.executionAllowed, false)
  assert.equal(result.certifiedForLive, false)
  assert.deepEqual(f.reads, { key:1, secret:1, passphrase:1 })
  assert.deepEqual(f.paths, [BITGET_V3_ENDPOINTS.accountInfo, BITGET_V3_ENDPOINTS.accountSettings])
  assert.ok(f.methods.every(m => m === 'GET'))
  assertRedacted(result)
})

test('UTA certification reads balances and spot order-history contracts without exposing account data or authorizing live', async () => {
  const f = fixture()
  const response = await routePrivateBitgetCertification(
    request('certify', await command()), f.env, f.dependencies)
  const result = await body(response)
  assert.equal(response.status, 200)
  assert.equal(result.contract, 'BITGET_UTA_V3')
  assert.equal(result.accountModel, 'UTA_HYBRID')
  assert.equal(result.result.apiVersion, 'V3')
  assert.equal(result.result.status, 'PASSED')
  assert.equal(result.result.checks.length, 6)
  assert.ok(result.result.checks.every((c: any) => c.status === 'PASS'))
  assert.ok(f.paths.includes(BITGET_V3_ENDPOINTS.accountAssets))
  assert.ok(f.paths.includes(BITGET_V3_ENDPOINTS.orderHistory))
  assert.ok(f.methods.every(m => m === 'GET'))
  assert.deepEqual(f.reads, { key:1, secret:1, passphrase:1 })
  assert.equal(result.result.executionAllowed, false)
  assert.equal(result.result.certifiedForLive, false)
  assert.equal(result.result.withdrawalAllowed, false)
  assert.equal('unifiedAccountSnapshot' in result.result, false)
  assertRedacted(result)
})

test('UTA wrong account hash is stopped before assets/order history calls', async () => {
  const f = fixture()
  const result = await routePrivateBitgetCertification(
    request('certify', await command('another-account')), f.env, f.dependencies)
  assert.equal(result.status, 403)
  assert.deepEqual(f.paths, [BITGET_V3_ENDPOINTS.accountInfo, BITGET_V3_ENDPOINTS.accountSettings])
})

test('UTA missing/writable/withdrawal/unknown authorities, mismatched UID and wrong account mode fail closed', async () => {
  const bad: FixtureOptions[] = [
    { permType: 'read-and-write' }, { permissions: ['uta_trade', 'withdraw'] },
    { permissions: ['uta_trade', 'unknown_write'] }, { permissions: ['uta_mgt'] },
    { infoUserId: 'wrong-uid' }, { settingsMode: 'classic' },
    { apiCode: '' },
  ]
  for (const options of bad) {
    const f = fixture(options)
    const response = await routePrivateBitgetCertification(request('inspect'), f.env, f.dependencies)
    assert.equal(response.status, 503)
    assert.ok(f.paths.length <= 2)
    assert.deepEqual(f.reads, { key:1, secret:1, passphrase:1 })
    assertRedacted(await body(response))
  }
})

test('UTA certification malformed order-history is reported as failed without leaking provider rows', async () => {
  const f = fixture({ history: { list: [{ category: 'MARGIN', orderId: 'secret-order' }] } })
  const response = await routePrivateBitgetCertification(
    request('certify', await command()), f.env, f.dependencies)
  const result = await body(response)
  assert.equal(response.status, 200)
  assert.equal(result.result.status, 'FAILED')
  assert.equal(result.result.checks.find((c: any) => c.name === 'ORDER_HISTORY_CONTRACT').status, 'FAIL')
  assertRedacted(result)
})

test('UTA unauthorized and unsafe routes fail before credential read or provider API call', async () => {
  for (const path of ['inspect','certify'] as const) {
    const f = fixture()
    const response = await routePrivateBitgetCertification(request(path, path === 'certify' ? await command() : undefined, 'WRONG-TOKEN'), f.env, f.dependencies)
    assert.equal(response.status, 401)
    assert.deepEqual(f.reads, {key:0, secret:0, passphrase:0})
    assert.deepEqual(f.paths, [])
  }
  const f = fixture()
  const response = await routePrivateBitgetCertification(
    new Request('https://private-service/internal/bitget/uta/place-order', {method:'POST'}), f.env, f.dependencies)
  assert.equal(response.status, 404)
  assert.equal(f.paths.length, 0)
})

test('private inspection and certification distinguish the documented UTA hybrid and unified modes', async () => {
  for (const mode of ['hybrid', 'unified'] as const) {
    for (const permType of ['readonly', 'read-only'] as const) {
      const f = fixture({ settingsMode: mode, permType })
      const inspection = await routePrivateBitgetCertification(
        request('inspect'), f.env, f.dependencies)
      const inspectionResult = await body(inspection)
      assert.equal(inspection.status, 200)
      assert.equal(inspectionResult.accountModel, mode === 'hybrid' ? 'UTA_HYBRID' : 'UTA_UNIFIED')
      assert.equal(inspectionResult.permissionsVerified, true)
      assert.equal(inspectionResult.executionAllowed, false)
      assertRedacted(inspectionResult)
      const certification = await routePrivateBitgetCertification(
        request('certify', await command()), f.env, f.dependencies)
      const certificationResult = await body(certification)
      assert.equal(certification.status, 200)
      assert.equal(certificationResult.result.status, 'PASSED')
      assert.equal(certificationResult.accountModel, mode === 'hybrid' ? 'UTA_HYBRID' : 'UTA_UNIFIED')
      assert.equal(certificationResult.result.certifiedForLive, false)
      assert.equal(certificationResult.withdrawalAllowed, false)
      assertRedacted(certificationResult)
    }
  }
})

test('private UTA inspection blocks stale or missing response timestamps before secondary read', async () => {
  for (const responseTime of [null, '1760000000000', AT - 120_001, AT + 30_001]) {
    const f = fixture({ responseTime })
    const response = await routePrivateBitgetCertification(request('inspect'), f.env, f.dependencies)
    assert.equal(response.status, 503)
    assert.deepEqual(f.paths, [BITGET_V3_ENDPOINTS.accountInfo])
    const redacted = await body(response)
    assert.equal(redacted.code, 'CERTIFICATION_PROVIDER_UNAVAILABLE')
    assert.equal(redacted.certifiedForLive, false)
    assert.equal(redacted.executionAllowed, false)
    assertRedacted(redacted)
  }
})

test('private UTA recovery returns only hashed read-only order evidence for exact account/product', async () => {
  const f = fixture()
  const response = await routePrivateBitgetCertification(
    request('order-info',{...await command(),orderIdentity:{clientOid:'candidate-v3-001'}}),
    f.env,f.dependencies)
  const output=await body(response)
  assert.equal(response.status,200)
  assert.equal(output.code,'CERTIFICATION_ORDER_INFO_REVIEWED')
  assert.equal(output.contract,'BITGET_UTA_V3')
  assert.equal(output.review.status,'filled')
  assert.equal(output.review.terminalProviderStatus,true)
  assert.match(output.review.responseHash,/^[a-f0-9]{64}$/)
  assert.match(output.review.observedIdentityHash,/^[a-f0-9]{64}$/)
  assert.equal(output.review.ledgerSettlementConfirmed,false)
  assert.equal(output.review.automaticRetryAllowed,false)
  assert.equal(output.review.providerMutationAllowed,false)
  assert.equal(output.review.liveExecutionAllowed,false)
  assert.equal(output.review.independentReconciliationRequired,true)
  assert.equal(output.certifiedForLive,false)
  assert.equal(output.executionAllowed,false)
  assert.ok(f.paths.includes(BITGET_V3_ENDPOINTS.orderInfo))
  assert.deepEqual(f.paths,[
    BITGET_V3_ENDPOINTS.accountInfo, BITGET_V3_ENDPOINTS.accountSettings,
    BITGET_V3_ENDPOINTS.orderInfo,
  ])
  assert.ok(f.methods.every(method=>method==='GET'))
  assert.deepEqual(f.reads,{key:1,secret:1,passphrase:1})
  const json=JSON.stringify(output)
  for(const leaked of ['1234567890123','candidate-v3-001','TEST_ONLY_KEY','TEST_ONLY_SECRET']) {
    assert.equal(json.includes(leaked),false)
  }
  assertRedacted(output)
})

test('private UTA recovery rejects account-hash mismatch before order-info query', async () => {
  const f=fixture()
  const response=await routePrivateBitgetCertification(
    request('order-info',{...await command('other-owner'),orderIdentity:{clientOid:'candidate-v3-001'}}),
    f.env,f.dependencies)
  assert.equal(response.status,403)
  assert.equal(f.paths.includes(BITGET_V3_ENDPOINTS.orderInfo),false)
  assert.deepEqual(f.paths,[BITGET_V3_ENDPOINTS.accountInfo,BITGET_V3_ENDPOINTS.accountSettings])
})

test('private UTA recovery rejects malformed command before reading credentials', async()=>{
  for(const identity of [null,{},[],{orderId:'12',clientOid:'candidate-v3-001'},
    {clientOid:'x'.repeat(33)},{orderId:'abcdef'},{clientOid:'valid',category:'MARGIN'}]) {
    const f=fixture()
    const response=await routePrivateBitgetCertification(
      request('order-info',{...await command(),orderIdentity:identity}),
      f.env,f.dependencies)
    assert.equal(response.status,503)
    assert.equal((await body(response)).code,'CERTIFICATION_COMMAND_INVALID')
    assert.deepEqual(f.paths,[])
    assert.deepEqual(f.reads,{key:0,secret:0,passphrase:0})
  }
})

test('private UTA recovery refuses mismatched order status, market and identity without leaking response', async()=>{
  const good={category:'SPOT',symbol:'BTCUSDT',orderId:'1234567890123',
    clientOid:'candidate-v3-001',side:'buy',orderType:'market',orderStatus:'filled'}
  for(const override of [
    {category:'MARGIN'},{symbol:'ETHUSDT'},
    {clientOid:'another-client'},{orderStatus:'unknown'}, {side:'hold'}
  ]) {
    const f=fixture({orderInfo:{...good,...override}})
    const response=await routePrivateBitgetCertification(
      request('order-info',{...await command(),orderIdentity:{clientOid:'candidate-v3-001'}}),
      f.env,f.dependencies)
    assert.equal(response.status,503)
    const output=await body(response)
    assert.equal(output.code,'CERTIFICATION_PROVIDER_UNAVAILABLE')
    assert.equal(JSON.stringify(output).includes('another-client'),false)
    assert.equal(output.automaticRetryAllowed,false)
    assertRedacted(output)
    assert.ok(f.paths.includes(BITGET_V3_ENDPOINTS.orderInfo))
  }
})

test('private UTA recovery declines untrusted invocation token before secrets or network',async()=>{
  const f=fixture()
  const response=await routePrivateBitgetCertification(
    request('order-info',{...await command(),orderIdentity:{clientOid:'candidate-v3-001'}},'invalid-token'),
    f.env,f.dependencies)
  assert.equal(response.status,401)
  assert.deepEqual(f.paths,[])
  assert.deepEqual(f.reads,{key:0,secret:0,passphrase:0})
})

test('private UTA recovery by provider orderId refuses mismatched returned orderId',async()=>{
  const f=fixture({orderInfo:{category:'SPOT',symbol:'BTCUSDT',orderId:'9999999999',
    clientOid:'candidate-v3-001',side:'buy',orderType:'market',orderStatus:'filled'}})
  const response=await routePrivateBitgetCertification(
    request('order-info',{...await command(),orderIdentity:{orderId:'1234567890123'}}),
    f.env,f.dependencies)
  assert.equal(response.status,503)
  assert.equal((await body(response)).code,'CERTIFICATION_PROVIDER_UNAVAILABLE')
  assert.ok(f.paths.includes(BITGET_V3_ENDPOINTS.orderInfo))
})
