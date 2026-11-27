const DEFAULT_FRONTEND_URL = 'https://crypto-signal-bot-indol.vercel.app';
const CURRENT_WORKER = 'https://crypto-signal-bot-api.analyzer-d94.workers.dev';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class VerificationError extends Error {}

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new VerificationError(`${name} requires a URL`);
  return value.replace(/\/+$/, '');
}

async function json(frontendUrl, path) {
  const response = await fetch(new URL(path, `${frontendUrl}/`), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
    redirect: 'error',
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new VerificationError('attestation response exceeds size limit');
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new VerificationError('attestation response exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new VerificationError('attestation response is not valid JSON');
  }
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new VerificationError(message);
}

async function main() {
  const frontendUrl = readArgument('--frontend', DEFAULT_FRONTEND_URL);
  const release = await json(frontendUrl, '/release.json');
  assert(release.response.status === 200, `release.json returned HTTP ${release.response.status}`);
  assert(release.body?.attestation_path === '/api/release-attestation', 'release manifest does not advertise the attestation endpoint');
  assert(release.body?.management_api_path === '/v1/management', 'release manifest does not advertise the management API');
  assert(release.body?.backend_url === CURRENT_WORKER, 'release manifest Worker mismatch');

  const attestation = await json(frontendUrl, release.body.attestation_path);
  assert(attestation.response.status === 200, `release attestation returned HTTP ${attestation.response.status}`);
  assert(attestation.body?.ok === true, 'release attestation is degraded');
  assert(attestation.body?.worker === CURRENT_WORKER, 'attestation Worker mismatch');
  assert(attestation.body?.execution?.primary === 'btcc', 'attestation does not identify BTCC as primary execution exchange');
  assert(attestation.body?.execution?.secondary === 'bitget', 'attestation does not identify Bitget as secondary execution exchange');
  assert(attestation.body?.safety?.trading_mode === 'paper', 'attestation trading mode is not paper');
  assert(attestation.body?.safety?.network === 'testnet', 'attestation network is not testnet');
  assert(attestation.body?.safety?.allow_mainnet === false, 'attestation allows mainnet');
  assert(attestation.body?.safety?.live_trading_enabled === false, 'attestation enables live trading');
  assert(attestation.body?.safety?.withdrawals_enabled === false, 'attestation enables withdrawals');
  assert(attestation.body?.safety?.provider_mutation_enabled === false, 'attestation enables provider mutation');
  assert(attestation.body?.safety?.real_funds_enabled === false, 'attestation enables real-fund activity');
  assert(attestation.body?.storage?.d1_status === 'healthy', 'D1 is not healthy in the release attestation');
  assert(attestation.body?.storage?.agent_memory_available === true, 'agent memory is not available in the release attestation');
  assert(attestation.body?.management?.route_present === true, 'management API route is not present in production attestation');
  assert(attestation.body?.management?.identity_provider_configured === true, 'production management identity provider is not configured');
  assert(attestation.body?.management?.authentication_enforced === true, 'production management bearer authentication is not enforced');
  assert(attestation.body?.management?.anonymous_status === 401, 'anonymous management probe did not return 401');
  assert(attestation.body?.management?.anonymous_code === 'UNAUTHENTICATED', 'anonymous management probe code mismatch');
  assert(Array.isArray(attestation.body?.failures) && attestation.body.failures.length === 0, 'release attestation contains invariant failures');

  console.log(`Production attestation verified: frontend → canonical Worker; execution BTCC→Bitget; management auth enforced; paper/testnet locks intact.`);
}

main().catch(error => {
  console.error(`Production attestation failed: ${error instanceof VerificationError ? error.message : 'verification failed (details redacted)'}`);
  process.exitCode = 1;
});
