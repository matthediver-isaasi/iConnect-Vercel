import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('complex registration projection does not request the standard-only Xero error column', () => {
  const source = readFileSync(new URL('./event-registration-report.js', import.meta.url), 'utf8');
  const fields = source.match(/from\('complex_event_booking'\)\s*\.select\('([^']+)'/)[1].split(',').map(s => s.trim());
  assert.equal(fields.includes('xero_invoice_error'), false);
  for (const field of ['invoice_recovery_status', 'invoice_recovery_next_attempt_at', 'accounting_invoice_id', 'xero_invoice_id']) {
    assert.ok(fields.includes(field), field);
  }
  const standard = source.match(/from\('booking'\)\s*\.select\('([^']+)'/)[1];
  assert.ok(standard.includes('xero_invoice_error'));
});
