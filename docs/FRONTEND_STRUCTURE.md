# Frontend Structure

> React + TypeScript + Vite SPA with Tailwind CSS and ShadCN/Radix UI.

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite (with `@vitejs/plugin-react-swc`) |
| Styling | Tailwind CSS + `tailwindcss-animate` |
| Components | ShadCN/Radix UI primitives |
| Charts | Recharts |
| Routing | React Router DOM |
| Data Fetching | TanStack React Query + custom hooks |
| Auth | Supabase JS (`@supabase/supabase-js`) |
| Form Handling | React Hook Form + Zod validation |

## Directory Layout

```
src/
├── pages/                       # Route-level page components
│   ├── Index.tsx                # Main dashboard (authenticated)
│   ├── PublicHome.tsx           # Public landing page
│   ├── Auth.tsx                 # Supabase auth page
│   ├── AuthRepair.tsx           # Auth session repair
│   ├── ResetPassword.tsx        # Password reset
│   ├── Account.tsx              # User account page
│   ├── AdminCenter.tsx          # Admin panel (role-gated)
│   ├── Backtest.tsx             # Backtesting interface
│   ├── DashboardDemo.tsx        # Public demo dashboard
│   ├── Infrastructure.tsx       # Infrastructure status
│   ├── IntegrationsStatus.tsx   # Integration health monitor
│   ├── OperatorReadiness.tsx    # Operator readiness checks
│   ├── Portfolio.tsx            # Dedicated portfolio view
│   ├── PrivacyPolicy.tsx        # Privacy policy
│   ├── ProductionStatus.tsx     # Production status page
│   ├── Settings.tsx             # User settings
│   ├── Waitlist.tsx             # Waitlist signup form
│   └── NotFound.tsx             # 404 page
│
├── components/
│   ├── dashboard/               # Dashboard panel components
│   │   ├── Header.tsx           # Top navigation bar
│   │   ├── RuntimeStatusStrip.tsx # Connectivity and mode strip
│   │   ├── PortfolioPanel.tsx   # Balances and positions
│   │   ├── SignalPanel.tsx      # Signal classification display
│   │   ├── GuardianPanel.tsx    # Kill-switch and guardian status
│   │   ├── EarningsPanel.tsx    # P&L summary
│   │   ├── AuditTrailPanel.tsx  # Activity stream
│   │   ├── PriceChart.tsx       # Price chart (Recharts, lazy-loaded)
│   │   ├── PriceTicker.tsx      # Real-time price ticker
│   │   ├── RiskGauge.tsx        # Risk visualization
│   │   ├── SystemMetricsPanel.tsx # Health and metrics
│   │   ├── AIInsightCard.tsx    # AI insight display
│   │   ├── BacktestPanel.tsx    # Backtest results
│   │   ├── CommandConsolePanel.tsx # Operator command console
│   │   ├── MonitoringPanel.tsx  # Monitoring probe status
│   │   ├── SurgePanel.tsx       # Market surge detection
│   │   ├── IndicatorToggles.tsx # Toggle controls
│   │   ├── MicrostructureDisplay.tsx # Market microstructure
│   │   └── SettingsModal.tsx    # User settings dialog
│   │
│   ├── ui/                      # ShadCN primitives (~40 components)
│   │   ├── button.tsx, card.tsx, dialog.tsx, ...
│   │   └── (auto-generated via shadcn CLI)
│   │
│   ├── AuthBanner.tsx           # Auth status banner
│   ├── BackendUnavailable.tsx   # Backend down fallback
│   ├── Card.tsx                 # Generic card wrapper
│   ├── ErrorBoundary.tsx        # React error boundary
│   ├── LoadingScreen.tsx        # Full-screen loading
│   ├── Modal.tsx                # Generic modal wrapper
│   ├── NavLink.tsx              # Navigation link component
│   ├── ProtectedRoute.tsx       # Auth route guard
│   ├── SetupRequired.tsx        # First-run setup prompt
│   ├── SetupRequiredScreen.tsx  # Setup required full screen
│   ├── SystemStatusBanner.tsx   # System status indicator
│   └── Toast.tsx                # Toast notification component
│
├── hooks/                       # Custom React hooks
│   ├── useDashboardOrchestration.ts # Auto-trade effect + WS callback handlers
│   ├── useBackendStatus.ts      # Backend health polling
│   ├── useBackendWebSocket.ts   # WebSocket connection
│   ├── useBackendMetrics.ts     # System metrics
│   ├── usePortfolio.ts          # Balance and position data
│   ├── useSignalEngine.ts       # Signal classification data
│   ├── useGuardianStatus.ts     # Guardian/kill-switch state
│   ├── useEarnings.ts           # P&L data
│   ├── useAuditTrail.ts         # Audit log data
│   ├── useCryptoPrices.ts       # Price data (CoinGecko/backend)
│   ├── useConsole.ts            # Operator console commands
│   ├── useMonitoring.ts         # Monitoring probe data
│   ├── useSurgeScanner.ts       # Market surge detection
│   ├── useStream.ts             # SSE stream connection
│   ├── useExchangeStatus.ts     # Exchange connectivity status
│   ├── useManagementAccess.ts   # Role-based access control
│   ├── useAIInsights.ts         # AI insight data
│   ├── usePersistedSettings.ts  # localStorage settings
│   └── use-toast.ts             # Toast notification hook
│
├── context/                     # React context providers
│   ├── AuthContext.ts           # Auth context definition
│   └── AuthProvider.tsx         # Supabase auth state provider
│
├── lib/                         # Shared utilities and clients
│   ├── backendRuntime.ts        # Backend HTTP client (primary)
│   ├── backendAuth.ts           # Backend auth helpers
│   ├── backendTypes.ts          # Backend response types
│   ├── supabaseClient.ts        # Supabase client config
│   ├── websocket.ts             # WebSocket client helpers
│   ├── streamClient.ts          # SSE stream client
│   ├── runtimeConfig.ts         # Runtime config resolution
│   ├── env.ts                   # Environment variable access
│   ├── queryKeys.ts             # TanStack Query key constants
│   ├── paperSafety.ts           # Paper-mode safety guards
│   ├── paperSignal.ts           # Paper-mode signal helpers
│   ├── paperDashboardRoutes.ts  # Paper dashboard route config
│   ├── guardianStatus.ts        # Guardian status helpers
│   ├── operatorAuth.ts          # Operator auth utilities
│   ├── operatorBoundary.ts      # Operator boundary enforcement
│   ├── operatorReadinessApi.ts  # Operator readiness API client
│   ├── managementApi.ts         # Management API client
│   ├── infrastructureApi.ts     # Infrastructure API client
│   ├── invokeEdgeFunction.ts    # Supabase edge function caller
│   ├── handleAuthError.ts       # Auth error handler
│   ├── authNavigation.ts        # Auth redirect logic
│   └── utils.ts                 # Utility functions (cn, etc.)
│
├── integrations/
│   └── supabase/                # Supabase client config
│
├── providers/
│   └── QueryClientProvider.tsx  # TanStack Query provider
│
├── types/                       # TypeScript type definitions
├── tests/                       # Frontend tests
│
├── App.tsx                      # Re-exports AppCore
├── AppCore.tsx                  # Root component with router + access gates
├── main.tsx                     # Application entry point
└── index.css                    # Global styles (Tailwind)
```

## Routing

| Path | Component | Access Level |
|------|-----------|-------------|
| `/` | `PublicHome` | Public |
| `/auth` | `Auth` | Public |
| `/auth/repair` | `AuthRepair` | Public |
| `/reset-password` | `ResetPassword` | Public |
| `/waitlist` | `Waitlist` | Public |
| `/status` | `ProductionStatus` | Public |
| `/demo` | `DashboardDemo` | Public |
| `/privacy` | `PrivacyPolicy` | Public |
| `/dashboard` | `Index` (Dashboard) | Auth (graceful on role/auth failure) |
| `/backtest` | `Backtest` | Auth + role |
| `/portfolio` | `Portfolio` | Auth + role |
| `/settings` | `Settings` | Auth + role |
| `/account` | `Account` | Auth (no role required) |
| `/integrations` | `IntegrationsStatus` | Auth + role |
| `/infrastructure` | `Infrastructure` | Auth + role |
| `/operator-readiness` | `OperatorReadiness` | Auth + role |
| `/admin/*` | `AdminCenter` | Admin (RISK_ADMIN, AUDITOR, RELEASE_ADMIN) |
| `/home` | Redirects → `/` | — |
| `*` | `NotFound` | Public |

## Removed Pages (Stub Cleanup)

The following stub pages were deleted as part of the remediation:

- `Audit.tsx` — dashboard panel covers this
- `Positions.tsx` — superseded by `PortfolioPanel` and `/portfolio`
- `Guardian.tsx` — dashboard panel covers this
- `Health.tsx` — dashboard panel covers this

## Data Flow

```
Backend API ──→ Custom Hooks (usePortfolio, etc.) ──→ Dashboard Panels
Backend WS  ──→ useBackendWebSocket ──→ useDashboardOrchestration ──→ Coordinated refetches
Supabase    ──→ AuthProvider ──→ AccessGate guards
```

## Design System

The frontend uses a **cyberpunk-inspired dark theme** with:
- Neon accent colors (cyan, magenta, green)
- Dark backgrounds (`bg-background`)
- Glass-panel card effects
- Monospace fonts for data display
- All themed via Tailwind CSS custom properties in `index.css`

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VITE_BACKEND_URL` | Backend API base URL | `/api` |
| `VITE_API_BASE_URL` | Alias for `VITE_BACKEND_URL` | `/api` |
| `VITE_SUPABASE_URL` | Supabase project URL | — |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key | — |

## Build Commands

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (port 8080)
npm run build        # Production build
npm run lint         # ESLint check
npm run preview      # Preview production build
```
