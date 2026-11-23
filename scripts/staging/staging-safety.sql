-- Applied to iconnect-staging after every refresh. Never run on production.
--
-- A fresh copy of production carries live integration credentials. These
-- controls stop previews acting on real customers or real accounts. Original
-- values are kept in staging_safety.* so authorised operators can restore
-- specific integrations (scripts/staging/staging-restore-integrations.sql).
--
-- OAuth tokens are deleted, not disabled: Xero, Zoho, QuickBooks and
-- Microsoft rotate refresh tokens, so a preview refreshing a copied token
-- would silently disconnect production. Reconnect staging to sandbox/demo
-- accounts through the app instead.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if exists (select 1 from pg_control_system() where system_identifier = 7581440907192989109) then
    raise exception 'refusing: this is the production database';
  end if;
end $$;

create schema if not exists staging_safety;
revoke all on schema staging_safety from public, anon, authenticated, service_role;

drop table if exists staging_safety.tenant_integrations_original,
  staging_safety.system_settings_original, staging_safety.floater_original,
  staging_safety.applied;

create table staging_safety.tenant_integrations_original as
  select id, integration_type, is_enabled, credentials from public.tenant_integrations;
create table staging_safety.system_settings_original as
  select id, setting_key, setting_value from public.system_settings
  where setting_key in ('wp_webhook_url', 'wp_webhook_api_key', 'xero_invoice_enabled');
create table staging_safety.floater_original as
  select id, webhook_url from public.floater where coalesce(webhook_url, '') <> '';
create table staging_safety.applied (applied_at timestamptz not null default now(), summary jsonb not null);

-- Rotating OAuth tokens shared with production.
delete from public.xero_token;
delete from public.quickbooks_token;
delete from public.outlook_connection;
update public.tenant_integrations
   set credentials = credentials - 'access_token' - 'refresh_token' - 'expires_at' - 'expires_in'
 where integration_type = 'zoho_campaigns';

-- Stripe: switch every feature to test mode where test keys exist; otherwise disable.
update public.tenant_integrations t
   set credentials = t.credentials || (
         select coalesce(jsonb_object_agg(k, 'test'), '{}'::jsonb)
         from jsonb_object_keys(t.credentials) k where k like 'stripe\_mode\_%')
 where integration_type = 'stripe' and credentials ? 'test_secret_key' and credentials ? 'test_publishable_key';
update public.tenant_integrations
   set is_enabled = false
 where integration_type = 'stripe' and not (credentials ? 'test_secret_key' and credentials ? 'test_publishable_key');

-- Payments, accounting, CRM/email marketing, meetings: off until an operator restores them.
update public.tenant_integrations
   set is_enabled = false
 where integration_type in ('gocardless', 'xero', 'quickbooks', 'zoho_campaigns', 'zoom');

-- Outbound webhooks to real systems.
update public.system_settings set setting_value = null where setting_key in ('wp_webhook_url', 'wp_webhook_api_key');
update public.system_settings set setting_value = 'false' where setting_key = 'xero_invoice_enabled';
update public.floater set webhook_url = null where coalesce(webhook_url, '') <> '';

insert into staging_safety.applied (summary)
select jsonb_build_object(
  'xero_tokens', (select count(*) from public.xero_token),
  'quickbooks_tokens', (select count(*) from public.quickbooks_token),
  'outlook_connections', (select count(*) from public.outlook_connection),
  'enabled_integrations', (select jsonb_object_agg(integration_type, n) from (
      select integration_type, count(*) n from public.tenant_integrations where is_enabled group by 1) x),
  'stripe_live_modes', (select count(*) from public.tenant_integrations t, jsonb_each_text(t.credentials) e
      where t.integration_type = 'stripe' and t.is_enabled and e.key like 'stripe\_mode\_%' and e.value <> 'test'),
  'webhooks_set', (select count(*) from public.floater where coalesce(webhook_url, '') <> '')
    + (select count(*) from public.system_settings where setting_key = 'wp_webhook_url' and coalesce(setting_value, '') <> ''));

commit;
select summary from staging_safety.applied order by applied_at desc limit 1;
