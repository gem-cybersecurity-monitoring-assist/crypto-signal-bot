import { canonicalHash } from '../../../canonical-json.ts'
import type { ProductRules, OrderIntent } from '../../../domain.ts'
import type { OrderPreviewRequest } from '../../../exchange-contracts.ts'
import { validateOrderAgainstProductRules } from '../../../product-rules.ts'
import { normalizeBitgetV3Symbol } from './endpoints-v3.ts'

export const BITGET_V3_ORDER_CANDIDATE_ENDPOINTS = Object.freeze({
  placeOrder: '/api/v3/trade/place-order',
  cancelOrder: '/api/v3/trade/cancel-order',
  orderInfo: '/api/v3/trade/order-info',
} as const)

const HEX64 = /^[a-f0-9]{64}$/
const CLIENT_ID = /^[A-Za-z0-9:_-]{1,64}$/
const PROVIDER_ID = /^[0-9]{1,64}$/
const PRODUCT_ID = /^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/
const LOCKS = Object.freeze({
  providerMutationAllowed: false as const,
  executionAllowed: false as const,
  mainnetAllowed: false as const,
  withdrawalAllowed: false as const,
  automaticRetryAllowed: false as const,
  transportSelected: false as const,
  signingMaterialPresent: false as const,
})
const WARNINGS = Object.freeze([
  'source_only_execution_locked',
  'independent_account_family_certification_required',
  'requires_separate_reviewed_live_transport',
  'no_automatic_retry_of_ambiguous_submission',
] as const)

export type BitgetV3TimeInForce = 'gtc' | 'post_only' | 'ioc' | 'fok'

export interface BitgetV3RecoveryLookup {
  readonly method: 'GET'
  readonly endpoint: typeof BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.orderInfo
  readonly query: Readonly<{ orderId?: string; clientOid?: string }>
}

export interface BitgetV3UnsignedOrderCandidate {
  readonly provider: 'BITGET'
  readonly accountFamily: 'UTA_SPOT_V3'
  readonly category: 'SPOT'
  readonly operation: 'PLACE' | 'CANCEL'
  readonly method: 'POST_EVIDENCE_ONLY'
  readonly endpoint: string
  readonly productId: string
  readonly unsignedBody: Readonly<Record<string, string>>
  readonly recoveryLookups: readonly BitgetV3RecoveryLookup[]
  readonly previewHash: string | null
  readonly accountFamilyReviewHash: string
  readonly builtAt: string
  readonly expiresAt: string
  readonly warnings: typeof WARNINGS
  readonly candidateHash: string
  readonly providerMutationAllowed: false
  readonly executionAllowed: false
  readonly mainnetAllowed: false
  readonly withdrawalAllowed: false
  readonly automaticRetryAllowed: false
  readonly transportSelected: false
  readonly signingMaterialPresent: false
}

export interface BitgetV3PlaceCandidateInput {
  readonly request: OrderPreviewRequest
  readonly productRules: ProductRules
  readonly clientOrderId: string
  readonly previewHash: string
  readonly accountFamilyReviewHash: string
  readonly timeInForce: BitgetV3TimeInForce | null
  readonly builtAt: string
  readonly expiresAt: string
}

export interface BitgetV3CancelCandidateInput {
  readonly productId: string
  readonly orderId: string | null
  readonly clientOrderId: string | null
  readonly accountFamilyReviewHash: string
  readonly builtAt: string
  readonly expiresAt: string
}

function requireHex(value: string, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new TypeError(`${field} must be lowercase SHA-256 hex`)
  }
  return value
}
function requireClientId(value: string): string {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) {
    throw new TypeError('clientOrderId must be a 1-64 character provider-safe identifier')
  }
  return value
}
function requireProduct(value: string): string {
  if (typeof value !== 'string' || !PRODUCT_ID.test(value)) {
    throw new TypeError('productId must be uppercase BASE-QUOTE')
  }
  const [base, quote] = value.split('-')
  if (base === quote) throw new TypeError('productId must contain different assets')
  return value
}
function validateWindow(builtAt: string, expiresAt: string): void {
  if (typeof builtAt !== 'string' || typeof expiresAt !== 'string') {
    throw new TypeError('timestamps must be ISO strings')
  }
  const a = Date.parse(builtAt), b = Date.parse(expiresAt)
  if (!Number.isFinite(a) || !Number.isFinite(b)
    || b <= a || b - a > 120_000 || new Date(a).toISOString() !== builtAt
    || new Date(b).toISOString() !== expiresAt) {
    throw new TypeError('candidate expiry must be within 120 seconds of ISO builtAt')
  }
}
function lookup(identity: { orderId?: string; clientOid?: string }): BitgetV3RecoveryLookup {
  return Object.freeze({
    method: 'GET' as const,
    endpoint: BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.orderInfo,
    query: Object.freeze(identity),
  })
}
async function finalize(input: {
  operation: 'PLACE' | 'CANCEL'
  endpoint: string
  productId: string
  unsignedBody: Record<string, string>
  previewHash: string | null
  accountFamilyReviewHash: string
  recoveryLookups: readonly BitgetV3RecoveryLookup[]
  builtAt: string
  expiresAt: string
}): Promise<BitgetV3UnsignedOrderCandidate> {
  validateWindow(input.builtAt, input.expiresAt)
  const unsignedBody = Object.freeze({ ...input.unsignedBody })
  const evidence = {
    provider: 'BITGET' as const,
    accountFamily: 'UTA_SPOT_V3' as const,
    category: 'SPOT' as const,
    operation: input.operation,
    method: 'POST_EVIDENCE_ONLY' as const,
    endpoint: input.endpoint,
    productId: input.productId,
    unsignedBody,
    recoveryLookups: Object.freeze([...input.recoveryLookups]),
    previewHash: input.previewHash,
    accountFamilyReviewHash: input.accountFamilyReviewHash,
    builtAt: input.builtAt,
    expiresAt: input.expiresAt,
    warnings: WARNINGS,
    ...LOCKS,
  }
  return Object.freeze({ ...evidence, candidateHash: await canonicalHash(evidence) })
}

/** Pure source evidence. No POST transport, signing key, order write or funded action. */
export async function buildBitgetV3UnsignedPlaceCandidate(
  input: BitgetV3PlaceCandidateInput,
): Promise<BitgetV3UnsignedOrderCandidate> {
  const productId = requireProduct(input.request.productId)
  const previewHash = requireHex(input.previewHash, 'previewHash')
  const accountFamilyReviewHash = requireHex(input.accountFamilyReviewHash, 'accountFamilyReviewHash')
  const clientOrderId = requireClientId(input.clientOrderId)
  validateWindow(input.builtAt, input.expiresAt)
  const request = input.request
  if (request.stopPrice !== null || !['BUY', 'SELL'].includes(request.side)
    || !['MARKET', 'LIMIT'].includes(request.orderType)) {
    throw new TypeError('UTA Spot candidate supports only non-triggered buy/sell market or limit orders')
  }
  const orderIntent: OrderIntent = {
    intentId: 'bitget-v3-source-candidate',
    idempotencyKey: `candidate:${clientOrderId}`,
    correlationId: `candidate:${previewHash.slice(0,24)}`,
    exchangeAccountId: 'bitget-v3-source-only',
    productId, side: request.side, orderType: request.orderType,
    baseQuantity: request.baseQuantity, quoteNotional: request.quoteNotional,
    limitPrice: request.limitPrice, stopPrice: request.stopPrice,
    strategyId: null, requestedBy: 'source-only-candidate', requestedAt: input.builtAt,
  }
  const product = validateOrderAgainstProductRules(orderIntent, input.productRules, new Date(input.builtAt))
  if (!product.accepted) throw new TypeError(`product validation failed: ${product.reasons.join(',')}`)

  const marketBuy = request.orderType === 'MARKET' && request.side === 'BUY'
  const qty = marketBuy ? request.quoteNotional : request.baseQuantity
  if (!qty || (marketBuy && request.baseQuantity !== null)
    || (!marketBuy && request.quoteNotional !== null)) {
    throw new TypeError('UTA Spot market BUY is quote-sized; all other orders are base-sized')
  }
  const body: Record<string, string> = {
    category: 'SPOT', symbol: normalizeBitgetV3Symbol(productId),
    side: request.side.toLowerCase(), orderType: request.orderType.toLowerCase(),
    qty, clientOid: clientOrderId,
  }
  if (request.orderType === 'LIMIT') {
    if (request.limitPrice === null
      || !['gtc','post_only','ioc','fok'].includes(input.timeInForce ?? '')) {
      throw new TypeError('UTA limit order requires limitPrice and reviewed timeInForce')
    }
    body.price = request.limitPrice
    body.timeInForce = input.timeInForce!
  } else if (request.limitPrice !== null || input.timeInForce !== null) {
    throw new TypeError('UTA market order must omit price and timeInForce')
  }
  return finalize({
    operation:'PLACE', endpoint: BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.placeOrder,
    productId, unsignedBody: body, previewHash, accountFamilyReviewHash,
    recoveryLookups: [lookup({ clientOid: clientOrderId })],
    builtAt: input.builtAt, expiresAt: input.expiresAt,
  })
}

/** Source-only cancel candidate. No cancel transport exists in this module. */
export async function buildBitgetV3UnsignedCancelCandidate(
  input: BitgetV3CancelCandidateInput,
): Promise<BitgetV3UnsignedOrderCandidate> {
  const productId = requireProduct(input.productId)
  const accountFamilyReviewHash = requireHex(input.accountFamilyReviewHash, 'accountFamilyReviewHash')
  const orderId = input.orderId
  const clientOrderId = input.clientOrderId
  if ((orderId === null) === (clientOrderId === null)) {
    throw new TypeError('UTA cancellation must identify exactly one orderId or clientOrderId')
  }
  if (orderId !== null && (typeof orderId !== 'string' || !PROVIDER_ID.test(orderId))) {
    throw new TypeError('orderId must contain provider-issued digits')
  }
  if (clientOrderId !== null) requireClientId(clientOrderId)
  const identity: Record<string, string> = orderId !== null ? { orderId } : { clientOid: clientOrderId! }
  return finalize({
    operation: 'CANCEL', endpoint: BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.cancelOrder,
    productId, unsignedBody: { category:'SPOT', ...identity },
    accountFamilyReviewHash, previewHash: null,
    recoveryLookups: [lookup(identity)],
    builtAt: input.builtAt, expiresAt: input.expiresAt,
  })
}
