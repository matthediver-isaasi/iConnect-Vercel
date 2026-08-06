import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';
import { getTenantContext } from '../../../../_lib/tenantContext.js';
import { isGroupAdminForEventRequest } from '../../../../_lib/groupAdminEventWrite.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyAdminAccess(req) {
  const sessionMember = await getSessionMember(req);

  if (!sessionMember) {
    return { hasAccess: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { hasAccess: false, memberId: sessionMember.id };
  }

  if (!supabase) {
    return { hasAccess: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasAccess: false, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');

    if (isAdmin) {
      return { hasAccess: true, memberId: sessionMember.id };
    }

    return { hasAccess: false, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Admin Update Buddy Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
}

async function findBookingTable(bookingId, tenantId) {
  const { data: regular } = await supabase
    .from('booking')
    .select('id, event_id')
    .eq('id', bookingId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (regular) {
    return { table: 'booking', booking: regular };
  }

  const { data: complex } = await supabase
    .from('complex_event_booking')
    .select('id, event_id')
    .eq('id', bookingId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (complex) {
    return { table: 'complex_event_booking', booking: complex };
  }

  return { table: null, booking: null };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { hasAccess, error: accessError } = await verifyAdminAccess(req);

  if (accessError) {
    return res.status(401).json({ error: accessError });
  }

  if (!hasAccess) {
    // Task e1476154: group admins may manage attendees of their own group's
    // events (simple or complex) — the group page surfaces the same modal.
    const groupOk = await isGroupAdminForEventRequest(req, req.query.eventId);
    if (!groupOk) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const context = await getTenantContext(req);
  if (!context?.tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  const { eventId } = req.query;
  const { bookingId, buddy } = req.body || {};

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID is required' });
  }

  const valueToStore = buddy === true || buddy === 'true';

  try {
    const { table, booking } = await findBookingTable(bookingId, context.tenantId);

    if (!table || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.event_id && String(booking.event_id) !== String(eventId)) {
      return res.status(400).json({ error: 'Booking does not belong to this event' });
    }

    const { data: updated, error: updateError } = await supabase
      .from(table)
      .update({ buddy: valueToStore })
      .eq('id', bookingId)
      .eq('tenant_id', context.tenantId)
      .select('id, buddy')
      .single();

    if (updateError) {
      console.error('[Admin Update Buddy] Update failed:', updateError);
      return res.status(500).json({ error: updateError.message || 'Failed to update buddy' });
    }

    console.log(
      `[Admin Update Buddy] Booking ${bookingId} (${table}, event ${eventId}) buddy set to ${valueToStore}`
    );

    return res.status(200).json({
      success: true,
      bookingId: updated.id,
      buddy: !!updated.buddy,
    });
  } catch (error) {
    console.error('[Admin Update Buddy] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to update buddy' });
  }
}
