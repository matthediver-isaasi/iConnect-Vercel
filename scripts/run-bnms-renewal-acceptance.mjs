import { spawnSync } from 'node:child_process';

// Deliberately do not inherit workspace credentials, NODE_OPTIONS or dotenv.
const result = spawnSync(process.execPath, [
  'node_modules/@playwright/test/cli.js', 'test',
  '--config', 'tests/bnms-renewal-acceptance.config.mjs', ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'test', BNMS_DISPOSABLE_ACCEPTANCE: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
