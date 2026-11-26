-- Reformat retained signed-agreement PDFs without losing the original.
--
-- Adds an append-only history of superseded final PDFs and a service-only RPC
-- which, in one locked transaction, records the original path + SHA-256 and
-- switches the envelope to a newly rendered file. The guard on
-- sales_agreement_envelope still rejects every other change to a completed
-- agreement: only final_pdf_path/final_pdf_hash may change, and only when a
-- matching history row was written by the same transaction. Signed snapshot,
-- signatures, evidence and document_hash remain immutable. Storage objects are
-- never deleted or overwritten by this migration or its RPC.
--
-- Fails closed if the installed guard is not the reviewed definition.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $preflight$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.guard_sales_agreement_envelope()'::regprocedure) INTO definition;
 IF position('Final agreement artifact is immutable' IN definition)=0 THEN
   RAISE EXCEPTION 'Unexpected guard_sales_agreement_envelope definition; review before applying';
 END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.sales_agreement_final_pdf_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 envelope_id uuid NOT NULL REFERENCES public.sales_agreement_envelope(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL,
 superseded_path text NOT NULL,
 superseded_hash text NOT NULL CHECK (superseded_hash ~ '^[0-9a-f]{64}$'),
 superseded_finalized_at timestamptz,
 replacement_path text NOT NULL,
 replacement_hash text NOT NULL CHECK (replacement_hash ~ '^[0-9a-f]{64}$'),
 layout text NOT NULL CHECK (length(btrim(layout)) BETWEEN 1 AND 100),
 superseded_at timestamptz NOT NULL DEFAULT now(),
 transaction_id bigint NOT NULL DEFAULT txid_current(),
 CHECK (superseded_path <> replacement_path),
 UNIQUE (envelope_id, replacement_path)
);
CREATE INDEX IF NOT EXISTS sales_agreement_final_pdf_history_envelope_idx
 ON public.sales_agreement_final_pdf_history(envelope_id, superseded_at);
ALTER TABLE public.sales_agreement_final_pdf_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_agreement_final_pdf_history FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sales_agreement_final_pdf_history TO service_role;
DROP POLICY IF EXISTS sales_agreement_final_pdf_history_service_read ON public.sales_agreement_final_pdf_history;
CREATE POLICY sales_agreement_final_pdf_history_service_read ON public.sales_agreement_final_pdf_history
 FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.guard_sales_agreement_final_pdf_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Superseded agreement PDF history is append-only' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS sales_agreement_final_pdf_history_immutable ON public.sales_agreement_final_pdf_history;
CREATE TRIGGER sales_agreement_final_pdf_history_immutable BEFORE UPDATE OR DELETE ON public.sales_agreement_final_pdf_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_agreement_final_pdf_history();

CREATE OR REPLACE FUNCTION public.guard_sales_agreement_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v public.sales_quote_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agreement evidence cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id FOR UPDATE;
   IF v.id IS NULL OR v.quote_id<>NEW.quote_id OR v.status NOT IN ('issued','sent')
     OR length(btrim(COALESCE(v.terms_snapshot->>'legalHtml','')))=0
     OR NOT EXISTS (SELECT 1 FROM public.sales_quote q WHERE q.id=v.quote_id AND q.current_version=v.version_number)
     OR NEW.snapshot->'version'->>'id' IS DISTINCT FROM v.id::text
     OR NEW.snapshot->'version'->'terms_snapshot' IS DISTINCT FROM v.terms_snapshot
   THEN RAISE EXCEPTION 'Agreement requires the current immutable issued quote' USING ERRCODE='23514'; END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['customer','customer_evidence','finalization_status','finalization_error','final_pdf_path','final_pdf_hash','finalized_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['customer','customer_evidence','finalization_status','finalization_error','final_pdf_path','final_pdf_hash','finalized_at']) THEN
   RAISE EXCEPTION 'Signed agreement snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.customer IS NOT NULL
    AND (NEW.customer IS DISTINCT FROM OLD.customer OR NEW.customer_evidence IS DISTINCT FROM OLD.customer_evidence) THEN
   RAISE EXCEPTION 'Customer signature evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.finalization_status='complete' AND NEW IS DISTINCT FROM OLD THEN
   -- Only a recorded presentation supersession may switch the retained file.
   IF (to_jsonb(NEW)-ARRAY['final_pdf_path','final_pdf_hash']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['final_pdf_path','final_pdf_hash'])
     OR NEW.final_pdf_path IS NULL OR NEW.final_pdf_hash IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.sales_agreement_final_pdf_history h
       WHERE h.envelope_id=OLD.id AND h.superseded_path=OLD.final_pdf_path AND h.superseded_hash=OLD.final_pdf_hash
         AND h.replacement_path=NEW.final_pdf_path AND h.replacement_hash=NEW.final_pdf_hash
         AND h.transaction_id=txid_current()) THEN
     RAISE EXCEPTION 'Final agreement artifact is immutable' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.supersede_sales_agreement_final_pdf(
 p_envelope_id uuid, p_expected_path text, p_expected_hash text, p_new_path text, p_new_hash text, p_layout text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.sales_agreement_envelope%ROWTYPE;
BEGIN
 IF p_new_hash IS NULL OR p_new_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid replacement hash' USING ERRCODE='22023'; END IF;
 IF p_layout IS NULL OR length(btrim(p_layout)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid layout' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM public.sales_agreement_envelope WHERE id=p_envelope_id FOR UPDATE;
 IF e.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF e.finalization_status<>'complete' THEN RETURN jsonb_build_object('ok',false,'reason','not_complete'); END IF;
 IF e.final_pdf_path=p_new_path AND e.final_pdf_hash=p_new_hash THEN
   RETURN jsonb_build_object('ok',true,'changed',false);
 END IF;
 IF e.final_pdf_path IS DISTINCT FROM p_expected_path OR e.final_pdf_hash IS DISTINCT FROM p_expected_hash THEN
   RETURN jsonb_build_object('ok',false,'reason','changed_concurrently');
 END IF;
 IF p_new_path IS NULL OR p_new_path=e.final_pdf_path
   OR left(p_new_path, length(e.tenant_id::text || '/' || e.id::text || '/'))<>e.tenant_id::text || '/' || e.id::text || '/' THEN
   RAISE EXCEPTION 'Replacement must be a new object in the agreement folder' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.sales_agreement_final_pdf_history(envelope_id,tenant_id,superseded_path,superseded_hash,
   superseded_finalized_at,replacement_path,replacement_hash,layout)
 VALUES(e.id,e.tenant_id,e.final_pdf_path,e.final_pdf_hash,e.finalized_at,p_new_path,p_new_hash,btrim(p_layout));
 UPDATE public.sales_agreement_envelope SET final_pdf_path=p_new_path, final_pdf_hash=p_new_hash WHERE id=e.id;
 RETURN jsonb_build_object('ok',true,'changed',true);
END $$;
REVOKE ALL ON FUNCTION public.supersede_sales_agreement_final_pdf(uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_sales_agreement_final_pdf(uuid,text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_sales_agreement_final_pdf_history() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
