export type SignalSnapshot = { id: number; source: string; stale: number | boolean; created_at: string } | null;

export type SignalFreshnessInput = {
  sourceKind: 'persisted' | 'derived';
  symbol: string;
  side?: string;
  signalId?: number;
  signalCreatedAt?: string | null;
  priceSource?: string | null;
  snapshot?: SignalSnapshot;
};

const MAX_AGE_MS = 15 * 60 * 1000;
const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Metadata for display and deduplication only; never grants execution authority. */
export function buildSignalFreshnessMetadata(input: SignalFreshnessInput, nowMs = Date.now()) {
  if (input.sourceKind === "persisted") {
    const createdMs = parseTime(input.signalCreatedAt);
    const stale = createdMs === null || createdMs > nowMs + 5 * 60 * 1000 || nowMs - createdMs > MAX_AGE_MS;
    return {
      schema_version: 1,
      event_id: Number.isInteger(input.signalId) ? "signal:" + input.symbol + ":" + input.signalId : null,
      source_kind: "persisted" as const,
      signal_created_at: input.signalCreatedAt ?? null,
      market_data_as_of: null,
      market_data_stale: null,
      stale,
      expires_at: createdMs === null ? null : new Date(createdMs + MAX_AGE_MS).toISOString(),
      price_source: null,
    };
  }

  const snapshot = input.snapshot ?? null;
  const snapshotMs = parseTime(snapshot?.created_at);
  const liveSourceMatches = Boolean(snapshot && input.priceSource && input.priceSource === snapshot.source && (input.priceSource === "coinbase" || input.priceSource === "binance"));
  const marketDataStale = !liveSourceMatches || !snapshot || Boolean(snapshot.stale) || snapshotMs === null || snapshotMs > nowMs + 5 * 60 * 1000 || nowMs - (snapshotMs ?? 0) > MAX_AGE_MS;
  const eventId = snapshot && Number.isInteger(snapshot.id)
    ? "ema:" + input.symbol + ":" + snapshot.id + ":" + (input.side ?? "HOLD")
    : null;
  return {
    schema_version: 1,
    event_id: eventId,
    source_kind: "derived" as const,
    signal_created_at: new Date(nowMs).toISOString(),
    market_data_as_of: snapshotMs === null ? null : new Date(snapshotMs).toISOString(),
    market_data_stale: marketDataStale,
    stale: marketDataStale,
    expires_at: snapshotMs === null ? null : new Date(snapshotMs + MAX_AGE_MS).toISOString(),
    price_source: input.priceSource ?? null,
  };
}