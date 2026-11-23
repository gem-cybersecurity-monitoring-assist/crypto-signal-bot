import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { routePrivateBitgetCertification } from '../src/live/bitget-private-certification-service.ts'
import {
  BITGET_V3_API_ORIGIN, BITGET_V3_ENDPOINTS, isBitgetV3PrivateReadEndpoint,
} from '../src/live/adapters/bitget/v3/endpoints-v3.ts'

const ID = /^[A-Za-z0-9:._-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const PRODUCT = /^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/
const SAFE_READ_PATH = BITGET_V3_ENDPOINTS.instruments

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PRIVATE_READONLY_${label}_UNCONFIGURED`)
  }
  return value
}
function validateInputs(env) {
  const mode = required(env.GEM_CERT_MODE, 'MODE')
  if (!['inspect','certify'].includes(mode)) throw new Error('PRIVATE_READONLY_MODE_INVALID')
  const accountId = required(env.GEM_CERT_ACCOUNT_REF, 'ACCOUNT_REF')
  if (!ID.test(accountId)) throw new Error('PRIVATE_READONLY_ACCOUNT_REF_INVALID')
  const productId = required(env.GEM_CERT_PRODUCT_ID, 'PRODUCT')
  if (!PRODUCT.test(productId)) throw new Error('PRIVATE_READONLY_PRODUCT_INVALID')
  const [base, quote] = productId.split('-')
  if (base === quote || base.length + quote.length > 30) {
    throw new Error('PRIVATE_READONLY_PRODUCT_INVALID')
  }
  const hash = env.GEM_CERT_EXPECTED_HASH ?? ''
  if (mode === 'certify' && !HASH.test(hash)) {
    throw new Error('PRIVATE_READONLY_EXPECTED_HASH_REQUIRED')
  }
  const runId = 'actions-readonly-' + String(env.GITHUB_RUN_ID ?? 'local').slice(0, 45)
  if (!ID.test(runId)) throw new Error('PRIVATE_READONLY_RUN_ID_INVALID')
  return { mode, accountId, productId, hash, runId }
}
export function enforceProviderGetOnly(fetcher) {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== BITGET_V3_API_ORIGIN
      || init?.method !== 'GET'
      || !(isBitgetV3PrivateReadEndpoint(url.pathname) || url.pathname === SAFE_READ_PATH)
      || init?.redirect !== 'error') {
      throw new Error('PRIVATE_READONLY_PROVIDER_NETWORK_DENIED')
    }
    return fetcher(input, init)
  }
}

/**
 * Dedicated ephemeral GitHub Actions certification lane. No Cloudflare deploy,
 * persistent credentials, provider writes, real-money permissions or retries.
 * The existing private Worker service is invoked in memory, not via HTTP.
 */
export async function runManualBitgetReadOnlyCertification({
  env, fetcher, clock = Date.now, tokenFactory = () => randomBytes(32).toString('hex'),
}) {
  const values = validateInputs(env)
  if (env.GEM_CERT_ACKNOWLEDGED !== 'true') throw new Error('PRIVATE_READONLY_OWNER_ACK_REQUIRED')
  const apiKey = required(env.BITGET_CERT_API_KEY, 'API_KEY')
  const apiSecret = required(env.BITGET_CERT_API_SECRET, 'API_SECRET')
  const apiPassphrase = required(env.BITGET_CERT_API_PASSPHRASE, 'API_PASSPHRASE')
  const token = tokenFactory()
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new Error('PRIVATE_READONLY_TOKEN_GENERATION_INVALID')
  }
  const requestBody = values.mode === 'certify' ? {
    runId: values.runId,
    exchangeAccountId: values.accountId,
    expectedAccountRefHash: values.hash,
    productId: values.productId,
  } : undefined
  const request = new Request(
    'https://isolated-private-runner.invalid/internal/bitget/uta/' + values.mode,
    {
      method:'POST',
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      ...(requestBody ? { body:JSON.stringify(requestBody) } : {}),
    },
  )
  const response = await routePrivateBitgetCertification(request, {
    CERTIFICATION_RUNNER_TOKEN:token,
    BITGET_CERT_API_KEY:{get:async()=>apiKey},
    BITGET_CERT_API_SECRET:{get:async()=>apiSecret},
    BITGET_CERT_API_PASSPHRASE:{get:async()=>apiPassphrase},
  }, {fetcher:enforceProviderGetOnly(fetcher),clock})
  // Do not print raw provider responses, service failure details or secret values.
  if (response.status !== 200) throw new Error('PRIVATE_READONLY_PROVIDER_VERIFICATION_FAILED')
  const evidence = await response.json()
  if (evidence?.contract !== 'BITGET_UTA_V3'
    || evidence.executionAllowed !== false
    || evidence.withdrawalAllowed !== false
    || evidence.certifiedForLive !== false
    || evidence.providerMutationAllowed !== false
    || evidence.automaticRetryAllowed !== false
    || evidence.accountModelVerified !== true
    || !HASH.test(evidence.accountRefHash ?? '')) {
    throw new Error('PRIVATE_READONLY_SAFETY_EVIDENCE_INVALID')
  }
  if (values.mode === 'inspect') {
    if (evidence.code !== 'CERTIFICATION_IDENTITY_INSPECTED'
      || evidence.permissionsVerified !== true) {
      throw new Error('PRIVATE_READONLY_INSPECTION_INCOMPLETE')
    }
    return Object.freeze({
      mode:values.mode, status:'INSPECTED',
      accountRefHash:evidence.accountRefHash,
      accountModel:evidence.accountModel,
      certifiedForLive:false, executionAllowed:false,
    })
  }
  const checks = evidence.result?.checks
  if (evidence.code !== 'CERTIFICATION_CONTRACTS_EVALUATED'
    || evidence.result?.status !== 'PASSED'
    || !Array.isArray(checks) || checks.length < 6
    || !checks.every(c => c.status === 'PASS' && HASH.test(c.evidenceHash ?? ''))
    || !HASH.test(evidence.result?.evidenceHash ?? '')) {
    throw new Error('PRIVATE_READONLY_CERTIFICATION_CHECKS_FAILED')
  }
  return Object.freeze({
    mode:values.mode,status:'READ_ONLY_CHECKS_PASSED',
    accountRefHash:evidence.accountRefHash,
    accountModel:evidence.accountModel,
    checks:checks.map(c => Object.freeze({name:c.name,status:c.status,evidenceHash:c.evidenceHash})),
    evidenceHash:evidence.result.evidenceHash,
    certifiedForLive:false,executionAllowed:false,
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runManualBitgetReadOnlyCertification({
      env:process.env, fetcher:fetch, clock:Date.now,
    })
    // Outputs are hashes and non-sensitive status only, never raw balances/UID.
    const lines = [
      '### GEM Crypto Signal Bot — private Bitget read-only check',
      '- Mode: ' + result.mode,
      '- Result: ' + result.status,
      '- UTA account model: ' + result.accountModel,
      '- Account reference SHA-256: `' + result.accountRefHash + '`',
      '- Trading authorized: **No**',
      '- Withdrawals authorized: **No**',
      ...(result.evidenceHash ? ['- Certification evidence SHA-256: `'+result.evidenceHash+'`'] : []),
      ...(result.checks ? ['- Passed read-only checks: '+result.checks.length] : []),
      '',
      'Provider read-only contract checks are not a live-trading release approval.',
    ]
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n')
    console.log('BITGET_READ_ONLY_'+result.status)
  } catch {
    console.error('BITGET_READ_ONLY_FAILED_CLOSED: inspect restricted API key permissions, account scope, provider availability and input configuration. No trades were placed.')
    process.exitCode=1
  }
}
