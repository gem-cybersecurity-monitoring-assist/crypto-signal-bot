import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const smokeUrl = new URL('../scripts/smoke-check.mjs', import.meta.url).href

function runSmoke(payload) {
  const program = `
    globalThis.fetch = async (_url, options) => {
      if (options.redirect !== 'error' || !options.signal) throw new Error('unsafe fetch options');
      return { status: 200, text: async () => JSON.stringify(${JSON.stringify(payload)}) };
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
