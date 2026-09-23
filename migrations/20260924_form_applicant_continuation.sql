-- Service-only capabilities. Browser roles must never read or mint grants.
alter table public.form add column if not exists mutation_access_policy jsonb;
create table public.form_applicant_continuation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  form_id uuid not null references public.form(id),
  organization_id uuid not null references public.organization(id),
  token_hash text not null unique,
  draft_token_hashes text[] not null default '{}',
  member_ids uuid[],
  configuration_digest text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  issued_by text,
  created_at timestamptz not null default now(),
  -- Intentionally retained if a failed submission is deleted: never re-arm a consumed grant.
  submission_id uuid unique,
  bound_at timestamptz
);
alter table public.form_applicant_continuation enable row level security;
revoke all on public.form_applicant_continuation from anon, authenticated;
grant all on public.form_applicant_continuation to service_role;
alter table public.form_draft_submission add column if not exists applicant_continuation_id uuid
  references public.form_applicant_continuation(id);
create or replace function public.bind_form_applicant_continuation(
  p_grant_id uuid, p_tenant_id uuid, p_form_id uuid, p_submission_id uuid, p_digest text
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.form_applicant_continuation g set
    submission_id = p_submission_id, bound_at = coalesce(bound_at, now())
  where g.id = p_grant_id and g.tenant_id = p_tenant_id and g.form_id = p_form_id
    and g.configuration_digest = p_digest and g.revoked_at is null and g.expires_at > now()
    and (g.submission_id is null or g.submission_id = p_submission_id)
    and exists (select 1 from public.form_submission s where s.id = p_submission_id
      and s.tenant_id = p_tenant_id and s.form_id = p_form_id
      and s.organization_id = g.organization_id);
  return found;
end;
$$;
revoke all on function public.bind_form_applicant_continuation(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_form_applicant_continuation(uuid, uuid, uuid, uuid, text) to service_role;
create or replace function public.bind_form_applicant_draft(
  p_grant_id uuid, p_tenant_id uuid, p_token_hash text
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.form_applicant_continuation set draft_token_hashes =
    case when p_token_hash = any(draft_token_hashes) then draft_token_hashes
      else array_append(draft_token_hashes, p_token_hash) end
  where id = p_grant_id and tenant_id = p_tenant_id
    and revoked_at is null and expires_at > now();
  return found;
end;
$$;
revoke all on function public.bind_form_applicant_draft(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_form_applicant_draft(uuid, uuid, text) to service_role;