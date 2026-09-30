-- Task #3300: aggregate resource view counts in the database instead of
-- shipping every resource_view row to the serverless function/browser.
CREATE OR REPLACE FUNCTION resource_view_counts(p_tenant_id UUID)
RETURNS TABLE(resource_id UUID, views BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT rv.resource_id, COUNT(*)::BIGINT AS views
  FROM resource_view rv
  WHERE rv.tenant_id = p_tenant_id
  GROUP BY rv.resource_id;
$$;
