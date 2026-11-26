import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, MockFrontendBackendError } = vi.hoisted(() => {
  class MockFrontendBackendError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  return { fetchMock: vi.fn(), MockFrontendBackendError };
});

vi.mock('@/lib/backend', () => ({
  fetchBackendJson: fetchMock,
  FrontendBackendError: MockFrontendBackendError,
  getBackendBaseUrl: () => 'https://worker.test',
}));

import { describePortfolioLoadError, usePortfolio } from '@/hooks/usePortfolio';
import { useBackendStatus } from '@/hooks/useBackendStatus';
import { PAPER_DASHBOARD_ROUTES } from '@/lib/paperDashboardRoutes';

describe('authenticated Worker portfolio read contract', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('uses the Worker summary fields as reported, without a second client-side valuation', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === PAPER_DASHBOARD_ROUTES.portfolioSummary) {
        return {
          cash_usdt: 8500,
          equity_usdt: 10250,
          positions_value_usdt: 1750,
          open_positions: [{
            symbol: 'BTCUSDT',
            quantity: 0.01,
            current_price: 100000,
            market_value_usdt: 1000,
            unrealized_pnl: 25,
          }],
        };
      }
      if (path === PAPER_DASHBOARD_ROUTES.orders) {
        return {
          orders: [
            {
              id: 'ord-1',
              symbol: 'BTCUSDT',
              side: 'BUY',
              order_type: 'MARKET',
              quantity: 0.01,
              price: 97500,
              status: 'FILLED',
              created_at: 1732500000,
            },
            { symbol: 'BTCUSDT', quantity: 1 },
          ],
        };
      }
      throw new Error(`Unexpected dashboard endpoint: ${path}`);
    });

    const { result, unmount } = renderHook(() => usePortfolio(60_000));
    await waitFor(() => expect(result.current.portfolio?.equityUsdt).toBe(10250));

    expect(result.current.portfolio).toMatchObject({
      cashUsdt: 8500,
      positionsValueUsdt: 1750,
      valuationAvailable: true,
      positions: { BTC: 0.01 },
      positionMarks: {
        BTC: { currentPrice: 100000, marketValueUsdt: 1000, unrealizedPnl: 25 },
      },
      orders: [{ id: 'ord-1', side: 'BUY', status: 'FILLED' }],
    });
    expect(fetchMock.mock.calls.map(([path]) => path).sort()).toEqual([
      PAPER_DASHBOARD_ROUTES.orders,
      PAPER_DASHBOARD_ROUTES.portfolioSummary,
    ].sort());
    unmount();
  });

  it('leaves valuation unavailable when the API omits its valuation fields', async () => {
    fetchMock.mockImplementation(async (path: string) => (
      path === PAPER_DASHBOARD_ROUTES.portfolioSummary
        ? { cash_usdt: 100, open_positions: [] }
        : { orders: [] }
    ));

    const { result, unmount } = renderHook(() => usePortfolio(60_000));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.portfolio?.cashUsdt).toBe(100);
    expect(result.current.portfolio?.equityUsdt).toBeNull();
    expect(result.current.portfolio?.valuationAvailable).toBe(false);
    unmount();
  });

  it('exposes authentication failures and clears previously loaded account data', async () => {
    fetchMock.mockImplementation(async () => {
      throw new MockFrontendBackendError('Unauthorized', 401, 'AUTHENTICATION_REQUIRED');
    });

    const { result, unmount } = renderHook(() => usePortfolio(60_000));
    await waitFor(() => expect(result.current.error?.status).toBe(401));

    expect(result.current.portfolio).toBeNull();
    expect(describePortfolioLoadError(result.current.error!)).toMatch(/unauthenticated/i);
    unmount();
  });

  it('does not label a cash-only summary as dashboard equity', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === PAPER_DASHBOARD_ROUTES.health) return { status: 'ok' };
      if (path === PAPER_DASHBOARD_ROUTES.runtimeStatus) return {};
      if (path === PAPER_DASHBOARD_ROUTES.exchangeStatus) return { status: 'paper_only' };
      if (path === PAPER_DASHBOARD_ROUTES.portfolioSummary) return { cash_usdt: 8500 };
      throw new Error(`Unexpected dashboard endpoint: ${path}`);
    });

    const { result, unmount } = renderHook(() => useBackendStatus(60_000));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.paperBalance).toBeNull();
    expect(result.current.endpointErrors.balanceError).toContain('equity_usdt');
    unmount();
  });
});
