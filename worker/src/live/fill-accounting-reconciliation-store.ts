import { canonicalHash, canonicalJson } from './canonical-json.ts'
import {
  calculateSignedLedgerBalance,
  reconcileFillAccounting,
  type AccountingReconciliationLot,
  type AccountingReconciliationPosition,
  type FillAccountingReconciliationResult,
} from './fill-accounting-reconciliation.ts'
import {
  addDecimal,
  asDecimalString,
  asSignedDecimalString,
  compareDecimal,
  subtractNonNegativeDecimal,
  type DecimalString,
  type SignedDecimalString,
} from './decimal.ts'
import {
  normalizeExecutionExchange,
  type CanonicalExecutionExchange,
} from './exchange-registry.ts'

export interface FillAccountingReconciliationStoreEnv {
  DB: D1Database
}

export interface PersistFillAccountingReconciliationInput {
  reconciliationId: string
  exchangeName: CanonicalExecutionExchange | string
  exchangeAccountId: string
  productId: string
  baseAsset: string
  quoteAsset: string
  ledgerBaseAccountIds: readonly string[]
  exchangeBaseBalance: DecimalString | null
  currentPrice: DecimalString | null
  exchangeObservationHash: string | null
  observedAt: string
}

export interface PersistFillAccountingReconciliationResult
  extends FillAccountingReconciliationResult {
  projectionStatus: 'PROJECTED' | 'REPLAYED'
  exchangeName: CanonicalExecutionExchange
}

export class FillAccountingReconciliationConflictError extends Error {
  readonly code = 'FILL_ACCOUNTING_RECONCILIATION_CONFLICT'

  constructor(message: string) {
    super(message)
    this.name = 'FillAccountingReconciliationConflictError'
  }
}

export class FillAccountingReconciliationUnavailableError extends Error {
  readonly code = 'FILL_ACCOUNTING_RECONCILIATION_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'FillAccountingReconciliationUnavailableError'
  }
}

type ReconciliationReceiptRow = {
  input_hash: string
  reconciliation_hash: string
  status: 'CLEAR' | 'HALT_FOR_REVIEW'
  reasons_json: string
  reconstructed_quantity: string
  reconstructed_cost_basis_quote: string
  reconstructed_average_entry_price: string | null
  reconstructed_realized_pnl_quote: string
  ledger_base_inventory_balance: string
  exchange_base_balance: string | null
  current_price: string | null
  market_value_quote: string | null
  unrealized_pnl_quote: string | null
  provider_mutation_allowed: number
  reservation_applied: number
  execution_allowed: number
}

type PositionRow = {
  base_asset: string
  quote_asset: string
  quantity: string
  total_cost_basis_quote: string
  average_entry_price: string | null
  cumulative_realized_pnl_quote: string
  status: 'OPEN' | 'CLOSED'
}

type LotRow = {
  base_asset: string
  quote_asset: string
  lot_id: string
  original_quantity: string
  original_cost_quote: string
}

type ConsumptionRow = {
  lot_id: string
  quantity: string
  cost_basis_quote: string
}

type RealizedPnlRow = {
  base_asset: string
  quote_asset: string
  realized_pnl_quote: string
}

type LedgerEntryRow = {
  asset: string
  journal_exchange_account_id: string | null
  direction: 'DEBIT' | 'CREDIT'
  amount: string
}

const ZERO = asDecimalString('0')
const MAX_LEDGER_ACCOUNTS = 20

function required(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${field} is required`)
  return normalized
}

function asset(value: string, field: string): string {
  const normalized = required(value, field).toUpperCase()
  if (!/^[A-Z0-9]{2,20}$/.test(normalized)) {
    throw new TypeError(`${field} must be an uppercase asset code`)
  }
  return normalized
}

function iso(value: string, field: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be ISO-8601`)
  return new Date(parsed).toISOString()
}

function optionalHash(value: string | null, field: string): string | null {
  if (value === null) return null
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash`)
  }
  return normalized
}

function optionalDecimal(value: DecimalString | null, field: string): DecimalString | null {
  return value === null ? null : asDecimalString(value, field)
}

function ledgerAccountIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_LEDGER_ACCOUNTS) {
    throw new RangeError(`ledgerBaseAccountIds must contain 1-${MAX_LEDGER_ACCOUNTS} accounts`)
  }
  const normalized = Array.from(new Set(values.map((value) => required(value, 'ledgerBaseAccountId'))))
  if (normalized.length !== values.length) throw new TypeError('ledgerBaseAccountIds must be unique')
  return Object.freeze(normalized.sort())
}

function parseReasons(value: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new FillAccountingReconciliationConflictError(
      'stored reconciliation reasons are not valid JSON',
    )
  }
  if (!Array.isArray(parsed) || parsed.some((reason) => typeof reason !== 'string')) {
    throw new FillAccountingReconciliationConflictError(
      'stored reconciliation reasons must be a string array',
    )
  }
  return Object.freeze(Array.from(new Set(parsed)).sort())
}

function assertReceiptLocks(row: ReconciliationReceiptRow): void {
  if (
    row.provider_mutation_allowed !== 0
    || row.reservation_applied !== 0
    || row.execution_allowed !== 0
  ) {
    throw new FillAccountingReconciliationConflictError(
      'stored reconciliation violates permanent capability locks',
    )
  }
}

function stableInput(
  input: PersistFillAccountingReconciliationInput,
  exchangeName: CanonicalExecutionExchange,
  normalizedLedgerAccountIds: readonly string[],
  exchangeObservationHash: string | null,
  observedAt: string,
): unknown {
  return {
    reconciliationId: input.reconciliationId,
    exchangeName,
    exchangeAccountId: input.exchangeAccountId,
    productId: input.productId,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    ledgerBaseAccountIds: normalizedLedgerAccountIds,
    exchangeBaseBalance: input.exchangeBaseBalance,
    currentPrice: input.currentPrice,
    exchangeObservationHash,
    observedAt,
  }
}

type LedgerAccountRow = { ledger_account_id: string }
const MAX_EVIDENCE_ROWS = 10000

function boundedRows<T>(result: D1Result<unknown> | undefined): T[] {
  if (!result?.success || !Array.isArray(result.results) || result.results.length > MAX_EVIDENCE_ROWS) {
    throw new FillAccountingReconciliationUnavailableError('reconciliation snapshot unavailable or exceeds evidence bound')
  }
  return result.results as T[]
}

/** One D1 transactional batch captures a consistent projection snapshot.
 * The later receipt describes this snapshot, not current execution clearance.
 */
async function loadEvidenceSnapshot(
  env: FillAccountingReconciliationStoreEnv,
  input: PersistFillAccountingReconciliationInput,
) {
  const placeholders = input.ledgerBaseAccountIds.map(() => '?').join(', ')
  const scope = [input.exchangeAccountId, input.productId]
  const results = await env.DB.batch([
    env.DB.prepare(`
      SELECT base_asset, quote_asset, quantity, total_cost_basis_quote, average_entry_price,
             cumulative_realized_pnl_quote, status
        FROM live_position_accounting
       WHERE exchange_account_id = ? AND product_id = ? LIMIT 1
    `).bind(...scope),
    env.DB.prepare(`
      SELECT lot_id, base_asset, quote_asset, original_quantity, original_cost_quote
        FROM live_cost_basis_lots
       WHERE exchange_account_id = ? AND product_id = ?
       ORDER BY acquired_at ASC, lot_id ASC LIMIT 10001
    `).bind(...scope),
    env.DB.prepare(`
      SELECT c.lot_id, c.quantity, c.cost_basis_quote
        FROM live_cost_basis_consumptions c
        JOIN live_cost_basis_lots l ON l.lot_id = c.lot_id
       WHERE l.exchange_account_id = ? AND l.product_id = ?
       ORDER BY c.consumed_at ASC, c.consumption_id ASC LIMIT 10001
    `).bind(...scope),
    env.DB.prepare(`
      SELECT base_asset, quote_asset, realized_pnl_quote
        FROM live_realized_pnl_events
       WHERE exchange_account_id = ? AND product_id = ?
       ORDER BY realized_at ASC, realized_pnl_event_id ASC LIMIT 10001
    `).bind(...scope),
    env.DB.prepare(`
      SELECT ledger_account_id FROM ledger_accounts
       WHERE exchange_account_id = ? AND asset = ?
         AND account_type IN ('INVENTORY_AVAILABLE', 'INVENTORY_RESERVED')
       ORDER BY ledger_account_id LIMIT 10001
    `).bind(input.exchangeAccountId, input.baseAsset),
    env.DB.prepare(`
      SELECT e.direction, e.amount, e.asset, j.exchange_account_id AS journal_exchange_account_id
        FROM ledger_entries e LEFT JOIN ledger_journals j ON j.journal_id = e.journal_id
       WHERE e.ledger_account_id IN (${placeholders})
       ORDER BY e.created_at ASC, e.entry_id ASC LIMIT 10001
    `).bind(...input.ledgerBaseAccountIds),
  ])
  if (results.length !== 6) {
    throw new FillAccountingReconciliationUnavailableError('incomplete reconciliation snapshot')
  }
  const accounts = boundedRows<LedgerAccountRow>(results[4]).map(row => row.ledger_account_id).sort()
  if (canonicalJson(accounts) !== canonicalJson(input.ledgerBaseAccountIds)) {
    throw new FillAccountingReconciliationConflictError('ledger account scope differs from complete base inventory accounts')
  }
  return {
    position: loadPosition(boundedRows<PositionRow>(results[0])[0] ?? null, input),
    lots: loadLots(boundedRows<LotRow>(results[1]), boundedRows<ConsumptionRow>(results[2]), input),
    realizedPnlEvents: loadRealizedPnl(boundedRows<RealizedPnlRow>(results[3]), input),
    ledgerBaseInventoryBalance: loadLedgerBalance(boundedRows<LedgerEntryRow>(results[5]), input),
  }
}

function assertAssetScope(row: {base_asset: string; quote_asset: string}, input: PersistFillAccountingReconciliationInput): void {
  if (row.base_asset !== input.baseAsset || row.quote_asset !== input.quoteAsset) {
    throw new FillAccountingReconciliationConflictError('accounting projection asset scope mismatch')
  }
}

function loadPosition(row: PositionRow | null, input: PersistFillAccountingReconciliationInput): AccountingReconciliationPosition {
  if (!row) {
    throw new FillAccountingReconciliationUnavailableError(
      'position accounting projection is missing',
    )
  }
  assertAssetScope(row, input)
  return Object.freeze({
    quantity: asDecimalString(row.quantity, 'position.quantity'),
    totalCostBasisQuote: asDecimalString(
      row.total_cost_basis_quote,
      'position.totalCostBasisQuote',
    ),
    averageEntryPrice: row.average_entry_price === null
      ? null
      : asDecimalString(row.average_entry_price, 'position.averageEntryPrice'),
    cumulativeRealizedPnlQuote: asSignedDecimalString(
      row.cumulative_realized_pnl_quote,
      'position.cumulativeRealizedPnlQuote',
    ),
    status: row.status,
  })
}

function loadLots(
  lots: LotRow[],
  consumptions: ConsumptionRow[],
  input: PersistFillAccountingReconciliationInput,
): readonly AccountingReconciliationLot[] {
  const consumedByLot = new Map<string, { quantity: DecimalString; cost: DecimalString }>()
  for (const row of consumptions) {
    const current = consumedByLot.get(row.lot_id) ?? { quantity: ZERO, cost: ZERO }
    current.quantity = addDecimal(
      current.quantity,
      asDecimalString(row.quantity, 'consumption.quantity'),
    )
    current.cost = addDecimal(
      current.cost,
      asDecimalString(row.cost_basis_quote, 'consumption.costBasisQuote'),
    )
    consumedByLot.set(row.lot_id, current)
  }

  return Object.freeze(lots.map((row) => {
    assertAssetScope(row, input)
    const originalQuantity = asDecimalString(row.original_quantity, 'lot.originalQuantity')
    const originalCost = asDecimalString(row.original_cost_quote, 'lot.originalCostQuote')
    const consumed = consumedByLot.get(row.lot_id) ?? { quantity: ZERO, cost: ZERO }
    if (
      compareDecimal(consumed.quantity, originalQuantity) > 0
      || compareDecimal(consumed.cost, originalCost) > 0
    ) {
      throw new FillAccountingReconciliationConflictError(`lot ${row.lot_id} is over-consumed`)
    }
    return Object.freeze({
      lotId: row.lot_id,
      remainingQuantity: subtractNonNegativeDecimal(
        originalQuantity,
        consumed.quantity,
        'lot.remainingQuantity',
      ),
      remainingCostQuote: subtractNonNegativeDecimal(
        originalCost,
        consumed.cost,
        'lot.remainingCostQuote',
      ),
    })
  }))
}

function loadRealizedPnl(
  rows: RealizedPnlRow[], input: PersistFillAccountingReconciliationInput,
): readonly SignedDecimalString[] {
  return Object.freeze(rows.map(row => {
    assertAssetScope(row, input)
    return asSignedDecimalString(row.realized_pnl_quote, 'realizedPnlQuote')
  }))
}

function loadLedgerBalance(
  rows: LedgerEntryRow[], input: PersistFillAccountingReconciliationInput,
): SignedDecimalString {
  return calculateSignedLedgerBalance(rows.map(row => {
    if (row.asset !== input.baseAsset || row.journal_exchange_account_id !== input.exchangeAccountId) {
      throw new FillAccountingReconciliationConflictError('ledger entry asset or journal scope mismatch')
    }
    return { direction: row.direction, amount: asDecimalString(row.amount, 'ledgerEntry.amount') }
  }))
}

function receiptQuery(): string {
  return `
    SELECT input_hash, reconciliation_hash, status, reasons_json,
           reconstructed_quantity, reconstructed_cost_basis_quote,
           reconstructed_average_entry_price,
           reconstructed_realized_pnl_quote, ledger_base_inventory_balance,
           exchange_base_balance, current_price, market_value_quote,
           unrealized_pnl_quote, provider_mutation_allowed,
           reservation_applied, execution_allowed
      FROM live_fill_accounting_reconciliations
     WHERE reconciliation_id = ?
     LIMIT 1
  `
}

function replayResult(
  reconciliationId: string,
  exchangeName: CanonicalExecutionExchange,
  row: ReconciliationReceiptRow,
): PersistFillAccountingReconciliationResult {
  assertReceiptLocks(row)
  return Object.freeze({
    reconciliationId,
    projectionStatus: 'REPLAYED',
    exchangeName,
    status: row.status,
    reasons: parseReasons(row.reasons_json),
    reconstructedQuantity: asDecimalString(
      row.reconstructed_quantity,
      'receipt.reconstructedQuantity',
    ),
    reconstructedCostBasisQuote: asDecimalString(
      row.reconstructed_cost_basis_quote,
      'receipt.reconstructedCostBasisQuote',
    ),
    reconstructedAverageEntryPrice: row.reconstructed_average_entry_price === null
      ? null
      : asDecimalString(
        row.reconstructed_average_entry_price,
        'receipt.reconstructedAverageEntryPrice',
      ),
    reconstructedRealizedPnlQuote: asSignedDecimalString(
      row.reconstructed_realized_pnl_quote,
      'receipt.reconstructedRealizedPnlQuote',
    ),
    ledgerBaseInventoryBalance: asSignedDecimalString(
      row.ledger_base_inventory_balance,
      'receipt.ledgerBaseInventoryBalance',
    ),
    exchangeBaseBalance: row.exchange_base_balance === null
      ? null
      : asDecimalString(row.exchange_base_balance, 'receipt.exchangeBaseBalance'),
    currentPrice: row.current_price === null
      ? null
      : asDecimalString(row.current_price, 'receipt.currentPrice'),
    marketValueQuote: row.market_value_quote === null
      ? null
      : asDecimalString(row.market_value_quote, 'receipt.marketValueQuote'),
    unrealizedPnlQuote: row.unrealized_pnl_quote === null
      ? null
      : asSignedDecimalString(row.unrealized_pnl_quote, 'receipt.unrealizedPnlQuote'),
    reconciliationHash: row.reconciliation_hash,
    providerMutationAllowed: false,
    reservationApplied: false,
    executionAllowed: false,
  })
}

export async function persistFillAccountingReconciliation(
  env: FillAccountingReconciliationStoreEnv,
  input: PersistFillAccountingReconciliationInput,
): Promise<PersistFillAccountingReconciliationResult> {
  const reconciliationId = required(input.reconciliationId, 'reconciliationId')
  const exchangeName = normalizeExecutionExchange(input.exchangeName)
  const exchangeAccountId = required(input.exchangeAccountId, 'exchangeAccountId')
  const productId = required(input.productId, 'productId')
  const baseAsset = asset(input.baseAsset, 'baseAsset')
  const quoteAsset = asset(input.quoteAsset, 'quoteAsset')
  if (baseAsset === quoteAsset) throw new TypeError('baseAsset and quoteAsset must differ')
  const normalizedLedgerAccountIds = ledgerAccountIds(input.ledgerBaseAccountIds)
  const exchangeObservationHash = optionalHash(
    input.exchangeObservationHash,
    'exchangeObservationHash',
  )
  const exchangeBaseBalance = optionalDecimal(
    input.exchangeBaseBalance,
    'exchangeBaseBalance',
  )
  const currentPrice = optionalDecimal(input.currentPrice, 'currentPrice')
  const observedAt = iso(input.observedAt, 'observedAt')
  const normalizedInput: PersistFillAccountingReconciliationInput = {
    ...input,
    reconciliationId,
    exchangeName,
    exchangeAccountId,
    productId,
    baseAsset,
    quoteAsset,
    ledgerBaseAccountIds: normalizedLedgerAccountIds,
    exchangeBaseBalance,
    currentPrice,
    exchangeObservationHash,
    observedAt,
  }
  const inputHash = await canonicalHash(stableInput(
    normalizedInput,
    exchangeName,
    normalizedLedgerAccountIds,
    exchangeObservationHash,
    observedAt,
  ))

  const existing = await env.DB.prepare(receiptQuery())
    .bind(reconciliationId)
    .first<ReconciliationReceiptRow>()

  if (existing) {
    if (existing.input_hash !== inputHash) {
      throw new FillAccountingReconciliationConflictError(
        'reconciliation ID was already used with different evidence',
      )
    }
    return replayResult(reconciliationId, exchangeName, existing)
  }

  const { position, lots, realizedPnlEvents, ledgerBaseInventoryBalance } =
    await loadEvidenceSnapshot(env, normalizedInput)
  const result = await reconcileFillAccounting({
    reconciliationId,
    exchangeName,
    exchangeAccountId,
    productId,
    baseAsset,
    quoteAsset,
    position,
    lots,
    realizedPnlEvents,
    ledgerBaseInventoryBalance,
    exchangeBaseBalance,
    currentPrice,
    observedAt,
  })

  await env.DB.prepare(`
    INSERT INTO live_fill_accounting_reconciliations (
      reconciliation_id, exchange_name, exchange_account_id, product_id,
      base_asset, quote_asset, input_hash, ledger_account_ids_json,
      exchange_observation_hash, status, reasons_json, position_quantity,
      reconstructed_quantity, position_cost_basis_quote,
      reconstructed_cost_basis_quote, reconstructed_average_entry_price,
      position_realized_pnl_quote, reconstructed_realized_pnl_quote,
      ledger_base_inventory_balance, exchange_base_balance, current_price,
      market_value_quote, unrealized_pnl_quote, reconciliation_hash,
      provider_mutation_allowed, reservation_applied, execution_allowed,
      observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
  `).bind(
    reconciliationId,
    exchangeName,
    exchangeAccountId,
    productId,
    baseAsset,
    quoteAsset,
    inputHash,
    canonicalJson(normalizedLedgerAccountIds),
    exchangeObservationHash,
    result.status,
    canonicalJson(result.reasons),
    position.quantity,
    result.reconstructedQuantity,
    position.totalCostBasisQuote,
    result.reconstructedCostBasisQuote,
    result.reconstructedAverageEntryPrice,
    position.cumulativeRealizedPnlQuote,
    result.reconstructedRealizedPnlQuote,
    result.ledgerBaseInventoryBalance,
    result.exchangeBaseBalance,
    result.currentPrice,
    result.marketValueQuote,
    result.unrealizedPnlQuote,
    result.reconciliationHash,
    observedAt,
  ).run()

  const projected = await env.DB.prepare(receiptQuery())
    .bind(reconciliationId)
    .first<ReconciliationReceiptRow>()
  if (!projected) {
    throw new Error('fill-accounting reconciliation receipt is missing after insert')
  }
  assertReceiptLocks(projected)
  if (
    projected.input_hash !== inputHash
    || projected.reconciliation_hash !== result.reconciliationHash
    || projected.status !== result.status
    || canonicalJson(parseReasons(projected.reasons_json)) !== canonicalJson(result.reasons)
    || projected.reconstructed_quantity !== result.reconstructedQuantity
    || projected.reconstructed_cost_basis_quote !== result.reconstructedCostBasisQuote
    || projected.reconstructed_average_entry_price !== result.reconstructedAverageEntryPrice
    || projected.reconstructed_realized_pnl_quote !== result.reconstructedRealizedPnlQuote
    || projected.ledger_base_inventory_balance !== result.ledgerBaseInventoryBalance
    || projected.exchange_base_balance !== result.exchangeBaseBalance
    || projected.current_price !== result.currentPrice
    || projected.market_value_quote !== result.marketValueQuote
    || projected.unrealized_pnl_quote !== result.unrealizedPnlQuote
  ) {
    throw new FillAccountingReconciliationConflictError(
      'fill-accounting reconciliation receipt verification failed',
    )
  }

  return Object.freeze({
    ...result,
    projectionStatus: 'PROJECTED',
    exchangeName,
  })
}
