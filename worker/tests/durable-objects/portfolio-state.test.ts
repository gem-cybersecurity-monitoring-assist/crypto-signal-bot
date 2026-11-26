import { describe, it, expect } from 'vitest'
import { PortfolioReplayLedger, PortfolioState, type ReplayFill } from '../../src/durable-objects/PortfolioState'
class AtomicFixture {
  values = new Map<string, unknown>()
  tail: Promise<unknown> = Promise.resolve()
  failOutbox = false
  transaction<T>(fn: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.values)
      const tx = {
        get: async (key: string) => structuredClone(next.get(key)),
        put: async (key: string, value: unknown) => {
          if (this.failOutbox && key.startsWith('paper-replay:outbox:')) throw new Error('Injected rollback')
          next.set(key, structuredClone(value))
        },
      }
      const result = await fn(tx as unknown as DurableObjectTransaction)
      this.values = next
      return result
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
const event = (overrides: Partial<ReplayFill> = {}): ReplayFill => ({
  mode:'isolated_paper_replay',portfolioId:'test-portfolio',eventId:'buy1',
  expectedVersion:0,symbol:'BTC-USDT',side:'BUY',quantity:'2',simulatedPrice:'100',simulatedFee:'2',...overrides,
})
async function setup() {
  const storage = new AtomicFixture()
  const ledger = new PortfolioReplayLedger(storage)
  await ledger.initialize('test-portfolio','1000')
  return {ledger,storage}
}
describe('isolated atomic portfolio replay', () => {
  it('commits one receipt and one outbox event for concurrent duplicates', async () => {
    const {ledger,storage}=await setup()
    const results=await Promise.all([ledger.apply(event()),ledger.apply(event())])
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true])
    expect(results[0].id).toBe(results[1].id)
    expect((await ledger.snapshot())?.cash).toBe('798')
    expect([...storage.values.keys()].filter(k=>k.includes(':outbox:'))).toHaveLength(1)
  })
  it('rejects changed payload under the same event identity', async () => {
    const {ledger}=await setup()
    await ledger.apply(event())
    await expect(ledger.apply(event({quantity:'3'}))).rejects.toThrow('identity conflict')
    expect((await ledger.snapshot())?.version).toBe(1)
  })
  it('rolls back state and receipt when the outbox write fails', async () => {
    const {ledger,storage}=await setup()
    storage.failOutbox=true
    await expect(ledger.apply(event())).rejects.toThrow('Injected rollback')
    expect((await ledger.snapshot())?.cash).toBe('1000')
    expect(storage.values.size).toBe(1)
    storage.failOutbox=false
    expect((await ledger.apply(event())).replayed).toBe(false)
  })
  it('reconstructs FIFO partial and full closes, fees and protected reserve', async () => {
    const {ledger,storage}=await setup()
    await ledger.apply(event())
    const after=await ledger.apply(event({eventId:'sell1',expectedVersion:1,side:'SELL',quantity:'1',simulatedPrice:'120',simulatedFee:'1'}))
    expect(after.realizedPnl).toBe('18')
    expect(after.state.protectedReserve).toBe('4.5')
    expect(after.state.cash).toBe('912.5')
    expect(after.state.positions[0].lots).toEqual([{quantity:'1',cost:'101'}])
    const restarted=new PortfolioReplayLedger(storage)
    const final=await restarted.apply(event({eventId:'sell2',expectedVersion:2,side:'SELL',quantity:'1',simulatedPrice:'90',simulatedFee:'1'}))
    expect(final.state.positions).toEqual([])
    expect(final.state.realizedPnl).toBe('6')
    expect(final.state.cash).toBe('1001.5')
    expect(final.state.protectedReserve).toBe('4.5')
    expect(final.executionAuthorized).toBe(false)
  })
  it('rejects insufficient cash and inventory without partial mutation', async () => {
    const {ledger}=await setup()
    await expect(ledger.apply(event({quantity:'100'}))).rejects.toThrow('reusable cash')
    await expect(ledger.apply(event({side:'SELL'}))).rejects.toThrow('inventory')
    expect((await ledger.snapshot())?.version).toBe(0)
  })
  it('rejects stale versions and cross-portfolio events', async () => {
    const {ledger}=await setup()
    await ledger.apply(event())
    await expect(ledger.apply(event({eventId:'buy2'}))).rejects.toThrow('version conflict')
    await expect(ledger.apply(event({portfolioId:'other'}))).rejects.toThrow('portfolio mismatch')
  })
  it('preserves halt across reconstructed owners and rejects later events', async () => {
    const {ledger,storage}=await setup()
    await ledger.halt('test-portfolio')
    const restarted=new PortfolioReplayLedger(storage)
    await expect(restarted.apply(event({expectedVersion:1}))).rejects.toThrow('halted')
    expect((await restarted.snapshot())?.halted).toBe(true)
  })
  it('rejects unbound and cross-portfolio object identities', async () => {
    for (const name of [undefined, 'wrong-portfolio']) {
      const obj=new PortfolioState({storage:new AtomicFixture(),id:{name}} as unknown as DurableObjectState)
      await expect(obj.ledger.initialize('test-portfolio','1000')).rejects.toThrow('scope mismatch')
    }
  })
  it('does not expose a public mutation route', async () => {
    const obj=new PortfolioState({storage:new AtomicFixture(),id:{name:"test-portfolio"}} as unknown as DurableObjectState)
    expect((await obj.fetch()).status).toBe(403)
  })
})
