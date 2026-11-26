import { probeTestnetDepth } from './depth-testnet-probe'

const result = await probeTestnetDepth({
  openSocket: url => new WebSocket(url),
  fetchSnapshot: fetch,
  now: Date.now,
})
console.log(JSON.stringify({observedAt: new Date().toISOString(), ...result}))
if (result.status !== 'sequence_observed') process.exitCode = 1
