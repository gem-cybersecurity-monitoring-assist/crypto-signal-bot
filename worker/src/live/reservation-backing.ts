import { asDecimalString, compareDecimal, sumDecimals } from './decimal.ts'
import type { DecimalString } from './decimal.ts'

export async function hasReservationBacking(env: { DB: D1Database }, accountId: string, orderId: string,
  asset: string, amount: DecimalString, reservedId: string, availableId: string): Promise<boolean> {
  const backing = (await env.DB.prepare(`SELECT e.amount, e.direction, e.ledger_account_id,
    a.exchange_account_id, a.asset, a.account_type FROM ledger_entries e
    JOIN ledger_journals j ON j.journal_id=e.journal_id
    JOIN ledger_accounts a ON a.ledger_account_id=e.ledger_account_id
    WHERE j.exchange_account_id=? AND j.reference_type='ORDER' AND j.reference_id=?
      AND j.event_type='FUNDS_RESERVED' AND j.status='POSTED' AND e.asset=? LIMIT 101`)
    .bind(accountId, orderId, asset).all<{ amount: string; direction: string; ledger_account_id: string;
      exchange_account_id: string; asset: string; account_type: string }>()).results
  if (!backing.length || backing.length > 100 || backing.some((e) => e.exchange_account_id !== accountId
    || e.asset !== asset || !((e.direction === 'DEBIT' && e.ledger_account_id === reservedId)
      || (e.direction === 'CREDIT' && e.ledger_account_id === availableId)))
    || compareDecimal(sumDecimals(backing.filter((e) => e.direction === 'DEBIT').map((e) => asDecimalString(e.amount))), amount) !== 0
    || compareDecimal(sumDecimals(backing.filter((e) => e.direction === 'CREDIT').map((e) => asDecimalString(e.amount))), amount) !== 0) return false
  return true
}
