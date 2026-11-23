import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const endpoints = read('worker/src/live/adapters/bitget/v3/endpoints-v3.ts')
const client = read('worker/src/live/adapters/bitget/v3/read-only-client-v3.ts')
const service = read('worker/src/live/bitget-private-certification-service.ts')
const config = read('wrangler.provider-certification.toml')
const paper = read('worker/src/index.ts')
const live = read('worker/src/index_live_candidate.ts')
const errors = []
const requireText = (text, needle, message) => { if (!text.includes(needle)) errors.push(message) }
for (const [source, needle, message] of [
  [endpoints, "accountInfo: '/api/v3/account/info'", 'UTA account identity endpoint missing'],
  [endpoints, "orderHistory: '/api/v3/trade/history-orders'", 'UTA order-history endpoint missing'],
  [endpoints, "method.trim().toUpperCase() !== 'GET'", 'UTA client must use GET only'],
  [client, "info.permType !== 'read-only'", 'UTA permission scope must be read-only'],
  [client, "authorities.includes('uta_trade')", 'UTA trade(read) permission check missing'],
  [client, "a === 'uta_trade' || a === 'uta_mgt'", 'UTA privilege allowlist missing'],
  [client, "accountMode !== 'hybrid'", 'UTA account-mode gate missing'],
  [client, "this.request(BITGET_V3_ENDPOINTS.accountInfo)", 'separate key-permission request missing'],
  [client, "this.request(BITGET_V3_ENDPOINTS.accountSettings)", 'separate account-mode request missing'],
  [client, "BITGET_V3_ENDPOINTS.orderHistory", 'UTA order-history GET missing'],
  [service, "/internal/bitget/uta/inspect", 'private UTA inspection route missing'],
  [service, "/internal/bitget/uta/certify", 'private UTA certification route missing'],
  [service, 'const permissions = await v3.verifyReadOnlyPermissions()', 'UTA permissions not reloaded before collecting account data'],
  [service, 'accountRefHash !== command.expectedAccountRefHash', 'identity mismatch guard missing'],
  [service, "contract = 'BITGET_CLASSIC_SPOT_V2'", 'Classic route compatibility missing'],
  [service, "'BITGET_UTA_V3'", 'UTA version marker missing'],
  [service, "executionAllowed: false", 'UTA certification must never grant execution'],
  [service, "withdrawalAllowed: false", 'UTA certification must never grant withdrawals'],
]) requireText(source, needle, message)

for (const file of [
  'worker/src/index.ts',
  'worker/src/index_live_candidate.ts',
  'worker/src/index_withdrawals_candidate.ts',
  'worker/src/index_bitget_trade_quarantine.ts',
]) {
  const text = fs.existsSync(path.join(root, file)) ? read(file) : ''
  if (/bitget-private-certification-service|index_provider_certification|adapters\/bitget\/v3\//.test(text)) {
    errors.push('private UTA certification must not become a public or live candidate route')
  }
}
if (!/workers_dev = false/.test(config) || !/preview_urls = false/.test(config)
  || /\[\[routes\]\]|\[triggers\]|\[\[d1_databases\]\]|BITGET_TRADE_|BITGET_WITHDRAW/.test(config)) {
  errors.push('private provider certification exposure or financial binding detected')
}
for (const script of [endpoints, client]) {
  if (/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\bcreateOrder\s*\(|\bsubmitOrder\s*\(/i.test(script)) {
    errors.push('UTA read-only client contains a provider write path')
  }
}
if (/bitget-private-certification-service|adapters\/bitget\/v3\//.test(paper+live)) {
  errors.push('production paper/live route unexpectedly bound to provider certification')
}
if (errors.length) {
  console.error('Bitget V3 private certification safety verification failed:')
  errors.forEach(e => console.error('- '+e))
  process.exitCode = 1
} else console.log('Bitget V3 private certification safety verification passed.')
