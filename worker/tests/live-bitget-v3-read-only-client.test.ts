import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BitgetV3ReadOnlyClient,
  BitgetV3ReadOnlyClientError,
  assertBitgetV3ReadOnlyAuthorities,
} from '../src/live/adapters/bitget/v3/read-only-client-v3.ts'
import { BITGET_V3_ENDPOINTS } from '../src/live/adapters/bitget/v3/endpoints-v3.ts'

function testClient(fetcher: typeof fetch, now: () => number = () => 1784289600000) {
  return new BitgetV3ReadOnlyClient({
    secretProvider: {
      async read() {
        return {
          apiKey: 'test-api-key',
          secretKey: 'test-secret-key',
          passphrase: 'test-passphrase',
        }
      },
    },
    now,
    fetcher,
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const INFO_FIXTURE = {
  code: '00000', data: { userId: '6682030769', permType: 'read-only', permissions: ['uta_trade', 'uta_mgt'] },
}

const UNIFIED_SETTINGS = {
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

test('V3 permission assertion accepts a unified account', () => {
  const accepted = assertBitgetV3ReadOnlyAuthorities(UNIFIED_SETTINGS, INFO_FIXTURE)
  assert.equal(accepted.userId, '6682030769')
  assert.equal(accepted.accountMode, 'hybrid')
  assert.equal(accepted.permissionsVerified, true)
  assert.equal(accepted.readOnly, true)
  assert.ok(Object.isFrozen(accepted))
})

test('V3 permission assertion rejects non-unified account modes', () => {
  for (const accountMode of ['classic', 'upgrading', 'switching', '']) {
    assert.throws(
      () =>
        assertBitgetV3ReadOnlyAuthorities({
          code: '00000',
          data: { uid: 'user-1', accountMode },
        }, INFO_FIXTURE),
      (error: unknown) => {
        assert.ok(error instanceof BitgetV3ReadOnlyClientError)
        assert.equal(error.code, 'ACCOUNT_MODE_UNVERIFIED')
        return true
      },
    )
  }
})

test('V3 permission assertion rejects missing uid and malformed payloads', () => {
  assert.throws(
    () => assertBitgetV3ReadOnlyAuthorities({ code: '00000', data: { accountMode: 'hybrid' } }, INFO_FIXTURE),
    (error: unknown) =>
      error instanceof BitgetV3ReadOnlyClientError && error.code === 'ACCOUNT_ID_MISSING',
  )
  for (const malformed of [null, 'x', 42, []]) {
    assert.throws(
      () => assertBitgetV3ReadOnlyAuthorities(malformed, INFO_FIXTURE),
      (error: unknown) =>
        error instanceof BitgetV3ReadOnlyClientError &&
        error.code === 'ACCOUNT_SETTINGS_MALFORMED',
    )
  }
})

test('V3 client signs private GET requests and pins the origin', async () => {
  let capturedUrl = ''
  let captured: RequestInit | undefined
  const client = testClient(async (input, init) => {
    capturedUrl = String(input)
    captured = init
    return jsonResponse(capturedUrl.endsWith('/api/v3/account/info') ? INFO_FIXTURE : UNIFIED_SETTINGS)
  })

  const permissions = await client.verifyReadOnlyPermissions()
  assert.equal(permissions.userId, '6682030769')
  assert.ok(capturedUrl.startsWith('https://api.bitget.com/api/v3/account/settings'))
  assert.equal(permissions.permissionsVerified, true)

  const headers = new Headers(captured?.headers)
  assert.equal(headers.get('ACCESS-KEY'), 'test-api-key')
  assert.equal(headers.get('ACCESS-TIMESTAMP'), '1784289600000')
  assert.equal(headers.get('ACCESS-PASSPHRASE'), 'test-passphrase')
  assert.match(headers.get('ACCESS-SIGN') ?? '', /^[A-Za-z0-9+/]+=*$/)
  assert.equal(JSON.stringify(captured).includes('test-secret-key'), false)
})

test('V3 public instruments endpoint sends no auth headers', async () => {
  let captured: RequestInit | undefined
  const client = testClient(async (_input, init) => {
    captured = init
    return jsonResponse({ code: '00000', msg: 'success', requestTime: 1, data: [] })
  })

  await client.getInstruments('SPOT')
  const headers = new Headers(captured?.headers)
  assert.equal(headers.get('ACCESS-KEY'), null)
  assert.equal(headers.get('ACCESS-SIGN'), null)
})

test('V3 client requires a category for instruments', async () => {
  const client = testClient(async () => jsonResponse({}))
  await assert.rejects(client.getInstruments('nope'), /must be one of/)
})

test('V3 client rejects non-success envelopes', async () => {
  const client = testClient(async () =>
    jsonResponse({ code: '40001', msg: 'invalid signature' }),
  )
  await assert.rejects(client.getAccountAssets(), (error: unknown) => {
    assert.ok(error instanceof BitgetV3ReadOnlyClientError)
    assert.equal(error.code, 'BITGET_V3_API_ERROR')
    return true
  })
})

test('V3 client rejects non-JSON bodies', async () => {
  const client = testClient(async () => new Response('not json', { status: 200 }))
  await assert.rejects(client.getAccountAssets(), (error: unknown) => {
    assert.ok(error instanceof BitgetV3ReadOnlyClientError)
    assert.equal(error.code, 'RESPONSE_NOT_JSON')
    return true
  })
})

test('V3 client surfaces HTTP errors', async () => {
  const client = testClient(async () => new Response('{}', { status: 429 }))
  await assert.rejects(client.getAccountAssets(), (error: unknown) => {
    assert.ok(error instanceof BitgetV3ReadOnlyClientError)
    assert.equal(error.code, 'HTTP_ERROR')
    assert.equal(error.status, 429)
    return true
  })
})

test('V3 client rejects oversized responses', async () => {
  const client = new BitgetV3ReadOnlyClient({
    secretProvider: { async read() { return { apiKey: 'a', secretKey: 'b', passphrase: 'c' } } },
    maxResponseBytes: 1024,
    fetcher: async () => new Response('x'.repeat(2048), { status: 200 }),
  })
  await assert.rejects(client.getAccountAssets(), (error: unknown) => {
    assert.ok(error instanceof BitgetV3ReadOnlyClientError)
    assert.equal(error.code, 'RESPONSE_TOO_LARGE')
    return true
  })
})

test('V3 client validates constructor bounds', () => {
  assert.throws(
    () =>
      new BitgetV3ReadOnlyClient({
        secretProvider: { async read() { return { apiKey: 'a', secretKey: 'b', passphrase: 'c' } } },
        timeoutMs: 50,
      }),
    /timeoutMs must be 100-30000/,
  )
})

test('V3 client validates funding coin codes', async () => {
  const client = testClient(async () => jsonResponse({}))
  await assert.rejects(client.getFundingAssets('!!!'), (error: unknown) => {
    assert.ok(error instanceof BitgetV3ReadOnlyClientError)
    assert.equal(error.code, 'COIN_INVALID')
    return true
  })
})

test('V3 client validates position query fields', async () => {
  const client = testClient(async () => jsonResponse({}))
  await assert.rejects(client.getCurrentPositions({ category: 'nope' }), /must be one of/)
  await assert.rejects(client.getCurrentPositions({ posSide: 'both' }), /must be long or short/)
})

test('V3 read-only client rejects streaming bodies at the byte cap without buffering the remaining stream', async () => {
  let chunksRead = 0
  let cancelled = false
  const client = new BitgetV3ReadOnlyClient({
    secretProvider: { async read() { return { apiKey: 'test', secretKey: 'test', passphrase: 'test' } } },
    maxResponseBytes: 1024,
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1
        controller.enqueue(new Uint8Array(600))
        if (chunksRead > 10) controller.close()
      },
      cancel() { cancelled = true },
    }), { status: 200 }),
  })
  await assert.rejects(client.getAccountAssets(), (error: unknown) =>
    error instanceof BitgetV3ReadOnlyClientError && error.code === 'RESPONSE_TOO_LARGE')
  assert.equal(cancelled, true)
  assert.ok(chunksRead <= 4, 'consumer must not read an unbounded body')
})

test('accepts both documented UTA modes and read-only permission spellings without granting writes', () => {
  for (const mode of ['hybrid', 'unified'] as const) {
    for (const permission of ['read-only', 'readonly'] as const) {
      const permissions = assertBitgetV3ReadOnlyAuthorities(
        { ...UNIFIED_SETTINGS, data: { ...UNIFIED_SETTINGS.data, accountMode: mode } },
        { ...INFO_FIXTURE, data: { ...INFO_FIXTURE.data, permType: permission } },
      )
      assert.equal(permissions.accountMode, mode)
      assert.equal(permissions.permissionsVerified, true)
      assert.equal(permissions.readOnly, true)
    }
  }
})

test('rejects arbitrary and write-capable permission types even with an otherwise valid account', () => {
  for (const permission of ['read-and-write', 'read_and_write', 'READONLY', 'withdraw', '', null]) {
    assert.throws(() => assertBitgetV3ReadOnlyAuthorities(UNIFIED_SETTINGS, {
      ...INFO_FIXTURE, data: { ...INFO_FIXTURE.data, permType: permission },
    }), (error: unknown) => error instanceof BitgetV3ReadOnlyClientError
      && error.code === 'API_KEY_PERMISSIONS_UNVERIFIED')
  }
})

test('V3 read-only product lookups scope GET queries to the reviewed Spot symbol', async () => {
  const observed: string[] = []
  const client = testClient(async (input, init) => {
    observed.push(String(input))
    assert.equal(init?.method, 'GET')
    return jsonResponse({ code: '00000', data: [] })
  })
  await client.getInstruments('SPOT', 'BTCUSDT')
  await client.getOrderHistory('BTCUSDT')
  assert.deepEqual(observed.map((raw) => {
    const u = new URL(raw)
    return [u.pathname, u.searchParams.get('category'), u.searchParams.get('symbol')]
  }), [
    ['/api/v3/market/instruments', 'SPOT', 'BTCUSDT'],
    ['/api/v3/trade/history-orders', 'SPOT', 'BTCUSDT'],
  ])
  assert.throws(() => client.getOrderHistory('!!'), /symbol/)
  await assert.rejects(client.getInstruments('SPOT', '!!'), /symbol/)
  assert.equal(observed.length, 2)
})

test('strict private V3 certification rejects stale, future, missing or forged provider requestTime', async () => {
  const at = Date.parse('2026-11-23T12:50:00.000Z')
  for (const requestTime of [undefined, null, '1760000000000', 1.5, NaN, 0,
    at - 120_001, at + 30_001]) {
    let requests = 0
    const client = new BitgetV3ReadOnlyClient({
      secretProvider: { async read() { return {
        apiKey: 'test-key', secretKey: 'test-secret', passphrase: 'test-passphrase',
      } } },
      now: () => at, requireFreshResponseTime: true,
      fetcher: async () => {
        requests += 1
        return jsonResponse({ code: '00000', requestTime, data: {} })
      },
    })
    await assert.rejects(client.verifyReadOnlyPermissions(), (error: unknown) =>
      error instanceof BitgetV3ReadOnlyClientError
        && error.code === 'PROVIDER_RESPONSE_NOT_FRESH')
    assert.equal(requests, 1, 'invalid account-info freshness must stop before account settings')
  }
})

test('strict V3 client accepts provider timestamps inside explicit bounded clock-skew window', async () => {
  const at = Date.parse('2026-11-23T12:50:00.000Z')
  for (const requestTime of [at - 120_000, at - 30_000, at, at + 30_000]) {
    let calls = 0
    const client = new BitgetV3ReadOnlyClient({
      secretProvider: { async read() { return {
        apiKey: 'test-key', secretKey: 'test-secret', passphrase: 'test-passphrase',
      } } },
      now: () => at, requireFreshResponseTime: true,
      fetcher: async () => {
        calls += 1
        return jsonResponse({
          ...(calls === 1 ? INFO_FIXTURE : UNIFIED_SETTINGS),
          requestTime,
        })
      },
    })
    const result = await client.verifyReadOnlyPermissions()
    assert.equal(result.readOnly, true)
    assert.equal(calls, 2)
  }
})

test('strict response-time verification is opt-in for mock fixtures, not a provider permission bypass', async () => {
  const client = testClient(async () => jsonResponse({ code: '00000', data: {} }))
  const response = await client.getAccountAssets()
  assert.deepEqual(response, { code: '00000', data: {} })
})

test('V3 order-info recovery signs only exact GET requests; unknown identity never contacts provider', async () => {
  const observed: Array<{url:string, method:string, key:string | null, signature:string | null}> = []
  let credentialsRead = 0
  const client = new BitgetV3ReadOnlyClient({
    now: () => 1784289600000,
    secretProvider: {async read() {
      credentialsRead++
      return {apiKey:'test-key', secretKey:'test-secret', passphrase:'test-passphrase'}
    }},
    fetcher: async (url, init) => {
      const headers = new Headers(init?.headers)
      observed.push({url:String(url), method:init?.method??'',
        key:headers.get('ACCESS-KEY'), signature:headers.get('ACCESS-SIGN')})
      return jsonResponse({code:'00000', requestTime:1784289600000, data:{
        orderId:'123456789', clientOid:'candidate-001', category:'SPOT',
        symbol:'BTCUSDT', side:'buy', orderType:'market', orderStatus:'filled',
      }})
    },
  })
  const response = await client.getOrderInfo({clientOid:'candidate-001'})
  assert.ok(response)
  await client.getOrderInfo({orderId:'123456789'})
  assert.deepEqual(observed.map(x=>[new URL(x.url).pathname,
    new URL(x.url).search, x.method]), [
    ['/api/v3/trade/order-info', '?clientOid=candidate-001', 'GET'],
    ['/api/v3/trade/order-info', '?orderId=123456789', 'GET'],
  ])
  assert.ok(observed.every(x=>x.key==='test-key' && /^[A-Za-z0-9+/]+=*$/.test(x.signature??'')))
  assert.equal(credentialsRead, 2)
  for (const identity of [{}, {orderId:'123',clientOid:'abc'},
    {clientOid:'a'.repeat(33)}, {clientOid:'x%26category=MARGIN'},
    {orderId:'abc'}, {orderId:'123',method:'POST'}]) {
    assert.throws(() => client.getOrderInfo(identity))
  }
  assert.equal(observed.length, 2)
  assert.equal(credentialsRead, 2)
})
