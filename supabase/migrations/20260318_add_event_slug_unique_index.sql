CREATE UNIQUE INDEX IF NOT EXISTS idx_event_slug_tenant_unique
ON event (tenant_id, slug)
WHERE slug IS NOT NULL AND slug != '';
