-- Journal routing is report configuration, never membership/payment authority.
-- Dedicated tenant primary key serializes first saves; revision CAS protects edits.
CREATE TABLE IF NOT EXISTS public.nmc_journal_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  printed_classes text[] NOT NULL,
  online_classes text[] NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (printed_classes && online_classes)),
  CHECK (array_position(printed_classes, NULL) IS NULL),
  CHECK (array_position(online_classes, NULL) IS NULL)
);
ALTER TABLE public.nmc_journal_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nmc_journal_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.nmc_journal_settings TO service_role;
NOTIFY pgrst, 'reload schema';
