BEGIN;
-- Keep lifecycle validation aligned with the ownership authority. These are
-- narrow replacements of reviewed predicates, never of award evidence.
DO $$
DECLARE change record; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('public.validate_manual_cpd_award()',
      'NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=NEW.tenant_id AND id=NEW.member_id)',
      'NOT public.cpd_member_belongs_to_tenant(NEW.member_id,NEW.tenant_id)'),
    ('public.record_manual_cpd_award(uuid,uuid,uuid,numeric,text,date,text,jsonb)',
      'NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id)',
      'NOT public.cpd_member_belongs_to_tenant(p_member_id,p_tenant_id)'),
    ('public.validate_historical_cpd_points_entry()',
      'NOT EXISTS (SELECT 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id)',
      'NOT public.cpd_member_belongs_to_tenant(NEW.member_id,NEW.tenant_id)'),
    ('public.record_event_cpd_points_award(jsonb)',
      'AND b->>''member_id'' IN(award.member_id::text,award.effective_member_id::text)',
      'AND award.effective_member_id IS NOT NULL /* immutable award binds attendee, not booking purchaser */')
  ) AS changes(signature,old_fragment,new_fragment)
  LOOP
    SELECT pg_get_functiondef(change.signature::regprocedure) INTO definition;
    IF strpos(definition,change.old_fragment)>0 THEN
      EXECUTE replace(definition,change.old_fragment,change.new_fragment);
    ELSIF strpos(definition,change.new_fragment)=0 THEN
      RAISE EXCEPTION 'Unexpected CPD lifecycle definition: %',change.signature;
    END IF;
  END LOOP;
END $$;
COMMIT;
