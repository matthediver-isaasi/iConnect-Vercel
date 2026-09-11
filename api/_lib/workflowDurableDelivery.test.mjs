import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContractFailureResult,
  durableDeliveryOutcomeError,
  executeCreateContractAction,
  membershipInvoiceDeliveryActionState,
  workflowEmailActionResult,
} from './workflows.js';
import { supabase } from './database.js';

test('durable workflow delivery retries a batch with only confirmed failed actions', () => {
  const outcome = durableDeliveryOutcomeError([
    { action_type: 'send_email', status: 'failed', error: 'provider rejected message' },
    { action_type: 'update_field', status: 'failed', error: 'validation rejected' },
  ]);
  assert.equal(outcome.hadSuccessfulEffect, false);
  assert.equal(outcome.error.ddKnownQueryFailure, true);
  assert.equal(outcome.error.ddAmbiguousEffect, undefined);
});

test('durable workflow delivery escalates mixed/partial action results instead of replaying successes', () => {
  for (const results of [
    [
      { action_type: 'send_email', status: 'success' },
      { action_type: 'update_field', status: 'failed' },
    ],
    [{ action_type: 'send_email_role', status: 'partial' }],
  ]) {
    const outcome = durableDeliveryOutcomeError(results);
    assert.equal(outcome.hadSuccessfulEffect, true);
    assert.equal(outcome.error.ddAmbiguousEffect, true);
  }
});

test('a later failed workflow is ambiguous when an earlier workflow already succeeded', () => {
  const outcome = durableDeliveryOutcomeError(
    [{ action_type: 'send_email', status: 'failed' }],
    true,
  );
  assert.equal(outcome.hadSuccessfulEffect, true);
  assert.equal(outcome.error.ddAmbiguousEffect, true);
});

test('an explicitly ambiguous external email result overrides failed status retry handling', () => {
  const outcome = durableDeliveryOutcomeError([
    workflowEmailActionResult({ success: false, ambiguousEffect: true }),
  ]);
  assert.equal(outcome.hadSuccessfulEffect, true);
  assert.equal(outcome.error.ddAmbiguousEffect, true);
  assert.equal(outcome.error.ddKnownQueryFailure, undefined);
});

test('membership invoice email ambiguity makes the create-membership action failed', () => {
  assert.deepEqual(
    membershipInvoiceDeliveryActionState(
      { invoice_id: 'invoice-1' },
      { success: false, ambiguousEffect: true, error: 'provider response lost' },
    ),
    {
      status: 'failed',
      ambiguousEffect: true,
      error: 'provider response lost',
    },
  );
});

test('a later multi-signer contract failure retains an earlier ambiguous signing-email result', () => {
  const result = createContractFailureResult(new Error('second signer processing failed'), true);
  assert.equal(result.status, 'failed');
  assert.equal(result.ambiguousEffect, true);
});

test('actual multi-signer contract path retains a first ambiguous email when the second send throws', async () => {
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      insert() { return chain; },
      single: async () => {
        if (table === 'form') {
          return {
            data: {
              id: 'contract-form',
              slug: 'contract',
              name: 'Contract',
              contract_settings: { initial_email_template_id: 'template' },
            },
            error: null,
          };
        }
        if (table === 'contract_instance') return { data: { id: 'instance' }, error: null };
        if (table === 'email_template') {
          return { data: { subject: 'Sign', body: 'Please sign', from_email: null, reply_to: null }, error: null };
        }
        return { data: { name: table }, error: null };
      },
    };
    return chain;
  };
  let sends = 0;
  try {
    const result = await executeCreateContractAction(
      {
        config: {
          contract_form_id: 'contract-form',
          organization_mapping: '_trigger',
          signer_mappings: [
            { first_name_field: '_static', first_name_static: 'One', email_field: '_static', email_static: 'one@test' },
            { first_name_field: '_static', first_name_static: 'Two', email_field: '_static', email_static: 'two@test' },
          ],
        },
      },
      { id: 'workflow', tenant_id: 'tenant' },
      'organization',
      'organization',
      {},
      'https://tenant.test',
      {
        sendEmail: async () => {
          sends += 1;
          if (sends === 1) return { success: false, ambiguousEffect: true };
          throw new Error('second signer processing failed');
        },
      },
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.ambiguousEffect, true);
    assert.equal(sends, 2);
  } finally {
    supabase.from = originalFrom;
  }
});