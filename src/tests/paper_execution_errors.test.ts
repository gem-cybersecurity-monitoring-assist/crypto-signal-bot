import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  SUPABASE_CONFIGURED: true,
  getSupabaseClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'session-token' } } }) },
  }),
}));

vi.mock('../lib/env', () => ({
  getConfiguredBackendUrl: () => 'https://worker.test',
  getConfiguredWebSocketUrl: () => 'wss://worker.test',
}));

import {
  describePaperExecutionError,
  fetchBackendJson,
  FrontendBackendError,
} from '../lib/backendRuntime';

beforeAll(() => {
  // backendRuntime uses window timers; the test environment is node.
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', globalThis);
});

describe('paper execution error guidance', () => {
  it('turns TRADER_ROLE_REQUIRED into the admin grant the user needs', () => {
    const message = describePaperExecutionError(
      new FrontendBackendError('A current GLOBAL TRADER role is required for paper execution.', 403, 'TRADER_ROLE_REQUIRED'),
    );
    expect(message).toMatch(/TRADER role with GLOBAL scope/);
    expect(message).toMatch(/Admin → Access/);
  });

  it('tells signed-out users to sign in and inactive users to ask for reactivation', () => {
    expect(describePaperExecutionError(new FrontendBackendError('x', 401, 'UNAUTHENTICATED'))).toMatch(/Sign in/);
    expect(describePaperExecutionError(new FrontendBackendError('x', 403, 'ACCOUNT_INACTIVE'))).toMatch(/not active/);
  });

  it('keeps the server message for risk rejections and unknown errors', () => {
    expect(describePaperExecutionError(new FrontendBackendError('Risk check blocked the order.', 409, 'RISK_REJECTED')))
      .toBe('Risk check blocked the order.');
    expect(describePaperExecutionError('not an error', 'Trade failed')).toBe('Trade failed');
  });
});

describe('paper intent request', () => {
  it('sends the Supabase session as a Bearer token, never an operator key, and preserves the Worker error code', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'A current GLOBAL TRADER role is required for paper execution.', code: 'TRADER_ROLE_REQUIRED' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchBackendJson('/intent/paper', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', notional_usdt: 100 }),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FrontendBackendError);
    expect((error as FrontendBackendError).status).toBe(403);
    expect((error as FrontendBackendError).code).toBe('TRADER_ROLE_REQUIRED');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer session-token');
    expect(headers.has('X-API-Key')).toBe(false);
    expect(init.credentials).toBe('omit');
  });
});
