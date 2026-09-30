-- Platform operation lease: atomic acquire/release for long-running,
-- mutually-exclusive platform operations (first user: demo tenant
-- seed/reset/delete). NULL tenant_id rows in system_settings cannot be
-- serialized by its unique constraint (NULLs are distinct), so leases get
-- their own tiny table with a non-null primary key and RPC pair.
--
-- Access: server-side only (service_role). Postgres grants EXECUTE on new
-- functions to PUBLIC by default, so both functions revoke PUBLIC explicitly
-- and grant only service_role.
--
-- Idempotent: safe to re-run.

create table if not exists platform_op_lock (
  lock_key text primary key,
  holder_token text not null,
  holder_info jsonb,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table platform_op_lock enable row level security;

-- Atomically acquire (or steal an expired) lease. Returns
-- { acquired: bool, holder_info, expires_at } — when not acquired, the
-- current live holder's info is returned.
create or replace function acquire_platform_op_lock(
  p_key text,
  p_token text,
  p_info jsonb,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row platform_op_lock%rowtype;
begin
  -- Input validation: bounded positive TTL and constrained key/token shapes,
  -- so no caller can create an excessive or malformed lease.
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'p_ttl_seconds must be between 1 and 3600';
  end if;
  if p_key is null or p_key !~ '^[a-z0-9_:-]{1,120}$' then
    raise exception 'invalid lock key';
  end if;
  if p_token is null or p_token !~ '^[a-f0-9]{16,64}$' then
    raise exception 'invalid lock token';
  end if;

  -- Serialize competing acquirers on the key row.
  insert into platform_op_lock (lock_key, holder_token, holder_info, expires_at)
  values (p_key, p_token, p_info, now() + make_interval(secs => p_ttl_seconds))
  on conflict (lock_key) do update
    set holder_token = excluded.holder_token,
        holder_info = excluded.holder_info,
        acquired_at = now(),
        expires_at = excluded.expires_at
    where platform_op_lock.expires_at < now()
       or platform_op_lock.holder_token = excluded.holder_token
  returning * into v_row;

  if v_row.lock_key is not null and v_row.holder_token = p_token then
    return jsonb_build_object('acquired', true, 'expires_at', v_row.expires_at);
  end if;

  select * into v_row from platform_op_lock where lock_key = p_key;
  return jsonb_build_object(
    'acquired', false,
    'holder_info', v_row.holder_info,
    'expires_at', v_row.expires_at
  );
end;
$$;

-- Release only the lease owned by the given token.
create or replace function release_platform_op_lock(
  p_key text,
  p_token text
) returns boolean
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from platform_op_lock
    where lock_key = p_key and holder_token = p_token
    returning 1
  )
  select exists(select 1 from deleted);
$$;

-- Lock down: server-only access via service_role.
revoke all on table platform_op_lock from public, anon, authenticated;
revoke all on function acquire_platform_op_lock(text, text, jsonb, integer) from public, anon, authenticated;
revoke all on function release_platform_op_lock(text, text) from public, anon, authenticated;
grant execute on function acquire_platform_op_lock(text, text, jsonb, integer) to service_role;
grant execute on function release_platform_op_lock(text, text) to service_role;
grant select, insert, update, delete on table platform_op_lock to service_role;
