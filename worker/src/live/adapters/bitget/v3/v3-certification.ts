/**
 * Bitget UTA V3 read-only certification harness.
 *
 * Runs the step-1 certification checks against a `BitgetV3ReadOnlyClient`
 * (mock fixtures shaped from the UTA docs, or the live read-only endpoints
 * once Gem provides a read-only UTA key). Every check records PASS / FAIL /
 * BLOCKED with an evidence hash, runId, and measured latency.
 *
 * This harness can never certify anything for live execution: the result type
 * hardcodes certifiedForLive/providerMutationAllowed/executionAllowed (and
 * friends) to false, mirroring the V2 certification result shape.
 */
import { canonicalHash } from '../../../canonical-json.ts'
import {
  assertBitgetV3ReadOnlyRequest,
  BITGET_V3_ENDPOINTS,
} from './endpoints-v3.ts'
import {
  BitgetV3ReadOnlyAdapter,
  type BitgetV3PositionSnapshot,
  type BitgetV3UnifiedAccountSnapshot,
} from './normalizer-v3.ts'
import type {
  BitgetV3AccountPermissions,
  BitgetV3ReadOnlyEndpoint,
} from './read-only-client-v3.ts'
import type { ExchangeProduct } from '../../../exchange-contracts.ts'

export type BitgetV3CertificationCheckStatus = 'PASS' | 'FAIL' | 'BLOCKED'
export type BitgetV3CertificationStatus = 'PASSED' | 'FAILED' | 'BLOCKED'

export interface BitgetV3ReadOnlyCertificationClient {
  verifyReadOnlyPermissions(): Promise<BitgetV3AccountPermissions>
  getAccountAssets(): Promise<unknown>
  getCurrentPositions(
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
  getInstruments(category: unknown, symbol?: unknown): Promise<unknown>
  getOrderHistory(symbol?: unknown): Promise<unknown>
  request(
    endpoint: BitgetV3ReadOnlyEndpoint,
    query?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): Promise<unknown>
}

export interface BitgetV3ReadOnlyCertificationInput {
  runId: string
  exchangeAccountId: string
  productId: string
  observedAt: string
  productExpiresAt: string
  evaluatedAt: string
  client: BitgetV3ReadOnlyCertificationClient
  adapter?: BitgetV3ReadOnlyAdapter
  expectedPermissions?: BitgetV3AccountPermissions
}

export interface BitgetV3ReadOnlyCertificationCheck {
  name:
    | 'READ_ONLY_PERMISSIONS'
    | 'ACCOUNT_ASSETS_CONTRACT'
    | 'POSITION_CONTRACT'
    | 'INSTRUMENTS_CONTRACT'
    | 'ORDER_HISTORY_CONTRACT'
    | 'READ_ONLY_ENFORCEMENT'
  status: BitgetV3CertificationCheckStatus
  reason: string | null
  latencyMs: number
  evidenceHash: string
}

export interface BitgetV3ReadOnlyCertificationResult {
  runId: string
  provider: 'BITGET'
  apiVersion: 'V3'
  exchangeAccountId: string
  status: BitgetV3CertificationStatus
  checks: readonly BitgetV3ReadOnlyCertificationCheck[]
  evaluatedAt: string
  evidenceHash: string
  unifiedAccountSnapshot: BitgetV3UnifiedAccountSnapshot | null
  positionCount: number
  productCount: number
  certifiedForLive: false
  providerMutationAllowed: false
  automaticRetryAllowed: false
  transferAllowed: false
  withdrawalAllowed: false
  executionAllowed: false
  credentialsPersisted: false
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${field} is required`)
  return normalized
}

async function timed<T>(
  name: BitgetV3ReadOnlyCertificationCheck['name'],
  fn: () => Promise<{ reason: string | null; evidence: unknown }>,
): Promise<BitgetV3ReadOnlyCertificationCheck> {
  const started = Date.now()
  try {
    const { reason, evidence } = await fn()
    return {
      name,
      status: 'PASS',
      reason,
      latencyMs: Date.now() - started,
      evidenceHash: await canonicalHash({ name, evidence }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      name,
      status: message.includes('BLOCKED') ? 'BLOCKED' : 'FAIL',
      reason: message,
      latencyMs: Date.now() - started,
      evidenceHash: await canonicalHash({ name, failure: message }),
    }
  }
}

export async function runBitgetV3ReadOnlyCertification(
  input: BitgetV3ReadOnlyCertificationInput,
): Promise<BitgetV3ReadOnlyCertificationResult> {
  const runId = requiredText(input.runId, 'runId')
  const exchangeAccountId = requiredText(input.exchangeAccountId, 'exchangeAccountId')
  const productId = requiredText(input.productId, 'productId')
  if (!/^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/.test(productId)) {
    throw new TypeError('Bitget UTA productId must be BASE-QUOTE uppercase')
  }
  const [baseAsset, quoteAsset] = productId.split('-')
  if (baseAsset === quoteAsset) throw new TypeError('Bitget UTA productId must contain different assets')
  const symbol = `${baseAsset}${quoteAsset}`
  const adapter = input.adapter ?? new BitgetV3ReadOnlyAdapter()
  let unifiedAccountSnapshot: BitgetV3UnifiedAccountSnapshot | null = null
  let positionCount = 0
  let productCount = 0
  let positions: readonly BitgetV3PositionSnapshot[] = Object.freeze([])
  let products: readonly ExchangeProduct[] = Object.freeze([])

  // The permission check must settle before any account-data call is scheduled.
  // Promise.all on all six checks would leak read attempts even for invalid keys.
  const permissionCheck = await timed('READ_ONLY_PERMISSIONS', async () => {
      const permissions = await input.client.verifyReadOnlyPermissions()
      if (permissions.readOnly !== true
        || !['hybrid', 'unified'].includes(permissions.accountMode)
        || permissions.permissionsVerified !== true
        || typeof permissions.userId !== 'string' || !permissions.userId.trim()
        || !Array.isArray(permissions.authorities)
        || !permissions.authorities.includes('uta_trade')
        || !permissions.authorities.every(scope => scope === 'uta_trade' || scope === 'uta_mgt')) {
        throw new Error('V3 API key and UTA account family have not been verified')
      }
      const expected = input.expectedPermissions
      if (expected && (
        permissions.userId !== expected.userId
        || permissions.accountMode !== expected.accountMode
        || JSON.stringify([...permissions.authorities].sort()) !== JSON.stringify([...expected.authorities].sort())
      )) {
        throw new Error('V3 certification permission identity changed')
      }
      return {
        reason: null,
        evidence: { userId: permissions.userId, accountMode: permissions.accountMode },
      }
  })

  const downstreamChecks: readonly BitgetV3ReadOnlyCertificationCheck[] =
    permissionCheck.status === 'PASS' ? await Promise.all([
    timed('ACCOUNT_ASSETS_CONTRACT', async () => {
      const raw = await input.client.getAccountAssets()
      unifiedAccountSnapshot = adapter.normalizeUnifiedAccount(raw, input.observedAt)
      return {
        reason: null,
        evidence: {
          balanceCount: unifiedAccountSnapshot.balances.length,
          accountEquityUsd: unifiedAccountSnapshot.accountEquityUsd,
        },
      }
    }),
    timed('POSITION_CONTRACT', async () => {
      const raw = await input.client.getCurrentPositions()
      positions = adapter.normalizePositionList(raw)
      positionCount = positions.length
      return {
        reason: null,
        evidence: {
          positionCount,
          productIds: positions.map((position) => position.productId),
        },
      }
    }),
    timed('INSTRUMENTS_CONTRACT', async () => {
      const raw = await input.client.getInstruments('SPOT', symbol)
      const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const rows = root.data
      if (root.code !== '00000' || !Array.isArray(rows) || rows.length !== 1) {
        throw new Error('Bitget UTA requested Spot product instrument is missing or ambiguous')
      }
      if (!rows[0] || typeof rows[0] !== 'object' || (rows[0] as Record<string, unknown>).category !== 'SPOT') {
        throw new Error('Bitget UTA requested instrument is not a Spot instrument')
      }
      products = Object.freeze(
        rows.map((row) =>
          adapter.normalizeProduct(row, input.observedAt, input.productExpiresAt),
        ),
      )
      if (products[0].productId !== productId || products[0].tradingEnabled !== true) {
        products = Object.freeze([])
        throw new Error('Bitget UTA requested Spot product is unavailable or non-trading')
      }
      productCount = products.length
      return {
        reason: null,
        evidence: {
          productCount,
          productIds: products.map((product) => product.productId),
        },
      }
    }),
    timed('ORDER_HISTORY_CONTRACT', async () => {
      const raw = await input.client.getOrderHistory(symbol)
      const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {}
      const rows = data.list
      if (root.code !== '00000' || !Array.isArray(rows) || rows.length > 10) {
        throw new Error('Bitget V3 order-history contract is unavailable or malformed')
      }
      // The client requests at most ten Spot history rows; this is a sample, not reconciliation.
      const orderIds = new Set<string>()
      for (const row of rows) {
        const order = row && typeof row === 'object' ? row as Record<string, unknown> : {}
        if (order.category !== 'SPOT' || typeof order.orderId !== 'string' || !order.orderId.trim()
          || order.orderId !== order.orderId.trim() || order.orderId.length > 128
          || order.symbol !== symbol || orderIds.has(order.orderId)) {
          throw new Error('Bitget V3 order-history contains an unscoped, duplicate or invalid SPOT record')
        }
        orderIds.add(order.orderId)
      }
      return { reason: null, evidence: { spotOrderHistoryCount: rows.length,
        symbol, sampledOrderIdentityHash: await canonicalHash([...orderIds].sort()) } }
    }),
    timed('READ_ONLY_ENFORCEMENT', async () => {
      let rejected = 0
      try {
        assertBitgetV3ReadOnlyRequest('POST', BITGET_V3_ENDPOINTS.accountAssets)
      } catch {
        rejected += 1
      }
      try {
        assertBitgetV3ReadOnlyRequest('GET', '/api/v3/trade/place-order')
      } catch {
        rejected += 1
      }
      try {
        assertBitgetV3ReadOnlyRequest('DELETE', BITGET_V3_ENDPOINTS.currentPositions)
      } catch {
        rejected += 1
      }
      if (rejected !== 3) throw new Error('read-only enforcement rejected fewer than expected')
      return { reason: null, evidence: { rejected } }
    }),
  ]) : await Promise.all(([
    'ACCOUNT_ASSETS_CONTRACT', 'POSITION_CONTRACT', 'INSTRUMENTS_CONTRACT',
    'ORDER_HISTORY_CONTRACT', 'READ_ONLY_ENFORCEMENT',
  ] as const).map(async (name): Promise<BitgetV3ReadOnlyCertificationCheck> => ({
    name,
    status: 'BLOCKED',
    reason: 'READ_ONLY_PERMISSIONS_NOT_VERIFIED',
    latencyMs: 0,
    evidenceHash: await canonicalHash({ name, blockedBy: 'READ_ONLY_PERMISSIONS' }),
  })))
  const checks = [permissionCheck, ...downstreamChecks]

  const failed = checks.filter((check) => check.status === 'FAIL')
  const blocked = checks.filter((check) => check.status === 'BLOCKED')
  const status: BitgetV3CertificationStatus =
    failed.length > 0 ? 'FAILED' : blocked.length > 0 ? 'BLOCKED' : 'PASSED'

  return {
    runId,
    provider: 'BITGET',
    apiVersion: 'V3',
    exchangeAccountId,
    status,
    checks: Object.freeze(checks),
    evaluatedAt: input.evaluatedAt,
    evidenceHash: await canonicalHash({
      runId,
      status,
      checks: checks.map((check) => ({
        name: check.name,
        status: check.status,
        evidenceHash: check.evidenceHash,
      })),
    }),
    unifiedAccountSnapshot,
    positionCount,
    productCount,
    certifiedForLive: false,
    providerMutationAllowed: false,
    automaticRetryAllowed: false,
    transferAllowed: false,
    withdrawalAllowed: false,
    executionAllowed: false,
    credentialsPersisted: false,
  }
}
