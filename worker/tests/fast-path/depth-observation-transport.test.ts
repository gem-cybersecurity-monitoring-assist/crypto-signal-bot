import { describe, expect, it } from 'vitest'
import { DepthObservationTransport } from '../../src/fast-path/depth-observation-transport'
import { FeedHealthRegistry } from '../../src/fast-path/feed-health'
const now = 1700000000000
const delta = (id: number, offset = 10, override = {}) => JSON.stringify({
  e: 'depthUpdate', s: 'BTCUSDT', E: now+offset, U: id, u: id,
  b: [['100','0']], a: [['101','2']], ...override,
})
const snap = (id: number) => JSON.stringify({lastUpdateId:id,bids:[['100','1']],asks:[['101','2']]})
function setup() {
  const transport = new DepthObservationTransport('BTC-USDT', new FeedHealthRegistry())
  const generation = transport.connect(now)
  return {transport,generation}
}
describe('depth observation transport boundary', () => {
  it('replays provider-shaped frames through recovery and observation', () => {
    const {transport,generation} = setup()
    expect(transport.receive(generation,delta(101),now+10)).toBe('buffered')
    expect(transport.snapshot(generation,1,snap(100),now+20)).toBe(true)
    expect(transport.status(now+20).feed?.lastExchangeTsMs).toBeNull()
    expect(transport.receive(generation,delta(102,30),now+30)).toBe('observed')
    expect(transport.status(now+30)).toMatchObject({executionAuthorized:false,providerAuthenticityVerified:false})
  })
  it('rejects callbacks from the prior connection generation', () => {
    const {transport,generation} = setup()
    transport.disconnect(generation,now+10)
    expect(transport.status(now+10).phase).toBe('unavailable')
    const next = transport.connect(now+20)
    expect(transport.receive(generation,delta(101,30),now+30)).toBe('rejected')
    expect(transport.snapshot(generation,2,snap(100),now+30)).toBe(false)
    transport.disconnect(generation,now+30)
    expect(transport.receive(next,delta(101,30),now+30)).toBe('buffered')
    expect(transport.snapshot(next,2,snap(100),now+40)).toBe(true)
  })
  it.each(['{',' '.repeat(65537),delta(101,10,{s:'ETHUSDT'}),delta(101,10,{U:undefined}),
    delta(101,10,{b:[['100junk','1']]}),delta(101,10,{b:[['0','1']]}),
    delta(101,10,{E:1700000000011})])('rejects malformed frames', raw => {
    const {transport,generation} = setup()
    expect(transport.receive(generation,raw,now+10)).toBe('rejected')
    expect(transport.status(now+10).phase).toBe('unavailable')
  })
  it('rejects a malformed snapshot rather than marking recovery healthy', () => {
    const {transport,generation} = setup()
    transport.receive(generation,delta(101),now+10)
    expect(transport.snapshot(generation,1,JSON.stringify({lastUpdateId:100}),now+20)).toBe(false)
    expect(transport.status(now+20).phase).toBe('unavailable')
  })
  it('rejects a receipt clock regression', () => {
    const {transport,generation} = setup()
    transport.receive(generation,delta(101),now+10)
    expect(transport.receive(generation,delta(102),now+9)).toBe('rejected')
    expect(transport.status(now+10).transportConnected).toBe(false)
  })
})
