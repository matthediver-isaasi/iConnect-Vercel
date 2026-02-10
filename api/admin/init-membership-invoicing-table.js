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
      CREATE TABLE IF NOT EXISTS organisation_membership_invoicing (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        tenant_id UUID NOT NULL,
        organization_id UUID NOT NULL,
        invoicing_mode TEXT NOT NULL DEFAULT 'manual' CHECK (invoicing_mode IN ('automatic', 'scheduled', 'manual')),
        invoice_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, organization_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_org_membership_invoicing_tenant 
        ON organisation_membership_invoicing(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_org_membership_invoicing_org 
        ON organisation_membership_invoicing(tenant_id, organization_id);
    `;

    const { error } = await supabase.rpc('exec_sql', { sql_text: createSQL });

    if (error) {
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        const { error: checkError } = await supabase
          .from('organisation_membership_invoicing')
          .select('id')
          .limit(1);

        if (checkError && checkError.code === '42P01') {
          return res.status(200).json({
            success: false,
            message: 'Table does not exist yet. Please create the organisation_membership_invoicing table manually in Supabase SQL editor.',
            sql: createSQL.trim()
          });
        }

        return res.json({ success: true, message: 'Table already exists' });
      }

      console.error('[Init Invoicing Table] Error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, message: 'Table created successfully' });
  } catch (error) {
    console.error('[Init Invoicing Table] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
