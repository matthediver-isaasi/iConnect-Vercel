BEGIN;
INSERT INTO storage.buckets(id, name, public, file_size_limit)
VALUES ('member-note-documents', 'member-note-documents', false, 2097152)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 2097152;

DROP POLICY IF EXISTS member_note_documents_service_only ON storage.objects;
CREATE POLICY member_note_documents_service_only ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (bucket_id <> 'member-note-documents')
  WITH CHECK (bucket_id <> 'member-note-documents');

CREATE OR REPLACE FUNCTION public.member_note_documents_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id='member-note-documents' AND public=false
  ) AND EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid='storage.objects'::regclass
      AND p.polname='member_note_documents_service_only'
      AND p.polpermissive=false
  );
$$;
REVOKE ALL ON FUNCTION public.member_note_documents_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_note_documents_ready() TO service_role;
COMMIT;
