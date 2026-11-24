import { canonicalHash } from '../../../canonical-json.ts'
import type { LiveDispatchAdmissionStore } from '../../../live-dispatch-admission-store.ts'
import { reviewBitgetV3SpotOrderInfo } from './order-info-review-v3.ts'
import { BitgetV3ReadOnlyClient, type BitgetV3ReadOnlyClientOptions } from './read-only-client-v3.ts'

/**
 * Recover a send whose process stopped before recording a result. The caller
 * authenticates before invoking and supplies a client with read-only credentials.
 * Recovery evidence is for reconciliation; it does not settle the ledger.
 */
export async function recoverBitgetV3OrderWrite(
  admission: LiveDispatchAdmissionStore,
  options: BitgetV3ReadOnlyClientOptions,
  attemptId: string,
) {
  const pending = admission.getBitgetRecovery(attemptId)
  if (!pending) return Object.freeze({ state: 'ATTEMPT_NOT_ARMED' as const })

  const now = options.now ?? Date.now
  const credentials = Object.freeze({ ...await options.secretProvider.read() })
  const client = new BitgetV3ReadOnlyClient({
    ...options, now, requireFreshResponseTime: true,
    secretProvider: { read: async () => credentials },
  })
  const permissions = await client.verifyReadOnlyPermissions()
  if (!permissions.permissionsVerified || await canonicalHash(permissions.userId) !== pending.accountRefHash) {
    throw new Error('Bitget recovery account does not match the admitted account')
  }

  const response = await client.getOrderInfo(pending.identity)
  const observedAtMs = now()
  const review = await reviewBitgetV3SpotOrderInfo({
    response, expectedIdentity: pending.identity, expectedSymbol: pending.productId, evaluatedAtMs: observedAtMs,
  })
  admission.recordBitgetRecovery(pending.attemptId, review, observedAtMs)
  return Object.freeze({
    state: 'PROVIDER_STATUS_VERIFIED' as const,
    attemptId: pending.attemptId,
    accountRefHash: pending.accountRefHash,
    candidateHash: pending.candidateHash,
    review,
  })
}
