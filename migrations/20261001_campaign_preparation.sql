-- Apply before deploying the resumable campaign worker. No legacy preparation
-- is inferred complete from the existence of recipient rows.
alter table public.email_campaign add column if not exists preparation_generation uuid;
alter table public.email_campaign add column if not exists preparation_actor_member_id uuid;
create table if not exists public.campaign_preparation (
  id uuid primary key,
  campaign_id uuid not null references public.email_campaign(id) on delete cascade,
  tenant_id uuid not null,
  campaign_version timestamptz,
  snapshot jsonb not null,
  phase text not null default 'resolve',
  segment integer not null default 0,
  cursor integer not null default 0,
  last_ordinal bigint not null default 0,
  continuation jsonb not null default '{}',
  has_consent_checks boolean not null default false,
  total integer not null default 0,
  lease uuid,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.campaign_preparation add column if not exists continuation jsonb not null default '{}';
alter table public.campaign_preparation add column if not exists has_consent_checks boolean not null default false;
create index if not exists campaign_preparation_work
  on public.campaign_preparation(updated_at) where phase<>'complete';
create index if not exists campaign_preparation_campaign
  on public.campaign_preparation(campaign_id);
create table if not exists public.campaign_preparation_read (
  generation uuid not null references public.campaign_preparation(id) on delete cascade,
  segment integer not null,
  sequence integer not null,
  key text not null,
  result jsonb not null,
  primary key (generation, segment, key)
);
create index if not exists campaign_preparation_read_sequence
  on public.campaign_preparation_read(generation, segment, sequence);
create table if not exists public.campaign_preparation_recipient (
  generation uuid not null references public.campaign_preparation(id) on delete cascade,
  email_key text not null,
  ordinal bigint generated always as identity,
  recipient_id uuid not null default gen_random_uuid(),
  recipient jsonb not null,
  primary key (generation, email_key),
  unique (generation, ordinal)
);
create index if not exists campaign_preparation_recipient_id
  on public.campaign_preparation_recipient(generation,recipient_id);
create table if not exists public.campaign_preparation_fact (
  generation uuid not null references public.campaign_preparation(id) on delete cascade,
  segment integer not null,
  bucket text not null,
  key text not null,
  value jsonb not null default '{}',
  primary key(generation,segment,bucket,key)
);
create table if not exists public.campaign_preparation_candidate (
  generation uuid not null references public.campaign_preparation(id) on delete cascade,
  ordinal bigint generated always as identity,
  recipient jsonb not null,
  primary key(generation,ordinal)
);
create index if not exists campaign_preparation_member_email
  on public.member(tenant_id,lower(btrim(email)));
create index if not exists campaign_preparation_member_exact_email
  on public.member(tenant_id,lower(email));
create index if not exists campaign_preparation_unsubscribe_email
  on public.email_unsubscribe(tenant_id,lower(btrim(email)));
alter table public.campaign_preparation_fact enable row level security;
alter table public.campaign_preparation_candidate enable row level security;
alter table public.campaign_preparation enable row level security;
alter table public.campaign_preparation_read enable row level security;
alter table public.campaign_preparation_recipient enable row level security;
revoke all on public.campaign_preparation, public.campaign_preparation_read,
  public.campaign_preparation_recipient,public.campaign_preparation_fact,public.campaign_preparation_candidate from anon, authenticated;
grant all on public.campaign_preparation, public.campaign_preparation_read,
  public.campaign_preparation_recipient,public.campaign_preparation_fact,public.campaign_preparation_candidate to service_role;

create or replace function public.campaign_preparation_email_members(p_tenant uuid,p_emails text[],p_trim boolean default false)
returns table(email_key text,id uuid,email text,first_name text,last_name text,
  communications_opted_out_all boolean,any_opted_out boolean,login_enabled boolean,organization_id uuid)
language sql stable security definer set search_path=public as $$
  select e.key,m.id,m.email,m.first_name,m.last_name,m.communications_opted_out_all,
    exists(select 1 from member x where x.tenant_id=p_tenant and
      (case when p_trim then lower(btrim(x.email)) else lower(x.email) end)=e.key
      and x.communications_opted_out_all is true),m.login_enabled,m.organization_id
  from (select distinct lower(btrim(v)) as key from unnest(p_emails[1:200]) v) e
  cross join lateral(select * from member x where x.tenant_id=p_tenant and
    (case when p_trim then lower(btrim(x.email)) else lower(x.email) end)=e.key
    and x.email !~* '^deleted_.*@deleted[.]local$' order by x.id desc limit 1) m
$$;
create or replace function public.campaign_preparation_attended_bookings(p_tenant uuid,p_ids uuid[])
returns table(booking_id uuid) language sql stable security definer set search_path=public as $$
  select distinct c.booking_id from complex_event_session_checkin c
  where c.tenant_id=p_tenant and c.booking_id=any(p_ids[1:200]) and c.checked_in_at is not null
$$;
revoke all on function public.campaign_preparation_email_members(uuid,text[],boolean) from public,anon,authenticated;
revoke all on function public.campaign_preparation_attended_bookings(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.campaign_preparation_email_members(uuid,text[],boolean) to service_role;
grant execute on function public.campaign_preparation_attended_bookings(uuid,uuid[]) to service_role;

create or replace function public.campaign_preparation_begin(
  p_campaign uuid, p_tenant uuid, p_version timestamptz, p_status text,
  p_scheduled timestamptz, p_generation uuid, p_actor uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare c email_campaign%rowtype;
begin
  select * into c from email_campaign where id=p_campaign and tenant_id=p_tenant for update;
  if not found or c.status not in ('draft','scheduled') or c.status<>p_status
    or c.updated_at is distinct from p_version or c.scheduled_at is distinct from p_scheduled
    or c.category_review_required is true then
    raise exception 'Campaign preparation conflict';
  end if;
  -- Never mix a new generation with residual provider or partial audience rows.
  if exists(select 1 from email_campaign_recipient where campaign_id=c.id) then
    raise exception 'Existing campaign recipients require reconciliation before preparation';
  end if;
  update email_campaign set status='preparing', preparation_generation=p_generation,
    preparation_actor_member_id=p_actor,
    sent_count=0, total_recipients=0, sent_at=now(), updated_at=clock_timestamp()
    where id=c.id returning * into c;
  insert into campaign_preparation(id,campaign_id,tenant_id,campaign_version,snapshot)
    values(p_generation,c.id,c.tenant_id,c.updated_at,to_jsonb(c));
  return to_jsonb(c);
end $$;

create or replace function public.campaign_preparation_identity(value jsonb)
returns jsonb language sql immutable set search_path=public as $$
  select value-array['status','updated_at','paused_at','paused_by','pause_reason',
    'sent_count','opened_count','clicked_count','delivered_count','failed_count']
$$;

-- One short transaction per checkpoint. A crashed owner can be replaced after
-- its lease expires, but cannot commit with its old token afterwards.
create or replace function public.campaign_preparation_step(
  p_generation uuid, p_owner uuid, p_action text, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare p campaign_preparation%rowtype; c email_campaign%rowtype; r jsonb; n integer;
  plan_quotas jsonb; plan_code_value text; email_limit numeric; used bigint; reserved bigint; next_ordinal bigint;
  candidate record; eligible boolean; bypass boolean; member_key uuid; category_key uuid;
  accepted integer:=0; inserted_count integer;
begin
  select * into p from campaign_preparation where id=p_generation;
  if not found then raise exception 'Preparation not found'; end if;
  select * into c from email_campaign where id=p.campaign_id for update;
  select * into p from campaign_preparation where id=p_generation for update;
  if c.preparation_generation is distinct from p.id then raise exception 'Preparation generation changed'; end if;
  if p_action='resume' then
    if c.status not in ('paused','failed') or p.phase in ('complete','failed') then raise exception 'Preparation cannot resume'; end if;
    -- Only operator metadata may change while a generation is paused.
    if campaign_preparation_identity(to_jsonb(c)) is distinct from campaign_preparation_identity(p.snapshot) then
      raise exception 'Campaign changed while preparation was paused';
    end if;
    update email_campaign set status='preparing', updated_at=clock_timestamp()
      where id=c.id returning * into c;
    update campaign_preparation set campaign_version=c.updated_at,snapshot=to_jsonb(c),
      lease=null,lease_until=null,last_error=null where id=p.id;
    return to_jsonb(c);
  end if;
  if c.status<>'preparing' then raise exception 'Preparation no longer authorized'; end if;
  if p_action='claim' then
    if p.lease_until>clock_timestamp() and p.lease is distinct from p_owner then return null; end if;
    update campaign_preparation set lease=p_owner,lease_until=clock_timestamp()+interval '55 seconds',
      updated_at=clock_timestamp() where id=p.id returning * into p;
    if c.updated_at is distinct from p.campaign_version
      or campaign_preparation_identity(to_jsonb(c)) is distinct from campaign_preparation_identity(p.snapshot)
      or c.category_review_required is true then
      return to_jsonb(p)||jsonb_build_object('authorization_error','Campaign changed or requires review; this audience preparation is no longer authorized');
    end if;
    return to_jsonb(p);
  end if;
  if p.lease is distinct from p_owner or p.lease_until<=clock_timestamp() then
    raise exception 'Preparation lease expired';
  end if;
  -- Failure is not promotion: a current, leased generation can be closed after
  -- its policy/content becomes invalid. Generation, status and lease fencing
  -- above still prevent overwriting cancellation, pause, or a newer owner.
  if p_action<>'fail' and (c.updated_at is distinct from p.campaign_version
     or campaign_preparation_identity(to_jsonb(c)) is distinct from campaign_preparation_identity(p.snapshot)
     or c.category_review_required is true) then raise exception 'Preparation no longer authorized'; end if;
  if p_action in ('quota','complete') then
    -- Serialize reservations across campaigns in the same tenant. Count both
    -- submitted usage and queued/reserved work; retries exclude their own
    -- reservation rather than charging the same generation twice.
    perform pg_advisory_xact_lock(hashtextextended(p.tenant_id::text,4891));
    select coalesce(plan_code,'free') into plan_code_value from tenant where id=p.tenant_id;
    if not found then raise exception 'Cannot verify campaign tenant quota'; end if;
    select quotas into plan_quotas from plan where code=plan_code_value;
    if not found then raise exception 'Cannot verify campaign plan quota'; end if;
    if plan_quotas->>'emails_per_month' is not null then
      email_limit := (plan_quotas->>'emails_per_month')::numeric;
      if email_limit<0 then raise exception 'Invalid email plan quota'; end if;
      -- One snapshot: a provider update from pending to sent cannot fall
      -- between a usage query and a reservation query and disappear from both.
      select
        count(*) filter(where er.status in ('sent','delivered','opened','clicked')
          and er.sent_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'),
        count(*) filter(where ec.id<>p.campaign_id
          and ((er.status='pending' and ec.status in ('sending','paused')
              and (ec.preparation_generation is null or exists(select 1 from campaign_preparation cp
                where cp.id=ec.preparation_generation and cp.phase='complete')))
            or er.status='processing'))
        into used,reserved from email_campaign_recipient er
        join email_campaign ec on ec.id=er.campaign_id
        where ec.tenant_id=p.tenant_id;
      reserved := reserved + coalesce((select sum(cp.total) from campaign_preparation cp
        join email_campaign ec on ec.preparation_generation=cp.id
        where cp.tenant_id=p.tenant_id and cp.id<>p.id and cp.phase='insert'
          and ec.status in ('preparing','paused')),0);
      if used+reserved+p.total>email_limit then
        raise exception 'Plan email quota exceeded: used %, reserved %, audience %, limit %',
          used,reserved,p.total,email_limit;
      end if;
    end if;
  end if;
  if p_action='stream' then
    if p.phase<>'resolve' or p.segment is distinct from (p_payload->>'segment')::integer
      or p.continuation is distinct from p_payload->'expected' then raise exception 'Resolution checkpoint conflict'; end if;
    if exists(select 1 from campaign_preparation_recipient where generation=p.id) then
      raise exception 'Legacy partially staged preparation requires review before streamed resolution';
    end if;
    if jsonb_typeof(p_payload->'candidates') is distinct from 'array'
      or jsonb_typeof(p_payload->'facts') is distinct from 'array'
      or jsonb_array_length(p_payload->'candidates')>200 or jsonb_array_length(p_payload->'facts')>400 then
      raise exception 'Resolution checkpoint exceeds chunk budget';
    end if;
    for r in select value from jsonb_array_elements(p_payload->'facts') loop
      insert into campaign_preparation_fact(generation,segment,bucket,key,value)
        values(p.id,p.segment,r->>'bucket',r->>'key',coalesce(r->'value','{}')) on conflict do nothing;
    end loop;
    for r in select value from jsonb_array_elements(p_payload->'candidates') loop
      insert into campaign_preparation_candidate(generation,recipient) values(p.id,r);
    end loop;
    update campaign_preparation set continuation=case when (p_payload->>'done')::boolean then '{}'::jsonb
      else p_payload->'continuation' end,segment=segment+case when (p_payload->>'done')::boolean then 1 else 0 end
      where id=p.id;
    delete from campaign_preparation_read where generation=p.id and segment=p.segment;
  elsif p_action='stream_resolved' then
    if p.phase<>'resolve' or p.segment<>(case when jsonb_typeof(p.snapshot->'target_audiences')='array'
      and jsonb_array_length(p.snapshot->'target_audiences')>0 then jsonb_array_length(p.snapshot->'target_audiences') else 1 end)
      then raise exception 'Audience segments are incomplete'; end if;
    update campaign_preparation set phase='global_consent',cursor=0,last_ordinal=0,total=0 where id=p.id;
  elsif p_action in ('global_consent','consent') then
    if p.phase<>p_action or p.cursor is distinct from (p_payload->>'cursor')::integer then raise exception 'Consent checkpoint conflict'; end if;
    n:=0;next_ordinal:=p.last_ordinal;
    category_key:=nullif(p.snapshot->>'communication_category_id','')::uuid;
    for candidate in select * from campaign_preparation_candidate
      where generation=p.id and ordinal>p.last_ordinal order by ordinal limit 200 loop
      n:=n+1;next_ordinal:=candidate.ordinal;r:=candidate.recipient;
      bypass:=coalesce((r->>'bypass_opt_out')::boolean,false);
      member_key:=nullif(r->>'member_id','')::uuid;
      if p_action='global_consent' then
        eligible:=bypass or (coalesce((r->>'communications_opted_out_all')::boolean,false)=false
          and not exists(select 1 from email_unsubscribe u where u.tenant_id=p.tenant_id
            and lower(btrim(u.email))=lower(btrim(r->>'email')) and u.unsubscribe_type='all'));
        if not eligible then delete from campaign_preparation_candidate where generation=p.id and ordinal=candidate.ordinal;
        elsif not bypass then p.has_consent_checks:=true; end if;
      else
        eligible:=true;
        if p.has_consent_checks and category_key is not null then
          if member_key is not null then
            eligible:=exists(select 1 from member m where m.id=member_key and m.tenant_id=p.tenant_id
              and m.login_enabled is distinct from false and m.email is not null and m.email<>''
              and m.email !~* '^deleted_.*@deleted[.]local$');
            if eligible and not bypass then
              eligible:=exists(select 1 from member_communication_preference mp where mp.tenant_id=p.tenant_id
                and mp.member_id=member_key and mp.category_id=category_key and mp.is_subscribed is true);
            end if;
          end if;
          if eligible and not bypass then
            eligible:=not exists(select 1 from email_unsubscribe u where u.tenant_id=p.tenant_id
              and lower(btrim(u.email))=lower(btrim(r->>'email')) and u.unsubscribe_type='category'
              and u.communication_category_id=category_key);
          end if;
        end if;
        if eligible then
          insert into campaign_preparation_recipient(generation,email_key,recipient)
            values(p.id,lower(r->>'email'),r) on conflict do nothing;
          get diagnostics inserted_count=row_count;accepted:=accepted+inserted_count;
        end if;
      end if;
    end loop;
    if n=0 and p_action='consent' and p.total=0 then raise exception 'No recipients found for this campaign'; end if;
    update campaign_preparation set cursor=case when n=0 then 0 else cursor+n end,
      last_ordinal=case when n=0 then 0 else next_ordinal end,total=total+accepted,
      has_consent_checks=p.has_consent_checks,
      phase=case when n>0 then phase when p_action='global_consent' then 'consent' else 'quota' end where id=p.id;
  elsif p_action='read' then
    if p.phase<>'resolve' or p.segment<>(p_payload->>'segment')::integer then raise exception 'Read checkpoint conflict'; end if;
    insert into campaign_preparation_read(generation,segment,sequence,key,result)
      values(p.id,p.segment,(p_payload->>'sequence')::integer,p_payload->>'key',p_payload->'result') on conflict do nothing;
  elsif p_action='stage' then
    if p.phase<>'resolve' or p.segment<>(p_payload->>'segment')::integer or p.cursor<>(p_payload->>'cursor')::integer then
      raise exception 'Recipient checkpoint conflict';
    end if;
    if jsonb_typeof(p_payload->'recipients')<>'array' or jsonb_array_length(p_payload->'recipients')>200 then
      raise exception 'Recipient checkpoint exceeds chunk budget';
    end if;
    for r in select value from jsonb_array_elements(p_payload->'recipients') loop
      insert into campaign_preparation_recipient(generation,email_key,recipient)
        values(p.id,lower(r->>'email'),r) on conflict do nothing;
    end loop;
    update campaign_preparation set cursor=cursor+jsonb_array_length(p_payload->'recipients') where id=p.id;
  elsif p_action='segment' then
    if p.phase<>'resolve' or p.segment<>(p_payload->>'segment')::integer then raise exception 'Segment checkpoint conflict'; end if;
    update campaign_preparation set segment=segment+1,cursor=0 where id=p.id;
    delete from campaign_preparation_read where generation=p.id and segment=p.segment;
  elsif p_action='resolved' then
    if p.phase<>'resolve' then raise exception 'Phase conflict'; end if;
    if p.segment <> (case when jsonb_typeof(p.snapshot->'target_audiences')='array'
      and jsonb_array_length(p.snapshot->'target_audiences')>0
      then jsonb_array_length(p.snapshot->'target_audiences') else 1 end) then
      raise exception 'Audience segments are incomplete';
    end if;
    select count(*) into n from campaign_preparation_recipient where generation=p.id;
    if n=0 then raise exception 'No recipients found for this campaign'; end if;
    update campaign_preparation set phase='quota',cursor=0,total=n where id=p.id;
  elsif p_action='quota' then
    if p.phase<>'quota' then raise exception 'Phase conflict'; end if;
    update campaign_preparation set phase='insert',cursor=0,last_error=null where id=p.id;
  elsif p_action='insert' then
    if p.phase<>'insert' or p.cursor<>(p_payload->>'cursor')::integer then raise exception 'Insertion checkpoint conflict'; end if;
    with batch as (
      select * from campaign_preparation_recipient
      where generation=p.id and ordinal>p.last_ordinal order by ordinal limit 200
    ), inserted as (
      insert into email_campaign_recipient(id,campaign_id,member_id,email,first_name,last_name,status)
      select recipient_id,p.campaign_id,
        nullif(recipient->>'member_id','')::uuid,recipient->>'email',
        recipient->>'first_name',recipient->>'last_name','pending'
      from batch on conflict(id) do nothing returning id
    ) select count(*),max(ordinal) into n,next_ordinal from batch;
    if n=0 or p.cursor+n>p.total then raise exception 'Prepared recipient checkpoint is inconsistent'; end if;
    update campaign_preparation set cursor=cursor+n,last_ordinal=next_ordinal where id=p.id;
  elsif p_action='complete' then
    if p.phase<>'insert' or p.cursor<>p.total then raise exception 'Preparation is incomplete'; end if;
    select count(*) into n from email_campaign_recipient where campaign_id=c.id;
    if n<>p.total then raise exception 'Prepared recipient count mismatch'; end if;
    update campaign_preparation set phase='complete' where id=p.id;
    update email_campaign set status='sending',total_recipients=p.total,updated_at=clock_timestamp() where id=c.id;
  elsif p_action='fail' then
    update campaign_preparation set phase='failed',last_error=coalesce(nullif(p_payload->>'error',''),'Audience preparation failed'),
      lease=null,lease_until=null,updated_at=clock_timestamp() where id=p.id;
    update email_campaign set status='failed',updated_at=clock_timestamp() where id=c.id;
  elsif p_action='release' then
    update campaign_preparation set lease=null,lease_until=null,last_error=p_payload->>'error',
      updated_at=clock_timestamp() where id=p.id;
  else raise exception 'Unknown preparation action';
  end if;
  select * into p from campaign_preparation where id=p.id;
  return to_jsonb(p);
end $$;

create or replace function public.guard_campaign_preparation() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.status='sending' and old.status is distinct from 'sending'
     and new.preparation_generation is not null
     and not exists(select 1 from campaign_preparation where id=new.preparation_generation and phase='complete') then
    raise exception 'Cannot send a partially prepared campaign';
  end if;
  return new;
end $$;
drop trigger if exists guard_campaign_preparation on public.email_campaign;
create trigger guard_campaign_preparation before update on public.email_campaign
  for each row execute function public.guard_campaign_preparation();
revoke all on function public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid) from public,anon,authenticated;
revoke all on function public.campaign_preparation_step(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid) to service_role;
grant execute on function public.campaign_preparation_step(uuid,uuid,text,jsonb) to service_role;