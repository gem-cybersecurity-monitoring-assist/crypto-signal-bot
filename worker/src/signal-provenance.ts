export const SIGNAL_MAX_AGE_MS = 15 * 60 * 1000

export type SignalSourceKind = 'persisted' | 'derived'

export type SignalProvenanceInput = {
  symbol: string
  side: string
  sourceKind: SignalSourceKind
  signalId?: number | null
  signalCreatedAt?: string | null
  marketSnapshotId?: number | null
  marketDataAsOf?: string | null
  priceSource?: string | null
  marketSnapshotStale?: boolean | number | null
  nowMs?: number
}

function timestamp(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isoAt(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

/**
 * Produces display-safe provenance for the read-only signal API.
 * A response timestamp is deliberately not treated as a market-data timestamp.
 */
export function buildSignalProvenance(input: SignalProvenanceInput) {
  const nowMs = input.nowMs ?? Date.now()
  const signalAt = timestamp(input.signalCreatedAt)
  const marketAt = timestamp(input.marketDataAsOf)
  const source = input.priceSource?.trim().toLowerCase() ?? ''
  const fallbackPrice = !source || source === 'fallback'
  const validSide = ['BUY', 'SELL', 'HOLD'].includes(input.side.toUpperCase())
  const validSymbol = /^[A-Z0-9]{2,20}$/.test(input.symbol)
  const cachedPrice = source.startsWith('cache:')
  const snapshotMarkedStale = input.marketSnapshotStale === true
    || input.marketSnapshotStale === 1

  const eventId = input.sourceKind === 'persisted'
    ? (Number.isInteger(input.signalId) ? `persisted:${input.signalId}` : null)
    : (Number.isInteger(input.marketSnapshotId)
      ? `derived:${input.symbol}:${input.marketSnapshotId}:${input.side}`
      : null)

  const freshnessAt = input.sourceKind === 'persisted' ? signalAt : marketAt
  const signalAgeMs = signalAt === null ? null : nowMs - signalAt
  const marketAgeMs = marketAt === null ? null : nowMs - marketAt
  const stale = snapshotMarkedStale
    || fallbackPrice
    || cachedPrice
    || eventId === null
    || !validSide
    || !validSymbol
    || signalAgeMs === null
    || signalAgeMs < 0
    || signalAgeMs > SIGNAL_MAX_AGE_MS
    || marketAgeMs === null
    || marketAgeMs < 0
    || marketAgeMs > SIGNAL_MAX_AGE_MS

  const expiresAt = freshnessAt === null ? null : Math.min(
    freshnessAt + SIGNAL_MAX_AGE_MS,
    marketAt === null ? Number.POSITIVE_INFINITY : marketAt + SIGNAL_MAX_AGE_MS,
  )
  const provenanceStatus = fallbackPrice
    ? 'UNTRUSTED_PRICE_FALLBACK'
    : input.sourceKind === 'persisted'
      ? 'PERSISTED_SIGNAL'
      : 'DERIVED_WORKER_SIGNAL'

  return {
    event_id: eventId,
    schema_version: 1,
    source_kind: input.sourceKind,
    provenance_status: provenanceStatus,
    price_source: input.priceSource ?? null,
    market_data_as_of: input.marketDataAsOf ?? null,
    signal_created_at: input.signalCreatedAt ?? null,
    expires_at: isoAt(expiresAt),
    stale,
    decision_grade: !stale && eventId !== null,
  }
}
