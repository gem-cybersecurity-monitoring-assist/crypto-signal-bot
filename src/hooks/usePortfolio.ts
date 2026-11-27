import { useCallback, useEffect, useState } from 'react';
import { fetchBackendJson, FrontendBackendError } from '@/lib/backend';
import { PAPER_DASHBOARD_ROUTES } from '@/lib/paperDashboardRoutes';

export interface BackendPosition {
  symbol?: string;
  quantity?: number | string;
  status?: string;
  current_price?: number | string;
  market_value_usdt?: number | string;
  unrealized_pnl?: number | string;
}

export interface PortfolioSummary {
  balance_usdt?: number | string;
  cash_usdt?: number | string;
  equity_usdt?: number | string;
  positions_value_usdt?: number | string;
  positions?: BackendPosition[] | Record<string, number>;
  open_positions?: BackendPosition[];
}

export interface BackendOrder {
  id?: string | number;
  symbol?: string;
  side?: string;
  order_type?: string;
  quantity?: number | string;
  price?: number | string | null;
  status?: string;
  created_at?: number | string;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: string;
  order_type: string;
  quantity: number;
  price: number | null;
  status: string;
  created_at: number;
}

export interface PortfolioState {
  balances: Record<string, number>;
  positions: Record<string, number>;
  orders: PaperOrder[];
  cashUsdt: number | null;
  equityUsdt: number | null;
  positionsValueUsdt: number | null;
  valuationAvailable: boolean;
  positionMarks: Record<string, {
    currentPrice: number | null;
    marketValueUsdt: number | null;
    unrealizedPnl: number | null;
  }>;
}

export interface PortfolioLoadError {
  message: string;
  status?: number;
  code?: string;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? '')
    .toUpperCase()
    .replace(/[-/](USDT|USD)$/i, '')
    .replace(/(USDT|USD)$/i, '')
    .trim();
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  }
  const raw = String(value ?? '').trim();
  const numeric = Number(raw);
  if (raw && Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function normalizePositions(input: PortfolioSummary['positions'] | undefined): Record<string, number> {
  if (!input) return {};
  if (Array.isArray(input)) {
    return input.reduce<Record<string, number>>((acc, position) => {
      const symbol = normalizeSymbol(position.symbol);
      const quantity = finiteNumber(position.quantity);
      if (symbol && quantity !== null && quantity > 0 && position.status !== 'closed') {
        acc[symbol] = (acc[symbol] ?? 0) + quantity;
      }
      return acc;
    }, {});
  }
  const positions: Record<string, number> = {};
  Object.entries(input).forEach(([rawSymbol, rawQuantity]) => {
    const symbol = normalizeSymbol(rawSymbol);
    const quantity = finiteNumber(rawQuantity);
    if (symbol && quantity !== null && quantity > 0) positions[symbol] = quantity;
  });
  return positions;
}

function normalizeOrder(order: BackendOrder): PaperOrder | null {
  const id = order.id === undefined || order.id === null ? '' : String(order.id);
  const symbol = normalizeSymbol(order.symbol);
  const side = String(order.side ?? '').toUpperCase();
  const quantity = finiteNumber(order.quantity);
  const createdAt = normalizeTimestamp(order.created_at);
  const status = String(order.status ?? '').toUpperCase();
  if (!id || !symbol || (side !== 'BUY' && side !== 'SELL') || quantity === null || createdAt === null || !status) {
    return null;
  }

  return {
    id,
    symbol,
    side,
    order_type: String(order.order_type ?? 'MARKET').toUpperCase(),
    quantity,
    price: order.price === null || order.price === undefined ? null : finiteNumber(order.price),
    status,
    created_at: createdAt,
  };
}

export function describePortfolioLoadError(error: PortfolioLoadError): string {
  if (error.status === 401 || error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'UNAUTHENTICATED') {
    return 'The Worker rejected the portfolio request as unauthenticated (HTTP 401). Confirm the application session and Worker authentication contract.';
  }
  if (error.status === 403 || error.code === 'ACCESS_FORBIDDEN') {
    return 'Portfolio access was denied for the authenticated account. Check the account role or contact an administrator.';
  }
  if (error.code === 'SPA_FALLBACK_RESPONSE') {
    return 'The configured API URL returned the frontend HTML page instead of portfolio JSON. Check API routing and the backend URL.';
  }
  if (error.code === 'API_ROUTE_NOT_FOUND') {
    return `The Worker returned a JSON 404 for the portfolio API route: ${error.message}`;
  }
  return error.message;
}

export function usePortfolio(pollIntervalMs = 10000) {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PortfolioLoadError | null>(null);

  const fetch = useCallback(async () => {
    try {
      const [summaryData, ordData] = await Promise.all([
        fetchBackendJson<PortfolioSummary>(PAPER_DASHBOARD_ROUTES.portfolioSummary),
        fetchBackendJson<{ orders?: BackendOrder[] }>(PAPER_DASHBOARD_ROUTES.orders),
      ]);

      if (!summaryData || typeof summaryData !== 'object' || Array.isArray(summaryData)) {
        throw new FrontendBackendError(
          'The Worker portfolio summary response was not a JSON object.',
          undefined,
          'INVALID_API_RESPONSE',
        );
      }
      if (!ordData || typeof ordData !== 'object' || !Array.isArray(ordData.orders)) {
        throw new FrontendBackendError(
          'The Worker orders response did not contain an orders array.',
          undefined,
          'INVALID_API_RESPONSE',
        );
      }

      const cashUsdt = firstNumber(summaryData.cash_usdt, summaryData.balance_usdt);
      const equityUsdt = firstNumber(summaryData.equity_usdt);
      const positionsValueUsdt = firstNumber(summaryData.positions_value_usdt);
      const positions = normalizePositions(summaryData.open_positions ?? summaryData.positions);
      const positionRows = Array.isArray(summaryData.open_positions) ? summaryData.open_positions : [];
      const positionMarks = positionRows
        .reduce<PortfolioState['positionMarks']>((marks, position) => {
          const symbol = normalizeSymbol(position.symbol);
          if (!symbol) return marks;
          marks[symbol] = {
            currentPrice: firstNumber(position.current_price),
            marketValueUsdt: firstNumber(position.market_value_usdt),
            unrealizedPnl: firstNumber(position.unrealized_pnl),
          };
          return marks;
        }, {});

      setPortfolio({
        balances: { ...(cashUsdt === null ? {} : { USDT: cashUsdt }), ...positions },
        positions,
        orders: ordData.orders.map(normalizeOrder).filter((order): order is PaperOrder => order !== null),
        cashUsdt,
        equityUsdt,
        positionsValueUsdt,
        valuationAvailable: equityUsdt !== null && positionsValueUsdt !== null,
        positionMarks,
      });
      setError(null);
    } catch (cause) {
      const loadError: PortfolioLoadError = cause instanceof FrontendBackendError
        ? { message: cause.message, status: cause.status, code: cause.code }
        : { message: cause instanceof Error ? cause.message : 'Portfolio data is unavailable.' };
      setError(loadError);
      if (loadError.status === 401 || loadError.status === 403) setPortfolio(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const id = window.setInterval(fetch, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [fetch, pollIntervalMs]);

  return { portfolio, isLoading, error, refetch: fetch };
}
