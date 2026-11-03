-- auth.role() supports both modern PostgREST request.jwt.claims and legacy
-- request.jwt.claim.role. SECURITY DEFINER current_user is the function owner,
-- so it cannot identify the API caller's service role by itself.
DO $repair$
DECLARE
  definition text;
  old_guard constant text := 'COALESCE(current_setting(''request.jwt.claim.role'', true), '''') <> ''service_role''';
  new_guard constant text := 'COALESCE(auth.role(), '''') <> ''service_role''';
BEGIN
  SELECT pg_get_functiondef('public.replace_attendance_report_snapshot(uuid,text,text,jsonb)'::regprocedure)
    INTO definition;
  IF strpos(definition,old_guard)>0 THEN
    IF (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard) <> 1 THEN
      RAISE EXCEPTION 'Unexpected attendance snapshot authorization contract';
    END IF;
    EXECUTE replace(definition,old_guard,new_guard);
  ELSIF strpos(definition,new_guard)=0 THEN
    RAISE EXCEPTION 'Attendance snapshot authorization differs from reviewed contract';
  END IF;
END
$repair$;

REVOKE ALL ON FUNCTION public.replace_attendance_report_snapshot(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_attendance_report_snapshot(uuid,text,text,jsonb) TO service_role;
