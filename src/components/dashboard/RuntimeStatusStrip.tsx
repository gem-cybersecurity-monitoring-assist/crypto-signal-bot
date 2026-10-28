import { Activity, AlertTriangle, CheckCircle2, CircleHelp, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

type RuntimeStatusStripProps = {
  backendConnected: boolean;
  websocketConnected: boolean;
  mode: string;
  guardianState: string;
  guardianHalted: boolean;
  marketDataLabel: string;
  riskLabel: string;
};

type StatusItemProps = {
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'warning' | 'danger' | 'neutral';
  icon: typeof Activity;
};

function StatusItem({ label, value, detail, tone = 'neutral', icon: Icon }: StatusItemProps) {
  const toneClasses = {
    good: 'text-accent border-accent/25 bg-accent/5',
    warning: 'text-warning border-warning/25 bg-warning/5',
    danger: 'text-destructive border-destructive/30 bg-destructive/5',
    neutral: 'text-muted-foreground border-border/70 bg-muted/15',
  };

  return (
    <div className={`min-w-0 rounded-lg border p-3 ${toneClasses[tone]}`}>
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="metric-label truncate">{label}</span>
      </div>
      <p className="mt-2 break-words text-sm font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

export function RuntimeStatusStrip({
  backendConnected,
  websocketConnected,
  mode,
  guardianState,
  guardianHalted,
  marketDataLabel,
  riskLabel,
}: RuntimeStatusStripProps) {
  const normalizedMode = mode.toUpperCase();
  const paperMode = normalizedMode === 'PAPER' || normalizedMode === 'TESTNET';

  return (
    <section aria-labelledby="runtime-status-heading" className="cyber-card p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="metric-label">Live operational checks</p>
          <h2 id="runtime-status-heading" className="mt-1 text-sm font-semibold tracking-wide text-foreground">
            Runtime &amp; Safety
          </h2>
        </div>
        <span className="status-chip status-chip-warning">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          PAPER-ONLY WORKFLOW
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatusItem
          label="Runtime mode"
          value={normalizedMode || 'UNKNOWN'}
          detail={paperMode ? 'No live execution from this mode.' : 'Confirm environment before any action.'}
          tone={paperMode ? 'good' : 'warning'}
          icon={ShieldCheck}
        />
        <StatusItem
          label="Backend API"
          value={backendConnected ? 'Connected' : 'Offline'}
          detail={backendConnected ? 'Backend responded to health checks.' : 'Health and account data may be stale.'}
          tone={backendConnected ? 'good' : 'danger'}
          icon={backendConnected ? CheckCircle2 : AlertTriangle}
        />
        <StatusItem
          label="WebSocket"
          value={websocketConnected ? 'Connected' : 'Not connected'}
          detail={websocketConnected ? 'Realtime events available.' : 'Realtime updates may be delayed.'}
          tone={websocketConnected ? 'good' : 'warning'}
          icon={websocketConnected ? Wifi : WifiOff}
        />
        <StatusItem
          label="Market data"
          value={marketDataLabel}
          detail="Source label from the current dashboard data path."
          tone="neutral"
          icon={Activity}
        />
        <StatusItem
          label="Guardian"
          value={guardianState}
          detail={guardianHalted ? 'Trading is halted by a safety control.' : 'Review Guardian details before testing.'}
          tone={guardianHalted ? 'danger' : guardianState === 'NOMINAL' ? 'good' : 'warning'}
          icon={ShieldCheck}
        />
        <StatusItem
          label="Paper-trade access"
          value="Server check required"
          detail="A current global TRADER grant must be confirmed by the API; this panel does not assume access."
          tone="warning"
          icon={CircleHelp}
        />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Signal/risk result: <span className="font-semibold text-foreground">{riskLabel}</span>. A passing dashboard status does not override backend authorization or risk checks.
      </p>
    </section>
  );
}
