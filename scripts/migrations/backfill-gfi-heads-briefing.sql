-- One-time GFI correction. Default is a rollback rehearsal.
-- Run the WHOLE file in one connection. Never install as a migration or schedule.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SELECT pg_advisory_xact_lock(hashtextextended(tenant_id::text || ':' || lower(trim(email)),0))
FROM public.member
WHERE tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d'
  AND role_id='561682bb-57f2-4a61-89aa-c3c201692923'
ORDER BY lower(trim(email)),id;
LOCK TABLE public.tenant, public.role, public.communication_category,
  public.communication_category_role, public.member,
  public.member_communication_preference, public.email_unsubscribe
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $repair$
DECLARE
  t constant uuid := 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
  c constant uuid := 'b5a43d92-04f3-4e83-a0e5-fce00c678552';
  r constant uuid := '561682bb-57f2-4a61-89aa-c3c201692923';
  candidates uuid[];
  inserted jsonb;
  pref_before jsonb;
  ledger_before jsonb;
  member_before text;
  displayed_before integer;
  displayed_after integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=t AND slug='gfi')
    OR NOT EXISTS(SELECT 1 FROM role WHERE id=r AND tenant_id=t AND name='Head of Service')
    OR NOT EXISTS(SELECT 1 FROM communication_category WHERE id=c AND tenant_id=t
      AND name='Heads briefing' AND is_active AND member_enabled)
    OR (SELECT count(*) FROM communication_category_role WHERE category_id=c)<>1
    OR NOT EXISTS(SELECT 1 FROM communication_category_role WHERE category_id=c AND role_id=r AND tenant_id=t)
  THEN RAISE EXCEPTION 'Exact configuration changed'; END IF;

  IF EXISTS(SELECT 1 FROM member m JOIN member n ON n.tenant_id=m.tenant_id
      AND lower(trim(n.email))=lower(trim(m.email)) AND n.id<>m.id
      WHERE m.tenant_id=t AND m.role_id=r)
    OR EXISTS(SELECT 1 FROM member m JOIN email_unsubscribe u
      ON u.tenant_id=t AND lower(trim(u.email))=lower(trim(m.email))
      WHERE m.tenant_id=t AND m.role_id=r AND (
        (u.member_id IS NOT NULL AND u.member_id<>m.id)
        OR u.unsubscribe_type IS NULL OR u.unsubscribe_type NOT IN ('all','category')
        OR (u.unsubscribe_type='all' AND u.communication_category_id IS NOT NULL)
        OR (u.unsubscribe_type='category' AND u.communication_category_id IS NULL)))
    OR EXISTS(SELECT 1 FROM member m JOIN member_communication_preference p ON p.member_id=m.id
      WHERE m.tenant_id=t AND m.role_id=r AND p.category_id=c
        AND (p.tenant_id IS DISTINCT FROM t OR p.is_subscribed IS NULL))
  THEN RAISE EXCEPTION 'Ambiguous identity or consent'; END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO pref_before
    FROM member_communication_preference p WHERE tenant_id=t;
  SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') INTO ledger_before
    FROM email_unsubscribe u WHERE tenant_id=t;
  SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY id)) INTO member_before FROM member m WHERE tenant_id=t;
  SELECT count(*) INTO displayed_before FROM member m WHERE m.tenant_id=t
    AND coalesce(m.email,'')<>'' AND m.email !~* '^deleted_.*@deleted[.]local$'
    AND coalesce(to_jsonb(m)->>'lifecycle_state','') NOT IN ('archived','minimised','deleted')
    AND m.login_enabled IS DISTINCT FROM false AND m.communications_opted_out_all IS DISTINCT FROM true
    AND EXISTS(SELECT 1 FROM member_communication_preference p WHERE p.member_id=m.id AND p.tenant_id=t AND p.category_id=c AND p.is_subscribed=true);

  SELECT coalesce(array_agg(m.id ORDER BY m.id),'{}') INTO candidates FROM member m
    WHERE m.tenant_id=t AND m.role_id=r AND m.status='active'
      AND m.login_enabled IS DISTINCT FROM false AND m.membership_paused IS DISTINCT FROM true
      AND m.membership_cancelled IS DISTINCT FROM true
      AND m.communications_opted_out_all IS DISTINCT FROM true
      AND trim(m.email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      AND m.email !~* '^deleted_.*@deleted[.]local$'
      AND coalesce(to_jsonb(m)->>'lifecycle_state','') NOT IN ('archived','minimised','deleted')
      AND NOT EXISTS(SELECT 1 FROM member_communication_preference p WHERE p.member_id=m.id AND p.category_id=c)
      AND NOT EXISTS(SELECT 1 FROM email_unsubscribe u WHERE u.tenant_id=t
        AND lower(trim(u.email))=lower(trim(m.email))
        AND (u.unsubscribe_type='all' OR u.communication_category_id=c));
  -- Pins the reviewed population; zero is permitted only for idempotent replay.
  IF cardinality(candidates) NOT IN (0,189) THEN RAISE EXCEPTION 'Cohort changed; new preflight required'; END IF;
  IF cardinality(candidates)>0 AND md5(array_to_string(candidates,','))<>'f3e542051e51b58ac89d17d69f588f12'
    THEN RAISE EXCEPTION 'Exact reviewed member set changed'; END IF;
  WITH added AS (
    INSERT INTO member_communication_preference(tenant_id,member_id,category_id,is_subscribed)
    SELECT t,id,c,true FROM member WHERE tenant_id=t AND role_id=r AND id=ANY(candidates)
    ON CONFLICT(member_id,category_id) DO NOTHING
    RETURNING id,member_id,category_id,tenant_id,is_subscribed
  ) SELECT coalesce(jsonb_agg(to_jsonb(added) ORDER BY id),'[]') INTO inserted FROM added;
  IF jsonb_array_length(inserted)<>cardinality(candidates)
    OR pref_before IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]')
      FROM member_communication_preference p WHERE tenant_id=t
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inserted) i WHERE (i->>'id')::uuid=p.id))
    OR ledger_before IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM email_unsubscribe u WHERE tenant_id=t)
    OR member_before IS DISTINCT FROM (SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY id)) FROM member m WHERE tenant_id=t)
  THEN RAISE EXCEPTION 'Preservation verification failed'; END IF;
  SELECT count(*) INTO displayed_after FROM member m WHERE m.tenant_id=t
    AND coalesce(m.email,'')<>'' AND m.email !~* '^deleted_.*@deleted[.]local$'
    AND coalesce(to_jsonb(m)->>'lifecycle_state','') NOT IN ('archived','minimised','deleted')
    AND m.login_enabled IS DISTINCT FROM false AND m.communications_opted_out_all IS DISTINCT FROM true
    AND EXISTS(SELECT 1 FROM member_communication_preference p WHERE p.member_id=m.id AND p.tenant_id=t AND p.category_id=c AND p.is_subscribed=true);
  IF displayed_after<>displayed_before+cardinality(candidates) THEN RAISE EXCEPTION 'Displayed count mismatch'; END IF;
  PERFORM set_config('gfi.repair_result',jsonb_build_object('inserted',inserted,
    'added',cardinality(candidates),'displayedBefore',displayed_before,'displayedAfter',displayed_after,
    'preservedExistingPreferences',true,'preservedLedger',true,'preservedMembers',true)::text,true);
END;
$repair$;
SELECT current_setting('gfi.repair_result')::jsonb AS result;
ROLLBACK;
