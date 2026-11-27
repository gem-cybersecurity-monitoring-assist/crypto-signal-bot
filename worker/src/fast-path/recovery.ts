import { classifySequence, validateNormalizedEvent } from './events'
import {
  DEFAULT_FAST_PATH_THRESHOLDS,
  type FastPathThresholds,
  type NormalizedMarketEvent,
  type RecoveryState,
} from './types'

export interface RecoveryApplyResult {
  state: RecoveryState
  accepted: NormalizedMarketEvent[]
  rejected: NormalizedMarketEvent[]
  lastSequence: number | null
  errorCode: string | null
}

export class BinanceDepthRecovery {
  private state: RecoveryState = 'idle'
  private startedAtMs: number | null = null
  private lastSequence: number | null = null
  private symbol: string | null = null
  private failureCode: string | null = null
  private readonly buffer: NormalizedMarketEvent[] = []

  constructor(private readonly thresholds: FastPathThresholds = { ...DEFAULT_FAST_PATH_THRESHOLDS }) {}

  begin(nowMs: number): void {
    this.state = 'loading_snapshot'
    this.startedAtMs = nowMs
    this.lastSequence = null
    this.symbol = null
    this.failureCode = null
    this.buffer.length = 0
  }

  bufferDelta(event: NormalizedMarketEvent, nowMs: number): RecoveryState {
    this.expireIfNeeded(nowMs)
    if (this.state === 'unavailable') return this.state
    if (this.state === 'idle') this.begin(nowMs)
    if (this.state === 'healthy') return this.state
    if (validateNormalizedEvent(event).length > 0 ||
        event.source !== 'binance' || event.channel !== 'diff_depth' ||
        event.kind !== 'level2' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(event.symbol) ||
        event.sequenceStart === undefined || event.sequenceEnd === undefined ||
        event.receivedTsMs > nowMs || event.exchangeTsMs > nowMs) {
      return this.fail('INVALID_RECOVERY_EVENT')
    }
    if (this.symbol !== null && this.symbol !== event.symbol) {
      return this.fail('RECOVERY_SYMBOL_MISMATCH')
    }
    this.symbol = event.symbol
    if (this.buffer.length >= this.thresholds.maxBufferedEvents) {
      return this.fail('RECOVERY_BUFFER_OVERFLOW')
    }
    this.state = 'buffering'
    // Retain an independent copy so a caller cannot mutate buffered evidence.
    this.buffer.push({ ...event, updates: event.updates?.map(update => ({ ...update })) })
    this.buffer.sort((a, b) => (a.sequenceStart ?? a.sequenceEnd ?? 0) - (b.sequenceStart ?? b.sequenceEnd ?? 0))
    return this.state
  }

  applySnapshot(lastUpdateId: number, nowMs: number): RecoveryApplyResult {
    this.expireIfNeeded(nowMs)
    if (this.state === 'unavailable') {
      return this.result([], [...this.buffer], this.failureCode ?? 'RECOVERY_UNAVAILABLE')
    }

    if (this.state === 'idle' || this.state === 'healthy') {
      return this.result([], [], 'RECOVERY_NOT_STARTED')
    }
    if (!Number.isSafeInteger(lastUpdateId) || lastUpdateId < 0) {
      this.fail('INVALID_SNAPSHOT_SEQUENCE')
      return this.result([], [...this.buffer], this.failureCode)
    }
    this.state = 'bridging'
    const accepted: NormalizedMarketEvent[] = []
    const rejected: NormalizedMarketEvent[] = []
    let sequence = lastUpdateId
    let bridged = false

    for (const event of this.buffer) {
      const start = event.sequenceStart ?? event.sequenceEnd
      const end = event.sequenceEnd ?? event.sequenceStart
      if (start === undefined || end === undefined) {
        rejected.push(event)
        continue
      }
      if (end <= sequence) {
        rejected.push(event)
        continue
      }
      const relation = classifySequence(sequence, start, end)
      if (!bridged) {
        if (start <= sequence + 1 && end >= sequence + 1) {
          accepted.push(event)
          sequence = end
          bridged = true
          continue
        }
        rejected.push(event)
        continue
      }
      if (relation === 'continuous') {
        accepted.push(event)
        sequence = end
        continue
      }
      if (relation === 'duplicate' || relation === 'out_of_order') {
        rejected.push(event)
        continue
      }
      this.state = 'resyncing'
      this.lastSequence = sequence
      // A partial bridge is diagnostic only. Never expose it as an applicable batch.
      return this.result([], [...this.buffer], 'SEQUENCE_GAP')
    }

    if (!bridged) {
      this.state = 'resyncing'
      this.lastSequence = lastUpdateId
      return this.result([], [...this.buffer], 'SNAPSHOT_BRIDGE_NOT_FOUND')
    }

    this.state = 'healthy'
    this.lastSequence = sequence
    this.startedAtMs = null
    this.buffer.length = 0
    return this.result(accepted, rejected, null)
  }

  tick(nowMs: number): RecoveryState {
    this.expireIfNeeded(nowMs)
    return this.state
  }

  reset(): void {
    this.state = 'idle'
    this.startedAtMs = null
    this.lastSequence = null
    this.symbol = null
    this.failureCode = null
    this.buffer.length = 0
  }

  getState(): RecoveryState {
    return this.state
  }

  getLastSequence(): number | null {
    return this.lastSequence
  }

  getBufferedCount(): number {
    return this.buffer.length
  }

  private expireIfNeeded(nowMs: number): void {
    if (this.startedAtMs === null) return
    if (nowMs - this.startedAtMs <= this.thresholds.recoveryTimeoutMs) return
    if (this.state !== 'unavailable') this.fail('RECOVERY_TIMEOUT')
  }

  private fail(code: string): RecoveryState {
    this.state = 'unavailable'
    this.failureCode = code
    return this.state
  }

  private result(
    accepted: NormalizedMarketEvent[],
    rejected: NormalizedMarketEvent[],
    errorCode: string | null,
  ): RecoveryApplyResult {
    return {
      state: this.state,
      accepted,
      rejected,
      lastSequence: this.lastSequence,
      errorCode,
    }
  }
}
