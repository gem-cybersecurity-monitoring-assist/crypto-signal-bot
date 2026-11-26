import { getSupabaseClient, SUPABASE_CONFIGURED } from '@/integrations/supabase/client';
import { getConfiguredBackendUrl, getConfiguredWebSocketUrl } from './env';

const DEFAULT_TIMEOUT_MS = 10_000;
const BROWSER_BLOCKED_PATH = /\/(?:intent\/live|withdraw(?:al)?s?|mainnet)(?:\/|$)/i;

type BackendRequestInit = RequestInit & {
  timeoutMs?: number;
};

export class FrontendBackendError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'FrontendBackendError';
    this.status = status;
    this.code = code;
  }
}

// Turns Worker authorization codes into the next step the user can take.
// Unknown errors keep the server's message.
const PAPER_EXECUTION_GUIDANCE: Record<string, string> = {
  UNAUTHENTICATED: 'Sign in on the Account page to place paper trades.',
  ACCOUNT_INACTIVE: 'Your account is not active. Ask a release administrator to reactivate it.',
  TRADER_ROLE_REQUIRED:
    'Your account does not have paper-trading access yet. A release administrator must grant the TRADER role with GLOBAL scope in Admin → Access.',
  RATE_LIMITED: 'Too many requests. Wait a minute and try again.',
};

export function describePaperExecutionError(error: unknown, fallback = 'Paper trade failed.'): string {
  if (error instanceof FrontendBackendError && error.code && PAPER_EXECUTION_GUIDANCE[error.code]) {
    return PAPER_EXECUTION_GUIDANCE[error.code];
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function getBackendBaseUrl(): string {
  return getConfiguredBackendUrl();
}

export function getBackendWebSocketUrl(path = '/ws/updates'): string {
  const base = getConfiguredWebSocketUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base.replace(/\/+$/, '')}${normalizedPath}`;
}

function buildBackendUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getBackendBaseUrl().replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function assertBrowserSafe(path: string, method: string): void {
  if (BROWSER_BLOCKED_PATH.test(path)) {
    throw new FrontendBackendError(
      `Browser access to ${path} is blocked. Live trading, mainnet, and withdrawals are server-only and disabled.`,
      403,
    );
  }

  if (method !== 'GET' && method !== 'HEAD' && /\/guardian\/reset/i.test(path)) {
    throw new FrontendBackendError(
      'Guardian reset cannot be initiated from the public frontend.',
      403,
    );
  }
}

function isSpaResponse(contentType: string, body: string): boolean {
  return contentType.includes('text/html')
    || /^\s*<!doctype\s+html\b/i.test(body)
    || /^\s*<(?:html|head|body)\b/i.test(body);
}

async function readError(response: Response, path: string): Promise<{ message: string; code?: string }> {
  const fallback = `Backend request failed (${response.status})`;
  const contentType = response.headers.get('content-type') ?? '';

  try {
    const body = await response.text();
    if (isSpaResponse(contentType, body)) {
      return {
        message: `The API request to ${path} returned an HTML page instead of an API response; the frontend SPA fallback may be handling this URL.`,
        code: 'SPA_FALLBACK_RESPONSE',
      };
    }

    if (contentType.includes('json') || body.trim().startsWith('{')) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      if (payload.error === 'Not found' && typeof payload.path === 'string') {
        return {
          message: `The Worker API route was not found: ${payload.path}`,
          code: 'API_ROUTE_NOT_FOUND',
        };
      }
      const message = payload.detail ?? payload.message ?? payload.error;
      return {
        message: typeof message === 'string' ? message : fallback,
        code: typeof payload.code === 'string'
          ? payload.code
          : response.status === 401
            ? 'AUTHENTICATION_REQUIRED'
            : response.status === 403
              ? 'ACCESS_FORBIDDEN'
              : undefined,
      };
    }
    return {
      message: body || fallback,
      code: response.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : response.status === 403
          ? 'ACCESS_FORBIDDEN'
          : undefined,
    };
  } catch {
    return {
      message: fallback,
      code: response.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : response.status === 403
          ? 'ACCESS_FORBIDDEN'
          : undefined,
    };
  }
}

async function getCurrentAccessToken(): Promise<string | null> {
  if (!SUPABASE_CONFIGURED) return null;
  try {
    const client = await getSupabaseClient();
    const { data, error } = await client.auth.getSession();
    if (error) {
      throw new FrontendBackendError(
        'Unable to verify the current sign-in session. Sign in again before retrying.',
        undefined,
        'AUTH_SESSION_UNAVAILABLE',
      );
    }
    return data.session?.access_token ?? null;
  } catch (error) {
    if (error instanceof FrontendBackendError) throw error;
    throw new FrontendBackendError(
      'Unable to verify the current sign-in session. Sign in again before retrying.',
      undefined,
      'AUTH_SESSION_UNAVAILABLE',
    );
  }
}

async function backendFetch(path: string, init: BackendRequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  assertBrowserSafe(path, method);

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const headers = new Headers(init.headers ?? {});
    headers.set('Accept', headers.get('Accept') ?? 'application/json');
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Authenticated application requests use the current Supabase session.
    // The browser must never receive or send BACKEND_API_KEY/X-API-Key.
    if (!headers.has('Authorization')) {
      const accessToken = await getCurrentAccessToken();
      if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    }

    const response = await fetch(buildBackendUrl(path), {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
      credentials: 'omit',
      cache: init.cache ?? 'no-store',
    });

    if (!response.ok) {
      const { message, code } = await readError(response, path);
      throw new FrontendBackendError(message, response.status, code);
    }

    return response;
  } catch (error) {
    if (error instanceof FrontendBackendError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new FrontendBackendError(`Backend request timed out: ${path}`);
    }
    throw new FrontendBackendError(
      error instanceof Error ? error.message : `Backend request failed: ${path}`,
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchBackendJson<T>(
  path: string,
  init: BackendRequestInit = {},
): Promise<T> {
  const response = await backendFetch(path, init);
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (isSpaResponse(contentType, body)) {
    throw new FrontendBackendError(
      `The API request to ${path} returned an HTML page instead of JSON; the frontend SPA fallback may be handling this URL.`,
      response.status,
      'SPA_FALLBACK_RESPONSE',
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new FrontendBackendError(
      `The API response for ${path} was not valid JSON.`,
      response.status,
      'INVALID_API_JSON',
    );
  }
}

export async function fetchBackendText(
  path: string,
  init: BackendRequestInit = {},
): Promise<string> {
  const response = await backendFetch(path, init);
  return response.text();
}