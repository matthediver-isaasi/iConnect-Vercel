-- Historical evidence only. No provider hooks, live schedules or annual memberships.
-- The current authorization deliberately pins ONE member, not all BNMS.
CREATE TABLE IF NOT EXISTS public.bnms_dd_pilot_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL CHECK (tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE REFERENCES public.member(id) CHECK (member_id = '33e5d54d-162e-436d-9bff-ec6676d198f9'),
  structure_id uuid NOT NULL REFERENCES public.membership_tier_config(id) CHECK (structure_id = '07f35246-907a-411d-be78-2b3a9587ce3a'),
  mandate_id text NOT NULL UNIQUE CHECK (mandate_id = 'MD00330XE0B797'),
  customer_id text NOT NULL CHECK (customer_id = 'CU00426EF15CE5'),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  source text NOT NULL DEFAULT 'bnms_xero_history' CHECK (source = 'bnms_xero_history'),
  historical_only boolean NOT NULL DEFAULT true CHECK (historical_only),
  first_managed_collection date NOT NULL DEFAULT '2026-10-01' CHECK (first_managed_collection = '2026-10-01'),
  nominated_day integer NOT NULL DEFAULT 1 CHECK (nominated_day = 1),
  approved_monthly_amount_minor integer NOT NULL DEFAULT 1300 CHECK (approved_monthly_amount_minor = 1300),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, tenant_id, member_id)
);
CREATE TABLE IF NOT EXISTS public.bnms_dd_historical_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.bnms_dd_pilot_import(id),
  tenant_id uuid NOT NULL CHECK (tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL CHECK (member_id = '33e5d54d-162e-436d-9bff-ec6676d198f9'),
  period date NOT NULL CHECK (period >= '2026-01-01' AND period <= '2026-09-01' AND extract(day from period) = 1),
  charge_date date NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor = 1304),
  currency text NOT NULL CHECK (currency = 'GBP'),
  provider_payment_id text NOT NULL UNIQUE,
  provider_status text NOT NULL CHECK (provider_status = 'paid_out'),
  xero_invoice_id uuid NOT NULL UNIQUE,
  xero_invoice_number text NOT NULL,
  xero_payment_id uuid NOT NULL UNIQUE,
  historical_only boolean NOT NULL DEFAULT true CHECK (historical_only),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, member_id, period),
  FOREIGN KEY(import_id, tenant_id, member_id) REFERENCES public.bnms_dd_pilot_import(id, tenant_id, member_id)
);
CREATE OR REPLACE FUNCTION public.bnms_dd_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'BNMS historical import provenance is immutable; explicit reviewed repair migration required';
END $$;
DROP TRIGGER IF EXISTS bnms_dd_import_immutable ON public.bnms_dd_pilot_import;
CREATE TRIGGER bnms_dd_import_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_pilot_import
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
DROP TRIGGER IF EXISTS bnms_dd_history_immutable ON public.bnms_dd_historical_payment;
CREATE TRIGGER bnms_dd_history_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_historical_payment
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
ALTER TABLE public.bnms_dd_pilot_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bnms_dd_historical_payment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_pilot_import, public.bnms_dd_historical_payment FROM PUBLIC;
-- No client RLS policies: only authenticated tenant-filtered server reads.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.bnms_dd_pilot_import, public.bnms_dd_historical_payment FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.bnms_dd_pilot_import, public.bnms_dd_historical_payment FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.bnms_dd_pilot_import, public.bnms_dd_historical_payment FROM service_role;
    GRANT SELECT ON public.bnms_dd_pilot_import, public.bnms_dd_historical_payment TO service_role;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bnms_dd_verify_parent_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id)
    OR NOT EXISTS(SELECT 1 FROM membership_tier_config WHERE id=NEW.structure_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'BNMS historical member/structure tenant identity mismatch';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_import_identity ON public.bnms_dd_pilot_import;
CREATE TRIGGER bnms_dd_import_identity BEFORE INSERT ON public.bnms_dd_pilot_import
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_verify_parent_identity();
CREATE OR REPLACE FUNCTION public.bnms_dd_verify_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE parent_id uuid;
BEGIN
  IF TG_TABLE_NAME='bnms_dd_pilot_import' THEN
    parent_id := NEW.id;
  ELSE
    parent_id := NEW.import_id;
  END IF;
  IF (SELECT count(*) FROM bnms_dd_historical_payment WHERE import_id=parent_id) <> 9 THEN
    RAISE EXCEPTION 'BNMS historical import must contain exactly nine monthly records atomically';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_import_complete ON public.bnms_dd_pilot_import;
CREATE CONSTRAINT TRIGGER bnms_dd_import_complete AFTER INSERT ON public.bnms_dd_pilot_import
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_verify_complete();
DROP TRIGGER IF EXISTS bnms_dd_history_complete ON public.bnms_dd_historical_payment;
CREATE CONSTRAINT TRIGGER bnms_dd_history_complete AFTER INSERT ON public.bnms_dd_historical_payment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_verify_complete();
CREATE OR REPLACE FUNCTION public.bnms_dd_protect_canonical_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM bnms_dd_historical_payment WHERE provider_payment_id=NEW.gocardless_payment_id) THEN
    RAISE EXCEPTION 'Historical-only BNMS payment cannot enter the mutable payment ledger';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_no_historical_provider_replay ON public.gocardless_payments;
CREATE TRIGGER bnms_dd_no_historical_provider_replay BEFORE INSERT OR UPDATE ON public.gocardless_payments
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_protect_canonical_payment();
CREATE OR REPLACE FUNCTION public.bnms_dd_protect_canonical_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM bnms_dd_historical_payment
    WHERE xero_invoice_id::text IN (NEW.xero_invoice_id::text, NEW.accounting_invoice_id::text)) THEN
    RAISE EXCEPTION 'Historical-only BNMS invoice cannot enter the mutable membership ledger';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_no_historical_invoice_replay ON public.member_membership_history;
CREATE TRIGGER bnms_dd_no_historical_invoice_replay BEFORE INSERT OR UPDATE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_protect_canonical_invoice();