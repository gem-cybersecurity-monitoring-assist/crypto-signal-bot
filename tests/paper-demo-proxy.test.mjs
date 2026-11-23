import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/operator/paper-trade-test-e7d98447.js';

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('paper demo proxy rejects requests without a bearer session', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected fetch'); };
  try {
    const response = mockResponse();
    await handler({ method: 'GET', headers: {} }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, 'authentication_required');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('paper demo proxy forwards the authenticated bearer session', async () => {
  const originalFetch = globalThis.fetch;
  const token = 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature';
  let forwardedAuthorization;
  globalThis.fetch = async (_url, options) => {
    forwardedAuthorization = options.headers.Authorization;
    return new Response(JSON.stringify({ ok: false, error: 'active_global_trader_role_required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const response = mockResponse();
    await handler({ method: 'GET', headers: { authorization: token } }, response);
    assert.equal(forwardedAuthorization, token);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error, 'active_global_trader_role_required');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('paper demo proxy rejects malformed bearer headers', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected fetch'); };
  try {
    const response = mockResponse();
    await handler({ method: 'GET', headers: { authorization: 'Basic abc123' } }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('paper demo proxy rejects non-GET methods', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected fetch'); };
  try {
    const response = mockResponse();
    await handler({ method: 'POST', headers: { authorization: 'Bearer valid.token.value' } }, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.body.error, 'method_not_allowed');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
