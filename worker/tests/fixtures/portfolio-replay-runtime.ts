// Local test harness only. Never a deployed Worker entrypoint.
import { PortfolioState, PortfolioReplayLedger, type ReplayFill, type ReplayValuationInput } from '../../src/durable-objects/PortfolioState'
export { PortfolioState }
export class ReplayFixture extends PortfolioState {
  constructor(private readonly ctx: DurableObjectState) { super(ctx) }
  async fetch(request: Request): Promise<Response> {
    try {
      const path=new URL(request.url).pathname
      if (path==='/initialize') return Response.json(await this.ledger.initialize('fixture-portfolio','1000'))
      if (path==='/mark') return Response.json(await this.ledger.mark(await request.json<ReplayValuationInput>()))
      if (path==='/apply') return Response.json(await this.ledger.apply(await request.json<ReplayFill>()))
      if (path==='/rollback-probe') {
        const failureStore = {
          transaction: <T>(fn: (tx: DurableObjectTransaction) => Promise<T>) =>
            this.ctx.storage.transaction(tx => fn(new Proxy(tx, {
              get(target, key) {
                if (key === 'put') return async (name: string, value: unknown) => {
                  if (name.startsWith('paper-replay:outbox:')) throw new Error('test rollback')
                  await target.put(name, value)
                }
                const value = Reflect.get(target, key, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            }))),
        }
        const ledger = new PortfolioReplayLedger(failureStore, this.ctx.id.name ?? null)
        return Response.json(await ledger.apply(await request.json<ReplayFill>()))
      }
      if (path==='/halt') return Response.json(await this.ledger.halt('fixture-portfolio'))
      if (path==='/outbox') return Response.json(await this.ledger.outboxPage(Number(new URL(request.url).searchParams.get('after') ?? '0')))
      if (path==='/snapshot') return Response.json(await this.ledger.snapshot())
      return super.fetch()
    } catch {
      return Response.json({error:'fixture_rejected'},{status:409})
    }
  }
}
export default { fetch: () => new Response('Local test fixture', {status:404}) }
