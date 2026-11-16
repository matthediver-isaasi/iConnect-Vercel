-- Service-owned work queue. Browser roles must never claim or mutate jobs.
create table if not exists public.zoom_registration_job (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_kind text not null check (resource_kind in ('event','session')),
  resource_id uuid not null,
  request_key uuid not null,
  target jsonb not null,
  email_requested boolean not null default false,
  booking_ids jsonb not null,
  cursor integer not null default 0,
  status text not null default 'queued' check (status in ('queued','running','completed','attention','stopped')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  email_claimed_for uuid,
  totals jsonb not null default '{}',
  last_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, request_key)
);
create unique index if not exists zoom_registration_job_active
  on public.zoom_registration_job(tenant_id,resource_kind,resource_id)
  where status in ('queued','running');
create index if not exists zoom_registration_job_due on public.zoom_registration_job(available_at)
  where status in ('queued','running');
alter table public.zoom_registration_job enable row level security;
revoke all on public.zoom_registration_job from public, anon, authenticated;
grant select, insert, update on public.zoom_registration_job to service_role;

create or replace function public.claim_zoom_registration_job()
returns setof public.zoom_registration_job
language sql security definer set search_path = public as $$
  update public.zoom_registration_job
  set status='running', lease_token=gen_random_uuid(), lease_until=now()+interval '6 minutes',
      updated_at=now()
  where id = (
    select id from public.zoom_registration_job
    where status in ('queued','running') and available_at <= now()
      and (lease_until is null or lease_until < now())
    order by available_at, created_at for update skip locked limit 1
  ) returning *;
$$;
revoke all on function public.claim_zoom_registration_job() from public, anon, authenticated;
grant execute on function public.claim_zoom_registration_job() to service_role;

-- Attach and enqueue are one transaction; a dropped HTTP response cannot leave
-- an attached target without its registration work.
create or replace function public.enqueue_zoom_registration_job(p_job jsonb, p_expected jsonb, p_patch jsonb)
returns public.zoom_registration_job
language plpgsql security definer set search_path = public as $$
declare j public.zoom_registration_job; current_target jsonb;
begin
  select * into j from public.zoom_registration_job
    where tenant_id=(p_job->>'tenant_id')::uuid and request_key=(p_job->>'request_key')::uuid;
  if found then
    if j.resource_id<>(p_job->>'resource_id')::uuid or j.resource_kind<>p_job->>'resource_kind' then
      raise exception 'Request key already used';
    end if;
    return j;
  end if;
  if p_job->>'resource_kind'='event' then
    select jsonb_build_object('zoom_meeting_id',zoom_meeting_id,'zoom_webinar_id',zoom_webinar_id)
      into current_target from public.event
      where id=(p_job->>'resource_id')::uuid and tenant_id=(p_job->>'tenant_id')::uuid for update;
  else
    select jsonb_build_object('zoom_meeting_id',zoom_meeting_id,'zoom_webinar_id',zoom_webinar_id)
      into current_target from public.complex_event_session
      where id=(p_job->>'resource_id')::uuid and tenant_id=(p_job->>'tenant_id')::uuid for update;
  end if;
  if current_target is null or current_target <> p_expected then
    raise exception 'Zoom target changed; reload before starting registration';
  end if;
  insert into public.zoom_registration_job(tenant_id,resource_kind,resource_id,request_key,target,email_requested,booking_ids,created_by)
    values ((p_job->>'tenant_id')::uuid,p_job->>'resource_kind',(p_job->>'resource_id')::uuid,
      (p_job->>'request_key')::uuid,p_job->'target',(p_job->>'email_requested')::boolean,p_job->'booking_ids',
      (p_job->>'created_by')::uuid) returning * into j;
  if j.resource_kind='event' then
    update public.event set
      zoom_meeting_id=(p_patch->>'zoom_meeting_id')::uuid,
      zoom_webinar_id=(p_patch->>'zoom_webinar_id')::uuid,
      is_online=true, online_provider='zoom',
      start_date=case when p_patch ? 'start_date' then (p_patch->>'start_date')::timestamptz else start_date end,
      end_date=case when p_patch ? 'end_date' then (p_patch->>'end_date')::timestamptz else end_date end,
      timezone=coalesce(p_patch->>'timezone',timezone)
      where id=j.resource_id and tenant_id=j.tenant_id;
  else
    update public.complex_event_session set
      zoom_meeting_id=p_patch->>'zoom_meeting_id', zoom_webinar_id=p_patch->>'zoom_webinar_id',
      zoom_type=p_patch->>'zoom_type', online_provider='zoom',
      zoom_join_url=p_patch->>'zoom_join_url', zoom_start_url=p_patch->>'zoom_start_url',
      zoom_registration_url=p_patch->>'zoom_registration_url',
      start_time=case when p_patch ? 'start_time' then (p_patch->>'start_time')::timestamptz else start_time end,
      end_time=case when p_patch ? 'end_time' then (p_patch->>'end_time')::timestamptz else end_time end,
      timezone=coalesce(p_patch->>'timezone',timezone)
      where id=j.resource_id and tenant_id=j.tenant_id;
  end if;
  return j;
end;
$$;
revoke all on function public.enqueue_zoom_registration_job(jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_zoom_registration_job(jsonb,jsonb,jsonb) to service_role;
