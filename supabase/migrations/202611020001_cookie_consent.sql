-- PREPARED ONLY. Apply to the approved destination, never the legacy workspace DB.
begin;
create table public.cookie_consent_records (
  tenant_id uuid not null references public.tenant(id) on delete cascade,
  record_id text not null, consent_id text not null,
  domain text not null, categories jsonb not null, regulation text not null,
  region text, action text not null, source text not null, taxonomy_hash text not null,
  policy_version text not null, policy_revision text not null, decided_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, record_id)
);
create index cookie_consent_retention on public.cookie_consent_records(created_at);
alter table public.cookie_consent_records enable row level security;
revoke all on public.cookie_consent_records from public, anon, authenticated;
grant select, insert, delete on public.cookie_consent_records to service_role;
create table public.cookie_consent_budget (
  tenant_id uuid primary key references public.tenant(id) on delete cascade,
  bucket timestamptz not null, requests integer not null
);
alter table public.cookie_consent_budget enable row level security;
revoke all on public.cookie_consent_budget from public, anon, authenticated;
create function public.ingest_cookie_consent(p_tenant uuid, p_record jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer; v_bucket timestamptz := date_trunc('minute',clock_timestamp());
begin
  insert into cookie_consent_budget values (p_tenant,v_bucket,1)
  on conflict (tenant_id) do update set bucket=v_bucket,
    requests=case when cookie_consent_budget.bucket=v_bucket then cookie_consent_budget.requests+1 else 1 end
  returning requests into v_count;
  if v_count>600 then return false; end if;
  insert into cookie_consent_records
  (tenant_id,record_id,consent_id,domain,categories,regulation,region,action,source,taxonomy_hash,policy_version,policy_revision,decided_at)
  values (p_tenant,p_record->>'record_id',p_record->>'consent_id',p_record->>'domain',p_record->'categories',
  p_record->>'regulation',p_record->>'region',p_record->>'action',p_record->>'source',p_record->>'taxonomy_hash',
  p_record->>'policy_version',p_record->>'policy_revision',(p_record->>'decided_at')::timestamptz)
  on conflict (tenant_id,record_id) do nothing;
  return true;
end $$;
revoke all on function public.ingest_cookie_consent(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_cookie_consent(uuid,jsonb) to service_role;
create function public.set_cookie_consent_settings(p_tenant uuid,p_value jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform set_config('app.cookie_consent_write','yes',true);
  if p_tenant is null then
    insert into platform_preferences(key,value) values ('cookie_consent',p_value)
    on conflict(key) do update set value=excluded.value;
  else
    update tenant set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{cookie_consent}',p_value) where id=p_tenant;
    if not found then raise exception 'Tenant not found'; end if;
  end if;
  perform set_config('app.cookie_consent_write','no',true);
end $$;
revoke all on function public.set_cookie_consent_settings(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.set_cookie_consent_settings(uuid,jsonb) to service_role;
create function public.guard_cookie_consent_settings() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if current_setting('app.cookie_consent_write',true) is distinct from 'yes' then
    if TG_TABLE_NAME='tenant' then
      if (to_jsonb(OLD)->'settings'->'cookie_consent') is distinct from (to_jsonb(NEW)->'settings'->'cookie_consent') then
        raise exception 'Use dedicated cookie consent settings endpoint';
      end if;
    elsif to_jsonb(OLD)->>'key'='cookie_consent' or to_jsonb(NEW)->>'key'='cookie_consent' then
      raise exception 'Use dedicated cookie consent settings endpoint';
    end if;
  end if;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
create trigger tenant_cookie_consent_guard before insert or update on public.tenant for each row execute function public.guard_cookie_consent_settings();
create trigger platform_cookie_consent_guard before insert or update or delete on public.platform_preferences for each row execute function public.guard_cookie_consent_settings();
create function public.cleanup_cookie_consent() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare days integer; removed integer;
begin
  select coalesce((value->>'retentionDays')::integer,180) into days from platform_preferences where key='cookie_consent';
  days := coalesce(days,180);
  if days<7 or days>730 then raise exception 'Invalid retention'; end if;
  delete from cookie_consent_records where (tenant_id,record_id) in (
    select tenant_id,record_id from cookie_consent_records
    where created_at < clock_timestamp()-make_interval(days=>days)
    order by created_at limit 1000 for update skip locked
  );
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function public.cleanup_cookie_consent() from public,anon,authenticated;
grant execute on function public.cleanup_cookie_consent() to service_role;
commit;
