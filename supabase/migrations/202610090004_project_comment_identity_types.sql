BEGIN;

-- tenant_identity.id is varchar in the deployed schema. Board membership and
-- RPC actor/recipient IDs are UUIDs. Convert the parameters, not the indexed
-- identity column, and retain all existing authorization/atomicity checks.
CREATE OR REPLACE FUNCTION public.create_project_comment_with_mentions(
  p_card_id uuid, p_actor_id uuid, p_content text, p_recipient_ids uuid[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_card public.project_card%ROWTYPE;
  v_comment public.project_card_comment%ROWTYPE;
  v_recipient uuid;
  v_role text;
  v_label text;
  v_author text;
BEGIN
  IF p_content IS NULL OR length(btrim(p_content)) = 0 OR length(p_content) > 20000
    OR cardinality(p_recipient_ids) > 50 THEN
    RAISE EXCEPTION 'Invalid comment or too many mentions' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_card FROM public.project_card WHERE id=p_card_id FOR SHARE;
  IF NOT FOUND OR v_card.is_archived IS TRUE THEN
    RAISE EXCEPTION 'Card unavailable' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.project_board WHERE id=v_card.board_id AND is_archived IS NOT TRUE FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Board unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT role INTO v_role FROM public.project_board_member
    WHERE board_id=v_card.board_id AND identity_id=p_actor_id FOR SHARE;
  IF NOT FOUND OR v_role IS NULL OR v_role NOT IN ('owner','admin','member') THEN
    RAISE EXCEPTION 'Not allowed to comment on this board' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),email,'Board member')
    INTO v_author FROM public.tenant_identity WHERE id=p_actor_id::text;

  INSERT INTO public.project_card_comment(card_id,identity_id,content)
    VALUES(p_card_id,p_actor_id,btrim(p_content)) RETURNING * INTO v_comment;
  FOR v_recipient IN SELECT DISTINCT unnest(coalesce(p_recipient_ids,'{}'::uuid[])) LOOP
    PERFORM 1 FROM public.project_board_member
      WHERE board_id=v_card.board_id AND identity_id=v_recipient FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mention recipient is not a board member' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),email)
      INTO v_label FROM public.tenant_identity WHERE id=v_recipient::text;
    IF v_label IS NULL OR position('@' || v_label IN p_content) = 0 THEN
      RAISE EXCEPTION 'Mention is missing from the comment; select the member again' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.project_mention_inbox(board_id,card_id,comment_id,recipient_id,author_name,content)
      VALUES(v_card.board_id,p_card_id,v_comment.id,v_recipient,coalesce(v_author,'Board member'),
        left(btrim(p_content),280));
  END LOOP;
  INSERT INTO public.project_card_activity(card_id,identity_id,action_type,action_data)
    VALUES(p_card_id,p_actor_id,'commented',jsonb_build_object('comment_id',v_comment.id));
  RETURN to_jsonb(v_comment);
END;
$$;
REVOKE ALL ON FUNCTION public.create_project_comment_with_mentions(uuid,uuid,text,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_project_comment_with_mentions(uuid,uuid,text,uuid[]) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
