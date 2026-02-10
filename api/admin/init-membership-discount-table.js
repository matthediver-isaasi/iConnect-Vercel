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

    const createSQL = `
      CREATE TABLE IF NOT EXISTS membership_tier_discount (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        tenant_id UUID NOT NULL,
        config_id UUID NOT NULL,
        field_id UUID NOT NULL,
        field_label TEXT,
        match_value TEXT NOT NULL,
        discount_type TEXT NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage', 'fixed')),
        discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
        label TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_membership_tier_discount_tenant
        ON membership_tier_discount(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_membership_tier_discount_config
        ON membership_tier_discount(config_id);

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_history'
          AND column_name = 'custom_discount_total'
        ) THEN
          ALTER TABLE organisation_membership_history ADD COLUMN custom_discount_total NUMERIC(12,2) DEFAULT 0;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_history'
          AND column_name = 'custom_discount_details'
        ) THEN
          ALTER TABLE organisation_membership_history ADD COLUMN custom_discount_details JSONB;
        END IF;
      END $$;
    `;

    const { error } = await supabase.rpc('exec_sql', { sql_text: createSQL });

    if (error) {
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        const { error: checkError } = await supabase
          .from('membership_tier_discount')
          .select('id')
          .limit(1);

        if (checkError && checkError.code === '42P01') {
          return res.status(200).json({
            success: false,
            message: 'Table does not exist yet. Please create the table and columns manually in Supabase SQL editor.',
            sql: createSQL.trim()
          });
        }

        const columnAddSQL = `
          ALTER TABLE organisation_membership_history ADD COLUMN IF NOT EXISTS custom_discount_total NUMERIC(12,2) DEFAULT 0;
          ALTER TABLE organisation_membership_history ADD COLUMN IF NOT EXISTS custom_discount_details JSONB;
        `.trim();

        return res.json({
          success: true,
          message: 'Discount table already exists. Please also ensure additional columns exist on organisation_membership_history.',
          columnMigrationSQL: columnAddSQL
        });
      }

      console.error('[Init Discount Table] Error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, message: 'Membership tier discount table and columns created successfully' });
  } catch (error) {
    console.error('[Init Discount Table] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
