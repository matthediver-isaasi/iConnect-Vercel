import test from 'node:test';
import assert from 'node:assert/strict';
import { runRenewalEnvelope } from './directDebitRenewalEnvelope.js';
import { readonlyTenantDatabase } from './directDebitDryRunRuntime.js';

test('renewal envelope reports UTC threshold and protected pending/done/cursor uncertainty without RPC', async () => {
  for (const [setting, hour, reached] of [['14:30', 14, false], ['6:59', 6, true], ['invalid', 6, true], [null, 6, true]]) {
    const reads = [];
    const database = {
      from(table) {
        assert.notEqual(table, 'membership_renewal_cron_state', 'State has no tenant column and is deliberately not granted for reads');
        reads.push(table);
        const result = { data: table === 'system_settings' ? (setting ? { setting_value: setting } : null) : [] };
        return {
          select() { return this; }, eq() { return this; }, is() { return this; },
          order() { return this; }, limit() { return this; }, maybeSingle() { return this; },
          then(resolve) { resolve(result); },
          update() { assert.fail('No state updates'); },
        };
      },
      rpc() { assert.fail('No discovery or lease RPC'); },
    };
    const stages = [];
    await runRenewalEnvelope({
      db: readonlyTenantDatabase(database, 'tenant'), plan: { tenant_id: 'tenant' },
      now: new Date('2026-01-01T13:00:00Z'), trace: stage => stages.push(stage),
    });
    assert.equal(stages[0].status, 'unknown');
    assert.match(stages[0].reason, new RegExp(`${String(hour).padStart(2, '0')}:00 UTC`));
    assert.match(stages[0].reason, reached ? /has reached/ : /has not reached/);
    assert.match(stages[0].reason, /already-done opportunity for today does not rerun/);
    assert.match(stages[0].reason, /pending opportunity can resume even before/);
    assert.match(stages[0].reason, /previously discovered tenants/);
    assert.match(stages[0].reason, /annual expiry is a separate/);
    assert.deepEqual(stages[0].operations, []);
    assert.equal(reads.length, 4);
  }
});