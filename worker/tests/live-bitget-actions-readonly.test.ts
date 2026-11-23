import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalHash } from '../src/live/canonical-json.ts'
import {
  enforceProviderGetOnly, runManualBitgetReadOnlyCertification,
} from '../scripts/run-bitget-actions-readonly.mjs'
import { BITGET_V3_ENDPOINTS } from '../src/live/adapters/bitget/v3/endpoints-v3.ts'

const AT = Date.parse('2026-11-23T14:45:00.000Z')
const UID = 'authorized-test-owner-uid'
const HEADERS = Object.freeze({
  BITGET_CERT_API_KEY:'UNIT_TEST_KEY_NOT_REAL',
  BITGET_CERT_API_SECRET:'UNIT_TEST_SECRET_NOT_REAL',
  BITGET_CERT_API_PASSPHRASE:'UNIT_TEST_PASSPHRASE_NOT_REAL',
  GEM_CERT_MODE:'inspect',
  GEM_CERT_ACCOUNT_REF:'owner-uta-account',
  GEM_CERT_PRODUCT_ID:'BTC-USDT',
  GEM_CERT_ACKNOWLEDGED:'true',
  GITHUB_RUN_ID:'101',
})
function fixture() {
  const paths=[]
  const methods=[]
  const fetcher=async(input,init)=>{
    const url=new URL(String(input))
    paths.push(url.pathname);methods.push(init?.method)
    let data
    switch(url.pathname) {
      case BITGET_V3_ENDPOINTS.accountInfo:
        data={userId:UID,permType:'read-only',permissions:['uta_trade']}
        break
      case BITGET_V3_ENDPOINTS.accountSettings:
        data={uid:UID,accountMode:'hybrid'}
        break
      case BITGET_V3_ENDPOINTS.accountAssets:
        data={accountEquity:'3.41',effEquity:'3.41',
          assets:[{coin:'USDT',available:'3.00',locked:'0'}]}
        break
      case BITGET_V3_ENDPOINTS.currentPositions:
        data={list:[]}
        break
      case BITGET_V3_ENDPOINTS.instruments:
        data=[{symbol:'BTCUSDT',category:'SPOT',baseCoin:'BTC',quoteCoin:'USDT',
          status:'online',pricePrecision:'2',quantityPrecision:'6',
          quotePrecision:'6',minOrderQty:'0.00001',minOrderAmount:'1'}]
        break
      case BITGET_V3_ENDPOINTS.orderHistory:
        data={list:[{orderId:'123',symbol:'BTCUSDT',category:'SPOT'}]}
        break
      default:
        throw new Error('TEST_UNEXPECTED_ENDPOINT')
    }
    return Response.json({code:'00000',requestTime:AT,data})
  }
  return {paths,methods,fetcher}
}
const settings=(fetcher,overrides={})=>({
  env:{...HEADERS,...overrides},fetcher,clock:()=>AT,
  tokenFactory:()=>('a'.repeat(64)),
})

test('manual read-only inspect verifies provider scope and reveals only sanitized account hash',async()=>{
  const f=fixture()
  const output=await runManualBitgetReadOnlyCertification(settings(f.fetcher))
  assert.equal(output.mode,'inspect')
  assert.equal(output.status,'INSPECTED')
  assert.equal(output.accountRefHash,await canonicalHash(UID))
  assert.equal(output.accountModel,'UTA_HYBRID')
  assert.equal(output.certifiedForLive,false)
  assert.equal(output.executionAllowed,false)
  assert.deepEqual(f.paths,[BITGET_V3_ENDPOINTS.accountInfo,BITGET_V3_ENDPOINTS.accountSettings])
  assert.ok(f.methods.every(m=>m==='GET'))
  for(const sensitive of [UID,HEADERS.BITGET_CERT_API_SECRET,HEADERS.BITGET_CERT_API_PASSPHRASE,'3.41']) {
    assert.equal(JSON.stringify(output).includes(sensitive),false)
  }
})

test('manual read-only certification evaluates isolated provider contracts and never approves live trading',async()=>{
  const f=fixture()
  const hash=await canonicalHash(UID)
  const output=await runManualBitgetReadOnlyCertification(settings(f.fetcher,{
    GEM_CERT_MODE:'certify',GEM_CERT_EXPECTED_HASH:hash,
  }))
  assert.equal(output.status,'READ_ONLY_CHECKS_PASSED')
  assert.equal(output.accountRefHash,hash)
  assert.equal(output.checks.length,6)
  assert.ok(output.checks.every(check=>check.status==='PASS' && /^[a-f0-9]{64}$/.test(check.evidenceHash)))
  assert.equal(output.executionAllowed,false)
  assert.equal(output.certifiedForLive,false)
  assert.deepEqual(new Set(f.paths),new Set([
    BITGET_V3_ENDPOINTS.accountInfo,BITGET_V3_ENDPOINTS.accountSettings,
    BITGET_V3_ENDPOINTS.accountAssets,BITGET_V3_ENDPOINTS.currentPositions,
    BITGET_V3_ENDPOINTS.instruments,BITGET_V3_ENDPOINTS.orderHistory,
  ]))
  assert.ok(f.methods.every(m=>m==='GET'))
  for(const secret of [HEADERS.BITGET_CERT_API_KEY,HEADERS.BITGET_CERT_API_SECRET,
    HEADERS.BITGET_CERT_API_PASSPHRASE,UID,'3.41']) {
    assert.equal(JSON.stringify(output).includes(secret),false)
  }
})

test('wrong account hash prevents account data reads and any live trading',async()=>{
  const f=fixture()
  await assert.rejects(runManualBitgetReadOnlyCertification(settings(f.fetcher,{
    GEM_CERT_MODE:'certify',GEM_CERT_EXPECTED_HASH:'b'.repeat(64),
  })),/PRIVATE_READONLY_PROVIDER_VERIFICATION_FAILED/)
  assert.deepEqual(f.paths,[BITGET_V3_ENDPOINTS.accountInfo,BITGET_V3_ENDPOINTS.accountSettings])
})

test('missing credentials or missing acknowledgement fail before provider fetch',async()=>{
  for(const overrides of [
    {BITGET_CERT_API_KEY:''},{BITGET_CERT_API_SECRET:''},
    {BITGET_CERT_API_PASSPHRASE:''},
    {GEM_CERT_ACKNOWLEDGED:'false'},
    {GEM_CERT_MODE:'trade'},{GEM_CERT_ACCOUNT_REF:'unsafe account!'},
    {GEM_CERT_PRODUCT_ID:'MARGIN'},
    {GEM_CERT_MODE:'certify',GEM_CERT_EXPECTED_HASH:''},
  ]) {
    const f=fixture()
    await assert.rejects(runManualBitgetReadOnlyCertification(settings(f.fetcher,overrides)))
    assert.deepEqual(f.paths,[])
  }
})

test('GitHub Actions wrapper denies write methods, unknown hosts, non-allowlisted paths and redirects',async()=>{
  let called=0
  const guarded=enforceProviderGetOnly(async()=>{
    called++
    return Response.json({code:'00000',requestTime:AT,data:{}})
  })
  for(const [url,init] of [
    ['https://api.bitget.com/api/v3/trade/place-order',{method:'POST',redirect:'error'}],
    ['https://api.bitget.com/api/v3/trade/cancel-order',{method:'GET',redirect:'error'}],
    ['https://api.bitget.com/api/v3/account/info',{method:'POST',redirect:'error'}],
    ['https://untrusted.example.com/api/v3/account/info',{method:'GET',redirect:'error'}],
    ['http://api.bitget.com/api/v3/account/info',{method:'GET',redirect:'error'}],
    ['https://api.bitget.com/api/v3/account/info',{method:'GET',redirect:'follow'}],
  ]) {
    await assert.rejects(guarded(url,init),/PRIVATE_READONLY_PROVIDER_NETWORK_DENIED/)
  }
  assert.equal(called,0)
  await guarded('https://api.bitget.com/api/v3/account/info',{method:'GET',redirect:'error'})
  assert.equal(called,1)
})
