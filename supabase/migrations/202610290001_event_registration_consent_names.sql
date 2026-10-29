-- Optional purchaser snapshot. Existing capabilities remain nameless.
alter table public.event_registration_consent
  add column if not exists first_name varchar(255),
  add column if not exists last_name varchar(255);

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
      -- Match the preference operation's normalized email, including legacy casing.
      -- Fill only blanks, only in selected categories, under the recipient lock.
      update email_subscriber s set
        first_name=case when nullif(btrim(s.first_name),'') is null then coalesce(nullif(btrim(v.first_name),''),s.first_name) else s.first_name end,
        last_name=case when nullif(btrim(s.last_name),'') is null then coalesce(nullif(btrim(v.last_name),''),s.last_name) else s.last_name end
        where s.tenant_id=v.tenant_id and lower(trim(s.email))=v.email and s.communication_category_id=c.id;
      if not found then
        insert into email_subscriber(tenant_id,email,first_name,last_name,communication_category_id,opted_out,subscribed_at)
          values(v.tenant_id,v.email,nullif(btrim(v.first_name),''),nullif(btrim(v.last_name),''),c.id,true,now())
          on conflict (tenant_id,email,communication_category_id) where communication_category_id is not null
          do update set
            first_name=case when nullif(btrim(email_subscriber.first_name),'') is null then coalesce(excluded.first_name,email_subscriber.first_name) else email_subscriber.first_name end,
            last_name=case when nullif(btrim(email_subscriber.last_name),'') is null then coalesce(excluded.last_name,email_subscriber.last_name) else email_subscriber.last_name end;
      end if;
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
revoke all on function public.complete_event_registration_consent(uuid,text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.complete_event_registration_consent(uuid,text,uuid,uuid[]) to service_role;
