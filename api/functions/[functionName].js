import Stripe from 'stripe';
import crypto from 'crypto';
import { getSession, getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { sendEmail, replacePlaceholders } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getZoomAccessTokenForTenant } from '../_lib/zoomClient.js';
import { getXeroCredentials } from '../_lib/xeroCredentials.js';
import { getAccountingProvider, getAccountingProviderByName, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { creditTrainingFundForPurchase } from '../_lib/trainingFundPurchase.js';
import { getStripeCredentials, findOrCreateStripeCustomer } from '../_lib/stripeCredentials.js';
import { sendConfirmationEmailsFromTemplate as sharedSendConfirmationEmailsFromTemplate } from '../_lib/eventConfirmationEmail.js';
import { sanitizeOptionSelections } from '../_lib/eventOptionSelections.js';
import { getAllowVoucherUseAfterExpiry, isVoucherUsableForEventDate } from '../_lib/voucherExpiryPolicy.js';
import {
  ticketHasAccessRestrictions,
  isTicketAccessibleToMember,
  getMemberGroupIdsForMember
} from '../_lib/ticketAccess.js';

// Helper: Get Stripe client for a tenant
async function getStripeClient(tenantId, feature) {
  if (!tenantId) {
    console.error('[Stripe] Cannot get Stripe client: tenantId is required');
    return null;
  }
  
  const creds = await getStripeCredentials(tenantId, feature);
  
  if (!creds || !creds.secret_key) {
    console.error('[Stripe] No Stripe credentials configured for tenant:', tenantId);
    return null;
  }
  
  if (!creds.is_enabled) {
    console.error('[Stripe] Stripe integration is disabled for tenant:', tenantId);
    return null;
  }
  
  console.log('[Stripe] Got Stripe client for tenant:', tenantId, feature ? `(feature: ${feature})` : '');
  return new Stripe(creds.secret_key);
}

// Helper: Get Stripe publishable key for a tenant
async function getStripePublishableKeyForTenant(tenantId, feature) {
  if (!tenantId) {
    console.error('[Stripe] Cannot get publishable key: tenantId is required');
    return null;
  }
  
  const creds = await getStripeCredentials(tenantId, feature);
  
  if (!creds || !creds.publishable_key) {
    return null;
  }
  
  if (!creds.is_enabled) {
    return null;
  }
  
  return creds.publishable_key;
}

// Helper: Get valid Xero access token (refreshes if needed)
// REQUIRES appTenantId for multi-tenant isolation
async function getValidXeroAccessToken(appTenantId) {
  console.log('[Xero] getValidXeroAccessToken called for appTenantId:', appTenantId);
  
  if (!supabase) {
    console.error('[Xero] Supabase not configured');
    throw new Error('Supabase not configured');
  }
  
  if (!appTenantId) {
    console.error('[Xero] appTenantId is required');
    throw new Error('appTenantId is required for Xero token lookup');
  }
  
  const { data: tokens, error: tokenError } = await supabase
    .from('xero_token')
    .select('*')
    .eq('app_tenant_id', appTenantId);

  if (tokenError) {
    console.error('[Xero] Error fetching tokens from database:', tokenError.message);
  }

  if (!tokens || tokens.length === 0) {
    console.error('[Xero] No Xero token found for tenant - authentication required');
    throw new Error('No Xero token found for this tenant. Please authenticate first.');
  }

  const token = tokens[0];
  
  if (token.tenant_id === 'PENDING_SELECTION') {
    throw new Error('Xero authentication incomplete. Please select a Xero organization.');
  }
  
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  console.log(`[Xero] Token expires at: ${expiresAt.toISOString()}, now: ${now.toISOString()}`);

  // Token is still valid
  if (expiresAt > fiveMinutesFromNow) {
    console.log('[Xero] Token is valid, returning existing token');
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  // Refresh token using tenant-scoped credentials
  console.log('[Xero] Token expired or expiring soon, refreshing...');
  
  const xeroCredentials = await getXeroCredentials(appTenantId);
  
  if (!xeroCredentials || !xeroCredentials.client_id || !xeroCredentials.client_secret) {
    console.error('[Xero] Xero credentials not configured for this tenant');
    throw new Error('Xero credentials not configured for this tenant');
  }

  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${xeroCredentials.client_id}:${xeroCredentials.client_secret}`).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }).toString(),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || tokenData.error) {
    console.error('[Xero] Token refresh failed:', JSON.stringify(tokenData));
    throw new Error(`Failed to refresh Xero token: ${JSON.stringify(tokenData)}`);
  }

  console.log('[Xero] Token refreshed successfully');
  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

  await supabase
    .from('xero_token')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq('id', token.id);

  console.log('[Xero] Token updated in database, expires at:', newExpiresAt);
  return { accessToken: tokenData.access_token, tenantId: token.tenant_id };
}

// Helper: Find or create Xero contact
// contactInfo: { name: string, email?: string, isOrganization: boolean }
async function findOrCreateXeroContact(accessToken, tenantId, contactInfo) {
  // Support legacy string-only calls
  const info = typeof contactInfo === 'string' 
    ? { name: contactInfo, email: null, isOrganization: true }
    : contactInfo;
  
  console.log(`[Xero] Finding/creating contact: ${info.name} (${info.isOrganization ? 'organization' : 'individual'})`);
  
  // Search for existing contact by name
  const escapedName = info.name.replace(/"/g, '\\"');
  console.log(`[Xero] Searching for existing contact by name...`);
  
  const contactSearchResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${escapedName}"`)}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json'
      }
    }
  );

  console.log(`[Xero] Contact search response status: ${contactSearchResponse.status}`);

  if (!contactSearchResponse.ok) {
    const errorText = await contactSearchResponse.text();
    console.error(`[Xero] Contact search failed with status ${contactSearchResponse.status}: ${errorText.substring(0, 300)}`);
    throw new Error(`Xero contact search failed (${contactSearchResponse.status})`);
  }

  const searchText = await contactSearchResponse.text();
  let contactData;
  try {
    contactData = JSON.parse(searchText);
  } catch (parseErr) {
    console.error(`[Xero] Contact search response not valid JSON: ${searchText.substring(0, 300)}`);
    throw new Error('Xero contact search returned non-JSON response');
  }

  if (contactData.Contacts && contactData.Contacts.length > 0) {
    console.log(`[Xero] Found existing contact: ${contactData.Contacts[0].ContactID}`);
    return contactData.Contacts[0].ContactID;
  }

  console.log(`[Xero] No existing contact found, creating new contact...`);
  const newContact = { Name: info.name };
  if (info.email) {
    newContact.EmailAddress = info.email;
  }
  
  const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Contacts: [newContact] })
  });

  console.log(`[Xero] Create contact response status: ${createContactResponse.status}`);

  if (!createContactResponse.ok) {
    const errorText = await createContactResponse.text();
    console.error(`[Xero] Create contact failed with status ${createContactResponse.status}: ${errorText.substring(0, 300)}`);
    throw new Error(`Xero contact creation failed (${createContactResponse.status})`);
  }

  const createText = await createContactResponse.text();
  let newContactData;
  try {
    newContactData = JSON.parse(createText);
  } catch (parseErr) {
    console.error(`[Xero] Create contact response not valid JSON: ${createText.substring(0, 300)}`);
    throw new Error('Xero contact creation returned non-JSON response');
  }
  
  if (newContactData.Contacts && newContactData.Contacts.length > 0) {
    console.log(`[Xero] Created new contact: ${newContactData.Contacts[0].ContactID}`);
    return newContactData.Contacts[0].ContactID;
  }

  console.error(`[Xero] Failed to create contact. Response:`, JSON.stringify(newContactData).substring(0, 500));
  throw new Error('Failed to create Xero contact');
}

// Zoom OAuth token is now handled by the shared zoomClient module

// Helper: Send confirmation emails using event_email configuration
// personalizedZoomUrl: Optional attendee-specific Zoom join URL from webinar registration
async function sendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl = null, pricingDetails = null, tenantId = null) {
  return sharedSendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl, pricingDetails, tenantId);
}


async function scheduleBookingReminderEmails(bookingId, eventId, attendeeEmail, ticketClassId) {
  if (!supabase) return;
  
  try {
    const { data: reminderEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .eq('email_type', 'reminder')
      .eq('is_enabled', true);

    if (emailsError || !reminderEmails || reminderEmails.length === 0) {
      console.log('[scheduleBookingReminderEmails] No reminder emails configured for event');
      return;
    }
    
    console.log(`[scheduleBookingReminderEmails] Found ${reminderEmails.length} reminder emails to process`);

    const isComplex = reminderEmails[0]?.is_complex_event || false;

    if (isComplex) {
      await scheduleBookingComplexReminders(bookingId, eventId, attendeeEmail, ticketClassId, reminderEmails);
      return;
    }

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, start_date, title')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.log('[scheduleBookingReminderEmails] No event found');
      return;
    }

    let eventStartMs = null;
    if (event.start_date) {
      let startDateStr = event.start_date;
      if (!startDateStr.endsWith('Z') && !startDateStr.includes('+') && !startDateStr.includes('-', 10)) {
        startDateStr = startDateStr + 'Z';
      }
      const parsedMs = new Date(startDateStr).getTime();
      if (!isNaN(parsedMs)) {
        eventStartMs = parsedMs;
        console.log(`[scheduleBookingReminderEmails] Event start: ${startDateStr}, now: ${new Date().toISOString()}`);
      } else {
        console.error('[scheduleBookingReminderEmails] Invalid event start_date:', event.start_date);
      }
    } else {
      console.log('[scheduleBookingReminderEmails] Event has no start_date; only absolute reminders will be scheduled');
    }
    const nowMs = Date.now();

    for (let i = 0; i < reminderEmails.length; i++) {
      const email = reminderEmails[i];
      console.log(`[scheduleBookingReminderEmails] Processing email ${i + 1}/${reminderEmails.length}: id=${email.id}, timing_type=${email.timing_type}`);

      const isAbsolute = isAbsoluteReminder(email);
      let scheduledTimeMs;
      if (isAbsolute) {
        scheduledTimeMs = calculateScheduledTimeMs(0, email);
      } else {
        if (eventStartMs == null) {
          console.log(`[scheduleBookingReminderEmails] Skipping relative reminder (${email.timing_type}) - event has no start_date`);
          continue;
        }
        scheduledTimeMs = calculateScheduledTimeMs(eventStartMs, email);
      }
      if (scheduledTimeMs == null) continue;
      const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

      if (scheduledTimeMs <= nowMs) {
        console.log(`[scheduleBookingReminderEmails] Skipping reminder (${email.timing_type}) - scheduled time ${scheduledTimeISO} already passed`);
        continue;
      }

      const { data: existing } = await supabase
        .from('scheduled_email')
        .select('id')
        .eq('event_email_id', email.id)
        .eq('booking_id', bookingId)
        .maybeSingle();

      if (existing) {
        console.log(`[scheduleBookingReminderEmails] Reminder already scheduled for booking ${bookingId}, email ${email.id}`);
        continue;
      }

      const { error: insertError } = await supabase
        .from('scheduled_email')
        .insert({
          event_email_id: email.id,
          booking_id: bookingId,
          attendee_email: attendeeEmail,
          scheduled_send_time: scheduledTimeISO,
          status: 'pending'
        });
      
      if (insertError) {
        console.error(`[scheduleBookingReminderEmails] Failed to insert scheduled_email for ${email.timing_type}:`, insertError.message, insertError.code);
        continue;
      }
      
      console.log(`[scheduleBookingReminderEmails] Scheduled ${email.timing_type} reminder for ${scheduledTimeISO}`);
    }

    console.log(`[scheduleBookingReminderEmails] Scheduled reminders for booking ${bookingId}`);
  } catch (err) {
    console.error('[scheduleBookingReminderEmails] Error:', err.message);
  }
}

async function scheduleBookingComplexReminders(bookingId, eventId, attendeeEmail, ticketClassId, reminderEmails) {
  try {
    const { data: sessions, error: sessionsError } = await supabase
      .from('complex_event_session')
      .select('id, title, start_time')
      .eq('complex_event_id', eventId)
      .order('start_time', { ascending: true });

    if (sessionsError || !sessions || sessions.length === 0) {
      console.log('[scheduleBookingComplexReminders] No sessions found for complex event');
      return;
    }

    const sessionIds = sessions.map(s => s.id);
    const { data: junctions } = await supabase
      .from('complex_event_session_track')
      .select('complex_event_session_id, complex_event_track_id')
      .in('complex_event_session_id', sessionIds);

    const sessionTrackMap = {};
    for (const j of (junctions || [])) {
      if (!sessionTrackMap[j.complex_event_session_id]) {
        sessionTrackMap[j.complex_event_session_id] = [];
      }
      sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
    }

    let accessibleSessions = sessions;

    if (ticketClassId) {
      const { data: ticketClass } = await supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .eq('id', ticketClassId)
        .eq('complex_event_id', eventId)
        .maybeSingle();

      if (ticketClass && !ticketClass.all_tracks && ticketClass.linked_track_ids?.length > 0) {
        accessibleSessions = sessions.filter(s => {
          const trackIds = sessionTrackMap[s.id] || [];
          return trackIds.length === 0 || 
            trackIds.some(tid => ticketClass.linked_track_ids.includes(tid));
        });
      }
    }

    console.log(`[scheduleBookingComplexReminders] ${accessibleSessions.length} accessible sessions for booking ${bookingId}`);

    const nowMs = Date.now();

    for (const email of reminderEmails) {
      if (isAbsoluteReminder(email)) {
        const scheduledTimeMs = calculateScheduledTimeMs(0, email);
        if (scheduledTimeMs == null || scheduledTimeMs <= nowMs) {
          console.log(`[scheduleBookingComplexReminders] Skipping absolute reminder - already passed or invalid`);
          continue;
        }
        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .is('session_id', null)
          .maybeSingle();

        if (existing) {
          console.log(`[scheduleBookingComplexReminders] Absolute reminder already scheduled for booking ${bookingId}`);
          continue;
        }

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: null,
            status: 'pending'
          });

        if (insertError) {
          console.error(`[scheduleBookingComplexReminders] Failed to insert absolute reminder:`, insertError.message);
        } else {
          console.log(`[scheduleBookingComplexReminders] Scheduled absolute reminder for booking ${bookingId} at ${scheduledTimeISO}`);
        }
        continue;
      }

      for (const session of accessibleSessions) {
        if (!session.start_time) continue;

        let startTimeStr = session.start_time;
        if (!startTimeStr.endsWith('Z') && !startTimeStr.includes('+') && !startTimeStr.includes('-', 10)) {
          startTimeStr = startTimeStr + 'Z';
        }
        const sessionStartMs = new Date(startTimeStr).getTime();
        if (isNaN(sessionStartMs)) continue;

        const scheduledTimeMs = calculateScheduledTimeMs(sessionStartMs, email);
        if (!scheduledTimeMs) continue;

        if (scheduledTimeMs <= nowMs) {
          console.log(`[scheduleBookingComplexReminders] Skipping session "${session.title}" reminder - already passed`);
          continue;
        }

        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .eq('session_id', session.id)
          .maybeSingle();

        if (existing) {
          console.log(`[scheduleBookingComplexReminders] Reminder already scheduled for booking ${bookingId}, session ${session.id}`);
          continue;
        }

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: session.id,
            status: 'pending'
          });

        if (insertError) {
          console.error(`[scheduleBookingComplexReminders] Failed to insert for session ${session.title}:`, insertError.message);
          continue;
        }

        console.log(`[scheduleBookingComplexReminders] Scheduled reminder for session "${session.title}" at ${scheduledTimeISO}`);
      }
    }

    console.log(`[scheduleBookingComplexReminders] Done scheduling for booking ${bookingId}`);
  } catch (err) {
    console.error('[scheduleBookingComplexReminders] Error:', err.message);
  }
}

function getHoursFromTimingType(timingType, customHours) {
  switch (timingType) {
    case '7_days_before': return 7 * 24;
    case '3_days_before': return 3 * 24;
    case '1_day_before': return 24;
    case '12_hours_before': return 12;
    case '6_hours_before': return 6;
    case '1_hour_before': return 1;
    case '30_minutes_before': return 0.5;
    case 'custom': return customHours || 24;
    default: return 24;
  }
}

function isAbsoluteReminder(email) {
  return (
    email &&
    email.timing_type === 'custom' &&
    email.custom_unit === 'specific_datetime' &&
    !!email.custom_send_at
  );
}

function calculateScheduledTimeMs(referenceMs, email) {
  const { timing_type, custom_hours_before, custom_unit, custom_send_at } = email;

  if (timing_type === 'custom' && custom_unit === 'specific_datetime') {
    if (custom_send_at) {
      return new Date(custom_send_at).getTime();
    }
    return null;
  }

  let hoursBeforeEvent;
  if (timing_type === 'custom') {
    const value = custom_hours_before || 24;
    switch (custom_unit) {
      case 'days': hoursBeforeEvent = value * 24; break;
      case 'minutes': hoursBeforeEvent = value / 60; break;
      case 'hours':
      default: hoursBeforeEvent = value; break;
    }
  } else {
    hoursBeforeEvent = getHoursFromTimingType(timing_type, custom_hours_before);
  }

  return referenceMs - (hoursBeforeEvent * 60 * 60 * 1000);
}

const functionHandlers = {
  async sendMagicLink(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email } = params;
    if (!email) return { success: false, error: 'Email is required' };

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name')
      .eq('email', email.toLowerCase())
      .single();

    if (memberError || !member) {
      return { success: false, error: 'No member found with this email address' };
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const { error: linkError } = await supabase
      .from('magic_link')
      .insert({
        member_id: member.id,
        token,
        email: email.toLowerCase(),
        expires_at: expiresAt.toISOString(),
        used: false
      });

    if (linkError) {
      console.error('Failed to create magic link:', linkError);
      return { success: false, error: 'Failed to create login link' };
    }

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    console.log(`Magic link for ${email}: ${baseUrl}/auth/verify?token=${token}`);

    return { success: true };
  },

  async verifyMagicLink(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { token } = params;
    if (!token) return { success: false, error: 'Token is required' };

    const { data: magicLink, error: linkError } = await supabase
      .from('magic_link')
      .select('*, member(*)')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (linkError || !magicLink) {
      return { success: false, error: 'Invalid or expired link' };
    }

    if (new Date(magicLink.expires_at) < new Date()) {
      return { success: false, error: 'Link has expired' };
    }

    await supabase
      .from('magic_link')
      .update({ used: true })
      .eq('id', magicLink.id);

    return { success: true, member: magicLink.member };
  },

  async validateMember(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email } = params;

    console.log('[validateMember] Validating member:', email);

    if (!email) {
      return { success: false, error: 'Email is required' };
    }

    const { data: allTeamMembers } = await supabase
      .from('team_member')
      .select('*');

    const teamMember = allTeamMembers?.find(
      tm => tm.email === email && tm.is_active === true
    );

    if (teamMember) {
      console.log('[validateMember] Found active TeamMember');
      return {
        success: true,
        member: {
          email: teamMember.email,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          role_id: teamMember.role_id,
          is_team_member: true,
          member_excluded_features: []
        }
      };
    }

    console.log('[validateMember] Not a TeamMember, checking Member entity...');

    const { data: allMembers } = await supabase
      .from('member')
      .select('*');

    let member = allMembers?.find(m => m.email === email);

    if (!member) {
      console.log('[validateMember] Member not found in database');
      return {
        success: false,
        error: 'Email not found. Please check your email address or contact support.'
      };
    }

    console.log('[validateMember] Found Member record');

    // Auto-generate handle if member doesn't have one
    if (!member.handle && member.first_name && member.last_name) {
      console.log('[validateMember] Member has no handle, generating one...');
      
      try {
        const generateSlug = (text) => {
          return text
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        };

        const { data: allMembersForHandles } = await supabase
          .from('member')
          .select('handle');
        
        const existingHandles = new Set(
          (allMembersForHandles || [])
            .map(m => m.handle)
            .filter(h => h !== null)
        );

        let baseHandle = `${generateSlug(member.first_name)}-${generateSlug(member.last_name)}`;
        
        if (baseHandle.length < 3) baseHandle = generateSlug(member.first_name);
        if (baseHandle.length < 3) baseHandle = generateSlug(member.last_name);
        if (baseHandle.length < 3) baseHandle = 'member';
        if (baseHandle.length > 30) baseHandle = baseHandle.substring(0, 30);

        let handle = baseHandle;
        let counter = 1;

        while (existingHandles.has(handle)) {
          const suffix = `-${counter}`;
          const maxBaseLength = 30 - suffix.length;
          handle = baseHandle.substring(0, maxBaseLength) + suffix;
          counter++;
        }

        const { error: updateError } = await supabase
          .from('member')
          .update({ handle })
          .eq('id', member.id);

        if (!updateError) {
          member.handle = handle;
          console.log('[validateMember] Generated and saved handle:', handle);
        } else {
          console.error('[validateMember] Failed to save handle:', updateError);
        }
      } catch (handleError) {
        console.error('[validateMember] Error generating handle:', handleError.message);
      }
    }

    let organizationId = member.organization_id;
    let organizationName = null;
    let trainingFundBalance = 0;
    let programTicketBalances = {};

    if (organizationId) {
      const { data: allOrgs } = await supabase
        .from('organization')
        .select('*');

      const org = allOrgs?.find(o => o.id === organizationId);

      if (org) {
        organizationName = org.name;
        organizationId = org.id;
        trainingFundBalance = org.training_fund_balance || 0;
        programTicketBalances = org.program_ticket_balances || {};
      }
    }

    return {
      success: true,
      member: {
        id: member.id,
        email: member.email,
        first_name: member.first_name,
        last_name: member.last_name,
        handle: member.handle || null,
        organization_id: organizationId,
        organization_name: organizationName,
        training_fund_balance: trainingFundBalance,
        program_ticket_balances: programTicketBalances,
        role_id: member.role_id || null,
        member_excluded_features: member.member_excluded_features || [],
        is_team_member: false
      }
    };
  },

  async getStripePublishableKey(params, req) {
    const tenantContext = await getTenantContext(req);
    const tenantId = tenantContext.tenantId;
    
    if (!tenantId) {
      throw new Error('Unable to determine tenant context');
    }
    
    const feature = params?.feature || null;
    const publishableKey = await getStripePublishableKeyForTenant(tenantId, feature);
    if (!publishableKey) throw new Error('Stripe not configured for this tenant');
    return { publishableKey };
  },

  async createStripePaymentIntent(params, req) {
    const tenantContext = await getTenantContext(req);
    const tenantId = tenantContext.tenantId;
    
    if (!tenantId) {
      throw new Error('Unable to determine tenant context');
    }
    
    const stripe = await getStripeClient(tenantId, 'events');
    if (!stripe) throw new Error('Stripe not configured for this tenant');
    
    const { amount, currency = 'gbp', metadata, memberEmail } = params;

    let stripeCustomer = null;
    if (memberEmail) {
      let customerName;
      if (supabase) {
        const { data: memberData } = await supabase
          .from('member')
          .select('first_name, last_name, organization:organization_id(name)')
          .ilike('email', memberEmail)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (memberData) {
          customerName = [memberData.first_name, memberData.last_name].filter(Boolean).join(' ') || undefined;
        }
      }
      stripeCustomer = await findOrCreateStripeCustomer(stripe, {
        email: memberEmail,
        name: customerName,
        metadata: { tenant_id: tenantId },
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      customer: stripeCustomer?.id || undefined,
      receipt_email: memberEmail || undefined,
      metadata
    });

    return { success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  },

  // Task #1660 — Create a Training Fund top-up purchase.
  // Creates an accounting invoice (Xero/QBO) and either:
  //  - card:    a Stripe PaymentIntent (funds released on confirm), or
  //  - invoice: tracks the amount as PENDING balance until the
  //             reconciliation cron confirms the invoice paid.
  async createTrainingFundPurchase(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    const ctx = await getTenantContext(req);
    const tenantId = ctx?.tenantId;
    if (!tenantId) throw new Error('Unable to determine tenant context');
    if (!ctx?.memberId) throw new Error('You must be signed in as an organisation member to buy funds');

    const {
      amount,
      paymentMethod,
      purchaseOrderNumber = null,
      poToFollow = false,
    } = params || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) throw new Error('Amount must be greater than zero');
    if (paymentMethod !== 'card' && paymentMethod !== 'invoice') {
      throw new Error('paymentMethod must be "card" or "invoice"');
    }

    // Resolve the buying member + their organisation + role.
    const { data: member, error: memberErr } = await supabase
      .from('member')
      .select('id, organization_id, role_id, email, first_name, last_name, tenant_id')
      .eq('id', ctx.memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (memberErr || !member) throw new Error('Member record not found');
    if (!member.organization_id) throw new Error('You must belong to an organisation to buy training funds');

    // RBAC gate — commerce.balances.buy-funds.
    if (member.role_id) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', member.role_id)
        .maybeSingle();
      const excluded = Array.isArray(role?.excluded_features) ? role.excluded_features : [];
      if (isResourceExcluded(excluded, 'commerce.balances.buy-funds')) {
        const err = new Error('You do not have permission to buy training funds');
        err.statusCode = 403;
        throw err;
      }
    }

    // Load org for invoice contact details.
    const { data: org, error: orgErr } = await supabase
      .from('organization')
      .select('id, name, invoicing_email, training_fund_pending_balance, tenant_id')
      .eq('id', member.organization_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (orgErr || !org) throw new Error('Organisation not found');

    // Resolve accounting provider (Xero/QBO). Hard-fail if none connected.
    const provider = await getAccountingProvider(tenantId);
    if (!provider || provider.name === 'none') {
      throw new Error('No accounting package is connected. Connect Xero or QuickBooks before buying funds.');
    }

    // Create the purchase row first (pending) so we have an id to reference.
    const nowIso = new Date().toISOString();
    const { data: purchase, error: insertErr } = await supabase
      .from('training_fund_purchase')
      .insert({
        tenant_id: tenantId,
        organization_id: org.id,
        amount: amt,
        payment_method: paymentMethod,
        purchase_order_number: purchaseOrderNumber || null,
        po_to_follow: !!poToFollow,
        status: 'pending',
        created_by: member.id,
        created_date: nowIso,
      })
      .select('*')
      .single();
    if (insertErr || !purchase) {
      throw new Error(`Failed to create purchase: ${insertErr?.message || 'unknown error'}`);
    }

    // Create the accounting invoice.
    const poSuffix = purchaseOrderNumber ? ` (PO: ${purchaseOrderNumber})` : (poToFollow ? ' (PO to follow)' : '');
    let invoice;
    try {
      invoice = await provider.createMembershipInvoice({
        appTenantId: tenantId,
        organizationName: org.name,
        invoicingEmail: org.invoicing_email || null,
        invoicingAddress: null,
        membershipYear: '',
        tierLabel: 'Training Fund',
        finalCost: amt,
        currency: 'GBP',
        reference: purchaseOrderNumber || 'Training Fund top-up',
        vatRate: null,
        markAsPaid: false,
        stripePaymentIntentId: null,
        invoiceDescription: `Training Fund top-up${poSuffix}`,
      });
    } catch (err) {
      // Roll back the purchase row so the org isn't left with an orphan.
      await supabase.from('training_fund_purchase').delete().eq('id', purchase.id);
      throw new Error(`Failed to create invoice: ${err.message}`);
    }

    const invoiceColumns = buildInvoiceColumnUpdate(invoice);
    const purchaseUpdate = {
      ...invoiceColumns,
      online_invoice_url: invoice?.onlineInvoiceUrl || invoice?.online_invoice_url || null,
    };

    if (paymentMethod === 'card') {
      // Create a Stripe PaymentIntent. Funds released on confirm.
      const stripe = await getStripeClient(tenantId, 'events');
      if (!stripe) {
        await supabase.from('training_fund_purchase').delete().eq('id', purchase.id);
        throw new Error('Stripe is not configured for this tenant');
      }

      const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
      let stripeCustomer = null;
      if (member.email) {
        stripeCustomer = await findOrCreateStripeCustomer(stripe, {
          email: member.email,
          name: memberName,
          metadata: { tenant_id: tenantId },
        });
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amt * 100),
        currency: 'gbp',
        customer: stripeCustomer?.id || undefined,
        receipt_email: member.email || undefined,
        metadata: {
          payment_type: 'training_fund_purchase',
          purchase_id: purchase.id,
          tenant_id: tenantId,
          organization_id: org.id,
        },
      });

      purchaseUpdate.stripe_payment_intent_id = paymentIntent.id;
      await supabase
        .from('training_fund_purchase')
        .update(purchaseUpdate)
        .eq('id', purchase.id);

      const publishableKey = await getStripePublishableKeyForTenant(tenantId, 'events');

      return {
        success: true,
        purchaseId: purchase.id,
        paymentMethod: 'card',
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        publishableKey,
      };
    }

    // Invoice method — track the amount as pending balance.
    await supabase
      .from('training_fund_purchase')
      .update(purchaseUpdate)
      .eq('id', purchase.id);

    const { error: pendingErr } = await supabase.rpc('increment_org_training_fund_pending', {
      p_org_id: org.id,
      p_delta: amt,
    });
    if (pendingErr) {
      throw new Error(`Failed to update pending balance: ${pendingErr.message}`);
    }

    return {
      success: true,
      purchaseId: purchase.id,
      paymentMethod: 'invoice',
      invoiceNumber: invoice?.invoiceNumber || invoice?.invoice_number || null,
      onlineInvoiceUrl: purchaseUpdate.online_invoice_url,
    };
  },

  // Task #1660 — Confirm a card Training Fund purchase after Stripe payment.
  // Verifies the PaymentIntent, applies the payment to the accounting
  // invoice, then credits the org's available balance (idempotent).
  async confirmTrainingFundPurchasePayment(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    const { purchaseId, paymentIntentId } = params || {};
    if (!purchaseId || !paymentIntentId) {
      return { success: false, error: 'Missing purchaseId or paymentIntentId' };
    }

    // Require an authenticated member in a usable tenant context — this is a
    // financial state-transition endpoint and must not be callable anonymously.
    const ctx = await getTenantContext(req);
    const tenantId = ctx?.tenantId;
    if (!tenantId) throw new Error('Unable to determine tenant context');
    if (!ctx?.memberId) throw new Error('You must be signed in to confirm this payment');

    const { data: purchase } = await supabase
      .from('training_fund_purchase')
      .select('*')
      .eq('id', purchaseId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!purchase) return { success: false, error: 'Purchase not found' };

    // The confirming member must belong to the org that owns the purchase and
    // hold the buy-funds permission.
    const { data: member, error: memberErr } = await supabase
      .from('member')
      .select('id, organization_id, role_id')
      .eq('id', ctx.memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (memberErr || !member) throw new Error('Member record not found');
    if (member.organization_id !== purchase.organization_id) {
      const err = new Error('You do not have permission to confirm this payment');
      err.statusCode = 403;
      throw err;
    }
    if (member.role_id) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', member.role_id)
        .maybeSingle();
      const excluded = Array.isArray(role?.excluded_features) ? role.excluded_features : [];
      if (isResourceExcluded(excluded, 'commerce.balances.buy-funds')) {
        const err = new Error('You do not have permission to confirm this payment');
        err.statusCode = 403;
        throw err;
      }
    }

    const stripe = await getStripeClient(purchase.tenant_id, 'events');
    if (!stripe) throw new Error('Stripe not configured for this tenant');

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return { success: false, error: `Payment not confirmed. Status: ${paymentIntent.status}` };
    }

    const metadataMatch = String(paymentIntent.metadata?.purchase_id) === String(purchaseId);
    const storedMatch = purchase.stripe_payment_intent_id === paymentIntentId;
    if (!metadataMatch && !storedMatch) {
      return { success: false, error: 'Payment verification failed - purchase mismatch' };
    }

    if (purchase.status !== 'pending') {
      return { success: true, message: 'Purchase already processed', purchaseId };
    }

    const paidAt = new Date().toISOString();

    // Best-effort: mark the accounting invoice paid. The card payment has
    // already succeeded, so a failure here must NOT block crediting funds.
    const invoiceId = purchase.accounting_invoice_id || purchase.xero_invoice_id;
    if (invoiceId) {
      try {
        const provider = purchase.accounting_provider
          ? getAccountingProviderByName(purchase.accounting_provider)
          : await getAccountingProvider(purchase.tenant_id);
        await provider.applyStripePaymentToInvoice({
          appTenantId: purchase.tenant_id,
          xeroInvoiceId: invoiceId,
          invoiceId,
          stripePaymentIntentId: paymentIntentId,
        });
      } catch (err) {
        console.error(`[confirmTrainingFundPurchasePayment] Failed to apply payment to invoice for purchase ${purchaseId}: ${err.message}`);
      }
    }

    // Credit the fund (compare-and-set; idempotent).
    const result = await creditTrainingFundForPurchase({
      purchaseId,
      paidAt,
      source: 'stripe_confirm',
    });

    return {
      success: true,
      purchaseId,
      credited: result.credited,
      balanceAfter: result.balanceAfter ?? null,
    };
  },

  async refreshMemberBalance(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email } = params;
    if (!email) return { error: 'Email required' };

    // Find member in local database
    const { data: member } = await supabase
      .from('member')
      .select('*, organization:organization_id(*)')
      .ilike('email', email)
      .single();

    if (!member) {
      return { error: 'Member not found', searchedEmail: email };
    }

    // Return balance from local organization record
    if (member.organization) {
      return {
        success: true,
        training_fund_balance: member.organization.training_fund_balance || 0,
        organization_name: member.organization.name
      };
    }

    return { success: true, training_fund_balance: 0 };
  },

  async syncMemberFromCRM() {
    return { success: true, message: 'Use validateMember instead for CRM sync' };
  },

  async generateMemberHandles(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { member_email, member_id, generate_all } = params;

    const generateHandle = (firstName, lastName) => {
      const first = (firstName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const last = (lastName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const random = Math.random().toString(36).substring(2, 6);
      return `${first}${last}${random}`;
    };

    if (generate_all) {
      const { data: members } = await supabase
        .from('member')
        .select('id, first_name, last_name, handle')
        .is('handle', null);

      if (!members || members.length === 0) {
        return { success: true, message: 'No members without handles found', updated: 0 };
      }

      let updated = 0;
      for (const member of members) {
        const handle = generateHandle(member.first_name, member.last_name);
        await supabase
          .from('member')
          .update({ handle })
          .eq('id', member.id);
        updated++;
      }

      return { success: true, message: `Generated handles for ${updated} members`, updated };
    }

    let memberId = member_id;
    if (!memberId && member_email) {
      const { data: member } = await supabase
        .from('member')
        .select('id, first_name, last_name')
        .ilike('email', member_email)
        .single();
      
      if (!member) {
        return { success: false, error: 'Member not found' };
      }
      memberId = member.id;
    }

    if (!memberId) {
      return { success: false, error: 'member_id or member_email required' };
    }

    const { data: member } = await supabase
      .from('member')
      .select('id, first_name, last_name')
      .eq('id', memberId)
      .single();

    if (!member) {
      return { success: false, error: 'Member not found' };
    }

    const handle = generateHandle(member.first_name, member.last_name);
    await supabase
      .from('member')
      .update({ handle })
      .eq('id', member.id);

    return { success: true, handle };
  },

  async validateColleague(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email, memberEmail, organizationId } = params;

    if (!email || !organizationId) {
      return { valid: false, error: 'Missing required parameters' };
    }

    // Get the organization and tenant for dynamic messaging
    const { data: targetOrg } = await supabase
      .from('organization')
      .select('*, tenant:tenant_id(name)')
      .eq('id', organizationId)
      .single();
    
    const tenantName = targetOrg?.tenant?.name || 'We';

    // Check if colleague already exists as a member in the local database
    const { data: existingMember } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, organization_id')
      .ilike('email', email)
      .maybeSingle();

    if (existingMember) {
      // Check if member belongs to the same organization
      if (existingMember.organization_id !== organizationId) {
        return {
          valid: false,
          status: 'wrong_organization',
          error: `A ticket will be sent shortly. This email address cannot be verified, ${tenantName} will be in touch.`
        };
      }

      return {
        valid: true,
        status: 'verified',
        first_name: existingMember.first_name,
        last_name: existingMember.last_name,
        member_id: existingMember.id
      };
    }

    // Check email domain against organization's allowed domains
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (!emailDomain) {
      return { valid: false, status: 'invalid_email', error: 'Invalid email format' };
    }

    if (targetOrg?.email_domains) {
      const orgDomains = targetOrg.email_domains.map(d => d.toLowerCase());
      if (orgDomains.includes(emailDomain)) {
        return {
          valid: true,
          status: 'domain_match',
          message: 'Email domain matches organization'
        };
      }
    }

    return {
      valid: true,
      status: 'external',
      message: `A ticket will be sent shortly. This email address cannot be verified, ${tenantName} will be in touch.`
    };
  },

  async createBooking(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const {
      eventId,
      memberEmail,
      attendees,
      registrationMode,
      numberOfLinks = 0,
      ticketsRequired,
      programTag,
      thirdPartyConsent = null
    } = params;

    if (!eventId || !memberEmail) {
      return { success: false, error: 'Missing required parameters: eventId and memberEmail' };
    }

    // Use case-insensitive email lookup
    const normalizedEmail = memberEmail.toLowerCase();
    console.log('[createBooking] Looking up member with email:', normalizedEmail);
    
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (memberError) {
      console.error('[createBooking] Member query error:', memberError);
      return { success: false, error: 'Database error looking up member' };
    }

    if (!member) {
      console.log('[createBooking] Member not found for email:', normalizedEmail);
      return { success: false, error: 'Member not found' };
    }
    
    console.log('[createBooking] Found member:', member.id, member.email);

    // Direct event lookup by ID
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .maybeSingle();

    if (eventError) {
      console.error('[createBooking] Event query error:', eventError);
      return { success: false, error: 'Database error looking up event' };
    }

    if (!event) {
      console.log('[createBooking] Event not found for id:', eventId);
      return { success: false, error: 'Event not found' };
    }
    
    console.log('[createBooking] Found event:', event.id, event.title);

    // Block registration for closed events (event_state or legacy status='closed' when event_state is null, or past registration deadline)
    if (event.event_state === 'closed' || (!event.event_state && event.status === 'closed')) {
      console.log('[createBooking] Blocking registration - event is closed:', eventId);
      return { success: false, error: 'Registration is closed for this event' };
    }

    // Block registration once an admin has started the safe-deletion flow
    // (status='cancelling'). This prevents racing a refund pipeline against
    // a brand-new charge. See task-700 / api/_lib/eventDeletion.js.
    if (event.status === 'cancelling') {
      console.log('[createBooking] Blocking registration - event is being cancelled:', eventId);
      return { success: false, error: 'This event is being cancelled and is no longer accepting bookings' };
    }

    if (event.registration_closes_at && new Date() > new Date(event.registration_closes_at)) {
      console.log('[createBooking] Blocking registration - past registration deadline:', eventId);
      return { success: false, error: 'Registration deadline has passed for this event' };
    }

    if (!programTag || !event.program_tag) {
      return { success: false, error: 'This event does not have a program association' };
    }

    if (!member.organization_id) {
      console.log('[createBooking] Member has no organization_id');
      return { success: false, error: 'Member does not have an associated organization' };
    }

    console.log('[createBooking] Looking up organization:', member.organization_id);
    
    // Look up organization by ID
    let { data: org, error: orgError } = await supabase
      .from('organization')
      .select('*')
      .eq('id', member.organization_id)
      .maybeSingle();

    if (!org) {
      console.log('[createBooking] Organization not found for id:', member.organization_id);
      return { success: false, error: 'Organization not found' };
    }
    
    console.log('[createBooking] Found organization:', org.id, org.name);

    const currentBalances = org.program_ticket_balances || {};
    const currentBalance = currentBalances[programTag] || 0;

    if (currentBalance < ticketsRequired) {
      return { success: false, error: `Insufficient program tickets. Required: ${ticketsRequired}, Available: ${currentBalance}` };
    }

    const bookingReference = `BK${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const createdBookings = [];
    const zoomRegistrationResults = [];

    // Helper: Check if event is a Zoom event
    const isZoomEvent = (evt) => {
      if (!evt.location) return false;
      const location = evt.location.toLowerCase();
      return location.includes('zoom.us') || 
             (location.startsWith('online') && location.includes('zoom'));
    };

    // Helper: Extract Zoom URL from location
    const extractZoomUrl = (location) => {
      if (!location) return null;
      const urlMatch = location.match(/https?:\/\/[^\s]+zoom[^\s]*/i);
      return urlMatch ? urlMatch[0] : null;
    };

    // Helper: Extract Zoom webinar ID from URL
    const extractZoomWebinarId = (url) => {
      if (!url) return null;
      // Match patterns like /j/82859217632 or /w/82859217632
      const match = url.match(/\/[jw]\/(\d+)/);
      return match ? match[1] : null;
    };

    // Helper: Find webinar by event location
    const findWebinarByLocation = async (eventLocation) => {
      console.log('[createBooking] Event location:', eventLocation);
      
      const zoomUrl = extractZoomUrl(eventLocation);
      console.log('[createBooking] Extracted Zoom URL:', zoomUrl);
      
      if (!zoomUrl) {
        console.log('[createBooking] Could not extract Zoom URL from location');
        return null;
      }
      
      // Extract Zoom webinar ID from the URL for more reliable matching
      const eventWebinarId = extractZoomWebinarId(zoomUrl);
      console.log('[createBooking] Extracted webinar ID from event:', eventWebinarId);
      
      // Fetch all webinars (scheduled and synced)
      const { data: webinars, error } = await supabase
        .from('zoom_webinar')
        .select('*');
      
      if (error || !webinars) {
        console.error('[createBooking] Error fetching webinars:', error);
        return null;
      }
      
      console.log('[createBooking] Found', webinars.length, 'webinars in database');
      
      // Log all webinars for debugging
      webinars.forEach((w, i) => {
        console.log(`[createBooking] Webinar ${i+1}: id=${w.id}, zoom_id=${w.zoom_webinar_id}, status=${w.status}, join_url=${w.join_url?.substring(0, 50)}...`);
      });
      
      // Try to match by webinar ID first (most reliable)
      if (eventWebinarId) {
        const matchByZoomId = webinars.find(w => w.zoom_webinar_id?.toString() === eventWebinarId);
        if (matchByZoomId) {
          console.log('[createBooking] Found webinar by Zoom ID match:', matchByZoomId.id, matchByZoomId.topic);
          return matchByZoomId;
        }
        
        // Also check join_url for the ID
        const matchByJoinUrlId = webinars.find(w => {
          const joinUrlId = extractZoomWebinarId(w.join_url);
          return joinUrlId === eventWebinarId;
        });
        if (matchByJoinUrlId) {
          console.log('[createBooking] Found webinar by join_url ID match:', matchByJoinUrlId.id, matchByJoinUrlId.topic);
          return matchByJoinUrlId;
        }
      }
      
      // Fallback: Try URL substring matching
      const normalizeUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      const normalizedZoomUrl = normalizeUrl(zoomUrl);
      
      const matchingWebinar = webinars.find((w) => {
        if (!w.join_url) return false;
        const normalizedJoinUrl = normalizeUrl(w.join_url);
        return normalizedZoomUrl.includes(normalizedJoinUrl) || normalizedJoinUrl.includes(normalizedZoomUrl);
      });
      
      if (matchingWebinar) {
        console.log('[createBooking] Found matching webinar by URL:', matchingWebinar.id, matchingWebinar.topic);
      } else {
        console.log('[createBooking] No matching webinar found for URL:', zoomUrl);
        console.log('[createBooking] Event webinar ID:', eventWebinarId);
      }
      
      return matchingWebinar || null;
    };

    // Helper: Register attendee with Zoom (uses same logic as /api/zoom/webinars/[id]/registrants)
    const registerWithZoom = async (webinar, attendee) => {
      try {
        // Use the database ID (webinar.id) for logging
        console.log(`[createBooking] registerWithZoom called for webinar db_id=${webinar.id}, zoom_id=${webinar.zoom_webinar_id}`);
        
        if (!webinar.zoom_webinar_id) {
          console.log(`[createBooking] Webinar not synced with Zoom (no zoom_webinar_id)`);
          return { success: false, error: 'Webinar not synced with Zoom' };
        }
        
        if (!webinar.registration_required) {
          console.log(`[createBooking] Registration not required for webinar ${webinar.zoom_webinar_id} - skipping`);
          return { success: true, skipped: true, reason: 'Registration not required' };
        }
        
        if (webinar.status !== 'scheduled') {
          console.log(`[createBooking] Webinar status is '${webinar.status}', not 'scheduled'`);
          return { success: false, error: `Webinar status is ${webinar.status}` };
        }
        
        if (new Date(webinar.start_time) <= new Date()) {
          console.log(`[createBooking] Webinar has already started (${webinar.start_time})`);
          return { success: false, error: 'Webinar has already started' };
        }
        
        console.log(`[createBooking] Getting Zoom access token for tenant ${webinar.tenant_id}...`);
        const token = await getZoomAccessTokenForTenant(webinar.tenant_id);
        console.log(`[createBooking] Got token, registering ${attendee.email} for webinar ${webinar.zoom_webinar_id}`);
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              first_name: attendee.first_name,
              last_name: attendee.last_name,
              email: attendee.email,
              auto_approve: true
            })
          }
        );
        
        console.log(`[createBooking] Zoom API response status: ${zoomResponse.status}`);
        
        if (!zoomResponse.ok) {
          const errorData = await zoomResponse.json().catch(() => ({}));
          console.error(`[createBooking] Zoom registration error for ${attendee.email}:`, JSON.stringify(errorData));
          
          if (errorData.code === 3027) {
            console.log(`[createBooking] ${attendee.email} already registered`);
            return { success: true, already_registered: true };
          }
          
          return { success: false, error: errorData.message || 'Zoom registration failed', code: errorData.code };
        }
        
        const zoomData = await zoomResponse.json();
        console.log(`[createBooking] ✓ Registered ${attendee.email}, registrant_id: ${zoomData.registrant_id}, join_url: ${zoomData.join_url}`);
        
        return { success: true, registrant_id: zoomData.registrant_id, join_url: zoomData.join_url };
      } catch (err) {
        console.error(`[createBooking] Zoom registration exception for ${attendee.email}:`, err.message);
        return { success: false, error: err.message };
      }
    };

    // Determine event type and handle accordingly
    // Priority: 1) Direct zoom_webinar_id link, 2) URL matching fallback, 3) Backstage event
    const eventIsBackstage = !!event.backstage_event_id;
    let eventIsZoom = false;
    let matchingWebinar = null;

    // First, check for direct zoom_webinar_id link (preferred method)
    if (event.zoom_webinar_id && !eventIsBackstage) {
      console.log('[createBooking] Event has direct zoom_webinar_id:', event.zoom_webinar_id);
      
      const { data: webinarById, error: webinarError } = await supabase
        .from('zoom_webinar')
        .select('*')
        .eq('id', event.zoom_webinar_id)
        .single();
      
      if (webinarById && !webinarError) {
        matchingWebinar = webinarById;
        eventIsZoom = true;
        console.log('[createBooking] Found linked webinar:', matchingWebinar.topic, 'zoom_id:', matchingWebinar.zoom_webinar_id);
      } else {
        console.log('[createBooking] Failed to fetch linked webinar:', webinarError?.message);
      }
    }
    // Fallback: Try URL matching if no direct link and location contains zoom.us
    else if (!eventIsBackstage && isZoomEvent(event)) {
      console.log('[createBooking] No direct link, trying URL matching from location:', event.location);
      matchingWebinar = await findWebinarByLocation(event.location);
      eventIsZoom = !!matchingWebinar;
    }

    // Register attendees with Zoom if we found a webinar
    if (eventIsZoom && matchingWebinar && (registrationMode === 'self' || registrationMode === 'colleagues')) {
      console.log('[createBooking] Will register attendees with Zoom webinar:', matchingWebinar.zoom_webinar_id);
      
      for (const attendee of (attendees || [])) {
        const result = await registerWithZoom(matchingWebinar, {
          email: attendee.email,
          first_name: attendee.first_name || 'Guest',
          last_name: attendee.last_name || 'Attendee'
        });
        zoomRegistrationResults.push({ email: attendee.email, ...result });
      }
    } else if (eventIsZoom && !matchingWebinar) {
      console.log('[createBooking] Event detected as Zoom but no matching webinar found');
    }

    // Determine booking status based on event type
    let bookingStatus = 'confirmed';
    if (eventIsBackstage) {
      bookingStatus = 'pending_backstage_sync';
    } else if (eventIsZoom && matchingWebinar) {
      bookingStatus = 'confirmed';
    }

    if (registrationMode === 'self' || registrationMode === 'colleagues') {
      const attendeeList = attendees || [];
      for (let i = 0; i < attendeeList.length; i++) {
        const attendee = attendeeList[i];
        // Find corresponding Zoom registration result
        const zoomResult = zoomRegistrationResults.find(r => r.email === attendee.email);
        
        // Generate unique booking reference for each attendee
        const attendeeBookingRef = attendeeList.length > 1 
          ? `${bookingReference}-${i + 1}` 
          : bookingReference;
        
        const bookingData = {
          event_id: eventId,
          member_id: member.id,
          attendee_email: attendee.email,
          attendee_first_name: attendee.first_name,
          attendee_last_name: attendee.last_name,
          ticket_price: event.ticket_price || 0,
          booking_reference: attendeeBookingRef,
          booking_group_reference: bookingReference, // Base reference to group all attendees
          status: bookingStatus,
          payment_method: 'program_ticket',
          third_party_consent: (event.pricing_config?.collectThirdPartyConsent === true && typeof thirdPartyConsent === 'boolean') ? thirdPartyConsent : null,
          ...sanitizeOptionSelections(attendee, event),
          created_at: new Date().toISOString()
        };

        // Add Zoom registrant ID if available
        if (zoomResult?.registrant_id) {
          bookingData.zoom_registrant_id = zoomResult.registrant_id;
        }

        const { data: booking } = await supabase
          .from('booking')
          .insert(bookingData)
          .select()
          .single();

        if (booking) createdBookings.push(booking);
      }
    } else if (registrationMode === 'links') {
      for (let i = 0; i < numberOfLinks; i++) {
        const confirmationToken = crypto.randomUUID();
        
        // Generate unique booking reference for each link
        const linkBookingRef = numberOfLinks > 1 
          ? `${bookingReference}-${i + 1}` 
          : bookingReference;

        const { data: booking } = await supabase
          .from('booking')
          .insert({
            event_id: eventId,
            member_id: member.id,
            attendee_email: '',
            attendee_first_name: '',
            attendee_last_name: '',
            ticket_price: event.ticket_price || 0,
            booking_reference: linkBookingRef,
            booking_group_reference: bookingReference, // Base reference to group all links
            status: 'pending',
            payment_method: 'program_ticket',
            confirmation_token: confirmationToken,
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        if (booking) createdBookings.push(booking);
      }
    }

    const newBalance = currentBalance - ticketsRequired;
    const updatedBalances = { ...currentBalances, [programTag]: newBalance };

    await supabase
      .from('organization')
      .update({ program_ticket_balances: updatedBalances, last_synced: new Date().toISOString() })
      .eq('id', org.id);

    await supabase
      .from('program_ticket_transaction')
      .insert({
        organization_id: org.id,
        program_name: programTag,
        transaction_type: 'usage',
        quantity: ticketsRequired,
        booking_reference: bookingReference,
        event_name: event.title || 'Unknown Event',
        member_email: memberEmail,
        notes: `Used ${ticketsRequired} ${programTag} ticket(s) for ${event.title || 'event'}`
      });

    // Send confirmation emails using event_email configuration
    const emailResults = [];
    console.log('[createBooking] Sending confirmation emails to attendees...');
    
    for (const booking of createdBookings) {
      const attendee = (attendees || []).find(a => a.email === booking.attendee_email);
      // Get personalized Zoom join URL from registration results if available
      const zoomResult = zoomRegistrationResults.find(r => r.email === booking.attendee_email);
      const personalizedZoomUrl = zoomResult?.join_url || null;
      const results = await sendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl);
      emailResults.push(...results);
    }
    
    if (emailResults.length > 0) {
      console.log(`[createBooking] Sent ${emailResults.filter(r => r.success).length}/${emailResults.length} confirmation emails`);
    }

    // Build response based on event type
    const response = {
      success: true,
      booking_reference: bookingReference,
      bookings: createdBookings,
      tickets_used: ticketsRequired,
      remaining_balance: newBalance,
      event_type: eventIsZoom ? 'zoom' : eventIsBackstage ? 'backstage' : 'regular'
    };

    // Add confirmation email results
    if (emailResults.length > 0) {
      response.confirmation_emails = {
        results: emailResults,
        sent: emailResults.filter(r => r.success).length,
        failed: emailResults.filter(r => !r.success).length
      };
    }

    if (eventIsZoom || event.zoom_webinar_id) {
      // Extract webinar ID from location for diagnostics (fallback method)
      const extractedWebinarId = extractZoomWebinarId(event.location);
      
      response.zoom_registration = {
        webinar_found: !!matchingWebinar,
        registrations: zoomRegistrationResults,
        debug: {
          event_zoom_webinar_id: event.zoom_webinar_id || null,
          event_location: event.location,
          extracted_webinar_id: extractedWebinarId,
          webinar_matched_id: matchingWebinar?.zoom_webinar_id || null,
          match_method: event.zoom_webinar_id ? 'direct_link' : (matchingWebinar ? 'url_matching' : 'none')
        }
      };
      if (!matchingWebinar && event.zoom_webinar_id) {
        response.warning = `Zoom webinar not found - event has zoom_webinar_id "${event.zoom_webinar_id}" but fetch failed`;
      } else if (!matchingWebinar) {
        response.warning = `Zoom webinar not found - extracted ID "${extractedWebinarId}" from location "${event.location}"`;
      }
    } else if (eventIsBackstage) {
      response.warning = 'Backstage sync not performed in serverless mode - admin may need to sync manually';
    }

    console.log('[createBooking] Booking complete:', response);
    return response;
  },

  async checkDuplicateRegistrations(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { eventId, attendeeEmails } = params;
    
    if (!eventId || !attendeeEmails || !Array.isArray(attendeeEmails) || attendeeEmails.length === 0) {
      return { success: true, duplicates: [] };
    }
    
    // Normalize emails to lowercase for comparison
    const normalizedEmails = attendeeEmails.map(email => email.toLowerCase().trim());
    
    // Check for existing confirmed bookings for this event with these attendee emails
    const { data: existingBookings, error } = await supabase
      .from('booking')
      .select('attendee_email, attendee_first_name, attendee_last_name, status')
      .eq('event_id', eventId)
      .in('status', ['confirmed', 'pending'])
      .in('attendee_email', normalizedEmails);
    
    if (error) {
      console.error('[checkDuplicateRegistrations] Error:', error);
      return { success: false, error: error.message };
    }
    
    // Build list of duplicates with attendee info
    const duplicates = existingBookings.map(booking => ({
      email: booking.attendee_email,
      name: `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim() || booking.attendee_email,
      status: booking.status
    }));
    
    return {
      success: true,
      hasDuplicates: duplicates.length > 0,
      duplicates
    };
  },

  async createOneOffEventBooking(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const {
      eventId,
      memberEmail,
      attendees,
      registrationMode,
      ticketsRequired,
      totalCost,
      pricingDetails,
      selectedVoucherIds = [],
      trainingFundAmount = 0,
      accountAmount = 0,
      purchaseOrderNumber = null,
      poToFollow = false,
      paymentMethod = 'account',
      stripePaymentIntentId = null,
      ticketClassId = null,
      ticketClassName = null,
      ticketClassPrice = null,
      isGuestBooking = false,
      guestInfo = null,
      discountCodeId = null,
      discountCodeAmount = 0,
      donationData = null,
      thirdPartyConsent = null,
      _testMode = false
    } = params;

    console.log('[createOneOffEventBooking] Starting booking:', {
      eventId,
      memberEmail,
      ticketsRequired,
      totalCost,
      paymentMethod,
      ticketClassId,
      ticketClassName,
      attendeesReceived: attendees?.length || 0,
      attendeesData: JSON.stringify(attendees),
      isGuestBooking,
      guestInfo: guestInfo ? { email: guestInfo.email, first_name: guestInfo.first_name } : null,
      discountCodeId,
      discountCodeAmount
    });

    // Validate required fields - for guest bookings, require guestInfo instead of memberEmail
    if (!eventId || !ticketsRequired) {
      console.log('[createOneOffEventBooking] VALIDATION FAILED - Missing eventId or ticketsRequired:', { eventId, ticketsRequired });
      return { success: false, error: `Missing required parameters: eventId=${eventId}, ticketsRequired=${ticketsRequired}` };
    }
    
    if (!isGuestBooking && !memberEmail) {
      console.log('[createOneOffEventBooking] VALIDATION FAILED - Member booking without memberEmail');
      return { success: false, error: 'Missing required parameter: memberEmail (for member bookings)' };
    }
    
    if (isGuestBooking && (!guestInfo || !guestInfo.email || !guestInfo.first_name || !guestInfo.last_name)) {
      console.log('[createOneOffEventBooking] VALIDATION FAILED - Guest booking missing guestInfo:', {
        hasGuestInfo: !!guestInfo,
        email: guestInfo?.email,
        first_name: guestInfo?.first_name,
        last_name: guestInfo?.last_name
      });
      return { success: false, error: `Missing required guest information: email=${guestInfo?.email}, first_name=${guestInfo?.first_name}, last_name=${guestInfo?.last_name}` };
    }
    
    // For guest bookings, create attendee from guestInfo if no attendees provided
    let bookingAttendees = attendees;
    if (isGuestBooking && (!attendees || attendees.length === 0)) {
      bookingAttendees = [{
        email: guestInfo.email,
        first_name: guestInfo.first_name,
        last_name: guestInfo.last_name,
        organization: guestInfo.organization,
        phone: guestInfo.phone,
        job_title: guestInfo.job_title,
        dietary_selections: guestInfo.dietary_selections,
        allergy_selections: guestInfo.allergy_selections,
        accessibility_selections: guestInfo.accessibility_selections,
        isGuest: true
      }];
    }
    
    // Validate attendees array
    if (!bookingAttendees || !Array.isArray(bookingAttendees) || bookingAttendees.length === 0) {
      console.error('[createOneOffEventBooking] No attendees provided:', { attendees: bookingAttendees });
      return { success: false, error: 'No attendees provided' };
    }

    // Get event details first (needed for tenant scoping)
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.error('[createOneOffEventBooking] Event query error:', eventError);
      return { success: false, error: 'Event not found' };
    }

    // Block registration for closed events (event_state or legacy status='closed' when event_state is null, or past registration deadline)
    if (event.event_state === 'closed' || (!event.event_state && event.status === 'closed')) {
      console.log('[createOneOffEventBooking] Blocking registration - event is closed:', eventId);
      return { success: false, error: 'Registration is closed for this event' };
    }

    // Block registration once an admin has started the safe-deletion flow
    // (status='cancelling'). See task-700 / api/_lib/eventDeletion.js.
    if (event.status === 'cancelling') {
      console.log('[createOneOffEventBooking] Blocking registration - event is being cancelled:', eventId);
      return { success: false, error: 'This event is being cancelled and is no longer accepting bookings' };
    }

    if (event.registration_closes_at && new Date() > new Date(event.registration_closes_at)) {
      console.log('[createOneOffEventBooking] Blocking registration - past registration deadline:', eventId);
      return { success: false, error: 'Registration deadline has passed for this event' };
    }

    // Get member details (skip for guest bookings)
    let member = null;
    let org = null;
    
    if (!isGuestBooking) {
      let memberQuery = supabase
        .from('member')
        .select('*')
        .ilike('email', memberEmail.toLowerCase());
      
      if (event.tenant_id) {
        memberQuery = memberQuery.eq('tenant_id', event.tenant_id);
      }
      
      const { data: memberData, error: memberError } = await memberQuery.maybeSingle();
      
      if (memberError || !memberData) {
        console.error('[createOneOffEventBooking] Member query error:', memberError);
        return { success: false, error: 'Member not found' };
      }
      
      member = memberData;
      console.log('[createOneOffEventBooking] Member found:', member.id, member.email);
      
      // Get organization if member has one (optional - some members like Alumni may not have an org)
      if (member.organization_id) {
        const { data: orgData, error: orgError } = await supabase
          .from('organization')
          .select('*')
          .eq('id', member.organization_id)
          .single();

        if (!orgError && orgData) {
          org = orgData;
          console.log('[createOneOffEventBooking] Organization found:', org.name);
        } else {
          console.log('[createOneOffEventBooking] Organization lookup failed, proceeding without org:', orgError?.message);
        }
      } else {
        console.log('[createOneOffEventBooking] Member has no organization_id, proceeding without org');
      }
    } else {
      console.log('[createOneOffEventBooking] Guest booking - no member lookup needed');
    }

    // Task #1519: Group events (member_group_id set) are SELF-ONLY. A caller may
    // only register themselves — no colleagues, external attendees, or buy-N.
    // Reject any booking that attempts to add extra/other attendees.
    if (event.member_group_id) {
      const callerEmail = String(
        (isGuestBooking ? guestInfo?.email : (member?.email || memberEmail)) || ''
      ).trim().toLowerCase();

      if (bookingAttendees.length > 1) {
        console.log('[createOneOffEventBooking] Blocking multi-attendee booking on group event:', eventId);
        return { success: false, error: 'Group events only allow self-registration' };
      }

      const attendeeEmail = String(bookingAttendees[0]?.email || '').trim().toLowerCase();
      if (!callerEmail || attendeeEmail !== callerEmail) {
        console.log('[createOneOffEventBooking] Blocking registration of another attendee on group event:', {
          eventId,
          callerEmail,
          attendeeEmail
        });
        return { success: false, error: 'Group events only allow self-registration' };
      }
    }

    // Enforce role/member-group ticket access restrictions for one-off events.
    // Mirrors the complex-event booking guard so a ticket marked role_match_only
    // is only purchasable by members whose role OR member group matches.
    if (ticketClassId && event.pricing_config?.ticket_classes) {
      const selectedTicketClass = event.pricing_config.ticket_classes.find(tc => tc.id === ticketClassId);
      if (selectedTicketClass && ticketHasAccessRestrictions(selectedTicketClass)) {
        if (isGuestBooking || !member) {
          console.log('[createOneOffEventBooking] Blocking guest from restricted ticket:', ticketClassId);
          return { success: false, error: 'You do not have access to this ticket class' };
        }
        const memberGroupIds = await getMemberGroupIdsForMember(supabase, member.id);
        const allowed = isTicketAccessibleToMember({
          ticketClass: selectedTicketClass,
          memberRoleId: member.role_id,
          memberGroupIds
        });
        if (!allowed) {
          console.log('[createOneOffEventBooking] Member does not match ticket roles/groups:', {
            memberId: member.id,
            ticketClassId,
            memberRoleId: member.role_id,
            ticketRoleIds: selectedTicketClass.role_ids || [],
            ticketGroupIds: selectedTicketClass.member_group_ids || []
          });
          return { success: false, error: 'You do not have access to this ticket class' };
        }
      }
    }

    // Verify Stripe payment if card payment was used
    let verifiedStripeClient = null;
    if (_testMode && paymentMethod === 'card') {
      console.log('[createOneOffEventBooking] TEST MODE - Skipping Stripe payment verification');
    } else if (paymentMethod === 'card' && stripePaymentIntentId) {
      console.log('[createOneOffEventBooking] Verifying Stripe payment:', stripePaymentIntentId);
      
      // Get tenant-scoped Stripe client from event's tenant
      const stripe = await getStripeClient(event.tenant_id, 'events');
      if (!stripe) {
        return { success: false, error: 'Stripe is not configured for this tenant' };
      }
      verifiedStripeClient = stripe;

      // Check for existing bookings with this PaymentIntent to prevent duplicate processing
      const { data: existingBookings, error: existingError } = await supabase
        .from('booking')
        .select('id, booking_reference, booking_group_reference, attendee_email, status')
        .eq('stripe_payment_intent_id', stripePaymentIntentId);
      
      if (!existingError && existingBookings && existingBookings.length > 0) {
        console.log('[createOneOffEventBooking] Found existing bookings for PaymentIntent:', stripePaymentIntentId, 'count:', existingBookings.length);
        return {
          success: true,
          booking_reference: existingBookings[0].booking_group_reference || existingBookings[0].booking_reference,
          bookings: existingBookings,
          already_processed: true,
          message: 'This payment has already been processed and your booking is confirmed.'
        };
      }

      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
        
        // Verify payment was successful
        if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'requires_capture') {
          console.error('[createOneOffEventBooking] Payment not successful:', paymentIntent.status);
          return { success: false, error: 'Payment has not been completed. Please try again.' };
        }

        // Verify payment amount: the frontend charges (remainingBalance + donation) and converts to pence via amount*100.
        // The PaymentIntent was created by our own createStripePaymentIntent endpoint with the correct amount.
        // We verify the PaymentIntent metadata matches this event to prevent cross-event payment reuse.
        // The amount was already validated when the PaymentIntent was created, so we do a loose sanity check
        // rather than a strict recalculation (which is fragile due to voucher/discount server-side revalidation).
        const piMetadata = paymentIntent.metadata || {};
        if (piMetadata.event_id && piMetadata.event_id !== eventId) {
          console.error('[createOneOffEventBooking] PaymentIntent event_id mismatch:', {
            expected: eventId,
            received: piMetadata.event_id
          });
          return { success: false, error: 'Payment was created for a different event' };
        }
        
        // Sanity check: payment amount should not exceed total cost + donation (converted to pence)
        const donationAmountValue = donationData?.amount || 0;
        const maxReasonableAmount = Math.round((totalCost + donationAmountValue) * 100) + 100;
        
        console.log('[createOneOffEventBooking] Payment amount verification:', {
          totalCost,
          donationAmount: donationAmountValue,
          maxReasonableAmountPence: maxReasonableAmount,
          actualAmountPence: paymentIntent.amount,
          paymentIntentEventId: piMetadata.event_id
        });
        
        if (paymentIntent.amount > maxReasonableAmount) {
          console.error('[createOneOffEventBooking] Payment amount exceeds expected maximum:', {
            maxReasonable: maxReasonableAmount,
            received: paymentIntent.amount
          });
          return { success: false, error: 'Payment amount exceeds expected total' };
        }

        console.log('[createOneOffEventBooking] Stripe payment verified:', paymentIntent.status);
      } catch (stripeError) {
        console.error('[createOneOffEventBooking] Stripe verification error:', stripeError);
        return { success: false, error: 'Failed to verify payment: ' + (stripeError.message || 'Unknown error') };
      }
    }

    // Count-based ticket capacity PRE-CHECK (Task #1758). available_count is a
    // fixed maximum that is never mutated; availability is derived from the count
    // of status='confirmed' bookings per ticket_class_id. This atomically checks
    // there is room for the requested tickets before we take any further action.
    // Unlimited / legacy single-price tickets (no ticketClassId) return ok=true.
    if (ticketClassId) {
      try {
        const { data: capCheck, error: capError } = await supabase.rpc('check_oneoff_ticket_capacity', {
          p_event_id: eventId,
          p_ticket_class_id: ticketClassId,
          p_requested: bookingAttendees.length,
          p_booking_ids: null
        });
        if (capError) {
          // Best-effort: proceed; the post-verify guard is authoritative.
          console.error('[createOneOffEventBooking] Capacity pre-check RPC error:', capError.message);
        } else if (capCheck && capCheck.ok === false) {
          console.warn('[createOneOffEventBooking] Ticket class sold out at pre-check:', { ticketClassId, capCheck });
          // Refund any Stripe payment already taken, since we are not booking.
          if (stripePaymentIntentId && verifiedStripeClient) {
            try {
              await verifiedStripeClient.refunds.create({
                payment_intent: stripePaymentIntentId,
                reason: 'requested_by_customer'
              });
              return {
                success: false,
                error: 'Sorry, these tickets have just sold out. Your payment has been automatically refunded.',
                sold_out: true,
                refunded: true
              };
            } catch (refundError) {
              console.error('[createOneOffEventBooking] Failed to auto-refund after sold-out pre-check:', refundError.message);
              return {
                success: false,
                error: `These tickets have just sold out and we could not process an automatic refund. Please contact support with reference: ${stripePaymentIntentId}`,
                sold_out: true,
                refund_failed: true,
                stripe_payment_intent_id: stripePaymentIntentId
              };
            }
          }
          return {
            success: false,
            error: 'Sorry, these tickets have just sold out.',
            sold_out: true
          };
        }
      } catch (capErr) {
        console.error('[createOneOffEventBooking] Capacity pre-check exception:', capErr.message);
      }
    }

    // Generate booking reference
    const bookingReference = `OOE-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    
    // For guest bookings, skip vouchers and training fund - use full card payment
    let validatedTrainingFundAmount = 0;
    let voucherAmountApplied = 0;
    const voucherDeductions = [];
    let pendingTrainingFundTxId = null;

    // Validate and recompute discount code amount on server side (never trust client amount).
    // IMPORTANT: discount code is applied BEFORE vouchers and training fund so that a
    // percentage discount is calculated against the full ticket price (matching the
    // complex-event booking flow in api/public/complex-event-booking.js).
    let validatedDiscountAmount = 0;
    let validatedDiscountCodeId = null;
    // Captured for deferred usage-tracking writes (only persisted after all
    // downstream validations — role checks, voucher/TF tenant resolution —
    // succeed, so a failed booking does not consume discount usage).
    let validatedDiscountCodeRecord = null;
    let validatedDiscountIsMemberTargeted = false;

    if (discountCodeId) {
      console.log(`[createOneOffEventBooking] Validating discount code ID: ${discountCodeId} for tenant: ${event.tenant_id}`);

      // Validate discount code with tenant scoping for multi-tenant security
      const { data: discountCode, error: discountCodeError } = await supabase
        .from('discount_code')
        .select('*')
        .eq('id', discountCodeId)
        .eq('is_active', true)
        .eq('tenant_id', event.tenant_id) // Ensure code belongs to this tenant
        .maybeSingle();

      if (discountCodeError || !discountCode) {
        console.warn(`[createOneOffEventBooking] Discount code validation failed: ${discountCodeError?.message || 'Not found or inactive'}`);
      } else {
        const isMemberTargetedCode = discountCode.member_id || discountCode.role_id || discountCode.member_group_id;
        let targetEligible = true;

        // SECURITY: For member-targeted codes, verify session identity matches the booking member
        if (isMemberTargetedCode && member?.id && req) {
          try {
            const sessionMember = await getSessionMember(req);
            if (!sessionMember || sessionMember.id !== member.id) {
              console.warn(`[createOneOffEventBooking] Session member ${sessionMember?.id} does not match booking member ${member.id} for member-targeted discount`);
              targetEligible = false;
            }
          } catch (e) {
            console.warn(`[createOneOffEventBooking] Could not verify session for member-targeted discount: ${e.message}`);
            targetEligible = false;
          }
        }

        // Validate organization-targeted restriction at booking time
        if (discountCode.organization_id && targetEligible) {
          if (!org?.id || discountCode.organization_id !== org.id) {
            console.warn(`[createOneOffEventBooking] Discount code targeted to org ${discountCode.organization_id}, but booking org is ${org?.id}`);
            targetEligible = false;
          }
        }

        // Validate event-targeted restriction at booking time
        if (discountCode.event_id && targetEligible) {
          if (!eventId || discountCode.event_id !== eventId) {
            console.warn(`[createOneOffEventBooking] Discount code targeted to event ${discountCode.event_id}, but booking event is ${eventId}`);
            targetEligible = false;
          }
        }

        // Validate member-targeted restrictions at booking time
        if (discountCode.member_id && targetEligible) {
          if (!member?.id || discountCode.member_id !== member.id) {
            console.warn(`[createOneOffEventBooking] Discount code targeted to member ${discountCode.member_id}, but booking member is ${member?.id}`);
            targetEligible = false;
          }
        }
        if (discountCode.role_id && targetEligible) {
          if (!member?.role_id || member.role_id !== discountCode.role_id) {
            console.warn(`[createOneOffEventBooking] Discount code targeted to role ${discountCode.role_id}, but member role is ${member?.role_id}`);
            targetEligible = false;
          }
        }
        if (discountCode.member_group_id && targetEligible) {
          if (!member?.id) {
            targetEligible = false;
          } else {
            const { data: grpAssignment } = await supabase
              .from('member_group_assignment')
              .select('id')
              .eq('member_id', member.id)
              .eq('group_id', discountCode.member_group_id)
              .maybeSingle();
            if (!grpAssignment) {
              console.warn(`[createOneOffEventBooking] Member ${member.id} not in group ${discountCode.member_group_id}`);
              targetEligible = false;
            }
          }
        }

        // For member-targeted codes, check per-member max usage
        if (isMemberTargetedCode && targetEligible && member?.id && discountCode.max_usage_count) {
          const { data: perMemberUsage } = await supabase
            .from('discount_code_usage')
            .select('usage_count')
            .eq('discount_code_id', discountCode.id)
            .eq('member_id', member.id)
            .maybeSingle();
          if (perMemberUsage && perMemberUsage.usage_count >= discountCode.max_usage_count) {
            console.warn(`[createOneOffEventBooking] Member ${member.id} has reached max uses for discount code`);
            targetEligible = false;
          }
        }

        // Check if discount code has expired (use correct column name: expires_at)
        if (!targetEligible) {
          console.warn(`[createOneOffEventBooking] Discount code target eligibility check failed`);
        } else if (discountCode.expires_at && new Date(discountCode.expires_at) < new Date()) {
          console.warn(`[createOneOffEventBooking] Discount code has expired`);
        } else if (!isMemberTargetedCode && discountCode.max_usage_count && discountCode.current_usage_count >= discountCode.max_usage_count) {
          console.warn(`[createOneOffEventBooking] Discount code has reached maximum uses`);
        } else {
          // Compute discount amount server-side against the FULL totalCost (before
          // vouchers and training fund), matching the complex-event flow.
          if (discountCode.type === 'percentage') {
            validatedDiscountAmount = Math.min(
              (totalCost * discountCode.value) / 100,
              totalCost
            );
          } else {
            validatedDiscountAmount = Math.min(discountCode.value, totalCost);
          }

          validatedDiscountCodeId = discountCode.id;
          // Capture for deferred usage-tracking writes (see below, after
          // voucher/TF validations have all passed).
          validatedDiscountCodeRecord = discountCode;
          validatedDiscountIsMemberTargeted = !!isMemberTargetedCode;
          console.log(`[createOneOffEventBooking] Discount code validated: ${discountCode.code}, type=${discountCode.type}, value=${discountCode.value}, computed amount=${validatedDiscountAmount}`);
        }
      }
    }

    // Ceiling for vouchers + training fund is the cost AFTER the discount code is applied.
    const costAfterDiscount = Math.max(0, totalCost - validatedDiscountAmount);

    if (!isGuestBooking && org) {
      // Server-side role restriction validation for training fund
      const trainingFundAllowedRoles = org.training_fund_allowed_role_ids || [];
      if (trainingFundAmount > 0 && trainingFundAllowedRoles.length > 0) {
        if (!member?.role_id || !trainingFundAllowedRoles.includes(member.role_id)) {
          console.warn('[createOneOffEventBooking] Training fund rejected - member role not in allowed list:', {
            memberRoleId: member?.role_id,
            allowedRoles: trainingFundAllowedRoles
          });
          return { success: false, error: 'Your role does not have permission to use the training fund' };
        }
      }

      // Server-side role restriction validation for vouchers
      const voucherAllowedRoles = org.voucher_allowed_role_ids || [];
      if (selectedVoucherIds && selectedVoucherIds.length > 0 && voucherAllowedRoles.length > 0) {
        if (!member?.role_id || !voucherAllowedRoles.includes(member.role_id)) {
          console.warn('[createOneOffEventBooking] Voucher usage rejected - member role not in allowed list:', {
            memberRoleId: member?.role_id,
            allowedRoles: voucherAllowedRoles
          });
          return { success: false, error: 'Your role does not have permission to use training vouchers' };
        }
      }

      // Server-side validation: Clamp training fund amount to available balance.
      // Ceiling is the cost AFTER the discount code is applied (matching the new
      // discount-first order). See comment above the discount block.
      validatedTrainingFundAmount = Math.min(
        Math.max(0, trainingFundAmount || 0),
        org.training_fund_balance || 0,
        costAfterDiscount
      );
      
      // Process voucher deductions if any - with ownership validation
      if (selectedVoucherIds && selectedVoucherIds.length > 0) {
        console.log('[createOneOffEventBooking] Processing vouchers:', selectedVoucherIds);
        const allowVoucherAfterExpiry = await getAllowVoucherUseAfterExpiry(supabase, event.tenant_id || org.tenant_id);
        for (const voucherId of selectedVoucherIds) {
          console.log('[createOneOffEventBooking] Looking up voucher:', voucherId, 'for org:', org.id);
          // Fetch voucher from the voucher table and validate it belongs to the member's organization
          const { data: voucher, error: voucherError } = await supabase
            .from('voucher')
            .select('*')
            .eq('id', voucherId)
            .eq('organization_id', org.id)
            .eq('status', 'active')
            .single();
          
          console.log('[createOneOffEventBooking] Voucher lookup result:', voucher ? { id: voucher.id, value: voucher.value, status: voucher.status } : 'not found', 'error:', voucherError?.message);
          
          if (voucher && !isVoucherUsableForEventDate(voucher, event.start_date, allowVoucherAfterExpiry)) {
            return res.status(400).json({
              error: 'One or more selected vouchers expire before the event takes place and cannot be used for this booking.'
            });
          }
          
          if (voucher && voucher.value > 0) {
            // Clamp amount to remaining cost
            const amountToUse = Math.min(voucher.value, costAfterDiscount - voucherAmountApplied - validatedTrainingFundAmount);
            if (amountToUse > 0) {
              // Resolve tenant_id BEFORE any voucher mutation. If we cannot
              // resolve it, abort before touching voucher.value so we don't
              // leave the voucher debited without a matching transaction row.
              const vtxTenantId = event.tenant_id || org.tenant_id || null;
              if (!vtxTenantId) {
                console.error('[createOneOffEventBooking] Refusing to write voucher_transaction with NULL tenant_id', {
                  eventId: event.id,
                  orgId: org.id,
                  voucherId,
                  bookingReference,
                });
                return res.status(500).json({ error: 'Could not resolve tenant context for voucher transaction' });
              }

              voucherAmountApplied += amountToUse;
              voucherDeductions.push({ voucherId, amount: amountToUse });

              // Update voucher balance in the voucher table
              const newValue = voucher.value - amountToUse;
              console.log('[createOneOffEventBooking] Updating voucher', voucherId, 'from', voucher.value, 'to', newValue);
              const { error: updateError } = await supabase
                .from('voucher')
                .update({
                  value: newValue,
                  status: newValue <= 0 ? 'used' : 'active'
                })
                .eq('id', voucherId);
              
              if (updateError) {
                console.error('[createOneOffEventBooking] Failed to update voucher:', updateError.message);
              } else {
                console.log('[createOneOffEventBooking] Voucher updated successfully');
                const { error: vtxError } = await supabase
                  .from('voucher_transaction')
                  .insert({
                    voucher_id: voucherId,
                    organization_id: org.id,
                    booking_reference: bookingReference,
                    event_id: event.id,
                    event_title: event.title || 'One-off Event',
                    member_id: member?.id || null,
                    member_email: memberEmail,
                    amount: amountToUse,
                    balance_before: voucher.value,
                    balance_after: newValue,
                    type: 'booking_usage',
                    created_at: new Date().toISOString(),
                    tenant_id: vtxTenantId
                  });
                
                if (vtxError) {
                  console.error('[createOneOffEventBooking] Failed to create voucher transaction:', vtxError.message);
                } else {
                  console.log('[createOneOffEventBooking] Voucher transaction created successfully');
                }
              }
            }
          } else {
            console.warn('[createOneOffEventBooking] Voucher not found or not owned by org:', voucherId);
          }
        }
      }

      // Process training fund deduction if any (use validated amount)
      if (validatedTrainingFundAmount > 0) {
        const newTrainingFundBalance = org.training_fund_balance - validatedTrainingFundAmount;

        // Resolve a non-null tenant_id BEFORE mutating any balances. Writing a
        // training_fund_transaction with tenant_id = NULL would silently exclude
        // it from /TrainingFundManagement reconciliation while still deducting
        // the org balance. Fail loudly instead.
        const tfTenantId = event.tenant_id || org.tenant_id || null;
        if (!tfTenantId) {
          console.error('[createOneOffEventBooking] Refusing to write training_fund_transaction with NULL tenant_id', {
            eventId: event.id,
            orgId: org.id,
            bookingReference,
          });
          return res.status(500).json({ error: 'Could not resolve tenant context for training fund transaction' });
        }

        await supabase
          .from('organization')
          .update({
            training_fund_balance: newTrainingFundBalance
          })
          .eq('id', org.id);
        
        // Create training fund transaction record in the correct table.
        // booking_id is left null here and updated after bookings are inserted (below).
        const { data: tfTxRow, error: tfTxError } = await supabase
          .from('training_fund_transaction')
          .insert({
            organization_id: org.id,
            type: 'booking_usage',
            amount: validatedTrainingFundAmount,
            balance_before: org.training_fund_balance,
            balance_after: newTrainingFundBalance,
            reason: `Event booking: ${event.title || 'One-off Event'} (${bookingReference})`,
            created_by: member?.id || null,
            created_date: new Date().toISOString(),
            tenant_id: tfTenantId
          })
          .select('id')
          .single();
        
        if (tfTxError) {
          console.error('[createOneOffEventBooking] Failed to create training fund transaction:', tfTxError.message);
        } else {
          console.log('[createOneOffEventBooking] Training fund transaction created successfully');
          pendingTrainingFundTxId = tfTxRow?.id || null;
        }
      }
    }

    // Deferred discount-code usage tracking. We only persist usage increments
    // AFTER voucher/training-fund role checks and tenant-resolution guards
    // above have passed, so a request that aborts on those checks does not
    // consume discount usage (matches pre-task-899 tracking semantics).
    if (validatedDiscountCodeId && validatedDiscountCodeRecord) {
      const discountCode = validatedDiscountCodeRecord;
      const isMemberTargetedCode = validatedDiscountIsMemberTargeted;

      // Increment current_usage_count for non-member-targeted codes
      // (member-targeted codes use per-member tracking in discount_code_usage).
      if (!isMemberTargetedCode) {
        await supabase
          .from('discount_code')
          .update({ current_usage_count: (discountCode.current_usage_count || 0) + 1 })
          .eq('id', discountCode.id)
          .eq('tenant_id', event.tenant_id);
      }

      // Track usage in discount_code_usage table for reporting (requires organization)
      if (org?.id) {
        const { data: existingUsage } = await supabase
          .from('discount_code_usage')
          .select('id, usage_count')
          .eq('discount_code_id', discountCode.id)
          .eq('organization_id', org.id)
          .is('member_id', null)
          .maybeSingle();

        if (existingUsage) {
          await supabase
            .from('discount_code_usage')
            .update({ usage_count: (existingUsage.usage_count || 0) + 1 })
            .eq('id', existingUsage.id);
          console.log(`[createOneOffEventBooking] Updated discount_code_usage for org ${org.id}: count=${(existingUsage.usage_count || 0) + 1}`);
        } else {
          const { error: usageError } = await supabase
            .from('discount_code_usage')
            .insert({
              discount_code_id: discountCode.id,
              organization_id: org.id,
              usage_count: 1,
              tenant_id: event.tenant_id
            });
          if (usageError) {
            console.error('[createOneOffEventBooking] Failed to create discount_code_usage:', usageError.message);
          } else {
            console.log(`[createOneOffEventBooking] Created discount_code_usage for org ${org.id}`);
          }
        }
      } else {
        console.log(`[createOneOffEventBooking] Skipping discount_code_usage tracking - no organization (guest booking)`);
      }

      // Track per-member usage for member/role/group-targeted codes
      if (isMemberTargetedCode && member?.id) {
        const { data: existingMemberUsage } = await supabase
          .from('discount_code_usage')
          .select('id, usage_count')
          .eq('discount_code_id', discountCode.id)
          .eq('member_id', member.id)
          .maybeSingle();

        if (existingMemberUsage) {
          await supabase
            .from('discount_code_usage')
            .update({ usage_count: (existingMemberUsage.usage_count || 0) + 1 })
            .eq('id', existingMemberUsage.id);
          console.log(`[createOneOffEventBooking] Updated per-member discount_code_usage for member ${member.id}: count=${(existingMemberUsage.usage_count || 0) + 1}`);
        } else {
          const { error: memberUsageError } = await supabase
            .from('discount_code_usage')
            .insert({
              discount_code_id: discountCode.id,
              member_id: member.id,
              organization_id: org?.id || null,
              usage_count: 1,
              tenant_id: event.tenant_id
            });
          if (memberUsageError) {
            console.error('[createOneOffEventBooking] Failed to create per-member discount_code_usage:', memberUsageError.message);
          } else {
            console.log(`[createOneOffEventBooking] Created per-member discount_code_usage for member ${member.id}`);
          }
        }
      }
    }

    // Calculate validated remaining balance after vouchers, training fund, and discount code
    const validatedRemainingBalance = Math.max(0, totalCost - voucherAmountApplied - validatedTrainingFundAmount - validatedDiscountAmount);
    console.log(`[createOneOffEventBooking] Payment breakdown: totalCost=${totalCost}, vouchers=${voucherAmountApplied}, trainingFund=${validatedTrainingFundAmount}, discountCode=${validatedDiscountAmount}, remaining=${validatedRemainingBalance}`);
    
    // Create booking records for each attendee
    const createdBookings = [];
    console.log('[createOneOffEventBooking] About to create bookings for', bookingAttendees.length, 'attendees (isGuestBooking:', isGuestBooking, ')');
    
    for (let i = 0; i < bookingAttendees.length; i++) {
      const attendee = bookingAttendees[i];
      console.log(`[createOneOffEventBooking] Processing attendee ${i + 1}/${bookingAttendees.length}:`, attendee.email);
      // Calculate ticket price - use ticket class price if provided, otherwise from pricing config or total cost
      const ticketPriceValue = ticketClassPrice || event.pricing_config?.ticketPrice || (totalCost / ticketsRequired);
      
      // Generate unique booking reference for each attendee (append index if multiple attendees)
      // Keep the base reference in booking_group_reference for grouping all attendees together
      const attendeeBookingRef = bookingAttendees.length > 1 
        ? `${bookingReference}-${i + 1}` 
        : bookingReference;
      
      const bookingData = {
        event_id: event.id,
        member_id: isGuestBooking ? null : member?.id,
        organization_id: isGuestBooking ? null : org?.id,
        booking_reference: attendeeBookingRef,
        booking_group_reference: bookingReference, // Base reference to group all attendees from same booking session
        attendee_email: attendee.email,
        attendee_first_name: attendee.first_name || attendee.firstName,
        attendee_last_name: attendee.last_name || attendee.lastName,
        status: 'confirmed',
        payment_method: paymentMethod,
        ticket_price: ticketPriceValue,
        total_cost: totalCost / ticketsRequired,
        voucher_amount: voucherAmountApplied / ticketsRequired,
        training_fund_amount: validatedTrainingFundAmount / ticketsRequired,
        account_amount: (paymentMethod === 'account' ? validatedRemainingBalance : 0) / ticketsRequired,
        purchase_order_number: purchaseOrderNumber,
        po_to_follow: paymentMethod === 'account' ? poToFollow : false,
        stripe_payment_intent_id: stripePaymentIntentId,
        is_one_off_event: true,
        ticket_class_id: ticketClassId,
        ticket_class_name: ticketClassName,
        is_guest_booking: isGuestBooking,
        guest_organisation_name: attendee.organization || null,
        attendee_phone: attendee.phone || null,
        attendee_job_title: attendee.job_title || null,
        discount_code_id: validatedDiscountCodeId || null,
        discount_code_amount: validatedDiscountAmount > 0 ? validatedDiscountAmount / ticketsRequired : 0,
        third_party_consent: (event.pricing_config?.collectThirdPartyConsent === true && typeof thirdPartyConsent === 'boolean') ? thirdPartyConsent : null,
        ...sanitizeOptionSelections(attendee, event),
        created_at: new Date().toISOString(),
        tenant_id: event.tenant_id
      };

      console.log('[createOneOffEventBooking] Inserting booking:', JSON.stringify(bookingData));
      
      const { data: booking, error: bookingError } = await supabase
        .from('booking')
        .insert(bookingData)
        .select()
        .single();

      if (bookingError) {
        console.error('[createOneOffEventBooking] Booking insert failed:', bookingError);
        
        // If Stripe payment was taken, automatically refund since booking creation failed
        if (stripePaymentIntentId && verifiedStripeClient) {
          try {
            console.log('[createOneOffEventBooking] Auto-refunding Stripe payment due to booking failure:', stripePaymentIntentId);
            await verifiedStripeClient.refunds.create({
              payment_intent: stripePaymentIntentId,
              reason: 'requested_by_customer'
            });
            console.log('[createOneOffEventBooking] Stripe refund issued successfully');
            return { 
              success: false, 
              error: 'We could not complete your booking due to a system error. Your payment has been automatically refunded. Please try again.',
              refunded: true
            };
          } catch (refundError) {
            console.error('[createOneOffEventBooking] Failed to auto-refund:', refundError.message);
            return { 
              success: false, 
              error: `Booking failed and we could not process an automatic refund. Please contact support with reference: ${stripePaymentIntentId}`,
              refund_failed: true,
              stripe_payment_intent_id: stripePaymentIntentId
            };
          }
        }
        
        return { 
          success: false, 
          error: `Failed to create booking: ${bookingError.message || 'Unknown database error'}`,
          details: bookingError
        };
      } else if (booking) {
        console.log('[createOneOffEventBooking] Booking created:', booking.id);
        createdBookings.push(booking);
        
        try {
          await scheduleBookingReminderEmails(booking.id, eventId, booking.attendee_email, ticketClassId);
        } catch (err) {
          console.error('[createOneOffEventBooking] Failed to schedule reminders:', err.message);
        }
      }
    }

    // Check if any bookings were created
    if (createdBookings.length === 0) {
      console.error('[createOneOffEventBooking] No bookings were created');
      
      // If Stripe payment was taken but no bookings created, auto-refund
      if (stripePaymentIntentId && verifiedStripeClient) {
        try {
          console.log('[createOneOffEventBooking] Auto-refunding Stripe payment - no bookings created:', stripePaymentIntentId);
          await verifiedStripeClient.refunds.create({
            payment_intent: stripePaymentIntentId,
            reason: 'requested_by_customer'
          });
          console.log('[createOneOffEventBooking] Stripe refund issued successfully');
          return { 
            success: false, 
            error: 'We could not complete your booking due to a system error. Your payment has been automatically refunded. Please try again.',
            refunded: true
          };
        } catch (refundError) {
          console.error('[createOneOffEventBooking] Failed to auto-refund:', refundError.message);
          return { 
            success: false, 
            error: `Booking failed and we could not process an automatic refund. Please contact support with reference: ${stripePaymentIntentId}`,
            refund_failed: true,
            stripe_payment_intent_id: stripePaymentIntentId
          };
        }
      }
      
      return { success: false, error: 'No bookings were created' };
    }

    // Count-based ticket capacity POST-VERIFY (Task #1758). The pre-check is not
    // sufficient under concurrency: two checkouts can both pass it and then both
    // insert their rows. This atomically confirms our just-inserted rows fit
    // within the fixed maximum (under the same advisory lock); if they do not,
    // the guard DELETES our booking rows (this booking lost the race) and we
    // refund any payment taken (mirrors the no-bookings auto-refund above).
    if (ticketClassId && createdBookings.length > 0) {
      let capacityExceeded = false;
      try {
        const { data: capVerify, error: capVerifyError } = await supabase.rpc('check_oneoff_ticket_capacity', {
          p_event_id: eventId,
          p_ticket_class_id: ticketClassId,
          p_requested: createdBookings.length,
          p_booking_ids: createdBookings.map(b => b.id)
        });
        if (capVerifyError) {
          console.error('[createOneOffEventBooking] Capacity post-verify RPC error:', capVerifyError.message);
        } else if (capVerify && capVerify.ok === false) {
          capacityExceeded = true;
          console.warn('[createOneOffEventBooking] Capacity exceeded at post-verify; rows removed by guard:', { ticketClassId, capVerify });
        }
      } catch (capErr) {
        console.error('[createOneOffEventBooking] Capacity post-verify exception:', capErr.message);
      }

      if (capacityExceeded) {
        // The guard already deleted our booking rows under its advisory lock.
        // Best-effort: cancel any reminder emails scheduled for those rows.
        try {
          await supabase
            .from('scheduled_email')
            .delete()
            .in('booking_id', createdBookings.map(b => b.id));
        } catch (cleanupErr) {
          console.error('[createOneOffEventBooking] Failed to clean up scheduled emails after capacity post-verify:', cleanupErr.message);
        }

        if (stripePaymentIntentId && verifiedStripeClient) {
          try {
            await verifiedStripeClient.refunds.create({
              payment_intent: stripePaymentIntentId,
              reason: 'requested_by_customer'
            });
            return {
              success: false,
              error: 'Sorry, these tickets have just sold out. Your payment has been automatically refunded.',
              sold_out: true,
              refunded: true
            };
          } catch (refundError) {
            console.error('[createOneOffEventBooking] Failed to auto-refund after capacity post-verify:', refundError.message);
            return {
              success: false,
              error: `These tickets have just sold out and we could not process an automatic refund. Please contact support with reference: ${stripePaymentIntentId}`,
              sold_out: true,
              refund_failed: true,
              stripe_payment_intent_id: stripePaymentIntentId
            };
          }
        }
        return {
          success: false,
          error: 'Sorry, these tickets have just sold out.',
          sold_out: true
        };
      }
    }

    // Backfill the booking_id on the training fund transaction now that we
    // have a real booking row to link to (so the report export can resolve
    // the event's internal_reference).
    if (pendingTrainingFundTxId && createdBookings.length > 0) {
      const { error: tfLinkErr } = await supabase
        .from('training_fund_transaction')
        .update({ booking_id: createdBookings[0].id })
        .eq('id', pendingTrainingFundTxId);
      if (tfLinkErr) {
        console.error('[createOneOffEventBooking] Failed to link training fund transaction to booking:', tfLinkErr.message);
      }
    }

    // Register attendees with Zoom if this is a Zoom webinar event
    let zoomRegistrationResults = [];
    if (event.zoom_webinar_id) {
      console.log('[createOneOffEventBooking] Event has zoom_webinar_id:', event.zoom_webinar_id);
      
      // Fetch the webinar details
      const { data: webinar, error: webinarError } = await supabase
        .from('zoom_webinar')
        .select('*')
        .eq('id', event.zoom_webinar_id)
        .single();
      
      if (webinar && !webinarError) {
        console.log('[createOneOffEventBooking] Found webinar:', webinar.topic, 'zoom_id:', webinar.zoom_webinar_id);
        
        // Check if registration is required and webinar is valid for registration
        if (webinar.zoom_webinar_id && webinar.registration_required && webinar.status === 'scheduled') {
          const webinarStartTime = new Date(webinar.start_time);
          if (webinarStartTime > new Date()) {
            console.log('[createOneOffEventBooking] Registering', bookingAttendees.length, 'attendees with Zoom');
            
            try {
              const zoomToken = await getZoomAccessTokenForTenant(event.tenant_id);
              
              // Register each attendee with Zoom
              for (let i = 0; i < bookingAttendees.length; i++) {
                const attendee = bookingAttendees[i];
                console.log(`[createOneOffEventBooking] Registering attendee ${i + 1}/${bookingAttendees.length}: ${attendee.email}`);
                
                try {
                  const zoomResponse = await fetch(
                    `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
                    {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${zoomToken}`,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        first_name: attendee.first_name || attendee.firstName || 'Guest',
                        last_name: attendee.last_name || attendee.lastName || 'Attendee',
                        email: attendee.email,
                        auto_approve: true
                      })
                    }
                  );
                  
                  console.log(`[createOneOffEventBooking] Zoom API response status: ${zoomResponse.status}`);
                  
                  if (!zoomResponse.ok) {
                    const errorData = await zoomResponse.json().catch(() => ({}));
                    console.error(`[createOneOffEventBooking] Zoom registration error for ${attendee.email}:`, JSON.stringify(errorData));
                    
                    if (errorData.code === 3027) {
                      // Already registered - not an error
                      console.log(`[createOneOffEventBooking] ${attendee.email} already registered`);
                      zoomRegistrationResults.push({ email: attendee.email, success: true, already_registered: true });
                    } else {
                      zoomRegistrationResults.push({ 
                        email: attendee.email, 
                        success: false, 
                        error: errorData.message || 'Zoom registration failed',
                        code: errorData.code 
                      });
                    }
                  } else {
                    const zoomData = await zoomResponse.json();
                    console.log(`[createOneOffEventBooking] ✓ Registered ${attendee.email}, registrant_id: ${zoomData.registrant_id}, join_url: ${zoomData.join_url}`);
                    
                    zoomRegistrationResults.push({ 
                      email: attendee.email, 
                      success: true, 
                      registrant_id: zoomData.registrant_id,
                      join_url: zoomData.join_url 
                    });
                    
                    // Update the booking record with the Zoom registrant ID
                    const attendeeBookingRef = bookingAttendees.length > 1 
                      ? `${bookingReference}-${i + 1}` 
                      : bookingReference;
                    
                    await supabase
                      .from('booking')
                      .update({ zoom_registrant_id: zoomData.registrant_id })
                      .eq('booking_reference', attendeeBookingRef);
                  }
                } catch (zoomErr) {
                  console.error(`[createOneOffEventBooking] Zoom registration exception for ${attendee.email}:`, zoomErr.message);
                  zoomRegistrationResults.push({ email: attendee.email, success: false, error: zoomErr.message });
                }
              }
            } catch (tokenErr) {
              console.error('[createOneOffEventBooking] Failed to get Zoom access token:', tokenErr.message);
              zoomRegistrationResults.push({ error: 'Failed to get Zoom access token', details: tokenErr.message });
            }
          } else {
            console.log('[createOneOffEventBooking] Webinar has already started, skipping registration');
          }
        } else {
          console.log('[createOneOffEventBooking] Webinar registration not required or not scheduled:', {
            zoom_webinar_id: webinar.zoom_webinar_id,
            registration_required: webinar.registration_required,
            status: webinar.status
          });
        }
      } else {
        console.log('[createOneOffEventBooking] Failed to fetch webinar:', webinarError?.message);
      }
    }

    // Register attendees for virtual sessions in complex events (per-session Zoom webinar registration)
    let sessionZoomRegistrationResults = [];
    if (event.is_complex) {
      try {
        let sessionQuery = supabase
          .from('complex_event_session')
          .select('*')
          .eq('event_id', eventId)
          .eq('status', 'scheduled')
          .in('delivery_mode', ['virtual', 'hybrid'])
          .not('zoom_webinar_id', 'is', null);

        if (event.tenant_id) {
          sessionQuery = sessionQuery.eq('tenant_id', event.tenant_id);
        }

        const { data: virtualSessions } = await sessionQuery;

        if (virtualSessions && virtualSessions.length > 0) {
          console.log(`[createOneOffEventBooking] Found ${virtualSessions.length} virtual sessions with Zoom webinars`);

          const bookedTrack = (ticketClassName || '').trim().toLowerCase();

          for (const session of virtualSessions) {
            if (!session.zoom_registration_required) {
              console.log(`[createOneOffEventBooking] Session "${session.title}" does not require registration, skipping`);
              continue;
            }

            if (session.start_time && new Date(session.start_time) <= new Date()) {
              console.log(`[createOneOffEventBooking] Session "${session.title}" has already started, skipping`);
              continue;
            }

            const sessionTrack = (session.track_name || '').trim().toLowerCase();
            if (sessionTrack) {
              if (!bookedTrack || sessionTrack !== bookedTrack) {
                console.log(`[createOneOffEventBooking] Session "${session.title}" track "${session.track_name}" does not match booking track "${ticketClassName || '(none)'}", skipping`);
                continue;
              }
            }

            try {
              const zoomToken = await getZoomAccessTokenForTenant(event.tenant_id);

              for (const attendee of bookingAttendees) {
                try {
                  const zoomResponse = await fetch(
                    `https://api.zoom.us/v2/webinars/${session.zoom_webinar_id}/registrants`,
                    {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${zoomToken}`,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        first_name: attendee.first_name || attendee.firstName || 'Guest',
                        last_name: attendee.last_name || attendee.lastName || 'Attendee',
                        email: attendee.email,
                        auto_approve: true
                      })
                    }
                  );

                  if (zoomResponse.ok) {
                    const zoomData = await zoomResponse.json();
                    console.log(`[createOneOffEventBooking] ✓ Registered ${attendee.email} for session "${session.title}", registrant_id: ${zoomData.registrant_id}`);
                    sessionZoomRegistrationResults.push({
                      session_id: session.id,
                      session_title: session.title,
                      email: attendee.email,
                      success: true,
                      registrant_id: zoomData.registrant_id,
                      join_url: zoomData.join_url
                    });
                  } else {
                    const errorData = await zoomResponse.json().catch(() => ({}));
                    if (errorData.code === 3027) {
                      console.log(`[createOneOffEventBooking] ${attendee.email} already registered for session "${session.title}"`);
                      sessionZoomRegistrationResults.push({ session_id: session.id, email: attendee.email, success: true, already_registered: true });
                    } else {
                      console.error(`[createOneOffEventBooking] Session zoom registration error for ${attendee.email}:`, errorData);
                      sessionZoomRegistrationResults.push({ session_id: session.id, email: attendee.email, success: false, error: errorData.message });
                    }
                  }
                } catch (regErr) {
                  console.error(`[createOneOffEventBooking] Session zoom exception for ${attendee.email}:`, regErr.message);
                  sessionZoomRegistrationResults.push({ session_id: session.id, email: attendee.email, success: false, error: regErr.message });
                }
              }
            } catch (tokenErr) {
              console.error('[createOneOffEventBooking] Failed to get token for session registration:', tokenErr.message);
            }
          }
        }
      } catch (sessionErr) {
        console.error('[createOneOffEventBooking] Error fetching complex event sessions:', sessionErr.message);
      }
    }

    // If paying to account, create an account charge record
    let xeroInvoiceResult = null;
    let xeroDebug = {
      attempted: false,
      remainingBalance: validatedRemainingBalance,
      paymentMethod: paymentMethod,
      isGuestBooking: isGuestBooking,
      hasOrganization: !!org,
      settingEnabled: null,
      settingValue: null,
      tokenFound: null,
      tenantIdFound: null,
      contactId: null,
      invoiceResponseStatus: null,
      invoiceResponseBody: null,
      error: null
    };
    
    console.log(`[Xero] Invoice flow started - remainingBalance: ${validatedRemainingBalance}, paymentMethod: ${paymentMethod}, isGuest: ${isGuestBooking}, hasOrg: ${!!org}`);
    
    // Account charges only apply to account/PO payments (not Stripe)
    if (!isGuestBooking && validatedRemainingBalance > 0 && paymentMethod === 'account' && org) {
      console.log(`[Xero] Creating account charge record for £${validatedRemainingBalance.toFixed(2)}`);
      await supabase
        .from('program_ticket_transaction')
        .insert({
          organization_id: org.id,
          transaction_type: 'account_charge',
          value: validatedRemainingBalance,
          booking_reference: bookingReference,
          event_name: event.title || 'One-off Event',
          member_email: memberEmail,
          purchase_order_number: purchaseOrderNumber,
          po_to_follow: poToFollow,
          notes: `Account charge: £${validatedRemainingBalance.toFixed(2)} for ${event.title || 'event'} (PO: ${poToFollow ? 'To follow' : (purchaseOrderNumber || 'N/A')})`
        });
    }

    // Xero invoices are created for ANY payment method when there's a balance due
    // Only skip when training funds/vouchers completely cover the cost (zero balance)
    // Invoice to: organization (if linked) > plain text org > individual name
    if (validatedRemainingBalance > 0) {
      // Resolve invoice contact using priority: linked org > guest plain text org > individual name
      let invoiceContactInfo = null;
      
      if (org) {
        invoiceContactInfo = {
          name: org.name,
          email: org.invoicing_email || null,
          isOrganization: true
        };
        console.log(`[Xero] Invoice to linked organization: ${org.name}`);
      } else if (isGuestBooking && guestInfo) {
        // Guest booking - use guest's organization or personal details
        if (guestInfo.organization && guestInfo.organization.trim()) {
          invoiceContactInfo = {
            name: guestInfo.organization.trim(),
            email: guestInfo.email,
            isOrganization: true
          };
          console.log(`[Xero] Invoice to guest organization: ${guestInfo.organization}`);
        } else {
          // No organization provided - invoice to individual
          const guestName = `${guestInfo.first_name || ''} ${guestInfo.last_name || ''}`.trim();
          invoiceContactInfo = {
            name: guestName || guestInfo.email,
            email: guestInfo.email,
            isOrganization: false
          };
          console.log(`[Xero] Invoice to guest individual: ${invoiceContactInfo.name}`);
        }
      } else if (member) {
        // Member without linked organization - invoice to individual member
        const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim();
        invoiceContactInfo = {
          name: memberName || member.email,
          email: member.email,
          isOrganization: false
        };
        console.log(`[Xero] Invoice to member individual: ${invoiceContactInfo.name}`);
      }
      
      if (!invoiceContactInfo || !invoiceContactInfo.name) {
        console.log(`[Xero] Cannot determine invoice contact - skipping invoice creation`);
        xeroDebug.error = 'Cannot determine invoice contact';
      } else {
        xeroDebug.invoiceContactInfo = invoiceContactInfo;
        console.log(`[Xero] Checking if invoice should be created - balance: £${validatedRemainingBalance.toFixed(2)}, contact: ${invoiceContactInfo.name}`);

        // Derive appTenantId early for tenant-scoped settings queries
        const appTenantId = event.tenant_id || member?.tenant_id || null;
        console.log(`[Xero] Using appTenantId for settings: ${appTenantId}`);
        
        if (!appTenantId) {
          console.error(`[Xero] Cannot determine tenant ID for Xero invoice - skipping`);
          xeroDebug.error = 'Cannot determine tenant ID';
        } else {
        // Check if Xero invoice generation is enabled (tenant-scoped)
        const { data: xeroSettings, error: xeroSettingsError } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'xero_invoice_enabled')
          .eq('tenant_id', appTenantId)
          .maybeSingle();

        xeroDebug.settingValue = xeroSettings?.setting_value;
        xeroDebug.settingError = xeroSettingsError?.message;

        const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';
        xeroDebug.settingEnabled = xeroInvoiceEnabled;

        console.log(`[Xero] Invoice setting enabled: ${xeroInvoiceEnabled} (raw value: ${xeroSettings?.setting_value})`);

        if (!xeroInvoiceEnabled) {
          console.log(`[Xero] Invoice creation skipped - feature not enabled in system settings`);
        } else {
          xeroDebug.attempted = true;
          console.log(`[Xero] Attempting invoice creation for ${paymentMethod} payment of £${validatedRemainingBalance.toFixed(2)}`);

          try {
            console.log(`[Xero] Getting valid access token for appTenantId: ${appTenantId}`);
            const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);
            xeroDebug.tokenFound = !!accessToken;
            xeroDebug.tenantIdFound = !!tenantId;
            console.log(`[Xero] Token retrieved: ${!!accessToken}, tenantId: ${!!tenantId}`);

            if (!accessToken || !tenantId) {
              console.error(`[Xero] Missing token or tenantId - cannot create invoice`);
              xeroDebug.error = 'Missing access token or tenant ID';
            } else {
              // Find or create Xero contact using resolved contact info
              const contactId = await findOrCreateXeroContact(accessToken, tenantId, invoiceContactInfo);
              xeroDebug.contactId = contactId;
              console.log(`[Xero] Contact ID: ${contactId}`);

              // Build attendee list for description
              const attendeeList = bookingAttendees.map(a => {
                const firstName = a.first_name || a.firstName || '';
                const lastName = a.last_name || a.lastName || '';
                return `${firstName} ${lastName}`.trim() || a.email;
              }).join('\n');

              // Build financial breakdown
              const ticketUnitPrice = ticketClassPrice || (totalCost / ticketsRequired);
              const ticketSubtotal = ticketUnitPrice * ticketsRequired;

              let financialBreakdown = [];
              financialBreakdown.push(`${ticketsRequired} x ${ticketClassName || 'Ticket'} @ £${ticketUnitPrice.toFixed(2)} = £${ticketSubtotal.toFixed(2)}`);

              // Add any discounts/offers applied
              if (voucherAmountApplied > 0) {
                financialBreakdown.push(`Voucher applied: -£${voucherAmountApplied.toFixed(2)}`);
              }
              if (validatedTrainingFundAmount > 0) {
                financialBreakdown.push(`Training fund applied: -£${validatedTrainingFundAmount.toFixed(2)}`);
              }

              // Check if there was a BOGO or bulk discount in pricing details
              if (pricingDetails) {
                if (pricingDetails.freeTickets && pricingDetails.freeTickets > 0) {
                  financialBreakdown.push(`BOGO offer: ${pricingDetails.freeTickets} free ticket${pricingDetails.freeTickets > 1 ? 's' : ''}`);
                }
                if (pricingDetails.bulkDiscountAmount && pricingDetails.bulkDiscountAmount > 0) {
                  financialBreakdown.push(`Bulk discount: -£${pricingDetails.bulkDiscountAmount.toFixed(2)}`);
                }
                if (pricingDetails.discountAmount && pricingDetails.discountAmount > 0 && !pricingDetails.bulkDiscountAmount) {
                  financialBreakdown.push(`Discount applied: -£${pricingDetails.discountAmount.toFixed(2)}`);
                }
              }

              financialBreakdown.push(`Total to invoice: £${validatedRemainingBalance.toFixed(2)}`);

              // Build line description with full event details and financial breakdown
              const lineDescriptionParts = [
                `Event: ${event.title || 'One-off Event'}`,
                `Reference: ${event.internal_reference || 'N/A'}`,
                `Ticket class: ${ticketClassName || 'Standard'}`,
                `Attendees: ${ticketsRequired}`,
                attendeeList,
                '',
                '----------',
                'Financial Breakdown:',
                ...financialBreakdown
              ];
              const lineDescription = lineDescriptionParts.join('\n');

              // Get Xero account code from system settings (default to '200' for Sales) - tenant-scoped
              const { data: accountCodeSetting } = await supabase
                .from('system_settings')
                .select('setting_value')
                .eq('setting_key', 'xero_sales_account_code')
                .eq('tenant_id', appTenantId)
                .maybeSingle();

              const systemDefaultAccountCode = accountCodeSetting?.setting_value || '200';
              const eventAccountCode = (event.xero_account_code || '').trim();
              const xeroAccountCode = eventAccountCode || systemDefaultAccountCode;
              xeroDebug.accountCodeUsed = xeroAccountCode;
              xeroDebug.accountCodeSource = eventAccountCode ? 'event' : 'system_default';
              
              // Get Xero invoice status setting (DRAFT or AUTHORISED) - tenant-scoped
              const { data: invoiceStatusSetting } = await supabase
                .from('system_settings')
                .select('setting_value')
                .eq('setting_key', 'xero_invoice_status')
                .eq('tenant_id', appTenantId)
                .maybeSingle();
              
              const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';
              xeroDebug.invoiceStatus = xeroInvoiceStatus;

              // Calculate due date (30 days from now)
              const dueDate = new Date();
              dueDate.setDate(dueDate.getDate() + 30);
              const dueDateString = dueDate.toISOString().split('T')[0];

              // Determine reference: PO number or "TBC" if supply later was selected
              const invoiceReference = poToFollow ? 'TBC' : (purchaseOrderNumber || 'TBC');

              // Get VAT rate from ticket class if available
              let vatRateKey = null;
              if (ticketClassId && event.pricing_config?.ticket_classes) {
                const selectedTicketClass = event.pricing_config.ticket_classes.find(tc => tc.id === ticketClassId);
                if (selectedTicketClass?.vat_rate_key) {
                  vatRateKey = selectedTicketClass.vat_rate_key;
                  xeroDebug.vatRateKey = vatRateKey;
                  xeroDebug.vatRateLabel = selectedTicketClass.vat_rate_label;
                  xeroDebug.vatRatePercentage = selectedTicketClass.vat_rate_percentage;
                }
              }

              // Build line item with optional tracking for Project and VAT
              const lineItem = {
                Description: lineDescription,
                Quantity: 1,
                UnitAmount: validatedRemainingBalance,
                AccountCode: xeroAccountCode
              };

              // Add VAT rate (TaxType) if set on ticket class
              if (vatRateKey) {
                lineItem.TaxType = vatRateKey;
              }

              // Add tracking for Projects if internal_reference is set on the event
              if (event.internal_reference) {
                lineItem.Tracking = [{
                  Name: 'Projects',
                  Option: event.internal_reference
                }];
                xeroDebug.trackingAdded = { Name: 'Projects', Option: event.internal_reference };
              }

              // Create invoice with quantity 1 and total amount
              const invoicePayload = {
                Type: 'ACCREC',
                Contact: { ContactID: contactId },
                DueDate: dueDateString,
                LineItems: [lineItem],
                Reference: invoiceReference,
                Status: xeroInvoiceStatus
              };

              console.log(`[Xero] Sending invoice to Xero API - Amount: £${validatedRemainingBalance.toFixed(2)}, Reference: ${invoiceReference}, DueDate: ${dueDateString}`);
              console.log(`[Xero] Invoice payload: ${JSON.stringify(invoicePayload).substring(0, 500)}`);

              const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'xero-tenant-id': tenantId,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify({ Invoices: [invoicePayload] })
              });

              xeroDebug.invoiceResponseStatus = invoiceResponse.status;
              console.log(`[Xero] API response status: ${invoiceResponse.status}`);

              // Get response as text first to handle both JSON and XML errors
              const responseText = await invoiceResponse.text();
              xeroDebug.invoiceResponseRaw = responseText.substring(0, 500);

              let invoiceData = null;
              try {
                invoiceData = JSON.parse(responseText);
                xeroDebug.invoiceResponseBody = invoiceData;
              } catch (parseError) {
                console.error(`[Xero] Failed to parse response as JSON: ${responseText.substring(0, 200)}`);
                xeroDebug.invoiceResponseBody = responseText.substring(0, 500);
                xeroDebug.parseError = 'Response was not JSON: ' + responseText.substring(0, 200);
              }

              if (invoiceData && invoiceData.Invoices && invoiceData.Invoices.length > 0) {
                const invoice = invoiceData.Invoices[0];
                console.log(`[Xero] Invoice created successfully - ID: ${invoice.InvoiceID}, Number: ${invoice.InvoiceNumber}, Total: ${invoice.Total}`);

                xeroInvoiceResult = {
                  invoice_id: invoice.InvoiceID,
                  invoice_number: invoice.InvoiceNumber,
                  total: invoice.Total,
                  status: invoice.Status
                };

                // Update all booking records with Xero invoice ID and number
                console.log(`[Xero] Updating booking records with invoice ID for group: ${bookingReference}`);
                const { error: updateError } = await supabase
                  .from('booking')
                  .update({
                    xero_invoice_id: invoice.InvoiceID,
                    xero_invoice_number: invoice.InvoiceNumber
                  })
                  .eq('booking_group_reference', bookingReference);

                if (updateError) {
                  console.error(`[Xero] Failed to update bookings with Xero data: ${updateError.message}`);
                  xeroDebug.updateError = updateError.message;
                } else {
                  console.log(`[Xero] Bookings updated with Xero invoice ID: ${invoice.InvoiceNumber}`);
                }

                // Record payment in Xero if this was a Stripe payment AND invoice is AUTHORISED
                // Xero only accepts payments against AUTHORISED invoices, not DRAFT
                if (paymentMethod === 'card' && stripePaymentIntentId && invoice.InvoiceID && invoice.Status === 'AUTHORISED') {
                  try {
                    // Get Stripe bank account code from system settings - tenant-scoped
                    const { data: stripeBankCodeSetting } = await supabase
                      .from('system_settings')
                      .select('setting_value')
                      .eq('setting_key', 'xero_stripe_bank_account_code')
                      .eq('tenant_id', appTenantId)
                      .maybeSingle();

                    const stripeBankAccountCode = stripeBankCodeSetting?.setting_value;
                    
                    if (stripeBankAccountCode) {
                      console.log(`[Xero] Recording Stripe payment for invoice ${invoice.InvoiceNumber} - Amount: £${validatedRemainingBalance.toFixed(2)}, Bank Account: ${stripeBankAccountCode}`);
                      
                      // First, get the bank account ID from the account code
                      const accountsResponse = await fetch(`https://api.xero.com/api.xro/2.0/Accounts?where=Code=="${stripeBankAccountCode}"`, {
                        method: 'GET',
                        headers: {
                          'Authorization': `Bearer ${accessToken}`,
                          'xero-tenant-id': tenantId,
                          'Accept': 'application/json'
                        }
                      });

                      const accountsData = await accountsResponse.json();
                      const bankAccount = accountsData?.Accounts?.[0];

                      if (bankAccount?.AccountID) {
                        // Create payment against the invoice
                        const paymentPayload = {
                          Invoice: { InvoiceID: invoice.InvoiceID },
                          Account: { AccountID: bankAccount.AccountID },
                          Date: new Date().toISOString().split('T')[0],
                          Amount: validatedRemainingBalance,
                          Reference: `Stripe: ${stripePaymentIntentId}`
                        };

                        console.log(`[Xero] Creating payment: ${JSON.stringify(paymentPayload)}`);

                        const paymentResponse = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
                          method: 'POST',
                          headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'xero-tenant-id': tenantId,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                          },
                          body: JSON.stringify({ Payments: [paymentPayload] })
                        });

                        const paymentData = await paymentResponse.json();
                        
                        if (paymentData?.Payments?.[0]?.PaymentID) {
                          console.log(`[Xero] Payment recorded successfully - PaymentID: ${paymentData.Payments[0].PaymentID}`);
                          xeroDebug.paymentRecorded = true;
                          xeroDebug.paymentId = paymentData.Payments[0].PaymentID;
                        } else {
                          console.error(`[Xero] Failed to record payment: ${JSON.stringify(paymentData)}`);
                          xeroDebug.paymentError = JSON.stringify(paymentData).substring(0, 500);
                        }
                      } else {
                        console.warn(`[Xero] Bank account not found for code: ${stripeBankAccountCode}`);
                        xeroDebug.paymentSkipped = 'Bank account not found';
                      }
                    } else {
                      console.log(`[Xero] Stripe bank account code not configured - payment not recorded`);
                      xeroDebug.paymentSkipped = 'No Stripe bank account code configured';
                    }
                  } catch (paymentError) {
                    console.error(`[Xero] Error recording payment: ${paymentError.message}`);
                    xeroDebug.paymentError = paymentError.message;
                    // Don't fail the booking, just log the error
                  }
                } else if (paymentMethod === 'card' && stripePaymentIntentId && invoice.InvoiceID && invoice.Status !== 'AUTHORISED') {
                  console.log(`[Xero] Skipping payment recording - invoice is ${invoice.Status} (must be AUTHORISED for payment recording)`);
                  xeroDebug.paymentSkipped = `Invoice is ${invoice.Status}, not AUTHORISED`;
                }
              } else {
                console.error(`[Xero] Invoice creation failed - no invoice in response. Status: ${invoiceResponse.status}`);
                if (invoiceData?.ErrorNumber) {
                  console.error(`[Xero] Error details: ${invoiceData.ErrorNumber} - ${invoiceData.Message}`);
                }
                // Log full validation errors if present
                if (invoiceData?.Elements) {
                  invoiceData.Elements.forEach((element, idx) => {
                    if (element.ValidationErrors) {
                      element.ValidationErrors.forEach((ve, veIdx) => {
                        console.error(`[Xero] Validation error ${idx}.${veIdx}: ${ve.Message}`);
                      });
                    }
                  });
                }
                // Log raw response for debugging
                console.error(`[Xero] Full response: ${JSON.stringify(invoiceData).substring(0, 1000)}`);
              }
            }
          } catch (xeroError) {
            console.error(`[Xero] Invoice creation error: ${xeroError.message}`);
            xeroDebug.error = xeroError.message;
            xeroDebug.errorStack = xeroError.stack;
            // Don't fail the booking, just log the error
          }
        }
        }
      }
    } else {
      console.log(`[Xero] Invoice skipped - zero balance (fully covered by training funds/vouchers)`);
    }

    // Decrement available seats for the event (if not unlimited)
    if (event.available_seats !== null && event.available_seats !== undefined && !event.is_unlimited_registration) {
      const seatsToDecrement = bookingAttendees.length;
      console.log(`[createOneOffEventBooking] Decrementing ${seatsToDecrement} seats for event ${eventId}`);
      
      try {
        // Try atomic RPC first
        const { data: newSeatCount, error: rpcError } = await supabase
          .rpc('adjust_event_seats', { p_event_id: eventId, p_delta: -seatsToDecrement });
        
        if (rpcError) {
          console.error(`[createOneOffEventBooking] RPC seat decrement failed:`, rpcError.message);
          // Fallback to direct update
          const { data: currentEvent } = await supabase
            .from('event')
            .select('available_seats')
            .eq('id', eventId)
            .single();
          
          if (currentEvent && currentEvent.available_seats !== null) {
            const newSeatCount = Math.max(0, currentEvent.available_seats - seatsToDecrement);
            await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', eventId);
            console.log(`[createOneOffEventBooking] Fallback: Decremented seats to ${newSeatCount}`);
          }
        } else {
          console.log(`[createOneOffEventBooking] Atomically decremented seats, new count: ${newSeatCount}`);
        }
      } catch (rpcErr) {
        console.error(`[createOneOffEventBooking] Seat decrement exception:`, rpcErr.message);
        // Fallback to direct update
        const { data: currentEvent } = await supabase
          .from('event')
          .select('available_seats')
          .eq('id', eventId)
          .single();
        
        if (currentEvent && currentEvent.available_seats !== null) {
          const newSeatCount = Math.max(0, currentEvent.available_seats - seatsToDecrement);
          await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', eventId);
          console.log(`[createOneOffEventBooking] Fallback: Decremented seats to ${newSeatCount}`);
        }
      }
    }

    // NOTE (Task #1758): ticket-class availability is COUNT-BASED. available_count
    // is a fixed maximum (capacity) and is never mutated by bookings — derived
    // availability comes from counting status='confirmed' bookings per
    // ticket_class_id. Capacity is enforced atomically via the
    // check_oneoff_ticket_capacity pre-check / post-verify guard above, so there
    // is no decrement step here.

    // Send confirmation emails using event_email configuration
    const emailResults = [];
    console.log('[createOneOffEventBooking] Sending confirmation emails to attendees...');
    
    for (const booking of createdBookings) {
      const attendee = bookingAttendees.find(a => a.email === booking.attendee_email);
      const zoomResult = zoomRegistrationResults.find(r => r.email === booking.attendee_email);
      const personalizedZoomUrl = zoomResult?.join_url || null;
      const results = await sendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl, pricingDetails);
      emailResults.push(...results);
    }
    
    if (emailResults.length > 0) {
      console.log(`[createOneOffEventBooking] Sent ${emailResults.filter(r => r.success).length}/${emailResults.length} confirmation emails`);
    }

    // Subscribe donor to email communication list if donation_config has email_list_key and registrant is a member
    // Trigger on: event has donate mode enabled with a list configured, AND either a donation was made or event is in donate mode
    const hasDonationListConfig = event.donation_config?.enabled && event.donation_config?.email_list_key;
    if (hasDonationListConfig && member?.id) {
      const emailListCategoryId = event.donation_config.email_list_key;
      console.log(`[createOneOffEventBooking] Checking donation email list subscription for member ${member.id}, category: ${emailListCategoryId}`);
      
      try {
        // Validate that the communication category belongs to this event's tenant
        const { data: category, error: catError } = await supabase
          .from('communication_category')
          .select('id')
          .eq('id', emailListCategoryId)
          .eq('tenant_id', event.tenant_id)
          .maybeSingle();

        if (!category || catError) {
          console.warn(`[createOneOffEventBooking] Communication category ${emailListCategoryId} not found for tenant ${event.tenant_id} - skipping subscription`);
        } else {
          // Check if preference already exists
          const { data: existingPref } = await supabase
            .from('member_communication_preference')
            .select('id, is_subscribed')
            .eq('member_id', member.id)
            .eq('category_id', emailListCategoryId)
            .maybeSingle();

          if (existingPref) {
            if (!existingPref.is_subscribed) {
              await supabase
                .from('member_communication_preference')
                .update({ is_subscribed: true })
                .eq('id', existingPref.id);
              console.log(`[createOneOffEventBooking] Updated existing preference to subscribed for member ${member.id}`);
            } else {
              console.log(`[createOneOffEventBooking] Member ${member.id} already subscribed to list ${emailListCategoryId}`);
            }
          } else {
            await supabase
              .from('member_communication_preference')
              .insert({
                member_id: member.id,
                category_id: emailListCategoryId,
                is_subscribed: true
              });
            console.log(`[createOneOffEventBooking] Created new subscription for member ${member.id} to list ${emailListCategoryId}`);
          }
        }
      } catch (commPrefError) {
        console.error(`[createOneOffEventBooking] Failed to subscribe member to donation email list:`, commPrefError.message);
        // Don't fail the booking, just log the error
      }
    } else if (hasDonationListConfig && !member?.id) {
      const emailListCategoryId = event.donation_config.email_list_key;
      const guestEmail = guestInfo?.email || bookingAttendees?.[0]?.email;
      const guestFirstName = guestInfo?.first_name || bookingAttendees?.[0]?.first_name || null;
      const guestLastName = guestInfo?.last_name || bookingAttendees?.[0]?.last_name || null;

      if (guestEmail) {
        console.log(`[createOneOffEventBooking] Guest booking - subscribing ${guestEmail} to donation email list via email_subscriber`);
        try {
          const { data: category } = await supabase
            .from('communication_category')
            .select('id')
            .eq('id', emailListCategoryId)
            .eq('tenant_id', event.tenant_id)
            .maybeSingle();

          if (category) {
            await supabase
              .from('email_subscriber')
              .upsert({
                tenant_id: event.tenant_id,
                email: guestEmail.toLowerCase(),
                first_name: guestFirstName,
                last_name: guestLastName,
                communication_category_id: emailListCategoryId,
                opted_out: false,
                subscribed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }, {
                onConflict: 'tenant_id,email,communication_category_id'
              });
            console.log(`[createOneOffEventBooking] Guest ${guestEmail} subscribed to donation email list ${emailListCategoryId}`);
          } else {
            console.warn(`[createOneOffEventBooking] Communication category ${emailListCategoryId} not found for tenant ${event.tenant_id} - skipping guest subscription`);
          }
        } catch (guestSubError) {
          console.error(`[createOneOffEventBooking] Failed to subscribe guest to donation email list:`, guestSubError.message);
        }
      } else {
        console.log(`[createOneOffEventBooking] Guest booking but no email available - skipping email list subscription`);
      }
    }

    // If this is a group ticket, create the group booking record with a secure token
    let groupBookingResult = null;
    const selectedTicketClass = event.pricing_config?.ticket_classes?.find(tc => tc.id === ticketClassId);
    if (selectedTicketClass?.is_group_ticket && selectedTicketClass.group_size) {
      try {
        const groupToken = crypto.randomBytes(32).toString('hex');
        const bookerEmail = isGuestBooking ? guestInfo?.email : memberEmail;
        const bookerFirstName = isGuestBooking ? guestInfo?.first_name : (member?.first_name || null);
        const bookerLastName = isGuestBooking ? guestInfo?.last_name : (member?.last_name || null);

        const { data: groupBooking, error: groupError } = await supabase
          .from('event_group_booking')
          .insert({
            tenant_id: event.tenant_id,
            event_id: event.id,
            ticket_class_id: ticketClassId,
            booker_email: bookerEmail?.toLowerCase(),
            booker_first_name: bookerFirstName,
            booker_last_name: bookerLastName,
            token: groupToken,
            status: 'active',
            group_size: selectedTicketClass.group_size,
            stripe_payment_intent_id: stripePaymentIntentId,
            booking_reference: bookingReference,
            payment_method: paymentMethod,
            total_cost: totalCost
          })
          .select()
          .single();

        if (groupError) {
          console.error('[createOneOffEventBooking] Failed to create group booking:', groupError.message);
        } else {
          console.log('[createOneOffEventBooking] Group booking created:', groupBooking.id, 'token:', groupToken.substring(0, 8) + '...');

          // Build the group management URL
          let tenantSlug = null;
          const { data: tenantData } = await supabase
            .from('tenant')
            .select('slug')
            .eq('id', event.tenant_id)
            .single();
          tenantSlug = tenantData?.slug;

          const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
          let groupUrl;
          if (tenantSlug) {
            groupUrl = `https://${tenantSlug}.${APP_DOMAIN}/group-booking/${groupToken}`;
          } else {
            groupUrl = `${process.env.APP_URL || 'http://localhost:5000'}/group-booking/${groupToken}`;
          }

          groupBookingResult = {
            group_booking_id: groupBooking.id,
            token: groupToken,
            group_url: groupUrl,
            group_size: selectedTicketClass.group_size,
            cutoff_date: selectedTicketClass.group_cutoff_date || null
          };

          // Send group booking management email to the booker
          try {
            const cutoffText = selectedTicketClass.group_cutoff_date
              ? `\n\nPlease note: You must add all participants before ${new Date(selectedTicketClass.group_cutoff_date).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}. After this time, no further changes can be made.`
              : '';

            await sendEmail({
              to: bookerEmail,
              subject: `Your Group Booking for ${event.title} - Add Your Participants`,
              html: `
                <p>Hi ${bookerFirstName || 'there'},</p>
                <p>Thank you for your group booking for <strong>${event.title}</strong>.</p>
                <p>Your booking reference is: <strong>${bookingReference}</strong></p>
                <p>You have <strong>${selectedTicketClass.group_size} places</strong> available in your group. To add your participants, please use the link below:</p>
                <p><a href="${groupUrl}" style="display:inline-block;padding:12px 24px;background-color:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:bold;">Manage Your Group</a></p>
                <p>You can return to this link at any time to add or remove people from your group.${cutoffText}</p>
                <p>If you have any questions, please don't hesitate to contact us.</p>
              `,
              tenantId: event.tenant_id
            });
            console.log('[createOneOffEventBooking] Group booking email sent to:', bookerEmail);
          } catch (emailErr) {
            console.error('[createOneOffEventBooking] Failed to send group booking email:', emailErr.message);
          }
        }
      } catch (groupErr) {
        console.error('[createOneOffEventBooking] Group booking creation error:', groupErr.message);
      }
    }

    const response = {
      success: true,
      booking_reference: bookingReference,
      booking_group_reference: bookingReference,
      bookings: createdBookings,
      payment_details: {
        total_cost: totalCost,
        voucher_amount: voucherAmountApplied,
        training_fund_amount: validatedTrainingFundAmount,
        discount_code_amount: validatedDiscountAmount,
        account_amount: paymentMethod === 'account' ? validatedRemainingBalance : 0,
        card_amount: paymentMethod === 'card' ? validatedRemainingBalance : 0
      },
      xero_invoice: xeroInvoiceResult,
      group_booking: groupBookingResult
    };

    // Add confirmation email results
    if (emailResults.length > 0) {
      response.confirmation_emails = {
        results: emailResults,
        sent: emailResults.filter(r => r.success).length,
        failed: emailResults.filter(r => !r.success).length
      };
    }

    // Add Zoom registration results if applicable
    if (event.zoom_webinar_id && zoomRegistrationResults.length > 0) {
      response.zoom_registration = {
        webinar_id: event.zoom_webinar_id,
        registrations: zoomRegistrationResults,
        all_successful: zoomRegistrationResults.every(r => r.success !== false)
      };
    }

    if (sessionZoomRegistrationResults.length > 0) {
      response.session_zoom_registration = {
        registrations: sessionZoomRegistrationResults,
        all_successful: sessionZoomRegistrationResults.every(r => r.success !== false)
      };
    }

    return response;
  },

  async processProgramTicketPurchase(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const {
      organizationId,
      programName,
      quantity,
      paymentMethod,
      memberEmail,
      stripePaymentIntentId
    } = params;

    if (!programName || !quantity) {
      return { success: false, error: 'Missing required parameters' };
    }

    let org = null;

    // Try to find organization by ID first
    if (organizationId) {
      const { data: orgById } = await supabase
        .from('organization')
        .select('*')
        .eq('id', organizationId)
        .maybeSingle();
      org = orgById;

    }

    // If no org found by ID, try to find via member email
    if (!org && memberEmail) {
      const { data: member } = await supabase
        .from('member')
        .select('*')
        .ilike('email', memberEmail)
        .maybeSingle();

      if (member?.organization_id) {
        const { data: orgByMember } = await supabase
          .from('organization')
          .select('*')
          .eq('id', member.organization_id)
          .maybeSingle();
        org = orgByMember;
      }
    }

    if (!org) {
      return { success: false, error: 'Organization not found' };
    }

    const currentBalances = org.program_ticket_balances || {};
    const currentBalance = currentBalances[programName] || 0;
    const newBalance = currentBalance + quantity;

    const updatedBalances = { ...currentBalances, [programName]: newBalance };

    await supabase
      .from('organization')
      .update({ program_ticket_balances: updatedBalances, last_synced: new Date().toISOString() })
      .eq('id', org.id);

    const { data: transaction } = await supabase
      .from('program_ticket_transaction')
      .insert({
        organization_id: org.id,
        program_name: programName,
        transaction_type: 'purchase',
        quantity: quantity,
        payment_method: paymentMethod,
        member_email: memberEmail,
        stripe_payment_intent_id: stripePaymentIntentId,
        notes: `Purchased ${quantity} ${programName} ticket(s)`
      })
      .select()
      .single();

    return {
      success: true,
      transaction_id: transaction?.id,
      new_balance: newBalance,
      organization_id: org.id
    };
  },

  async syncBackstageEventsDeprecated() {
    return { 
      success: false, 
      error: 'Event sync should be triggered from admin panel in development environment' 
    };
  },

  async updateExpiredVouchers() {
    if (!supabase) throw new Error('Supabase not configured');
    
    const now = new Date().toISOString();
    
    const { data: expiredVouchers, error } = await supabase
      .from('voucher')
      .update({ status: 'expired' })
      .lt('expiry_date', now)
      .eq('status', 'active')
      .select();

    if (error) {
      return { success: false, error: error.message };
    }

    return { 
      success: true, 
      expired_count: expiredVouchers?.length || 0 
    };
  },

  async applyDiscountCode(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { code, memberEmail, eventId, amount, ticketClassId } = params;

    if (!code) {
      return { valid: false, error: 'Discount code is required' };
    }

    // Get tenant context for multi-tenant scoping
    let tenantId = null;
    
    // First try to get tenant from the event
    if (eventId) {
      const { data: event } = await supabase
        .from('event')
        .select('tenant_id')
        .eq('id', eventId)
        .maybeSingle();
      tenantId = event?.tenant_id;
    }
    
    // Fallback to request context if no event tenant found
    if (!tenantId && req) {
      try {
        const tenantContext = await getTenantContext(req);
        tenantId = tenantContext?.tenantId;
      } catch (e) {
        console.warn('[applyDiscountCode] Could not get tenant context:', e.message);
      }
    }

    // Require tenant context for security - fail closed if not available
    if (!tenantId) {
      console.error('[applyDiscountCode] No tenant context - rejecting discount code validation for security');
      return { valid: false, error: 'Unable to validate discount code - please try again' };
    }

    // SECURITY: Derive memberId from authenticated session, never trust client-supplied value
    let authenticatedMemberId = null;
    if (req) {
      try {
        const sessionMember = await getSessionMember(req);
        authenticatedMemberId = sessionMember?.id || null;
      } catch (e) {
        console.warn('[applyDiscountCode] Could not get session member:', e.message);
      }
    }

    // Query discount codes with required tenant filter for multi-tenant security
    const { data: discountCodes } = await supabase
      .from('discount_code')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .eq('tenant_id', tenantId);

    if (!discountCodes || discountCodes.length === 0) {
      return { valid: false, error: 'Invalid discount code' };
    }

    const discountCode = discountCodes[0];
    const isMemberTargeted = discountCode.member_id || discountCode.role_id || discountCode.member_group_id;

    // Use correct column names from database: expires_at, max_usage_count, current_usage_count, type, value
    if (discountCode.expires_at && new Date(discountCode.expires_at) < new Date()) {
      return { valid: false, error: 'Discount code has expired' };
    }

    // For non-member-targeted codes, check global usage count
    if (!isMemberTargeted) {
      if (discountCode.max_usage_count && discountCode.current_usage_count >= discountCode.max_usage_count) {
        return { valid: false, error: 'Discount code has reached maximum uses' };
      }
    }

    // Validate organization-targeted restriction
    // Supports both authenticated members and guests (lookup by email)
    if (discountCode.organization_id) {
      let memberOrgId = null;
      if (authenticatedMemberId) {
        const { data: memberForOrg } = await supabase
          .from('member')
          .select('organization_id')
          .eq('id', authenticatedMemberId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        memberOrgId = memberForOrg?.organization_id;
      } else if (memberEmail) {
        const { data: memberByEmail } = await supabase
          .from('member')
          .select('organization_id')
          .ilike('email', memberEmail)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        memberOrgId = memberByEmail?.organization_id;
      }
      if (!memberOrgId || memberOrgId !== discountCode.organization_id) {
        console.log('[applyDiscountCode] Member org', memberOrgId, 'does not match code org', discountCode.organization_id);
        return { valid: false, error: 'This discount code is not available for your organisation' };
      }
    }

    // Validate member-targeted restrictions using server-derived memberId
    if (discountCode.member_id) {
      if (!authenticatedMemberId) {
        console.log('[applyDiscountCode] Code is member-targeted but no authenticated member session');
        return { valid: false, error: 'This discount code is not available to you' };
      }
      if (discountCode.member_id !== authenticatedMemberId) {
        console.log('[applyDiscountCode] Code is targeted to member', discountCode.member_id, 'but requester is', authenticatedMemberId);
        return { valid: false, error: 'This discount code is not available to you' };
      }
    }

    if (discountCode.role_id) {
      if (!authenticatedMemberId) {
        console.log('[applyDiscountCode] Code is role-targeted but no authenticated member session');
        return { valid: false, error: 'This discount code is not available to you' };
      }
      const { data: memberRecord } = await supabase
        .from('member')
        .select('role_id')
        .eq('id', authenticatedMemberId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!memberRecord || memberRecord.role_id !== discountCode.role_id) {
        console.log('[applyDiscountCode] Member role', memberRecord?.role_id, 'does not match code role', discountCode.role_id);
        return { valid: false, error: 'This discount code is not available for your role' };
      }
    }

    if (discountCode.member_group_id) {
      if (!authenticatedMemberId) {
        console.log('[applyDiscountCode] Code is group-targeted but no authenticated member session');
        return { valid: false, error: 'This discount code is not available to you' };
      }
      const { data: groupAssignment } = await supabase
        .from('member_group_assignment')
        .select('id')
        .eq('member_id', authenticatedMemberId)
        .eq('group_id', discountCode.member_group_id)
        .maybeSingle();
      if (!groupAssignment) {
        console.log('[applyDiscountCode] Member', authenticatedMemberId, 'is not in group', discountCode.member_group_id);
        return { valid: false, error: 'This discount code is not available for your group' };
      }
    }

    // Validate event-targeted restriction
    if (discountCode.event_id) {
      if (!eventId || discountCode.event_id !== eventId) {
        console.log('[applyDiscountCode] Code is event-targeted to', discountCode.event_id, 'but applied to event', eventId);
        return { valid: false, error: 'This discount code is not valid for this event' };
      }
    }

    if (discountCode.ticket_class_id) {
      if (!ticketClassId || discountCode.ticket_class_id !== ticketClassId) {
        console.log('[applyDiscountCode] Code is ticket-class-targeted to', discountCode.ticket_class_id, 'but applied to ticket class', ticketClassId);
        return { valid: false, error: 'This discount code is not valid for your selected ticket' };
      }
    }

    // For member/role/group-targeted codes, check per-member usage against max_usage_count
    if (authenticatedMemberId && isMemberTargeted && discountCode.max_usage_count) {
      const { data: memberUsage } = await supabase
        .from('discount_code_usage')
        .select('usage_count')
        .eq('discount_code_id', discountCode.id)
        .eq('member_id', authenticatedMemberId)
        .maybeSingle();
      if (memberUsage && memberUsage.usage_count >= discountCode.max_usage_count) {
        return { valid: false, error: 'You have reached the maximum uses for this discount code' };
      }
    }

    let discountAmount = 0;
    if (discountCode.type === 'percentage') {
      discountAmount = (amount * discountCode.value) / 100;
    } else {
      discountAmount = discountCode.value;
    }

    return {
      valid: true,
      discount_code_id: discountCode.id,
      discount_type: discountCode.type,
      discount_value: discountCode.value,
      discount_amount: Math.min(discountAmount, amount),
      final_amount: Math.max(0, amount - discountAmount)
    };
  },

  async createJobPostingPaymentIntent(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const tenantContext = await getTenantContext(req);
    const tenantId = tenantContext.tenantId;
    
    if (!tenantId) {
      throw new Error('Unable to determine tenant context');
    }
    
    const stripe = await getStripeClient(tenantId, 'jobs');
    if (!stripe) throw new Error('Stripe not configured for this tenant');
    
    // Frontend sends: amount, currency, metadata: { job_posting_id, contact_email, company_name, job_title }
    const { amount, currency = 'gbp', metadata = {} } = params;

    let stripeCustomer = null;
    if (metadata.contact_email) {
      stripeCustomer = await findOrCreateStripeCustomer(stripe, {
        email: metadata.contact_email,
        name: metadata.company_name || undefined,
        metadata: { tenant_id: tenantId, type: 'job_posting' },
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      customer: stripeCustomer?.id || undefined,
      receipt_email: metadata.contact_email || undefined,
      metadata: {
        type: 'job_posting',
        job_posting_id: String(metadata.job_posting_id || ''),
        job_title: metadata.job_title || '',
        company_name: metadata.company_name || '',
        contact_email: metadata.contact_email || ''
      }
    });

    // Store PaymentIntent ID on job record for confirmation lookup
    if (metadata.job_posting_id) {
      await supabase
        .from('job_posting')
        .update({ stripe_payment_intent_id: paymentIntent.id })
        .eq('id', metadata.job_posting_id);
    }

    return { 
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    };
  },

  async setPublicHomePage(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { slug } = params;
    const settingKey = 'public_home_page_slug';
    
    // Get tenant context for proper multi-tenant isolation
    const { getTenantContext } = await import('../_lib/tenantContext.js');
    const tenantContext = await getTenantContext(req);
    const tenantId = tenantContext.tenantId;
    
    if (!tenantId) {
      console.error('[setPublicHomePage] No tenant context found');
      throw new Error('Unable to determine tenant context. Please ensure you are logged in.');
    }
    
    console.log(`[setPublicHomePage] Setting home page to: ${slug || '(none)'} for tenant: ${tenantId}`);

    // First try to find existing setting for this tenant
    const { data: tenantSettings, error: tenantFetchError } = await supabase
      .from('system_settings')
      .select('*')
      .eq('setting_key', settingKey)
      .eq('tenant_id', tenantId);

    if (tenantFetchError) {
      console.error('[setPublicHomePage] Error fetching tenant settings:', tenantFetchError);
      throw new Error(tenantFetchError.message);
    }

    // If we have a setting for this tenant, update it
    if (tenantSettings && tenantSettings.length > 0) {
      const existingSetting = tenantSettings[0];
      const { data, error } = await supabase
        .from('system_settings')
        .update({ setting_value: slug || '' })
        .eq('id', existingSetting.id)
        .select()
        .single();

      if (error) {
        console.error('[setPublicHomePage] Error updating setting:', error);
        throw new Error(error.message);
      }

      console.log('[setPublicHomePage] Updated existing tenant setting:', data);
      return { success: true, data };
    }

    // Check if there's an existing setting without tenant_id (legacy data)
    const { data: legacySettings, error: legacyFetchError } = await supabase
      .from('system_settings')
      .select('*')
      .eq('setting_key', settingKey)
      .is('tenant_id', null);

    if (legacyFetchError) {
      console.error('[setPublicHomePage] Error fetching legacy settings:', legacyFetchError);
    }

    // If there's a legacy setting without tenant_id, update it with tenant_id
    if (legacySettings && legacySettings.length > 0) {
      const legacySetting = legacySettings[0];
      const { data, error } = await supabase
        .from('system_settings')
        .update({ 
          setting_value: slug || '',
          tenant_id: tenantId
        })
        .eq('id', legacySetting.id)
        .select()
        .single();

      if (error) {
        console.error('[setPublicHomePage] Error updating legacy setting:', error);
        throw new Error(error.message);
      }

      console.log('[setPublicHomePage] Updated legacy setting with tenant_id:', data);
      return { success: true, data };
    }

    // No existing setting found, try to create new one
    // Use upsert to handle race conditions and constraint violations
    const { data, error } = await supabase
      .from('system_settings')
      .upsert({
        setting_key: settingKey,
        setting_value: slug || '',
        tenant_id: tenantId
      }, {
        onConflict: 'tenant_id,setting_key',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) {
      console.error('[setPublicHomePage] Error upserting setting:', error);
      throw new Error(error.message);
    }

    console.log('[setPublicHomePage] Upserted setting:', data);
    return { success: true, data };
  },

  async createJobPostingMember(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const {
      title,
      description,
      company_name,
      company_logo_url,
      location,
      salary_range,
      job_type,
      hours,
      closing_date,
      application_method,
      application_value,
      contact_email,
      contact_name,
      memberEmail,
      attachment_urls = [],
      attachment_names = []
    } = params;

    console.log('[createJobPostingMember] Creating job posting');
    console.log('[createJobPostingMember] Provided email:', memberEmail);

    let member = null;

    // Get tenant context ONCE and reuse it for all lookups
    const tenantContext = req ? await getTenantContext(req) : null;
    console.log('[createJobPostingMember] Tenant context:', JSON.stringify({
      tenantId: tenantContext?.tenantId,
      memberId: tenantContext?.memberId,
      tenantUserId: tenantContext?.tenantUserId,
      isAuthenticated: tenantContext?.isAuthenticated
    }));

    // PRIMARY: Use memberId from getTenantContext if available
    if (tenantContext?.memberId) {
      const { data: contextMember, error: contextError } = await supabase
        .from('member')
        .select('*')
        .eq('id', tenantContext.memberId)
        .single();
      
      if (contextMember && !contextError) {
        member = contextMember;
        console.log('[createJobPostingMember] Found member via tenant context:', member.id, member.email);
      } else {
        console.warn('[createJobPostingMember] Failed to fetch member from context memberId:', contextError?.message);
      }
    }

    // FALLBACK 1: Try email lookup with tenant scoping for security
    // CRITICAL: Filter by tenant_id to prevent cross-tenant member lookup
    if (!member && memberEmail && tenantContext?.tenantId) {
      const normalizedEmail = memberEmail.toLowerCase().trim();
      console.log('[createJobPostingMember] Fallback 1: Tenant-scoped email lookup:', normalizedEmail, 'tenant:', tenantContext.tenantId);
      
      // Join with organization to get tenant-scoped members
      const { data: emailMembers, error: emailError } = await supabase
        .from('member')
        .select('*, organization!inner(tenant_id)')
        .ilike('email', normalizedEmail)
        .eq('organization.tenant_id', tenantContext.tenantId);
      
      if (emailMembers && emailMembers.length > 0 && !emailError) {
        member = emailMembers[0];
        console.log('[createJobPostingMember] Found member via tenant-scoped email:', member.id, member.email);
      } else {
        // Also check members without organization but with matching tenant context
        console.log('[createJobPostingMember] Org-scoped email lookup failed, trying direct member lookup');
        const { data: directMembers, error: directError } = await supabase
          .from('member')
          .select('*')
          .ilike('email', normalizedEmail);
        
        if (directMembers && directMembers.length > 0 && !directError) {
          // Filter to match tenant - check if member's org belongs to this tenant
          for (const m of directMembers) {
            if (m.organization_id) {
              const { data: org } = await supabase
                .from('organization')
                .select('tenant_id')
                .eq('id', m.organization_id)
                .single();
              if (org?.tenant_id === tenantContext.tenantId) {
                member = m;
                console.log('[createJobPostingMember] Found member via direct lookup with tenant check:', member.id);
                break;
              }
            }
          }
        }
        if (!member) {
          console.warn('[createJobPostingMember] Tenant-scoped email lookup failed:', emailError?.message || 'no results');
        }
      }
    }

    // FALLBACK 2: Try tenant_user_member_link table if we have tenantUserId
    if (!member && tenantContext?.tenantUserId) {
      console.log('[createJobPostingMember] Fallback 2: Checking tenant_user_member_link for tenantUserId:', tenantContext.tenantUserId);
      
      try {
        const { data: link, error: linkError } = await supabase
          .from('tenant_user_member_link')
          .select('member_id')
          .eq('tenant_user_id', tenantContext.tenantUserId)
          .single();
        
        if (link && !linkError) {
          const { data: linkedMember, error: linkedError } = await supabase
            .from('member')
            .select('*')
            .eq('id', link.member_id)
            .single();
          
          if (linkedMember && !linkedError) {
            member = linkedMember;
            console.log('[createJobPostingMember] Found member via tenant_user_member_link:', member.id, member.email);
          }
        } else {
          console.log('[createJobPostingMember] No tenant_user_member_link found:', linkError?.message || 'no link');
        }
      } catch (err) {
        // Handle case where tenant_user_member_link table doesn't exist
        console.log('[createJobPostingMember] tenant_user_member_link lookup failed (table may not exist):', err.message);
      }
    }

    if (!member) {
      console.error('[createJobPostingMember] Member not found via tenant context, email, or tenant_user link');
      return { success: false, error: 'Member not found. Please log in again.' };
    }

    // Get organization name if member has an organization
    let organizationName = null;
    if (member.organization_id) {
      const { data: allOrgs } = await supabase.from('organization').select('*');
      const org = allOrgs?.find(o => o.id === member.organization_id);
      if (org) {
        organizationName = org.name;
      }
    }

    // Get tenant_id from tenantContext or from member's organization
    let tenantId = tenantContext?.tenantId;
    if (!tenantId && member.organization_id) {
      const { data: org } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', member.organization_id)
        .single();
      tenantId = org?.tenant_id;
    }
    
    // CRITICAL: tenant_id is required for the job to appear in queries
    if (!tenantId) {
      console.error('[createJobPostingMember] FAILED: Could not determine tenant_id');
      return { success: false, error: 'Could not determine tenant context. Please log in again.' };
    }
    console.log('[createJobPostingMember] Using tenant_id:', tenantId);

    const { data: jobPosting, error } = await supabase
      .from('job_posting')
      .insert({
        tenant_id: tenantId,
        title,
        description,
        company_name,
        company_logo_url: company_logo_url || null,
        location,
        salary_range: salary_range || null,
        job_type: job_type || null,
        hours: hours || null,
        closing_date,
        application_method,
        application_value,
        contact_email: memberEmail,
        contact_name,
        posted_by_member_id: member.id,
        posted_by_organization_id: member.organization_id || null,
        posted_by_organization_name: organizationName,
        is_member_post: true,
        status: 'pending_approval',
        payment_status: 'N/A',
        attachment_urls,
        attachment_names,
        created_date: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, job_id: jobPosting.id, job_posting: jobPosting };
  },

  async createJobPostingNonMember(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const {
      title,
      description,
      company_name,
      company_logo_url,
      location,
      salary_range,
      job_type,
      hours,
      closing_date,
      application_method,
      application_value,
      contact_email,
      contact_name,
      attachment_urls = [],
      attachment_names = []
    } = params;

    // Get pricing from system settings
    let price = 50; // Default price in GBP
    const { data: settings } = await supabase
      .from('system_settings')
      .select('*')
      .eq('setting_key', 'job_posting_price');
    
    if (settings && settings.length > 0) {
      price = parseFloat(settings[0].setting_value);
    }

    // Calculate expiry date (90 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 90);

    const { data: jobPosting, error } = await supabase
      .from('job_posting')
      .insert({
        title,
        description,
        company_name,
        company_logo_url: company_logo_url || '',
        location,
        salary_range: salary_range || '',
        job_type,
        hours: hours || null,
        closing_date,
        application_method,
        application_value,
        contact_email,
        contact_name,
        is_member_post: false,
        status: 'pending_payment',
        payment_status: 'pending',
        expiry_date: expiryDate.toISOString(),
        amount_paid: price,
        attachment_urls,
        attachment_names,
        created_date: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, job_id: jobPosting.id, job_posting: jobPosting };
  },

  async confirmJobPostingPayment(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { jobPostingId, paymentIntentId } = params;
    
    console.log('[confirmJobPostingPayment] Confirming payment for job:', jobPostingId, 'paymentIntent:', paymentIntentId);
    
    if (!jobPostingId || !paymentIntentId) {
      return { success: false, error: 'Missing jobPostingId or paymentIntentId' };
    }
    
    // First, try to find the job by ID to get the tenant
    const { data: jobPosting } = await supabase
      .from('job_posting')
      .select('*')
      .eq('id', jobPostingId)
      .single();
    
    if (!jobPosting) {
      return { success: false, error: 'Job posting not found' };
    }
    
    // Get tenant-scoped Stripe client from job posting's tenant
    const stripe = await getStripeClient(jobPosting.tenant_id, 'jobs');
    if (!stripe) throw new Error('Stripe not configured for this tenant');
    
    // Verify payment was successful with Stripe
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      
      console.log('[confirmJobPostingPayment] PaymentIntent status:', paymentIntent.status);
      
      if (paymentIntent.status !== 'succeeded') {
        return { success: false, error: `Payment not confirmed. Status: ${paymentIntent.status}` };
      }
      
      // Verify either via metadata or stored PaymentIntent ID on the job record
      const metadataMatch = String(paymentIntent.metadata.job_posting_id) === String(jobPostingId);
      const storedMatch = jobPosting.stripe_payment_intent_id === paymentIntentId;
      
      if (!metadataMatch && !storedMatch) {
        console.error('[confirmJobPostingPayment] Payment verification failed:', {
          metadataJobId: paymentIntent.metadata.job_posting_id,
          providedJobId: jobPostingId,
          storedPaymentIntentId: jobPosting.stripe_payment_intent_id,
          providedPaymentIntentId: paymentIntentId
        });
        return { success: false, error: 'Payment verification failed - job posting mismatch' };
      }
      
      // Check if already processed
      if (jobPosting.status !== 'pending_payment') {
        console.log('[confirmJobPostingPayment] Job already processed, status:', jobPosting.status);
        return { success: true, job_posting: jobPosting, message: 'Job already processed' };
      }
      
      // Update job posting status to pending_approval
      const { data: updatedJob, error: updateError } = await supabase
        .from('job_posting')
        .update({
          status: 'pending_approval',
          payment_status: 'paid',
          stripe_payment_intent_id: paymentIntentId,
          payment_date: new Date().toISOString()
        })
        .eq('id', jobPostingId)
        .select()
        .single();
      
      if (updateError) {
        console.error('[confirmJobPostingPayment] Update error:', updateError);
        return { success: false, error: updateError.message };
      }
      
      console.log('[confirmJobPostingPayment] Successfully updated job to pending_approval');
      return { success: true, job_posting: updatedJob };
      
    } catch (error) {
      console.error('[confirmJobPostingPayment] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async cancelProgramTicketTransaction(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { transactionId, reason, memberEmail } = params;

    const { data: transaction } = await supabase
      .from('program_ticket_transaction')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    if (transaction.transaction_type !== 'usage') {
      return { success: false, error: 'Can only cancel usage transactions' };
    }

    const { data: org } = await supabase
      .from('organization')
      .select('*')
      .eq('id', transaction.organization_id)
      .single();

    if (!org) {
      return { success: false, error: 'Organization not found' };
    }

    const currentBalances = org.program_ticket_balances || {};
    const currentBalance = currentBalances[transaction.program_name] || 0;
    const newBalance = currentBalance + transaction.quantity;

    await supabase
      .from('organization')
      .update({
        program_ticket_balances: { ...currentBalances, [transaction.program_name]: newBalance }
      })
      .eq('id', org.id);

    await supabase
      .from('program_ticket_transaction')
      .update({
        cancelled_at: new Date().toISOString(),
        cancelled_by_member_email: memberEmail,
        cancellation_reason: reason
      })
      .eq('id', transactionId);

    await supabase
      .from('program_ticket_transaction')
      .insert({
        organization_id: org.id,
        program_name: transaction.program_name,
        transaction_type: 'refund',
        quantity: transaction.quantity,
        member_email: memberEmail,
        notes: `Refund for cancelled transaction. Reason: ${reason || 'Not specified'}`
      });

    return {
      success: true,
      refunded_quantity: transaction.quantity,
      new_balance: newBalance
    };
  },

  async reinstateProgramTicketTransaction(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { transactionId, memberEmail } = params;

    const { data: transaction } = await supabase
      .from('program_ticket_transaction')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    if (!transaction.cancelled_at) {
      return { success: false, error: 'Transaction is not cancelled' };
    }

    const { data: org } = await supabase
      .from('organization')
      .select('*')
      .eq('id', transaction.organization_id)
      .single();

    if (!org) {
      return { success: false, error: 'Organization not found' };
    }

    const currentBalances = org.program_ticket_balances || {};
    const currentBalance = currentBalances[transaction.program_name] || 0;
    const newBalance = currentBalance - transaction.quantity;

    if (newBalance < 0) {
      return { success: false, error: 'Insufficient balance to reinstate transaction' };
    }

    await supabase
      .from('organization')
      .update({
        program_ticket_balances: { ...currentBalances, [transaction.program_name]: newBalance }
      })
      .eq('id', org.id);

    await supabase
      .from('program_ticket_transaction')
      .update({
        cancelled_at: null,
        cancelled_by_member_email: null,
        cancellation_reason: null,
        notes: transaction.notes + ` | Reinstated by ${memberEmail} on ${new Date().toISOString()}`
      })
      .eq('id', transactionId);

    return {
      success: true,
      reinstated_quantity: transaction.quantity,
      new_balance: newBalance
    };
  },

  async syncBackstageEvents(params) {
    // Zoho Backstage integration deprecated - events are now managed directly in the application
    return { 
      success: false, 
      error: 'Zoho Backstage integration has been deprecated. Events are now managed directly in the application.' 
    };
  },

  async syncEventsFromBackstage(params) {
    return this.syncBackstageEvents(params);
  },

  async cancelTicketViaFlow(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { orderId, cancelReason = "Cancelled by member via iConnect", memberId } = params;

    if (!orderId || !memberId) {
      return { success: false, error: 'Missing required parameters: orderId and memberId' };
    }

    const { data: allBookings } = await supabase.from('booking').select('*');
    const booking = allBookings?.find(b => b.backstage_order_id === orderId);

    if (!booking) {
      return { success: false, error: 'Booking not found with this order ID' };
    }

    if (booking.member_id !== memberId) {
      return { success: false, error: 'Unauthorized: You can only cancel your own bookings' };
    }

    if (booking.status === 'cancelled') {
      return { success: true, message: 'Ticket already cancelled' };
    }

    const { data: allEvents } = await supabase.from('event').select('*');
    const event = allEvents?.find(e => e.id === booking.event_id);

    const { data: allMembers } = await supabase.from('member').select('*');
    const member = allMembers?.find(m => m.id === booking.member_id);

    let organizationId = member?.organization_id;

    if (organizationId && event?.program_tag) {
      const { data: org } = await supabase
        .from('organization')
        .select('*')
        .eq('id', organizationId)
        .single();

      if (org) {
        const currentBalances = org.program_ticket_balances || {};
        const currentBalance = currentBalances[event.program_tag] || 0;
        const newBalance = currentBalance + 1;

        await supabase.from('organization').update({
          program_ticket_balances: { ...currentBalances, [event.program_tag]: newBalance },
          last_synced: new Date().toISOString()
        }).eq('id', org.id);

        await supabase.from('program_ticket_transaction').insert({
          organization_id: org.id,
          program_name: event.program_tag,
          transaction_type: 'refund',
          quantity: 1,
          booking_reference: booking.booking_reference || orderId,
          event_name: event.title || 'Unknown Event',
          member_email: member?.email || booking.attendee_email || 'unknown',
          notes: `Ticket refunded due to cancellation: ${cancelReason}`
        });
      }
    }

    await supabase.from('booking').update({ status: 'cancelled' }).eq('id', booking.id);

    return { success: true, message: 'Ticket cancelled successfully' };
  },

  async cancelBackstageOrder(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { orderId, cancelReason = "Cancelled by member" } = params;

    if (!orderId) {
      return { success: false, error: 'Missing required parameter: orderId' };
    }

    // Find booking by backstage order ID or regular booking ID
    const { data: booking } = await supabase
      .from('booking')
      .select('*')
      .or(`backstage_order_id.eq.${orderId},id.eq.${orderId}`)
      .single();

    if (!booking) {
      return { success: false, error: 'No booking found with this order ID' };
    }

    if (booking.status === 'cancelled') {
      return { success: true, message: 'Booking already cancelled' };
    }

    // Cancel the booking locally
    await supabase.from('booking').update({ status: 'cancelled' }).eq('id', booking.id);

    return { success: true, message: 'Booking cancelled successfully' };
  },

  async processBackstageCancellation(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const webhookData = params;
    const action = webhookData.action;
    const resourceType = webhookData.resource;
    const backstageOrderId = webhookData.resource_id;

    if (action === 'cancel' && resourceType === 'eventorder') {
      if (!backstageOrderId) {
        return { success: false, error: 'Missing order ID in payload' };
      }

      const { data: allBookings } = await supabase.from('booking').select('*');
      const bookingToCancel = allBookings?.find(b => b.backstage_order_id === backstageOrderId && b.status !== 'cancelled');

      if (bookingToCancel) {
        await supabase.from('booking').update({ status: 'cancelled' }).eq('id', bookingToCancel.id);
        return { success: true, message: `Cancelled booking for Backstage Order ID: ${backstageOrderId}`, booking_id: bookingToCancel.id };
      }

      return { success: true, message: `No active booking found for Backstage Order ID: ${backstageOrderId}` };
    }

    return { success: true, message: 'Webhook received but not an expected order cancellation event' };
  },

  async checkMemberStatusByEmail(params) {
    if (!supabase) {
      return { 
        is_member: false, 
        has_job_posting_access: false,
        debug: { error: 'Supabase not configured' }
      };
    }
    
    const { email } = params;

    if (!email) {
      return { is_member: false, has_job_posting_access: false, debug: { error: 'Email is required' } };
    }

    const searchEmail = email.toLowerCase().trim();
    console.log('[checkMemberStatusByEmail] Checking email:', searchEmail);
    
    try {
      // Query directly by email using case-insensitive match
      const { data: members, error: memberError } = await supabase
        .from('member')
        .select('*')
        .ilike('email', searchEmail);
      
      console.log('[checkMemberStatusByEmail] Query result - found:', members?.length || 0);
      
      if (memberError) {
        console.error('[checkMemberStatusByEmail] Database error:', memberError);
        return { 
          is_member: false, 
          has_job_posting_access: false, 
          debug: { 
            error: memberError.message,
            code: memberError.code,
            searchedEmail: searchEmail
          }
        };
      }

      if (members && members.length > 0) {
        const member = members[0];
        
        // Check if member has job posting access based on their role
        let has_job_posting_access = true; // Default to true if no role restrictions
        
        if (member.role_id) {
          const { data: role } = await supabase
            .from('role')
            .select('*')
            .eq('id', member.role_id)
            .single();
          
          if (role && role.excluded_features) {
            const excludedFeatures = Array.isArray(role.excluded_features) 
              ? role.excluded_features 
              : [];
            // Check if the member's role has access to jobs.post-job (not excluded)
            has_job_posting_access = !isResourceExcluded(excludedFeatures, 'jobs.post-job');
          }
        }

        return {
          is_member: true,
          has_job_posting_access,
          member_id: member.id,
          organization_id: member.organization_id,
          first_name: member.first_name,
          last_name: member.last_name,
          debug: { searchedEmail: searchEmail, foundEmail: member.email }
        };
      }

      return { 
        is_member: false, 
        has_job_posting_access: false, 
        debug: { searchedEmail: searchEmail, message: 'No member found with this email' }
      };
    } catch (err) {
      return { 
        is_member: false, 
        has_job_posting_access: false, 
        debug: { error: err.message, searchedEmail: searchEmail }
      };
    }
  },

  async validateUser(params) {
    return this.validateMember(params);
  },

  // Zoho CRM sync functions removed - integration deprecated (syncAllOrganizationsFromZoho, syncAllMembersFromZoho)

  async exportAllData() {
    return { success: false, error: 'Data export should be triggered from admin panel in development environment' };
  },

  async sendTeamMemberInvite(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email, inviterName, inviterEmail, emailSubject, emailBody, organizationId: paramOrgId } = params;
    
    if (!email) {
      return { success: false, error: 'Email is required' };
    }
    
    if (!inviterEmail) {
      return { success: false, error: 'Inviter email is required' };
    }

    // Resolve tenant_id from request for scoped lookups
    let resolvedTenantId = null;
    try {
      const tenantContext = await getTenantContext(req);
      resolvedTenantId = tenantContext?.tenantId || null;
    } catch (e) {
      console.warn('[sendTeamMemberInvite] Could not resolve tenant context:', e.message);
    }
    
    // Get base URL for signup link
    let baseUrl = process.env.SITE_URL;
    if (!baseUrl && process.env.VERCEL_URL) {
      baseUrl = `https://${process.env.VERCEL_URL}`;
    }
    if (!baseUrl && req?.headers?.origin) {
      baseUrl = req.headers.origin;
    }
    if (!baseUrl) {
      console.error('[sendTeamMemberInvite] Base URL could not be determined');
      return { success: false, error: 'Server configuration error: site URL not set' };
    }
    
    // Check if the invitee already has a member record (tenant-scoped if possible)
    let existingMemberQuery = supabase
      .from('member')
      .select('id, organization_id, email')
      .eq('email', email.toLowerCase());
    if (resolvedTenantId) existingMemberQuery = existingMemberQuery.eq('tenant_id', resolvedTenantId);
    const { data: existingMember } = await existingMemberQuery.maybeSingle();
    
    // Get the inviter's details including organization and tenant_id for email domain (tenant-scoped if possible)
    let inviterQuery = supabase
      .from('member')
      .select('id, first_name, last_name, organization_id, tenant_id')
      .eq('email', inviterEmail.toLowerCase());
    if (resolvedTenantId) inviterQuery = inviterQuery.eq('tenant_id', resolvedTenantId);
    const { data: inviter } = await inviterQuery.maybeSingle();
    
    const organizationId = inviter?.organization_id || paramOrgId || null;
    const inviterFullName = inviter ? `${inviter.first_name || ''} ${inviter.last_name || ''}`.trim() : inviterName || '';
    
    // If the invitee already exists, check if they belong to a different organization
    if (existingMember) {
      if (existingMember.organization_id && existingMember.organization_id !== organizationId) {
        console.log(`[sendTeamMemberInvite] Invitee ${email} already belongs to a different organization`);
        return { success: false, error: 'This person is already a member of another organization' };
      }
      // If they're already in this organization, they can still receive the invite (maybe they need to set up password)
      console.log(`[sendTeamMemberInvite] Invitee ${email} already exists, sending invite anyway`);
    }
    
    // Fetch organization details (extra fields supplied so the generic
    // placeholder helper below can resolve [[organization.invoicing_email]]
    // and [[organization.phone]] in invite templates).
    let organizationName = '';
    let organizationInvoicingEmail = '';
    let organizationPhone = '';
    if (organizationId) {
      const { data: org } = await supabase
        .from('organization')
        .select('id, name, invoicing_email, phone')
        .eq('id', organizationId)
        .maybeSingle();
      organizationName = org?.name || '';
      organizationInvoicingEmail = org?.invoicing_email || '';
      organizationPhone = org?.phone || '';
    }
    
    // Build the signup/login link with organization_id parameter
    // Note: Member record is NOT created here - it will be created when the invitee
    // completes the signup form. This prevents zombie members from unanswered invites.
    const signupLink = `${baseUrl}/login?email=${encodeURIComponent(email)}${organizationId ? `&organization_id=${organizationId}` : ''}`;
    
    // Build the email content
    let finalSubject = emailSubject || `You're invited to join our team`;
    let finalBody = emailBody || `
      <p>Hi,</p>
      <p>${inviterFullName} has invited you to join the team.</p>
      <p>Click the link below to sign up and set up your account:</p>
      <p><a href="{{invite_link}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invitation</a></p>
    `;
    
    // Replace {{placeholder}} syntax
    finalBody = finalBody.replace(/\{\{invite_link\}\}/gi, signupLink);
    finalBody = finalBody.replace(/\{\{inviter_name\}\}/gi, inviterFullName);
    finalBody = finalBody.replace(/\{\{invitee_email\}\}/gi, email);
    finalBody = finalBody.replace(/\{\{organization_name\}\}/gi, organizationName);
    finalBody = finalBody.replace(/\{\{organization_id\}\}/gi, organizationId || '');
    
    // Run subject + body through the generic placeholder helper so every
    // [[member.*]] / [[organization.*]] token in the catalog stays in sync
    // without each new field requiring a hand-rolled .replace pair here.
    // The helper supports both `{{member.field}}` and `[[member.field]]`.
    finalSubject = finalSubject.replace(/\{\{inviter_name\}\}/gi, inviterFullName);
    finalSubject = finalSubject.replace(/\{\{organization_name\}\}/gi, organizationName);

    // Underscore aliases (member_first_name, organization_name, ...) are
    // included so prefix-less tokens like [[member_first_name]] continue to
    // resolve via the helper's direct-lookup fallback path. The previous
    // hand-rolled .replace ladder supported those aliases — preserving them
    // here prevents a regression in existing user-edited invite templates.
    const inviterMemberContext = {
      id: inviter?.id || '',
      first_name: inviter?.first_name || '',
      last_name: inviter?.last_name || '',
      full_name: inviterFullName,
      email: inviterEmail,
      member_id: inviter?.id || '',
      member_first_name: inviter?.first_name || '',
      member_last_name: inviter?.last_name || '',
      member_full_name: inviterFullName,
      member_email: inviterEmail,
      organization_id: organizationId || '',
      organization_name: organizationName,
      organization_invoicing_email: organizationInvoicingEmail,
      organization_phone: organizationPhone,
    };
    const placeholderContext = {
      tenantId: inviter?.tenant_id || resolvedTenantId || null,
      memberId: inviter?.id || null,
    };
    finalBody = replacePlaceholders(finalBody, 'member', inviterMemberContext, placeholderContext);
    finalSubject = replacePlaceholders(finalSubject, 'member', inviterMemberContext, placeholderContext);
    
    // Send email via Mailgun with tenant context for proper email domain
    const emailResult = await sendEmail({
      to: email,
      subject: finalSubject,
      html: finalBody,
      tenantId: inviter?.tenant_id
    });
    
    if (!emailResult.success) {
      console.error('[sendTeamMemberInvite] Email send failed:', emailResult.error);
      return { success: false, error: 'Failed to send invitation email: ' + emailResult.error };
    }
    
    console.log(`[sendTeamMemberInvite] Invitation sent to ${email} by ${inviterFullName} (org: ${organizationId})`);
    
    return { success: true, message: 'Invitation sent successfully' };
  },

  async renameResourceSubcategory(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    const { oldSubcategoryName, newSubcategoryName, categoryId } = params;

    if (!oldSubcategoryName || !newSubcategoryName) {
      return { success: false, error: 'Both oldSubcategoryName and newSubcategoryName are required' };
    }

    if (!categoryId) {
      return { success: false, error: 'categoryId is required' };
    }

    const tenantContext = await getTenantContext(req);
    const tenantId = tenantContext?.tenantId;
    if (!tenantId) {
      return { success: false, error: 'Unable to determine tenant context' };
    }

    // Step 1: Rename in the canonical subcategories array on the parent category.
    const { data: category, error: catError } = await supabase
      .from('resource_category')
      .select('id, subcategories')
      .eq('id', categoryId)
      .eq('tenant_id', tenantId)
      .single();

    if (catError || !category) {
      return { success: false, error: 'Resource category not found' };
    }

    const currentSubs = Array.isArray(category.subcategories) ? category.subcategories : [];
    if (!currentSubs.includes(oldSubcategoryName)) {
      return { success: false, error: 'Subcategory not found in category' };
    }

    const updatedSubs = currentSubs.map((s) => (s === oldSubcategoryName ? newSubcategoryName : s));
    const { error: catUpdateError } = await supabase
      .from('resource_category')
      .update({ subcategories: updatedSubs })
      .eq('id', categoryId)
      .eq('tenant_id', tenantId);

    if (catUpdateError) {
      return { success: false, error: 'Failed to update category subcategories: ' + catUpdateError.message };
    }

    // Step 2: Migrate resource rows whose subcategories array contains the old name.
    const { data: resources, error: resourceFetchError } = await supabase
      .from('resource')
      .select('id, subcategories')
      .contains('subcategories', [oldSubcategoryName])
      .eq('tenant_id', tenantId);

    if (resourceFetchError) {
      return { success: false, error: 'Failed to fetch resources for migration: ' + resourceFetchError.message };
    }

    const resourceCount = resources?.length || 0;
    if (resourceCount > 0) {
      for (const resource of resources) {
        const currentSubs = Array.isArray(resource.subcategories) ? resource.subcategories : [];
        // Replace old name with new name, dedupe in case new name was already present
        const newSubs = [...new Set(currentSubs.map((s) => (s === oldSubcategoryName ? newSubcategoryName : s)))];
        const { error: resourceUpdateError } = await supabase
          .from('resource')
          .update({ subcategories: newSubs })
          .eq('id', resource.id)
          .eq('tenant_id', tenantId);
        if (resourceUpdateError) {
          return { success: false, error: `Failed to update resource ${resource.id}: ` + resourceUpdateError.message };
        }
      }
    }

    // Step 3: Update member_group.resource_subcategories arrays that reference the old name.
    let groupsUpdated = 0;
    const groupUpdateFailures = [];
    const { data: groups, error: groupFetchError } = await supabase
      .from('member_group')
      .select('id, resource_subcategories')
      .eq('tenant_id', tenantId);

    if (groupFetchError) {
      console.warn(`[renameResourceSubcategory] Failed to fetch member groups for tenant ${tenantId}: ${groupFetchError.message}. Group-scoped resource links may still reference the old name "${oldSubcategoryName}".`);
      groupUpdateFailures.push({ groupId: null, error: groupFetchError.message });
    } else if (Array.isArray(groups)) {
      for (const group of groups) {
        const linked = Array.isArray(group.resource_subcategories) ? group.resource_subcategories : [];
        if (linked.includes(oldSubcategoryName)) {
          const updatedLinked = linked.map((s) => (s === oldSubcategoryName ? newSubcategoryName : s));
          const { error: groupUpdateError } = await supabase
            .from('member_group')
            .update({ resource_subcategories: updatedLinked })
            .eq('id', group.id)
            .eq('tenant_id', tenantId);
          if (groupUpdateError) {
            console.warn(`[renameResourceSubcategory] Failed to update member_group ${group.id} resource_subcategories from "${oldSubcategoryName}" to "${newSubcategoryName}": ${groupUpdateError.message}`);
            groupUpdateFailures.push({ groupId: group.id, error: groupUpdateError.message });
          } else {
            groupsUpdated++;
          }
        }
      }
    }

    // Step 4: Update members' saved filter preferences in member_resource_category.
    // These store subcategory selections as plain strings; without this, a renamed
    // subcategory silently stops matching and the member's saved filter shows nothing.
    // Scoped by resource_category_id (already tenant-verified above) so no tenant_id column is needed.
    const { error: memberPrefUpdateError } = await supabase
      .from('member_resource_category')
      .update({ subcategory_name: newSubcategoryName })
      .eq('resource_category_id', categoryId)
      .eq('subcategory_name', oldSubcategoryName);

    if (memberPrefUpdateError) {
      return { success: false, error: 'Failed to update member category preferences: ' + memberPrefUpdateError.message };
    }

    const partialFailure = groupUpdateFailures.length > 0;

    let message = resourceCount > 0
      ? `Subcategory renamed successfully (${resourceCount} resource${resourceCount !== 1 ? 's' : ''} updated)`
      : 'Subcategory renamed successfully';
    if (partialFailure) {
      message += `. Warning: ${groupUpdateFailures.length} member group link${groupUpdateFailures.length !== 1 ? 's' : ''} could not be updated and may still reference the old name — run scripts/resync-resource-subcategories.mjs --fix-groups to repair.`;
    }

    return {
      success: true,
      updated: resourceCount,
      groupsUpdated,
      partialFailure,
      groupUpdateFailures,
      message,
    };
  },

  async handleJobPostingPaymentWebhook(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { paymentIntentId, jobPostingId, status } = params;

    // Can be called with either paymentIntentId (legacy) or jobPostingId (from payment_intent.succeeded metadata)
    if (!paymentIntentId && !jobPostingId) {
      return { success: false, error: 'Missing payment intent ID or job posting ID' };
    }

    if (status === 'succeeded') {
      let jobPosting = null;
      
      // First try to find by job_posting_id (preferred, from payment intent metadata)
      if (jobPostingId) {
        const { data } = await supabase.from('job_posting').select('*').eq('id', jobPostingId).single();
        jobPosting = data;
      }
      
      // Fallback to finding by stripe_payment_intent_id (legacy)
      if (!jobPosting && paymentIntentId) {
        const { data: jobPostings } = await supabase.from('job_posting').select('*').eq('stripe_payment_intent_id', paymentIntentId);
        jobPosting = jobPostings?.[0];
      }

      // Get the tenant name for email branding
      let tenantName = 'The Team';
      if (jobPosting?.tenant_id) {
        const { data: tenantData } = await supabase
          .from('tenant')
          .select('name')
          .eq('id', jobPosting.tenant_id)
          .single();
        if (tenantData?.name) {
          tenantName = `${tenantData.name} Team`;
        }
      }

      if (jobPosting) {
        // Update job posting status to pending_approval (not active - needs admin review)
        await supabase.from('job_posting').update({ 
          payment_status: 'paid', 
          status: 'pending_approval',
          stripe_payment_intent_id: paymentIntentId || jobPosting.stripe_payment_intent_id
        }).eq('id', jobPosting.id);
        
        // Send email notifications
        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        const mailgunFromEmail = process.env.MAILGUN_FROM_EMAIL;
        
        if (mailgunApiKey && mailgunDomain) {
          try {
            const FormData = (await import('form-data')).default;
            const Mailgun = (await import('mailgun.js')).default;
            const mailgun = new Mailgun(FormData);
            const mg = mailgun.client({
              username: 'api',
              key: mailgunApiKey
            });
            
            // Send confirmation to poster
            await mg.messages.create(mailgunDomain, {
              from: mailgunFromEmail,
              to: jobPosting.contact_email,
              subject: 'Job Posting Payment Confirmed - Pending Approval',
              html: `
                <h2>Payment Confirmed!</h2>
                <p>Dear ${jobPosting.contact_name},</p>
                <p>Your payment of £${jobPosting.amount_paid} for the job posting <strong>${jobPosting.title}</strong> at <strong>${jobPosting.company_name}</strong> has been received successfully.</p>
                <p>Your job posting is now pending approval from our team. You'll receive another email once it's approved and live on the job board.</p>
                <p><strong>Job Details:</strong></p>
                <ul>
                  <li>Title: ${jobPosting.title}</li>
                  <li>Company: ${jobPosting.company_name}</li>
                  <li>Location: ${jobPosting.location}</li>
                  <li>Type: ${jobPosting.job_type}</li>
                </ul>
                <p>Best regards,<br>${tenantName}</p>
              `
            });
            
            // Notify users with job posting management access
            const { data: allRoles } = await supabase
              .from('role')
              .select('*');
            
            // Filter to roles that have job posting management access
            const jobManagementRoles = allRoles?.filter(r => {
              const excludedFeatures = r.excluded_features || [];
              return !excludedFeatures.includes('admin.job-postings');
            }) || [];
            
            if (jobManagementRoles.length > 0) {
              const roleIds = jobManagementRoles.map(r => r.id);
              const { data: allMembers } = await supabase.from('member').select('*');
              const notifyMembers = allMembers?.filter(m => roleIds.includes(m.role_id)) || [];
              
              for (const member of notifyMembers) {
                await mg.messages.create(mailgunDomain, {
                  from: mailgunFromEmail,
                  to: member.email,
                  subject: 'New Paid Job Posting Awaiting Approval',
                  html: `
                    <h2>New Paid Job Posting Submitted</h2>
                    <p>A non-member has paid and submitted a new job posting that requires approval:</p>
                    <p><strong>Job Details:</strong></p>
                    <ul>
                      <li>Title: ${jobPosting.title}</li>
                      <li>Company: ${jobPosting.company_name}</li>
                      <li>Location: ${jobPosting.location}</li>
                      <li>Posted by: ${jobPosting.contact_name} (${jobPosting.contact_email})</li>
                      <li>Amount Paid: £${jobPosting.amount_paid}</li>
                    </ul>
                    <p>Please log in to the admin portal to review and approve this posting.</p>
                  `
                });
              }
            }
          } catch (emailError) {
            console.error('[handleJobPostingPaymentWebhook] Email error:', emailError);
          }
        }
        
        return { success: true, job_posting_id: jobPosting.id };
      }
    }

    return { success: true, message: 'Webhook processed' };
  },

  async clearProgramTicketTransactions(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { organizationId, programName, confirmClear } = params;

    if (!confirmClear) {
      return { success: false, error: 'Confirmation required to clear transactions' };
    }

    let query = supabase.from('program_ticket_transaction').delete();

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    if (programName) {
      query = query.eq('program_name', programName);
    }

    const { error } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, message: 'Transactions cleared' };
  },

  async clearBookings(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { eventId, confirmClear } = params;

    if (!confirmClear) {
      return { success: false, error: 'Confirmation required to clear bookings' };
    }

    let query = supabase.from('booking').delete();

    if (eventId) {
      query = query.eq('event_id', eventId);
    }

    const { error } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, message: 'Bookings cleared' };
  },

  async updateProgramDetails(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { programId, ...updateData } = params;

    if (!programId) {
      return { success: false, error: 'Program ID is required' };
    }

    const { data, error } = await supabase.from('program').update(updateData).eq('id', programId).select().single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, program: data };
  },

  async updateEventImage(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { eventId, imageUrl, thumbnailUrl } = params;

    if (!eventId) {
      return { success: false, error: 'Event ID is required' };
    }

    const updatePayload = {};
    if (imageUrl !== undefined) updatePayload.image_url = imageUrl;
    if (thumbnailUrl !== undefined) updatePayload.thumbnail_url = thumbnailUrl;

    if (Object.keys(updatePayload).length === 0) {
      return { success: false, error: 'No update data provided' };
    }

    await supabase.from('event').update(updatePayload).eq('id', eventId);

    return { success: true, ...updatePayload };
  },

  // getZohoAuthUrl removed - Zoho CRM integration deprecated

  async registerAttendeeToZoom(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { eventId, bookingId, attendeeEmail, attendeeFirstName, attendeeLastName } = params;

    if (!eventId || !attendeeEmail) {
      return { success: false, error: 'Missing required parameters: eventId and attendeeEmail' };
    }

    // Get the event
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      return { success: false, error: 'Event not found' };
    }

    // Check if event has a Zoom webinar
    if (!event.zoom_webinar_id) {
      return { success: false, error: 'Event does not have an associated Zoom webinar' };
    }

    // Get the webinar details
    const { data: webinar, error: webinarError } = await supabase
      .from('zoom_webinar')
      .select('*')
      .eq('id', event.zoom_webinar_id)
      .single();

    if (webinarError || !webinar) {
      return { success: false, error: 'Zoom webinar not found' };
    }

    if (!webinar.registration_required) {
      return { success: false, error: 'Webinar does not require registration' };
    }

    if (!webinar.zoom_webinar_id) {
      return { success: false, error: 'Webinar not synced with Zoom' };
    }

    // Register the attendee to Zoom
    try {
      const token = await getZoomAccessTokenForTenant(event.tenant_id);
      
      console.log(`[Zoom] Registering ${attendeeEmail} for webinar ${webinar.zoom_webinar_id}`);
      
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            first_name: attendeeFirstName || 'Guest',
            last_name: attendeeLastName || 'Attendee',
            email: attendeeEmail,
            auto_approve: true
          })
        }
      );

      if (!zoomResponse.ok) {
        const errorData = await zoomResponse.json().catch(() => ({}));
        console.error('[Zoom] Registration error:', errorData);
        
        if (errorData.code === 3027) {
          return { success: true, message: 'Already registered for this webinar' };
        }
        
        return { 
          success: false, 
          error: errorData.message || 'Failed to register with Zoom'
        };
      }

      const zoomData = await zoomResponse.json();
      
      // Update booking with Zoom registrant ID if bookingId provided
      if (bookingId && zoomData.registrant_id) {
        await supabase
          .from('booking')
          .update({ zoom_registrant_id: zoomData.registrant_id })
          .eq('id', bookingId);
      }

      return {
        success: true,
        registrant_id: zoomData.registrant_id,
        join_url: zoomData.join_url
      };
    } catch (error) {
      console.error('[Zoom] Registration error:', error);
      return { success: false, error: error.message || 'Failed to register with Zoom' };
    }
  },

  async registerBookingAttendeesToZoom(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { bookingReference } = params;

    if (!bookingReference) {
      return { success: false, error: 'Booking reference is required' };
    }

    // Get all bookings with this reference
    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('*')
      .eq('booking_reference', bookingReference);

    if (bookingsError || !bookings || bookings.length === 0) {
      return { success: false, error: 'Bookings not found' };
    }

    const eventId = bookings[0].event_id;

    // Get the event
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event || !event.zoom_webinar_id) {
      return { success: true, message: 'Event has no Zoom webinar', registered: 0 };
    }

    // Get the webinar
    const { data: webinar, error: webinarError } = await supabase
      .from('zoom_webinar')
      .select('*')
      .eq('id', event.zoom_webinar_id)
      .single();

    if (webinarError || !webinar || !webinar.registration_required || !webinar.zoom_webinar_id) {
      return { success: true, message: 'Webinar does not require registration', registered: 0 };
    }

    const token = await getZoomAccessTokenForTenant(event.tenant_id);
    const results = [];

    for (const booking of bookings) {
      if (!booking.attendee_email || booking.zoom_registrant_id) {
        continue;
      }

      try {
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              first_name: booking.attendee_first_name || 'Guest',
              last_name: booking.attendee_last_name || 'Attendee',
              email: booking.attendee_email,
              auto_approve: true
            })
          }
        );

        if (zoomResponse.ok) {
          const zoomData = await zoomResponse.json();
          
          await supabase
            .from('booking')
            .update({ zoom_registrant_id: zoomData.registrant_id })
            .eq('id', booking.id);
          
          results.push({ email: booking.attendee_email, success: true, registrant_id: zoomData.registrant_id });
        } else {
          const errorData = await zoomResponse.json().catch(() => ({}));
          results.push({ email: booking.attendee_email, success: false, error: errorData.message || 'Registration failed' });
        }
      } catch (error) {
        results.push({ email: booking.attendee_email, success: false, error: error.message });
      }
    }

    return {
      success: true,
      registered: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  },

  // ============ Xero Integration Functions ============
  // NOTE: These legacy functions are deprecated - use /api/xero/* endpoints instead
  // They are kept for backwards compatibility but now use tenant-scoped credentials

  async getXeroAuthUrl(params, req) {
    // This is a legacy function - the new flow uses /api/xero/auth-url
    const tenantContext = await getTenantContext(req, supabase);
    if (!tenantContext?.tenant?.id) {
      throw new Error('Tenant context required for Xero auth');
    }
    
    const xeroCredentials = await getXeroCredentials(tenantContext.tenant.id);
    
    if (!xeroCredentials || !xeroCredentials.client_id) {
      throw new Error('Xero not configured. Please add your Xero credentials in Admin > Integrations.');
    }

    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const redirectUri = `${protocol}://${host}/api/xero/callback`;

    const authUrl = `https://login.xero.com/identity/connect/authorize?` + new URLSearchParams({
      response_type: 'code',
      client_id: xeroCredentials.client_id,
      redirect_uri: redirectUri,
      scope: 'offline_access accounting.transactions accounting.contacts accounting.settings openid profile email',
      state: Buffer.from(JSON.stringify({ tenantId: tenantContext.tenant.id })).toString('base64')
    }).toString();

    return { authUrl };
  },

  async xeroOAuthCallback(params, req) {
    // This is a legacy function - the new flow uses /api/xero/callback
    throw new Error('This function is deprecated. Use /api/xero/callback endpoint instead.');
  },

  async refreshXeroToken(params, req) {
    // This function now requires tenant context
    if (!supabase) throw new Error('Supabase not configured');

    const tenantContext = await getTenantContext(req, supabase);
    if (!tenantContext?.tenant?.id) {
      throw new Error('Tenant context required for Xero token refresh');
    }

    const xeroCredentials = await getXeroCredentials(tenantContext.tenant.id);
    
    if (!xeroCredentials || !xeroCredentials.client_id || !xeroCredentials.client_secret) {
      throw new Error('Xero credentials not configured for this tenant');
    }

    const { data: tokens } = await supabase
      .from('xero_token')
      .select('*')
      .eq('app_tenant_id', tenantContext.tenant.id);

    if (!tokens || tokens.length === 0) {
      throw new Error('No Xero token found. Please authenticate first.');
    }

    const currentToken = tokens[0];

    // Check if token needs refresh
    const expiresAt = new Date(currentToken.expires_at);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    if (expiresAt > fiveMinutesFromNow) {
      return {
        message: 'Token is still valid',
        expires_at: currentToken.expires_at
      };
    }

    // Refresh the token
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${xeroCredentials.client_id}:${xeroCredentials.client_secret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentToken.refresh_token,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(`Failed to refresh token: ${JSON.stringify(tokenData)}`);
    }

    const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

    await supabase
      .from('xero_token')
      .update({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: newExpiresAt,
      })
      .eq('id', currentToken.id);

    return {
      success: true,
      message: 'Token refreshed successfully',
      expires_at: newExpiresAt
    };
  },

  async createXeroInvoice(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    const {
      organizationName,
      purchaseOrderNumber,
      programName,
      baseTicketPrice,
      totalCost,
      totalTickets,
      offerDetails,
      discountCode,
      discountType,
      discountValue,
      stripePaymentIntentId,
      internalReference,
      appTenantId: providedTenantId,
      eventXeroAccountCode,
      eventId
    } = params;

    if (!organizationName || !programName || totalCost === undefined || !totalTickets) {
      throw new Error('Missing required parameters: organizationName, programName, totalCost, totalTickets');
    }
    
    // Derive appTenantId from session if not provided (backward compatibility)
    let appTenantId = providedTenantId;
    if (!appTenantId && req) {
      const sessionMember = await getSessionMember(req);
      if (sessionMember?.tenant_id) {
        appTenantId = sessionMember.tenant_id;
        console.log('[createXeroInvoice] Derived appTenantId from session:', appTenantId);
      }
    }
    
    if (!appTenantId) {
      throw new Error('Missing required parameter: appTenantId for Xero tenant scoping (or authenticated session with tenant context)');
    }

    // Get valid Xero token
    const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);

    // Find or create contact
    const contactId = await findOrCreateXeroContact(accessToken, tenantId, organizationName);
    
    // Get Xero settings from system settings - tenant-scoped
    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    
    const systemDefaultAccountCode = accountCodeSetting?.setting_value || '200';
    
    let resolvedEventCode = (eventXeroAccountCode || '').trim();
    if (!resolvedEventCode && eventId) {
      const { data: eventRecord } = await supabase
        .from('event')
        .select('xero_account_code')
        .eq('id', eventId)
        .eq('tenant_id', appTenantId)
        .maybeSingle();
      resolvedEventCode = (eventRecord?.xero_account_code || '').trim();
    }
    const xeroAccountCode = resolvedEventCode || systemDefaultAccountCode;
    
    const { data: invoiceStatusSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_invoice_status')
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    
    const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

    // Calculate unit price
    const unitPrice = (totalCost / totalTickets).toFixed(2);

    // Build line description
    let description = `${programName} tickets.\nPrice: £${baseTicketPrice}`;
    if (offerDetails) {
      description += `\nOffer: ${offerDetails}`;
    }
    if (internalReference) {
      description += `\nRef: ${internalReference}`;
    }
    if (discountCode) {
      const discountDisplay = discountType === 'percentage'
        ? `${discountValue}%`
        : `£${(discountValue || 0).toFixed(2)}`;
      description += `\nDiscount Code: ${discountCode} (${discountDisplay} off)`;
    }
    if (stripePaymentIntentId) {
      description += `\nStripe Payment ID: ${stripePaymentIntentId}`;
    }

    // Create invoice
    const invoicePayload = {
      Invoices: [{
        Type: 'ACCREC',
        Contact: { ContactID: contactId },
        Reference: purchaseOrderNumber || '',
        Status: xeroInvoiceStatus,
        DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        LineItems: [{
          Description: description,
          Quantity: totalTickets,
          UnitAmount: unitPrice,
          AccountCode: xeroAccountCode
        }]
      }]
    };

    const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(invoicePayload)
    });

    const invoiceData = await invoiceResponse.json();

    if (!invoiceResponse.ok || !invoiceData.Invoices || invoiceData.Invoices.length === 0) {
      throw new Error(`Failed to create invoice: ${JSON.stringify(invoiceData)}`);
    }

    const invoice = invoiceData.Invoices[0];

    return {
      success: true,
      invoice_id: invoice.InvoiceID,
      invoice_number: invoice.InvoiceNumber,
      total: invoice.Total,
      status: invoice.Status
    };
  },

  async updateXeroInvoicePO(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    // Verify authentication
    const session = await getSession(req);
    if (!session?.data?.memberId) {
      throw new Error('Authentication required - please refresh the page and try again');
    }
    const memberId = session.data.memberId;

    const { bookingGroupReference, purchaseOrderNumber } = params;

    if (!bookingGroupReference) {
      throw new Error('Missing required parameter: bookingGroupReference');
    }

    if (!purchaseOrderNumber || !String(purchaseOrderNumber).trim()) {
      throw new Error('Missing required parameter: purchaseOrderNumber');
    }

    const trimmedPo = String(purchaseOrderNumber).trim();

    // Verify the caller owns a row in this group; that row's tenant is then
    // used to scope every subsequent read/write.
    const { data: ownerRow, error: ownerError } = await supabase
      .from('booking')
      .select('id, member_id, tenant_id')
      .eq('booking_group_reference', bookingGroupReference)
      .eq('member_id', memberId)
      .limit(1)
      .maybeSingle();

    if (ownerError) {
      throw new Error(`Failed to fetch booking: ${ownerError.message}`);
    }

    if (!ownerRow) {
      throw new Error('Not authorized to update this booking');
    }

    // Scope the invoice lookup by the verified owner row's tenant so the
    // group reference can never resolve to another tenant's invoice.
    let invoiceLookup = supabase
      .from('booking')
      .select('xero_invoice_id, xero_invoice_number, tenant_id')
      .eq('booking_group_reference', bookingGroupReference)
      .not('xero_invoice_id', 'is', null);

    if (ownerRow.tenant_id) {
      invoiceLookup = invoiceLookup.eq('tenant_id', ownerRow.tenant_id);
    }

    const { data: invoiceRow } = await invoiceLookup.limit(1).maybeSingle();

    // Save locally first so the user's edit survives a Xero outage.
    let updateQuery = supabase
      .from('booking')
      .update({
        purchase_order_number: trimmedPo,
        po_to_follow: false
      })
      .eq('booking_group_reference', bookingGroupReference);

    if (ownerRow.tenant_id) {
      updateQuery = updateQuery.eq('tenant_id', ownerRow.tenant_id);
    }

    const { error: updateError } = await updateQuery;

    if (updateError) {
      throw new Error(`Failed to update booking PO number: ${updateError.message}`);
    }

    console.log(`[updateXeroInvoicePO] Booking PO number saved locally for group ${bookingGroupReference}`);

    // Legacy rows may pre-date the tenant_id backfill; fall back to the member's tenant.
    let appTenantId = invoiceRow?.tenant_id || ownerRow.tenant_id || null;
    if (!appTenantId) {
      const { data: memberData } = await supabase
        .from('member')
        .select('tenant_id')
        .eq('id', memberId)
        .single();
      appTenantId = memberData?.tenant_id || null;
    }

    let xeroUpdated = false;
    let xeroError = null;
    try {
      const _provider = await getAccountingProvider(appTenantId);
      const _r = await _provider.pushPurchaseOrder({
        appTenantId,
        xeroInvoiceId: invoiceRow?.xero_invoice_id || null,
        purchaseOrderNumber: trimmedPo,
        contextLabel: `updateXeroInvoicePO group ${bookingGroupReference}`
      });
      xeroUpdated = _r.xeroUpdated;
      xeroError = _r.xeroError;
    } catch (_provErr) {
      xeroError = _provErr.message;
    }

    try {
      const { sendPoSubmissionNotification } = await import('../_lib/poNotificationEmail.js');
      const { data: notifyBooking } = await supabase
        .from('booking')
        .select('booking_reference, event_id, attendee_first_name, attendee_last_name, attendee_email')
        .eq('booking_group_reference', bookingGroupReference)
        .eq('tenant_id', appTenantId || ownerRow.tenant_id)
        .limit(1)
        .maybeSingle();

      let eventName = '';
      if (notifyBooking?.event_id) {
        const { data: ev } = await supabase
          .from('event')
          .select('title')
          .eq('id', notifyBooking.event_id)
          .maybeSingle();
        eventName = ev?.title || '';
      }

      let submitterName = [notifyBooking?.attendee_first_name, notifyBooking?.attendee_last_name]
        .filter(Boolean).join(' ').trim();
      let submitterEmail = notifyBooking?.attendee_email || '';
      if (!submitterName || !submitterEmail) {
        const { data: memberRow } = await supabase
          .from('member')
          .select('first_name, last_name, email')
          .eq('id', memberId)
          .maybeSingle();
        if (memberRow) {
          if (!submitterName) {
            submitterName = [memberRow.first_name, memberRow.last_name].filter(Boolean).join(' ').trim();
          }
          if (!submitterEmail) submitterEmail = memberRow.email || '';
        }
      }

      await sendPoSubmissionNotification({
        tenantId: appTenantId || ownerRow.tenant_id,
        bookingReference: notifyBooking?.booking_reference || bookingGroupReference,
        eventName,
        purchaseOrderNumber: trimmedPo,
        submitterName,
        submitterEmail,
        bookingType: 'event',
      });
    } catch (notifyErr) {
      console.error('[updateXeroInvoicePO] PO notification email failed:', notifyErr.message);
    }

    return {
      success: true,
      invoice_id: invoiceRow?.xero_invoice_id || null,
      invoice_number: invoiceRow?.xero_invoice_number || null,
      reference: trimmedPo,
      xeroUpdated,
      xeroError
    };
  },

  async getXeroConnectionStatus(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { appTenantId } = params || {};
    
    // Build query with optional tenant filter
    let query = supabase
      .from('xero_token')
      .select('expires_at, tenant_id, app_tenant_id');
    
    if (appTenantId) {
      query = query.eq('app_tenant_id', appTenantId);
    }
    
    const { data: tokens } = await query;

    if (!tokens || tokens.length === 0) {
      return {
        connected: false,
        message: appTenantId 
          ? 'Xero not connected for this tenant. Please authenticate.'
          : 'Xero not connected. Please authenticate.'
      };
    }

    const token = tokens[0];
    const expiresAt = new Date(token.expires_at);
    const now = new Date();

    return {
      connected: true,
      tenant_id: token.tenant_id,
      app_tenant_id: token.app_tenant_id,
      expires_at: token.expires_at,
      is_expired: expiresAt <= now
    };
  },

  // Test handler to simulate Stripe payment recording in Xero without actual Stripe transactions
  async testXeroPaymentRecording(params, req) {
    if (!supabase) throw new Error('Supabase not configured');

    const { invoiceId, amount, testReference, appTenantId: providedTenantId } = params;
    const debug = {};

    // Validate inputs
    if (!invoiceId) {
      return { success: false, error: 'Invoice ID is required (Xero InvoiceID or Invoice Number)' };
    }
    if (!amount || amount <= 0) {
      return { success: false, error: 'Amount must be a positive number' };
    }
    
    // Derive appTenantId from session if not provided (backward compatibility)
    let appTenantId = providedTenantId;
    if (!appTenantId && req) {
      const sessionMember = await getSessionMember(req);
      if (sessionMember?.tenant_id) {
        appTenantId = sessionMember.tenant_id;
        console.log('[testXeroPaymentRecording] Derived appTenantId from session:', appTenantId);
      }
    }
    
    if (!appTenantId) {
      return { success: false, error: 'appTenantId is required for Xero tenant scoping (or authenticated session with tenant context)' };
    }

    try {
      // Get valid Xero token
      const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);
      debug.tokenObtained = true;

      // Get Stripe bank account code from system settings - tenant-scoped
      const { data: stripeBankCodeSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'xero_stripe_bank_account_code')
        .eq('tenant_id', appTenantId)
        .maybeSingle();

      const stripeBankAccountCode = stripeBankCodeSetting?.setting_value;
      debug.stripeBankAccountCode = stripeBankAccountCode || 'NOT CONFIGURED';

      if (!stripeBankAccountCode) {
        return {
          success: false,
          error: 'Stripe bank account code not configured in Event Settings',
          debug
        };
      }

      // First, fetch the invoice to verify it exists and get its status
      let invoiceUrl;
      // If it looks like an invoice number (starts with letters like INV, SI, etc.), search by number using where clause
      if (invoiceId.match(/^[A-Z]{2,}/i)) {
        // Xero requires the where clause format for filtering by InvoiceNumber
        invoiceUrl = `https://api.xero.com/api.xro/2.0/Invoices?where=InvoiceNumber=="${encodeURIComponent(invoiceId)}"`;
      } else {
        // Assume it's a UUID/InvoiceID
        invoiceUrl = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`;
      }
      debug.requestedInvoiceId = invoiceId;
      debug.invoiceUrl = invoiceUrl;

      console.log(`[TestXeroPayment] Fetching invoice: ${invoiceUrl}`);
      const invoiceResponse = await fetch(invoiceUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Accept': 'application/json'
        }
      });

      const invoiceData = await invoiceResponse.json();
      const invoice = invoiceData?.Invoices?.[0];

      if (!invoice) {
        return {
          success: false,
          error: `Invoice not found: ${invoiceId}`,
          debug: { ...debug, invoiceResponse: JSON.stringify(invoiceData).substring(0, 500) }
        };
      }

      debug.invoiceFound = true;
      debug.invoiceNumber = invoice.InvoiceNumber;
      debug.invoiceStatus = invoice.Status;
      debug.invoiceTotal = invoice.Total;
      debug.invoiceAmountDue = invoice.AmountDue;

      // Check if invoice is AUTHORISED
      if (invoice.Status !== 'AUTHORISED') {
        return {
          success: false,
          error: `Invoice is ${invoice.Status} - must be AUTHORISED for payment recording. Change Invoice Status to "Live" in Event Settings.`,
          debug
        };
      }

      // Get bank account ID from account code
      console.log(`[TestXeroPayment] Looking up bank account: ${stripeBankAccountCode}`);
      const accountsResponse = await fetch(`https://api.xero.com/api.xro/2.0/Accounts?where=Code=="${stripeBankAccountCode}"`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Accept': 'application/json'
        }
      });

      const accountsData = await accountsResponse.json();
      const bankAccount = accountsData?.Accounts?.[0];

      if (!bankAccount?.AccountID) {
        return {
          success: false,
          error: `Bank account not found for code: ${stripeBankAccountCode}. Check your Stripe Bank Account Code in Event Settings.`,
          debug: { ...debug, accountsResponse: JSON.stringify(accountsData).substring(0, 500) }
        };
      }

      debug.bankAccountFound = true;
      debug.bankAccountName = bankAccount.Name;
      debug.bankAccountId = bankAccount.AccountID;

      // Create payment
      const paymentPayload = {
        Invoice: { InvoiceID: invoice.InvoiceID },
        Account: { AccountID: bankAccount.AccountID },
        Date: new Date().toISOString().split('T')[0],
        Amount: parseFloat(amount),
        Reference: testReference || `TEST-${Date.now()}`
      };

      console.log(`[TestXeroPayment] Creating payment: ${JSON.stringify(paymentPayload)}`);

      const paymentResponse = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ Payments: [paymentPayload] })
      });

      const paymentData = await paymentResponse.json();

      if (paymentData?.Payments?.[0]?.PaymentID) {
        console.log(`[TestXeroPayment] Payment recorded successfully: ${paymentData.Payments[0].PaymentID}`);
        return {
          success: true,
          message: 'Payment recorded successfully in Xero',
          paymentId: paymentData.Payments[0].PaymentID,
          invoiceNumber: invoice.InvoiceNumber,
          amount: parseFloat(amount),
          reference: paymentPayload.Reference,
          bankAccount: bankAccount.Name,
          debug
        };
      } else {
        console.error(`[TestXeroPayment] Payment failed: ${JSON.stringify(paymentData)}`);
        return {
          success: false,
          error: 'Failed to create payment in Xero',
          xeroError: paymentData?.ErrorMessage || JSON.stringify(paymentData).substring(0, 500),
          debug
        };
      }

    } catch (error) {
      console.error(`[TestXeroPayment] Error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        debug
      };
    }
  },

  async backfillJobPostingCreatedDates(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    // Find all job postings where created_date is null but created_at exists
    const { data: jobsToFix, error: fetchError } = await supabase
      .from('job_posting')
      .select('id, created_at, created_date')
      .is('created_date', null);
    
    if (fetchError) {
      return { success: false, error: fetchError.message };
    }
    
    if (!jobsToFix || jobsToFix.length === 0) {
      return { success: true, message: 'No job postings need updating', updated: 0 };
    }
    
    let updatedCount = 0;
    const errors = [];
    
    for (const job of jobsToFix) {
      const dateToUse = job.created_at || new Date().toISOString();
      
      const { error: updateError } = await supabase
        .from('job_posting')
        .update({ created_date: dateToUse })
        .eq('id', job.id);
      
      if (updateError) {
        errors.push({ id: job.id, error: updateError.message });
      } else {
        updatedCount++;
      }
    }
    
    return {
      success: errors.length === 0,
      message: `Updated ${updatedCount} of ${jobsToFix.length} job postings`,
      updated: updatedCount,
      total: jobsToFix.length,
      errors: errors.length > 0 ? errors : undefined
    };
  },

  // ============ Organization Notes CRUD ============
  
  async getOrganizationNotes(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { organization_id } = params;
    
    if (!organization_id) {
      return { success: false, error: 'Organization ID is required' };
    }

    // Fetch notes
    const { data: notes, error: fetchError } = await supabase
      .from('organization_note')
      .select('*')
      .eq('organization_id', organization_id)
      .order('created_at', { ascending: false });

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }

    // Get member names for the notes
    const memberIds = [...new Set((notes || []).map(n => n.member_id))];
    let membersMap = {};
    
    if (memberIds.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .in('id', memberIds);
      
      if (members) {
        membersMap = members.reduce((acc, m) => {
          acc[m.id] = m;
          return acc;
        }, {});
      }
    }

    // Enrich notes with member info
    const enrichedNotes = (notes || []).map(note => ({
      ...note,
      member_name: membersMap[note.member_id] 
        ? `${membersMap[note.member_id].first_name || ''} ${membersMap[note.member_id].last_name || ''}`.trim() || membersMap[note.member_id].email
        : 'Unknown',
      member_email: membersMap[note.member_id]?.email || null
    }));

    return { success: true, notes: enrichedNotes };
  },

  async createOrganizationNote(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { organization_id, member_id, content } = params;
    
    if (!organization_id || !member_id || !content) {
      return { success: false, error: 'Organization ID, member ID, and content are required' };
    }

    const { data: note, error: insertError } = await supabase
      .from('organization_note')
      .insert({
        organization_id,
        member_id,
        content: content.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      return { success: false, error: insertError.message };
    }

    // Get member info for the response
    const { data: member } = await supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('id', member_id)
      .single();

    return {
      success: true,
      note: {
        ...note,
        member_name: member 
          ? `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email
          : 'Unknown',
        member_email: member?.email || null
      }
    };
  },

  async updateOrganizationNote(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { note_id, content } = params;
    
    if (!note_id || !content) {
      return { success: false, error: 'Note ID and content are required' };
    }

    // Check if note exists
    const { data: existingNote, error: fetchError } = await supabase
      .from('organization_note')
      .select('*')
      .eq('id', note_id)
      .single();

    if (fetchError || !existingNote) {
      return { success: false, error: 'Note not found' };
    }

    const { data: updatedNote, error: updateError } = await supabase
      .from('organization_note')
      .update({
        content: content.trim(),
        updated_at: new Date().toISOString()
      })
      .eq('id', note_id)
      .select()
      .single();

    if (updateError) {
      return { success: false, error: updateError.message };
    }

    return { success: true, note: updatedNote };
  },

  async deleteOrganizationNote(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { note_id } = params;
    
    if (!note_id) {
      return { success: false, error: 'Note ID is required' };
    }

    // Check if note exists
    const { data: existingNote, error: fetchError } = await supabase
      .from('organization_note')
      .select('id')
      .eq('id', note_id)
      .single();

    if (fetchError || !existingNote) {
      return { success: false, error: 'Note not found' };
    }

    const { error: deleteError } = await supabase
      .from('organization_note')
      .delete()
      .eq('id', note_id);

    if (deleteError) {
      return { success: false, error: deleteError.message };
    }

    return { success: true };
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { functionName, ...queryParams } = req.query;

  // Handle OAuth callbacks that come as GET requests
  const oauthCallbackFunctions = ['xeroOAuthCallback'];
  
  if (req.method === 'GET' && oauthCallbackFunctions.includes(functionName)) {
    try {
      const handlerFn = functionHandlers[functionName];
      if (!handlerFn) {
        return res.status(404).send('Callback handler not found');
      }
      
      // Pass query params (code, state, error) as the params
      const result = await handlerFn(queryParams, req);
      
      // Return an HTML page that closes the popup
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Authentication Complete</title></head>
          <body>
            <h2>${result.success ? '✓ Authentication Successful' : '✗ Authentication Failed'}</h2>
            <p>${result.message || (result.success ? 'You can close this window.' : 'Please try again.')}</p>
            <script>
              setTimeout(function() { window.close(); }, 2000);
            </script>
          </body>
        </html>
      `;
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    } catch (error) {
      console.error(`OAuth callback ${functionName} error:`, error);
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Authentication Error</title></head>
          <body>
            <h2>✗ Authentication Failed</h2>
            <p>${error.message || 'An error occurred during authentication.'}</p>
            <script>
              setTimeout(function() { window.close(); }, 3000);
            </script>
          </body>
        </html>
      `;
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const handlerFn = functionHandlers[functionName];
    
    if (!handlerFn) {
      console.log(`Function called: ${functionName}`, req.body);
      return res.json({ 
        success: false, 
        error: `Function '${functionName}' is not yet implemented in serverless`
      });
    }

    const result = await handlerFn(req.body, req);
    return res.json(result);
  } catch (error) {
    console.error(`Function ${functionName} error:`, error);
    return res.status(500).json({ error: error.message || 'Function execution failed' });
  }
}
