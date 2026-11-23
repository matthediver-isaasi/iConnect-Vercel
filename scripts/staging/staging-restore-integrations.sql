-- Restore integration settings that staging-safety.sql switched off, for
-- authorised development-site testing on iconnect-staging. Never production.
--
-- Usage (one integration type at a time, deliberately):
--   psql "$STAGING_DATABASE_URL" -v integration=zoom -f scripts/staging/staging-restore-integrations.sql
--   psql "$STAGING_DATABASE_URL" -v integration=webhooks -f scripts/staging/staging-restore-integrations.sql
--
-- Prefer sandbox/test credentials: reconnect Xero/QuickBooks/Zoho/Outlook to
-- demo accounts through the app (copied production OAuth tokens are deleted
-- and cannot be restored here on purpose). Restoring a type re-enables the
-- copied production credentials for that type, so previews would act on the
-- real provider account.
\set ON_ERROR_STOP on
begin;
do $$ begin
  if exists (select 1 from pg_control_system() where system_identifier = 7581440907192989109) then
    raise exception 'refusing: this is the production database';
  end if;
end $$;

select set_config('staging.integration', :'integration', true);

update public.tenant_integrations t
   set is_enabled = o.is_enabled, credentials = o.credentials, updated_at = now()
  from staging_safety.tenant_integrations_original o
 where o.id = t.id and o.integration_type = current_setting('staging.integration');

update public.system_settings s set setting_value = o.setting_value
  from staging_safety.system_settings_original o
 where o.id = s.id and current_setting('staging.integration') = 'webhooks';
update public.floater f set webhook_url = o.webhook_url
  from staging_safety.floater_original o
 where o.id = f.id and current_setting('staging.integration') = 'webhooks';

insert into staging_safety.applied (summary)
values (jsonb_build_object('restored', current_setting('staging.integration')));
commit;
