-- Migration: Add tenant_id to zoom_meeting and zoom_webinar tables for multi-tenant isolation
-- This ensures each tenant can only access their own Zoom resources

-- Add tenant_id to zoom_meeting table
ALTER TABLE zoom_meeting 
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);

-- Add tenant_id to zoom_webinar table  
ALTER TABLE zoom_webinar
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);

-- Create indexes for efficient tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_tenant_id ON zoom_meeting(tenant_id);
CREATE INDEX IF NOT EXISTS idx_zoom_webinar_tenant_id ON zoom_webinar(tenant_id);

-- Create composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_tenant_status ON zoom_meeting(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_tenant_start_time ON zoom_meeting(tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_zoom_webinar_tenant_status ON zoom_webinar(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_zoom_webinar_tenant_start_time ON zoom_webinar(tenant_id, start_time);

-- Add comments for documentation
COMMENT ON COLUMN zoom_meeting.tenant_id IS 'Tenant ID for multi-tenant isolation - meetings are scoped to their owning tenant';
COMMENT ON COLUMN zoom_webinar.tenant_id IS 'Tenant ID for multi-tenant isolation - webinars are scoped to their owning tenant';

-- Enable RLS on zoom_meeting table
ALTER TABLE zoom_meeting ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for zoom_meeting
DROP POLICY IF EXISTS zoom_meeting_tenant_isolation ON zoom_meeting;
CREATE POLICY zoom_meeting_tenant_isolation ON zoom_meeting
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_meeting_insert_policy ON zoom_meeting;
CREATE POLICY zoom_meeting_insert_policy ON zoom_meeting
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_meeting_update_policy ON zoom_meeting;
CREATE POLICY zoom_meeting_update_policy ON zoom_meeting
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_meeting_delete_policy ON zoom_meeting;
CREATE POLICY zoom_meeting_delete_policy ON zoom_meeting
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Enable RLS on zoom_webinar table
ALTER TABLE zoom_webinar ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for zoom_webinar
DROP POLICY IF EXISTS zoom_webinar_tenant_isolation ON zoom_webinar;
CREATE POLICY zoom_webinar_tenant_isolation ON zoom_webinar
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_webinar_insert_policy ON zoom_webinar;
CREATE POLICY zoom_webinar_insert_policy ON zoom_webinar
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_webinar_update_policy ON zoom_webinar;
CREATE POLICY zoom_webinar_update_policy ON zoom_webinar
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS zoom_webinar_delete_policy ON zoom_webinar;
CREATE POLICY zoom_webinar_delete_policy ON zoom_webinar
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
