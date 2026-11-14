BEGIN;
-- No recipient backfill. Historical modes and sent-email evidence are untouched.
ALTER TABLE public.email_campaign ADD COLUMN deliver_to_inbox_when_opted_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.email_campaign_recipient
  ADD COLUMN inbox_published_at timestamptz,
  ADD COLUMN inbox_subject text,
  ADD COLUMN inbox_html text;

CREATE FUNCTION public.guard_optional_campaign_inbox() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.deliver_to_inbox_when_opted_out IS DISTINCT FROM OLD.deliver_to_inbox_when_opted_out
    AND (OLD.status NOT IN ('draft','scheduled') OR OLD.preparation_generation IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.email_campaign_recipient WHERE campaign_id=OLD.id)) THEN
    RAISE EXCEPTION 'Inbox delivery option is locked after preparation begins';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optional_campaign_inbox_lock BEFORE UPDATE ON public.email_campaign
FOR EACH ROW EXECUTE FUNCTION public.guard_optional_campaign_inbox();
REVOKE ALL ON FUNCTION public.guard_optional_campaign_inbox() FROM PUBLIC,anon,authenticated;

-- Extend the current checkpoint function in place, failing closed if its
-- reviewed consent contract has changed. Retain all other generation fencing.
DO $$
DECLARE source text; changed text;
BEGIN
  source:=pg_get_functiondef('public.campaign_preparation_step(uuid,uuid,text,jsonb)'::regprocedure);
  changed:=replace(source,
    'bypass:=coalesce((r->>''bypass_opt_out'')::boolean,false);',
    'bypass:=coalesce((r->>''bypass_opt_out'')::boolean,false) AND coalesce((p.snapshot->>''deliver_to_inbox_when_opted_out'')::boolean,false)=false;');
  IF changed=source THEN RAISE EXCEPTION 'Preparation bypass contract changed'; END IF;
  source:=changed;
  changed:=replace(source,
    'if not eligible then discarded:=discarded+1;',
    'if coalesce((p.snapshot->>''deliver_to_inbox_when_opted_out'')::boolean,false) and
        exists(select 1 from member m where m.tenant_id=p.tenant_id
          and lower(btrim(m.email))=lower(btrim(r->>''email'')) and m.communications_opted_out_all is true)
       then eligible:=false; end if;
     if not eligible then discarded:=discarded+1;');
  IF changed=source THEN RAISE EXCEPTION 'Preparation address consent contract changed'; END IF;
  source:=changed;
  changed:=replace(source,
    'if not eligible then discarded:=discarded+1; delete from campaign_preparation_candidate where generation=p.id and ordinal=candidate.ordinal;',
    'if not eligible and coalesce((p.snapshot->>''deliver_to_inbox_when_opted_out'')::boolean,false)
       and member_key is not null then
       update campaign_preparation_candidate set recipient=recipient||''{"inbox_only":true,"bypass_opt_out":false}''::jsonb
         where generation=p.id and ordinal=candidate.ordinal;
       p.has_consent_checks:=true;
     elsif not eligible then discarded:=discarded+1; delete from campaign_preparation_candidate where generation=p.id and ordinal=candidate.ordinal;');
  IF changed=source THEN RAISE EXCEPTION 'Preparation global consent contract changed'; END IF;
  source:=changed;
  changed:=replace(source,
    'if eligible then
          insert into campaign_preparation_recipient',
    'if coalesce((p.snapshot->>''deliver_to_inbox_when_opted_out'')::boolean,false)
           and category_key is not null and exists(
             select 1 from member m where m.tenant_id=p.tenant_id
               and lower(btrim(m.email))=lower(btrim(r->>''email''))
               and (m.login_enabled is false or not exists(
                 select 1 from member_communication_preference mp where mp.tenant_id=p.tenant_id
                   and mp.member_id=m.id and mp.category_id=category_key and mp.is_subscribed is true)))
           then eligible:=false; end if;
         if coalesce((p.snapshot->>''deliver_to_inbox_when_opted_out'')::boolean,false)
           and member_key is not null and (not eligible or coalesce((r->>''inbox_only'')::boolean,false)) then
           r:=r||''{"inbox_only":true,"bypass_opt_out":false}''::jsonb;
           eligible:=true;
         end if;
         if eligible then
          insert into campaign_preparation_recipient');
  IF changed=source THEN RAISE EXCEPTION 'Preparation category consent contract changed'; END IF;
  EXECUTE changed;
END $$;

CREATE FUNCTION public.publish_campaign_inbox_only(
  p_campaign uuid,p_tenant uuid,p_recipient uuid,p_subject text,p_html text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_campaign; r public.email_campaign_recipient;
BEGIN
  SELECT * INTO c FROM public.email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR c.deliver_to_inbox_when_opted_out IS NOT TRUE THEN RAISE EXCEPTION 'Invalid inbox campaign'; END IF;
  SELECT * INTO r FROM public.email_campaign_recipient WHERE id=p_recipient AND campaign_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient not found'; END IF;
  IF r.inbox_published_at IS NOT NULL THEN RETURN true; END IF;
  IF c.status<>'sending' OR c.is_test_mode IS TRUE OR c.archived_at IS NOT NULL
    OR r.status<>'processing' OR r.sent_at IS NOT NULL OR r.mailgun_message_id IS NOT NULL
    OR r.delivery_is_test IS NOT NULL OR r.member_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.member m WHERE m.id=r.member_id AND m.tenant_id=p_tenant
      AND lower(btrim(m.email))=lower(btrim(r.email)) AND m.login_enabled IS DISTINCT FROM false)
    OR p_html IS NULL OR p_subject IS NULL THEN RAISE EXCEPTION 'Inbox publication not permitted'; END IF;
  PERFORM set_config('iconnect.inbox_publication_recipient',r.id::text,true);
  UPDATE public.email_campaign_recipient SET inbox_published_at=clock_timestamp(),
    inbox_subject=p_subject,inbox_html=p_html,status='unsubscribed',
    error_message='Email excluded by consent; published to member inbox'
    WHERE id=r.id;
  -- Survey entitlements were prepared for this exact attendee. Acceptance here
  -- denotes delivery of the invitation, not provider acceptance or sent email.
  UPDATE public.campaign_survey_delivery SET status='accepted',resolved_at=clock_timestamp()
    WHERE campaign_recipient_id=r.id AND campaign_id=c.id AND tenant_id=p_tenant AND status='pending';
  PERFORM set_config('iconnect.inbox_publication_recipient','',true);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publish_campaign_inbox_only(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_campaign_inbox_only(uuid,uuid,uuid,text,text) TO service_role;

CREATE FUNCTION public.guard_campaign_inbox_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.inbox_published_at IS NOT NULL AND
    (TG_OP='INSERT' OR OLD.inbox_published_at IS NULL) AND
    current_setting('iconnect.inbox_publication_recipient',true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'Inbox publication requires the publication authority';
  END IF;
  IF TG_OP='UPDATE' AND OLD.inbox_published_at IS NOT NULL AND
    (NEW.inbox_published_at IS DISTINCT FROM OLD.inbox_published_at
      OR NEW.inbox_html IS DISTINCT FROM OLD.inbox_html OR NEW.inbox_subject IS DISTINCT FROM OLD.inbox_subject
      OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.sent_at IS NOT NULL OR NEW.mailgun_message_id IS NOT NULL OR NEW.delivery_is_test IS NOT NULL) THEN
    RAISE EXCEPTION 'Inbox-only publication is immutable and cannot become email';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_inbox_evidence_immutable BEFORE INSERT OR UPDATE ON public.email_campaign_recipient
FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_inbox_evidence();
REVOKE ALL ON FUNCTION public.guard_campaign_inbox_evidence() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE VIEW public.campaign_inbox_recipient WITH (security_invoker=true) AS
SELECT r.* FROM public.email_campaign_recipient r
WHERE (r.sent_at IS NOT NULL AND r.delivery_is_test IS FALSE)
 OR (r.inbox_published_at IS NOT NULL AND r.member_id IS NOT NULL AND r.inbox_html IS NOT NULL
   AND r.sent_at IS NULL AND r.mailgun_message_id IS NULL AND r.delivery_is_test IS NULL);
REVOKE ALL ON public.campaign_inbox_recipient FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.campaign_inbox_recipient TO service_role;

CREATE OR REPLACE FUNCTION public.campaign_inbox_unread_summary(p_tenant uuid,p_member uuid)
RETURNS TABLE(unread_count bigint,latest_subject text,latest_recipient_id uuid,latest_sent_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 WITH unread AS MATERIALIZED (
  SELECT r.id,coalesce(r.inbox_published_at,r.sent_at) AS sent_at,coalesce(r.inbox_subject,c.subject) AS subject
  FROM public.campaign_inbox_recipient r JOIN public.email_campaign c ON c.id=r.campaign_id
  WHERE r.member_id=p_member AND c.tenant_id=p_tenant AND NOT EXISTS(
    SELECT 1 FROM public.member_inbox_message_state s WHERE s.recipient_id=r.id
    AND s.member_id=p_member AND s.tenant_id=p_tenant AND (s.is_read IS TRUE OR s.is_archived IS TRUE))
 )
 SELECT (SELECT count(*) FROM unread),latest.subject,latest.id,latest.sent_at
 FROM (SELECT 1) seed LEFT JOIN LATERAL (
  SELECT subject,id,sent_at FROM unread ORDER BY sent_at DESC,id LIMIT 1
 ) latest ON true;
$$;
REVOKE ALL ON FUNCTION public.campaign_inbox_unread_summary(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_inbox_unread_summary(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
