import { DepthObservationSession } from './depth-observation-session'
import { FeedHealthRegistry } from './feed-health'
import { normalizeBinanceMessage } from './normalizers/binance'

const MAX_FRAME_BYTES = 65536
const MAX_LEVELS = 1024
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function levels(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LEVELS && value.every(level =>
    Array.isArray(level) && level.length === 2 && level.every(item =>
      typeof item === 'string' && item.length <= 32 && DECIMAL.test(item) && Number.isFinite(Number(item))) &&
    Number(level[0]) > 0)
}
function frame(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES ||
      new TextEncoder().encode(raw).length > MAX_FRAME_BYTES) return null
  try { return record(JSON.parse(raw)) } catch { return null }
}

/** Transport callback boundary for deterministic observation/replay.
 * The caller owns sockets, TLS and provider identity. No network is opened here.
 */
export class DepthObservationTransport {
  private readonly session: DepthObservationSession
  private generation = 0
  private connected = false
  private lastReceipt = 0
  private readonly wireSymbol: string

  constructor(private readonly symbol: string, registry: FeedHealthRegistry) {
    this.session = new DepthObservationSession(symbol, registry)
    this.wireSymbol = symbol.replace('-', '')
  }

  connect(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || nowMs < this.lastReceipt) throw new TypeError('Invalid transport clock')
    this.generation += 1
    this.connected = true
    this.lastReceipt = nowMs
    this.session.begin(nowMs)
    return this.generation
  }

  receive(generation: number, raw: string, nowMs: number): 'buffered' | 'observed' | 'rejected' {
    if (!this.current(generation, nowMs)) return 'rejected'
    const data = frame(raw)
    // Require actual provider depth fields. No aliases or symbol hints.
    if (!data || data.e !== 'depthUpdate' || data.s !== this.wireSymbol ||
        !sequence(data.E) || data.E < 1000000000000 || data.E > nowMs ||
        !sequence(data.U) || !sequence(data.u) || data.U > data.u ||
        !levels(data.b) || !levels(data.a) ||
        (data.b as unknown[]).length + (data.a as unknown[]).length === 0) {
      this.disconnect(generation, nowMs)
      return 'rejected'
    }
    const result = this.session.receive(normalizeBinanceMessage(data, nowMs)[0], nowMs)
    return result
  }

  snapshot(generation: number, attempt: number, raw: string, nowMs: number): boolean {
    if (!this.current(generation, nowMs)) return false
    if (this.session.status(nowMs).attempt !== attempt) return false
    const data = frame(raw)
    if (!data || !sequence(data.lastUpdateId) || !levels(data.bids) || !levels(data.asks)) {
      this.disconnect(generation, nowMs)
      return false
    }
    // Snapshot REST response does not carry a symbol. Binding to the requested
    // symbol is a caller contract, not independently authenticated provenance.
    return this.session.applySnapshot({
      source: 'binance', symbol: this.symbol, attempt, receivedAtMs: nowMs,
      lastUpdateId: data.lastUpdateId,
    }, nowMs)
  }

  disconnect(generation: number, nowMs: number): void {
    if (generation !== this.generation || !this.connected) return
    this.connected = false
    this.session.disconnect(Number.isSafeInteger(nowMs) && nowMs >= this.lastReceipt ? nowMs : this.lastReceipt)
  }

  status(nowMs: number) {
    return { ...this.session.status(nowMs), transportGeneration: this.generation,
      transportConnected: this.connected, transportScope: 'caller_owned_unverified' as const }
  }

  private current(generation: number, nowMs: number): boolean {
    if (!this.connected || generation !== this.generation) return false
    if (!Number.isSafeInteger(nowMs) || nowMs < this.lastReceipt) {
      this.disconnect(generation, this.lastReceipt)
      return false
    }
    this.lastReceipt = nowMs
    return true
  }
}
