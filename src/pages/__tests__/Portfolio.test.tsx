import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: vi.fn(),
  describePortfolioLoadError: vi.fn((error: { status?: number; message: string }) => (
    error.status === 401 ? 'Authentication failed while loading portfolio data.' : error.message
  )),
}));
vi.mock('@/lib/backend', () => ({
  fetchBackendJson: vi.fn().mockResolvedValue({}),
}));

import Portfolio from '../Portfolio';
import { usePortfolio } from '@/hooks/usePortfolio';

const mockPortfolio = {
  balances: { USDT: 8500 },
  positions: { BTC: 0.01, ETH: 0.5 },
  cashUsdt: 8500,
  equityUsdt: 10250,
  positionsValueUsdt: 1750,
  valuationAvailable: true,
  positionMarks: {
    BTC: { currentPrice: 100000, marketValueUsdt: 1000, unrealizedPnl: 25 },
    ETH: { currentPrice: 1500, marketValueUsdt: 750, unrealizedPnl: -10 },
  },
  orders: [
    {
      id: 'ord-1',
      symbol: 'BTC',
      side: 'BUY',
      order_type: 'MARKET',
      quantity: 0.01,
      price: 97500,
      status: 'FILLED',
      created_at: 1732500000,
    },
    {
      id: 'ord-2',
      symbol: 'ETH',
      side: 'SELL',
      order_type: 'LIMIT',
      quantity: 0.5,
      price: 3500,
      status: 'REJECTED',
      created_at: 1732499000,
    },
  ],
};

beforeEach(() => {
  vi.mocked(usePortfolio).mockReturnValue({
    portfolio: mockPortfolio,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as any);
});

describe('Portfolio page', () => {
  it('renders the page title', () => {
    render(<Portfolio />);
    expect(screen.getByText('Portfolio')).toBeInTheDocument();
  });

  it('shows summary stat cards', () => {
    render(<Portfolio />);
    expect(screen.getByText('Total Equity')).toBeInTheDocument();
    expect(screen.getByText(/Cash/)).toBeInTheDocument();
  });

  it('shows open positions section', () => {
    render(<Portfolio />);
    expect(screen.getByText('Open Positions')).toBeInTheDocument();
  });

  it('shows recent orders section', () => {
    render(<Portfolio />);
    expect(screen.getByText('Recent Orders')).toBeInTheDocument();
  });

  it('renders paper mode footer', () => {
    render(<Portfolio />);
    expect(screen.getByText(/paper trading/i)).toBeInTheDocument();
  });

  it('discloses that current Worker portfolio reads are shared and not session-authorized', () => {
    render(<Portfolio />);
    expect(screen.getByRole('note')).toHaveTextContent(/do not verify the Supabase session/i);
    expect(screen.getByRole('note')).toHaveTextContent(/shared paper-runtime records/i);
  });

  it('shows order status badges', () => {
    render(<Portfolio />);
    expect(screen.getByText('FILLED')).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
  });

  it('shows BUY/SELL side indicators', () => {
    render(<Portfolio />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('shows empty state when no positions', () => {
    vi.mocked(usePortfolio).mockReturnValue({
      portfolio: { balances: { USDT: 10000 }, positions: {}, orders: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);
    render(<Portfolio />);
    expect(screen.getByText(/no open positions/i)).toBeInTheDocument();
  });

  it('does not present unavailable portfolio data as an empty portfolio', () => {
    vi.mocked(usePortfolio).mockReturnValue({
      portfolio: null,
      isLoading: false,
      error: { message: 'Sign in again', status: 401, code: 'AUTHENTICATION_REQUIRED' },
      refetch: vi.fn(),
    } as any);
    render(<Portfolio />);
    expect(screen.getByRole('alert')).toHaveTextContent(/authentication failed/i);
    expect(screen.getByText(/position data unavailable/i)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(3);
  });

  it('shows unavailable valuation instead of substituting cash when the API omits valuation', () => {
    vi.mocked(usePortfolio).mockReturnValue({
      portfolio: {
        ...mockPortfolio,
        equityUsdt: null,
        positionsValueUsdt: null,
        valuationAvailable: false,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);
    render(<Portfolio />);
    expect(screen.getByText('Total Equity').closest('.cyber-card')).toHaveTextContent('Unavailable');
    expect(screen.getByText('Positions Value').closest('.cyber-card')).toHaveTextContent('Unavailable');
  });
});
