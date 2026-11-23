import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const file = 'worker/src/live/adapters/bitget/v3/unsigned-candidate-v3.ts'
const source = readFileSync(resolve(root,file),'utf8')
const paper = readFileSync(resolve(root,'worker/src/index.ts'),'utf8')
const live = readFileSync(resolve(root,'worker/src/index_live_candidate.ts'),'utf8')
const failures = []
for (const term of [
  'POST_EVIDENCE_ONLY', 'accountFamilyReviewHash', 'productRules',
  'recoveryLookups', 'no_automatic_retry_of_ambiguous_submission',
  'signingMaterialPresent: false', 'executionAllowed: false',
  'providerMutationAllowed: false', 'mainnetAllowed: false',
  'withdrawalAllowed: false', 'automaticRetryAllowed: false',
  "category: 'SPOT'", '/api/v3/trade/order-info',
]) if (!source.includes(term)) failures.push('Missing source-only UTA guard: '+term)
if (/\b(fetch|XMLHttpRequest|WebSocket|process\.env|signBitgetPrehash|secretKey|apiSecret|axios|crypto\.subtle\.sign)\b/.test(source)) {
  failures.push('V3 unsigned candidate must not import/sign/fetch/reach provider credentials')
}
if (/unsigned-candidate-v3/.test(paper+live)) {
  failures.push('V3 unsigned candidate must not be bound to production or live Worker')
}
if (failures.length) {
  failures.forEach(f=>console.error(f))
  process.exitCode = 1
} else console.log('UTA v3 unsigned candidate isolation verified')
