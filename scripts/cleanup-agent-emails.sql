-- Cleanup Script: Remove agent-to-agent emails from member_email table
-- Run this in Supabase SQL Editor to remove previously synced internal emails
-- This script identifies emails where both sender AND all recipients are agents

-- First, let's see what would be deleted (preview query)
-- Uncomment this section to preview before running the actual delete

/*
WITH agent_emails AS (
  SELECT DISTINCT LOWER(microsoft_email) as email, tenant_id
  FROM outlook_connection
  WHERE status = 'active' AND microsoft_email IS NOT NULL
),
emails_to_delete AS (
  SELECT me.id, me.tenant_id, me.from_address, me.to_addresses, me.cc_addresses, me.subject
  FROM member_email me
  WHERE EXISTS (
    SELECT 1 FROM agent_emails ae 
    WHERE ae.tenant_id = me.tenant_id 
    AND ae.email = LOWER(me.from_address)
  )
  AND NOT EXISTS (
    -- Check if any TO recipient is NOT an agent
    SELECT 1 
    FROM jsonb_array_elements(COALESCE(me.to_addresses, '[]'::jsonb)) AS r
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_emails ae 
      WHERE ae.tenant_id = me.tenant_id 
      AND ae.email = LOWER(r->>'address')
    )
  )
  AND NOT EXISTS (
    -- Check if any CC recipient is NOT an agent
    SELECT 1 
    FROM jsonb_array_elements(COALESCE(me.cc_addresses, '[]'::jsonb)) AS r
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_emails ae 
      WHERE ae.tenant_id = me.tenant_id 
      AND ae.email = LOWER(r->>'address')
    )
  )
  -- Must have at least one recipient
  AND (jsonb_array_length(COALESCE(me.to_addresses, '[]'::jsonb)) > 0 
       OR jsonb_array_length(COALESCE(me.cc_addresses, '[]'::jsonb)) > 0)
)
SELECT COUNT(*) as emails_to_delete FROM emails_to_delete;
*/

-- ACTUAL DELETE QUERY
-- This will permanently remove agent-to-agent emails

WITH agent_emails AS (
  SELECT DISTINCT LOWER(microsoft_email) as email, tenant_id
  FROM outlook_connection
  WHERE status = 'active' AND microsoft_email IS NOT NULL
),
emails_to_delete AS (
  SELECT me.id
  FROM member_email me
  WHERE EXISTS (
    SELECT 1 FROM agent_emails ae 
    WHERE ae.tenant_id = me.tenant_id 
    AND ae.email = LOWER(me.from_address)
  )
  AND NOT EXISTS (
    -- Check if any TO recipient is NOT an agent
    SELECT 1 
    FROM jsonb_array_elements(COALESCE(me.to_addresses, '[]'::jsonb)) AS r
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_emails ae 
      WHERE ae.tenant_id = me.tenant_id 
      AND ae.email = LOWER(r->>'address')
    )
  )
  AND NOT EXISTS (
    -- Check if any CC recipient is NOT an agent
    SELECT 1 
    FROM jsonb_array_elements(COALESCE(me.cc_addresses, '[]'::jsonb)) AS r
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_emails ae 
      WHERE ae.tenant_id = me.tenant_id 
      AND ae.email = LOWER(r->>'address')
    )
  )
  -- Must have at least one recipient
  AND (jsonb_array_length(COALESCE(me.to_addresses, '[]'::jsonb)) > 0 
       OR jsonb_array_length(COALESCE(me.cc_addresses, '[]'::jsonb)) > 0)
)
DELETE FROM member_email
WHERE id IN (SELECT id FROM emails_to_delete);
