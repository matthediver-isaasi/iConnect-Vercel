-- Preserve the installed atomic snapshot implementation and all its transition
-- semantics. Resolve only the collision with RETURNS TABLE(target_id ...).
DO $repair$
DECLARE
  definition text;
  constraint_name text;
  old_clause constant text := 'ON CONFLICT (tenant_id,provider,target_type,target_id)';
  new_clause text;
BEGIN
  SELECT c.conname INTO STRICT constraint_name
  FROM pg_constraint c
  WHERE c.conrelid='public.attendance_target'::regclass AND c.contype='u'
    AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
      FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
      = ARRAY['tenant_id','provider','target_type','target_id'];
  new_clause := format('ON CONFLICT ON CONSTRAINT %I',constraint_name);
  SELECT pg_get_functiondef('public.replace_attendance_report_snapshot(uuid,text,text,jsonb)'::regprocedure)
    INTO definition;
  IF strpos(definition,old_clause)>0 THEN
    IF (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause) <> 1 THEN
      RAISE EXCEPTION 'Unexpected attendance snapshot conflict contract';
    END IF;
    EXECUTE replace(definition,old_clause,new_clause);
  ELSIF strpos(definition,new_clause)=0 THEN
    RAISE EXCEPTION 'Attendance snapshot implementation differs from reviewed contract';
  END IF;
END
$repair$;

REVOKE ALL ON FUNCTION public.replace_attendance_report_snapshot(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_attendance_report_snapshot(uuid,text,text,jsonb) TO service_role;
