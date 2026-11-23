import type { FeedUpdateResult, NormalizedMarketEvent, PriceOrigin } from '../types'

export const SHADOW_FEATURE_VERSION = 'phase3-shadow-features-v1' as const

/** No model, transport, portfolio state, or order authority is reachable here. */
export interface ShadowFeatureSnapshot {
  readonly featureVersion: typeof SHADOW_FEATURE_VERSION
  readonly candidateOnly: true
  readonly symbol: string
  readonly source: NormalizedMarketEvent['source']
  readonly eventId: string
  readonly exchangeTsMs: number
  readonly sourceAgeMs: number
  readonly sampleCount: number
  readonly midPrice: number
  readonly spreadBps: number
  readonly bestBidQuantity: number | null
  readonly bestAskQuantity: number | null
  readonly imbalance: number | null
  readonly momentumBps: number | null
  readonly realizedVolatilityBps: number | null
  /** These are unknown until the normalized input carries trustworthy evidence. */
  readonly signedTradeFlow: null
  readonly shortReversalBps: null
  readonly independentSourceDisagreementBps: null
}

type Stream = {
  eventId: string
  exchangeTsMs: number
  mid: number
  momentum: number | null
  variance: number | null
  samples: number
}

const ALPHA = 0.2
const MAX_AGE_MS = 500
const MAX_UPDATES = 32

function topQuantity(
  event: NormalizedMarketEvent, side: 'bid' | 'ask', price: number,
): number | null {
  const updates = event.updates
  if (!updates || updates.length > MAX_UPDATES) return null
  const best = updates.find((update) => update.side === side && update.price === price)
  return best && Number.isFinite(best.quantity) && best.quantity > 0 ? best.quantity : null
}

/** Bounded O(1) per book event (max 32 top-level updates inspected). */
export class ShadowFeatureEngine {
  private readonly streams = new Map<string, Stream>()

  constructor(private readonly maxTrackedStreams = 256) {
    if (!Number.isSafeInteger(maxTrackedStreams) || maxTrackedStreams < 1) {
      throw new Error('maxTrackedStreams must be a positive integer')
    }
  }

  get trackedStreamCount(): number {
    return this.streams.size
  }

  clear(): void {
    this.streams.clear()
  }

  observe(
    event: NormalizedMarketEvent,
    feed: FeedUpdateResult,
    priceOrigin: PriceOrigin,
    nowMs: number,
  ): ShadowFeatureSnapshot | null {
    const key = `${event.source}:${event.channel}:${event.symbol}`
    const healthy = feed.accepted && feed.reason === 'accepted' && feed.eventId === event.eventId
      && feed.state.source === event.source
      && feed.state.channel === event.channel
      && feed.state.symbol === event.symbol
      && feed.state.integrityState === 'healthy'
      && feed.state.heartbeatState === 'healthy'
      && feed.state.sequenceState === 'continuous'
      && feed.state.freshnessClass === 'green'
      && priceOrigin === 'live'
      && event.exchangeTimestampSource === 'exchange'
      && Number.isFinite(nowMs)
      && event.exchangeTsMs > 0
      && event.exchangeTsMs <= nowMs
      && nowMs - event.exchangeTsMs <= MAX_AGE_MS
      && (event.kind === 'book_ticker' || event.kind === 'level2' || event.kind === 'snapshot')
    if (!healthy) {
      // A feed gap, stale event or non-live price cannot inherit an old signal.
      this.streams.delete(key)
      return null
    }

    const bid = event.bid
    const ask = event.ask
    if (bid === undefined || ask === undefined || !Number.isFinite(bid)
      || !Number.isFinite(ask) || bid <= 0 || ask <= bid) {
      this.streams.delete(key)
      return null
    }
    const mid = (bid + ask) / 2
    if (!Number.isFinite(mid) || mid <= 0) {
      this.streams.delete(key)
      return null
    }
    const previous = this.streams.get(key)
    if (previous && (previous.eventId === event.eventId
      || event.exchangeTsMs < previous.exchangeTsMs)) {
      return null
    }
    const returnBps = previous ? ((mid - previous.mid) / previous.mid) * 10_000 : null
    const momentum = returnBps === null ? null
      : ALPHA * returnBps + (1 - ALPHA) * (previous?.momentum ?? returnBps)
    const variance = returnBps === null ? null
      : ALPHA * returnBps ** 2 + (1 - ALPHA) * (previous?.variance ?? returnBps ** 2)

    this.streams.delete(key)
    while (this.streams.size >= this.maxTrackedStreams) {
      const oldest = this.streams.keys().next().value
      if (oldest === undefined) break
      this.streams.delete(oldest)
    }
    const samples = (previous?.samples ?? 0) + 1
    this.streams.set(key, {
      eventId: event.eventId, exchangeTsMs: event.exchangeTsMs,
      mid, momentum, variance, samples,
    })
    const bestBidQuantity = topQuantity(event, 'bid', bid)
    const bestAskQuantity = topQuantity(event, 'ask', ask)
    const depth = bestBidQuantity !== null && bestAskQuantity !== null
      ? bestBidQuantity + bestAskQuantity : null
    return {
      featureVersion: SHADOW_FEATURE_VERSION,
      candidateOnly: true,
      symbol: event.symbol,
      source: event.source,
      eventId: event.eventId,
      exchangeTsMs: event.exchangeTsMs,
      sourceAgeMs: nowMs - event.exchangeTsMs,
      sampleCount: samples,
      midPrice: mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
      bestBidQuantity,
      bestAskQuantity,
      imbalance: depth && depth > 0 ? (bestBidQuantity! - bestAskQuantity!) / depth : null,
      momentumBps: momentum,
      realizedVolatilityBps: variance === null ? null : Math.sqrt(variance),
      signedTradeFlow: null,
      shortReversalBps: null,
      independentSourceDisagreementBps: null,
    }
  }
}
