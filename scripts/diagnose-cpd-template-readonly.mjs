#!/usr/bin/env node
// Bounded, read-only DEST diagnostic. Never prints addresses, secrets or body.
import pg from 'pg';

const PROJECT = 'lvmzliemqnieeoruhkik';
const EVENT = '66050b3c-aa70-4174-8552-0a2af85e5410';
const url = process.env.DEST_DATABASE_URL;
if (!url || new URL(process.env.DEST_SUPABASE_URL || 'https://invalid.example').hostname !== `${PROJECT}.supabase.co`) {
  throw new Error('Pinned destination credentials unavailable');
}
const parsed = new URL(url);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${PROJECT}.supabase.co`].includes(parsed.hostname)
  || (parsed.port && parsed.port !== '5432')
  || (parsed.hostname.endsWith('.pooler.supabase.com')
    && !decodeURIComponent(parsed.username).endsWith(`.${PROJECT}`))) {
  throw new Error('Pinned destination SQL identity mismatch');
}
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Provider CA unavailable');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
const db = new pg.Client({
  connectionString: parsed.toString(), ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname },
});
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  const event = await db.query(`SELECT e.id, e.title,
    c.config->'eventRule' ? 'email_template_id' AS selected_key_present,
    c.config->'eventRule'->>'email_template_id' AS selected_id,
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c.config) k) AS config_keys,
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c.config->'eventRule') k) AS event_rule_keys,
    (SELECT jsonb_object_keys(c.config->'eventRule') LIMIT 1) IS NOT NULL AS has_event_rule
    FROM public.event e LEFT JOIN public.event_cpd_certificate_config c
      ON c.event_id=e.id AND c.tenant_id=e.tenant_id AND c.event_type='event'
    WHERE e.id=$1`, [EVENT]);
  const candidate = await db.query(`SELECT t.id,t.name,t.is_active,t.category,
    length(trim(coalesce(t.subject,''))) > 0 AS has_subject,
    length(trim(coalesce(t.body,''))) > 0 AS has_body
    FROM public.email_template t JOIN public.event e ON e.tenant_id=t.tenant_id
    WHERE e.id=$1 AND t.name ILIKE $2 ORDER BY t.id LIMIT 10`,
  [EVENT, '%Autumn%']);
  const bookingColumns = await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='complex_event_booking'
      AND column_name IN ('event_id','complex_event_id') ORDER BY column_name`);
  const emailValidationTrigger = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.event_cpd_certificate_config'::regclass
      AND tgname='validate_event_cpd_email_template_config' AND NOT tgisinternal
  ) AS installed`);
  console.log(JSON.stringify({ event: event.rows[0] || null, candidate_templates: candidate.rows,
    complex_booking_event_columns: bookingColumns.rows.map(row => row.column_name),
    email_validation_trigger_installed: emailValidationTrigger.rows[0].installed,
    writes_performed: false }));
  await db.query('ROLLBACK');
} finally {
  await db.end();
}