import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) throw new Error('DEST_DATABASE_URL is required. No database was changed.');

const supabaseUrl = process.env.DEST_SUPABASE_URL
  || process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.DEST_SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY;
const client = new pg.Client({ connectionString });
const ids = {
  form: randomUUID(),
  submission: randomUUID(),
  organization: randomUUID(),
};
let began = false;

const safeError = error => ({
  name: error?.name || 'Error',
  code: error?.code || null,
  message: String(error?.message || 'Destination verification failed').replace(
    new RegExp('postgres(?:ql)?://\\\\S+', 'gi'),
    '[redacted database URL]',
  ),
  detail: error?.detail || null,
  where: error?.where || null,
});

try {
  await client.connect();
  await client.query('BEGIN');
  began = true;
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '30s'");

  const requiredFunctions = await client.query(`
    SELECT
      to_regprocedure('public.apply_form_stripe_address_mappings(uuid,uuid,uuid,uuid,jsonb,jsonb)') IS NOT NULL AS apply_exists,
      to_regprocedure('public.patch_form_submission_payment_meta(uuid,uuid,jsonb)') IS NOT NULL AS patch_exists,
      has_function_privilege('service_role', 'public.apply_form_stripe_address_mappings(uuid,uuid,uuid,uuid,jsonb,jsonb)', 'EXECUTE') AS service_can_apply,
      has_function_privilege('anon', 'public.apply_form_stripe_address_mappings(uuid,uuid,uuid,uuid,jsonb,jsonb)', 'EXECUTE') AS anon_can_apply,
      has_function_privilege('authenticated', 'public.apply_form_stripe_address_mappings(uuid,uuid,uuid,uuid,jsonb,jsonb)', 'EXECUTE') AS authenticated_can_apply
  `);
  assert.deepEqual(requiredFunctions.rows[0], {
    apply_exists: true,
    patch_exists: true,
    service_can_apply: true,
    anon_can_apply: false,
    authenticated_can_apply: false,
  });
  await client.query('SET LOCAL ROLE service_role');
  const serviceRoleVisibility = await client.query(`
    SELECT
      current_user = 'service_role' AS service_role_active,
      has_table_privilege(current_user, 'public.form_stripe_address_mapping_ledger', 'SELECT') AS ledger_visible,
      has_function_privilege(
        current_user,
        'public.apply_form_stripe_address_mappings(uuid,uuid,uuid,uuid,jsonb,jsonb)',
        'EXECUTE'
      ) AS rpc_visible
  `);
  assert.deepEqual(serviceRoleVisibility.rows[0], {
    service_role_active: true,
    ledger_visible: true,
    rpc_visible: true,
  });
  await client.query('SELECT form_submission_id FROM public.form_stripe_address_mapping_ledger LIMIT 0');
  await client.query('RESET ROLE');

  // A pre-existing tenant is referenced but never mutated.
  const tenantResult = await client.query('SELECT id FROM public.tenant ORDER BY id LIMIT 1');
  assert.equal(tenantResult.rowCount, 1, 'Destination has no tenant available for an isolated fixture');
  const tenantId = tenantResult.rows[0].id;

  await client.query(
    `INSERT INTO public.form (id, tenant_id, name, slug)
     VALUES ($1, $2, $3, $4)`,
    [ids.form, tenantId, 'Stripe address rollback verification', `stripe-address-verify-${ids.form}`],
  );
  await client.query(
    `INSERT INTO public.organization (id, tenant_id, name, invoicing_address)
     VALUES ($1, $2, $3, $4)`,
    [ids.organization, tenantId, 'Stripe address rollback verification', 'original fixture value'],
  );
  await client.query(
    `INSERT INTO public.form_submission
       (id, form_id, tenant_id, payment_provider, payment_status, payment_meta)
     VALUES ($1, $2, $3, 'stripe', 'paid', '{}'::jsonb)`,
    [ids.submission, ids.form, tenantId],
  );

  const mappings = [{
    source: 'formatted',
    target_entity: 'organization',
    target_type: 'core',
    target_field: 'invoicing_address',
  }];
  const snapshot = {
    line1: '10 High Street',
    line2: null,
    city: 'Leeds',
    state: null,
    postal_code: 'LS1 1AA',
    country: 'GB',
    formatted: '10 High Street\nLeeds\nLS1 1AA\nGB',
  };
  const normalizedAddress = {
    ...snapshot,
    country_code: 'GB',
    country: 'United Kingdom',
  };
  await client.query(
    'SELECT public.patch_form_submission_payment_meta($1, $2, $3)',
    [tenantId, ids.submission, {
      stripe_address_mapping_config: { version: 1, mappings },
      stripe_billing_address: snapshot,
    }],
  );
  await client.query(
    `INSERT INTO public.form_submission_entity_creation
       (form_submission_id, tenant_id, entity_type, entity_id)
     VALUES ($1, $2, 'organization', $3)`,
    [ids.submission, tenantId, ids.organization],
  );

  const applied = await client.query(
    'SELECT public.apply_form_stripe_address_mappings($1, $2, NULL, $3, $4, $5) AS result',
    [
      tenantId,
      ids.submission,
      ids.organization,
      JSON.stringify(mappings),
      JSON.stringify(normalizedAddress),
    ],
  );
  assert.equal(applied.rows[0].result?.ok, true);
  assert.equal(applied.rows[0].result?.applied, true);
  const mapped = await client.query(
    'SELECT invoicing_address FROM public.organization WHERE id = $1',
    [ids.organization],
  );
  assert.equal(mapped.rows[0].invoicing_address, snapshot.formatted);
  const ledger = await client.query(
    'SELECT count(*)::int AS count FROM public.form_stripe_address_mapping_ledger WHERE form_submission_id = $1',
    [ids.submission],
  );
  assert.equal(ledger.rows[0].count, 1);

  await client.query(
    'UPDATE public.organization SET invoicing_address = $2 WHERE id = $1',
    [ids.organization, 'later fixture edit'],
  );
  const replay = await client.query(
    "SELECT public.apply_form_stripe_address_mappings($1, $2, NULL, NULL, '[]'::jsonb, '{}'::jsonb) AS result",
    [tenantId, ids.submission],
  );
  assert.equal(replay.rows[0].result?.code, 'ALREADY_APPLIED');
  const preserved = await client.query(
    'SELECT invoicing_address FROM public.organization WHERE id = $1',
    [ids.organization],
  );
  assert.equal(preserved.rows[0].invoicing_address, 'later fixture edit');

  // The OpenAPI document is a read-only view of PostgREST's current schema
  // cache and proves the service role can see the newly installed RPC.
  const destination = new URL(connectionString);
  const configuredRestRef = supabaseUrl ? new URL(supabaseUrl).hostname.split('.')[0] : null;
  const destinationRef = decodeURIComponent(destination.username).split('.').pop();
  if (supabaseUrl && serviceKey && configuredRestRef === destinationRef) {
    const openApiResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    assert.equal(openApiResponse.ok, true, `PostgREST OpenAPI read failed (${openApiResponse.status})`);
    const openApi = await openApiResponse.json();
    assert.ok(
      openApi.paths?.['/rpc/apply_form_stripe_address_mappings'],
      'PostgREST schema cache does not expose the address mapping RPC',
    );
  } else {
    // The process may intentionally carry application REST credentials for a
    // different project than DEST_DATABASE_URL. Never send those credentials
    // cross-project; the service-role catalog/zero-row checks above remain the
    // safe destination visibility verification.
    console.log('Destination REST credentials unavailable; verified service-role catalog visibility instead.');
  }

  await client.query('ROLLBACK');
  began = false;
  const residue = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM public.form WHERE id = $1) OR
       EXISTS (SELECT 1 FROM public.form_submission WHERE id = $2) OR
       EXISTS (SELECT 1 FROM public.organization WHERE id = $3) AS exists`,
    [ids.form, ids.submission, ids.organization],
  );
  assert.equal(residue.rows[0].exists, false);
  console.log('Destination Stripe address verification passed; rollback left no fixture data.');
} catch (error) {
  if (began) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection failure still prevents commit; report only the original error.
    }
    began = false;
  }
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
} finally {
  if (began) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best effort on a broken connection; no COMMIT exists in this script.
    }
  }
  await client.end().catch(() => {});
}