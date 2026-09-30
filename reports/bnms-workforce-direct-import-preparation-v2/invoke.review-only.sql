-- REVIEW ONLY. Do not execute without separately recorded final approval.
-- In the same transaction, an authorized service-role operator must SET LOCAL
-- bnms.final_import_approval to <source SHA>:<reviewed manifest SHA>. This file does not set it.
-- Use only verified destination lvmzliemqnieeoruhkik.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT public.import_bnms_workforce_direct_occurrences();
COMMIT;
