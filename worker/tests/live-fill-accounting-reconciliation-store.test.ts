import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FillAccountingReconciliationConflictError,
  FillAccountingReconciliationUnavailableError,
  persistFillAccountingReconciliation,
  type FillAccountingReconciliationStoreEnv,
  type PersistFillAccountingReconciliationInput,
} from '../src/live/fill-accounting-reconciliation-store.ts'
import { asDecimalString } from '../src/live/decimal.ts'

interface FakeStatement {
  sql: string
  params: unknown[]
  bind(...params: unknown[]): FakeStatement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<D1Result>
}

type Receipt = {
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

class FakeD1 {
  receipt: Receipt | null = null
  position: Record<string, unknown> | null = {
    base_asset: 'BTC', quote_asset: 'USDT',
    quantity: '0.02',
    total_cost_basis_quote: '900',
    average_entry_price: '45000',
    cumulative_realized_pnl_quote: '240',
    status: 'OPEN',
  }
  lots: Record<string, unknown>[] = [
    { base_asset: 'BTC', quote_asset: 'USDT', lot_id: 'lot-1', original_quantity: '0.01', original_cost_quote: '400' },
    { base_asset: 'BTC', quote_asset: 'USDT', lot_id: 'lot-2', original_quantity: '0.01', original_cost_quote: '500' },
  ]
  consumptions: Record<string, unknown>[] = []
  realizedPnl: Record<string, unknown>[] = [
    { base_asset: 'BTC', quote_asset: 'USDT', realized_pnl_quote: '250' },
    { base_asset: 'BTC', quote_asset: 'USDT', realized_pnl_quote: '-10' },
  ]
  ledgerEntries: Record<string, unknown>[] = [
    { asset: 'BTC', journal_exchange_account_id: 'bitget-account-ref', direction: 'DEBIT', amount: '0.03' },
    { asset: 'BTC', journal_exchange_account_id: 'bitget-account-ref', direction: 'CREDIT', amount: '0.01' },
  ]
  accounts = [
    {ledger_account_id: 'ledger:BTC:inventory'},
    {ledger_account_id: 'ledger:BTC:reserved'},
  ]
  batchCount = 0
  failBatchIndex: number | null = null
  queryCount = 0
  insertCount = 0
  statements: FakeStatement[] = []

  prepare(sql: string): D1PreparedStatement {
    this.queryCount += 1
    const database = this
    const base: FakeStatement = {
      sql,
      params: [],
      bind(...params: unknown[]) {
        const bound: FakeStatement = {
          sql,
          params,
          bind: base.bind,
          first: async <T>() => database.first<T>(sql),
          all: async <T>() => database.all<T>(sql),
          run: async () => database.run(sql, params),
        }
        database.statements.push(bound)
        return bound
      },
      first: async <T>() => database.first<T>(sql),
      all: async <T>() => database.all<T>(sql),
      run: async () => database.run(sql, []),
    }
    return base as unknown as D1PreparedStatement
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.batchCount += 1
    return Promise.all((statements as unknown as FakeStatement[]).map(async (s, index) => ({
      success: index !== this.failBatchIndex,
      results: s.sql.includes('FROM live_position_accounting') ? (this.position ? [this.position] : []) : (await s.all()).results,
    } as D1Result)))
  }

  async first<T>(sql: string): Promise<T | null> {
    if (sql.includes('FROM live_fill_accounting_reconciliations')) {
      return this.receipt as T | null
    }
    if (sql.includes('FROM live_position_accounting')) return this.position as T | null
    return null
  }

  async all<T>(sql: string): Promise<{ results: T[] }> {
    if (sql.includes('FROM live_cost_basis_lots') && !sql.includes('JOIN')) {
      return { results: this.lots as T[] }
    }
    if (sql.includes('FROM live_cost_basis_consumptions')) {
      return { results: this.consumptions as T[] }
    }
    if (sql.includes('FROM live_realized_pnl_events')) {
      return { results: this.realizedPnl as T[] }
    }
    if (sql.includes('FROM ledger_accounts')) return { results: this.accounts as T[] }
    if (sql.includes('FROM ledger_entries')) {
      return { results: this.ledgerEntries as T[] }
    }
    return { results: [] }
  }

  async run(sql: string, params: unknown[]): Promise<D1Result> {
    if (sql.includes('INSERT INTO live_fill_accounting_reconciliations')) {
      this.insertCount += 1
      this.receipt = {
        input_hash: String(params[6]),
        reconciliation_hash: String(params[23]),
        status: params[9] as Receipt['status'],
        reasons_json: String(params[10]),
        reconstructed_quantity: String(params[12]),
        reconstructed_cost_basis_quote: String(params[14]),
        reconstructed_average_entry_price: params[15] === null ? null : String(params[15]),
        reconstructed_realized_pnl_quote: String(params[17]),
        ledger_base_inventory_balance: String(params[18]),
        exchange_base_balance: params[19] === null ? null : String(params[19]),
        current_price: params[20] === null ? null : String(params[20]),
        market_value_quote: params[21] === null ? null : String(params[21]),
        unrealized_pnl_quote: params[22] === null ? null : String(params[22]),
        provider_mutation_allowed: 0,
        reservation_applied: 0,
        execution_allowed: 0,
      }
    }
    return {} as D1Result
  }

  env(): FillAccountingReconciliationStoreEnv {
    return { DB: this as unknown as D1Database }
  }
}

function input(
  overrides: Partial<PersistFillAccountingReconciliationInput> = {},
): PersistFillAccountingReconciliationInput {
  return {
    reconciliationId: 'reconciliation-store-1',
    exchangeName: 'BITGET',
    exchangeAccountId: 'bitget-account-ref',
    productId: 'BTC-USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    ledgerBaseAccountIds: [
      'ledger:BTC:inventory',
      'ledger:BTC:reserved',
    ],
    exchangeBaseBalance: asDecimalString('0.02'),
    currentPrice: asDecimalString('60000'),
    exchangeObservationHash: 'a'.repeat(64),
    observedAt: '2026-07-17T22:00:00.000Z',
    ...overrides,
  }
}

test('matching accounting evidence projects an immutable clear reconciliation', async () => {
  const fake = new FakeD1()
  const result = await persistFillAccountingReconciliation(fake.env(), input())

  assert.equal(result.projectionStatus, 'PROJECTED')
  assert.equal(result.exchangeName, 'BITGET')
  assert.equal(result.status, 'CLEAR')
  assert.deepEqual(result.reasons, [])
  assert.equal(result.reconstructedQuantity, '0.02')
  assert.equal(result.reconstructedCostBasisQuote, '900')
  assert.equal(result.reconstructedAverageEntryPrice, '45000')
  assert.equal(result.reconstructedRealizedPnlQuote, '240')
  assert.equal(result.ledgerBaseInventoryBalance, '0.02')
  assert.equal(result.marketValueQuote, '1200')
  assert.equal(result.unrealizedPnlQuote, '300')
  assert.equal(result.providerMutationAllowed, false)
  assert.equal(result.reservationApplied, false)
  assert.equal(result.executionAllowed, false)
  assert.equal(fake.insertCount, 1)
  assert.equal(fake.batchCount, 1)
  assert.ok(fake.statements.some((statement) => (
    statement.sql.includes('FROM ledger_accounts')
    && statement.sql.includes('AND asset = ?')
  )))
})

test('identical reconciliation replays every immutable result field', async () => {
  const fake = new FakeD1()
  const projected = await persistFillAccountingReconciliation(fake.env(), input())
  const replay = await persistFillAccountingReconciliation(fake.env(), input())

  assert.equal(replay.projectionStatus, 'REPLAYED')
  assert.equal(replay.reconciliationHash, projected.reconciliationHash)
  assert.equal(replay.reconstructedAverageEntryPrice, '45000')
  assert.equal(replay.marketValueQuote, '1200')
  assert.equal(replay.unrealizedPnlQuote, '300')
  assert.equal(fake.insertCount, 1)
})

test('same reconciliation ID with changed evidence is rejected', async () => {
  const fake = new FakeD1()
  await persistFillAccountingReconciliation(fake.env(), input())

  await assert.rejects(
    persistFillAccountingReconciliation(fake.env(), input({
      currentPrice: asDecimalString('61000'),
    })),
    FillAccountingReconciliationConflictError,
  )
  assert.equal(fake.insertCount, 1)
})

test('missing position projection fails closed before insert', async () => {
  const fake = new FakeD1()
  fake.position = null

  await assert.rejects(
    persistFillAccountingReconciliation(fake.env(), input()),
    FillAccountingReconciliationUnavailableError,
  )
  assert.equal(fake.insertCount, 0)
})

test('over-consumed lot is rejected before reconciliation insert', async () => {
  const fake = new FakeD1()
  fake.consumptions = [{
    lot_id: 'lot-1',
    quantity: '0.02',
    cost_basis_quote: '400',
  }]

  await assert.rejects(
    persistFillAccountingReconciliation(fake.env(), input()),
    /lot lot-1 is over-consumed/,
  )
  assert.equal(fake.insertCount, 0)
})

test('Coinbase and unknown providers fail before any D1 query', async () => {
  for (const exchangeName of ['COINBASE', 'UNKNOWN']) {
    const fake = new FakeD1()
    await assert.rejects(
      persistFillAccountingReconciliation(fake.env(), input({ exchangeName })),
      /Unsupported execution exchange/,
    )
    assert.equal(fake.queryCount, 0)
  }
})

test('corrupted replay capability flags are rejected', async () => {
  const fake = new FakeD1()
  await persistFillAccountingReconciliation(fake.env(), input())
  assert.ok(fake.receipt)
  fake.receipt.execution_allowed = 1

  await assert.rejects(
    persistFillAccountingReconciliation(fake.env(), input()),
    /permanent capability locks/,
  )
})

test('invalid replay reasons JSON is rejected', async () => {
  const fake = new FakeD1()
  await persistFillAccountingReconciliation(fake.env(), input())
  assert.ok(fake.receipt)
  fake.receipt.reasons_json = '{not-json'

  await assert.rejects(
    persistFillAccountingReconciliation(fake.env(), input()),
    /stored reconciliation reasons are not valid JSON/,
  )
})

test('ledger account scope is bounded unique and order-normalized for replay', async () => {
  const fake = new FakeD1()
  const projected = await persistFillAccountingReconciliation(fake.env(), input({
    ledgerBaseAccountIds: ['ledger:BTC:reserved', 'ledger:BTC:inventory'],
  }))
  const replay = await persistFillAccountingReconciliation(fake.env(), input({
    ledgerBaseAccountIds: ['ledger:BTC:inventory', 'ledger:BTC:reserved'],
  }))

  assert.equal(projected.reconciliationHash, replay.reconciliationHash)
  await assert.rejects(
    persistFillAccountingReconciliation(new FakeD1().env(), input({
      reconciliationId: 'duplicate-accounts',
      ledgerBaseAccountIds: ['ledger:BTC:inventory', 'ledger:BTC:inventory'],
    })),
    /ledgerBaseAccountIds must be unique/,
  )
})

test('rejects omitted or foreign ledger accounts before creating a receipt', async () => {
  for (const ids of [['ledger:BTC:inventory'], ['foreign-account', 'ledger:BTC:inventory']]) {
    const fake = new FakeD1()
    await assert.rejects(persistFillAccountingReconciliation(fake.env(), input({ledgerBaseAccountIds: ids})),
      /ledger account scope differs/)
    assert.equal(fake.insertCount, 0)
  }
})

test('rejects mismatched asset and journal evidence without suppressing entries', async () => {
  for (const field of ['asset', 'journal_exchange_account_id']) {
    const fake = new FakeD1()
    fake.ledgerEntries[0][field] = 'WRONG'
    await assert.rejects(persistFillAccountingReconciliation(fake.env(), input()), /ledger entry asset or journal scope mismatch/)
    assert.equal(fake.insertCount, 0)
  }
})

test('rejects mismatched position, lot and realized PnL assets', async () => {
  for (const field of ['position', 'lots', 'realizedPnl'] as const) {
    const fake = new FakeD1()
    const row = field === 'position' ? fake.position! : fake[field][0]
    row.quote_asset = 'EUR'
    await assert.rejects(persistFillAccountingReconciliation(fake.env(), input()), /projection asset scope mismatch/)
    assert.equal(fake.insertCount, 0)
  }
})

test('incomplete or oversized transactional snapshot cannot persist a clear receipt', async () => {
  const failed = new FakeD1()
  failed.failBatchIndex = 2
  await assert.rejects(persistFillAccountingReconciliation(failed.env(), input()), FillAccountingReconciliationUnavailableError)
  assert.equal(failed.insertCount, 0)
  const oversized = new FakeD1()
  oversized.ledgerEntries = Array.from({length: 10001}, () => oversized.ledgerEntries[0])
  await assert.rejects(persistFillAccountingReconciliation(oversized.env(), input()), FillAccountingReconciliationUnavailableError)
  assert.equal(oversized.insertCount, 0)
})

test('canonical reconciliation ID replays without an additional evidence read', async () => {
  const fake = new FakeD1()
  const first = await persistFillAccountingReconciliation(fake.env(), input({reconciliationId:' receipt '}))
  const second = await persistFillAccountingReconciliation(fake.env(), input({reconciliationId:'receipt'}))
  assert.equal(first.reconciliationHash, second.reconciliationHash)
  assert.equal(fake.batchCount, 1)
  assert.equal(fake.insertCount, 1)
})

test('real SQLite migrations support a transactional snapshot and reject cross-account journals', async () => {
  const {DatabaseSync} = await import('node:sqlite')
  const {readFileSync} = await import('node:fs')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for (const file of ['005_live_ledger_and_reservations.sql','015_live_fill_accounting.sql']) {
      db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'))
    }
    db.prepare(`INSERT INTO live_position_accounting
      (exchange_account_id,product_id,base_asset,quote_asset,quantity,total_cost_basis_quote,
       cumulative_realized_pnl_quote,status,last_accounting_hash,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('bitget-account-ref','BTC-USDT','BTC','USDT','0','0','0','CLOSED','a'.repeat(64),'2026-07-17T22:00:00.000Z')
    for (const [id,type] of [['ledger:BTC:inventory','INVENTORY_AVAILABLE'],['ledger:BTC:reserved','INVENTORY_RESERVED']]) {
      db.prepare('INSERT INTO ledger_accounts (ledger_account_id,exchange_account_id,asset,account_type) VALUES (?,?,?,?)')
        .run(id,'bitget-account-ref','BTC',type)
    }
    const adapter = {
      prepare(sql: string) {
        const bind = (...params: unknown[]) => ({
          sql,params,bind,
          first: async () => db.prepare(sql).get(...params as never[]) ?? null,
          run: async () => ({success:true,meta:{changes:Number(db.prepare(sql).run(...params as never[]).changes)}}),
        })
        return bind()
      },
      async batch(statements: {sql:string;params:unknown[]}[]) {
        db.exec('BEGIN')
        try {
          const rows = statements.map(s=>({success:true,results:db.prepare(s.sql).all(...s.params as never[])}))
          db.exec('COMMIT')
          return rows
        } catch (error) {db.exec('ROLLBACK');throw error}
      },
    }
    const env={DB:adapter as unknown as D1Database}
    const first=await persistFillAccountingReconciliation(env,input({exchangeBaseBalance:asDecimalString('0')}))
    assert.equal(first.status,'CLEAR')
    assert.equal(first.executionAllowed,false)
    db.prepare(`INSERT INTO ledger_journals
      (journal_id,exchange_account_id,event_type,reference_type,reference_id,correlation_id,idempotency_key)
      VALUES (?,?,?,?,?,?,?)`).run('foreign-journal','foreign-account','TEST','TEST','ref','correlation','idem')
    db.prepare(`INSERT INTO ledger_entries (entry_id,journal_id,ledger_account_id,asset,direction,amount)
      VALUES (?,?,?,?,?,?)`).run('foreign-entry','foreign-journal','ledger:BTC:inventory','BTC','DEBIT','1')
    await assert.rejects(persistFillAccountingReconciliation(env,input({reconciliationId:'foreign-receipt'})),
      /ledger entry asset or journal scope mismatch/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM live_fill_accounting_reconciliations').get()!.n,1)
  } finally {db.close()}
})
