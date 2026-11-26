import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
test('local SQLite Durable Object serializes paper replay and enforces named isolation',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./fixtures/portfolio-replay-runtime.ts',import.meta.url))],
    bundle:true,format:'esm',target:'es2022',write:false})
  const mf=new Miniflare(convertV4MiniflareOptions({name:'portfolio-replay-local',modules:true,
    script:bundle.outputFiles[0].text,compatibilityDate:'2024-01-01',
    durableObjects:{REPLAY:{className:'ReplayFixture',useSQLite:true},BLOCKED:{className:'PortfolioState',useSQLite:true}}}))
  try {
    const ns=await mf.getDurableObjectNamespace('REPLAY')
    const stub=ns.get(ns.idFromName('fixture-portfolio'))
    const other=ns.get(ns.idFromName('other-portfolio'))
    const unnamed=ns.get(ns.newUniqueId())
    const init=(s:typeof stub)=>s.fetch('https://fixture/initialize',{method:'POST'})
    assert.equal((await init(other)).status,409)
    assert.equal((await init(unnamed)).status,409)
    assert.equal((await init(stub)).status,200)
    const event={mode:'isolated_paper_replay',portfolioId:'fixture-portfolio',eventId:'buy-1',
      expectedVersion:0,symbol:'BTC-USDT',side:'BUY',quantity:'2',simulatedPrice:'100',simulatedFee:'2'}
    const apply=(body=event)=>stub.fetch('https://fixture/apply',{method:'POST',body:JSON.stringify(body)})
    const concurrent=await Promise.all([apply(),apply()])
    assert.deepEqual(concurrent.map(r=>r.status),[200,200])
    const results=await Promise.all(concurrent.map(r=>r.json<any>()))
    assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true])
    assert.equal(results[0].id,results[1].id)
    assert.equal((await apply({...event,quantity:'3'})).status,409)
    const snap=await (await stub.fetch('https://fixture/snapshot')).json<any>()
    assert.equal(snap.cash,'798')
    assert.equal(snap.version,1)
    const next={...event,eventId:'buy-2',expectedVersion:1}
    const fault=await stub.fetch('https://fixture/rollback-probe',{method:'POST',body:JSON.stringify(next)})
    assert.equal(fault.status,409)
    assert.equal((await (await stub.fetch('https://fixture/snapshot')).json<any>()).version,1)
    const recovered=await apply(next)
    assert.equal(recovered.status,200)
    assert.equal((await recovered.json<any>()).replayed,false)
    assert.equal((await (await stub.fetch('https://fixture/snapshot')).json<any>()).cash,'596')
    assert.equal((await stub.fetch('https://fixture/halt',{method:'POST'})).status,200)
    assert.equal((await apply({...event,eventId:'buy-3',expectedVersion:3})).status,409)
    const blocked=await mf.getDurableObjectNamespace('BLOCKED')
    assert.equal((await blocked.get(blocked.idFromName('fixture-portfolio')).fetch('https://fixture/apply',{method:'POST'})).status,403)
    assert.equal((await mf.dispatchFetch('https://fixture/apply',{method:'POST'})).status,404)
  } finally { await mf.dispose() }
})
