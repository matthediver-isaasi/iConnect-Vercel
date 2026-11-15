BEGIN;

-- Retain the old columns/rows as read-only rollout history. New readers use
-- only event assignments; no public organisation fields are inherited.
ALTER TABLE public.event_sponsor ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.event_sponsor_category
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS event_type varchar(20),
  ADD COLUMN IF NOT EXISTS legacy_category_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_category_legacy_event
  ON public.event_sponsor_category(tenant_id,event_id,event_type,legacy_category_id);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_category_event_identity
  ON public.event_sponsor_category(id,tenant_id,event_id,event_type);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_tenant_identity ON public.event_sponsor(id,tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_organization_tenant_identity ON public.organization(id,tenant_id);

-- Preserve assignment categories first, filling previously implicit categories
-- once, during migration only. An explicit NULL after migration means no category.
INSERT INTO public.event_sponsor_category(tenant_id,event_id,event_type,legacy_category_id,name,display_order)
SELECT DISTINCT a.tenant_id,a.event_id,a.event_type,c.id,c.name,c.display_order
FROM public.event_sponsor_assignment a
JOIN public.event_sponsor_category c ON c.tenant_id=a.tenant_id AND c.event_id IS NULL
ON CONFLICT (tenant_id,event_id,event_type,legacy_category_id) DO NOTHING;

UPDATE public.event_sponsor_assignment a
SET category_id=c.id
FROM public.event_sponsor s, public.event_sponsor_category c
WHERE s.id=a.sponsor_id AND s.tenant_id=a.tenant_id
 AND c.tenant_id=a.tenant_id AND c.event_id=a.event_id AND c.event_type=a.event_type
 AND c.legacy_category_id=coalesce(a.category_id,s.category_id);

ALTER TABLE public.event_sponsor
 ADD CONSTRAINT sponsor_organization_same_tenant FOREIGN KEY(organization_id,tenant_id)
 REFERENCES public.organization(id,tenant_id);
ALTER TABLE public.event_sponsor_category
 ADD CONSTRAINT sponsor_category_event_scope CHECK(
 (event_id IS NULL AND event_type IS NULL) OR
 (event_id IS NOT NULL AND event_type IS NOT NULL AND event_type IN ('simple','complex')));
ALTER TABLE public.event_sponsor_assignment
 ADD CONSTRAINT sponsor_assignment_same_tenant FOREIGN KEY(sponsor_id,tenant_id)
 REFERENCES public.event_sponsor(id,tenant_id) ON DELETE CASCADE,
 ADD CONSTRAINT sponsor_assignment_category_scope FOREIGN KEY(category_id,tenant_id,event_id,event_type)
 REFERENCES public.event_sponsor_category(id,tenant_id,event_id,event_type);

CREATE OR REPLACE FUNCTION public.guard_event_sponsor_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE mapped uuid;
BEGIN
 IF TG_TABLE_NAME='event_sponsor' THEN
   IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
     RAISE EXCEPTION 'Sponsor tenant cannot be changed' USING ERRCODE='23514';
   END IF;
   IF (TG_OP='INSERT' AND NEW.category_id IS NOT NULL) OR
      (TG_OP='UPDATE' AND NEW.category_id IS DISTINCT FROM OLD.category_id AND NEW.category_id IS NOT NULL) THEN
     RAISE EXCEPTION 'Select sponsor categories on the event, not the sponsor' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.event_id,NEW.event_type)
      IS DISTINCT FROM (OLD.tenant_id,OLD.event_id,OLD.event_type) THEN
   RAISE EXCEPTION 'Sponsor event scope cannot be changed' USING ERRCODE='23514';
 END IF;
 IF NEW.event_id IS NULL OR NEW.event_type IS NULL OR NEW.event_type NOT IN ('simple','complex') THEN
   RAISE EXCEPTION 'Save the event before configuring sponsor categories' USING ERRCODE='23514';
 END IF;
 IF NEW.event_type='simple' THEN
   PERFORM 1 FROM public.event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id FOR KEY SHARE;
 ELSE
   PERFORM 1 FROM public.complex_event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id FOR KEY SHARE;
 END IF;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Sponsor event is unavailable in this tenant' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME='event_sponsor_category' THEN
   IF TG_OP='INSERT' AND NEW.legacy_category_id IS NOT NULL THEN
     RAISE EXCEPTION 'Legacy sponsor category provenance is read only' USING ERRCODE='23514';
   ELSIF TG_OP='UPDATE' AND NEW.legacy_category_id IS DISTINCT FROM OLD.legacy_category_id THEN
     RAISE EXCEPTION 'Legacy sponsor category provenance is read only' USING ERRCODE='23514';
   END IF;
 ELSIF NEW.category_id IS NOT NULL THEN
   -- During rolling deployment an old editor may post its old category ID.
   -- Resolve only an already-migrated copy for this exact event and tenant.
   SELECT id INTO mapped FROM public.event_sponsor_category
     WHERE tenant_id=NEW.tenant_id AND event_id=NEW.event_id AND event_type=NEW.event_type
       AND legacy_category_id=NEW.category_id;
   IF FOUND THEN NEW.category_id:=mapped; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_event_sponsor_scope() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER event_sponsor_scope_guard BEFORE INSERT OR UPDATE ON public.event_sponsor
 FOR EACH ROW EXECUTE FUNCTION public.guard_event_sponsor_scope();
CREATE TRIGGER event_sponsor_category_scope_guard BEFORE INSERT OR UPDATE ON public.event_sponsor_category
 FOR EACH ROW EXECUTE FUNCTION public.guard_event_sponsor_scope();
CREATE TRIGGER event_sponsor_assignment_scope_guard BEFORE INSERT OR UPDATE ON public.event_sponsor_assignment
 FOR EACH ROW EXECUTE FUNCTION public.guard_event_sponsor_scope();

-- The polymorphic event reference cannot be an ordinary FK. Clean children
-- while the parent still exists, including failure cleanup after duplication.
CREATE OR REPLACE FUNCTION public.delete_event_sponsor_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text:=CASE WHEN TG_TABLE_NAME='event' THEN 'simple' ELSE 'complex' END;
BEGIN
 DELETE FROM public.event_sponsor_assignment WHERE tenant_id=OLD.tenant_id AND event_id=OLD.id AND event_type=kind;
 DELETE FROM public.event_sponsor_category WHERE tenant_id=OLD.tenant_id AND event_id=OLD.id AND event_type=kind;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.delete_event_sponsor_scope() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER delete_event_sponsor_scope BEFORE DELETE ON public.event
 FOR EACH ROW EXECUTE FUNCTION public.delete_event_sponsor_scope();
CREATE TRIGGER delete_complex_event_sponsor_scope BEFORE DELETE ON public.complex_event
 FOR EACH ROW EXECUTE FUNCTION public.delete_event_sponsor_scope();
NOTIFY pgrst,'reload schema';
COMMIT;
