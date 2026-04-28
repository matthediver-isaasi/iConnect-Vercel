import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';
import { sendConfirmationEmailsFromTemplate } from '../../../../_lib/eventConfirmationEmail.js';

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

function isTicketClassMembersOnly(tc) {
  if (!tc) return false;
  if (tc.visibility_mode) {
    return tc.visibility_mode === 'members_only';
  }
  if (tc.is_public === false) return true;
  return false;
}

function parsePricingConfigTicketClasses(pricingConfig) {
  if (!pricingConfig) return [];
  let parsed = pricingConfig;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed?.ticket_classes) ? parsed.ticket_classes : [];
}

function normalizeRow(input) {
  if (!input || typeof input !== 'object') return null;
  const trim = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    first_name: trim(input.first_name),
    last_name: trim(input.last_name),
    email: trim(input.email).toLowerCase(),
    organization: trim(input.organization),
    job_title: trim(input.job_title),
  };
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
  const {
    rows,
    emails,
    ticket_class_id,
    ticket_class_name,
    send_confirmations,
  } = req.body || {};

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  // Backward compatibility: accept a flat emails array and turn it into rows.
  let inputRows = [];
  if (Array.isArray(rows) && rows.length > 0) {
    inputRows = rows;
  } else if (Array.isArray(emails) && emails.length > 0) {
    inputRows = emails.map(e => ({ email: e }));
  } else {
    return res.status(400).json({ error: 'rows array is required' });
  }

  const sendConfirmations = send_confirmations !== false; // default true

  try {
    console.log(`[Admin Import Attendees] Starting import for event ${eventId} with ${inputRows.length} rows | sendConfirmations=${sendConfirmations}`);

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.error('[Admin Import Attendees] Event not found:', eventError);
      return res.status(404).json({ error: 'Event not found' });
    }

    let resolvedTicketClassId = ticket_class_id || null;
    let resolvedTicketClassName = ticket_class_name || null;
    let resolvedTicketClass = null;

    if (event.is_complex) {
      if (!resolvedTicketClassId) {
        const { data: defaultTicketClass } = await supabase
          .from('complex_event_ticket_class')
          .select('id, name, visibility_mode, is_public')
          .eq('complex_event_id', eventId)
          .order('price', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (defaultTicketClass) {
          resolvedTicketClassId = defaultTicketClass.id;
          resolvedTicketClassName = resolvedTicketClassName || defaultTicketClass.name;
          resolvedTicketClass = defaultTicketClass;
          console.log(`[Admin Import Attendees] Using default ticket class: ${defaultTicketClass.name} (${defaultTicketClass.id})`);
        }
      } else {
        const { data: tc } = await supabase
          .from('complex_event_ticket_class')
          .select('id, name, visibility_mode, is_public')
          .eq('id', resolvedTicketClassId)
          .eq('complex_event_id', eventId)
          .maybeSingle();

        if (!tc) {
          return res.status(400).json({ error: 'Invalid ticket class for this event' });
        }
        resolvedTicketClass = tc;
        if (!resolvedTicketClassName) {
          resolvedTicketClassName = tc.name;
        }
      }
    } else {
      // Single event: ticket classes come from event.pricing_config.ticket_classes (if any).
      const singleTicketClasses = parsePricingConfigTicketClasses(event.pricing_config);
      if (resolvedTicketClassId) {
        const tc = singleTicketClasses.find(t => String(t.id) === String(resolvedTicketClassId));
        if (!tc) {
          return res.status(400).json({ error: 'Invalid ticket class for this event' });
        }
        resolvedTicketClass = tc;
        if (!resolvedTicketClassName) {
          resolvedTicketClassName = tc.name || null;
        }
      }
      // If no ticket_class_id provided for a single event, leave it null (works whether or not classes are configured).
    }

    const isMembersOnlyClass = isTicketClassMembersOnly(resolvedTicketClass);

    // Normalize rows + parse-level validation
    const parseErrors = [];
    const normalizedRows = [];
    const seenEmailsInBatch = new Set();
    inputRows.forEach((rawRow, idx) => {
      const rowNumber = idx + 1;
      const row = normalizeRow(rawRow);
      if (!row) {
        parseErrors.push({ row: rowNumber, reason: 'Malformed row' });
        return;
      }
      if (!row.email) {
        parseErrors.push({ row: rowNumber, reason: 'Missing email' });
        return;
      }
      if (!row.email.includes('@')) {
        parseErrors.push({ row: rowNumber, reason: 'Invalid email', email: row.email });
        return;
      }
      if (seenEmailsInBatch.has(row.email)) {
        // De-dupe within the batch silently (skip the duplicate row).
        return;
      }
      seenEmailsInBatch.add(row.email);
      normalizedRows.push({ ...row, _rowNumber: rowNumber });
    });

    console.log(`[Admin Import Attendees] Parsed ${normalizedRows.length} rows (${parseErrors.length} parse errors)`);

    const normalizedEmails = normalizedRows.map(r => r.email);

    const memberMap = new Map();
    if (normalizedEmails.length > 0) {
      const { data: members, error: memberError } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, organization_id')
        .in('email', normalizedEmails);

      if (memberError) {
        console.error('[Admin Import Attendees] Member lookup error:', memberError);
        return res.status(500).json({ error: 'Failed to look up members' });
      }
      (members || []).forEach(m => memberMap.set(m.email.toLowerCase(), m));
    }

    let existingEmails = new Set();
    if (normalizedEmails.length > 0) {
      const { data: existingBookings, error: bookingError } = await supabase
        .from('booking')
        .select('attendee_email')
        .eq('event_id', eventId)
        .neq('status', 'cancelled');

      if (bookingError) {
        console.error('[Admin Import Attendees] Existing bookings lookup error:', bookingError);
        return res.status(500).json({ error: 'Failed to check existing bookings' });
      }
      existingEmails = new Set((existingBookings || []).map(b => b.attendee_email?.toLowerCase()).filter(Boolean));
    }

    // Generate a shared booking_group_reference for this import batch
    const batchGroupRef = `IMPG-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const results = {
      registered: [],          // member emails (kept for backward compat)
      registeredMembers: [],   // member emails
      registeredGuests: [],    // guest emails
      alreadyRegistered: [],
      notFound: [],            // kept for backward compat (always empty now)
      warnings: [],            // [{ email, reason }]
      errors: [],              // [{ row?, email?, error }]
      emailsSent: [],
      emailsFailed: [],        // [{ email, error }]
      sendConfirmations,
    };

    parseErrors.forEach(pe => {
      results.errors.push({
        row: pe.row,
        email: pe.email || null,
        error: pe.reason,
      });
    });

    const insertedBookings = []; // collect for confirmation email step

    for (const row of normalizedRows) {
      const email = row.email;

      if (existingEmails.has(email)) {
        results.alreadyRegistered.push(email);
        continue;
      }

      const member = memberMap.get(email);
      const isGuest = !member;

      try {
        const bookingReference = `IMP-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

        const baseBooking = {
          event_id: eventId,
          ticket_price: 0,
          booking_reference: bookingReference,
          booking_group_reference: batchGroupRef,
          status: 'confirmed',
          payment_method: 'admin_import',
          ...(resolvedTicketClassId ? { ticket_class_id: resolvedTicketClassId } : {}),
          ...(resolvedTicketClassName ? { ticket_class_name: resolvedTicketClassName } : {}),
          ...(event.is_complex ? { is_one_off_event: true } : {}),
          ...(event.tenant_id ? { tenant_id: event.tenant_id } : {}),
        };

        let bookingData;
        if (member) {
          // Member booking: member fields are authoritative; CSV name/org are ignored.
          bookingData = {
            ...baseBooking,
            member_id: member.id,
            organization_id: member.organization_id,
            attendee_email: member.email,
            attendee_first_name: member.first_name || '',
            attendee_last_name: member.last_name || '',
            is_guest_booking: false,
          };
        } else {
          // Guest booking: use CSV-supplied details.
          bookingData = {
            ...baseBooking,
            member_id: null,
            organization_id: null,
            attendee_email: email,
            attendee_first_name: row.first_name || '',
            attendee_last_name: row.last_name || '',
            attendee_job_title: row.job_title || null,
            guest_organisation_name: row.organization || null,
            is_guest_booking: true,
          };
        }

        const { data: insertedBooking, error: insertError } = await supabase
          .from('booking')
          .insert(bookingData)
          .select()
          .single();

        if (insertError) {
          console.error(`[Admin Import Attendees] Insert failed for ${email}:`, insertError);
          results.errors.push({ row: row._rowNumber, email, error: insertError.message });
          continue;
        }

        results.registered.push(email);
        if (isGuest) {
          results.registeredGuests.push(email);
        } else {
          results.registeredMembers.push(email);
        }
        existingEmails.add(email);
        insertedBookings.push({ booking: insertedBooking, isGuest });

        if (isGuest && isMembersOnlyClass) {
          results.warnings.push({
            email,
            reason: 'Guest imported into a members-only ticket class',
          });
        }
      } catch (insertErr) {
        console.error(`[Admin Import Attendees] Exception for ${email}:`, insertErr);
        results.errors.push({ row: row._rowNumber, email, error: insertErr.message });
      }
    }

    if (sendConfirmations && insertedBookings.length > 0) {
      console.log(`[Admin Import Attendees] Sending confirmation emails for ${insertedBookings.length} bookings`);
      for (const { booking } of insertedBookings) {
        try {
          const attendee = {
            first_name: booking.attendee_first_name || '',
            last_name: booking.attendee_last_name || '',
            email: booking.attendee_email,
          };
          const sendResults = await sendConfirmationEmailsFromTemplate(
            eventId,
            booking,
            attendee,
            null,
            null,
            booking.tenant_id || event.tenant_id || null
          );

          if (!sendResults || sendResults.length === 0) {
            // No template configured — not a failure per row, but record once below.
            results.emailsFailed.push({
              email: booking.attendee_email,
              error: 'No confirmation email template configured for this event',
            });
            continue;
          }

          const successes = sendResults.filter(r => r.success);
          if (successes.length > 0) {
            results.emailsSent.push(booking.attendee_email);
          } else {
            const firstError = sendResults.find(r => !r.success)?.error || 'Email send failed';
            results.emailsFailed.push({ email: booking.attendee_email, error: firstError });
          }
        } catch (sendErr) {
          console.error(`[Admin Import Attendees] Confirmation send failed for ${booking.attendee_email}:`, sendErr);
          results.emailsFailed.push({
            email: booking.attendee_email,
            error: sendErr.message || 'Failed to send confirmation email',
          });
        }
      }
    }

    console.log(`[Admin Import Attendees] Complete: members=${results.registeredMembers.length}, guests=${results.registeredGuests.length}, alreadyRegistered=${results.alreadyRegistered.length}, warnings=${results.warnings.length}, errors=${results.errors.length}, emailsSent=${results.emailsSent.length}, emailsFailed=${results.emailsFailed.length}`);

    return res.json({
      success: true,
      eventId,
      results,
    });

  } catch (error) {
    console.error('[Admin Import Attendees] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to import attendees' });
  }
}
