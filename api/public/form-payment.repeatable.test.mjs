import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validatePaymentRelationships } from './form-payment.js';

test('paid create, monthly-card, and quote paths validate repeatable rows before charge resolution', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ validateRepeatableRowSubmission \} from '\.\.\/_lib\/formRepeatableRowValidation\.js';/);
  const quoteStart = source.indexOf('async function handleQuote');
  const monthlyStart = source.indexOf('async function handleCreateMonthlyCard');
  const createStart = source.indexOf('async function handleCreate(');
  for (const start of [quoteStart, monthlyStart, createStart]) {
    const section = source.slice(start, start + 5000);
    const validation = section.indexOf('validatePaymentRelationships(');
    const charge = section.indexOf('resolvePayableCharge(');
    assert.ok(validation >= 0, 'payment path validates selections');
    assert.ok(charge < 0 || validation < charge, 'validation occurs before payable charge resolution');
  }
});

test('paid validation rejects repeatable tampering before ordinary relationship database lookups', async () => {
  let queries = 0;
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [{
      id: 'workplaces', type: 'repeatable_rows',
      child_fields: [{ id: 'organisation', type: 'organisation_dropdown', required: true }],
    }],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { queries += 1; throw new Error('must not query for tampered rows'); } },
    { id: 'tenant-1' },
    form,
    { workplaces: [{ organisation: 'org-1', forged: 'yes' }] },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, 'unknown_child');
  assert.equal(queries, 0);
});