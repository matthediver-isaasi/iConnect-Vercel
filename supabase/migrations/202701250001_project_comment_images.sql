BEGIN;

-- Only unconfirmed Activity uploads enter this ledger. Cleanup runs after the
-- signed upload capability and confirmation token have both expired.
CREATE TABLE public.project_activity_upload (
  id uuid PRIMARY KEY,
  storage_path text NOT NULL UNIQUE,
  cleanup_after timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
ALTER TABLE public.project_activity_upload ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_activity_upload FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.project_activity_upload TO service_role;
CREATE INDEX project_activity_upload_cleanup_idx ON public.project_activity_upload(cleanup_after);

-- Links, not copied URLs: deleting a comment never deletes a shared attachment.
-- Deliberately deleting an attachment removes its image links.
CREATE TABLE public.project_comment_image (
  comment_id uuid NOT NULL REFERENCES public.project_card_comment(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES public.project_card_attachment(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, attachment_id)
);
CREATE INDEX project_comment_image_attachment_idx ON public.project_comment_image(attachment_id);
ALTER TABLE public.project_comment_image ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_comment_image FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.project_comment_image TO service_role;
ALTER TABLE public.project_card_comment ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX project_comment_request_idx
  ON public.project_card_comment(card_id, identity_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE FUNCTION public.create_project_comment_with_images(
  p_card_id uuid, p_actor_id uuid, p_content text,
  p_recipient_ids uuid[], p_attachment_ids uuid[], p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_card public.project_card%ROWTYPE;
  v_comment public.project_card_comment%ROWTYPE;
  v_attachment public.project_card_attachment%ROWTYPE;
  v_id uuid;
  v_result jsonb;
  v_images jsonb;
  v_ids uuid[];
BEGIN
  IF p_request_id IS NULL OR p_content IS NULL OR length(p_content)>20000
    OR p_attachment_ids IS NULL OR cardinality(p_attachment_ids)>10
    OR (length(btrim(p_content))=0 AND cardinality(p_attachment_ids)=0)
    OR p_recipient_ids IS NULL OR cardinality(p_recipient_ids)>50 THEN
    RAISE EXCEPTION 'Invalid comment or images' USING ERRCODE='22023';
  END IF;
  -- Serialize retries before checking the request key. The legacy function
  -- retains mention validation/delivery and activity creation in this transaction.
  SELECT * INTO v_card FROM public.project_card WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.is_archived IS TRUE THEN
    RAISE EXCEPTION 'Card unavailable' USING ERRCODE='P0002';
  END IF;
  PERFORM 1 FROM public.project_board WHERE id=v_card.board_id AND is_archived IS NOT TRUE FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Board unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.project_board_member WHERE board_id=v_card.board_id
    AND identity_id=p_actor_id AND role IN ('owner','admin','member') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed to comment' USING ERRCODE='42501'; END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_attachment_ids) x;
  v_ids := coalesce(v_ids, '{}'::uuid[]);
  SELECT * INTO v_comment FROM public.project_card_comment
    WHERE card_id=p_card_id AND identity_id=p_actor_id AND client_request_id=p_request_id;
  IF FOUND THEN
    IF v_comment.content <> btrim(p_content) OR v_ids <> ARRAY(
      SELECT attachment_id FROM public.project_comment_image WHERE comment_id=v_comment.id ORDER BY attachment_id
    ) THEN
      RAISE EXCEPTION 'This submission was already saved with different content' USING ERRCODE='22023';
    END IF;
  ELSE
    FOREACH v_id IN ARRAY v_ids LOOP
      SELECT * INTO v_attachment FROM public.project_card_attachment WHERE id=v_id FOR SHARE;
      IF NOT FOUND OR v_attachment.card_id <> p_card_id OR v_attachment.uploaded_by <> p_actor_id
        OR v_attachment.uploaded_by IS NULL
        OR v_attachment.file_type IS NULL
        OR v_attachment.file_type NOT IN ('image/png','image/jpeg','image/gif','image/webp')
        OR v_attachment.file_size IS NULL OR v_attachment.file_size <= 0
        OR v_attachment.file_size > 104857600 THEN
        RAISE EXCEPTION 'Image must be your uploaded image on this card' USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF length(btrim(p_content))=0 AND cardinality(p_recipient_ids)>0 THEN
      RAISE EXCEPTION 'Image-only comments cannot contain mentions' USING ERRCODE='22023';
    END IF;
    v_result := public.create_project_comment_with_mentions(p_card_id,p_actor_id,
      CASE WHEN length(btrim(p_content))=0 THEN '[Image]' ELSE p_content END, p_recipient_ids);
    UPDATE public.project_card_comment SET content=btrim(p_content),client_request_id=p_request_id
      WHERE id=(v_result->>'id')::uuid RETURNING * INTO v_comment;
    INSERT INTO public.project_comment_image(comment_id,attachment_id)
      SELECT v_comment.id, unnest(v_ids);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('attachment',jsonb_build_object(
    'id',a.id,'name',a.name,'url',a.url,'file_type',a.file_type,'file_size',a.file_size
  )) ORDER BY a.id),'[]'::jsonb) INTO v_images
    FROM public.project_comment_image i JOIN public.project_card_attachment a ON a.id=i.attachment_id
    WHERE i.comment_id=v_comment.id;
  RETURN to_jsonb(v_comment) || jsonb_build_object('images',v_images);
END;
$$;
REVOKE ALL ON FUNCTION public.create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
