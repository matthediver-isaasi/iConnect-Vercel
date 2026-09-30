-- REVIEW ONLY. Do not execute without separately recorded final import approval.
-- After approval, an authorized operator sets bnms.final_import_approval to
-- <source SHA>:<reviewed manifest SHA> in their session. This file does NOT set approval.
-- Use only the verified destination lvmzliemqnieeoruhkik, never SOURCE/runtime DB.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT public.import_bnms_workforce_occurrences();
COMMIT;
