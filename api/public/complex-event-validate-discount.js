import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveTicketPrice, validateDiscountCode, computeDiscountedPrice, parsePricingConfig } from '../_lib/complexEventPricing.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(400).json({ error: 'Tenant not found' });

    const { event_id, ticket_class_id, discount_code } = req.body;
    if (!event_id || !ticket_class_id || !discount_code) {
      return res.status(400).json({ valid: false, reason: 'Missing required fields' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: event } = await supabase
      .from('complex_event')
      .select('id, pricing_config')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .single();

    if (!event) return res.status(404).json({ valid: false, reason: 'Event not found' });

    const ticket = resolveTicketPrice(event.pricing_config, ticket_class_id);
    if (!ticket.found || ticket.price <= 0) {
      return res.status(400).json({ valid: false, reason: 'Invalid or free ticket class' });
    }

    let memberId = null, memberRoleId = null, orgId = null;
    const sessionCookie = req.cookies?.session;
    if (sessionCookie) {
      try {
        const sessionData = JSON.parse(Buffer.from(sessionCookie, 'base64').toString());
        if (sessionData?.memberId) {
          const { data: member } = await supabase
            .from('member')
            .select('id, role_id, organization_id')
            .eq('id', sessionData.memberId)
            .single();
          if (member) {
            memberId = member.id;
            memberRoleId = member.role_id;
            orgId = member.organization_id;
          }
        }
      } catch {}
    }

    const result = await validateDiscountCode({
      code: discount_code.trim().toUpperCase(),
      tenantId: tenant.id,
      eventId: event_id,
      memberId,
      memberRoleId,
      orgId
    });

    if (!result.valid) {
      return res.status(200).json({ valid: false, reason: result.reason });
    }

    const discountedPrice = computeDiscountedPrice(ticket.price, result.discountCode);

    return res.status(200).json({
      valid: true,
      original_price: ticket.price,
      discounted_price: discountedPrice,
      discount_type: result.discountCode.type,
      discount_value: result.discountCode.value,
      discount_code_id: result.discountCode.id
    });
  } catch (error) {
    console.error('[Complex Event Validate Discount] Error:', error);
    return res.status(500).json({ valid: false, reason: 'Failed to validate discount code' });
  }
}
