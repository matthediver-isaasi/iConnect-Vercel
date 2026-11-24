BEGIN;

-- Install only after the mention inbox/identity and comment-image contracts.
-- Legacy content remains literal text: rich_content NULL is intentional.
ALTER TABLE public.project_card ADD COLUMN discussion_version bigint NOT NULL DEFAULT 0;
ALTER TABLE public.project_card_comment
  ADD COLUMN parent_comment_id uuid REFERENCES public.project_card_comment(id) ON DELETE RESTRICT,
  ADD COLUMN reply_to_comment_id uuid REFERENCES public.project_card_comment(id) ON DELETE SET NULL,
  ADD COLUMN rich_content jsonb,
  ADD COLUMN IF NOT EXISTS edited_at timestamp;
ALTER TABLE public.project_card_comment ADD CONSTRAINT project_comment_rich_version
  CHECK (rich_content IS NULL OR ((
    rich_content->>'version' = '1' AND rich_content->'doc'->>'type' = 'doc'
    AND jsonb_typeof(rich_content->'doc') = 'object' AND octet_length(rich_content::text) <= 200000
  ) IS TRUE));
CREATE INDEX project_comment_thread_order ON public.project_card_comment(card_id,parent_comment_id,created_at,id);

CREATE TABLE public.project_comment_reaction (
  comment_id uuid NOT NULL REFERENCES public.project_card_comment(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL,
  emoji text NOT NULL CHECK (emoji IN ('👍','❤️','😂','😮','😢','😊')),
  PRIMARY KEY(comment_id,identity_id)
);
ALTER TABLE public.project_comment_reaction ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_comment_reaction FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.project_comment_reaction TO service_role;

-- Immutable submission evidence, independent of edits and root promotion.
-- A retry of a subsequently deleted post must not recreate it or notify again.
CREATE TABLE public.project_comment_request (
  card_id uuid NOT NULL REFERENCES public.project_card(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL,
  request_id uuid NOT NULL,
  payload jsonb NOT NULL,
  comment_id uuid REFERENCES public.project_card_comment(id) ON DELETE SET NULL,
  PRIMARY KEY(card_id,identity_id,request_id)
);
ALTER TABLE public.project_comment_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_comment_request FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.project_comment_request TO service_role;
INSERT INTO public.project_comment_request(card_id,identity_id,request_id,payload,comment_id)
SELECT c.card_id,c.identity_id,c.client_request_id,jsonb_build_object(
  'content',c.content,'rich',NULL,'target',NULL,
  'images',ARRAY(SELECT attachment_id FROM public.project_comment_image WHERE comment_id=c.id ORDER BY attachment_id),
  'mentions',ARRAY(SELECT recipient_id FROM public.project_mention_inbox WHERE comment_id=c.id ORDER BY recipient_id)
),c.id FROM public.project_card_comment c WHERE c.client_request_id IS NOT NULL;

CREATE FUNCTION public.project_comment_parent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_parent public.project_card_comment%ROWTYPE;
BEGIN
  IF EXISTS(SELECT 1 FROM public.project_card_comment WHERE parent_comment_id=NEW.id AND card_id<>NEW.card_id) THEN
    RAISE EXCEPTION 'Cannot move a thread away from its replies' USING ERRCODE='22023';
  END IF;
  IF NEW.parent_comment_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.project_card_comment WHERE id=NEW.parent_comment_id;
    IF NOT FOUND OR v_parent.card_id<>NEW.card_id OR v_parent.parent_comment_id IS NOT NULL
      OR NEW.parent_comment_id=NEW.id OR EXISTS(
        SELECT 1 FROM public.project_card_comment WHERE parent_comment_id=NEW.id
      ) THEN RAISE EXCEPTION 'Invalid single-level thread parent' USING ERRCODE='22023'; END IF;
  END IF;
  IF NEW.reply_to_comment_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.project_card_comment WHERE id=NEW.reply_to_comment_id AND card_id=NEW.card_id AND id<>NEW.id
  ) THEN RAISE EXCEPTION 'Invalid reply target' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_comment_parent_guard BEFORE INSERT OR UPDATE OF parent_comment_id,reply_to_comment_id,card_id
  ON public.project_card_comment FOR EACH ROW EXECUTE FUNCTION public.project_comment_parent_guard();

CREATE FUNCTION public.project_discussion_access(p_card_id uuid,p_actor_id uuid,p_write boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_board uuid; v_archived boolean;
BEGIN
  -- Every mutation (including legacy creates) locks the card before comment rows.
  SELECT board_id,is_archived INTO v_board,v_archived FROM public.project_card WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Card unavailable' USING ERRCODE='P0002'; END IF;
  IF p_write AND v_archived IS TRUE THEN RAISE EXCEPTION 'Card unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.project_board WHERE id=v_board AND (NOT p_write OR is_archived IS NOT TRUE) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Board unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.project_board_member WHERE board_id=v_board AND identity_id=p_actor_id
    AND (NOT p_write OR role IN ('owner','admin','member')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Board access required' USING ERRCODE='42501'; END IF;
  RETURN v_board;
END;
$$;

CREATE FUNCTION public.read_project_discussion(p_card_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_board uuid; v_version bigint; v_writable boolean; v_comments jsonb;
BEGIN
  v_board := public.project_discussion_access(p_card_id,p_actor_id,false);
  SELECT discussion_version INTO v_version FROM public.project_card WHERE id=p_card_id;
  SELECT m.role IN ('owner','admin','member') AND b.is_archived IS NOT TRUE AND c.is_archived IS NOT TRUE
    INTO v_writable FROM public.project_board_member m JOIN public.project_board b ON b.id=m.board_id
    JOIN public.project_card c ON c.id=p_card_id WHERE m.board_id=v_board AND m.identity_id=p_actor_id;
  SELECT coalesce(jsonb_agg(item ORDER BY root_created DESC NULLS LAST,root_id DESC,is_reply,created_at ASC NULLS LAST,id ASC),'[]')
    INTO v_comments FROM (
    SELECT c.id,c.created_at,coalesce(root.created_at,c.created_at) root_created,
      coalesce(c.parent_comment_id,c.id) root_id,c.parent_comment_id IS NOT NULL is_reply,
      to_jsonb(c) || jsonb_build_object(
        'can_edit',v_writable AND c.identity_id=p_actor_id,
        'author',jsonb_build_object('id',i.id,'first_name',i.first_name,'last_name',i.last_name,
          'email',i.email,'avatar_url',to_jsonb(i)->'avatar_url'),
        'reply_to_name',CASE WHEN c.parent_comment_id IS NOT NULL AND c.reply_to_comment_id IS NOT NULL
          THEN coalesce(nullif(btrim(concat_ws(' ',target_i.first_name,target_i.last_name)),''),'Board member') ELSE NULL END,
        'images',coalesce(img.images,'[]'::jsonb),
        'mentions',coalesce(mn.mentions,'[]'::jsonb),
        'reactions',coalesce(rx.reactions,'[]'::jsonb)
      ) item
    FROM public.project_card_comment c
    LEFT JOIN public.project_card_comment root ON root.id=c.parent_comment_id
    LEFT JOIN public.tenant_identity i ON i.id=c.identity_id::text
    LEFT JOIN public.project_card_comment target ON target.id=c.reply_to_comment_id
    LEFT JOIN public.project_board_member target_m ON target_m.board_id=v_board AND target_m.identity_id=target.identity_id
    LEFT JOIN public.tenant_identity target_i ON target_i.id=target_m.identity_id::text
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('attachment',jsonb_build_object(
        'id',a.id,'name',a.name,'url',a.url,'file_type',a.file_type,'file_size',a.file_size
      )) ORDER BY a.id) images FROM public.project_comment_image ci
      JOIN public.project_card_attachment a ON a.id=ci.attachment_id AND a.card_id=p_card_id WHERE ci.comment_id=c.id
    ) img ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',mi.recipient_id,'label',
        coalesce(nullif(btrim(concat_ws(' ',mention_i.first_name,mention_i.last_name)),''),mention_i.email)
      ) ORDER BY mi.recipient_id) mentions FROM public.project_mention_inbox mi
      JOIN public.project_board_member mention_m ON mention_m.board_id=v_board AND mention_m.identity_id=mi.recipient_id
      JOIN public.tenant_identity mention_i ON mention_i.id=mi.recipient_id::text
      WHERE mi.comment_id=c.id
    ) mn ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('emoji',emoji,'count',n,'selected',selected,'reactors',reactors) ORDER BY emoji) reactions FROM (
        SELECT r.emoji,count(*) n,bool_or(r.identity_id=p_actor_id) selected,
          jsonb_agg(jsonb_build_object('id',m.identity_id,'name',
            coalesce(nullif(btrim(concat_ws(' ',ri.first_name,ri.last_name)),''),'Board member')
          ) ORDER BY m.identity_id) reactors
        FROM public.project_comment_reaction r
        JOIN public.project_board_member m ON m.board_id=v_board AND m.identity_id=r.identity_id
        LEFT JOIN public.tenant_identity ri ON ri.id=m.identity_id::text
        WHERE r.comment_id=c.id GROUP BY r.emoji
      ) grouped
    ) rx ON true
    WHERE c.card_id=p_card_id
  ) rows;
  RETURN jsonb_build_object('comments',v_comments,'discussionVersion',v_version,'discussionCanWrite',v_writable);
END;
$$;

-- Keep the original validated mention transaction as an internal building block.
ALTER FUNCTION public.create_project_comment_with_mentions(uuid,uuid,text,uuid[])
  RENAME TO project_comment_mentions_legacy;
REVOKE ALL ON FUNCTION public.project_comment_mentions_legacy(uuid,uuid,text,uuid[]) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.write_project_discussion(
  p_card_id uuid,p_actor_id uuid,p_operation text,p_comment_id uuid DEFAULT NULL,
  p_content text DEFAULT NULL,p_rich_content jsonb DEFAULT NULL,p_recipient_ids uuid[] DEFAULT '{}',
  p_attachment_ids uuid[] DEFAULT '{}',p_request_id uuid DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL,p_emoji text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  v_board uuid; v_comment public.project_card_comment%ROWTYPE; v_target public.project_card_comment%ROWTYPE;
  v_request public.project_comment_request%ROWTYPE; v_payload jsonb; v_result jsonb;
  v_promoted uuid; v_id uuid; v_label text; v_node jsonb;
BEGIN
  v_board := public.project_discussion_access(p_card_id,p_actor_id,true);
  IF p_operation NOT IN ('create','edit','delete','react') OR p_operation IS NULL THEN
    RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
  END IF;
  IF p_operation IN ('create','edit') THEN
    IF p_content IS NULL OR length(p_content)>20000 OR p_attachment_ids IS NULL OR cardinality(p_attachment_ids)>10
      OR p_recipient_ids IS NULL OR cardinality(p_recipient_ids)>50
      OR (length(btrim(p_content))=0 AND cardinality(p_attachment_ids)=0)
      OR (p_rich_content IS NOT NULL AND (p_rich_content->>'version' IS DISTINCT FROM '1'
        OR p_rich_content->'doc'->>'type' IS DISTINCT FROM 'doc' OR octet_length(p_rich_content::text)>200000)) THEN
      RAISE EXCEPTION 'Invalid comment' USING ERRCODE='22023';
    END IF;
    FOREACH v_id IN ARRAY p_recipient_ids LOOP
      SELECT coalesce(nullif(btrim(concat_ws(' ',i.first_name,i.last_name)),''),i.email)
        INTO v_label FROM public.project_board_member m JOIN public.tenant_identity i ON i.id=m.identity_id::text
        WHERE m.board_id=v_board AND m.identity_id=v_id;
      IF v_label IS NULL OR position('@'||v_label IN p_content)=0 THEN
        RAISE EXCEPTION 'Mention is missing or no longer authorized' USING ERRCODE='22023';
      END IF;
    END LOOP;
    -- JSON mention labels must be actual current board names, not forged
    -- visible strings paired with somebody else's recipient identity.
    IF p_rich_content IS NOT NULL THEN
      FOR v_node IN SELECT DISTINCT value FROM jsonb_path_query(p_rich_content,'$.doc.** ? (@.type == "mention")') AS nodes(value) LOOP
        SELECT coalesce(nullif(btrim(concat_ws(' ',i.first_name,i.last_name)),''),i.email)
          INTO v_label FROM public.project_board_member m JOIN public.tenant_identity i ON i.id=m.identity_id::text
          WHERE m.board_id=v_board AND m.identity_id=(v_node->'attrs'->>'id')::uuid;
        IF v_label IS NULL OR v_label IS DISTINCT FROM v_node->'attrs'->>'label' THEN
          RAISE EXCEPTION 'Select a current board member to mention' USING ERRCODE='22023';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF p_operation='create' THEN
    IF p_request_id IS NULL AND (p_reply_to_id IS NOT NULL OR p_rich_content IS NOT NULL OR cardinality(p_attachment_ids)>0) THEN
      RAISE EXCEPTION 'A request ID is required for replies, rich content and images' USING ERRCODE='22023';
    END IF;
    v_payload := jsonb_build_object('content',btrim(p_content),'rich',p_rich_content,'target',p_reply_to_id,
      'images',ARRAY(SELECT DISTINCT unnest(p_attachment_ids) ORDER BY 1),
      'mentions',ARRAY(SELECT DISTINCT unnest(p_recipient_ids) ORDER BY 1));
    IF p_request_id IS NOT NULL THEN
      SELECT * INTO v_request FROM public.project_comment_request
        WHERE card_id=p_card_id AND identity_id=p_actor_id AND request_id=p_request_id;
      IF FOUND THEN
        IF v_request.payload<>v_payload THEN RAISE EXCEPTION 'Submission was already saved differently' USING ERRCODE='22023'; END IF;
        IF v_request.comment_id IS NULL THEN RAISE EXCEPTION 'This comment was already deleted' USING ERRCODE='PT409'; END IF;
        v_result := public.read_project_discussion(p_card_id,p_actor_id);
        RETURN v_result || jsonb_build_object('comment',(SELECT value FROM jsonb_array_elements(v_result->'comments') WHERE value->>'id'=v_request.comment_id::text));
      END IF;
    END IF;
    IF p_reply_to_id IS NOT NULL THEN
      SELECT * INTO v_target FROM public.project_card_comment WHERE id=p_reply_to_id AND card_id=p_card_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reply target unavailable' USING ERRCODE='P0002'; END IF;
    END IF;
    -- Validate all attachments before creating the comment or inbox rows.
    FOREACH v_id IN ARRAY p_attachment_ids LOOP
      PERFORM 1 FROM public.project_card_attachment WHERE id=v_id AND card_id=p_card_id AND uploaded_by=p_actor_id
        AND file_type IN ('image/png','image/jpeg','image/gif','image/webp') AND file_size>0 AND file_size<=104857600 FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Image must be your uploaded image on this card' USING ERRCODE='22023'; END IF;
    END LOOP;
    v_result := public.project_comment_mentions_legacy(p_card_id,p_actor_id,
      CASE WHEN length(btrim(p_content))=0 THEN '[Image]' ELSE p_content END,p_recipient_ids);
    p_comment_id := (v_result->>'id')::uuid;
    UPDATE public.project_card_comment SET content=btrim(p_content),rich_content=p_rich_content,
      client_request_id=p_request_id,parent_comment_id=coalesce(v_target.parent_comment_id,v_target.id),
      reply_to_comment_id=p_reply_to_id WHERE id=p_comment_id RETURNING * INTO v_comment;
    INSERT INTO public.project_comment_image SELECT p_comment_id,unnest(p_attachment_ids) ON CONFLICT DO NOTHING;
    IF p_request_id IS NOT NULL THEN
      INSERT INTO public.project_comment_request VALUES(p_card_id,p_actor_id,p_request_id,v_payload,p_comment_id);
    END IF;
  ELSE
    SELECT * INTO v_comment FROM public.project_card_comment WHERE id=p_comment_id AND card_id=p_card_id FOR UPDATE;
    IF NOT FOUND THEN
      IF p_operation='delete' THEN RETURN public.read_project_discussion(p_card_id,p_actor_id)||jsonb_build_object('deletedId',p_comment_id); END IF;
      RAISE EXCEPTION 'Comment unavailable' USING ERRCODE='P0002';
    END IF;
    IF p_operation IN ('edit','delete') AND v_comment.identity_id<>p_actor_id THEN
      RAISE EXCEPTION 'Only the author may change this comment' USING ERRCODE='42501';
    END IF;
    IF p_operation='edit' THEN
      FOREACH v_id IN ARRAY p_attachment_ids LOOP
        PERFORM 1 FROM public.project_card_attachment a WHERE a.id=v_id AND a.card_id=p_card_id
          AND (a.uploaded_by=p_actor_id OR EXISTS(SELECT 1 FROM public.project_comment_image WHERE comment_id=p_comment_id AND attachment_id=v_id))
          AND a.file_type IN ('image/png','image/jpeg','image/gif','image/webp') FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Image is not available on this comment' USING ERRCODE='22023'; END IF;
      END LOOP;
      UPDATE public.project_card_comment SET content=btrim(p_content),rich_content=p_rich_content,edited_at=clock_timestamp() WHERE id=p_comment_id;
      DELETE FROM public.project_comment_image WHERE comment_id=p_comment_id AND NOT(attachment_id=ANY(p_attachment_ids));
      INSERT INTO public.project_comment_image SELECT p_comment_id,unnest(p_attachment_ids) ON CONFLICT DO NOTHING;
      -- Edits never deliver a new notification. Remove no-longer-mentioned
      -- inbox references and refresh retained previews in the same transaction.
      DELETE FROM public.project_mention_inbox WHERE comment_id=p_comment_id AND NOT(recipient_id=ANY(p_recipient_ids));
      UPDATE public.project_mention_inbox SET content=left(btrim(p_content),280) WHERE comment_id=p_comment_id;
    ELSIF p_operation='delete' THEN
      IF v_comment.parent_comment_id IS NULL THEN
        SELECT id INTO v_promoted FROM public.project_card_comment WHERE parent_comment_id=p_comment_id
          ORDER BY created_at ASC NULLS LAST,id ASC LIMIT 1;
        IF v_promoted IS NOT NULL THEN
          UPDATE public.project_card_comment SET parent_comment_id=NULL,reply_to_comment_id=NULL WHERE id=v_promoted;
          UPDATE public.project_card_comment SET parent_comment_id=v_promoted,
            reply_to_comment_id=CASE WHEN reply_to_comment_id=p_comment_id THEN NULL ELSE reply_to_comment_id END
            WHERE parent_comment_id=p_comment_id;
        END IF;
      END IF;
      DELETE FROM public.project_card_comment WHERE id=p_comment_id;
    ELSIF p_operation='react' THEN
      IF p_emoji IS NULL THEN DELETE FROM public.project_comment_reaction WHERE comment_id=p_comment_id AND identity_id=p_actor_id;
      ELSIF p_emoji IN ('👍','❤️','😂','😮','😢','😊') THEN
        INSERT INTO public.project_comment_reaction VALUES(p_comment_id,p_actor_id,p_emoji)
          ON CONFLICT(comment_id,identity_id) DO UPDATE SET emoji=excluded.emoji;
      ELSE RAISE EXCEPTION 'Unsupported reaction' USING ERRCODE='22023'; END IF;
    END IF;
  END IF;
  UPDATE public.project_card SET discussion_version=discussion_version+1 WHERE id=p_card_id;
  v_result := public.read_project_discussion(p_card_id,p_actor_id);
  RETURN v_result || jsonb_build_object('comment',(SELECT value FROM jsonb_array_elements(v_result->'comments') WHERE value->>'id'=p_comment_id::text),
    'deletedId',CASE WHEN p_operation='delete' THEN p_comment_id ELSE NULL END);
END;
$$;

-- Existing callers retain signatures but join the same lock and idempotency
-- authority, so legacy creates cannot race root deletion.
CREATE FUNCTION public.create_project_comment_with_mentions(p_card_id uuid,p_actor_id uuid,p_content text,p_recipient_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.write_project_discussion(p_card_id,p_actor_id,'create',p_content=>p_content,p_recipient_ids=>p_recipient_ids)->'comment';
$$;
CREATE OR REPLACE FUNCTION public.create_project_comment_with_images(p_card_id uuid,p_actor_id uuid,p_content text,p_recipient_ids uuid[],p_attachment_ids uuid[],p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request ID required' USING ERRCODE='22023'; END IF;
  RETURN public.write_project_discussion(p_card_id,p_actor_id,'create',p_content=>p_content,p_recipient_ids=>p_recipient_ids,p_attachment_ids=>p_attachment_ids,p_request_id=>p_request_id)->'comment';
END;
$$;

REVOKE ALL ON FUNCTION public.project_comment_parent_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.project_discussion_access(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.read_project_discussion(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.write_project_discussion(uuid,uuid,text,uuid,text,jsonb,uuid[],uuid[],uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_project_comment_with_mentions(uuid,uuid,text,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_comment_parent_guard(),public.project_discussion_access(uuid,uuid,boolean),
  public.read_project_discussion(uuid,uuid),public.write_project_discussion(uuid,uuid,text,uuid,text,jsonb,uuid[],uuid[],uuid,uuid,text),
  public.create_project_comment_with_mentions(uuid,uuid,text,uuid[]),public.create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
