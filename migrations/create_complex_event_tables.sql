-- Complex Events Module: Tables for multi-session, multi-track events
-- Phase 1: Data model for complex_event, complex_event_track, complex_event_session

-- 1. complex_event table
CREATE TABLE IF NOT EXISTS complex_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  summary TEXT,
  image_url TEXT,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'tbc', 'closed')),
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  available_seats INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_complex_event_tenant_id ON complex_event(tenant_id);
CREATE INDEX IF NOT EXISTS idx_complex_event_status ON complex_event(status);
CREATE INDEX IF NOT EXISTS idx_complex_event_slug ON complex_event(slug);

-- 2. complex_event_track table
CREATE TABLE IF NOT EXISTS complex_event_track (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  complex_event_id UUID NOT NULL REFERENCES complex_event(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  colour TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complex_event_track_tenant_id ON complex_event_track(tenant_id);
CREATE INDEX IF NOT EXISTS idx_complex_event_track_event_id ON complex_event_track(complex_event_id);

-- 3. complex_event_session table
CREATE TABLE IF NOT EXISTS complex_event_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  complex_event_track_id UUID NOT NULL REFERENCES complex_event_track(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  speaker_names TEXT[],
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  location TEXT,
  is_online BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complex_event_session_tenant_id ON complex_event_session(tenant_id);
CREATE INDEX IF NOT EXISTS idx_complex_event_session_track_id ON complex_event_session(complex_event_track_id);

-- RLS policies (following tenant isolation pattern)
ALTER TABLE complex_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE complex_event_track ENABLE ROW LEVEL SECURITY;
ALTER TABLE complex_event_session ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by API)
DROP POLICY IF EXISTS "service_role_all_complex_event" ON complex_event;
CREATE POLICY "service_role_all_complex_event" ON complex_event FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_complex_event_track" ON complex_event_track;
CREATE POLICY "service_role_all_complex_event_track" ON complex_event_track FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_complex_event_session" ON complex_event_session;
CREATE POLICY "service_role_all_complex_event_session" ON complex_event_session FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Updated_at trigger function (reuse if exists)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_complex_event_updated_at ON complex_event;
CREATE TRIGGER update_complex_event_updated_at BEFORE UPDATE ON complex_event FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_complex_event_track_updated_at ON complex_event_track;
CREATE TRIGGER update_complex_event_track_updated_at BEFORE UPDATE ON complex_event_track FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_complex_event_session_updated_at ON complex_event_session;
CREATE TRIGGER update_complex_event_session_updated_at BEFORE UPDATE ON complex_event_session FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Cross-tenant integrity: ensure child tenant_id matches parent tenant_id
CREATE OR REPLACE FUNCTION check_complex_event_track_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM complex_event WHERE id = NEW.complex_event_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'complex_event_track tenant_id does not match parent complex_event tenant_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_track_tenant ON complex_event_track;
CREATE TRIGGER enforce_track_tenant BEFORE INSERT OR UPDATE ON complex_event_track FOR EACH ROW EXECUTE FUNCTION check_complex_event_track_tenant();

CREATE OR REPLACE FUNCTION check_complex_event_session_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM complex_event_track WHERE id = NEW.complex_event_track_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'complex_event_session tenant_id does not match parent complex_event_track tenant_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_session_tenant ON complex_event_session;
CREATE TRIGGER enforce_session_tenant BEFORE INSERT OR UPDATE ON complex_event_session FOR EACH ROW EXECUTE FUNCTION check_complex_event_session_tenant();
