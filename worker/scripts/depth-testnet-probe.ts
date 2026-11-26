/** One-shot public TESTNET observation, isolated from deployed Workers.
 * No credentials, subscription writes, orders, account access or persistence.
 */
import { DepthObservationTransport } from '../src/fast-path/depth-observation-transport'
import { FeedHealthRegistry } from '../src/fast-path/feed-health'

export const STREAM = 'wss://stream.testnet.binance.vision/ws/btcusdt@depth@100ms'
export const SNAPSHOT = 'https://testnet.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=100'
const MAX_BYTES = 65536
type Socket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'close'>
type Dependencies = {
  openSocket: (url: string) => Socket
  fetchSnapshot: typeof fetch
  now: () => number
}
type Result = {
  status: string
  socketOpened: boolean
  snapshotReceived: boolean
  snapshotRequested: boolean
  snapshotHttpStatus: number | null
  snapshotFailure: string | null
  bridgeVerified: boolean
  subsequentObservation: boolean
  lastSequence: number | null
  executionAuthorized: false
  providerAccountCertified: false
  network: 'testnet'
}

class SnapshotError extends Error {}

function transportFailure(error: unknown): string {
  if (error instanceof SnapshotError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return 'request_aborted'
  const cause = error instanceof Error ? error.cause : null
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'dns_unavailable'
    case 'ECONNREFUSED': case 'ECONNRESET': case 'ENETUNREACH': return 'connection_unavailable'
    case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT': return 'transport_timeout'
    case 'CERT_HAS_EXPIRED': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN': case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'tls_validation_failed'
    default: return 'transport_or_decode_unavailable'
  }
}

async function boundedText(response: Response): Promise<string> {
  let failure: string | null = null
  if (response.redirected || (response.status >= 300 && response.status < 400)) failure = 'redirect_rejected'
  else if ([401, 403, 451].includes(response.status)) failure = 'access_denied'
  else if ([418, 429].includes(response.status)) failure = 'rate_limited'
  else if (!response.ok) failure = 'http_unavailable'
  else if (!response.body) failure = 'empty_body'
  else if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) failure = 'unexpected_content_type'
  if (failure) {
    // Cancel the body without reading or exposing provider error text.
    void response.body?.cancel().catch(() => undefined)
    throw new SnapshotError(failure)
  }
  if (!response.body) throw new SnapshotError('empty_body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', {fatal: true})
  let total = 0
  let result = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return result + decoder.decode()
      total += chunk.value.byteLength
      if (total > MAX_BYTES) throw new SnapshotError('body_too_large')
      result += decoder.decode(chunk.value, {stream: true})
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function probeTestnetDepth(deps: Dependencies, timeoutMs = 8000): Promise<Result> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 9000) {
    throw new TypeError('Invalid probe deadline')
  }
  return new Promise(resolve => {
    const transport = new DepthObservationTransport('BTC-USDT', new FeedHealthRegistry())
    const abort = new AbortController()
    let socket: Socket | undefined
    let generation: number | null = null
    let finished = false
    let snapshotRequested = false
    let snapshotHttpStatus: number | null = null
    let snapshotFailure: string | null = null
    let snapshot: {raw: string; id: number; attempt: number} | undefined
    let highestSequence = -1
    let bridged = false
    let observed = false
    const timer = setTimeout(() => finish('deadline_exceeded'), timeoutMs)

    function finish(status: string) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      abort.abort()
      if (status === 'deadline_exceeded' && snapshotRequested && !snapshot && !snapshotFailure) snapshotFailure = 'deadline_exceeded'
      const state = transport.status(deps.now())
      if (generation !== null) transport.disconnect(generation, deps.now())
      if (socket) {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
        try { socket.close() } catch { /* already closed or connecting */ }
      }
      resolve({ status, socketOpened: generation !== null, snapshotReceived: !!snapshot,
        snapshotRequested, snapshotHttpStatus, snapshotFailure,
        bridgeVerified: bridged, subsequentObservation: observed,
        lastSequence: state.feed?.lastSequence ?? null, executionAuthorized: false,
        providerAccountCertified: false, network: 'testnet' })
    }
    function onOpen() {
      if (finished || generation !== null) return
      try { generation = transport.connect(deps.now()) }
      catch { finish('transport_clock_invalid') }
    }
    function onClose() { finish('socket_closed') }
    function onError() { finish('socket_unavailable') }
    function tryBridge() {
      if (finished || bridged || !snapshot || generation === null || highestSequence <= snapshot.id) return
      if (!transport.snapshot(generation, snapshot.attempt, snapshot.raw, deps.now())) {
        finish('snapshot_bridge_unverified')
        return
      }
      bridged = true
    }
    async function loadSnapshot(attempt: number) {
      try {
        const response = await deps.fetchSnapshot(SNAPSHOT, {
          method: 'GET', redirect: 'error', credentials: 'omit',
          signal: abort.signal, headers: { Accept: 'application/json' },
        })
        if (finished) { void response.body?.cancel().catch(() => undefined); return }
        snapshotHttpStatus = response.status
        const raw = await boundedText(response)
        if (finished) return
        let id: unknown
        try { id = JSON.parse(raw)?.lastUpdateId } catch { snapshotFailure = 'invalid_json'; finish('snapshot_invalid'); return }
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) { snapshotFailure = 'invalid_sequence'; finish('snapshot_invalid'); return }
        snapshot = {raw, id, attempt}
        tryBridge()
      } catch (error) {
        if (finished) return
        snapshotFailure = transportFailure(error)
        finish('snapshot_unavailable')
      }
    }
    function onMessage(event: MessageEvent) {
      if (finished || generation === null) return
      try {
        if (typeof event.data !== 'string') { finish('frame_invalid'); return }
        const result = transport.receive(generation, event.data, deps.now())
        if (result === 'rejected') { finish('frame_rejected'); return }
        if (result === 'observed') {
          if (!bridged) { finish('unexpected_observation'); return }
          observed = true
          finish('sequence_observed')
          return
        }
        if (bridged) { finish('sequence_gap_after_bridge'); return }
        // The transport has already validated the frame and numeric sequence.
        highestSequence = Math.max(highestSequence, JSON.parse(event.data).u)
        if (!snapshotRequested) {
          snapshotRequested = true
          void loadSnapshot(transport.status(deps.now()).attempt)
        }
        tryBridge()
      } catch { finish('observation_unavailable') }
    }
    try {
      socket = deps.openSocket(STREAM)
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
    } catch { finish('socket_unavailable') }
  })
}
