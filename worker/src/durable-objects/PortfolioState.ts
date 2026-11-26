/** Phase 4 isolated paper replay ledger. Not bound to the production Worker.
 * Inputs are precomputed hypothetical fills, not executable market intents.
 * No provider calls, funds, risk allocation, or external projection writes.
 */
import { canonicalHash } from '../live/canonical-json.ts'
import {
  asDecimalString as decimal, asSignedDecimalString as signed,
  addDecimal, addSignedDecimal, subtractDecimal, subtractNonNegativeDecimal,
  compareDecimal, compareSignedDecimal, multiplyDecimal, divideDecimalDown,
  type DecimalString, type SignedDecimalString,
} from '../live/decimal.ts'

type Lot = { quantity: DecimalString; cost: DecimalString }
type Position = { symbol: string; lots: Lot[] }
export type PortfolioSnapshot = {
  portfolioId: string
  version: number
  cash: DecimalString
  protectedReserve: DecimalString
  realizedPnl: SignedDecimalString
  positions: Position[]
  halted: boolean
}
export type ReplayFill = {
  mode: 'isolated_paper_replay'
  portfolioId: string
  eventId: string
  expectedVersion: number
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: string
  simulatedPrice: string
  simulatedFee: string
}
type Receipt = {
  id: string; inputHash: string; version: number
  portfolioId: string; eventId: string; realizedPnl: SignedDecimalString
  state: PortfolioSnapshot
  executionAuthorized: false
  providerMutationAllowed: false
}
type Result = Receipt & { replayed: boolean }
type TransactionStore = Pick<DurableObjectStorage, 'transaction'>
const ZERO = decimal('0')
const ONE_QUARTER = decimal('0.25')
const STATE = 'paper-replay:state'
const MAX_LOTS = 64
const MAX_POSITIONS = 32
const MAX_TOTAL_LOTS = 128
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Invalid replay identity')
  return value
}
function amount(value: unknown, positive = false): DecimalString {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/.test(value)) {
    throw new TypeError('Expected bounded decimal string')
  }
  const result = decimal(value)
  if (positive && compareDecimal(result, ZERO) <= 0) throw new TypeError('Expected positive amount')
  return result
}
function normalized(input: ReplayFill) {
  if (input.mode !== 'isolated_paper_replay' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      !['BUY','SELL'].includes(input.side) || !/^[A-Z0-9]{2,12}-USDT$/.test(input.symbol)) {
    throw new TypeError('Invalid paper replay event')
  }
  return {
    mode: input.mode, portfolioId: identifier(input.portfolioId),
    eventId: identifier(input.eventId), expectedVersion: input.expectedVersion,
    symbol: input.symbol, side: input.side, quantity: amount(input.quantity, true),
    simulatedPrice: amount(input.simulatedPrice, true), simulatedFee: amount(input.simulatedFee),
  }
}

/** Storage transaction is the only writer. All receipts and outbox events
 * commit together with the replay state, or not at all.
 */
export class PortfolioReplayLedger {
  constructor(private readonly storage: TransactionStore, private readonly boundPortfolioId?: string | null) {}

  private assertScope(portfolioId: string): void {
    if (this.boundPortfolioId !== undefined && this.boundPortfolioId !== portfolioId) {
      throw new Error('Replay portfolio scope mismatch')
    }
  }

  async initialize(portfolioId: string, initialCash: string): Promise<PortfolioSnapshot> {
    const id = identifier(portfolioId)
    this.assertScope(id)
    const cash = amount(initialCash)
    return this.storage.transaction(async tx => {
      if (await tx.get(STATE)) throw new Error('Replay portfolio already initialized')
      const state: PortfolioSnapshot = {
        portfolioId: id, version: 0, cash, protectedReserve: ZERO,
        realizedPnl: signed('0'), positions: [], halted: false,
      }
      await tx.put(STATE, state)
      return state
    })
  }

  async snapshot(): Promise<PortfolioSnapshot | null> {
    return this.storage.transaction(async tx => {
      const state = await tx.get<PortfolioSnapshot>(STATE) ?? null
      if (state) this.assertScope(state.portfolioId)
      return state
    })
  }

  /** One-way local replay halt. No reset or shared risk clearance implied. */
  async halt(portfolioId: string): Promise<PortfolioSnapshot> {
    this.assertScope(identifier(portfolioId))
    return this.storage.transaction(async tx => {
      const state = await tx.get<PortfolioSnapshot>(STATE)
      if (!state || state.portfolioId !== identifier(portfolioId)) throw new Error('Replay portfolio mismatch')
      if (state.halted) return state
      const next = { ...state, halted: true, version: state.version + 1 }
      await tx.put(STATE, next)
      await tx.put('paper-replay:outbox:' + next.version, { type: 'replay_halted', state: next, executionAuthorized: false })
      return next
    })
  }

  async apply(input: ReplayFill): Promise<Result> {
    const event = normalized(input)
    this.assertScope(event.portfolioId)
    const inputHash = await canonicalHash(event)
    const id = await canonicalHash({ portfolioId: event.portfolioId, eventId: event.eventId })
    const receiptKey = 'paper-replay:receipt:' + id
    return this.storage.transaction(async tx => {
      const state = await tx.get<PortfolioSnapshot>(STATE)
      if (!state || state.portfolioId !== event.portfolioId) throw new Error('Replay portfolio mismatch')
      const existing = await tx.get<Receipt>(receiptKey)
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error('Replay event identity conflict')
        return { ...existing, replayed: true }
      }
      if (state.halted) throw new Error('Replay portfolio halted')
      if (state.version !== event.expectedVersion) throw new Error('Replay state version conflict')
      if (!Number.isSafeInteger(state.version + 1)) throw new Error('Replay version exhausted')
      const next: PortfolioSnapshot = structuredClone(state)
      next.version++
      const notional = multiplyDecimal(event.quantity, event.simulatedPrice)
      let pnl = signed('0')
      const position = next.positions.find(p => p.symbol === event.symbol)
      if (event.side === 'BUY') {
        if (next.positions.reduce((n,p)=>n+p.lots.length,0) >= MAX_TOTAL_LOTS) throw new Error('Replay total lot bound reached')
        const cost = addDecimal(notional, event.simulatedFee)
        next.cash = subtractNonNegativeDecimal(next.cash, cost, 'reusable cash')
        if (position) {
          if (position.lots.length >= MAX_LOTS) throw new Error('Replay lot bound reached')
          position.lots.push({ quantity: event.quantity, cost })
        } else {
          if (next.positions.length >= MAX_POSITIONS) throw new Error('Replay position bound reached')
          next.positions.push({ symbol: event.symbol, lots: [{ quantity: event.quantity, cost }] })
        }
      } else {
        if (!position) throw new Error('Insufficient replay inventory')
        let remaining = event.quantity
        let cost = ZERO
        while (compareDecimal(remaining, ZERO) > 0) {
          const lot = position.lots[0]
          if (!lot) throw new Error('Insufficient replay inventory')
          if (compareDecimal(remaining, lot.quantity) >= 0) {
            remaining = subtractNonNegativeDecimal(remaining, lot.quantity)
            cost = addDecimal(cost, lot.cost)
            position.lots.shift()
          } else {
            const allocated = divideDecimalDown(multiplyDecimal(lot.cost, remaining), lot.quantity, 18)
            lot.quantity = subtractNonNegativeDecimal(lot.quantity, remaining)
            lot.cost = subtractNonNegativeDecimal(lot.cost, allocated)
            cost = addDecimal(cost, allocated)
            remaining = ZERO
          }
        }
        if (!position.lots.length) next.positions = next.positions.filter(p => p.symbol !== event.symbol)
        const proceeds = subtractNonNegativeDecimal(notional, event.simulatedFee, 'net simulated proceeds')
        pnl = subtractDecimal(proceeds, cost)
        next.realizedPnl = addSignedDecimal(next.realizedPnl, pnl)
        const transfer = compareSignedDecimal(pnl, signed('0')) > 0
          ? multiplyDecimal(decimal(pnl), ONE_QUARTER) : ZERO
        next.protectedReserve = addDecimal(next.protectedReserve, transfer)
        next.cash = addDecimal(next.cash, subtractNonNegativeDecimal(proceeds, transfer))
      }
      const receipt: Receipt = {
        id, inputHash, version: next.version, portfolioId: next.portfolioId,
        eventId: event.eventId, realizedPnl: pnl, state: next,
        executionAuthorized: false, providerMutationAllowed: false,
      }
      await tx.put(STATE, next)
      await tx.put(receiptKey, receipt)
      await tx.put('paper-replay:outbox:' + next.version, { type: 'replay_fill', receipt })
      return { ...receipt, replayed: false }
    })
  }
}

/** Candidate Durable Object; intentionally not exported from a deployed entrypoint.
 * All public HTTP requests fail closed. A reviewed internal RPC binding and
 * verified risk/market-event authority are separate migration gates.
 */
export class PortfolioState {
  readonly ledger: PortfolioReplayLedger
  constructor(state: DurableObjectState) { this.ledger = new PortfolioReplayLedger(state.storage, state.id.name ?? null) }
  async fetch(): Promise<Response> {
    return Response.json({ error: 'portfolio_replay_not_exposed', executionAuthorized: false }, { status: 403 })
  }
}
