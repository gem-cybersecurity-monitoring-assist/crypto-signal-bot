import type { PortfolioSnapshot } from './PortfolioState.ts'
import { asDecimalString, asSignedDecimalString, addDecimal, addSignedDecimal,
  compareDecimal, compareSignedDecimal, type DecimalString } from '../live/decimal.ts'

const ZERO = asDecimalString('0')
function decimal(value: unknown): DecimalString {
  if (typeof value !== 'string' || value.length > 120 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new Error('Invalid replay accounting amount')
  }
  return asDecimalString(value)
}

/** Book accounting, not a market valuation. No mark prices are inferred. */
export function assertReplayConservation(state: PortfolioSnapshot): DecimalString {
  if (!state || typeof state.portfolioId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(state.portfolioId) ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      typeof state.halted !== 'boolean' || !Array.isArray(state.positions) ||
      state.positions.length > 32) throw new Error('Invalid replay state')
  const opening = decimal(state.initialCash)
  const cash = decimal(state.cash)
  const reserve = decimal(state.protectedReserve)
  if (typeof state.realizedPnl !== 'string' || state.realizedPnl.length > 120 ||
      !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(state.realizedPnl)) throw new Error('Invalid replay P&L')
  let cost = ZERO
  let total = 0
  const symbols = new Set<string>()
  for (const position of state.positions) {
    if (!position || typeof position.symbol !== 'string' || !/^[A-Z0-9]{2,12}-USDT$/.test(position.symbol) ||
        symbols.has(position.symbol) || !Array.isArray(position.lots) ||
        position.lots.length < 1 || position.lots.length > 64) throw new Error('Invalid replay position')
    symbols.add(position.symbol)
    total += position.lots.length
    if (total > 128) throw new Error('Replay lot bound exceeded')
    for (const lot of position.lots) {
      if (!lot || compareDecimal(decimal(lot.quantity),ZERO) <= 0) throw new Error('Invalid replay lot quantity')
      cost = addDecimal(cost,decimal(lot.cost))
    }
  }
  const value = addDecimal(addDecimal(cash,reserve),cost)
  const expected = addSignedDecimal(asSignedDecimalString(opening),asSignedDecimalString(state.realizedPnl))
  if (compareSignedDecimal(asSignedDecimalString(value),expected) !== 0) {
    throw new Error('Replay accounting conservation failed')
  }
  return value
}
