-- Optionally link a speaker profile to an existing tenant member.
ALTER TABLE public.speaker
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES public.member(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS speaker_tenant_member_unique
  ON public.speaker (tenant_id, member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_speaker_member_id
  ON public.speaker (member_id);

-- The single-column FK guarantees that the member exists and handles member
-- removal. This trigger additionally binds the relationship to the speaker's
-- tenant so service-role imports and future write paths cannot bypass the API's
-- tenant validation.
CREATE OR REPLACE FUNCTION public.enforce_speaker_member_same_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.member_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.id = NEW.member_id
      AND m.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Speaker member must belong to the same tenant'
      USING
        ERRCODE = '23503',
        CONSTRAINT = 'speaker_member_same_tenant';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS speaker_member_same_tenant_trigger ON public.speaker;

CREATE TRIGGER speaker_member_same_tenant_trigger
  BEFORE INSERT OR UPDATE OF tenant_id, member_id
  ON public.speaker
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_speaker_member_same_tenant();