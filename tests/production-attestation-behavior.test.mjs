import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/verify-production-attestation.mjs', import.meta.url))
const worker = 'https://crypto-signal-bot-api.analyzer-d94.workers.dev'
const marker = 'FIXTURE_PRIVATE_ATTESTATION_SENTINEL'
const release = { attestation_path: '/api/release-attestation', management_api_path: '/v1/management', backend_url: worker }
const attestation = {
  ok: true, worker, execution: { primary: 'btcc', secondary: 'bitget' },
  safety: { trading_mode: 'paper', network: 'testnet', allow_mainnet: false, live_trading_enabled: false, withdrawals_enabled: false, provider_mutation_enabled: false, real_funds_enabled: false },
  storage: { d1_status: 'healthy', agent_memory_available: true },
  management: { route_present: true, identity_provider_configured: true, authentication_enforced: true, anonymous_status: 401, anonymous_code: 'UNAUTHENTICATED' },
  failures: [],
}

async function exercise(fault) {
  let redirected = 0
  const server = createServer((req, res) => {
    if (req.url === '/release.json') {
      if (fault === 'manifest') return res.end(JSON.stringify({ ...release, backend_url: marker }))
      return res.end(JSON.stringify(release))
    }
    if (req.url === '/redirect-target') { redirected++; return res.end(marker) }
    if (req.url !== '/api/release-attestation') { res.writeHead(404); return res.end() }
    if (fault === 'redirect') { res.writeHead(302, { location: '/redirect-target' }); return res.end() }
    if (fault === 'declared') { res.writeHead(200, { 'content-length': 70000 }); return res.end(marker + 'x'.repeat(70000 - marker.length)) }
    if (fault === 'streamed') { res.writeHead(200); res.write('x'.repeat(40000)); return res.end(marker + 'x'.repeat(30000)) }
    if (fault === 'malformed') return res.end(marker)
    if (fault === 'degraded') return res.end(JSON.stringify({ ...attestation, ok: false, failures: [marker] }))
    if (fault === 'identity') return res.end(JSON.stringify({ ...attestation, management: { ...attestation.management, anonymous_code: marker } }))
    if (fault === 'unsafe') return res.end(JSON.stringify({ ...attestation, safety: { ...attestation.safety, allow_mainnet: true } }))
    res.end(JSON.stringify(attestation))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--frontend', origin], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal, output }))
    })
    return { ...result, redirected }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
test('valid local production attestation passes', async () => {
  const result = await exercise()
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /Production attestation verified/)
})
for (const fault of ['manifest', 'redirect', 'declared', 'streamed', 'malformed', 'degraded', 'identity', 'unsafe']) {
  test('attestation rejects ' + fault + ' without response disclosure', async () => {
    const result = await exercise(fault)
    assert.equal(result.signal, null)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /Production attestation failed/)
    assert.ok(!result.output.includes(marker), 'fixture content disclosed')
    assert.equal(result.redirected, 0)
    if (['declared', 'streamed'].includes(fault)) assert.match(result.output, /response exceeds size limit/)
  })
}
