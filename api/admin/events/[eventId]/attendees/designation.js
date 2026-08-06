import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';
import { isGroupAdminForEventRequest } from '../../../../_lib/groupAdminEventWrite.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const MAX_DESIGNATION_LENGTH = 120;

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
    console.error('[Admin Update Designation Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
}

async function findBookingTable(bookingId) {
  const { data: regular } = await supabase
    .from('booking')
    .select('id, event_id')
    .eq('id', bookingId)
    .maybeSingle();

  if (regular) {
    return { table: 'booking', booking: regular };
  }

  const { data: complex } = await supabase
    .from('complex_event_booking')
    .select('id, event_id')
    .eq('id', bookingId)
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

  const { eventId } = req.query;
  const { bookingId, designation } = req.body || {};

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID is required' });
  }

  let normalizedDesignation = typeof designation === 'string' ? designation.trim() : '';
  if (normalizedDesignation.length > MAX_DESIGNATION_LENGTH) {
    return res.status(400).json({
      error: `Designation must be ${MAX_DESIGNATION_LENGTH} characters or fewer`,
    });
  }
  const valueToStore = normalizedDesignation === '' ? null : normalizedDesignation;

  try {
    const { table, booking } = await findBookingTable(bookingId);

    if (!table || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.event_id && String(booking.event_id) !== String(eventId)) {
      return res.status(400).json({ error: 'Booking does not belong to this event' });
    }

    const { data: updated, error: updateError } = await supabase
      .from(table)
      .update({ designation: valueToStore })
      .eq('id', bookingId)
      .select('id, designation')
      .single();

    if (updateError) {
      console.error('[Admin Update Designation] Update failed:', updateError);
      return res.status(500).json({ error: updateError.message || 'Failed to update designation' });
    }

    console.log(
      `[Admin Update Designation] Booking ${bookingId} (${table}, event ${eventId}) designation set to ${valueToStore ? `"${valueToStore}"` : 'null'}`
    );

    return res.status(200).json({
      success: true,
      bookingId: updated.id,
      designation: updated.designation || null,
    });
  } catch (error) {
    console.error('[Admin Update Designation] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to update designation' });
  }
}
