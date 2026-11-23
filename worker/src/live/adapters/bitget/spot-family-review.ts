import { canonicalHash } from '../../canonical-json.ts'
import { BITGET_MUTATION_EVIDENCE_ENDPOINTS, type BitgetUnsignedMutationCandidate } from './execution-candidate.ts'

/**
 * An account family cannot be inferred from a generic successful API response.
 * This source-only check never selects a fetcher, account, credential or route.
 */
export type BitgetSpotApiFamily = 'CLASSIC_SPOT_V2' | 'UTA_SPOT_V3' | 'UNKNOWN'
export type BitgetFamilyCheckStatus = 'REVIEW_COMPATIBLE' | 'BLOCKED'

export interface BitgetFamilyObservation {
  readonly exchangeAccountId: string
  readonly declaredFamily: BitgetSpotApiFamily
  readonly observedFamily: BitgetSpotApiFamily
  readonly observedAt: string
  readonly reviewedContractRef: string
  readonly externallyVerifiedFamily: boolean
  readonly externalEvidenceHash: string
}

export interface BitgetSpotFamilyReviewInput {
  readonly expectedExchangeAccountId: string
  readonly candidate: BitgetUnsignedMutationCandidate
  readonly account: BitgetFamilyObservation
  readonly evaluatedAt: string
}

export interface BitgetSpotFamilyReviewResult {
  readonly status: BitgetFamilyCheckStatus
  readonly provider: 'BITGET'
  readonly candidateHash: string
  readonly exchangeAccountId: string
  readonly selectedFamily: BitgetSpotApiFamily
  readonly approvedEndpoint: string | null
  readonly reasonCodes: readonly string[]
  readonly sourceOnly: true
  readonly executionAllowed: false
  readonly providerMutationAllowed: false
  readonly mainnetAllowed: false
  readonly automaticRetryAllowed: false
  readonly withdrawalAllowed: false
}

const SHA256 = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,128}$/
const MAX_AGE_MS = 5 * 60 * 1000
const CLASSIC_ENDPOINTS = new Set<string>([
  BITGET_MUTATION_EVIDENCE_ENDPOINTS.placeOrder,
  BITGET_MUTATION_EVIDENCE_ENDPOINTS.cancelOrder,
  BITGET_MUTATION_EVIDENCE_ENDPOINTS.cancelReplaceOrder,
])

export async function assessBitgetSpotFamily(
  input: BitgetSpotFamilyReviewInput,
): Promise<BitgetSpotFamilyReviewResult> {
  const reasons: string[] = []
  const family = input.account?.observedFamily ?? 'UNKNOWN'
  const accountId = input.expectedExchangeAccountId ?? ''
  if (!IDENTIFIER.test(accountId)
    || input.account?.exchangeAccountId !== accountId) reasons.push('EXCHANGE_ACCOUNT_MISMATCH')
  if (input.account?.declaredFamily !== family || family === 'UNKNOWN') {
    reasons.push('SPOT_ACCOUNT_FAMILY_UNVERIFIED')
  }
  if (family === 'UTA_SPOT_V3') reasons.push('UTA_V3_REQUIRES_SEPARATE_REVIEWED_ADAPTER')
  if (family !== 'CLASSIC_SPOT_V2' && family !== 'UTA_SPOT_V3') {
    reasons.push('SPOT_ACCOUNT_FAMILY_UNSUPPORTED')
  }
  if (input.account?.externallyVerifiedFamily !== true
    || !SHA256.test(input.account?.externalEvidenceHash ?? '')
    || !IDENTIFIER.test(input.account?.reviewedContractRef ?? '')) {
    reasons.push('INDEPENDENT_ACCOUNT_FAMILY_EVIDENCE_REQUIRED')
  }

  const now = Date.parse(input.evaluatedAt)
  const observed = Date.parse(input.account?.observedAt ?? '')
  if (!Number.isFinite(now) || !Number.isFinite(observed)
    || observed > now || now - observed > MAX_AGE_MS) {
    reasons.push('ACCOUNT_FAMILY_EVIDENCE_NOT_CURRENT')
  }
  if (!input.candidate
    || !CLASSIC_ENDPOINTS.has(input.candidate.endpoint)
    || family !== 'CLASSIC_SPOT_V2') {
    reasons.push('CANDIDATE_ENDPOINT_FAMILY_MISMATCH')
  }
  // Family compatibility cannot revive an expired or future-created candidate.
  // The candidate's own window is independently checked at review time.
  const built = Date.parse(input.candidate?.builtAt ?? '')
  const expires = Date.parse(input.candidate?.expiresAt ?? '')
  if (!Number.isFinite(now) || !Number.isFinite(built) || !Number.isFinite(expires)
    || built > now || expires <= now || expires <= built) {
    reasons.push('CANDIDATE_VALIDITY_WINDOW_INACTIVE')
  }
  if (input.candidate?.provider !== 'BITGET'
    || input.candidate?.method !== 'POST_EVIDENCE_ONLY') {
    reasons.push('INVALID_CANDIDATE_OR_METHOD')
  } else {
    try {
      // This independently recomputes the immutable candidate hash, locks,
      // exact operation endpoint and GET-only recovery plan.
      const { candidateHash, ...immutableEvidence } = input.candidate
      const operationEndpoint = input.candidate.operation === 'PLACE'
        ? BITGET_MUTATION_EVIDENCE_ENDPOINTS.placeOrder
        : input.candidate.operation === 'CANCEL'
          ? BITGET_MUTATION_EVIDENCE_ENDPOINTS.cancelOrder
          : input.candidate.operation === 'CANCEL_REPLACE'
            ? BITGET_MUTATION_EVIDENCE_ENDPOINTS.cancelReplaceOrder : null
      const expectedRecoveryCount = input.candidate.operation === 'CANCEL_REPLACE' ? 2 : 1
      const validLocks = input.candidate.providerMutationAllowed === false
        && input.candidate.executionAllowed === false
        && input.candidate.automaticRetryAllowed === false
        && input.candidate.transportSelected === false
        && input.candidate.signingMaterialPresent === false
        && Array.isArray(input.candidate.warnings)
        && input.candidate.warnings.includes('execution_locked')
        && input.candidate.warnings.includes('no_automatic_retry')
      const safeRecovery = Array.isArray(input.candidate.recoveryLookups)
        && input.candidate.recoveryLookups.length === expectedRecoveryCount
        && input.candidate.recoveryLookups.every((lookup) => lookup.method === 'GET'
          && lookup.endpoint === BITGET_MUTATION_EVIDENCE_ENDPOINTS.orderInfo)
      if (!SHA256.test(candidateHash)
        || await canonicalHash(immutableEvidence) !== candidateHash
        || !validLocks || !safeRecovery || input.candidate.endpoint !== operationEndpoint) {
        throw new Error('candidate integrity invalid')
      }
    } catch {
      reasons.push('CANDIDATE_INTEGRITY_INVALID')
    }
  }
  const compatible = reasons.length === 0
  return Object.freeze({
    status: compatible ? 'REVIEW_COMPATIBLE' as const : 'BLOCKED' as const,
    provider: 'BITGET' as const,
    candidateHash: SHA256.test(input.candidate?.candidateHash ?? '') ? input.candidate.candidateHash : '',
    exchangeAccountId: IDENTIFIER.test(accountId) ? accountId : '',
    selectedFamily: family,
    approvedEndpoint: compatible ? input.candidate.endpoint : null,
    reasonCodes: Object.freeze(compatible ? ['SOURCE_ONLY_REVIEW_COMPATIBLE'] : reasons),
    sourceOnly: true as const,
    executionAllowed: false as const,
    providerMutationAllowed: false as const,
    mainnetAllowed: false as const,
    automaticRetryAllowed: false as const,
    withdrawalAllowed: false as const,
  })
}
