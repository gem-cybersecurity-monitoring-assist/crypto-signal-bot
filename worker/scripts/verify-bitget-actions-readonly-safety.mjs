import { readFileSync } from 'node:fs'
import { dirname,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const workflow=readFileSync(resolve(root,'.github/workflows/bitget-uta-readonly-certification.yml'),'utf8')
const script=readFileSync(resolve(root,'worker/scripts/run-bitget-actions-readonly.mjs'),'utf8')
const paper=readFileSync(resolve(root,'worker/src/index.ts'),'utf8')
const live=readFileSync(resolve(root,'worker/src/index_live_candidate.ts'),'utf8')
const missing=[]
for(const [src,needle,why] of [
 [workflow,'workflow_dispatch:','must be manual dispatch only'],
 [workflow,'contents: read','must have read-only GitHub permissions'],
 [workflow,'environment: bitget-readonly-certification','must require protected environment'],
 [workflow,'refs/heads/main','must be restricted to reviewed main'],
 [workflow,'"${GITHUB_REF_PROTECTED:-false}" != "true"','must fail closed when main has no protection'],
 [workflow,'acknowledge_read_only','must require owner read-only acknowledgement'],
 [workflow,'BITGET_CERT_API_KEY: ${{ secrets.BITGET_CERT_API_KEY }}','must use GitHub secret binding'],
 [workflow,'BITGET_CERT_API_SECRET: ${{ secrets.BITGET_CERT_API_SECRET }}','must use GitHub secret binding'],
 [workflow,'BITGET_CERT_API_PASSPHRASE: ${{ secrets.BITGET_CERT_API_PASSPHRASE }}','must use GitHub secret binding'],
 [script,'enforceProviderGetOnly','must wrap outbound provider fetch'],
 [script,"init?.method !== 'GET'",'must reject any write method'],
 [script,'BITGET_V3_API_ORIGIN','must pin host to official Bitget HTTPS'],
 [script,'routePrivateBitgetCertification','must reuse reviewed private certification service'],
 [script,'PRIVATE_READONLY_PROVIDER_VERIFICATION_FAILED','must fail closed without provider error text'],
 [script,'evidence.executionAllowed !== false','must verify disabled live execution'],
 [script,'evidence.withdrawalAllowed !== false','must verify withdrawals are locked'],
]) if(!src.includes(needle)) missing.push(why)
if(/^\s*(?:schedule|pull_request|push):/m.test(workflow)) missing.push('must not auto-run with provider secrets')
if(/\b(?:wrangler deploy|ALLOW_MAINNET: true|LIVE_EXECUTION_ENABLED: true|WITHDRAWALS_ENABLED: true)\b/.test(workflow)) missing.push('no deployment/financial switch permitted')
if(/run-bitget-actions-readonly/.test(paper+live)) missing.push('read-only CLI must never be a production entrypoint')
if(missing.length){
 console.error('Bitget GitHub read-only lane safety failed:')
 missing.forEach(x=>console.error('- '+x))
 process.exitCode=1
}else console.log('Bitget GitHub Actions read-only lane safety verified')
