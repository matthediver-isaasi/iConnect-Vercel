-- Private configuration and short-lived purchaser capabilities. No historical backfill.
create table if not exists public.event_registration_communication (
  tenant_id uuid not null,
  event_kind text not null check (event_kind in ('simple','complex')),
  event_id uuid not null,
  category_ids uuid[] not null default '{}',
  primary key (tenant_id, event_kind, event_id)
);
create table if not exists public.event_registration_consent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_kind text not null check (event_kind in ('simple','complex')),
  event_id uuid not null,
  purchase_reference text not null,
  member_id uuid,
  email text not null,
  token_hash text not null unique,
  recovery_hash text,
  expires_at timestamptz not null default now() + interval '30 minutes',
  completed_at timestamptz,
  selected_category_ids uuid[],
  source text not null default 'event_registration',
  created_at timestamptz not null default now(),
  unique (tenant_id, event_kind, event_id, purchase_reference)
);
alter table public.event_registration_communication enable row level security;
alter table public.event_registration_consent enable row level security;
revoke all on public.event_registration_communication, public.event_registration_consent from public, anon, authenticated;
grant all on public.event_registration_communication, public.event_registration_consent to service_role;

create or replace function public.delete_event_registration_communication() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  delete from event_registration_communication where tenant_id=old.tenant_id and event_id=old.id
    and event_kind=case when tg_table_name='event' then 'simple' else 'complex' end;
  -- Revoke uncompleted capabilities; retain completed consent audit.
  delete from event_registration_consent where tenant_id=old.tenant_id and event_id=old.id and completed_at is null
    and event_kind=case when tg_table_name='event' then 'simple' else 'complex' end;
  return old;
end $$;
revoke all on function public.delete_event_registration_communication() from public,anon,authenticated;
drop trigger if exists delete_event_registration_communication on public.event;
create trigger delete_event_registration_communication after delete on public.event
  for each row execute function public.delete_event_registration_communication();
drop trigger if exists delete_event_registration_communication on public.complex_event;
create trigger delete_event_registration_communication after delete on public.complex_event
  for each row execute function public.delete_event_registration_communication();

-- Configuration replacement and subscription take the same event lock.
create or replace function public.set_event_registration_communication(
  p_tenant_id uuid, p_event_kind text, p_event_id uuid, p_category_ids uuid[]
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('event-consent:' || p_tenant_id::text || ':' || p_event_id::text, 0));
  if p_event_kind not in ('simple','complex') or p_category_ids is null
     or cardinality(p_category_ids) > 100 then raise exception 'Invalid configuration'; end if;
  if (p_event_kind = 'simple' and not exists(select 1 from event where id=p_event_id and tenant_id=p_tenant_id))
     or (p_event_kind = 'complex' and not exists(select 1 from complex_event where id=p_event_id and tenant_id=p_tenant_id))
  then raise exception 'Event unavailable'; end if;
  if exists(select 1 from unnest(p_category_ids) supplied(category_id)
      where not exists(select 1 from communication_category c where c.id=supplied.category_id and c.tenant_id=p_tenant_id and c.is_active))
  then raise exception 'Category unavailable'; end if;
  insert into event_registration_communication values (p_tenant_id,p_event_kind,p_event_id,p_category_ids)
  on conflict (tenant_id,event_kind,event_id) do update set category_ids=excluded.category_ids;
end $$;

-- The caller has checked special-category policy. This operation rechecks the
-- mutable audience/configuration/global state under the existing recipient lock.
create or replace function public.complete_event_registration_consent(
  p_id uuid, p_token_hash text, p_member_id uuid, p_category_ids uuid[]
) returns void language plpgsql security definer set search_path = public as $$
declare
  v event_registration_consent%rowtype;
  c communication_category%rowtype;
  m member%rowtype;
  category_id uuid;
  configured uuid[];
begin
  select * into v from event_registration_consent where id=p_id and token_hash=p_token_hash for update;
  if not found or v.expires_at <= now() or v.member_id is distinct from p_member_id then
    raise exception 'Offer unavailable';
  end if;
  if v.completed_at is not null then return; end if;
  if p_category_ids is null or cardinality(p_category_ids)>100 then raise exception 'Invalid selections'; end if;
  if cardinality(p_category_ids)=0 then
    update event_registration_consent set completed_at=now(),selected_category_ids='{}' where id=v.id;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('event-consent:' || v.tenant_id::text || ':' || v.event_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v.tenant_id::text || ':' || v.email, 0));
  select category_ids into configured from event_registration_communication
    where tenant_id=v.tenant_id and event_kind=v.event_kind and event_id=v.event_id;
  if configured is null or not p_category_ids <@ configured then raise exception 'Offer changed'; end if;
  if exists(select 1 from email_unsubscribe where tenant_id=v.tenant_id and lower(trim(email))=v.email
      and unsubscribe_type='all') then raise exception 'Subscription unavailable'; end if;
  if v.member_id is null then
    if exists(select 1 from member where tenant_id=v.tenant_id and lower(trim(email))=v.email) then
      raise exception 'Subscription unavailable';
    end if;
  else
    select * into m from member where id=v.member_id and tenant_id=v.tenant_id for share;
    if not found or lower(trim(m.email))<>v.email or m.login_enabled=false
      or m.communications_opted_out_all=true then raise exception 'Subscription unavailable'; end if;
  end if;
  foreach category_id in array p_category_ids loop
    select * into c from communication_category where id=category_id and tenant_id=v.tenant_id and is_active for share;
    if not found then raise exception 'Category unavailable'; end if;
    if v.member_id is null then
      if c.is_public is not true or c.system_key is not null
        or exists(select 1 from communication_category_role where tenant_id=v.tenant_id and communication_category_role.category_id=c.id)
      then raise exception 'Category unavailable'; end if;
      insert into email_subscriber(tenant_id,email,communication_category_id,opted_out,subscribed_at)
        values(v.tenant_id,v.email,c.id,true,now())
        on conflict (tenant_id,email,communication_category_id) where communication_category_id is not null do nothing;
    else
      if c.member_enabled=false then raise exception 'Category unavailable'; end if;
      if exists(select 1 from communication_category_role where tenant_id=v.tenant_id and communication_category_role.category_id=c.id)
        and not exists(select 1 from communication_category_role r where r.tenant_id=v.tenant_id and r.category_id=c.id
          and (to_jsonb(m.role_id) = to_jsonb(r.role_id) or to_jsonb(m.role_id) @> jsonb_build_array(r.role_id)))
      then raise exception 'Category unavailable'; end if;
    end if;
    perform set_email_preference_category_state(v.tenant_id,v.email,v.member_id,c.id,true,null);
  end loop;
  update event_registration_consent set completed_at=now(),selected_category_ids=p_category_ids where id=v.id;
end $$;
revoke all on function public.set_event_registration_communication(uuid,text,uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.complete_event_registration_consent(uuid,text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.set_event_registration_communication(uuid,text,uuid,uuid[]) to service_role;
grant execute on function public.complete_event_registration_consent(uuid,text,uuid,uuid[]) to service_role;
