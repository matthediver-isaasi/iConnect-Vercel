-- Atomic function to create the first platform owner
-- This function ensures only one owner can be created via setup by using row-level locking
-- It returns NULL for owner_id if any owners already exist

CREATE OR REPLACE FUNCTION create_first_platform_owner(
  p_name TEXT,
  p_email TEXT,
  p_password_hash TEXT
) RETURNS JSON AS $$
DECLARE
  v_owner_count INTEGER;
  v_new_owner_id UUID;
BEGIN
  -- Lock the table to prevent concurrent inserts during the check
  LOCK TABLE platform_owner IN EXCLUSIVE MODE;
  
  -- Check if any owners exist
  SELECT COUNT(*) INTO v_owner_count FROM platform_owner;
  
  -- If owners exist, return null to indicate setup is unavailable
  IF v_owner_count > 0 THEN
    RETURN json_build_object('owner_id', NULL, 'already_exists', true);
  END IF;
  
  -- Insert the first owner
  INSERT INTO platform_owner (name, email, password_hash, is_active)
  VALUES (p_name, p_email, p_password_hash, true)
  RETURNING id INTO v_new_owner_id;
  
  RETURN json_build_object('owner_id', v_new_owner_id, 'already_exists', false);
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission to the authenticated role if using Supabase RLS
-- GRANT EXECUTE ON FUNCTION create_first_platform_owner TO authenticated;
-- For public access during setup (before any auth exists):
GRANT EXECUTE ON FUNCTION create_first_platform_owner TO anon;
GRANT EXECUTE ON FUNCTION create_first_platform_owner TO authenticated;
