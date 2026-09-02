import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decryptCredentials,
  findOrCreateStripeCustomer,
  prepareRequiredStripeCustomer,
  selectStripeCredentials,
} from './stripeCredentials.js';
import {
  mergeCredentialUpdates,
  maskCredentials,
} from '../admin/integrations.js';

const stored = {
  secret_key: 'sk_live_realistic',
  publishable_key: 'pk_live_realistic',
  test_secret_key: 'sk_test_realistic',
  test_publishable_key: 'pk_test_realistic',
  stripe_mode_forms: 'live',
  stripe_mode_membership: 'test',
};

test('membership Test and Forms Live select independent complete key pairs', () => {
  assert.deepEqual(selectStripeCredentials(stored, 'membership'), {
    secret_key: 'sk_test_realistic',
    publishable_key: 'pk_test_realistic',
    mode: 'test',
    configuration_error: null,
  });
  assert.deepEqual(selectStripeCredentials(stored, 'forms'), {
    secret_key: 'sk_live_realistic',
    publishable_key: 'pk_live_realistic',
    mode: 'live',
    configuration_error: null,
  });
});

test('explicit Test mode never substitutes either live credential', () => {
  for (const incomplete of [
    { ...stored, test_secret_key: null },
    { ...stored, test_publishable_key: null },
    { ...stored, test_secret_key: null, test_publishable_key: null },
  ]) {
    const selected = selectStripeCredentials(incomplete, 'membership');
    assert.equal(selected.mode, 'test');
    assert.equal(selected.secret_key, null);
    assert.equal(selected.publishable_key, null);
    assert.match(selected.configuration_error, /set to Test/);
  }
});

test('an unreadable encrypted test credential fails closed instead of selecting live', () => {
  const decrypted = decryptCredentials({
    ...stored,
    test_secret_key: 'not-valid-encrypted:ciphertext',
  });
  const selected = selectStripeCredentials(decrypted, 'membership');
  assert.equal(selected.mode, 'test');
  assert.equal(selected.secret_key, null);
  assert.equal(selected.publishable_key, null);
  assert.match(selected.configuration_error, /could not be read/);
});

test('masked credential updates preserve secrets and exact persisted modes', () => {
  const masked = maskCredentials(stored);
  const merged = mergeCredentialUpdates(stored, {
    ...masked,
    stripe_mode_membership: 'test',
    stripe_mode_forms: 'live',
  });
  assert.deepEqual(merged, stored);
  assert.equal(masked.stripe_mode_membership, 'test');
  assert.equal(masked.stripe_mode_forms, 'live');
});

test('required membership customer reuses an email match and preserves ownership metadata', async () => {
  const updates = [];
  const stripe = {
    customers: {
      list: async (params) => {
        assert.equal(params.email, 'member@example.com');
        return { data: [{ id: 'cus_existing', metadata: { retained: 'yes' } }] };
      },
      update: async (...args) => {
        updates.push(args);
        return { id: args[0], ...args[1] };
      },
      create: async () => { throw new Error('must not create'); },
    },
  };
  const result = await prepareRequiredStripeCustomer(stripe, {
    email: ' Member@Example.com ',
    metadata: { tenant_id: 'tenant-1', member_id: 'member-1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.customer.id, 'cus_existing');
  assert.equal(result.email, 'member@example.com');
  assert.deepEqual(updates[0][1].metadata, {
    retained: 'yes',
    tenant_id: 'tenant-1',
    member_id: 'member-1',
  });
});

test('required membership customer can be created without a submitter email', async () => {
  const creates = [];
  const stripe = {
    customers: {
      list: async () => { throw new Error('must not list without email'); },
      update: async () => { throw new Error('must not update'); },
      create: async (...args) => {
        creates.push(args);
        return { id: 'cus_no_email' };
      },
    },
  };
  const result = await prepareRequiredStripeCustomer(stripe, {
    email: null,
    idempotencyKey: 'form-membership-customer:t1:s1',
    metadata: { tenant_id: 't1', form_submission_id: 's1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.email, null);
  assert.equal(result.emailOmitted, true);
  assert.equal(creates[0][0].email, undefined);
  assert.deepEqual(creates[0][0].metadata, {
    tenant_id: 't1',
    form_submission_id: 's1',
  });
  assert.deepEqual(creates[0][1], {
    idempotencyKey: 'form-membership-customer:t1:s1',
  });
});

test('required membership customer treats malformed email as absent', async () => {
  const stripe = {
    customers: {
      create: async (params) => {
        assert.equal(params.email, undefined);
        return { id: 'cus_bad_email' };
      },
    },
  };
  const result = await prepareRequiredStripeCustomer(stripe, {
    email: 'not-an-email',
    metadata: { tenant_id: 't1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.emailOmitted, true);
});

test('required membership customer returns a stable provider error while legacy optional lookup stays null', async () => {
  const stripe = {
    customers: {
      list: async () => {
        const error = new Error('restricted key cannot read customers');
        error.code = 'permission_error';
        error.type = 'StripePermissionError';
        error.statusCode = 403;
        throw error;
      },
    },
  };
  const required = await prepareRequiredStripeCustomer(stripe, {
    email: 'member@example.com',
    metadata: { tenant_id: 't1' },
  });
  assert.deepEqual(required, {
    ok: false,
    code: 'STRIPE_CUSTOMER_PROVIDER_ERROR',
    status: 502,
  });
  assert.equal(await findOrCreateStripeCustomer(stripe, {
    email: 'member@example.com',
  }), null);
});

test('both annual form-membership routes require the prepared Customer on PaymentIntent creation', async () => {
  const [embeddedFieldRoute, publicFormRoute] = await Promise.all([
    readFile(new URL('../forms/membership-payment.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/form-payment.js', import.meta.url), 'utf8'),
  ]);

  for (const source of [embeddedFieldRoute, publicFormRoute]) {
    assert.match(source, /prepareRequiredStripeCustomer/);
    assert.match(source, /code:\s*customerResult\.code/);
  }
  assert.match(embeddedFieldRoute, /customer:\s*stripeCustomer\.id/);
  assert.match(publicFormRoute, /customer:\s*stripeCustomer\?\.id\s*\|\|\s*undefined/);
  assert.match(publicFormRoute, /if\s*\(membershipMeta\)[\s\S]*stripeCustomer\s*=\s*customerResult\.customer/);
});