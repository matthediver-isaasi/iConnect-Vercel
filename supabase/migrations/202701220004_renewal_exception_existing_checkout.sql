-- Policy changes govern new elections/quotes, never rewrite an already
-- authorised purchase. Existing ownership/settlement guards remain in force.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_renewal_exception_checkout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rule jsonb; target uuid; cfg public.membership_tier_config;
 r jsonb:=to_jsonb(NEW); accepted jsonb; election text;
BEGIN
 IF r->>'organization_id' IS NOT NULL OR r->>'member_id' IS NULL THEN RETURN NEW; END IF;
 target:=coalesce(r#>>'{quote,simResult,config,id}',r#>>'{quote,simulation,config,id}',
   r#>>'{quote,snapshot,config,id}',r#>>'{quote,snapshot,config_id}',
   r#>>'{quote,snapshot,config_snapshot,id}',r#>>'{quote,snapshot,commitment,commitment_snapshot,config_id}',
   r->>'config_id',r#>>'{metadata,card,config_id}',r#>>'{metadata,dd,config_id}',
   r#>>'{commitment_snapshot,config_id}')::uuid;
 IF TG_TABLE_NAME='member_membership_history' THEN
   SELECT q.quote INTO accepted FROM public.membership_payment_quote q
   WHERE q.id::text=r->>'membership_payment_quote_id' AND q.tenant_id=NEW.tenant_id
     AND q.member_id::text=r->>'member_id' AND q.organization_id IS NULL;
   IF accepted#>>'{simResult,config,id}'=target::text THEN RETURN NEW; END IF;
   SELECT to_jsonb(a) INTO accepted FROM public.membership_billing_agreements a
   WHERE a.id::text=r->>'billing_agreement_id' AND a.tenant_id=NEW.tenant_id
     AND a.member_id::text=r->>'member_id' AND a.organization_id IS NULL;
   IF coalesce(accepted->>'config_id',accepted#>>'{metadata,card,config_id}',
     accepted#>>'{metadata,dd,config_id}',accepted#>>'{commitment_snapshot,config_id}')=target::text THEN RETURN NEW; END IF;
 END IF;
 election:=coalesce(r->>'membership_successor_election_id',r#>>'{quote,simResult,formRenewalElectionId}',
   r#>>'{metadata,membership_successor_election_id}',r#>>'{metadata,card,membership_successor_election_id}',
   r#>>'{metadata,dd,membership_successor_election_id}');
 IF TG_TABLE_NAME<>'membership_successor_election' AND election IS NOT NULL THEN
   SELECT e.quote INTO accepted FROM public.membership_successor_election e
   WHERE e.id::text=election AND e.tenant_id=NEW.tenant_id AND e.member_id::text=r->>'member_id'
     AND e.organization_id IS NULL;
   IF coalesce(accepted#>>'{simResult,config,id}',accepted#>>'{simulation,config,id}',
     accepted#>>'{snapshot,config,id}',accepted#>>'{snapshot,config_id}',
     accepted#>>'{snapshot,config_snapshot,id}')=target::text THEN RETURN NEW; END IF;
 END IF;
 rule:=public.resolve_membership_renewal_exception(NEW.tenant_id,(r->>'member_id')::uuid);
 IF rule IS NULL OR NOT (rule->>'restrictToClass')::boolean THEN RETURN NEW; END IF;
 SELECT * INTO cfg FROM public.membership_tier_config WHERE tenant_id=NEW.tenant_id AND id=target;
 IF cfg.id IS NULL OR cfg.structure_scope_type IS DISTINCT FROM 'member'
   OR cfg.structure_field_id::text IS DISTINCT FROM rule->>'purchasedFieldId'
   OR cfg.structure_match_value IS DISTINCT FROM rule->>'purchasedClassValue' THEN
   RAISE EXCEPTION 'Your membership must renew in its existing category. Please use your renewal link or contact the membership team.' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
