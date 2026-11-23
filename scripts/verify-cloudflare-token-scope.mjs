import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyWorkerDeploymentTarget } from './verify-worker-deployment-target.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDirectory = resolve(root, 'worker')
const cli = resolve(workerDirectory, 'node_modules/.bin/wrangler')

/**
 * Wrangler's whoami --json reports only accounts visible to the authenticated
 * token. Never log the raw whoami output, token, email, account names, or scope.
 */
export function verifyAuthenticatedCloudflareAccount(whoami, environment = process.env) {
  const requiredId = verifyWorkerDeploymentTarget(environment)
  if (!whoami || typeof whoami !== 'object' || whoami.loggedIn !== true) {
    throw new Error('Cloudflare deployment blocked: API token authentication did not succeed.')
  }
  if (!Array.isArray(whoami.accounts)) {
    throw new Error('Cloudflare deployment blocked: authenticated account scope is unavailable.')
  }
  // Fail closed if Wrangler changes the expected account schema.
  const visibleIds = whoami.accounts.map((account) => {
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
        typeof account.id !== 'string' || !/^[a-fA-F0-9]{32}$/.test(account.id)) {
      throw new Error('Cloudflare deployment blocked: malformed authenticated account evidence.')
    }
    return account.id
  })
  if (new Set(visibleIds).size !== visibleIds.length) {
    throw new Error('Cloudflare deployment blocked: duplicate authenticated account evidence.')
  }
  if (!visibleIds.includes(requiredId)) {
    throw new Error('Cloudflare deployment blocked: API token cannot access the canonical Worker account.')
  }
  return { verified: true, accountId: requiredId }
}

export function checkAuthenticatedCloudflareAccount(
  environment = process.env,
  runWhoami = () => {
    if (!existsSync(cli)) {
      throw new Error('Worker dependencies are not installed. Run npm ci in worker/.')
    }
    return spawnSync(cli, ['whoami', '--json', '--config', '../wrangler.toml'], {
      cwd: workerDirectory,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    })
  },
) {
  // Check configured account and token presence before invoking Wrangler.
  verifyWorkerDeploymentTarget(environment)
  if (!environment.CLOUDFLARE_API_TOKEN) {
    throw new Error('Cloudflare deployment blocked: required API token is missing.')
  }

  const result = runWhoami()
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    // In particular, NEVER print stderr from a credential-bearing subprocess.
    throw new Error('Cloudflare deployment blocked: could not verify token account scope.')
  }
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new Error('Cloudflare deployment blocked: Wrangler did not provide valid JSON account evidence.')
  }
  return verifyAuthenticatedCloudflareAccount(json, environment)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkAuthenticatedCloudflareAccount()
    console.log('Cloudflare token scope verified for the canonical Worker account.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloudflare account preflight failed.')
    process.exitCode = 1
  }
}
