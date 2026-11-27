import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/verify-deployed-paper-release.mjs', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../public/release.json', import.meta.url), 'utf8'))
const marker = 'FIXTURE_PRIVATE_RESPONSE_SENTINEL'
const locks = {
  trading_mode: 'paper', exchange_mode: 'paper', network: 'testnet',
  allow_mainnet: false, live_trading_enabled: false, withdrawals_enabled: false,
  provider_mutation_enabled: false, real_funds_enabled: false,
  execution_exchange_primary: 'btcc', execution_exchange_secondary: 'bitget',
}
async function exercise(fault) {
  let origin, redirected = 0
  const server = createServer((req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    switch (req.url) {
      case '/release.json':
        if (fault === 'malformed') { res.end(marker); return }
        return json(200, { ...manifest, ...locks, backend_url: origin })
      case '/dashboard':
        if (fault === 'redirect') { res.writeHead(302, { location: '/redirect-target' }); res.end(); return }
        if (fault === 'declared') { res.writeHead(200, { 'content-length': 70000 }); res.end(marker + 'x'.repeat(70000 - marker.length)); return }
        if (fault === 'streamed') { res.writeHead(200); res.write('x'.repeat(40000)); res.end(marker + 'x'.repeat(30000)); return }
        res.end('Crypto Signal Bot V2')
        return
      case '/redirect-target': redirected++; res.end(marker); return
      case '/healthz': return json(200, { ...locks, status: fault === 'health' ? marker : 'ok' })
      case '/runtime/status': return json(200, { ...locks, ...(fault === 'unsafe' ? { allow_mainnet: true } : {}) })
      case '/v2/infrastructure/status': return json(200, { version: '2.0', runtime: locks })
      case '/agent/context': return json(200, { ...locks, certification_mode: true, runtime: { status: 'ok' } })
      case '/agent/memory/release-auth-probe':
      case '/d1/query/readonly': return json(401, { error: 'unauthorized' })
      case '/intent/live':
      case '/live/order':
      case '/withdraw': return json(403, { error: 'disabled' })
      default: return json(404, {})
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = 'http://127.0.0.1:' + server.address().port
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--frontend', origin, '--backend', origin], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
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

test('valid local paper contract passes every verifier check', async () => {
  const result = await exercise()
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /Deployment verification passed: 10\/10/)
})
for (const fault of ['declared', 'streamed', 'redirect', 'malformed', 'health', 'unsafe']) {
  test('verifier fails closed and redacts fixture content: ' + fault, async () => {
    const result = await exercise(fault)
    assert.equal(result.signal, null)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /Deployment verification failed/)
    assert.ok(!result.output.includes(marker), 'unexpected fixture disclosure')
    assert.equal(result.redirected, 0)
    if (fault === 'declared' || fault === 'streamed') assert.match(result.output, /response exceeds size limit/)
  })
}
