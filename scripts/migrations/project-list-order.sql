-- Service-only atomic reorder. Lock the list table to serialize membership-of-set
-- changes (insert/archive/delete) too, including legacy direct writers.
BEGIN;
CREATE OR REPLACE FUNCTION public.reorder_project_lists(
  p_board_id uuid, p_tenant_id uuid, p_identity_id uuid, p_list_ids uuid[]
) RETURNS SETOF public.project_list
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active_ids uuid[];
BEGIN
  LOCK TABLE public.project_list IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_board b JOIN public.project_board_member m ON m.board_id = b.id
    WHERE b.id = p_board_id AND b.tenant_id = p_tenant_id
      AND m.identity_id = p_identity_id AND m.role IN ('owner','admin','member')
  ) THEN RAISE EXCEPTION 'Board edit permission required' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO active_ids
    FROM public.project_list WHERE board_id = p_board_id AND is_archived = false;
  IF p_list_ids IS NULL OR cardinality(p_list_ids) <> cardinality(active_ids)
    OR EXISTS (SELECT 1 FROM unnest(p_list_ids) id WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(p_list_ids) id) <> cardinality(p_list_ids)
    OR NOT (p_list_ids @> active_ids AND active_ids @> p_list_ids)
  THEN RAISE EXCEPTION 'Active list set changed' USING ERRCODE = 'PT409'; END IF;
  UPDATE public.project_list l SET position = ordered.ordinality - 1, updated_at = now()
    FROM unnest(p_list_ids) WITH ORDINALITY ordered(id, ordinality)
    WHERE l.id = ordered.id AND l.board_id = p_board_id;
  RETURN QUERY SELECT l.* FROM public.project_list l
    WHERE l.board_id = p_board_id AND l.is_archived = false ORDER BY l.position, l.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reorder_project_lists(uuid,uuid,uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_project_lists(uuid,uuid,uuid,uuid[]) TO service_role;
COMMIT;
