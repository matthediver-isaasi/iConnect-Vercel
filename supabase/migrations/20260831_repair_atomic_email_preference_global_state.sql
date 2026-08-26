-- Upgrade-safe repair for atomic email preference writes.
-- This later migration deliberately includes both the ledger uniqueness
-- contract and the RPCs whose ON CONFLICT clauses depend on that contract.

ALTER TABLE email_unsubscribe
  DROP CONSTRAINT IF EXISTS email_unsubscribe_email_canonical_check;

DROP TRIGGER IF EXISTS email_unsubscribe_canonicalize_email
  ON email_unsubscribe;

DROP INDEX IF EXISTS idx_email_unsubscribe_unique;
DROP INDEX IF EXISTS idx_email_unsubscribe_unique_null_category;

UPDATE email_unsubscribe
SET email = lower(trim(email))
WHERE email IS DISTINCT FROM lower(trim(email));

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, email, unsubscribe_type, communication_category_id
      ORDER BY COALESCE(unsubscribed_at, created_at) DESC, created_at DESC, id DESC
    ) AS rn
  FROM email_unsubscribe
)
DELETE FROM email_unsubscribe
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX idx_email_unsubscribe_unique
  ON email_unsubscribe (tenant_id, email, unsubscribe_type, communication_category_id)
  NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION canonicalize_email_unsubscribe_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(trim(NEW.email));
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_unsubscribe_canonicalize_email
  BEFORE INSERT OR UPDATE OF email
  ON email_unsubscribe
  FOR EACH ROW
  EXECUTE FUNCTION canonicalize_email_unsubscribe_email();

REVOKE ALL ON FUNCTION canonicalize_email_unsubscribe_email()
  FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION set_email_preference_global_state(
  p_tenant_id uuid,
  p_email text,
  p_member_id uuid,
  p_opt_out_all boolean,
  p_campaign_id uuid,
  p_category_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_category_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR v_email = '' OR p_opt_out_all IS NULL THEN
    RAISE EXCEPTION 'invalid email preference global state input';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || v_email, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM unnest(coalesce(p_category_ids, array[]::uuid[])) supplied(id)
    LEFT JOIN communication_category category
      ON category.id = supplied.id
      AND category.tenant_id = p_tenant_id
      AND category.is_active = true
    WHERE category.id IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid communication category';
  END IF;

  IF p_member_id IS NOT NULL THEN
    UPDATE member
    SET communications_opted_out_all = p_opt_out_all
    WHERE id = p_member_id
      AND tenant_id = p_tenant_id
      AND lower(trim(email)) = v_email;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member not found';
    END IF;

    IF p_opt_out_all THEN
      FOREACH v_category_id IN ARRAY coalesce(p_category_ids, array[]::uuid[])
      LOOP
        INSERT INTO member_communication_preference (
          tenant_id, member_id, category_id, is_subscribed
        ) VALUES (
          p_tenant_id, p_member_id, v_category_id, false
        )
        ON CONFLICT (member_id, category_id)
        DO UPDATE SET is_subscribed = false;
      END LOOP;
    END IF;
  ELSIF p_opt_out_all THEN
    UPDATE email_subscriber
    SET opted_out = true,
        opted_out_at = now(),
        updated_at = now()
    WHERE tenant_id = p_tenant_id
      AND lower(trim(email)) = v_email;
  END IF;

  IF p_opt_out_all THEN
    INSERT INTO email_unsubscribe (
      tenant_id, email, member_id, unsubscribe_type,
      communication_category_id, campaign_id, source, unsubscribed_at
    ) VALUES (
      p_tenant_id, v_email, p_member_id, 'all',
      null, p_campaign_id, 'user', now()
    )
    ON CONFLICT (tenant_id, email, unsubscribe_type, communication_category_id)
    DO UPDATE SET
      member_id = excluded.member_id,
      campaign_id = excluded.campaign_id,
      source = excluded.source,
      unsubscribed_at = excluded.unsubscribed_at;

    FOREACH v_category_id IN ARRAY coalesce(p_category_ids, array[]::uuid[])
    LOOP
      INSERT INTO email_unsubscribe (
        tenant_id, email, member_id, unsubscribe_type,
        communication_category_id, campaign_id, source, unsubscribed_at
      ) VALUES (
        p_tenant_id, v_email, p_member_id, 'category',
        v_category_id, p_campaign_id, 'user', now()
      )
      ON CONFLICT (tenant_id, email, unsubscribe_type, communication_category_id)
      DO UPDATE SET
        member_id = excluded.member_id,
        campaign_id = excluded.campaign_id,
        source = excluded.source,
        unsubscribed_at = excluded.unsubscribed_at;
    END LOOP;
  ELSE
    DELETE FROM email_unsubscribe
    WHERE tenant_id = p_tenant_id
      AND lower(trim(email)) = v_email
      AND unsubscribe_type = 'all'
      AND communication_category_id IS NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION set_email_preference_category_state(
  p_tenant_id uuid,
  p_email text,
  p_member_id uuid,
  p_category_id uuid,
  p_is_subscribed boolean,
  p_campaign_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
BEGIN
  IF p_tenant_id IS NULL
    OR v_email = ''
    OR p_category_id IS NULL
    OR p_is_subscribed IS NULL
  THEN
    RAISE EXCEPTION 'invalid email preference category state input';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || v_email, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM communication_category
    WHERE id = p_category_id
      AND tenant_id = p_tenant_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'invalid communication category';
  END IF;

  IF p_member_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM member
      WHERE id = p_member_id
        AND tenant_id = p_tenant_id
        AND lower(trim(email)) = v_email
        AND communications_opted_out_all = true
    ) THEN
      RAISE EXCEPTION 'global email opt-out is active';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM member
      WHERE id = p_member_id
        AND tenant_id = p_tenant_id
        AND lower(trim(email)) = v_email
    ) THEN
      RAISE EXCEPTION 'member not found';
    END IF;

    INSERT INTO member_communication_preference (
      tenant_id, member_id, category_id, is_subscribed
    ) VALUES (
      p_tenant_id, p_member_id, p_category_id, p_is_subscribed
    )
    ON CONFLICT (member_id, category_id)
    DO UPDATE SET is_subscribed = excluded.is_subscribed;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM email_unsubscribe
      WHERE tenant_id = p_tenant_id
        AND lower(trim(email)) = v_email
        AND unsubscribe_type = 'all'
        AND communication_category_id IS NULL
    ) THEN
      RAISE EXCEPTION 'global email opt-out is active';
    END IF;

    UPDATE email_subscriber
    SET opted_out = NOT p_is_subscribed,
        opted_out_at = CASE WHEN p_is_subscribed THEN null ELSE now() END,
        updated_at = now()
    WHERE tenant_id = p_tenant_id
      AND lower(trim(email)) = v_email
      AND communication_category_id = p_category_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'external subscriber category not found';
    END IF;
  END IF;

  IF p_is_subscribed THEN
    DELETE FROM email_unsubscribe
    WHERE tenant_id = p_tenant_id
      AND lower(trim(email)) = v_email
      AND unsubscribe_type = 'category'
      AND communication_category_id = p_category_id;
  ELSE
    INSERT INTO email_unsubscribe (
      tenant_id, email, member_id, unsubscribe_type,
      communication_category_id, campaign_id, source, unsubscribed_at
    ) VALUES (
      p_tenant_id, v_email, p_member_id, 'category',
      p_category_id, p_campaign_id, 'user', now()
    )
    ON CONFLICT (tenant_id, email, unsubscribe_type, communication_category_id)
    DO UPDATE SET
      member_id = excluded.member_id,
      campaign_id = excluded.campaign_id,
      source = excluded.source,
      unsubscribed_at = excluded.unsubscribed_at;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION set_email_preference_global_state(
  uuid, text, uuid, boolean, uuid, uuid[]
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_email_preference_global_state(
  uuid, text, uuid, boolean, uuid, uuid[]
) TO service_role;

REVOKE ALL ON FUNCTION set_email_preference_category_state(
  uuid, text, uuid, uuid, boolean, uuid
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_email_preference_category_state(
  uuid, text, uuid, uuid, boolean, uuid
) TO service_role;