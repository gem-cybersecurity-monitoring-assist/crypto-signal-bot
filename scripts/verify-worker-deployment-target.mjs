import { pathToFileURL } from 'node:url';

// Verified against the canonical Analyzer account. This is a public infrastructure
// identifier, not a credential. Never infer the deployment account from a Worker
// runtime variable: it must be selected explicitly by the deployment environment.
export const CANONICAL_WORKER_ACCOUNT_ID = 'd944e40760494a6843e521cd57c15dfd';

export function verifyWorkerDeploymentTarget(environment = process.env) {
  const selectedAccount = environment.CLOUDFLARE_ACCOUNT_ID;
  if (!selectedAccount) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID in the deployment/build environment; a Worker runtime variable does not select the deployment account.');
  }
  if (selectedAccount !== CANONICAL_WORKER_ACCOUNT_ID) {
    throw new Error('Deployment blocked: CLOUDFLARE_ACCOUNT_ID does not select the canonical analyzer-d94 Worker account.');
  }
  return selectedAccount;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyWorkerDeploymentTarget();
    console.log('Canonical Cloudflare deployment account verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
