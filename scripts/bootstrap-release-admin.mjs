#!/usr/bin/env node
// Owner-run, one-time RELEASE_ADMIN bootstrap for the production Worker.
//
// Run on a trusted machine from the repository root:
//   node scripts/bootstrap-release-admin.mjs           # claim bootstrap
//   node scripts/bootstrap-release-admin.mjs --check   # show this account's current roles only
//
// It signs in to the configured Supabase project with email + password, completes the
// TOTP step-up so the session is AAL2, then calls POST /v1/management/bootstrap with
// that session and the Worker's BACKEND_API_KEY. The key and password are read from a
// hidden prompt, sent only to their own services, and never printed or written to disk.
// The account must already have an authenticator enrolled (Account page → Enroll).
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_WORKER = 'https://crypto-signal-bot-api.analyzer-d94.workers.dev';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const workerArg = args.find((arg) => arg.startsWith('--worker='));
const worker = (workerArg ? workerArg.slice('--worker='.length) : DEFAULT_WORKER).replace(/\/+$/, '');

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

async function publicSupabaseConfig() {
  const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const value = (name) => toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
  const url = value('SUPABASE_URL');
  const key = value('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) fail('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not found in wrangler.toml.');
  return { url, key };
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) rl.output.write(chunk);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function workerJson(path, init) {
  const response = await fetch(`${worker}${path}`, { ...init, redirect: 'error' });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function summarizeRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '  (none)';
  return roles.map((role) => `  - ${role.role} ${role.scope_type}:${role.scope_key}`).join('\n');
}

const { url, key } = await publicSupabaseConfig();
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

console.log(`Worker: ${worker}`);
console.log(checkOnly ? 'Mode: check roles only (no changes).' : 'Mode: one-time RELEASE_ADMIN bootstrap.');

const email = await ask('Admin account email: ');
const password = await ask('Password (hidden): ', { hidden: true });
const signIn = await supabase.auth.signInWithPassword({ email, password });
if (signIn.error) fail(`Sign-in failed: ${signIn.error.message}`);

const factors = await supabase.auth.mfa.listFactors();
const totp = factors.data?.totp?.find((factor) => factor.status === 'verified');
if (!totp) {
  const unverified = (factors.data?.all ?? []).filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified').length;
  await supabase.auth.signOut({ scope: 'local' });
  fail(unverified
    ? `This account has ${unverified} authenticator setup(s) that were never verified. On the Account page click "Enroll authenticator", scan the new QR code, enter the code and click Verify, then run this again.`
    : 'This account has no authenticator. Enroll one on the Account page, then run this again.');
}
const code = await ask('6-digit authenticator code: ');
const verify = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
if (verify.error) fail(`Authenticator step-up failed: ${verify.error.message}`);

const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
if (assurance.data?.currentLevel !== 'aal2') fail('Session did not reach AAL2.');
const { data: sessionData } = await supabase.auth.getSession();
const accessToken = sessionData.session?.access_token;
if (!accessToken) fail('No session token after step-up.');

try {
  if (checkOnly) {
    const me = await workerJson('/v1/management/me', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    if (me.status !== 200) fail(`Role check failed (${me.status} ${me.body?.code ?? ''}).`);
    console.log(`\nActor: ${me.body?.profile?.actor_id ?? 'unknown'} (${me.body?.profile?.status ?? 'unknown'})`);
    console.log(`Current roles:\n${summarizeRoles(me.body?.roles)}`);
  } else {
    const operatorKey = await ask('Worker BACKEND_API_KEY (hidden): ', { hidden: true });
    if (!operatorKey) fail('BACKEND_API_KEY is required for bootstrap.');
    const result = await workerJson('/v1/management/bootstrap', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-API-Key': operatorKey,
      },
      body: '{}',
    });
    if (result.status === 200 && result.body?.ok) {
      console.log(`\n✔ RELEASE_ADMIN bootstrap claimed for actor ${result.body.profile?.actor_id ?? 'unknown'}.`);
      console.log(`Current roles:\n${summarizeRoles(result.body.roles)}`);
      console.log('\nNext: sign in to /admin with this account (authenticator step-up active) and grant');
      console.log('TRADER, scope GLOBAL, key "global" to the separate account you will trade with.');
    } else if (result.body?.code === 'BOOTSTRAP_CLOSED') {
      fail('Bootstrap is already claimed. Use an existing RELEASE_ADMIN to manage access.');
    } else if (result.status === 401) {
      fail('The Worker rejected the operator key. Re-set it with: npx wrangler secret put BACKEND_API_KEY');
    } else {
      fail(`Bootstrap failed (${result.status} ${result.body?.code ?? ''}): ${result.body?.error ?? 'no detail'}`);
    }
  }
} finally {
  await supabase.auth.signOut({ scope: 'local' });
}
