// Seeds the paper USDT balance row once. `portfolio` has an AUTOINCREMENT id and
// no unique key, so `INSERT OR IGNORE` never ignores anything and would add a new
// balance row on every Worker cold start. Guard with NOT EXISTS instead.
export const PAPER_BALANCE_SEED_SQL = `INSERT INTO portfolio (symbol, side, quantity, entry_price, current_price, pnl, status)
    SELECT 'USDT', 'balance', 10000, 1.0, 1.0, 0, 'balance'
    WHERE NOT EXISTS (SELECT 1 FROM portfolio WHERE symbol = 'USDT' AND status = 'balance')`

