import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { PAPER_BALANCE_SEED_SQL } from '../src/paper-balance-seed.ts'

function portfolioDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL,
    entry_price REAL NOT NULL, current_price REAL, pnl REAL DEFAULT 0,
    status TEXT DEFAULT 'open', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  return db
}

function balanceRows(db: DatabaseSync): Array<{ id: number; quantity: number }> {
  return db.prepare(
    "SELECT id, quantity FROM portfolio WHERE symbol = 'USDT' AND status = 'balance' ORDER BY id",
  ).all() as Array<{ id: number; quantity: number }>
}

test('paper balance seed creates the starting balance on an empty portfolio', () => {
  const db = portfolioDb()
  db.exec(PAPER_BALANCE_SEED_SQL)
  assert.deepEqual(balanceRows(db).map((row) => row.quantity), [10000])
})

test('paper balance seed is idempotent across repeated cold starts', () => {
  const db = portfolioDb()
  for (let i = 0; i < 5; i += 1) db.exec(PAPER_BALANCE_SEED_SQL)
  assert.equal(balanceRows(db).length, 1)
})

test('paper balance seed never overwrites or duplicates a traded balance', () => {
  const db = portfolioDb()
  db.exec(PAPER_BALANCE_SEED_SQL)
  db.exec("UPDATE portfolio SET quantity = 9500 WHERE symbol = 'USDT' AND status = 'balance'")
  db.exec(PAPER_BALANCE_SEED_SQL)
  assert.deepEqual(balanceRows(db).map((row) => row.quantity), [9500])
})
