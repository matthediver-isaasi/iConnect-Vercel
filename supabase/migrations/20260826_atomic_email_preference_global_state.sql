-- Atomically update global email preferences and their category/ledger state.
-- Server-only: preference links are validated by the API before this RPC runs.

create or replace function set_email_preference_global_state(
  p_tenant_id uuid,
  p_email text,
  p_member_id uuid,
  p_opt_out_all boolean,
  p_campaign_id uuid,
  p_category_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_category_id uuid;
begin
  if p_tenant_id is null or v_email = '' or p_opt_out_all is null then
    raise exception 'invalid email preference global state input';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || v_email, 0)
  );

  if exists (
    select 1
    from unnest(coalesce(p_category_ids, array[]::uuid[])) supplied(id)
    left join communication_category category
      on category.id = supplied.id
      and category.tenant_id = p_tenant_id
      and category.is_active = true
    where category.id is null
  ) then
    raise exception 'invalid communication category';
  end if;

  if p_member_id is not null then
    update member
    set communications_opted_out_all = p_opt_out_all
    where id = p_member_id
      and tenant_id = p_tenant_id
      and lower(trim(email)) = v_email;
    if not found then
      raise exception 'member not found';
    end if;

    if p_opt_out_all then
      foreach v_category_id in array coalesce(p_category_ids, array[]::uuid[])
      loop
        insert into member_communication_preference (
          tenant_id, member_id, category_id, is_subscribed
        ) values (
          p_tenant_id, p_member_id, v_category_id, false
        )
        on conflict (member_id, category_id)
        do update set is_subscribed = false;
      end loop;
    end if;
  elsif p_opt_out_all then
    update email_subscriber
    set opted_out = true,
        opted_out_at = now(),
        updated_at = now()
    where tenant_id = p_tenant_id
      and lower(trim(email)) = v_email;
  end if;

  if p_opt_out_all then
    insert into email_unsubscribe (
      tenant_id, email, member_id, unsubscribe_type,
      communication_category_id, campaign_id, source, unsubscribed_at
    ) values (
      p_tenant_id, v_email, p_member_id, 'all',
      null, p_campaign_id, 'user', now()
    )
    on conflict (tenant_id, email, unsubscribe_type, communication_category_id)
    do update set
      member_id = excluded.member_id,
      campaign_id = excluded.campaign_id,
      source = excluded.source,
      unsubscribed_at = excluded.unsubscribed_at;

    foreach v_category_id in array coalesce(p_category_ids, array[]::uuid[])
    loop
      insert into email_unsubscribe (
        tenant_id, email, member_id, unsubscribe_type,
        communication_category_id, campaign_id, source, unsubscribed_at
      ) values (
        p_tenant_id, v_email, p_member_id, 'category',
        v_category_id, p_campaign_id, 'user', now()
      )
      on conflict (tenant_id, email, unsubscribe_type, communication_category_id)
      do update set
        member_id = excluded.member_id,
        campaign_id = excluded.campaign_id,
        source = excluded.source,
        unsubscribed_at = excluded.unsubscribed_at;
    end loop;
  else
    delete from email_unsubscribe
    where tenant_id = p_tenant_id
      and lower(trim(email)) = v_email
      and unsubscribe_type = 'all'
      and communication_category_id is null;
  end if;
end;
$$;

create or replace function set_email_preference_category_state(
  p_tenant_id uuid,
  p_email text,
  p_member_id uuid,
  p_category_id uuid,
  p_is_subscribed boolean,
  p_campaign_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
begin
  if p_tenant_id is null
    or v_email = ''
    or p_category_id is null
    or p_is_subscribed is null
  then
    raise exception 'invalid email preference category state input';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || v_email, 0)
  );

  if not exists (
    select 1
    from communication_category
    where id = p_category_id
      and tenant_id = p_tenant_id
      and is_active = true
  ) then
    raise exception 'invalid communication category';
  end if;

  if p_member_id is not null then
    if exists (
      select 1
      from member
      where id = p_member_id
        and tenant_id = p_tenant_id
        and lower(trim(email)) = v_email
        and communications_opted_out_all = true
    ) then
      raise exception 'global email opt-out is active';
    end if;
    if not exists (
      select 1
      from member
      where id = p_member_id
        and tenant_id = p_tenant_id
        and lower(trim(email)) = v_email
    ) then
      raise exception 'member not found';
    end if;

    insert into member_communication_preference (
      tenant_id, member_id, category_id, is_subscribed
    ) values (
      p_tenant_id, p_member_id, p_category_id, p_is_subscribed
    )
    on conflict (member_id, category_id)
    do update set is_subscribed = excluded.is_subscribed;
  else
    if exists (
      select 1
      from email_unsubscribe
      where tenant_id = p_tenant_id
        and lower(trim(email)) = v_email
        and unsubscribe_type = 'all'
        and communication_category_id is null
    ) then
      raise exception 'global email opt-out is active';
    end if;

    update email_subscriber
    set opted_out = not p_is_subscribed,
        opted_out_at = case when p_is_subscribed then null else now() end,
        updated_at = now()
    where tenant_id = p_tenant_id
      and lower(trim(email)) = v_email
      and communication_category_id = p_category_id;
    if not found then
      raise exception 'external subscriber category not found';
    end if;
  end if;

  if p_is_subscribed then
    delete from email_unsubscribe
    where tenant_id = p_tenant_id
      and lower(trim(email)) = v_email
      and unsubscribe_type = 'category'
      and communication_category_id = p_category_id;
  else
    insert into email_unsubscribe (
      tenant_id, email, member_id, unsubscribe_type,
      communication_category_id, campaign_id, source, unsubscribed_at
    ) values (
      p_tenant_id, v_email, p_member_id, 'category',
      p_category_id, p_campaign_id, 'user', now()
    )
    on conflict (tenant_id, email, unsubscribe_type, communication_category_id)
    do update set
      member_id = excluded.member_id,
      campaign_id = excluded.campaign_id,
      source = excluded.source,
      unsubscribed_at = excluded.unsubscribed_at;
  end if;
end;
$$;

create or replace function set_form_communication_preference_state(
  p_tenant_id uuid,
  p_email text,
  p_member_id uuid,
  p_form_id uuid,
  p_first_name text,
  p_last_name text,
  p_category_ids uuid[],
  p_is_subscribed boolean[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_member_email text;
  v_category_id uuid;
  v_is_subscribed boolean;
  v_index integer;
  v_has_opt_in boolean := false;
begin
  if p_tenant_id is null
    or v_email = ''
    or cardinality(coalesce(p_category_ids, array[]::uuid[])) = 0
    or p_is_subscribed is null
    or cardinality(p_category_ids) <> cardinality(p_is_subscribed)
  then
    raise exception 'invalid form communication preference input';
  end if;

  if p_member_id is not null then
    select lower(trim(email))
    into v_member_email
    from member
    where id = p_member_id
      and tenant_id = p_tenant_id;
    if v_member_email is null then
      raise exception 'member not found';
    end if;
    v_email := v_member_email;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || v_email, 0)
  );

  if exists (
    select 1
    from unnest(p_category_ids) supplied(id)
    left join communication_category category
      on category.id = supplied.id
      and category.tenant_id = p_tenant_id
      and category.is_active = true
    where category.id is null
  ) then
    raise exception 'invalid communication category';
  end if;

  select coalesce(bool_or(value), false)
  into v_has_opt_in
  from unnest(p_is_subscribed) values_table(value);

  if v_has_opt_in then
    if p_member_id is not null then
      update member
      set communications_opted_out_all = false
      where id = p_member_id
        and tenant_id = p_tenant_id;
    end if;
    delete from email_unsubscribe
    where tenant_id = p_tenant_id
      and lower(trim(email)) = v_email
      and unsubscribe_type = 'all'
      and communication_category_id is null;
  end if;

  for v_index in 1..cardinality(p_category_ids)
  loop
    v_category_id := p_category_ids[v_index];
    v_is_subscribed := p_is_subscribed[v_index];

    if p_member_id is not null then
      insert into member_communication_preference (
        tenant_id, member_id, category_id, is_subscribed
      ) values (
        p_tenant_id, p_member_id, v_category_id, v_is_subscribed
      )
      on conflict (member_id, category_id)
      do update set is_subscribed = excluded.is_subscribed;

      delete from email_subscriber
      where tenant_id = p_tenant_id
        and lower(trim(email)) = v_email
        and communication_category_id = v_category_id;
    else
      insert into email_subscriber (
        tenant_id, email, first_name, last_name, form_id,
        communication_category_id, opted_out, subscribed_at,
        opted_out_at, updated_at
      ) values (
        p_tenant_id, v_email, p_first_name, p_last_name, p_form_id,
        v_category_id, not v_is_subscribed, now(),
        case when v_is_subscribed then null else now() end, now()
      )
      on conflict (tenant_id, email, communication_category_id)
      where communication_category_id is not null
      do update set
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        form_id = excluded.form_id,
        opted_out = excluded.opted_out,
        opted_out_at = excluded.opted_out_at,
        updated_at = excluded.updated_at;
    end if;

    if v_is_subscribed then
      delete from email_unsubscribe
      where tenant_id = p_tenant_id
        and lower(trim(email)) = v_email
        and unsubscribe_type = 'category'
        and communication_category_id = v_category_id;
    else
      insert into email_unsubscribe (
        tenant_id, email, member_id, unsubscribe_type,
        communication_category_id, source, unsubscribed_at
      ) values (
        p_tenant_id, v_email, p_member_id, 'category',
        v_category_id, 'user', now()
      )
      on conflict (tenant_id, email, unsubscribe_type, communication_category_id)
      do update set
        member_id = excluded.member_id,
        source = excluded.source,
        unsubscribed_at = excluded.unsubscribed_at;
    end if;
  end loop;
end;
$$;

revoke all on function set_email_preference_global_state(
  uuid, text, uuid, boolean, uuid, uuid[]
) from public, anon, authenticated;
grant execute on function set_email_preference_global_state(
  uuid, text, uuid, boolean, uuid, uuid[]
) to service_role;
revoke all on function set_email_preference_category_state(
  uuid, text, uuid, uuid, boolean, uuid
) from public, anon, authenticated;
grant execute on function set_email_preference_category_state(
  uuid, text, uuid, uuid, boolean, uuid
) to service_role;
revoke all on function set_form_communication_preference_state(
  uuid, text, uuid, uuid, text, text, uuid[], boolean[]
) from public, anon, authenticated;
grant execute on function set_form_communication_preference_state(
  uuid, text, uuid, uuid, text, text, uuid[], boolean[]
) to service_role;