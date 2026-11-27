import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { projectReplayEvent } from '../src/projections/replay-portfolio-projection.ts'
import type { ReplayOutboxEvent } from '../src/durable-objects/PortfolioState.ts'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
test('local SQLite Durable Object serializes paper replay and enforces named isolation',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./fixtures/portfolio-replay-runtime.ts',import.meta.url))],
    bundle:true,format:'esm',target:'es2022',write:false})
  const mf=new Miniflare(convertV4MiniflareOptions({name:'portfolio-replay-local',modules:true,
    script:bundle.outputFiles[0].text,compatibilityDate:'2024-01-01',
    durableObjects:{REPLAY:{className:'ReplayFixture',useSQLite:true},BLOCKED:{className:'PortfolioState',useSQLite:true}},
    d1Databases:{REPLAY_DB:'isolated-replay-local'}}))
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
    const db=await mf.getD1Database('REPLAY_DB')
    const outbox=await (await stub.fetch('https://fixture/outbox')).json<ReplayOutboxEvent[]>()
    assert.equal(outbox.length,3)
    // An unavailable projection does not undo the Durable Object commit.
    await assert.rejects(projectReplayEvent(db,outbox[0]))
    assert.equal((await (await stub.fetch('https://fixture/snapshot')).json<any>()).version,3)
    const migration=readFileSync(new URL('../migrations/replay/001_isolated_portfolio_projection.sql',import.meta.url),'utf8')
    for (const statement of migration.replace(/^--[^\n]*\n/gm, "").split(/(?=^CREATE )/m).map(s=>s.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
    await assert.rejects(projectReplayEvent(db,outbox[1]),/sequence gap/)
    const deliveries=await Promise.all([projectReplayEvent(db,outbox[0]),projectReplayEvent(db,outbox[0])])
    assert.deepEqual(deliveries.map(r=>r.replayed).sort(),[false,true])
    assert.equal(deliveries[0].bookValue,'1000')
    const poisoned=structuredClone(outbox[0])
    assert.equal(poisoned.type,'replay_fill')
    if(poisoned.type==='replay_fill') {
      poisoned.receipt.state.cash='799' as typeof poisoned.receipt.state.cash
      poisoned.receipt.state.initialCash='1001' as typeof poisoned.receipt.state.initialCash
      poisoned.receipt.state.peakEquity='1001' as typeof poisoned.receipt.state.peakEquity
    }
    await assert.rejects(projectReplayEvent(db,poisoned),/identity conflict/)
    const subsequent=await (await stub.fetch('https://fixture/outbox?after=1')).json<ReplayOutboxEvent[]>()
    assert.equal(subsequent.length,2)
    for(const record of subsequent) await projectReplayEvent(db,record)
    const projected=await db.prepare('SELECT version,event_type,book_value FROM isolated_replay_portfolio_events ORDER BY version').all()
    assert.deepEqual(projected.results,[
      {version:1,event_type:'replay_fill',book_value:'1000'},
      {version:2,event_type:'replay_fill',book_value:'1000'},
      {version:3,event_type:'replay_halted',book_value:'1000'},
    ])
    await assert.rejects(db.prepare("UPDATE isolated_replay_portfolio_events SET book_value='0' WHERE version=1").run(),/immutable/)
    assert.equal((await (await stub.fetch('https://fixture/outbox?after=3')).json<any[]>()).length,0)
    assert.equal((await stub.fetch('https://fixture/outbox?after=4')).status,409)
    // Even after a halt, valuation is observable but cannot clear that halt.
    const mark={mode:'isolated_paper_replay',portfolioId:'fixture-portfolio',eventId:'mark-1',
      expectedVersion:3,atMs:1000,marks:[{symbol:'BTC-USDT',price:'50'}]}
    const markResponse=await stub.fetch('https://fixture/mark',{method:'POST',body:JSON.stringify(mark)})
    assert.equal(markResponse.status,200)
    const markReceipt=await markResponse.json<any>()
    assert.equal(markReceipt.state.valuation.equity,'796')
    assert.equal(markReceipt.state.valuation.unrealizedPnl,'-204')
    assert.equal(markReceipt.state.valuation.drawdownPct,'20.4')
    assert.equal(markReceipt.state.halted,true)
    const page=await (await stub.fetch('https://fixture/outbox?after=3')).json<ReplayOutboxEvent[]>()
    assert.equal(page.length,1)
    assert.equal(page[0].type,'replay_valuation')
    const valuationProjection=await projectReplayEvent(db,page[0])
    assert.equal(valuationProjection.version,4)
    assert.equal(valuationProjection.bookValue,'1000')
    assert.equal((await projectReplayEvent(db,page[0])).replayed,true)
    const saved=await db.prepare('SELECT event_json FROM isolated_replay_portfolio_events WHERE version=4').first<{event_json:string}>()
    assert.equal(JSON.parse(saved!.event_json).receipt.state.valuation.equity,'796')
    const blocked=await mf.getDurableObjectNamespace('BLOCKED')
    assert.equal((await blocked.get(blocked.idFromName('fixture-portfolio')).fetch('https://fixture/apply',{method:'POST'})).status,403)
    assert.equal((await mf.dispatchFetch('https://fixture/apply',{method:'POST'})).status,404)
  } finally { await mf.dispose() }
})
