import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = JSON.parse(readFileSync(new URL('./regression-suites.json', import.meta.url), 'utf8'));
// These suites include disposable PostgreSQL harnesses. This permission only
// enables temporary UNIX-socket clusters, never network database connections.
const disposablePostgresSuites = new Set([
  'ai-assistant-tests',
  'stripe-address-mappings',
  'monthly-membership-activation',
  'rolling-memberships',
  'department-current-set',
]);
const [suite, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(suites, suite) || extra.length) {
  console.error(`Usage: node scripts/run-regression-suite.mjs <${Object.keys(suites).join('|')}>`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./run-isolated-tests.mjs', import.meta.url)),
    ...(disposablePostgresSuites.has(suite) ? ['--allow-local-postgres'] : []),
    '--shell', suites[suite],
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}