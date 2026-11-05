BEGIN;

-- Private compiler for the finite filter tree emitted by the existing list
-- builders. Identifiers and operators are whitelisted; values are quoted as
-- SQL literals, never executed as expressions. No caller-supplied SQL.
CREATE OR REPLACE FUNCTION public.crm_alphabet_predicate(p_node jsonb, p_alias text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  col text := p_node->>'column';
  op text := p_node->>'op';
  value text := p_node->>'value';
  result text;
  child jsonb;
  parts text[] := '{}';
BEGIN
  IF p_alias NOT IN ('r','v','o') THEN RAISE EXCEPTION 'Invalid alias'; END IF;
  IF p_node ? 'or' THEN
    IF jsonb_array_length(p_node->'or') > 400 THEN RAISE EXCEPTION 'Too many predicates'; END IF;
    FOR child IN SELECT * FROM jsonb_array_elements(p_node->'or') LOOP
      IF child ? 'or' THEN RAISE EXCEPTION 'Nested predicates are unsupported'; END IF;
      parts := array_append(parts, public.crm_alphabet_predicate(child,p_alias));
    END LOOP;
    RETURN '(' || coalesce(array_to_string(parts,' OR '),'false') || ')';
  END IF;
  IF col IS NULL OR col NOT IN ('id','tenant_id','name','first_name','last_name','email','mobile','job_title',
    'organization_id','organization_group_id','role_id','login_enabled',
    'phone','website_url','invoicing_email','invoicing_address','field_id','value') THEN
    RAISE EXCEPTION 'Invalid filter column';
  END IF;
  IF op = 'in' THEN
    IF jsonb_array_length(p_node->'value') > 2000 THEN RAISE EXCEPTION 'Too many filter values'; END IF;
    SELECT array_agg(quote_literal(x)) INTO parts FROM jsonb_array_elements_text(p_node->'value') x;
    result := CASE WHEN cardinality(parts)>0 THEN format('%I.%I IN (%s)',p_alias,col,array_to_string(parts,','))
      ELSE 'false' END;
  ELSIF op = 'is' THEN
    IF value IS NOT NULL AND value NOT IN ('null','true','false') THEN RAISE EXCEPTION 'Invalid IS operand'; END IF;
    result := format('%I.%I IS %s',p_alias,col,coalesce(value,'null'));
  ELSIF op IN ('eq','neq','like','ilike') THEN
    result := format('%I.%I %s %L',p_alias,col,
      CASE op WHEN 'eq' THEN '=' WHEN 'neq' THEN '<>' WHEN 'like' THEN 'LIKE' ELSE 'ILIKE' END,value);
  ELSE RAISE EXCEPTION 'Invalid filter operator';
  END IF;
  IF coalesce((p_node->>'negate')::boolean,false) THEN result := 'NOT ('||result||')'; END IF;
  RETURN '('||result||')';
END $$;

CREATE OR REPLACE FUNCTION public.crm_alphabet_predicates(p_nodes jsonb, p_alias text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE child jsonb; result text := 'true';
BEGIN
  IF jsonb_typeof(p_nodes) <> 'array' OR jsonb_array_length(p_nodes)>100 THEN RAISE EXCEPTION 'Invalid predicates'; END IF;
  FOR child IN SELECT * FROM jsonb_array_elements(p_nodes) LOOP
    result := result || ' AND ' || public.crm_alphabet_predicate(child,p_alias);
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.crm_alphabet_metadata(
  p_tenant uuid, p_entity text, p_sort text, p_filters jsonb, p_departments jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  clause text; j record; child record; term text; nested text; result jsonb;
  preference_table text; parent_column text; joins jsonb := p_filters->'joins';
BEGIN
  IF p_tenant IS NULL OR NOT (
    (p_entity='organization' AND p_sort='name') OR
    (p_entity='member' AND p_sort IN ('first_name','last_name'))
  ) THEN RAISE EXCEPTION 'Invalid alphabet scope'; END IF;
  IF octet_length(p_filters::text)>500000 OR jsonb_typeof(joins)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(joins))>60 THEN RAISE EXCEPTION 'Invalid filter size'; END IF;
  preference_table := p_entity || '_preference_value';
  parent_column := p_entity || '_id';
  -- Explicit mandatory tenant predicate, independent of the filter tree.
  clause := 'r.tenant_id = $1 AND ' || public.crm_alphabet_predicates(p_filters->'base','r');
  FOR j IN SELECT * FROM jsonb_each(joins) LOOP
    IF j.value->>'kind' = 'preference' THEN
      term := format('EXISTS (SELECT 1 FROM public.%I v WHERE v.%I=r.id AND %s)',
        preference_table,parent_column,public.crm_alphabet_predicates(j.value->'filters','v'));
      IF coalesce((j.value->>'negative')::boolean,false) THEN term := 'NOT ('||term||')'; END IF;
      clause := clause || ' AND ' || term;
    ELSIF j.value->>'kind' = 'organization' AND p_entity='member' THEN
      -- A left-embedded organisation does not filter the parent in PostgREST.
      -- Preserve that existing page behavior for negative linked-org filters.
      IF coalesce((j.value->>'optional')::boolean,false) THEN CONTINUE; END IF;
      nested := public.crm_alphabet_predicates(j.value->'filters','o');
      FOR child IN SELECT * FROM jsonb_each(joins) LOOP
        IF child.value->>'parent'=j.key AND child.value->>'kind'='organization_preference' THEN
          term := format('EXISTS (SELECT 1 FROM public.organization_preference_value v WHERE v.organization_id=o.id AND %s)',
            public.crm_alphabet_predicates(child.value->'filters','v'));
          IF coalesce((child.value->>'negative')::boolean,false) THEN term := 'NOT ('||term||')'; END IF;
          nested := nested || ' AND ' || term;
        END IF;
      END LOOP;
      clause := clause || ' AND EXISTS (SELECT 1 FROM public.organization o WHERE o.id=r.organization_id AND o.tenant_id=$1 AND '||nested||')';
    ELSIF j.value->>'kind' <> 'organization_preference' THEN RAISE EXCEPTION 'Invalid filter join';
    END IF;
  END LOOP;
  IF p_departments IS NOT NULL THEN
    IF p_entity<>'member' OR jsonb_array_length(p_departments->'ids')>100 THEN RAISE EXCEPTION 'Invalid departments'; END IF;
    -- The handler validates only the bounded department/schema IDs; membership
    -- itself stays in the database, including the exactly-one-parent rule.
    clause := clause || ' AND EXISTS (
      SELECT 1 FROM public.custom_object_relationship e
      WHERE e.tenant_id=$1 AND e.archived_at IS NULL
        AND e.relationship_definition_id=($2->>''definitionId'')::uuid
        AND e.target_record_id=r.id
        AND e.source_record_id IN (SELECT x::uuid FROM jsonb_array_elements_text($2->''ids'') x)
        AND (SELECT count(*) FROM public.custom_object_relationship p
          WHERE p.tenant_id=$1 AND p.archived_at IS NULL
          AND p.relationship_definition_id=($2->>''parentDefinitionId'')::uuid
          AND p.source_record_id=e.source_record_id)=1
        AND EXISTS (SELECT 1 FROM public.custom_object_relationship p
          WHERE p.tenant_id=$1 AND p.archived_at IS NULL
          AND p.relationship_definition_id=($2->>''parentDefinitionId'')::uuid
          AND p.source_record_id=e.source_record_id AND p.target_record_id=r.organization_id))';
  END IF;
  EXECUTE format($query$
    WITH ordered AS (
      SELECT r.id, row_number() OVER (ORDER BY r.%1$I ASC NULLS LAST,r.id ASC)-1 AS pos,
        CASE WHEN r.%1$I IS NULL OR r.%1$I='' THEN 'Unnamed'
          WHEN left(r.%1$I,1) ~ '^[0-9]$' THEN '0–9'
          WHEN left(r.%1$I,1) ~ '^[[:alpha:]]$' THEN upper(left(r.%1$I,1))
          ELSE 'Symbols' END AS label
      FROM public.%2$I r WHERE %3$s
    ), changes AS (
      SELECT *, CASE WHEN label IS DISTINCT FROM lag(label) OVER (ORDER BY pos) THEN 1 ELSE 0 END AS changed
      FROM ordered
    ), runs AS (
      SELECT *, sum(changed) OVER (ORDER BY pos) AS run FROM changes
    ), buckets AS (
      SELECT label, count(*) AS count, min(pos) AS offset,
        (array_agg(id ORDER BY pos))[1] AS id
      FROM runs GROUP BY run,label ORDER BY min(pos) LIMIT 513
    )
    SELECT jsonb_build_object('total',(SELECT count(*) FROM ordered),
      'buckets',coalesce(jsonb_agg(to_jsonb(buckets) ORDER BY buckets."offset"),'[]'::jsonb)) FROM buckets
  $query$,p_sort,p_entity,clause) INTO result USING p_tenant,p_departments;
  IF jsonb_array_length(result->'buckets')>512 THEN RAISE EXCEPTION 'Too many alphabet runs'; END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.crm_alphabet_predicate(jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crm_alphabet_predicates(jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crm_alphabet_metadata(uuid,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_alphabet_metadata(uuid,text,text,jsonb,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
