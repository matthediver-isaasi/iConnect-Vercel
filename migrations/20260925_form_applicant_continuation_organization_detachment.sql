-- Forward repair for installations of 20260924_form_applicant_continuation.sql.
-- Keep capability history when an organization is removed, but make the
-- detached capability permanently unusable.

alter table public.form_applicant_continuation
  alter column organization_id drop not null;

create index if not exists form_applicant_continuation_organization_id_idx
  on public.form_applicant_continuation (organization_id)
  where organization_id is not null;

create or replace function public.enforce_form_applicant_continuation_detachment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.organization_id is null then
    if new.organization_id is not null then
      raise exception 'A detached applicant continuation grant cannot be rebound'
        using errcode = '23514';
    end if;
    if new.revoked_at is null then
      raise exception 'A detached applicant continuation grant cannot be reactivated'
        using errcode = '23514';
    end if;
  elsif new.organization_id is distinct from old.organization_id then
    if new.organization_id is not null then
      raise exception 'An applicant continuation grant cannot change organization'
        using errcode = '23514';
    end if;
    new.revoked_at := coalesce(old.revoked_at, new.revoked_at, statement_timestamp());
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_form_applicant_continuation_detachment() from public;

drop trigger if exists form_applicant_continuation_detachment_guard
  on public.form_applicant_continuation;
create trigger form_applicant_continuation_detachment_guard
before update of organization_id, revoked_at
on public.form_applicant_continuation
for each row execute function public.enforce_form_applicant_continuation_detachment();

alter table public.form_applicant_continuation
  drop constraint if exists form_applicant_continuation_detached_revoked_check;
alter table public.form_applicant_continuation
  add constraint form_applicant_continuation_detached_revoked_check
  check (organization_id is not null or revoked_at is not null);

alter table public.form_applicant_continuation
  drop constraint if exists form_applicant_continuation_organization_id_fkey;
alter table public.form_applicant_continuation
  add constraint form_applicant_continuation_organization_id_fkey
  foreign key (organization_id) references public.organization(id) on delete set null;

create or replace function public.bind_form_applicant_continuation(
  p_grant_id uuid, p_tenant_id uuid, p_form_id uuid, p_submission_id uuid, p_digest text
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.form_applicant_continuation g set
    submission_id = p_submission_id, bound_at = coalesce(bound_at, now())
  where g.id = p_grant_id and g.tenant_id = p_tenant_id and g.form_id = p_form_id
    and g.organization_id is not null
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
    and organization_id is not null
    and revoked_at is null and expires_at > now();
  return found;
end;
$$;
revoke all on function public.bind_form_applicant_draft(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_form_applicant_draft(uuid, uuid, text) to service_role;