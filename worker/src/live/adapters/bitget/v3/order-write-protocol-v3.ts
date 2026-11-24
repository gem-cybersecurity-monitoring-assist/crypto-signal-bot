import { canonicalHash, canonicalJson } from '../../../canonical-json.ts'
import { signBitgetPrehash } from '../read-only-client.ts'
import { assertBitgetV3OrderLookupIdentity, BITGET_V3_API_ORIGIN } from './endpoints-v3.ts'
import type { BitgetV3SecretMaterial } from './read-only-client-v3.ts'
import {
  BITGET_V3_ORDER_CANDIDATE_ENDPOINTS,
  type BitgetV3UnsignedOrderCandidate,
} from './unsigned-candidate-v3.ts'

/**
 * Wire format for an admitted UTA Spot order. The dispatch layer must supply
 * a hash from durable admission, perform its current control check before
 * obtaining credentials, and send the returned request at most once.
 */
export async function prepareBitgetV3OrderWriteRequest(
  candidate: BitgetV3UnsignedOrderCandidate,
  admittedCandidateHash: string,
  credentials: Readonly<BitgetV3SecretMaterial>,
  nowMs: number,
): Promise<Request> {
  const { candidateHash, ...evidence } = candidate
  const endpoint = {
    PLACE: BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.placeOrder,
    CANCEL: BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.cancelOrder,
  }[candidate.operation]
  const builtAt = Date.parse(candidate.builtAt)
  const expiresAt = Date.parse(candidate.expiresAt)
  if (!endpoint || candidate.endpoint !== endpoint
    || candidate.provider !== 'BITGET' || candidate.accountFamily !== 'UTA_SPOT_V3'
    || candidate.category !== 'SPOT' || candidate.unsignedBody.category !== 'SPOT'
    || candidate.method !== 'POST_EVIDENCE_ONLY'
    || candidateHash !== admittedCandidateHash || !/^[a-f0-9]{64}$/.test(candidateHash)) {
    throw new TypeError('Bitget V3 request does not match the admitted Spot operation')
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isFinite(builtAt)
    || !Number.isFinite(expiresAt) || nowMs < builtAt || nowMs >= expiresAt
    || expiresAt - builtAt > 120_000) {
    throw new TypeError('Bitget V3 order candidate is outside its signing window')
  }

  // Snapshot the exact bytes before yielding to the asynchronous hash/signature.
  const body = canonicalJson(candidate.unsignedBody)
  if (await canonicalHash({ ...evidence, unsignedBody: JSON.parse(body) }) !== candidateHash) {
    throw new TypeError('Bitget V3 order candidate evidence changed')
  }
  const { apiKey, secretKey, passphrase } = credentials
  if (![apiKey, secretKey, passphrase].every(
    (value) => typeof value === 'string' && value.length > 0 && /^[!-~]+$/.test(value),
  )) {
    throw new TypeError('Bitget V3 signing credentials are invalid')
  }

  const timestamp = String(nowMs)
  const signature = await signBitgetPrehash(secretKey, `${timestamp}POST${endpoint}${body}`)
  return new Request(`${BITGET_V3_API_ORIGIN}${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
    body,
  })
}

export type BitgetV3OrderWriteAcknowledgement =
  | Readonly<{ state: 'ACKNOWLEDGED'; orderId: string }>
  | Readonly<{ state: 'UNKNOWN_REQUIRES_LOOKUP' }>

const UNKNOWN = Object.freeze({ state: 'UNKNOWN_REQUIRES_LOOKUP' } as const)

/** A positive ACK requires GET reconciliation before applying a fill or cancellation. */
export function interpretBitgetV3OrderWriteAcknowledgement(
  candidate: BitgetV3UnsignedOrderCandidate,
  httpStatus: number,
  payload: unknown,
): BitgetV3OrderWriteAcknowledgement {
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || !('code' in payload) || payload.code !== '00000' || !('data' in payload)
    || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return UNKNOWN
  }

  const data = payload.data as Record<string, unknown>
  const lookup = candidate.recoveryLookups[0]
  if (candidate.recoveryLookups.length !== 1 || lookup?.method !== 'GET'
    || lookup.endpoint !== BITGET_V3_ORDER_CANDIDATE_ENDPOINTS.orderInfo) return UNKNOWN
  try {
    const expected = assertBitgetV3OrderLookupIdentity(lookup.query)
    const actual = assertBitgetV3OrderLookupIdentity({ orderId: data.orderId })
    if (!('orderId' in actual)) return UNKNOWN
    const matches = 'orderId' in expected
      ? data.orderId === expected.orderId
      : data.clientOid === expected.clientOid
    if (matches) return Object.freeze({ state: 'ACKNOWLEDGED', orderId: actual.orderId })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
  }
  return UNKNOWN
}
