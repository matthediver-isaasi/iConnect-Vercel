import test from 'node:test';
import assert from 'node:assert/strict';
import { main, readSnapshot, reportHtml } from './validate-bnms-final-members.mjs';

test('apply and all argument overrides are refused before connecting', async () => {
  for (const args of [['--apply'], ['--tenant', 'other'], ['--file', 'other']]) await assert.rejects(main(args), /no apply mode/);
});
test('read-only guard is checked before any data read and rollback occurs on failure', async () => {
  const queries = [];
  const client = { query: async sql => {
    queries.push(sql);
    return { rows: [{ transaction_read_only: 'off' }] };
  } };
  await assert.rejects(readSnapshot(client, {}), /Read-only guard/);
  assert.deepEqual(queries, ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SHOW transaction_read_only', 'ROLLBACK']);
});
test('failed live reads still roll back, no mutation SQL or provider calls', async () => {
  const queries = [];
  const client = { query: async sql => {
    queries.push(sql);
    if (sql.startsWith('select')) throw Error('Synthetic lookup failure');
    return { rows: [{ transaction_read_only: 'on' }] };
  } };
  await assert.rejects(readSnapshot(client, {}), /Synthetic lookup failure/);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(queries.every(sql => /^(BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SHOW transaction_read_only|select |ROLLBACK)/.test(sql)));
});
test('HTML escapes row data and summary excludes member identities', () => {
  const report = { mappings: [], counts: {}, schemaBlockers: [], decisionsRequired: [], rows: [{ sourceRow: 1, outcome: 'ready-new', email: '<script>private@example.invalid</script>' }] };
  assert.ok(!reportHtml(report).includes('private@example.invalid'));
  assert.ok(reportHtml(report, true).includes('&lt;script&gt;private@example.invalid'));
});