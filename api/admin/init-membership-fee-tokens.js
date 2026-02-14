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
      CREATE TABLE IF NOT EXISTS membership_fee_token (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        tenant_id UUID NOT NULL,
        organization_id UUID NOT NULL,
        membership_year TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'po_submitted', 'paid', 'expired', 'cancelled')),
        final_cost NUMERIC(12, 2),
        currency TEXT DEFAULT 'GBP',
        tier_label TEXT,
        cost_breakdown JSONB,
        po_number TEXT,
        stripe_payment_intent_id TEXT,
        stripe_client_secret TEXT,
        recipient_email TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_membership_fee_token_token
        ON membership_fee_token(token);
      CREATE INDEX IF NOT EXISTS idx_membership_fee_token_tenant_org
        ON membership_fee_token(tenant_id, organization_id, membership_year);

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_invoicing'
          AND column_name = 'purchase_order_number'
        ) THEN
          ALTER TABLE organisation_membership_invoicing ADD COLUMN purchase_order_number TEXT;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_history'
          AND column_name = 'purchase_order_number'
        ) THEN
          ALTER TABLE organisation_membership_history ADD COLUMN purchase_order_number TEXT;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_history'
          AND column_name = 'stripe_payment_intent_id'
        ) THEN
          ALTER TABLE organisation_membership_history ADD COLUMN stripe_payment_intent_id TEXT;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organisation_membership_history'
          AND column_name = 'payment_method'
        ) THEN
          ALTER TABLE organisation_membership_history ADD COLUMN payment_method TEXT DEFAULT 'invoice';
        END IF;
      END $$;
    `;

    const { error } = await supabase.rpc('exec_sql', { sql_text: createSQL });

    if (error) {
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        const { error: checkError } = await supabase
          .from('membership_fee_token')
          .select('id')
          .limit(1);

        if (checkError && checkError.code === '42P01') {
          return res.status(200).json({
            success: false,
            message: 'Table does not exist yet. Please create the tables and columns manually in Supabase SQL editor.',
            sql: createSQL.trim()
          });
        }

        return res.json({
          success: true,
          message: 'Tables likely already exist. Please verify columns manually.',
        });
      }

      console.error('[Init Fee Tokens] Error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, message: 'Membership fee token table and columns created successfully' });
  } catch (error) {
    console.error('[Init Fee Tokens] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
