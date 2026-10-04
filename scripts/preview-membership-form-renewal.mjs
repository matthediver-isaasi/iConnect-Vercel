import { readFile } from 'node:fs/promises';
import { previewFormMembershipRenewal } from '../api/_lib/formMembershipRenewalDryRun.js';

// Run inside run-isolated-tests.mjs. Only the named local JSON file is read;
// there is no tenant discovery, environment lookup or provider request here.
if (process.env.TEST_ISOLATION_ACTIVE !== '1') {
  throw new Error('Run through scripts/run-isolated-tests.mjs to enforce the no-network/no-provider boundary');
}
const [path, method, now] = process.argv.slice(2);
if (!path || !['upfront', 'direct_debit'].includes(method) || !now || !Number.isFinite(Date.parse(now))) {
  throw new Error('Usage: node scripts/run-isolated-tests.mjs node scripts/preview-membership-form-renewal.mjs <snapshot.json> <upfront|direct_debit> <UTC-date>');
}
const fixture = JSON.parse(await readFile(path, 'utf8'));
console.log(JSON.stringify(previewFormMembershipRenewal({ ...fixture, method, now }), null, 2));