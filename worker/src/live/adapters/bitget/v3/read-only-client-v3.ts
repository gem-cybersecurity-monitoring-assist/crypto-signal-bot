/**
 * Bitget UTA V3 read-only client.
 *
 * Safety shape (mirrors the V2 read-only client): origin pinning, GET-only
 * frozen endpoint allowlist, HMAC-SHA256+base64 signing, envelope validation
 * (code === '00000'), timeouts, response-size caps, and fail-closed permission
 * assertion. There are no POST/PUT/DELETE code paths in this module — it is
 * structurally incapable of placing orders, independent of any flag or config.
 *
 * Signer verification (byte-for-byte, per the step-1 plan §5): Bitget's UTA
 * docs define the signature as
 *   ACCESS-SIGN = base64(HMAC-SHA256(secretKey,
 *     timestamp + method.toUpperCase() + requestPath + ("?" + queryString) + body))
 * with the body omitted for GET. The UTA GET example
 *   16273667805456 + GET + /api/v3/account/fee-rate + ?category=SPOT&symbol=BTCUSDT
 *   => '16273667805456GET/api/v3/account/fee-rate?category=SPOT&symbol=BTCUSDT'
 * is exactly what `buildBitgetPrehash(timestamp, 'GET', path, query)` from the
 * V2 module produces, and `signBitgetPrehash` applies the same HMAC-SHA256 +
 * base64 construction. The V2 signer is therefore reused. A known-answer test
 * encoding the documented example lives in the endpoint tests.
 *
 * Permission verification checks BOTH /api/v3/account/info, which exposes
 * permType and permissions, and /api/v3/account/settings, which exposes the
 * UTA account's actual accountMode ('hybrid' or 'unified' in the documented enum).
 * It fails closed on unknown/write/withdraw scopes, incompatible account
 * modes, or conflicting user identifiers. No method can send a write request.
 */
import {
  buildBitgetPrehash,
  signBitgetPrehash,
} from '../read-only-client.ts'
import {
  BITGET_V3_API_ORIGIN,
  BITGET_V3_ENDPOINTS,
  assertBitgetV3Category,
  assertBitgetV3PositionSide,
  assertBitgetV3OrderLookupIdentity,
  assertBitgetV3ReadOnlyRequest,
  buildBitgetV3Query,
  isBitgetV3PrivateReadEndpoint,
  normalizeBitgetV3Symbol,
  type BitgetV3Category,
  type BitgetV3PositionSide,
  type BitgetV3ReadOnlyEndpoint,
} from './endpoints-v3.ts'

export interface BitgetV3SecretMaterial {
  apiKey: string
  secretKey: string
  passphrase: string
}

export interface BitgetV3SecretProvider {
  read(): Promise<BitgetV3SecretMaterial>
}

export interface BitgetV3ReadOnlyClientOptions {
  secretProvider: BitgetV3SecretProvider
  fetcher?: typeof fetch
  now?: () => number
  timeoutMs?: number
  maxResponseBytes?: number
  /** Require fresh provider timestamps for isolated authenticated certification. */
  requireFreshResponseTime?: boolean
}

export interface BitgetV3AccountPermissions {
  userId: string
  accountMode: 'hybrid' | 'unified'
  readOnly: true
  permissionsVerified: true
  authorities: readonly string[]
}

const PRIVATE_LIMIT_MAX = 100

export class BitgetV3ReadOnlyClientError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(code: string, message: string, status: number | null = null) {
    super(message)
    this.name = 'BitgetV3ReadOnlyClientError'
    this.code = code
    this.status = status
  }
}

function requiredSecret(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new BitgetV3ReadOnlyClientError('SECRET_UNAVAILABLE', `${field} is unavailable`)
  }
  return normalized
}

/**
 * Fail-closed permission assertion for the V3 read-only client.
 *
 * Verifies (from GET /api/v3/account/settings):
 * - the payload is a well-formed object with a `data` section,
 * - `data.uid` is a non-empty string,
 * - `data.accountMode` is one of the documented UTA modes: 'hybrid' or 'unified';
 * - /api/v3/account/info returns the same UID, permType=read-only/readonly,
 *   and only the explicitly approved uta_trade/uta_mgt scopes.
 * Other modes and permissions remain blocked pending separate review.
 */
export function assertBitgetV3ReadOnlyAuthorities(
  input: unknown,
  accountInfo: unknown,
): BitgetV3AccountPermissions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BitgetV3ReadOnlyClientError(
      'ACCOUNT_SETTINGS_MALFORMED',
      'Bitget V3 account settings must be an object',
    )
  }
  const root = input as Record<string, unknown>
  if (root.code !== '00000' || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
    throw new BitgetV3ReadOnlyClientError('ACCOUNT_SETTINGS_MALFORMED',
      'Bitget V3 account settings lack a verified success envelope')
  }
  const data = root.data as Record<string, unknown>
  const userId = String(data.uid ?? data.userId ?? '').trim()
  if (!userId) {
    throw new BitgetV3ReadOnlyClientError(
      'ACCOUNT_ID_MISSING',
      'Bitget V3 account uid is missing',
    )
  }
  const accountMode = String(data.accountMode ?? '').trim().toLowerCase()
  if (accountMode !== 'hybrid' && accountMode !== 'unified') {
    throw new BitgetV3ReadOnlyClientError(
      'ACCOUNT_MODE_UNVERIFIED',
      'Bitget V3 account settings do not match the reviewed UTA account mode',
    )
  }
  const infoRoot = accountInfo && typeof accountInfo === 'object' && !Array.isArray(accountInfo)
    ? accountInfo as Record<string, unknown> : {}
  const info = infoRoot.data && typeof infoRoot.data === 'object' && !Array.isArray(infoRoot.data)
    ? infoRoot.data as Record<string, unknown> : {}
  const authorities = info.permissions
  if (infoRoot.code !== '00000'
    || String(info.userId ?? '').trim() !== userId
    || !['read-only', 'readonly'].includes(String(info.permType ?? ''))
    || !Array.isArray(authorities)
    || !authorities.includes('uta_trade')
    || !authorities.every((a) => a === 'uta_trade' || a === 'uta_mgt')) {
    throw new BitgetV3ReadOnlyClientError(
      'API_KEY_PERMISSIONS_UNVERIFIED',
      'Bitget V3 account information does not prove a scoped read-only UTA key',
    )
  }
  return Object.freeze({ userId, accountMode: accountMode as 'hybrid' | 'unified', readOnly: true, permissionsVerified: true,
    authorities: Object.freeze([...new Set(authorities)].sort()) })
}

function parseBitgetV3Envelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BitgetV3ReadOnlyClientError(
      'RESPONSE_MALFORMED',
      'Bitget V3 response must be an object',
    )
  }
  const envelope = value as Record<string, unknown>
  const code = String(envelope.code ?? '').trim()
  if (code !== '00000') {
    throw new BitgetV3ReadOnlyClientError('BITGET_V3_API_ERROR',
      'Bitget V3 read-only response lacked verified success evidence')
  }
  return value
}

function validateQuery(
  query: Readonly<Record<string, string | number | boolean | null | undefined>>,
): void {
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const limit = Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > PRIVATE_LIMIT_MAX) {
      throw new BitgetV3ReadOnlyClientError(
        'QUERY_LIMIT_INVALID',
        `limit must be 1-${PRIVATE_LIMIT_MAX}`,
      )
    }
  }
}

export class BitgetV3ReadOnlyClient {
  private readonly secretProvider: BitgetV3SecretProvider
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly requireFreshResponseTime: boolean

  constructor(options: BitgetV3ReadOnlyClientOptions) {
    this.secretProvider = options.secretProvider
    this.fetcher = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000
    this.requireFreshResponseTime = options.requireFreshResponseTime === true
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new BitgetV3ReadOnlyClientError(
        'TIMEOUT_INVALID',
        'timeoutMs must be 100-30000',
      )
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 5_000_000
    ) {
      throw new BitgetV3ReadOnlyClientError(
        'RESPONSE_LIMIT_INVALID',
        'maxResponseBytes must be 1024-5000000',
      )
    }
  }

  async request(
    endpoint: BitgetV3ReadOnlyEndpoint,
    query: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
  ): Promise<unknown> {
    assertBitgetV3ReadOnlyRequest('GET', endpoint)
    validateQuery(query)
    if (endpoint === BITGET_V3_ENDPOINTS.currentPositions) {
      const category = assertBitgetV3Category(query.category)
      if (!['USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES'].includes(category)
          || category !== query.category) {
        throw new TypeError('Bitget V3 positions require a canonical futures category')
      }
      if (Object.keys(query).some(key => !['category', 'symbol', 'posSide'].includes(key))) {
        throw new TypeError('Unsupported current-position query field')
      }
      if (query.posSide !== undefined) assertBitgetV3PositionSide(query.posSide)
    }
    const queryString = buildBitgetV3Query(query)
    const url = new URL(endpoint, BITGET_V3_API_ORIGIN)
    if (url.origin !== BITGET_V3_API_ORIGIN || url.pathname !== endpoint) {
      throw new BitgetV3ReadOnlyClientError(
        'ORIGIN_INVALID',
        'Bitget V3 request origin or path is invalid',
      )
    }
    url.search = queryString

    const headers = new Headers({
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      locale: 'en-US',
    })

    if (isBitgetV3PrivateReadEndpoint(endpoint)) {
      const secrets = await this.secretProvider.read()
      const apiKey = requiredSecret(secrets.apiKey, 'apiKey')
      const passphrase = requiredSecret(secrets.passphrase, 'passphrase')
      const timestamp = String(this.now())
      if (!/^\d{13}$/.test(timestamp)) {
        throw new BitgetV3ReadOnlyClientError(
          'CLOCK_INVALID',
          'Bitget V3 signing clock must return Unix milliseconds',
        )
      }
      const signature = await signBitgetPrehash(
        secrets.secretKey,
        buildBitgetPrehash(timestamp, 'GET', endpoint, queryString),
      )
      headers.set('ACCESS-KEY', apiKey)
      headers.set('ACCESS-SIGN', signature)
      headers.set('ACCESS-TIMESTAMP', timestamp)
      headers.set('ACCESS-PASSPHRASE', passphrase)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new BitgetV3ReadOnlyClientError(
          'HTTP_ERROR',
          `Bitget V3 HTTP ${response.status}`,
          response.status,
        )
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength && Number(contentLength) > this.maxResponseBytes) {
        throw new BitgetV3ReadOnlyClientError(
          'RESPONSE_TOO_LARGE',
          'Bitget V3 response exceeds configured size limit',
        )
      }
      const reader = response.body?.getReader()
      if (!reader) throw new BitgetV3ReadOnlyClientError('RESPONSE_NOT_JSON', 'Bitget V3 body is missing')
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > this.maxResponseBytes) {
            void reader.cancel().catch(() => {})
            throw new BitgetV3ReadOnlyClientError(
              'RESPONSE_TOO_LARGE', 'Bitget V3 response exceeds configured size limit')
          }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let body: string
      try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
      catch { throw new BitgetV3ReadOnlyClientError('RESPONSE_NOT_JSON', 'Bitget V3 body is not valid UTF-8') }
      let parsed: unknown
      try {
        parsed = JSON.parse(body) as unknown
      } catch {
        throw new BitgetV3ReadOnlyClientError(
          'RESPONSE_NOT_JSON',
          'Bitget V3 response is not valid JSON',
        )
      }
      const verified = parseBitgetV3Envelope(parsed)
      if (this.requireFreshResponseTime) {
        const envelope = verified as Record<string, unknown>
        const requestTime = envelope.requestTime
        // Every documented Bitget V3 response includes an integer requestTime.
        // A successful HTTP/API code alone must not certify replayed responses.
        const nowMs = this.now()
        if (typeof requestTime !== 'number' || !Number.isSafeInteger(requestTime)
          || requestTime < 1_000_000_000_000 || !Number.isSafeInteger(nowMs)
          || requestTime > nowMs + 30_000 || nowMs - requestTime > 120_000) {
          throw new BitgetV3ReadOnlyClientError(
            'PROVIDER_RESPONSE_NOT_FRESH', 'Bitget V3 response timestamp is missing or out of bounds',
          )
        }
      }
      return verified
    } catch (error) {
      if (error instanceof BitgetV3ReadOnlyClientError) throw error
      if (controller.signal.aborted) {
        throw new BitgetV3ReadOnlyClientError(
          'TIMEOUT',
          'Bitget V3 read-only request timed out',
        )
      }
      throw new BitgetV3ReadOnlyClientError(
        'NETWORK_ERROR',
        'Bitget V3 read-only request failed',
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async verifyReadOnlyPermissions(): Promise<BitgetV3AccountPermissions> {
    const info = await this.request(BITGET_V3_ENDPOINTS.accountInfo)
    const settings = await this.request(BITGET_V3_ENDPOINTS.accountSettings)
    return assertBitgetV3ReadOnlyAuthorities(settings, info)
  }

  /** Provider-signed GET only. Caller must independently verify account, product,
   * identity and settlement evidence before interpreting any order response. */
  getOrderInfo(identity: unknown): Promise<unknown> {
    return this.request(BITGET_V3_ENDPOINTS.orderInfo,
      assertBitgetV3OrderLookupIdentity(identity))
  }

  getOrderHistory(symbol?: unknown): Promise<unknown> {
    return this.request(BITGET_V3_ENDPOINTS.orderHistory, {
      category: 'SPOT', limit: 10,
      ...(symbol === undefined ? {} : { symbol: normalizeBitgetV3Symbol(symbol) }),
    })
  }

  getAccountAssets(): Promise<unknown> {
    return this.request(BITGET_V3_ENDPOINTS.accountAssets)
  }

  getAccountSettings(): Promise<unknown> {
    return this.request(BITGET_V3_ENDPOINTS.accountSettings)
  }

  async getFundingAssets(coin?: string): Promise<unknown> {
    const normalized = coin === undefined ? undefined : coin.trim().toUpperCase()
    if (normalized !== undefined && !/^[A-Z0-9]{2,20}$/.test(normalized)) {
      throw new BitgetV3ReadOnlyClientError(
        'COIN_INVALID',
        'coin must be a 2-20 character uppercase asset code',
      )
    }
    return this.request(
      BITGET_V3_ENDPOINTS.fundingAssets,
      normalized ? { coin: normalized } : {},
    )
  }

  async getCurrentPositions(
    query: Readonly<{
      category?: unknown
      symbol?: unknown
      posSide?: unknown
    }> = {},
  ): Promise<unknown> {
    const normalized: Record<string, string | number> = {}
    if (query.category !== undefined && query.category !== null && query.category !== '') {
      normalized.category = assertBitgetV3Category(query.category)
    }
    if (query.symbol !== undefined && query.symbol !== null && query.symbol !== '') {
      normalized.symbol = normalizeBitgetV3Symbol(query.symbol)
    }
    if (query.posSide !== undefined && query.posSide !== null && query.posSide !== '') {
      normalized.posSide = assertBitgetV3PositionSide(query.posSide)
    }
    if (!normalized.category || !['USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES'].includes(String(normalized.category))) {
      throw new TypeError('Bitget V3 positions require a futures category')
    }
    return this.request(BITGET_V3_ENDPOINTS.currentPositions, normalized)
  }

  async getInstruments(category: unknown, symbol?: unknown): Promise<unknown> {
    return this.request(BITGET_V3_ENDPOINTS.instruments, {
      category: assertBitgetV3Category(category),
      ...(symbol === undefined ? {} : { symbol: normalizeBitgetV3Symbol(symbol) }),
    })
  }
}

export type {
  BitgetV3Category,
  BitgetV3PositionSide,
  BitgetV3ReadOnlyEndpoint,
}
