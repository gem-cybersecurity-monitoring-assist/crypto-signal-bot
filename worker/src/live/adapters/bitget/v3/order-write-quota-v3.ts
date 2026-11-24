export type BitgetV3UidQuota = Readonly<{
  providerUidHash: string
  operation: 'PLACE' | 'CANCEL'
  claimedAtMs: number
  expiresAtMs: number
}>

type QuotaWindow = { lastClaimAtMs: number; claims: number[] }
const MAX_SEND_DELAY_MS = 250
// A claim may be used near its expiry, so retain it for the provider window
// plus that delay. This bounds the local send rate across process restarts.
const WINDOW_MS = 1_000 + MAX_SEND_DELAY_MS
const MAX_REQUESTS = 10

/** Storage must be shared by the certified provider UID, across all local accounts and API keys. */
export function createBitgetV3UidQuota(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  providerUidHash: string,
  now = Date.now,
) {
  if (!/^[a-f0-9]{64}$/.test(providerUidHash)) throw new TypeError('Invalid Bitget UID scope')

  return ({ providerUidHash: requestedUid, operation }: Pick<BitgetV3UidQuota, 'providerUidHash' | 'operation'>) => {
    if (requestedUid !== providerUidHash || (operation !== 'PLACE' && operation !== 'CANCEL')) {
      throw new TypeError('Invalid Bitget UID quota request')
    }
    return storage.transaction(async (txn): Promise<BitgetV3UidQuota | null> => {
      const key = `bitget-v3-write-quota:${providerUidHash}:${operation}`
      const previous = await txn.get<QuotaWindow>(key)
      const claimedAtMs = now()
      if (!Number.isSafeInteger(claimedAtMs) || claimedAtMs <= 0 || (previous && claimedAtMs < previous.lastClaimAtMs)) {
        throw new TypeError('Invalid Bitget UID quota clock')
      }
      const claims = (previous?.claims ?? []).filter(time => time > claimedAtMs - WINDOW_MS)
      if (claims.length >= MAX_REQUESTS) return null
      await txn.put(key, { lastClaimAtMs: claimedAtMs, claims: [...claims, claimedAtMs] })
      return Object.freeze({ providerUidHash, operation, claimedAtMs, expiresAtMs: claimedAtMs + MAX_SEND_DELAY_MS })
    })
  }
}
