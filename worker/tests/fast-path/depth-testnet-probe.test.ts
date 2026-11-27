import { describe, expect, it, vi } from 'vitest'
import { probeTestnetDepth, SNAPSHOT, STREAM } from '../../scripts/depth-testnet-probe'

const now = 1700000000000
class FakeSocket extends EventTarget {
  close = vi.fn()
  open() { this.dispatchEvent(new Event('open')) }
  send(id: number) {
    this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
      e:'depthUpdate',s:'BTCUSDT',E:now,U:id,u:id,b:[['100','1']],a:[],
    })}))
  }
}
const response = (id: number) => Response.json({lastUpdateId:id,bids:[['100','1']],asks:[['101','1']]})
const turn = () => new Promise(resolve => setTimeout(resolve,0))
function setup(fetchSnapshot = vi.fn(async () => response(101))) {
  const socket = new FakeSocket()
  const openSocket = vi.fn(() => socket as unknown as WebSocket)
  const pending = probeTestnetDepth({openSocket, fetchSnapshot: fetchSnapshot as typeof fetch, now: () => now}, 100)
  return {socket,openSocket,fetchSnapshot,pending}
}
describe('one-shot testnet depth probe', () => {
  it('waits for a bridge and a subsequent event, then closes', async () => {
    const t = setup()
    t.socket.open()
    t.socket.send(101)
    await turn()
    expect(t.openSocket).toHaveBeenCalledExactlyOnceWith(STREAM)
    expect(t.fetchSnapshot).toHaveBeenCalledExactlyOnceWith(SNAPSHOT, expect.objectContaining({method:'GET',redirect:'error',credentials:'omit'}))
    t.socket.send(102)
    t.socket.send(103)
    expect(await t.pending).toMatchObject({status:'sequence_observed',socketOpened:true,snapshotReceived:true,bridgeVerified:true,subsequentObservation:true,lastSequence:103,executionAuthorized:false,providerAccountCertified:false})
    expect(t.socket.close).toHaveBeenCalledOnce()
  })
  it('does not retry a denied HTTP snapshot', async () => {
    const t = setup(vi.fn(async () => new Response('',{status:451})))
    t.socket.open()
    t.socket.send(101)
    expect(await t.pending).toMatchObject({status:'snapshot_unavailable',bridgeVerified:false,snapshotRequested:true,snapshotHttpStatus:451,snapshotFailure:'access_denied'})
    expect(t.fetchSnapshot).toHaveBeenCalledOnce()
    expect(t.socket.close).toHaveBeenCalledOnce()
  })
  it('fails a sequence gap without claiming bridge completion', async () => {
    const t = setup(vi.fn(async () => response(99)))
    t.socket.open()
    t.socket.send(101)
    expect(await t.pending).toMatchObject({status:'snapshot_bridge_unverified',bridgeVerified:false})
  })
  it('closes and aborts on deadline without claiming provider evidence', async () => {
    const t = setup()
    expect(await t.pending).toMatchObject({status:'deadline_exceeded',socketOpened:false,bridgeVerified:false})
    expect(t.socket.close).toHaveBeenCalledOnce()
    expect(t.fetchSnapshot).not.toHaveBeenCalled()
  })
  it('rejects socket error without fetching or reconnecting', async () => {
    const t = setup()
    t.socket.dispatchEvent(new Event('error'))
    expect(await t.pending).toMatchObject({status:'socket_unavailable',socketOpened:false})
    expect(t.fetchSnapshot).not.toHaveBeenCalled()
    expect(t.openSocket).toHaveBeenCalledOnce()
  })
})

describe('sanitized snapshot diagnostics', () => {
  it.each([
    [429, 'rate_limited'], [403, 'access_denied'], [503, 'http_unavailable'],
    [302, 'redirect_rejected'], [200, 'unexpected_content_type'],
  ])('classifies HTTP %i without returning provider text', async (status, failure) => {
    const t = setup(vi.fn(async () => new Response('private provider text', {status})))
    t.socket.open()
    t.socket.send(101)
    const result = await t.pending
    expect(result).toMatchObject({snapshotHttpStatus:status,snapshotFailure:failure,bridgeVerified:false})
    expect(JSON.stringify(result)).not.toContain('private provider text')
    expect(t.fetchSnapshot).toHaveBeenCalledOnce()
  })
  it('classifies a network failure using only an allowlisted cause', async () => {
    const t = setup(vi.fn(async () => {throw new TypeError('private host detail',{cause:{code:'ENOTFOUND'}})}))
    t.socket.open()
    t.socket.send(101)
    const result = await t.pending
    expect(result).toMatchObject({snapshotHttpStatus:null,snapshotFailure:'dns_unavailable'})
    expect(JSON.stringify(result)).not.toContain('private host detail')
  })
  it('reports invalid JSON without copying body text', async () => {
    const t = setup(vi.fn(async () => new Response('bad json private detail',{headers:{'content-type':'application/json'}})))
    t.socket.open()
    t.socket.send(101)
    expect(await t.pending).toMatchObject({status:'snapshot_invalid',snapshotHttpStatus:200,snapshotFailure:'invalid_json'})
  })
  it('reports bounded-body rejection', async () => {
    const t = setup(vi.fn(async () => new Response(' '.repeat(65537),{headers:{'content-type':'application/json'}})))
    t.socket.open()
    t.socket.send(101)
    expect(await t.pending).toMatchObject({status:'snapshot_unavailable',snapshotFailure:'body_too_large'})
  })
  it('classifies a pending request at deadline', async () => {
    const t = setup(vi.fn(async () => new Promise<Response>(() => {})))
    t.socket.open()
    t.socket.send(101)
    expect(await t.pending).toMatchObject({status:'deadline_exceeded',snapshotRequested:true,snapshotFailure:'deadline_exceeded'})
    expect(t.fetchSnapshot.mock.calls).toHaveLength(1)
  })
})
