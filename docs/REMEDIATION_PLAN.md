# Remediation Plan

> Prioritized work plan — November 2026. Based on full repository audit.
> Supersedes prior remediation plan from PR #75.

## Completed Work (Prior PRs)

The following has already been delivered across PRs #75–#81 and the current cleanup branch:

- [x] Kill-switch routes, config dedup, reconciliation wiring (PR #75)
- [x] Paper trading SELL dust cleanup, rate limiter thread-safety (PR #75)
- [x] Market data tests, earnings tests, API contract fixes (PR #75)
- [x] Database persistence (SQLite/Postgres), testnet validation (PR #76–77)
- [x] Mainnet gate enforcement, retry logic, rejected order persistence (PR #77)
- [x] WebSocket server, frontend resilience, Render keepalive (PR #79)
- [x] PostgreSQL-ready persistence layer (SQLAlchemy async) (PR #79)
- [x] Live market data (CoinGecko primary, fallback chain) (PR #81)
- [x] CI: pytest + ruff in all workflows, deterministic decision traces (PR #81+)
- [x] Dead code cleanup: 1,862 lines removed (14 orphaned legacy files) (current branch)
- [x] .gitignore updated for Python artifacts (current branch)
- [x] All 8 target documentation files created (stale, being refreshed now)

---

## Phase 1: Backend Structural Refactor (Priority: HIGH)

Goal: Align backend module layout with CLAUDE.md target architecture.

### 1.1 Split `app.py` monolith — IN PROGRESS
**Problem**: `app.py` is ~1,400 lines with ~40 inline endpoints.
**Action**: Extract inline endpoints into existing route modules. `app.py` should contain only FastAPI app creation, lifespan, middleware, and router mounting.
**Files**: `backend/app.py` → distribute to `backend/routes/`
**Risk**: High — most endpoints live here. Must preserve all API contracts.
**Tests**: Run full `test_api.py` (112 tests) after each extraction batch.
**Progress**:
- [x] Created `backend/dependencies.py` with shared `require_auth` (sys.modules approach avoids import cycles)
- [x] Extracted audit/traces/metrics → `backend/routes/audit_v1.py`
- [x] Extracted earnings endpoints → `backend/routes/earnings_v1.py`
- [x] Extracted analysis/simulation → `backend/routes/analysis_v1.py`
- [ ] Remaining ~30 endpoints need DI refactor for module-level state before extraction

### 1.2 Consolidate risk modules — PARTIAL
**Problem**: Risk logic scattered across `logic/risk.py`, `engine/risk_rules.py`, `services/risk_gate/service.py`.
**Action**: Create `backend/risk/` with submodules: `scoring.py` (from logic/risk.py), `rules.py` (from engine/risk_rules.py), `gate.py` (from services/risk_gate/). Re-export public API from `risk/__init__.py`.
**Tests**: `test_risk.py` (14) + `test_risk_gate.py` (27) must pass unchanged.
**Progress**:
- [x] Moved `logic/risk.py` → `backend/risk/scoring.py` (scoring + gating)
- [ ] `engine/risk_rules.py` and `services/risk_gate/` already clean; moving is low-value churn

### 1.3 Split `logic/` grab-bag — DONE (pure modules)
**Problem**: `logic/` has 18 files with no clear boundary — mixes pure logic, adapters, state, and utilities.
**Action**:
- [x] `logic/features.py`, `logic/indicators.py`, `logic/signals.py`, `logic/strategies.py` → `backend/policy/`
- [x] `logic/risk.py` → `backend/risk/scoring.py`
- [x] `logic/audit_store.py` → `backend/audit/store.py`
- [x] `logic/decision_tracer.py` → `backend/audit/tracer.py`
- [ ] Remaining runtime-coupled files (`context.py`, `market_data.py`, `exchange_adapter.py`, etc.) stay in `backend/logic/` — moving requires cross-dependency resolution

### 1.4 Consolidate duplicate exchange code — DONE
**Problem**: `exchanges/` (standalone clients) duplicates `adapters/exchanges/`.
**Action**: Determined `adapters/exchanges/` is canonical (60+ import sites). `exchanges/` was only used by dead engine files.
**Result**: Removed `backend/exchanges/` (779 lines), `engine/gateway_service.py` (413 lines), `engine/withdrawal_manager.py` (218 lines — forbidden per CLAUDE.md).
**Tests**: All tests pass.

### 1.5 Consolidate audit modules — DONE
**Problem**: Audit logic split between `services/audit/service.py` and `logic/audit_store.py`.
**Action**: Created `backend/audit/` with `store.py` (from logic/audit_store.py) and `tracer.py` (from logic/decision_tracer.py).
**Result**: All audit import sites updated. Services/audit/ remains for the service layer.

### 1.6 Resolve duplicate endpoint paths — DONE
**Problem**: Guardian/status and other endpoints appear in multiple route modules.
**Action**: Audited all routes programmatically — no duplicate paths found after route extraction.
**Result**: Clean route map, no conflicts.

---

## Phase 2: Frontend Cleanup (Priority: HIGH)

### 2.1 Consolidate API clients — DONE
**Problem**: `api.ts` (3 consumers) lacks auth token injection that `backendRuntime.ts` has.
**Result**: `api.ts` deleted. All consumers migrated to `@/lib/backend`.

### 2.2 Route or delete stub pages — DONE
**Problem**: 5 unreachable pages (`Audit.tsx`, `Positions.tsx`, `Guardian.tsx`, `Health.tsx`, `PrivacyPolicy.tsx`).
**Result**: 4 stubs deleted. `PrivacyPolicy.tsx` routed at `/privacy`.

### 2.3 Fix stale lint script — DONE
**Problem**: `package.json` lint script still references deleted `src/components/LayoutCore.tsx`.
**Result**: Lint script updated to reference current files.

### 2.4 Extract Index.tsx state — DONE
**Problem**: `Index.tsx` (709 lines) has extensive local state.
**Action**: Extracted auto-trade effect and 8 WebSocket callback handlers into `useDashboardOrchestration` hook.
**Result**: Index.tsx reduced from 710 → 577 lines. No behavior change.

---

## Phase 3: CI & Testing (Priority: MEDIUM)

### 3.1 Enable automatic CI on push/PR — DONE
**Problem**: GitHub Actions `ci.yml` is `workflow_dispatch` only. No CI runs on push or PR.
**Action**: Add `push` and `pull_request` triggers to `ci.yml`. Ensure pytest + tsc + vite build all run.

### 3.2 Expand backend test coverage — MOSTLY DONE
**Test files added**:
- [x] `engine/coordinator.py` — 16 tests (validation, boundary values, exception types)
- [ ] `engine/execution_router.py` — requires async mocks (deferred)
- [x] `engine/pnl.py` — 12 tests (FIFO, partial sells, balance tracking)
- [x] `engine/state_machine.py` — 16 tests (transitions, terminal states, helpers)
- [x] `engine/broker_normalizer.py` — 14 tests (order/position/fill/health normalization)
- [x] `engine/venue_registry.py` — 17 tests (register, availability, symbol filtering)
- [x] `config/loader.py` — 12 tests (sub-config accessors, frozen, URL redaction)
- [ ] `services/portfolio_persistence.py` — requires DB session mocks (deferred)
- [x] `services/websocket_manager.py` — 13 tests (connect/disconnect, broadcast, dead clients)

**Result**: 100+ new tests added. Total backend tests now 580+.

### 3.3 Add frontend component tests
**Problem**: 0 component tests. Only 8 contract/integration test files exist.
**Action**: Add Vitest + React Testing Library tests for critical components (ProtectedRoute, dashboard panels, auth flow).

### 3.4 Promote ruff to blocking — DONE
**Problem**: Ruff runs in advisory mode (`--exit-zero`).
**Action**: Fixed 13 lint errors (unused vars, semicolon statements, duplicate import, trailing whitespace, unreachable code). Removed `--exit-zero` from CI.

---

## Phase 4: Frontend Feature Completion (Priority: MEDIUM)

### 4.1 Implement Settings page — DONE
**Problem**: `Settings.tsx` is routed but shows "coming soon".
**Action**: Build a config screen showing current trading mode, risk parameters, exchange connections, and guardian thresholds. Read-only in paper mode.
**Result**: Full settings page with 4 read-only server config sections (system, risk engine, guardian, market data) + editable dashboard preferences (sliders, toggles) using usePersistedSettings.

### 4.2 Implement Positions view — DONE
**Problem**: Dashboard has `PortfolioPanel` but no dedicated positions page.
**Action**: Build a full positions view with open lots, unrealized PnL, entry prices, and position sizing. Wire to `/portfolio` route.
**Result**: Full portfolio page with summary stats (equity, cash, position value), open positions table with live prices and 24h change, recent order history table with color-coded side/status.

### 4.3 Enhance standalone pages — DONE
**Action**: Build out standalone Health and Audit pages with more detail than the dashboard panels provide. Wire to routes.
**Result**: Built `Health.tsx` (backend service, guardian, market data, monitoring probes) and `Audit.tsx` (tabbed intents/orders/risk events with full history tables). Wired to `/health` and `/audit` routes.

### 4.4 Improve landing page — DONE
**Problem**: `PublicHome.tsx` is minimal (28 lines).
**Action**: Build a polished landing page with product overview, features, paper trading callout.
**Result**: Rewritten with hero, 6-card feature grid, paper-trading safety callout, integration/waitlist links, footer.

---

## Phase 5: Engine & Integration (Priority: MEDIUM)

### 5.1 Wire prediction bot
**Problem**: `services/prediction_bot/` exists but is not integrated into the engine pipeline.
**Action**: Wire into the coordinator's signal evaluation step.

### 5.2 Document Worker/Python boundary
**Problem**: Both layers have signal/risk/execution logic. The boundary is unclear.
**Action**: Produce a boundary document clarifying which layer owns which concern. Ensure no duplicate logic paths can produce conflicting decisions.

---

## Phase 6: Documentation Refresh (Priority: LOW)

### 6.1 Refresh all 8 target docs
All exist in `docs/` but are stale from PR #75 era:
- [x] `ARCHITECTURE_AUDIT.md` — refreshed (this audit)
- [x] `REMEDIATION_PLAN.md` — refreshed (this plan)
- [x] `DECISION_TRACE_SPEC.md` — refreshed, aligned with current implementation
- [x] `API_CONTRACTS.md` — refreshed, matches current endpoint inventory
- [x] `FRONTEND_STRUCTURE.md` — refreshed with current component inventory (18 pages, 20 components, 19 hooks)
- [x] `BACKEND_STRUCTURE.md` — updated for current module map
- [x] `RUNBOOK_LOCAL.md` — updated with integration test command and ruff flags
- [x] `FINAL_CHANGELOG.md` — refreshed with all work on current branch

---

## Phase 7: Pre-Live Preparation (Priority: LOW — blocked on owner authorization)

These items are needed before live trading can be enabled, per CLAUDE.md safety constraints:

- [ ] Integration tests for Binance/Bitget/BTCC live adapters with testnet
- [ ] Testnet validation with real exchange credentials
- [ ] Live adapter review (separate from paper code path)
- [ ] Withdrawal logic design (intentionally not built yet per CLAUDE.md)

---

## Execution Order

```
Phase 1 (backend refactor)  ─────────────────────────────▶  Highest impact, enables all else
Phase 2 (frontend cleanup)  ─────────────────────────────▶  Quick wins, build passes
Phase 3 (CI & testing)      ──────────────────▶              Safety net for refactors
Phase 4 (frontend features) ──────────────────▶              User-facing completeness
Phase 5 (engine/integration)     ──────▶                     Deeper functionality
Phase 6 (docs refresh)               ──────▶                 Maintenance
Phase 7 (pre-live)                         ──────▶           Blocked on authorization
```

**Recommended start**: Phase 1.1 (split app.py) and Phase 2.1 (consolidate API clients) can run in parallel. Phase 3.1 (CI triggers) is a quick win that should be done early.

---

## Risk Assessment

| Risk | Severity | Phase | Mitigation |
|------|----------|-------|------------|
| `app.py` split breaks API contracts | High | 1.1 | Run test_api.py (112 tests) after each extraction |
| Risk consolidation changes behavior | Medium | 1.2 | All 41 risk tests must pass unchanged |
| Module moves break imports | Medium | 1.3 | Use re-exports during transition, then remove |
| No CI catches regressions on PR | Medium | 3.1 | Enable CI triggers early in the plan |
| Worker/Python overlap causes conflicts | Medium | 5.2 | Document boundary before adding features |
| Frontend stub deletion confuses users | Low | 2.2 | Dashboard panels already cover the same data |
