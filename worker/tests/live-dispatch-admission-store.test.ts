import assert from 'node:assert/strict'
import test from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import { createBitgetV3OrderTransport } from '../src/live/adapters/bitget/v3/order-write-transport-v3.ts'
import { createBitgetV3UidQuota } from '../src/live/adapters/bitget/v3/order-write-quota-v3.ts'
import { buildBitgetV3UnsignedCancelCandidate } from '../src/live/adapters/bitget/v3/unsigned-candidate-v3.ts'
import {LiveDispatchAdmissionStore,type LiveDispatchClaim} from '../src/live/live-dispatch-admission-store.ts'

function fixture() {
  const db=new DatabaseSync(':memory:')
  let failDailyWrite=false
  const storage={sql:{exec(query:string,...args:(string|number)[]) {
    if(failDailyWrite && query.includes('INSERT INTO live_dispatch_daily_exposure')) throw Error('injected interrupted commit')
    if(!args.length && query.includes('CREATE TABLE')) {db.exec(query);return {toArray:()=>[]}}
    const rows=db.prepare(query).all(...args)
    return {toArray:()=>rows}
  }},transactionSync<T>(fn:()=>T):T {db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}}
  const identity={coordinatorName:'account-1',accountId:'account-1',accountRefHash:'a'.repeat(64),exchange:'BITGET' as const}
  const store=new LiveDispatchAdmissionStore(storage as any,identity)
  return {db,storage,identity,store,failWrite:()=>{failDailyWrite=true},recover:()=>{failDailyWrite=false}}
}
function claim(index=1):LiveDispatchClaim {
  return {attemptId:`attempt-${index}`,idempotencyKey:`key-${index}`,orderId:`order-${index}`,operation:'PLACE',
    candidateHash:'b'.repeat(64),releaseId:'release-1',releaseEvidenceHash:'c'.repeat(64),currentControlHash:'d'.repeat(64),
    claimedAt:'2026-10-04T10:00:00.000Z',notional:'100',maxOrderNotional:'100',maxDailyNotional:'1000'}
}
test('claim and exact daily exposure commit together without conferring execution',()=>{
  const f=fixture();try {
    const receipt=f.store.claim(claim())
    assert.equal(receipt.usedAndReservedNotional,'100');assert.equal(receipt.executionAllowed,false)
    assert.equal(receipt.automaticRetryAllowed,false)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_dispatch_admission').get()!.n,1)
  }finally{f.db.close()}
})
test('same attempt, idempotency key or logical order cannot reserve twice or dispatch after restart',()=>{
  const f=fixture();try {
    f.store.claim(claim());const restarted=new LiveDispatchAdmissionStore(f.storage as any,f.identity)
    for(const value of [claim(),{...claim(2),attemptId:'attempt-1'},{...claim(2),idempotencyKey:'key-1'},{...claim(2),orderId:'order-1'}]) {
      assert.throws(()=>restarted.claim(value),/ALREADY_CLAIMED/)
    }
    assert.equal(f.db.prepare('SELECT used_and_reserved_notional AS n FROM live_dispatch_daily_exposure').get()!.n,'100')
  }finally{f.db.close()}
})
test('simultaneous admission cannot exceed daily limit or count duplicates',async()=>{
  const f=fixture();try {
    const results=await Promise.allSettled(Array.from({length:20},(_,i)=>Promise.resolve().then(()=>f.store.claim(claim(i)))))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,10)
    assert.equal(f.db.prepare('SELECT used_and_reserved_notional AS n FROM live_dispatch_daily_exposure').get()!.n,'1000')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_dispatch_admission').get()!.n,10)
  }finally{f.db.close()}
})
test('failed budget write rolls back attempt and allows exactly one subsequent complete claim',()=>{
  const f=fixture();try {
    f.failWrite();assert.throws(()=>f.store.claim(claim()),/interrupted/)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_dispatch_admission').get()!.n,0)
    f.recover();f.store.claim(claim());assert.throws(()=>f.store.claim(claim()),/ALREADY_CLAIMED/)
  }finally{f.db.close()}
})
test('cancel adds no budget and new day does not erase a previously claimed place identity',()=>{
  const f=fixture();try {
    f.store.claim(claim())
    const cancel={...claim(2),orderId:'order-1',operation:'CANCEL' as const,notional:null}
    assert.equal(f.store.claim(cancel).usedAndReservedNotional,'100')
    assert.throws(()=>f.store.claim({...claim(),claimedAt:'2026-10-05T10:00:00.000Z'}),/ALREADY_CLAIMED/)
    assert.equal(f.store.claim({...claim(3),claimedAt:'2026-10-05T10:00:00.000Z'}).usedAndReservedNotional,'100')
  }finally{f.db.close()}
})
test('wrong namespace, provider or mutated persisted account owner cannot claim',()=>{
  const f=fixture();try {
    assert.throws(()=>new LiveDispatchAdmissionStore(f.storage as any,{...f.identity,coordinatorName:'other'}),/SCOPE_INVALID/)
    assert.throws(()=>new LiveDispatchAdmissionStore(f.storage as any,{...f.identity,exchange:'BTCC'}),/SCOPE_INVALID/)
    f.db.exec("UPDATE live_dispatch_owner SET account_ref_hash='changed'")
    assert.throws(()=>f.store.claim(claim()),/SCOPE_INVALID/)
  }finally{f.db.close()}
})
test('malformed financial evidence and microscopic overspending leave no attempt',()=>{
  const f=fixture();try {
    for(const value of [{notional:'100.000000000000000001'},{notional:'0'},{notional:'NaN'},{notional:100},
      {maxDailyNotional:'99'},{claimedAt:'2026-10-04T10:00:00Z'}]) {
      assert.throws(()=>f.store.claim({...claim(),...value} as LiveDispatchClaim))
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_dispatch_admission').get()!.n,0)
  }finally{f.db.close()}
})

async function transportFixture() {
  const admitted = fixture()
  const nowMs = Date.parse('2026-10-04T10:00:10.000Z')
  const accountRefHash = admitted.identity.accountRefHash
  const providerUidHash = 'e'.repeat(64)
  const candidate = await buildBitgetV3UnsignedCancelCandidate({
    productId: 'BTC-USDT', orderId: '1234567890', clientOrderId: null,
    accountFamilyReviewHash: 'f'.repeat(64),
    builtAt: new Date(nowMs - 10).toISOString(), expiresAt: new Date(nowMs + 10_000).toISOString(),
  })
  const controls = {
    admission: { ...claim(), operation: 'CANCEL' as const, notional: null, candidateHash: candidate.candidateHash },
    validUntilMs: nowMs + 1_000,
  }
  const options = {
    admission: admitted.store, accountRefHash, providerUidHash, now: () => nowMs,
    resolveControls: async () => controls,
    readCredentials: async () => ({ apiKey: 'fixture', secretKey: 'fixture', passphrase: 'fixture' }),
    claimUidQuota: async () => ({
      providerUidHash, operation: 'CANCEL' as const, claimedAtMs: nowMs, expiresAtMs: nowMs + 250,
    }),
    sendOnce: async (_request: Request) => Response.json({ code: '00000', data: { orderId: '1234567890' } }),
  }
  return { ...admitted, options, candidate }
}

test('mainnet transport admits once across concurrent calls and a coordinator restart', async () => {
  const f = await transportFixture()
  try {
    const requests: Request[] = []
    const sendOnce = async (request: Request) => {
      requests.push(request)
      return f.options.sendOnce(request)
    }
    const dispatch = createBitgetV3OrderTransport({ ...f.options, sendOnce })
    const results = await Promise.all([dispatch(f.candidate), dispatch(f.candidate)])
    const restarted = new LiveDispatchAdmissionStore(f.storage as any, f.identity)
    const retry = createBitgetV3OrderTransport({ ...f.options, admission: restarted, sendOnce })
    assert.deepEqual(await retry(f.candidate), { state: 'BLOCKED_BEFORE_SEND' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].redirect, 'error')
    assert.equal(results.filter(result => result.state === 'ACKNOWLEDGED').length, 1)
    const outcome = results.find(result => result.state === 'ACKNOWLEDGED')
    assert.deepEqual(outcome?.recovery, {
      method: 'GET', endpoint: '/api/v3/trade/order-info', query: { orderId: '1234567890' },
    })
  } finally {
    f.db.close()
  }
})

test('revocation after durable admission prevents credentials and send', async () => {
  const f = await transportFixture()
  try {
    let checks = 0
    let credentialReads = 0
    const dispatch = createBitgetV3OrderTransport({
      ...f.options,
      resolveControls: async () => ++checks === 1 ? f.options.resolveControls() : null,
      readCredentials: async () => { credentialReads++; return f.options.readCredentials() },
    })
    assert.deepEqual(await dispatch(f.candidate), { state: 'BLOCKED_BEFORE_SEND' })
    assert.equal(credentialReads, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_dispatch_admission').get()!.n, 1)
  } finally {
    f.db.close()
  }
})

test('timeout, oversized response and network error are ambiguous and never retry the POST', async () => {
  const invalidResponses = [
    async (_request: Request): Promise<Response> => { throw new Error('connection reset') },
    async (_request: Request) => new Response('x'.repeat(16_385)),
    (request: Request) => new Promise<Response>(resolve => {
      request.signal.addEventListener('abort', () => resolve(new Response('late')))
    }),
  ]
  for (const respond of invalidResponses) {
    const f = await transportFixture()
    try {
      let sends = 0
      const dispatch = createBitgetV3OrderTransport({
        ...f.options, timeoutMs: 20,
        sendOnce(request) { sends++; return respond(request) },
      })
      const result = await dispatch(f.candidate)
      assert.equal(result.state, 'UNKNOWN_REQUIRES_LOOKUP')
      assert.deepEqual(await dispatch(f.candidate), { state: 'BLOCKED_BEFORE_SEND' })
      assert.equal(sends, 1)
    } finally {
      f.db.close()
    }
  }
})

test('Bitget quota is persisted across instances by UID and operation', async () => {
  const values = new Map<string, unknown>()
  const storage = {
    async transaction<T>(run: (txn: object) => Promise<T>) {
      return run({
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => { values.set(key, value) },
      })
    },
  } as Pick<DurableObjectStorage, 'transaction'>
  const providerUidHash = 'e'.repeat(64)
  let now = 1_000_000
  const quota = () => createBitgetV3UidQuota(storage, providerUidHash, () => now)
  const place = { providerUidHash, operation: 'PLACE' as const }
  for (let i = 0; i < 10; i++) assert.ok(await quota()(place))
  assert.equal(await quota()(place), null)
  assert.ok(await quota()({ providerUidHash, operation: 'CANCEL' }))
  now += 1_249
  assert.equal(await quota()(place), null)
  now += 1
  assert.equal((await quota()(place))?.expiresAtMs, now + 250)
  now -= 1
  await assert.rejects(quota()(place), /quota clock/)
})
