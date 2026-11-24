import { canonicalHash, canonicalJson } from '../../../canonical-json.ts'
import {
  type LiveDispatchAdmissionStore,
  type LiveDispatchClaim,
} from '../../../live-dispatch-admission-store.ts'
import { readBoundedResponseBody } from '../bounded-response.ts'
import {
  BITGET_V3_ENDPOINTS,
  assertBitgetV3OrderLookupIdentity,
} from './endpoints-v3.ts'
import {
  interpretBitgetV3OrderWriteAcknowledgement,
  prepareBitgetV3OrderWriteRequest,
  type BitgetV3OrderWriteAcknowledgement,
} from './order-write-protocol-v3.ts'
import type { BitgetV3UidQuota } from './order-write-quota-v3.ts'
import type { BitgetV3SecretMaterial } from './read-only-client-v3.ts'
import type { BitgetV3UnsignedOrderCandidate } from './unsigned-candidate-v3.ts'

type DispatchIdentity = Readonly<{
  accountRefHash: string
  providerUidHash: string
  operation: 'PLACE' | 'CANCEL'
  candidateHash: string
  productId: string
}>

type CurrentDispatchControls = Readonly<{
  admission: Omit<LiveDispatchClaim, 'claimedAt'>
  validUntilMs: number
}>

export interface BitgetV3OrderTransportServices {
  /** Bound to the account's serialized Durable Object. */
  admission: LiveDispatchAdmissionStore
  accountRefHash: string
  providerUidHash: string
  /** Load current, trusted role, release, certification, risk and kill-switch evidence. */
  resolveControls(identity: DispatchIdentity): Promise<CurrentDispatchControls | null>
  /** Server-side signing material scoped to the independently certified account and UID. */
  readCredentials(identity: DispatchIdentity): Promise<Readonly<BitgetV3SecretMaterial>>
  /** An atomic rolling quota shared across all credentials for this provider UID. */
  claimUidQuota(identity: DispatchIdentity): Promise<BitgetV3UidQuota | null>
  sendOnce(request: Request): Promise<Response>
  now?: () => number
  timeoutMs?: number
}

type Recovery = Readonly<{
  method: 'GET'
  endpoint: typeof BITGET_V3_ENDPOINTS.orderInfo
  query: ReturnType<typeof assertBitgetV3OrderLookupIdentity>
}>

export type BitgetV3OrderDispatchResult =
  | Readonly<{ state: 'BLOCKED_BEFORE_SEND' }>
  | Readonly<BitgetV3OrderWriteAcknowledgement & { attemptId: string; recovery: Recovery }>

const BLOCKED = Object.freeze({ state: 'BLOCKED_BEFORE_SEND' } as const)
const SHA256 = /^[a-f0-9]{64}$/
const RESPONSE_BYTES = 16_384

/**
 * Private account-coordinator transport. A dispatch claim is consumed even if
 * revoked after admission. Recover the original attempt before any new action.
 */
export function createBitgetV3OrderTransport(services: BitgetV3OrderTransportServices) {
  const { admission, accountRefHash, providerUidHash, resolveControls, readCredentials,
    claimUidQuota, sendOnce, now = Date.now, timeoutMs = 5_000 } = services
  if (!SHA256.test(accountRefHash) || !SHA256.test(providerUidHash)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('Invalid Bitget V3 transport configuration')
  }

  return async (input: BitgetV3UnsignedOrderCandidate): Promise<BitgetV3OrderDispatchResult> => {
    let candidate: BitgetV3UnsignedOrderCandidate
    let identity: DispatchIdentity
    let recovery: Recovery
    let request: Request
    let attemptId: string
    try {
      candidate = JSON.parse(canonicalJson(input))
      const { candidateHash, ...evidence } = candidate
      if (!SHA256.test(candidateHash) || await canonicalHash(evidence) !== candidateHash
        || !['PLACE', 'CANCEL'].includes(candidate.operation) || candidate.recoveryLookups.length !== 1) return BLOCKED
      const lookup = candidate.recoveryLookups[0]
      if (lookup.method !== 'GET' || lookup.endpoint !== BITGET_V3_ENDPOINTS.orderInfo) return BLOCKED
      const query = assertBitgetV3OrderLookupIdentity(lookup.query)
      if ('orderId' in query
        ? candidate.operation === 'PLACE' || candidate.unsignedBody.orderId !== query.orderId
        : candidate.unsignedBody.clientOid !== query.clientOid) return BLOCKED
      recovery = Object.freeze({ method: 'GET', endpoint: BITGET_V3_ENDPOINTS.orderInfo, query })
      identity = Object.freeze({ accountRefHash, providerUidHash, candidateHash,
        operation: candidate.operation, productId: candidate.productId })
      const authorized = await resolveControls(identity)
      const claimTime = now()
      const builtAt = Date.parse(candidate.builtAt)
      const expiresAt = Date.parse(candidate.expiresAt)
      if (!authorized || !Number.isFinite(authorized.validUntilMs)
        || !Number.isSafeInteger(claimTime) || !Number.isFinite(builtAt) || !Number.isFinite(expiresAt)
        || claimTime < builtAt || claimTime >= Math.min(authorized.validUntilMs, expiresAt)
        || authorized.admission.candidateHash !== candidateHash
        || authorized.admission.operation !== candidate.operation) return BLOCKED

      const controlSnapshot = canonicalJson(authorized.admission)
      const originalDeadline = Math.min(authorized.validUntilMs, expiresAt)
      const claim = Object.freeze({ ...authorized.admission, claimedAt: new Date(claimTime).toISOString() })
      const receipt = admission.claim(claim)
      if (receipt.accountRefHash !== accountRefHash || receipt.exchange !== 'BITGET') return BLOCKED
      attemptId = receipt.attemptId

      const stillCurrent = async () => {
        const current = await resolveControls(identity)
        const currentTime = now()
        return current && Number.isFinite(current.validUntilMs) && Number.isSafeInteger(currentTime)
          && currentTime >= claimTime && currentTime < Math.min(current.validUntilMs, originalDeadline)
          && canonicalJson(current.admission) === controlSnapshot
      }
      if (!await stillCurrent()) return BLOCKED
      const credentials = await readCredentials(identity)
      request = await prepareBitgetV3OrderWriteRequest(candidate, receipt.candidateHash, credentials, now())
      const quota = await claimUidQuota(identity)
      if (!quota || quota.providerUidHash !== providerUidHash || quota.operation !== candidate.operation
        || !await stillCurrent()) return BLOCKED
      const sendAt = now()
      if (!Number.isSafeInteger(sendAt) || sendAt < quota.claimedAtMs
        || sendAt >= Math.min(originalDeadline, quota.expiresAtMs)
        || sendAt - Number(request.headers.get('ACCESS-TIMESTAMP')) >= timeoutMs) return BLOCKED
      admission.armBitgetRecovery({
        attemptId, candidateHash, productId: identity.productId, identity: recovery.query,
      })
      // The local write may take long enough that the UID reservation is stale.
      const committedAt = now()
      if (!Number.isSafeInteger(committedAt) || committedAt < sendAt
        || committedAt >= Math.min(originalDeadline, quota.expiresAtMs)) return BLOCKED
    } catch {
      return BLOCKED
    }

    const unknown = Object.freeze({ state: 'UNKNOWN_REQUIRES_LOOKUP' as const, attemptId, recovery })
    const deadline = new AbortController()
    const timeout = setTimeout(() => deadline.abort(), timeoutMs)
    try {
      const timedOut = new Promise<never>((_, reject) => {
        deadline.signal.addEventListener('abort', () => reject(new Error('Bitget response deadline exceeded')), { once: true })
      })
      const response = await Promise.race([sendOnce(new Request(request, { signal: deadline.signal })), timedOut])
      if (response.redirected) return unknown
      const body = await Promise.race([
        readBoundedResponseBody(response, RESPONSE_BYTES, deadline.signal, () => new Error('Invalid Bitget response body')),
        timedOut,
      ])
      const outcome = interpretBitgetV3OrderWriteAcknowledgement(candidate, response.status, JSON.parse(body))
      return Object.freeze({ ...outcome, attemptId, recovery })
    } catch {
      deadline.abort()
      return unknown
    } finally {
      clearTimeout(timeout)
    }
  }
}
