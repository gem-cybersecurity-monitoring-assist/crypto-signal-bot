import { privateToml } from '../worker/scripts/private-toml.mjs';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { certificationStoreConfig, inspectCertificationStore } from './verify-bitget-secret-store-resources.mjs';

/** Fail before a deployment if this inspection-only service gains public or financial bindings. */
export function privateCertificationConfig(text) {
  const config = privateToml(text, ['route', 'routes', 'triggers', 'env', 'd1_databases',
    'kv_namespaces', 'r2_buckets', 'durable_objects', 'services', 'queues', 'CERTIFICATION_RUNNER_TOKEN']);
  if (!config || config.name !== 'crypto-signal-bot-provider-certification'
    || config.main !== 'worker/src/index_provider_certification.ts'
    || config.workers_dev !== false || config.preview_urls !== false
    || ['ALLOW_MAINNET', 'LIVE_EXECUTION_ENABLED', 'WITHDRAWALS_ENABLED'].some(k => config.vars?.[k] !== 'false')
    || Object.hasOwn(config.vars, 'CERTIFICATION_RUNNER_TOKEN')
    || /BITGET_TRADE_|BITGET_WITHDRAW/.test(JSON.stringify(config))) {
    throw new Error('PRIVATE_CERTIFICATION_CONFIG_INVALID');
  }
  return certificationStoreConfig(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = privateCertificationConfig(await fs.readFile(new URL('../wrangler.provider-certification.toml',import.meta.url),'utf8'));
    const metadata = await inspectCertificationStore(config);
    console.log(JSON.stringify({ ...metadata, privateCertificationArtifactVerified: true,
      invocationTokenVerified: false, accountModelVerified: false, providerCertificationVerified: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
