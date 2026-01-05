import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';

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
    console.error('[Admin Import Attendees Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
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

  const { hasAccess, error } = await verifyAdminAccess(req);

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasAccess) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { eventId } = req.query;
  const { emails } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array is required' });
  }

  try {
    console.log(`[Admin Import Attendees] Starting import for event ${eventId} with ${emails.length} emails`);

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.error('[Admin Import Attendees] Event not found:', eventError);
      return res.status(404).json({ error: 'Event not found' });
    }

    const normalizedEmails = [...new Set(emails.map(e => e.toLowerCase().trim()).filter(e => e && e.includes('@')))];
    console.log(`[Admin Import Attendees] Normalized to ${normalizedEmails.length} unique valid emails`);

    const { data: members, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, organization_id')
      .in('email', normalizedEmails);

    if (memberError) {
      console.error('[Admin Import Attendees] Member lookup error:', memberError);
      return res.status(500).json({ error: 'Failed to look up members' });
    }

    const memberMap = new Map();
    (members || []).forEach(m => memberMap.set(m.email.toLowerCase(), m));

    const { data: existingBookings, error: bookingError } = await supabase
      .from('booking')
      .select('attendee_email')
      .eq('event_id', eventId)
      .neq('status', 'cancelled');

    if (bookingError) {
      console.error('[Admin Import Attendees] Existing bookings lookup error:', bookingError);
      return res.status(500).json({ error: 'Failed to check existing bookings' });
    }

    const existingEmails = new Set((existingBookings || []).map(b => b.attendee_email?.toLowerCase()));

    // Generate a shared booking_group_reference for this import batch
    const batchGroupRef = `IMPG-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const results = {
      registered: [],
      alreadyRegistered: [],
      notFound: [],
      errors: []
    };

    for (const email of normalizedEmails) {
      if (existingEmails.has(email)) {
        results.alreadyRegistered.push(email);
        continue;
      }

      const member = memberMap.get(email);
      if (!member) {
        results.notFound.push(email);
        continue;
      }

      try {
        // Generate unique booking reference per booking, but shared group reference for batch
        const bookingReference = `IMP-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        
        const bookingData = {
          event_id: eventId,
          member_id: member.id,
          organization_id: member.organization_id,
          attendee_email: member.email,
          attendee_first_name: member.first_name || '',
          attendee_last_name: member.last_name || '',
          ticket_price: 0,
          booking_reference: bookingReference,
          status: 'confirmed',
          payment_method: 'admin_import'
        };

        const { error: insertError } = await supabase
          .from('booking')
          .insert(bookingData);

        if (insertError) {
          console.error(`[Admin Import Attendees] Insert failed for ${email}:`, insertError);
          results.errors.push({ email, error: insertError.message });
        } else {
          results.registered.push(email);
          existingEmails.add(email);
        }
      } catch (insertErr) {
        console.error(`[Admin Import Attendees] Exception for ${email}:`, insertErr);
        results.errors.push({ email, error: insertErr.message });
      }
    }

    console.log(`[Admin Import Attendees] Complete: registered=${results.registered.length}, alreadyRegistered=${results.alreadyRegistered.length}, notFound=${results.notFound.length}, errors=${results.errors.length}`);

    return res.json({
      success: true,
      eventId,
      results
    });

  } catch (error) {
    console.error('[Admin Import Attendees] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to import attendees' });
  }
}
