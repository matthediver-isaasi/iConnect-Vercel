import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL || process.env.DEV_DATABASE_URL;

async function withRollback(t, fn) {
  if (!databaseUrl) {
    t.skip('No development/target PostgreSQL URL is available');
    return;
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

test('PostgreSQL distinguishes an absent JSONB lease key from JSON null', async (t) => {
  await withRollback(t, async (client) => {
    const { rows: [row] } = await client.query(`
      SELECT
        ('{"monthly_card_state":null}'::jsonb->'monthly_card_state') IS NULL AS json_null_is_absent,
        ('{}'::jsonb->'monthly_card_state') IS NULL AS missing_key_is_absent
    `);
    assert.equal(row.json_null_is_absent, false);
    assert.equal(row.missing_key_is_absent, true);
  });
});

test('expired form Checkout RPC releases the returning-member reservation and original applicant key', async (t) => {
  await withRollback(t, async (client) => {
    const fixture = await client.query(`
      SELECT m.id AS member_id, m.tenant_id, f.id AS form_id
        FROM member m
        JOIN form f ON f.tenant_id = m.tenant_id
       WHERE m.tenant_id IS NOT NULL
       LIMIT 1
    `);
    if (!fixture.rows[0]) {
      t.skip('No member/form fixture exists in the target database');
      return;
    }

    const { member_id: memberId, tenant_id: tenantId, form_id: formId } = fixture.rows[0];
    const submissionId = randomUUID();
    const agreementId = randomUUID();
    const checkoutSessionId = `cs_expired_${randomUUID()}`;
    const applicantKey = `form-card-applicant:${randomUUID()}`;

    await client.query(`
      INSERT INTO form_submission (
        id, form_id, tenant_id, payment_status, payment_provider, payment_meta
      ) VALUES (
        $1, $2, $3, 'pending', 'stripe_monthly_card',
        jsonb_build_object(
          'monthly_card',
          jsonb_build_object(
            'agreement_id', $4::text,
            'checkout_session_id', $5::text,
            'checkout_url', 'https://checkout.stripe.test/session'
          )
        )
      )
    `, [submissionId, formId, tenantId, agreementId, checkoutSessionId]);

    await client.query(`
      INSERT INTO membership_billing_agreements (
        id, tenant_id, member_id, agreement_type, provider, status,
        idempotency_key, environment, stripe_checkout_session_id,
        redirect_url, metadata
      ) VALUES (
        $1, $2, $3, 'member', 'stripe', 'payment_setup_required',
        $4, 'sandbox', $5, 'https://checkout.stripe.test/session',
        jsonb_build_object('form_submission_id', $6::text)
      )
    `, [agreementId, tenantId, memberId, applicantKey, checkoutSessionId, submissionId]);

    const released = await client.query(
      `SELECT release_expired_form_monthly_card_checkout($1::uuid, $2::text) AS result`,
      [agreementId, checkoutSessionId],
    );
    assert.equal(released.rows[0].result.ok, true);
    assert.equal(released.rows[0].result.released, true);

    const agreement = await client.query(`
      SELECT status, member_id, idempotency_key, stripe_checkout_session_id, redirect_url
        FROM membership_billing_agreements
       WHERE id = $1
    `, [agreementId]);
    assert.equal(agreement.rows[0].status, 'expired');
    assert.equal(agreement.rows[0].member_id, null);
    assert.notEqual(agreement.rows[0].idempotency_key, applicantKey);
    assert.equal(agreement.rows[0].stripe_checkout_session_id, null);
    assert.equal(agreement.rows[0].redirect_url, null);

    const submission = await client.query(`
      SELECT
        payment_meta->'monthly_card'->>'checkout_session_id' AS checkout_session_id,
        payment_meta->'monthly_card'->>'checkout_url' AS checkout_url
        FROM form_submission
       WHERE id = $1
    `, [submissionId]);
    assert.equal(submission.rows[0].checkout_session_id, null);
    assert.equal(submission.rows[0].checkout_url, null);

    // The same applicant/year idempotency key can now back a fresh agreement.
    await client.query(`
      INSERT INTO membership_billing_agreements (
        tenant_id, member_id, agreement_type, provider, status,
        idempotency_key, environment, metadata
      ) VALUES (
        $1, $2, 'member', 'stripe', 'payment_setup_required',
        $3, 'sandbox', '{}'::jsonb
      )
    `, [tenantId, memberId, applicantKey]);

    const retry = await client.query(
      `SELECT release_expired_form_monthly_card_checkout($1::uuid, $2::text) AS result`,
      [agreementId, checkoutSessionId],
    );
    assert.equal(retry.rows[0].result.ok, true);
    assert.equal(retry.rows[0].result.idempotent, true);
  });
});