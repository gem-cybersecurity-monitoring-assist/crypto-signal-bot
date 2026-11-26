import { feedKey, validateNormalizedEvent } from './events'
import { FeedHealthRegistry } from './feed-health'
import { BinanceDepthRecovery } from './recovery'
import { DEFAULT_FAST_PATH_THRESHOLDS, type FastPathThresholds, type NormalizedMarketEvent } from './types'

/** Only the local recovery attempt and receipt identity are checked here.
 * Provider authenticity and a durable transport/session owner are not established.
 */
export interface DepthSnapshotObservation {
  source: 'binance'
  symbol: string
  attempt: number
  receivedAtMs: number
  lastUpdateId: number
}

type Phase = 'idle' | 'recovering' | 'observing' | 'unavailable'

/** An in-memory, read-only observation coordinator. No network or execution calls. */
export class DepthObservationSession {
  private readonly identity
  private readonly recovery: BinanceDepthRecovery
  private phase: Phase = 'idle'
  private attempt = 0
  private startedAtMs: number | null = null

  constructor(
    symbol: string,
    private readonly registry: FeedHealthRegistry,
    thresholds: FastPathThresholds = { ...DEFAULT_FAST_PATH_THRESHOLDS },
  ) {
    if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/.test(symbol)) throw new TypeError('Expected canonical market symbol')
    this.identity = { source: 'binance' as const, channel: 'diff_depth', symbol }
    this.recovery = new BinanceDepthRecovery(thresholds)
  }

  get key(): string { return feedKey(this.identity) }

  begin(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new TypeError('Invalid recovery clock')
    this.attempt += 1
    this.startedAtMs = nowMs
    this.phase = 'recovering'
    this.recovery.begin(nowMs)
    this.registry.beginRecovery(this.identity, nowMs)
    return this.attempt
  }

  receive(event: NormalizedMarketEvent, nowMs: number): 'buffered' | 'observed' | 'rejected' {
    if (this.phase !== 'recovering' && this.phase !== 'observing') return 'rejected'
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
        feedKey(event) !== this.key || event.kind !== 'level2' ||
        validateNormalizedEvent(event).length || event.sequenceStart === undefined ||
        event.sequenceEnd === undefined || event.receivedTsMs > nowMs || event.exchangeTsMs > nowMs) {
      this.fail('INVALID_DEPTH_OBSERVATION', Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : this.startedAtMs ?? 1)
      return 'rejected'
    }
    if (this.phase === 'observing') {
      const result = this.registry.ingest(event, nowMs)
      if (result.accepted) return 'observed'
      if (result.reason !== 'sequence_gap') {
        if (result.state.recoveryState === 'unavailable') this.fail('FEED_UNAVAILABLE', nowMs)
        return 'rejected'
      }
      this.begin(nowMs)
    }
    if (event.receivedTsMs < (this.startedAtMs ?? nowMs)) {
      this.fail('OBSERVATION_BEFORE_RECOVERY', nowMs)
      return 'rejected'
    }
    if (this.recovery.bufferDelta(event, nowMs) === 'unavailable') {
      this.fail('RECOVERY_BUFFER_UNAVAILABLE', nowMs)
      return 'rejected'
    }
    return 'buffered'
  }

  applySnapshot(snapshot: DepthSnapshotObservation, nowMs: number): boolean {
    if (this.phase !== 'recovering') return false
    // A delayed response from an old attempt must not affect the current attempt.
    if (snapshot.attempt !== this.attempt) return false
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
        snapshot.source !== this.identity.source || snapshot.symbol !== this.identity.symbol ||
        !Number.isSafeInteger(snapshot.receivedAtMs) ||
        snapshot.receivedAtMs < (this.startedAtMs ?? nowMs) || snapshot.receivedAtMs > nowMs ||
        !Number.isSafeInteger(snapshot.lastUpdateId) || snapshot.lastUpdateId < 0) {
      this.fail('INVALID_SNAPSHOT_OBSERVATION', Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : this.startedAtMs ?? 1)
      return false
    }
    const result = this.recovery.applySnapshot(snapshot.lastUpdateId, nowMs)
    if (result.state !== 'healthy' || result.lastSequence === null || !result.accepted.length) {
      this.fail(result.errorCode ?? 'RECOVERY_INCOMPLETE', nowMs)
      return false
    }
    if (!this.registry.markRecoveryHealthy(this.key, result.lastSequence, nowMs)) {
      this.fail('RECOVERY_REGISTRY_REJECTED', nowMs)
      return false
    }
    // A snapshot is sequence evidence only: wait for a subsequent accepted
    // stream observation before publishing a market timestamp.
    this.phase = 'observing'
    return true
  }

  disconnect(nowMs: number): void {
    this.fail('TRANSPORT_DISCONNECTED', nowMs)
  }

  status(nowMs: number) {
    if (this.phase === 'recovering' && this.recovery.tick(nowMs) === 'unavailable') {
      this.fail('RECOVERY_TIMEOUT', nowMs)
    }
    return {
      phase: this.phase, attempt: this.attempt, feed: this.registry.get(this.key, nowMs),
      storageScope: 'ephemeral_worker_isolate' as const,
      providerAuthenticityVerified: false, executionAuthorized: false,
    }
  }

  private fail(code: string, nowMs: number): void {
    this.phase = 'unavailable'
    this.registry.markUnavailable(this.key, code, nowMs)
  }
}
