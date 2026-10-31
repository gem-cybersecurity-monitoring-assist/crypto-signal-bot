export type SignalSnapshot = { id: number; price: number; source: string; stale: number | boolean; created_at: string } | null;

export type SignalFreshnessInput = {
  sourceKind: 'persisted' | 'derived';
  symbol: string;
  side?: string;
  signalId?: number;
  signalCreatedAt?: string | null;
  priceSource?: string | null;
  entryPrice?: number | null;
  priceIsStale?: boolean;
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
    // Persisted rows have no linked market-snapshot ID/time in the current schema. A recent row timestamp alone cannot prove its entry price is current.
    const stale = true;
    return {
      schema_version: 1,
      event_id: Number.isInteger(input.signalId) ? "signal:" + input.symbol + ":" + input.signalId : null,
      source_kind: "persisted" as const,
      provenance_status: "PERSISTED_SIGNAL",
      decision_grade: false,
      signal_created_at: input.signalCreatedAt ?? null,
      market_data_as_of: null,
      market_snapshot_price: null,
      market_data_stale: null,
      stale,
      expires_at: createdMs === null ? null : new Date(createdMs + MAX_AGE_MS).toISOString(),
      price_source: null,
    };
  }

  const snapshot = input.snapshot ?? null;
  const snapshotMs = parseTime(snapshot?.created_at);
  const liveSourceMatches = Boolean(
    snapshot && input.priceSource &&
    input.priceSource === snapshot.source &&
    (input.priceSource === "coinbase" || input.priceSource === "binance") &&
    Number.isFinite(input.entryPrice) &&
    Math.abs(snapshot.price - (input.entryPrice ?? 0)) <= Math.max(1e-8, Math.abs(input.entryPrice ?? 0) * 1e-10) &&
    input.priceIsStale === false
  );
  const marketDataStale = !liveSourceMatches || !snapshot || Boolean(snapshot.stale) || snapshotMs === null || snapshotMs > nowMs + 5 * 60 * 1000 || nowMs - (snapshotMs ?? 0) > MAX_AGE_MS;
  const eventId = snapshot && Number.isInteger(snapshot.id)
    ? "ema:" + input.symbol + ":" + snapshot.id + ":" + (input.side ?? "HOLD")
    : null;
  return {
    schema_version: 1,
    event_id: eventId,
    source_kind: "derived" as const,
    provenance_status: "DERIVED_WORKER_SIGNAL",
    decision_grade: !marketDataStale,
    signal_created_at: new Date(nowMs).toISOString(),
    market_data_as_of: snapshotMs === null ? null : new Date(snapshotMs).toISOString(),
    market_snapshot_price: snapshot ? snapshot.price : null,
    market_data_stale: marketDataStale,
    stale: marketDataStale,
    expires_at: snapshotMs === null ? null : new Date(snapshotMs + MAX_AGE_MS).toISOString(),
    price_source: input.priceSource ?? null,
  };
}