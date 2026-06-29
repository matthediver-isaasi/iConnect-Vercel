import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { eventId } = req.query;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    // Try simple event first: ticket types live in pricing_config.ticket_classes JSONB
    const { data: simpleEvent } = await supabase
      .from('event')
      .select('id, pricing_config')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (simpleEvent) {
      const ticketClasses = simpleEvent.pricing_config?.ticket_classes || [];
      const ticketTypes = ticketClasses
        .filter(tc => tc.name)
        .map(tc => ({ id: tc.id || tc.name, name: tc.name }));
      return res.json({ ticketTypes });
    }

    // Try complex event: ticket types are rows in complex_event_ticket_class
    const { data: complexTicketClasses, error: complexErr } = await supabase
      .from('complex_event_ticket_class')
      .select('id, name')
      .eq('complex_event_id', eventId)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true });

    if (complexErr) {
      console.error('[EventTicketTypes] complex_event_ticket_class query error:', complexErr);
      return res.status(500).json({ error: complexErr.message });
    }

    const ticketTypes = (complexTicketClasses || [])
      .filter(tc => tc.name)
      .map(tc => ({ id: tc.id, name: tc.name }));

    return res.json({ ticketTypes });
  } catch (err) {
    console.error('[EventTicketTypes] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
