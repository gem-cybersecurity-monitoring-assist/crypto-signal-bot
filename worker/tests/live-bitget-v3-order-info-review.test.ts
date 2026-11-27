import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewBitgetV3SpotOrderInfo } from '../src/live/adapters/bitget/v3/order-info-review-v3.ts'
import { buildBitgetV3UnsignedPlaceCandidate } from '../src/live/adapters/bitget/v3/unsigned-candidate-v3.ts'
import { asDecimalString } from '../src/live/decimal.ts'

const NOW = Date.parse('2026-11-23T15:00:00.000Z')
const CLIENT_ID = 'candidate-v3-001'
function provider(status = 'filled', overrides: Record<string, unknown> = {}) {
  return {
    code:'00000',requestTime:NOW,
    data: {
      orderId:'12345678901234', clientOid:CLIENT_ID,
      category:'SPOT', symbol:'BTCUSDT',
      side:'buy', orderType:'market', orderStatus:status,
      qty:'0', amount:'100', cumExecQty:'0.002', cumExecValue:'99.50',
      ...overrides,
    },
  }
}
function review(response: unknown = provider(), identity:unknown = {clientOid:CLIENT_ID}) {
  return reviewBitgetV3SpotOrderInfo({
    response, expectedIdentity:identity, expectedSymbol:'BTCUSDT', evaluatedAtMs:NOW,
  })
}
test('V3 lookup evidence reports provider status, never trade/retry/settlement approval', async()=>{
  for(const status of ['live','new','partially_filled','filled','cancelled'] as const) {
    const record=await review(provider(status))
    assert.equal(record.status,status)
    assert.equal(record.terminalProviderStatus,['filled','cancelled'].includes(status))
    assert.equal(record.ledgerSettlementConfirmed,false)
    assert.equal(record.providerMutationAllowed,false)
    assert.equal(record.automaticRetryAllowed,false)
    assert.equal(record.liveExecutionAllowed,false)
    assert.equal(record.independentReconciliationRequired,true)
    assert.equal(record.sourceOnly,true)
    assert.equal(record.apiVersion,'UTA_V3')
    assert.equal(record.productSymbol,'BTCUSDT')
    assert.match(record.responseHash,/^[0-9a-f]{64}$/)
    assert.match(record.observedIdentityHash,/^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(record).includes('12345678901234'),false)
    assert.equal(JSON.stringify(record).includes(CLIENT_ID),false)
  }
})
test('V3 order evidence is deterministic and matches either known order identity',async()=>{
  const a=await review()
  const b=await review(provider(),{orderId:'12345678901234'})
  assert.equal(a.responseHash,b.responseHash)
  assert.equal(a.observedIdentityHash,b.observedIdentityHash)
})
test('V3 order-info blocks mismatched identity, category, symbol, order state and empty payload',async()=>{
  const cases=[
    provider('unknown'),provider('FILLED'),provider('filled',{symbol:'ETHUSDT'}),
    provider('filled',{category:'MARGIN'}),provider('filled',{orderId:'different'}),
    provider('filled',{clientOid:'other-id'}),provider('filled',{orderType:'isolated'}),
    provider('filled',{side:'hold'}),{code:'00000',requestTime:NOW,data:null},
    {code:'00000',requestTime:NOW,data:[]},
    {code:'40725',requestTime:NOW,data:provider().data},
  ]
  for(const response of cases) await assert.rejects(review(response))
  await assert.rejects(review(provider(),{orderId:'99999'}))
  await assert.rejects(review(provider(),{clientOid:'another-client'}))
})
test('V3 order-info rejects replayed, missing, malformed and future timestamps',async()=>{
  for(const requestTime of [undefined,null,'1790000000000',NOW-120001,NOW+30001,0,NaN]) {
    await assert.rejects(review({...provider(),requestTime}))
  }
  for(const requestTime of [NOW-120000,NOW,NOW+30000]) {
    assert.equal((await review({...provider(),requestTime})).sourceOnly,true)
  }
})
test('V3 order-info hash supports missing optional fill fields without inferring settlement',async()=>{
  const p=provider()
  const {qty, amount, cumExecQty,cumExecValue,...required}=p.data
  const r=await review({...p,data:required})
  assert.match(r.responseHash,/^[a-f0-9]{64}$/)
  assert.equal(r.ledgerSettlementConfirmed,false)
  assert.equal(r.independentReconciliationRequired,true)
})
test('V3 candidate order identity is capped at the documented 32-character limit',async()=>{
  const base={
    request:{productId:'BTC-USDT',side:'BUY' as const,orderType:'MARKET' as const,
      baseQuantity:null, quoteNotional:asDecimalString('100'), limitPrice:null,stopPrice:null},
    productRules:{
      productId:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT',
      baseIncrement:asDecimalString('0.00000001'),quoteIncrement:asDecimalString('0.01'),
      priceIncrement:asDecimalString('0.01'),minimumBaseSize:asDecimalString('0.0001'),
      maximumBaseSize:asDecimalString('10'), minimumQuoteSize:asDecimalString('5'),
      tradingEnabled:true,supportedOrderTypes:['MARKET','LIMIT'] as const,
      observedAt:'2026-07-17T14:00:00.000Z',expiresAt:'2026-07-17T14:10:00.000Z',
    },
    previewHash:'a'.repeat(64), accountFamilyReviewHash:'b'.repeat(64),
    timeInForce:null,builtAt:'2026-07-17T14:05:00.000Z',
    expiresAt:'2026-07-17T14:06:00.000Z',
  }
  const good=await buildBitgetV3UnsignedPlaceCandidate({...base,clientOrderId:'x'.repeat(32)})
  assert.equal(good.unsignedBody.clientOid.length,32)
  await assert.rejects(buildBitgetV3UnsignedPlaceCandidate({...base,clientOrderId:'x'.repeat(33)}))
})
