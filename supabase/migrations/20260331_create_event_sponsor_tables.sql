CREATE TABLE IF NOT EXISTS event_sponsor_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id),
  name VARCHAR(255) NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_sponsor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id),
  name VARCHAR(255) NOT NULL,
  logo_url TEXT,
  website_url TEXT,
  description TEXT,
  category_id UUID REFERENCES event_sponsor_category(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_sponsor_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id),
  event_id UUID NOT NULL,
  event_type VARCHAR(20) NOT NULL DEFAULT 'simple',
  sponsor_id UUID NOT NULL REFERENCES event_sponsor(id) ON DELETE CASCADE,
  category_id UUID REFERENCES event_sponsor_category(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(event_id, sponsor_id)
);

CREATE INDEX IF NOT EXISTS idx_event_sponsor_tenant ON event_sponsor(tenant_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsor_category_tenant ON event_sponsor_category(tenant_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsor_assignment_tenant ON event_sponsor_assignment(tenant_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsor_assignment_event ON event_sponsor_assignment(event_id);
