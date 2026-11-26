/** Exact marked valuation of hypothetical replay positions. No provider or order authority. */
import type { PortfolioSnapshot } from './PortfolioState.ts'
import {
  asDecimalString as decimal, addDecimal, compareDecimal, multiplyDecimal,
  subtractDecimal, subtractNonNegativeDecimal, divideDecimalDown,
  type DecimalString, type SignedDecimalString,
} from '../live/decimal.ts'

export type ReplayMark = { symbol: string; price: string }
export type ReplayValuation = {
  atMs: number
  marks: ReplayMark[]
  equity: DecimalString
  marketValue: DecimalString
  unrealizedPnl: SignedDecimalString
  drawdownPct: DecimalString
  source: 'hypothetical_replay_marks'
}
const ZERO = decimal('0')
const HUNDRED = decimal('100')
// Explicit isolated replay fixture policy, not a production authorization.
const DRAW_DOWN_LIMIT = decimal('15')

export function normalizeMarks(marks: ReplayMark[]): ReplayMark[] {
  if (!Array.isArray(marks) || marks.length > 32) throw new TypeError('Invalid replay mark set')
  const seen = new Set<string>()
  const result = marks.map(m => {
    if (!m || typeof m.symbol !== 'string' || !/^[A-Z0-9]{2,12}-USDT$/.test(m.symbol) ||
        seen.has(m.symbol) || typeof m.price !== 'string' ||
        !/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/.test(m.price) ||
        compareDecimal(decimal(m.price), ZERO) <= 0) throw new TypeError('Invalid replay mark')
    seen.add(m.symbol)
    return {symbol:m.symbol,price:decimal(m.price)}
  })
  return result.sort((a,b)=>a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)
}

export function computeReplayValuation(state: PortfolioSnapshot, marks: ReplayMark[], atMs: number) {
  if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new TypeError('Invalid replay valuation time')
  const normalized = normalizeMarks(marks)
  const bySymbol = new Map(normalized.map(m => [m.symbol,decimal(m.price)]))
  if (bySymbol.size !== state.positions.length) throw new Error('Incomplete replay mark scope')
  let marketValue = ZERO
  let cost = ZERO
  for (const position of state.positions) {
    const price = bySymbol.get(position.symbol)
    if (!price) throw new Error('Incomplete replay mark scope')
    for (const lot of position.lots) {
      marketValue = addDecimal(marketValue,multiplyDecimal(lot.quantity,price))
      cost = addDecimal(cost,lot.cost)
    }
  }
  const equity = addDecimal(addDecimal(state.cash,state.protectedReserve),marketValue)
  const peak = compareDecimal(equity,state.peakEquity)>0 ? equity : state.peakEquity
  const loss = subtractNonNegativeDecimal(peak,equity)
  const scaledLoss = multiplyDecimal(loss,HUNDRED)
  const drawdownPct = compareDecimal(peak,ZERO)===0 ? ZERO : divideDecimalDown(scaledLoss,peak,18)
  const limitReached = compareDecimal(peak,ZERO)>0 &&
    compareDecimal(scaledLoss,multiplyDecimal(peak,DRAW_DOWN_LIMIT))>=0
  const valuation: ReplayValuation = { atMs,marks:normalized,equity,marketValue,
    unrealizedPnl:subtractDecimal(marketValue,cost),drawdownPct,source:'hypothetical_replay_marks' }
  return {valuation,peakEquity:peak,limitReached}
}
