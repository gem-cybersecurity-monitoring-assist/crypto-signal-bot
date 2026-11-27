import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../scripts/verify-deployed-paper-release.mjs', import.meta.url), 'utf8')
test('deployment verifier bounds streamed and declared response sizes', () => {
  assert.match(source, /MAX_RESPONSE_BYTES = 64 \* 1024/)
  assert.match(source, /declared > MAX_RESPONSE_BYTES/)
  assert.match(source, /bytes > MAX_RESPONSE_BYTES/)
  assert.match(source, /reader\.cancel\(\)/)
})
test('deployment verifier rejects redirects and uses timeouts', () => {
  assert.match(source, /redirect: 'error'/)
  assert.match(source, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/)
})
test('deployment verifier redacts unexpected response and transport details', () => {
  assert.doesNotMatch(source, /text\.slice\(/)
  assert.doesNotMatch(source, /JSON\.stringify\(body\)/)
  assert.doesNotMatch(source, /error\.message\s*:\s*String\(error\)/)
  assert.match(source, /verification failed \(details redacted\)/)
})
