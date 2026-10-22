// Service-only atomic expiry. No direct balance or ledger writes.
import { supabase } from '../_lib/database.js';
import { administerVoucher } from '../_lib/voucherCreditService.js';

export function expireVoucher(db, voucher) {
  return administerVoucher(db, {
    tenantId: voucher.tenant_id,
    voucherId: voucher.id,
    operation: 'expire',
    values: {},
    actor: 'system:voucher-expiry',
    idempotencyKey: `expiry:${voucher.id}:${voucher.expires_at}`,
  });
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'Cron secret not configured' });
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { data, error } = await supabase.from('voucher')
      .select('id, tenant_id, expires_at')
      .lt('expires_at', new Date().toISOString()).gt('value', 0)
      .order('id', { ascending: true }).limit(500);
    if (error) throw error;
    const results = { processed: 0, skipped: 0, errors: 0, details: [] };
    for (const voucher of data || []) {
      if (!voucher.tenant_id) {
        results.skipped++;
        results.details.push({ voucher_id: voucher.id, skipped: 'null_tenant_id' });
        continue;
      }
      try {
        await expireVoucher(supabase, voucher);
        results.processed++;
      } catch (error) {
        results.errors++;
        results.details.push({ voucher_id: voucher.id, error: error.message });
      }
    }
    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: 'Voucher expiry processing failed', details: error.message });
  }
}
