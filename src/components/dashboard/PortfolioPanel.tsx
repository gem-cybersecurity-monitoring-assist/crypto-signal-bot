import { useState } from 'react';
import { Wallet, TrendingUp, TrendingDown, ArrowUpDown, RefreshCw, Landmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchBackendJson } from '@/lib/backend';
import { toast } from 'sonner';
import type { PortfolioState, PaperOrder } from '@/hooks/usePortfolio';
import { Signal, RiskAssessment } from '@/types/crypto';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface QuickTradeProps {
  symbol: string;
  signal: Signal | null;
  risk: RiskAssessment | null;
  price: number;
  positionQuantity: number;
  tradingMode: string;
  onFilled: () => void;
}

function QuickTrade({ symbol, signal, risk, price, positionQuantity, tradingMode, onFilled }: QuickTradeProps) {
  const [submitting, setSubmitting] = useState(false);
  const side = signal?.direction === 'DOWN' ? 'SELL' : 'BUY';
  const canTrade = Boolean(
    signal &&
    signal.direction !== 'NEUTRAL' &&
    risk &&
    risk.approved &&
    risk.positionSize > 0 &&
    price > 0 &&
    (side === 'BUY' || positionQuantity > 0)
  );

  const handleTrade = async (side: 'BUY' | 'SELL') => {
    if (!risk || !canTrade) return;
    if (tradingMode === 'live') {
      toast.error('Live execution is disabled. Certification rehearsal is the only enabled execution path.');
      return;
    }
    if (side === 'SELL' && positionQuantity <= 0) {
      toast.error('There is no open paper position to close for this asset.');
      return;
    }
    setSubmitting(true);
    try {
      const notional = risk.positionNotionalUsdt;
      if (side === 'BUY' && (typeof notional !== 'number' || !Number.isFinite(notional) || notional <= 0)) {
        throw new Error('The server risk decision did not authorize a paper order size.');
      }
      await fetchBackendJson('/intent/paper', {
        method: 'POST',
        body: JSON.stringify({
          symbol: `${symbol}USDT`,
          side,
          order_type: 'MARKET',
          ...(side === 'BUY'
            ? { notional_usdt: notional }
            : { quantity: positionQuantity }),
        }),
      });
      toast.success(`CERTIFICATION ${side} recorded for ${symbol}`);
      onFilled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Trade failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex gap-2 mt-3 pt-3 border-t border-border/50">
      <Button
        size="sm"
        variant="outline"
        className={cn(
          'flex-1 h-8 text-xs font-mono',
          side === 'BUY'
            ? 'border-accent/50 text-accent hover:bg-accent/10'
            : 'border-destructive/50 text-destructive hover:bg-destructive/10'
        )}
        onClick={() => handleTrade(side)}
        disabled={submitting || !canTrade}
        title={!canTrade ? 'Signal, risk, and live price must be ready for certification rehearsal' : `Rehearse ${side}`}
      >
        {submitting ? (
          <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
        ) : side === 'BUY' ? (
          <TrendingUp className="w-3 h-3 mr-1" />
        ) : (
          <TrendingDown className="w-3 h-3 mr-1" />
        )}
        REHEARSE {side}
      </Button>
    </div>
  );
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

function orderTimeLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusColor(status: string): string {
  switch (status) {
    case 'FILLED': return 'text-accent';
    case 'FAILED': return 'text-destructive';
    case 'RISK_REJECTED': return 'text-warning';
    default: return 'text-muted-foreground';
  }
}

interface PortfolioPanelProps {
  portfolio: PortfolioState | null;
  isLoading?: boolean;
  selectedSymbol?: string;
  selectedPrice?: number;
  signal?: Signal | null;
  risk?: RiskAssessment | null;
  onRefetch?: () => void;
  onActionComplete?: () => void;
  tradingMode?: string;
}

export function PortfolioPanel({
  portfolio,
  isLoading,
  selectedSymbol = 'BTC',
  selectedPrice = 0,
  signal,
  risk,
  onRefetch,
  onActionComplete,
  tradingMode = 'paper',
}: PortfolioPanelProps) {
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState('USDT');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawAddress, setWithdrawAddress] = useState('paper-vault');
  const [withdrawing, setWithdrawing] = useState(false);

  if (isLoading) {
    return (
      <div className="cyber-card p-6 animate-pulse">
        <div className="h-6 w-32 bg-muted rounded mb-4" />
        <div className="h-24 bg-muted rounded" />
      </div>
    );
  }

  const selectedAsset = selectedSymbol.toUpperCase().replace(/[-/](USDT|USD)$/i, '').replace(/(USDT|USD)$/i, '').trim();
  const usdt = portfolio?.balances?.USDT ?? 0;
  const nonUsdtBalances = Object.entries(portfolio?.balances ?? {}).filter(
    ([k, v]) => k !== 'USDT' && v > 0
  );
  const recentOrders: PaperOrder[] = (portfolio?.orders ?? []).slice(-5).reverse();

  const handleWithdraw = async () => {
    setWithdrawing(true);
    try {
      toast.error('Withdrawals are blocked by the certification safety release. The backend /withdraw route must remain HTTP 403.');
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="cyber-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <h3 className="font-display text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Certification Portfolio
          </h3>
        </div>
        {onRefetch && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] font-mono"
              onClick={() => setWithdrawOpen(true)}
              title="Withdrawals are blocked in certification mode"
            >
              <Landmark className="w-3 h-3 mr-1" />
              WITHDRAW BLOCKED
            </Button>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={onRefetch}
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex justify-between items-center">
          <span className="text-xs text-muted-foreground font-mono">USDT</span>
          <span className="text-sm font-mono font-semibold text-foreground">
            {currency.format(usdt)}
          </span>
        </div>
        {nonUsdtBalances.map(([asset, qty]) => (
          <div key={asset} className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground font-mono">{asset}</span>
            <span className="text-sm font-mono text-accent">{compact.format(qty)}</span>
          </div>
        ))}
        {nonUsdtBalances.length === 0 && (
          <p className="text-xs text-muted-foreground/60">No open positions</p>
        )}
      </div>

      {recentOrders.length > 0 && (
        <div className="border-t border-border/50 pt-3">
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowUpDown className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Recent Orders</span>
          </div>
          <div className="space-y-1.5">
            {recentOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'font-mono font-semibold',
                      o.side === 'BUY' ? 'text-accent' : 'text-destructive'
                    )}
                  >
                    {o.side}
                  </span>
                  <span className="text-muted-foreground">{o.symbol}</span>
                  <span className="text-muted-foreground/60">{compact.format(o.quantity)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('font-mono', statusColor(o.status))}>{o.status}</span>
                  <span className="text-muted-foreground/40">{orderTimeLabel(o.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <QuickTrade
        symbol={selectedSymbol}
        signal={signal ?? null}
        risk={risk ?? null}
        price={selectedPrice}
        positionQuantity={portfolio?.positions?.[selectedAsset] ?? 0}
        tradingMode={tradingMode}
        onFilled={() => onActionComplete?.()}
      />

      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="sm:max-w-[420px] bg-card border-border">
          <DialogHeader>
            <DialogTitle>Withdrawals Blocked</DialogTitle>
            <DialogDescription>
              Certification Mode keeps all withdrawals disabled while allowing realistic market, signal, order, accounting, and recovery rehearsal.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 opacity-60">
            <div className="space-y-2">
              <Label htmlFor="withdraw-asset">Asset</Label>
              <Input
                id="withdraw-asset"
                value={withdrawAsset}
                onChange={(event) => setWithdrawAsset(event.target.value)}
                placeholder="USDT"
                autoComplete="off"
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="withdraw-amount">Amount</Label>
              <Input
                id="withdraw-amount"
                type="number"
                min="0"
                step="0.000001"
                value={withdrawAmount}
                onChange={(event) => setWithdrawAmount(event.target.value)}
                placeholder="250"
                autoComplete="off"
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="withdraw-address">Destination</Label>
              <Input
                id="withdraw-address"
                value={withdrawAddress}
                onChange={(event) => setWithdrawAddress(event.target.value)}
                placeholder="paper-vault"
                autoComplete="off"
                disabled
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)} disabled={withdrawing}>
              Close
            </Button>
            <Button onClick={handleWithdraw} disabled={withdrawing} variant="destructive">
              Confirm Blocked
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
