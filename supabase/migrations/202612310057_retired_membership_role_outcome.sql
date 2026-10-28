BEGIN;
-- Keep the existing outcomes and allow the new source-purchase preservation
-- outcome. The previous function migration alone must not trip this CHECK.
ALTER TABLE public.membership_arrears_role_action
 DROP CONSTRAINT IF EXISTS membership_arrears_role_action_restoration_status_check;
ALTER TABLE public.membership_arrears_role_action
 ADD CONSTRAINT membership_arrears_role_action_restoration_status_check CHECK(
  restoration_status IS NULL OR restoration_status IN
   ('restored','manual_change_preserved','member_missing','retired_purchase_preserved')
 ) NOT VALID;
ALTER TABLE public.membership_arrears_role_action
 VALIDATE CONSTRAINT membership_arrears_role_action_restoration_status_check;
NOTIFY pgrst,'reload schema';
COMMIT;
