import { canonicalHash } from '../../../canonical-json.ts'
import { normalizeBitgetV3Symbol, assertBitgetV3OrderLookupIdentity } from './endpoints-v3.ts'

export type BitgetV3ObservedOrderStatus = 'live' | 'new' | 'partially_filled' | 'filled' | 'cancelled'

export interface BitgetV3OrderInfoReview {
  readonly provider: 'BITGET'
  readonly apiVersion: 'UTA_V3'
  readonly category: 'SPOT'
  readonly productSymbol: string
  readonly status: BitgetV3ObservedOrderStatus
  readonly terminalProviderStatus: boolean
  readonly responseHash: string
  readonly observedIdentityHash: string
  readonly providerMutationAllowed: false
  readonly automaticRetryAllowed: false
  readonly liveExecutionAllowed: false
  readonly ledgerSettlementConfirmed: false
  readonly independentReconciliationRequired: true
  readonly sourceOnly: true
}

const STATUSES = new Set<BitgetV3ObservedOrderStatus>([
  'live', 'new', 'partially_filled', 'filled', 'cancelled',
])
const DIGITS = /^[0-9]{1,64}$/
const CLIENT = /^[A-Za-z0-9:_-]{1,32}$/
const MAX_TIME_MS = 120_000
const MAX_CLOCK_AHEAD_MS = 30_000

/**
 * Source-only evidence check for the read-only GET order-info endpoint.
 * The caller must separately authenticate the account whose key made the GET
 * and verify the live Worker clock. This is never permission to execute/retry.
 */
export async function reviewBitgetV3SpotOrderInfo(input: {
  response: unknown
  expectedIdentity: unknown
  expectedSymbol: string
  evaluatedAtMs: number
}): Promise<BitgetV3OrderInfoReview> {
  const identity = assertBitgetV3OrderLookupIdentity(input.expectedIdentity)
  const symbol = normalizeBitgetV3Symbol(input.expectedSymbol)
  const now = input.evaluatedAtMs
  if (!Number.isSafeInteger(now)) throw new TypeError('evaluatedAtMs must be a safe Unix millisecond timestamp')

  const root = input.response
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new TypeError('Bitget V3 order-info response must be an object')
  }
  const env = root as Record<string, unknown>
  if (env.code !== '00000' || typeof env.requestTime !== 'number'
    || !Number.isSafeInteger(env.requestTime)
    || env.requestTime < 1_000_000_000_000
    || env.requestTime > now + MAX_CLOCK_AHEAD_MS
    || now - env.requestTime > MAX_TIME_MS) {
    throw new TypeError('Bitget V3 order-info response failed success or freshness checks')
  }

  const data = env.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Bitget V3 order-info response has no verified order data')
  }
  const order = data as Record<string, unknown>
  const status = order.orderStatus
  if (order.category !== 'SPOT' || order.symbol !== symbol
    || typeof status !== 'string' || !STATUSES.has(status as BitgetV3ObservedOrderStatus)
    || typeof order.orderId !== 'string' || !DIGITS.test(order.orderId)
    || typeof order.clientOid !== 'string' || !CLIENT.test(order.clientOid)
    || (typeof order.side !== 'string' || !['buy','sell'].includes(order.side))
    || !['limit','market'].includes(String(order.orderType ?? ''))) {
    throw new TypeError('Bitget V3 order-info account/product/status evidence mismatch')
  }
  if ('orderId' in identity && order.orderId !== identity.orderId
    || 'clientOid' in identity && order.clientOid !== identity.clientOid) {
    throw new TypeError('Bitget V3 order-info response identity mismatch')
  }
  const observedIdentityHash = await canonicalHash({
    category:'SPOT', symbol, orderId:order.orderId, clientOid:order.clientOid,
  })
  const responseHash = await canonicalHash({
    observedIdentityHash, status, orderType:order.orderType, side:order.side,
    requestTime:env.requestTime,
    qty:typeof order.qty === 'string' ? order.qty : null,
    amount:typeof order.amount === 'string' ? order.amount : null,
    cumExecQty:typeof order.cumExecQty === 'string' ? order.cumExecQty : null,
    cumExecValue:typeof order.cumExecValue === 'string' ? order.cumExecValue : null,
  })
  return Object.freeze({
    provider:'BITGET' as const, apiVersion:'UTA_V3' as const, category:'SPOT' as const,
    productSymbol:symbol, status:status as BitgetV3ObservedOrderStatus,
    terminalProviderStatus: status === 'filled' || status === 'cancelled',
    responseHash, observedIdentityHash,
    providerMutationAllowed:false as const,
    automaticRetryAllowed:false as const,
    liveExecutionAllowed:false as const,
    ledgerSettlementConfirmed:false as const,
    independentReconciliationRequired:true as const,
    sourceOnly:true as const,
  })
}
