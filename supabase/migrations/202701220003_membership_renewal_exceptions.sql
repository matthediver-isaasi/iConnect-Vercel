BEGIN;
CREATE TABLE public.membership_renewal_exceptions(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 revision bigint NOT NULL CHECK(revision>0),
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='array'),
 updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.membership_renewal_exceptions_history(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),revision bigint NOT NULL,
 rules jsonb NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE public.membership_renewal_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_renewal_exceptions_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_renewal_exceptions,public.membership_renewal_exceptions_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_renewal_exceptions,public.membership_renewal_exceptions_history TO service_role;
CREATE POLICY renewal_exceptions_read ON public.membership_renewal_exceptions FOR SELECT TO service_role USING(true);
CREATE POLICY renewal_exceptions_history_read ON public.membership_renewal_exceptions_history FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.save_membership_renewal_exceptions(p_tenant_id uuid,p_actor text,p_expected_revision bigint,p_rules jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; prior bigint; result public.membership_renewal_exceptions;
BEGIN
 IF nullif(trim(p_actor),'') IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0
   OR jsonb_typeof(p_rules) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rules)>100 THEN
   RAISE EXCEPTION 'Invalid renewal exceptions' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('renewal-exceptions:'||p_tenant_id::text,0));
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant unavailable'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
   IF jsonb_typeof(r)<>'object' OR coalesce(r->>'matchType','') NOT IN ('role','membership_class')
     OR coalesce(r->>'route','') NOT IN ('same_schedule','questionnaire')
     OR jsonb_typeof(r->'restrictToClass') IS DISTINCT FROM 'boolean'
     OR coalesce(r->>'id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN
       ('id','matchType','roleId','fieldId','classValue','route','formId','restrictToClass')) THEN
     RAISE EXCEPTION 'Choose a valid match and renewal route' USING ERRCODE='22023'; END IF;
   IF r->>'matchType'='role' THEN
     PERFORM 1 FROM public.role WHERE tenant_id=p_tenant_id AND id=(r->>'roleId')::uuid;
     IF NOT FOUND OR r->>'fieldId' IS NOT NULL OR r->>'classValue' IS NOT NULL THEN
       RAISE EXCEPTION 'Choose a role from this tenant' USING ERRCODE='22023'; END IF;
   ELSE
     PERFORM 1 FROM public.membership_tier_config c JOIN public.preference_field f ON f.id=c.structure_field_id
       WHERE c.tenant_id=p_tenant_id AND f.tenant_id=p_tenant_id AND f.entity_scope='member'
         AND c.structure_scope_type='member' AND c.structure_field_id=(r->>'fieldId')::uuid
         AND c.structure_match_value=r->>'classValue';
     IF NOT FOUND OR r->>'roleId' IS NOT NULL THEN
       RAISE EXCEPTION 'Choose an existing membership class from this tenant' USING ERRCODE='22023'; END IF;
   END IF;
   IF r->>'route'='questionnaire' OR r->>'formId' IS NOT NULL THEN
     PERFORM 1 FROM public.form WHERE tenant_id=p_tenant_id AND id=(r->>'formId')::uuid
       AND is_active AND require_authentication AND archived_at IS NULL
       AND (deactivate_at IS NULL OR deactivate_at>now()) AND coalesce(form_type,'standard')='standard'
       AND nullif(trim(slug),'') IS NOT NULL;
     IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active form requiring login' USING ERRCODE='22023'; END IF;
   END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) x GROUP BY x->>'id' HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) x
   GROUP BY x->>'matchType',x->>'roleId',x->>'fieldId',x->>'classValue' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Remove duplicate renewal exceptions' USING ERRCODE='22023'; END IF;
 SELECT revision INTO prior FROM public.membership_renewal_exceptions WHERE tenant_id=p_tenant_id;
 IF coalesce(prior,0)<>p_expected_revision THEN RAISE EXCEPTION 'Settings changed. Reload before saving' USING ERRCODE='40001'; END IF;
 INSERT INTO public.membership_renewal_exceptions(tenant_id,revision,rules,updated_by)
 VALUES(p_tenant_id,coalesce(prior,0)+1,p_rules,p_actor)
 ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,rules=excluded.rules,updated_by=excluded.updated_by,updated_at=now()
 RETURNING * INTO result;
 INSERT INTO public.membership_renewal_exceptions_history(tenant_id,revision,rules,actor)
 VALUES(p_tenant_id,result.revision,p_rules,p_actor);
 RETURN to_jsonb(result);
END $$;

CREATE FUNCTION public.resolve_membership_renewal_exception(p_tenant_id uuid,p_member_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rules jsonb; owner public.member; h public.member_membership_history; c jsonb; matches jsonb; matched jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('renewal-exceptions:'||p_tenant_id::text,0));
 SELECT e.rules INTO rules FROM public.membership_renewal_exceptions e WHERE e.tenant_id=p_tenant_id;
 IF rules IS NULL OR jsonb_array_length(rules)=0 THEN RETURN NULL; END IF;
 SELECT * INTO owner FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id;
 IF owner.id IS NULL THEN RAISE EXCEPTION 'Membership owner unavailable'; END IF;
 -- Purchase evidence, not mutable form answers or the current Former role.
 SELECT * INTO h FROM public.member_membership_history
 WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND payment_status='paid'
   AND status NOT IN ('cancelled','canceled','voided','expired_checkout','replaced','cancelled_by_request')
   AND (term_start_date IS NULL OR term_start_date<=current_date)
 ORDER BY term_end_date DESC NULLS LAST,id LIMIT 1;
 IF h.id IS NOT NULL THEN
   c:=coalesce(h.renewal_policy_snapshot,h.commitment_snapshot->'config',h.incentive_snapshot->'config');
   IF c IS NULL AND h.config_id IS NOT NULL THEN
     SELECT to_jsonb(x) INTO c FROM public.membership_tier_config x WHERE id=h.config_id AND tenant_id=p_tenant_id;
   END IF;
   IF c->>'tenant_id' IS DISTINCT FROM p_tenant_id::text THEN c:=NULL; END IF;
 END IF;
 SELECT jsonb_agg(r) INTO matches FROM jsonb_array_elements(rules) r
 WHERE (r->>'matchType'='role' AND r->>'roleId'=owner.role_id::text)
   OR (r->>'matchType'='membership_class' AND r->>'fieldId'=c->>'structure_field_id'
     AND r->>'classValue'=c->>'structure_match_value');
 IF matches IS NULL THEN RETURN NULL; END IF;
 IF jsonb_array_length(matches)>1 THEN RAISE EXCEPTION 'Conflicting renewal exceptions require administrator review'; END IF;
 matched:=matches->0;
 IF (matched->>'restrictToClass')::boolean AND (c->>'structure_field_id' IS NULL OR nullif(c->>'structure_match_value','') IS NULL) THEN
   RAISE EXCEPTION 'Previous membership class requires administrator review'; END IF;
 RETURN matched||jsonb_build_object('purchasedFieldId',c->>'structure_field_id','purchasedClassValue',c->>'structure_match_value');
END $$;

CREATE FUNCTION public.guard_renewal_exception_checkout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rule jsonb; target uuid; cfg public.membership_tier_config; r jsonb:=to_jsonb(NEW);
BEGIN
 IF r->>'organization_id' IS NOT NULL OR r->>'member_id' IS NULL THEN RETURN NEW; END IF;
 rule:=public.resolve_membership_renewal_exception(NEW.tenant_id,(r->>'member_id')::uuid);
 IF rule IS NULL OR NOT (rule->>'restrictToClass')::boolean THEN RETURN NEW; END IF;
 -- An existing authorised payment must still settle against its frozen terms.
 -- These inserts cannot rewrite its config/owner: existing commitment guards
 -- independently enforce matching agreement/quote ownership and economics.
 IF TG_TABLE_NAME='member_membership_history'
   AND (r->>'membership_payment_quote_id' IS NOT NULL OR r->>'billing_agreement_id' IS NOT NULL) THEN RETURN NEW; END IF;
 target:=coalesce(r#>>'{quote,simResult,config,id}',r#>>'{quote,simulation,config,id}',
   r#>>'{quote,snapshot,config,id}',r#>>'{quote,snapshot,config_id}',
   r#>>'{quote,snapshot,config_snapshot,id}',r#>>'{quote,snapshot,commitment,commitment_snapshot,config_id}',
   r->>'config_id',r#>>'{metadata,card,config_id}',r#>>'{metadata,dd,config_id}',
   r#>>'{commitment_snapshot,config_id}')::uuid;
 SELECT * INTO cfg FROM public.membership_tier_config WHERE tenant_id=NEW.tenant_id AND id=target;
 IF cfg.id IS NULL OR cfg.structure_scope_type IS DISTINCT FROM 'member'
   OR cfg.structure_field_id::text IS DISTINCT FROM rule->>'purchasedFieldId'
   OR cfg.structure_match_value IS DISTINCT FROM rule->>'purchasedClassValue' THEN
   RAISE EXCEPTION 'Your membership must renew in its existing category. Please use your renewal link or contact the membership team.' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER renewal_exception_quote BEFORE INSERT ON public.membership_payment_quote FOR EACH ROW EXECUTE FUNCTION public.guard_renewal_exception_checkout();
CREATE TRIGGER renewal_exception_successor BEFORE INSERT ON public.membership_successor_election FOR EACH ROW EXECUTE FUNCTION public.guard_renewal_exception_checkout();
CREATE TRIGGER renewal_exception_agreement BEFORE INSERT ON public.membership_billing_agreements FOR EACH ROW EXECUTE FUNCTION public.guard_renewal_exception_checkout();
CREATE TRIGGER renewal_exception_history BEFORE INSERT ON public.member_membership_history FOR EACH ROW EXECUTE FUNCTION public.guard_renewal_exception_checkout();
REVOKE ALL ON FUNCTION public.save_membership_renewal_exceptions(uuid,text,bigint,jsonb),
 public.resolve_membership_renewal_exception(uuid,uuid),public.guard_renewal_exception_checkout() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_renewal_exceptions(uuid,text,bigint,jsonb),
 public.resolve_membership_renewal_exception(uuid,uuid) TO service_role;
COMMIT;
