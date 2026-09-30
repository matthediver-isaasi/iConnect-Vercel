import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { error } = await supabase.rpc('exec_sql', {
      sql_text: `
        CREATE TABLE IF NOT EXISTS organisation_membership_override (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          tenant_id UUID NOT NULL,
          organization_id UUID NOT NULL,
          override_type TEXT NOT NULL CHECK (override_type IN ('structure', 'price', 'discount')),
          config_id UUID,
          band_id UUID,
          manual_price NUMERIC(12,2),
          discount_type TEXT CHECK (discount_type IN ('percentage', 'fixed')),
          discount_value NUMERIC(12,4),
          membership_year TEXT,
          note TEXT,
          created_by UUID,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, organization_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_org_membership_override_tenant 
          ON organisation_membership_override(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_org_membership_override_org 
          ON organisation_membership_override(tenant_id, organization_id);

        DO $$ BEGIN
          ALTER TABLE organisation_membership_override DROP CONSTRAINT IF EXISTS organisation_membership_override_override_type_check;
          ALTER TABLE organisation_membership_override ADD CONSTRAINT organisation_membership_override_override_type_check CHECK (override_type IN ('structure', 'price', 'discount'));
        EXCEPTION WHEN others THEN NULL;
        END $$;

        ALTER TABLE organisation_membership_override ADD COLUMN IF NOT EXISTS discount_type TEXT CHECK (discount_type IN ('percentage', 'fixed'));
        ALTER TABLE organisation_membership_override ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,4);
      `
    });

    if (error) {
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        const { error: createError } = await supabase
          .from('organisation_membership_override')
          .select('id')
          .limit(1);

        if (createError && createError.code === '42P01') {
          return res.status(200).json({
            success: false,
            message: 'Table does not exist yet. Please create the organisation_membership_override table manually in Supabase SQL editor.',
            sql: `CREATE TABLE IF NOT EXISTS organisation_membership_override (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('structure', 'price', 'discount')),
  config_id UUID,
  band_id UUID,
  manual_price NUMERIC(12,2),
  discount_type TEXT CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(12,4),
  membership_year TEXT,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_org_membership_override_tenant 
  ON organisation_membership_override(tenant_id);
CREATE INDEX IF NOT EXISTS idx_org_membership_override_org 
  ON organisation_membership_override(tenant_id, organization_id);`
          });
        }

        return res.json({ success: true, message: 'Table already exists' });
      }

      console.error('[Init Override Table] Error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, message: 'Table created successfully' });
  } catch (error) {
    console.error('[Init Override Table] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
