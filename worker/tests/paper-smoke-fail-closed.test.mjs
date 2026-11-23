import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const smokeUrl = new URL('../scripts/smoke-check.mjs', import.meta.url).href

function runSmoke(payload) {
  const program = `
    globalThis.fetch = async (_url, options) => {
      if (options.redirect !== 'error' || !options.signal) throw new Error('unsafe fetch options');
      return new Response(JSON.stringify(${JSON.stringify(payload)}), { status: 200 });
    };
    await import(${JSON.stringify(smokeUrl)});
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 10_000,
  })
}

test('smoke fails closed on unsafe runtime and never logs provider response body', () => {
  const secret = 'FAKE_SECRET_MUST_NOT_APPEAR'
  const result = runSmoke({ trading_mode: 'paper', allow_mainnet: false, live_trading_enabled: true, secret })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL GET \/runtime\/status/)
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_SECRET_MUST_NOT_APPEAR/)
  assert.match(result.stderr, /body withheld from logs/)
})

test('smoke rejects missing withdrawal and live-mode locks', () => {
  const result = runSmoke({ trading_mode: 'paper', exchange_mode: 'paper', network: 'testnet', allow_mainnet: false })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL GET \/runtime\/status/)
})


test('smoke rejects oversized response without exposing its content', () => {
  const secret = 'FAKE_OVERSIZED_SECRET_MUST_NOT_APPEAR'
  const result = runSmoke({ secret, filler: 'x'.repeat(70_000) })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /request or response rejected/)
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_OVERSIZED_SECRET_MUST_NOT_APPEAR/)
})

test('smoke handles failed requests without leaking provider error messages', () => {
  const program = `globalThis.fetch = async () => { throw new Error('FAKE_PROVIDER_SECRET'); }; await import(${JSON.stringify(smokeUrl)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_PROVIDER_SECRET/)
  assert.match(result.stdout, /FAIL GET \/healthz/)
})
