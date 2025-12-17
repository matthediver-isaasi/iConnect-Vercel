import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getSession, getSessionMember } from '../_lib/session.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { sendEmail } from '../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;

// Xero OAuth credentials
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;

// Helper: Get valid Xero access token (refreshes if needed)
async function getValidXeroAccessToken() {
  if (!supabase) throw new Error('Supabase not configured');
  
  const { data: tokens } = await supabase
    .from('xero_token')
    .select('*');

  if (!tokens || tokens.length === 0) {
    throw new Error('No Xero token found. Please authenticate first.');
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  // Token is still valid
  if (expiresAt > fiveMinutesFromNow) {
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  // Refresh token
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) {
    throw new Error('Xero credentials not configured');
  }

  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }).toString(),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || tokenData.error) {
    throw new Error(`Failed to refresh Xero token: ${JSON.stringify(tokenData)}`);
  }

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

  await supabase
    .from('xero_token')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq('id', token.id);

  return { accessToken: tokenData.access_token, tenantId: token.tenant_id };
}

// Helper: Find or create Xero contact
async function findOrCreateXeroContact(accessToken, tenantId, organizationName) {
  // Search for existing contact
  const escapedOrgName = organizationName.replace(/"/g, '\\"');
  const contactSearchResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${escapedOrgName}"`)}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json'
      }
    }
  );

  const contactData = await contactSearchResponse.json();

  if (contactData.Contacts && contactData.Contacts.length > 0) {
    return contactData.Contacts[0].ContactID;
  }

  // Create new contact
  const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ Contacts: [{ Name: organizationName }] })
  });

  const newContactData = await createContactResponse.json();
  if (newContactData.Contacts && newContactData.Contacts.length > 0) {
    return newContactData.Contacts[0].ContactID;
  }

  throw new Error('Failed to create Xero contact');
}

// Zoom OAuth token cache
let zoomTokenCache = null;

async function getZoomAccessToken() {
  if (zoomTokenCache && Date.now() < zoomTokenCache.expiresAt - 60000) {
    return zoomTokenCache.token;
  }
  
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials not configured');
  }
  
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${accountId}`
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Zoom] Token error:', errorText);
    throw new Error(`Failed to get Zoom access token: ${response.status}`);
  }
  
  const data = await response.json();
  
  zoomTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  
  return data.access_token;
}

// Helper: Send Zoom event confirmation email with join link
async function sendZoomEventConfirmationEmail(attendee, eventDetails, zoomJoinUrl, zoomType = 'webinar') {
  if (!zoomJoinUrl) {
    console.log(`[sendZoomEventConfirmationEmail] No join URL provided for ${attendee.email}`);
    return { success: false, error: 'No Zoom join URL available' };
  }
  
  try {
    const eventDate = eventDetails.start_time 
      ? new Date(eventDetails.start_time).toLocaleString('en-GB', { 
          dateStyle: 'full', 
          timeStyle: 'short',
          timeZone: 'Europe/London'
        })
      : 'Date TBC';
    
    const zoomTypeLabel = zoomType === 'meeting' ? 'Meeting' : 'Webinar';
    
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2d89ef;">Your Zoom ${zoomTypeLabel} Details</h2>
        <p>Hi ${attendee.first_name || 'there'},</p>
        <p>Thank you for registering for <strong>${eventDetails.title || 'the event'}</strong>.</p>
        <p><strong>Date:</strong> ${eventDate}</p>
        <p>Click the button below to join the ${zoomTypeLabel.toLowerCase()} when it starts:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${zoomJoinUrl}" style="background-color: #2d89ef; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Join Zoom ${zoomTypeLabel}
          </a>
        </p>
        <p style="font-size: 12px; color: #666;">
          Or copy this link: <a href="${zoomJoinUrl}">${zoomJoinUrl}</a>
        </p>
        <p>We look forward to seeing you there!</p>
      </div>
    `;
    
    const result = await sendEmail({
      to: attendee.email,
      subject: `Your Zoom ${zoomTypeLabel} Link: ${eventDetails.title || 'Event'}`,
      html: emailHtml
    });
    
    console.log(`[sendZoomEventConfirmationEmail] Email sent to ${attendee.email}:`, result);
    return { success: true, ...result };
  } catch (error) {
    console.error(`[sendZoomEventConfirmationEmail] Failed to send email to ${attendee.email}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function scheduleBookingReminderEmails(bookingId, eventId, attendeeEmail) {
  if (!supabase) return;
  
  try {
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, start_date, title')
      .eq('id', eventId)
      .single();

    if (eventError || !event || !event.start_date) {
      console.log('[scheduleBookingReminderEmails] No event or start_date found');
      return;
    }

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

    // Parse start_date as UTC - ensure we treat it consistently
    // Supabase stores timestamps in UTC, so we ensure the Z suffix for correct parsing
    const startDateStr = event.start_date.endsWith('Z') ? event.start_date : event.start_date + 'Z';
    const eventStartMs = new Date(startDateStr).getTime();
    const nowMs = Date.now();
    
    console.log(`[scheduleBookingReminderEmails] Event start: ${startDateStr}, now: ${new Date().toISOString()}`);
    
    for (const email of reminderEmails) {
      const hoursBeforeEvent = getHoursFromTimingType(email.timing_type, email.custom_hours_before);
      const scheduledTimeMs = eventStartMs - (hoursBeforeEvent * 60 * 60 * 1000);
      const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

      if (scheduledTimeMs <= nowMs) {
        console.log(`[scheduleBookingReminderEmails] Skipping reminder (${email.timing_type}) - scheduled time ${scheduledTimeISO} already passed`);
        continue;
      }

      // Check for existing scheduled email to avoid duplicates
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

      await supabase
        .from('scheduled_email')
        .insert({
          event_email_id: email.id,
          booking_id: bookingId,
          attendee_email: attendeeEmail,
          scheduled_send_time: scheduledTimeISO,
          status: 'pending'
        });
      
      console.log(`[scheduleBookingReminderEmails] Scheduled ${email.timing_type} reminder for ${scheduledTimeISO}`);
    }

    console.log(`[scheduleBookingReminderEmails] Scheduled reminders for booking ${bookingId}`);
  } catch (err) {
    console.error('[scheduleBookingReminderEmails] Error:', err.message);
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

async function getValidZohoAccessToken() {
  if (!supabase) throw new Error('Supabase not configured');
  
  const { data: tokens } = await supabase
    .from('zoho_token')
    .select('*')
    .limit(1);

  if (!tokens || tokens.length === 0) {
    throw new Error('No Zoho tokens found. Admin needs to authenticate first.');
  }

  const token = tokens[0];
  const now = new Date();
  const expiresAt = new Date(token.expires_at);

  if (expiresAt > now) {
    return token.access_token;
  }

  const accountsDomain = ZOHO_CRM_API_DOMAIN.includes('.eu') 
    ? 'https://accounts.zoho.eu' 
    : ZOHO_CRM_API_DOMAIN.includes('.com.au')
      ? 'https://accounts.zoho.com.au'
      : 'https://accounts.zoho.com';

  const refreshResponse = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: token.refresh_token,
    }),
  });

  const refreshData = await refreshResponse.json();

  if (refreshData.error) {
    throw new Error(`Failed to refresh token: ${refreshData.error}`);
  }

  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in * 1000)).toISOString();

  await supabase
    .from('zoho_token')
    .update({
      access_token: refreshData.access_token,
      expires_at: newExpiresAt,
    })
    .eq('id', token.id);

  return refreshData.access_token;
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
          member_excluded_features: [],
          has_seen_onboarding_tour: true
        }
      };
    }

    console.log('[validateMember] Not a TeamMember, checking Member entity...');

    const { data: allMembers } = await supabase
      .from('member')
      .select('*');

    let member = allMembers?.find(m => m.email === email);

    if (!member) {
      console.log('[validateMember] Member not found locally, checking Zoho CRM...');
      
      if (!ZOHO_CRM_API_DOMAIN || !ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
        console.log('[validateMember] Zoho not configured, cannot sync from CRM');
        return {
          success: false,
          error: 'Email not found. Please check your email address or contact support.'
        };
      }

      try {
        const accessToken = await getValidZohoAccessToken();
        
        const criteria = `(Email:equals:${email})`;
        const contactFields = 'id,Email,First_Name,Last_Name,Account_Name';
        const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}&fields=${contactFields}`;
        
        const searchResponse = await fetch(searchUrl, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
        });

        if (!searchResponse.ok) {
          console.log('[validateMember] CRM search failed');
          return {
            success: false,
            error: 'Email not found. Please check your email address or contact support.'
          };
        }

        const searchData = await searchResponse.json();
        
        if (!searchData.data || searchData.data.length === 0) {
          console.log('[validateMember] Email not found in Zoho CRM');
          return {
            success: false,
            error: 'Email not found. Please check your email address or contact support.'
          };
        }

        const contact = searchData.data[0];
        console.log('[validateMember] Found contact in Zoho CRM:', contact.Email, 'zoho_contact_id:', contact.id);

        const { data: existingMemberByZohoId } = await supabase
          .from('member')
          .select('*')
          .eq('zoho_contact_id', contact.id)
          .limit(1);
        
        if (existingMemberByZohoId && existingMemberByZohoId.length > 0) {
          console.log('[validateMember] Found existing member by zoho_contact_id, updating email');
          const existingMember = existingMemberByZohoId[0];
          await supabase
            .from('member')
            .update({ 
              email: email,
              first_name: contact.First_Name,
              last_name: contact.Last_Name,
              last_synced: new Date().toISOString()
            })
            .eq('id', existingMember.id);
          
          member = { ...existingMember, email, first_name: contact.First_Name, last_name: contact.Last_Name };
        }

        let organizationId = null;
        if (!member && contact.Account_Name?.id) {
          const accountFields = 'id,Account_Name,Training_Fund_Balance,Purchase_Order_Enabled,Email_Domains';
          const accountUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}?fields=${accountFields}`;
          const accountResponse = await fetch(accountUrl, {
            headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
          });

          if (accountResponse.ok) {
            const accountData = await accountResponse.json();
            const account = accountData.data[0];

            const { data: existingOrgs } = await supabase
              .from('organization')
              .select('*')
              .eq('zoho_account_id', account.id);

            if (existingOrgs && existingOrgs.length > 0) {
              organizationId = existingOrgs[0].id;
              await supabase
                .from('organization')
                .update({
                  name: account.Account_Name,
                  training_fund_balance: account.Training_Fund_Balance || 0,
                  purchase_order_enabled: account.Purchase_Order_Enabled || false,
                  last_synced: new Date().toISOString()
                })
                .eq('id', existingOrgs[0].id);
            } else {
              const { data: newOrg } = await supabase
                .from('organization')
                .insert({
                  name: account.Account_Name,
                  zoho_account_id: account.id,
                  training_fund_balance: account.Training_Fund_Balance || 0,
                  purchase_order_enabled: account.Purchase_Order_Enabled || false,
                  last_synced: new Date().toISOString()
                })
                .select()
                .single();
              organizationId = newOrg?.id;
            }
          }
        }

        if (!member) {
          const { data: allRoles } = await supabase
            .from('role')
            .select('*');
          
          // Check for role segmentation
          const { data: segmentationSettings } = await supabase
            .from('system_settings')
            .select('*')
            .eq('key', 'role_segmentation_field_id')
            .single();
          
          let defaultRole = null;
          const segmentationFieldId = segmentationSettings?.value;
          
          // If segmentation is enabled and organization exists, try to find matching role
          if (segmentationFieldId && organizationId) {
            const { data: orgPrefValue } = await supabase
              .from('organization_preference_value')
              .select('value')
              .eq('organization_id', organizationId)
              .eq('field_id', segmentationFieldId)
              .single();
            
            const orgSegmentValue = orgPrefValue?.value;
            
            if (orgSegmentValue) {
              defaultRole = allRoles?.find(r => 
                r.is_default === true && 
                r.segment_values && 
                Array.isArray(r.segment_values) && 
                r.segment_values.includes(orgSegmentValue)
              );
            }
          }
          
          // Fallback to any default role if no segmented match
          if (!defaultRole) {
            defaultRole = allRoles?.find(r => r.is_default === true);
          }

          const memberData = {
            email: email,
            first_name: contact.First_Name,
            last_name: contact.Last_Name,
            zoho_contact_id: contact.id,
            organization_id: organizationId,
            last_synced: new Date().toISOString(),
            login_enabled: true
          };

          if (defaultRole) {
            memberData.role_id = defaultRole.id;
          }

          const { data: newMember, error: insertError } = await supabase
            .from('member')
            .insert(memberData)
            .select()
            .single();

          if (insertError) {
            console.error('[validateMember] Failed to create member:', insertError);
            return {
              success: false,
              error: 'Failed to create member record'
            };
          }

          member = newMember;
          console.log('[validateMember] Created new member from CRM:', member.email);
        }

      } catch (crmError) {
        console.error('[validateMember] CRM sync error:', crmError.message);
        return {
          success: false,
          error: 'Email not found. Please check your email address or contact support.'
        };
      }
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
    let purchaseOrderEnabled = false;
    let programTicketBalances = {};

    if (organizationId) {
      const { data: allOrgs } = await supabase
        .from('organization')
        .select('*');

      let org = allOrgs?.find(o => o.id === organizationId);

      if (!org) {
        org = allOrgs?.find(o => o.zoho_account_id === organizationId);
      }

      if (org) {
        organizationName = org.name;
        organizationId = org.id;
        trainingFundBalance = org.training_fund_balance || 0;
        purchaseOrderEnabled = org.purchase_order_enabled || false;
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
        purchase_order_enabled: purchaseOrderEnabled,
        program_ticket_balances: programTicketBalances,
        role_id: member.role_id || null,
        member_excluded_features: member.member_excluded_features || [],
        has_seen_onboarding_tour: member.has_seen_onboarding_tour || false,
        is_team_member: false
      }
    };
  },

  async getStripePublishableKey() {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error('Stripe not configured');
    return { publishableKey };
  },

  async createStripePaymentIntent(params) {
    if (!stripe) throw new Error('Stripe not configured');
    
    const { amount, currency = 'gbp', metadata } = params;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      metadata
    });

    return { clientSecret: paymentIntent.client_secret };
  },

  async refreshMemberBalance(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { email } = params;
    if (!email) return { error: 'Email required' };

    const accessToken = await getValidZohoAccessToken();

    const { data: allMembers } = await supabase
      .from('member')
      .select('*');

    const member = allMembers?.find(m => m.email === email);

    if (!member) {
      return { error: 'Member not found', searchedEmail: email };
    }

    const criteria = `(Email:equals:${email})`;
    const contactFields = 'id,Email,First_Name,Last_Name,Account_Name';
    const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}&fields=${contactFields}`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    });

    if (!searchResponse.ok) {
      return { error: 'CRM lookup failed' };
    }

    const searchData = await searchResponse.json();
    
    if (!searchData.data || searchData.data.length === 0) {
      return { error: 'Contact not found in CRM' };
    }

    const contact = searchData.data[0];

    if (contact.Account_Name?.id) {
      const accountFields = 'id,Account_Name,Training_Fund_Balance,Purchase_Order_Enabled,Email_Domains';
      const accountUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}?fields=${accountFields}`;
      const accountResponse = await fetch(accountUrl, {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
      });

      if (accountResponse.ok) {
        const accountData = await accountResponse.json();
        const account = accountData.data[0];

        const { data: existingOrgs } = await supabase
          .from('organization')
          .select('*')
          .eq('zoho_account_id', account.id);

        if (existingOrgs && existingOrgs.length > 0) {
          const updatedBalance = account.Training_Fund_Balance || 0;
          
          await supabase
            .from('organization')
            .update({
              training_fund_balance: updatedBalance,
              purchase_order_enabled: account.Purchase_Order_Enabled || false,
              last_synced: new Date().toISOString()
            })
            .eq('id', existingOrgs[0].id);

          return {
            success: true,
            training_fund_balance: updatedBalance,
            organization_name: existingOrgs[0].name
          };
        }
      }
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
        .eq('email', member_email)
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

    const accessToken = await getValidZohoAccessToken();

    const criteria = `(Email:equals:${email})`;
    const contactFields = 'id,Email,First_Name,Last_Name,Account_Name';
    const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}&fields=${contactFields}`;

    const searchResponse = await fetch(searchUrl, {
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    });

    let searchData = { data: [] };
    const responseText = await searchResponse.text();

    if (responseText && responseText.trim() !== '') {
      try {
        searchData = JSON.parse(responseText);
      } catch (e) {
        console.error('Failed to parse search response:', responseText);
        searchData = { data: [] };
      }
    }

    if (searchResponse.ok && searchData.data && searchData.data.length > 0) {
      const contact = searchData.data[0];

      if (!contact.Account_Name?.id || contact.Account_Name.id !== organizationId) {
        return {
          valid: false,
          status: 'wrong_organization',
          error: 'A ticket will be sent shortly. This email address cannot be verified, AGCAS will be in touch.'
        };
      }

      return {
        valid: true,
        status: 'verified',
        first_name: contact.First_Name,
        last_name: contact.Last_Name,
        zoho_contact_id: contact.id
      };
    }

    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (!emailDomain) {
      return { valid: false, status: 'invalid_email', error: 'Invalid email format' };
    }

    const { data: allOrgs } = await supabase.from('organization').select('*');
    let targetOrg = allOrgs?.find(o => o.id === organizationId);
    if (!targetOrg) {
      targetOrg = allOrgs?.find(o => o.zoho_account_id === organizationId);
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
      message: 'A ticket will be sent shortly. This email address cannot be verified, AGCAS will be in touch.'
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
      programTag
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

    if (!programTag || !event.program_tag) {
      return { success: false, error: 'This event does not have a program association' };
    }

    if (!member.organization_id) {
      console.log('[createBooking] Member has no organization_id');
      return { success: false, error: 'Member does not have an associated organization' };
    }

    console.log('[createBooking] Looking up organization:', member.organization_id);
    
    // Try direct lookup by ID first
    let { data: org, error: orgError } = await supabase
      .from('organization')
      .select('*')
      .eq('id', member.organization_id)
      .maybeSingle();
    
    // If not found, try by zoho_account_id
    if (!org && !orgError) {
      const { data: orgByZoho } = await supabase
        .from('organization')
        .select('*')
        .eq('zoho_account_id', member.organization_id)
        .maybeSingle();
      org = orgByZoho;
    }

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
        
        console.log(`[createBooking] Getting Zoom access token...`);
        const token = await getZoomAccessToken();
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
          payment_method: 'program_ticket'
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
            confirmation_token: confirmationToken
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

    // Send Zoom confirmation emails if this is a Zoom event
    const emailResults = [];
    if (eventIsZoom && matchingWebinar && (registrationMode === 'self' || registrationMode === 'colleagues')) {
      console.log('[createBooking] Sending Zoom confirmation emails to attendees...');
      
      for (const attendee of (attendees || [])) {
        const zoomResult = zoomRegistrationResults.find(r => r.email === attendee.email);
        
        // Use the personalized join_url from registration, or fall back to webinar's general join_url
        const joinUrl = zoomResult?.join_url || matchingWebinar.join_url;
        
        if (joinUrl) {
          const emailResult = await sendZoomEventConfirmationEmail(
            attendee,
            { title: event.title, start_time: event.start_date || matchingWebinar.start_time },
            joinUrl,
            'webinar'
          );
          emailResults.push({ email: attendee.email, ...emailResult });
        } else {
          console.log(`[createBooking] No join_url available for ${attendee.email} - skipping email`);
          emailResults.push({ email: attendee.email, success: false, error: 'No Zoom join URL available' });
        }
      }
    }
    
    // Check if this is a Zoom meeting (not webinar) and send emails
    let matchingMeeting = null;
    if (!eventIsZoom && !eventIsBackstage && event.zoom_meeting_id) {
      const { data: meetingData } = await supabase
        .from('zoom_meeting')
        .select('*')
        .eq('id', event.zoom_meeting_id)
        .single();
      
      if (meetingData) {
        matchingMeeting = meetingData;
        console.log('[createBooking] Found Zoom meeting, sending confirmation emails...');
        
        for (const attendee of (attendees || [])) {
          const joinUrl = meetingData.join_url;
          
          if (joinUrl) {
            const emailResult = await sendZoomEventConfirmationEmail(
              attendee,
              { title: event.title, start_time: event.start_date || meetingData.start_time },
              joinUrl,
              'meeting'
            );
            emailResults.push({ email: attendee.email, ...emailResult });
          } else {
            console.log(`[createBooking] No meeting join_url available for ${attendee.email}`);
            emailResults.push({ email: attendee.email, success: false, error: 'No Zoom meeting join URL available' });
          }
        }
      }
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

    if (eventIsZoom || event.zoom_webinar_id) {
      // Extract webinar ID from location for diagnostics (fallback method)
      const extractedWebinarId = extractZoomWebinarId(event.location);
      
      response.zoom_registration = {
        webinar_found: !!matchingWebinar,
        registrations: zoomRegistrationResults,
        email_results: emailResults,
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
    } else if (matchingMeeting) {
      response.zoom_meeting = {
        meeting_found: true,
        email_results: emailResults
      };
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

  async createOneOffEventBooking(params) {
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
      guestInfo = null
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
      guestInfo: guestInfo ? { email: guestInfo.email, first_name: guestInfo.first_name } : null
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
        isGuest: true
      }];
    }
    
    // Validate attendees array
    if (!bookingAttendees || !Array.isArray(bookingAttendees) || bookingAttendees.length === 0) {
      console.error('[createOneOffEventBooking] No attendees provided:', { attendees: bookingAttendees });
      return { success: false, error: 'No attendees provided' };
    }

    // Get member details (skip for guest bookings)
    let member = null;
    let org = null;
    
    if (!isGuestBooking) {
      const { data: memberData, error: memberError } = await supabase
        .from('member')
        .select('*')
        .ilike('email', memberEmail.toLowerCase())
        .maybeSingle();
      
      if (memberError || !memberData) {
        console.error('[createOneOffEventBooking] Member query error:', memberError);
        return { success: false, error: 'Member not found' };
      }
      
      member = memberData;
      console.log('[createOneOffEventBooking] Member found:', member.id, member.email);
      
      // Get organization (only for member bookings)
      const { data: orgData, error: orgError } = await supabase
        .from('organization')
        .select('*')
        .eq('id', member.organization_id)
        .single();

      if (orgError || !orgData) {
        console.error('[createOneOffEventBooking] Organization not found');
        return { success: false, error: 'Organization not found' };
      }
      org = orgData;
    } else {
      console.log('[createOneOffEventBooking] Guest booking - no member lookup needed');
    }

    // Get event details
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.error('[createOneOffEventBooking] Event query error:', eventError);
      return { success: false, error: 'Event not found' };
    }

    // Verify Stripe payment if card payment was used
    if (paymentMethod === 'card' && stripePaymentIntentId) {
      console.log('[createOneOffEventBooking] Verifying Stripe payment:', stripePaymentIntentId);
      
      if (!stripe) {
        return { success: false, error: 'Stripe is not configured' };
      }

      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
        
        // Verify payment was successful
        if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'requires_capture') {
          console.error('[createOneOffEventBooking] Payment not successful:', paymentIntent.status);
          return { success: false, error: 'Payment has not been completed. Please try again.' };
        }

        // Verify payment amount matches expected amount
        const expectedCardAmount = Math.round((totalCost - (trainingFundAmount || 0)) * 100);
        if (Math.abs(paymentIntent.amount - expectedCardAmount) > 100) {
          console.error('[createOneOffEventBooking] Payment amount mismatch:', {
            expected: expectedCardAmount,
            received: paymentIntent.amount
          });
          return { success: false, error: 'Payment amount does not match the expected total' };
        }

        console.log('[createOneOffEventBooking] Stripe payment verified:', paymentIntent.status);
      } catch (stripeError) {
        console.error('[createOneOffEventBooking] Stripe verification error:', stripeError);
        return { success: false, error: 'Failed to verify payment: ' + (stripeError.message || 'Unknown error') };
      }
    }

    // Generate booking reference
    const bookingReference = `OOE-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    
    // For guest bookings, skip vouchers and training fund - use full card payment
    let validatedTrainingFundAmount = 0;
    let voucherAmountApplied = 0;
    const voucherDeductions = [];
    
    if (!isGuestBooking && org) {
      // Server-side validation: Clamp training fund amount to available balance
      validatedTrainingFundAmount = Math.min(
        Math.max(0, trainingFundAmount || 0),
        org.training_fund_balance || 0,
        totalCost
      );
      
      // Process voucher deductions if any - with ownership validation
      if (selectedVoucherIds && selectedVoucherIds.length > 0) {
        for (const voucherId of selectedVoucherIds) {
          // Fetch voucher and validate it belongs to the member's organization
          const { data: voucher } = await supabase
            .from('program_ticket_transaction')
            .select('*')
            .eq('id', voucherId)
            .eq('organization_id', org.id)
            .eq('transaction_type', 'voucher')
            .eq('status', 'active')
            .single();
          
          if (voucher && voucher.value > 0) {
            // Clamp amount to remaining cost
            const amountToUse = Math.min(voucher.value, totalCost - voucherAmountApplied - validatedTrainingFundAmount);
            if (amountToUse > 0) {
              voucherAmountApplied += amountToUse;
              voucherDeductions.push({ voucherId, amount: amountToUse });
              
              // Update voucher balance
              const newValue = voucher.value - amountToUse;
              await supabase
                .from('program_ticket_transaction')
                .update({
                  value: newValue,
                  status: newValue <= 0 ? 'used' : 'active',
                  notes: `${voucher.notes || ''} | Used £${amountToUse.toFixed(2)} for ${event.title || 'event'} (${bookingReference})`
                })
                .eq('id', voucherId);
            }
          } else {
            console.warn('[createOneOffEventBooking] Voucher not found or not owned by org:', voucherId);
          }
        }
      }

      // Process training fund deduction if any (use validated amount)
      if (validatedTrainingFundAmount > 0) {
        await supabase
          .from('organization')
          .update({
            training_fund_balance: org.training_fund_balance - validatedTrainingFundAmount
          })
          .eq('id', org.id);
        
        // Create training fund transaction record
        await supabase
          .from('program_ticket_transaction')
          .insert({
            organization_id: org.id,
            transaction_type: 'training_fund_usage',
            value: -validatedTrainingFundAmount,
            booking_reference: bookingReference,
            event_name: event.title || 'One-off Event',
            member_email: memberEmail,
            notes: `Training fund used: £${validatedTrainingFundAmount.toFixed(2)} for ${event.title || 'event'}`
          });
      }
    }

    // Calculate validated remaining balance after vouchers and training fund
    const validatedRemainingBalance = Math.max(0, totalCost - voucherAmountApplied - validatedTrainingFundAmount);
    
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
        is_guest_booking: isGuestBooking
      };

      console.log('[createOneOffEventBooking] Inserting booking:', JSON.stringify(bookingData));
      
      const { data: booking, error: bookingError } = await supabase
        .from('booking')
        .insert(bookingData)
        .select()
        .single();

      if (bookingError) {
        console.error('[createOneOffEventBooking] Booking insert failed:', bookingError);
        // Return error immediately if booking fails
        return { 
          success: false, 
          error: `Failed to create booking: ${bookingError.message || 'Unknown database error'}`,
          details: bookingError
        };
      } else if (booking) {
        console.log('[createOneOffEventBooking] Booking created:', booking.id);
        createdBookings.push(booking);
        
        // Schedule reminder emails for this booking (non-blocking)
        scheduleBookingReminderEmails(booking.id, eventId, booking.attendee_email).catch(err => {
          console.error('[createOneOffEventBooking] Failed to schedule reminders:', err.message);
        });
      }
    }

    // Check if any bookings were created
    if (createdBookings.length === 0) {
      console.error('[createOneOffEventBooking] No bookings were created');
      return { success: false, error: 'No bookings were created' };
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
              const zoomToken = await getZoomAccessToken();
              
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

    // If paying to account, create an account charge record and optionally a Xero invoice
    let xeroInvoiceResult = null;
    let xeroDebug = {
      attempted: false,
      remainingBalance: validatedRemainingBalance,
      paymentMethod: paymentMethod,
      conditionsMet: validatedRemainingBalance > 0 && paymentMethod === 'account',
      settingEnabled: null,
      settingValue: null,
      tokenFound: null,
      tenantIdFound: null,
      contactId: null,
      invoiceResponseStatus: null,
      invoiceResponseBody: null,
      error: null
    };
    
    // Account charges and Xero invoices only apply to member bookings (not guest checkouts)
    if (!isGuestBooking && validatedRemainingBalance > 0 && paymentMethod === 'account' && org) {
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

      // Check if Xero invoice generation is enabled
      const { data: xeroSettings, error: xeroSettingsError } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'xero_invoice_enabled')
        .maybeSingle();

      xeroDebug.settingValue = xeroSettings?.setting_value;
      xeroDebug.settingError = xeroSettingsError?.message;

      const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';
      xeroDebug.settingEnabled = xeroInvoiceEnabled;

      if (xeroInvoiceEnabled) {
        xeroDebug.attempted = true;
        try {
          const { accessToken, tenantId } = await getValidXeroAccessToken();
          xeroDebug.tokenFound = !!accessToken;
          xeroDebug.tenantIdFound = !!tenantId;

          if (accessToken && tenantId) {
            // Find or create Xero contact
            const contactId = await findOrCreateXeroContact(accessToken, tenantId, org.name);
            xeroDebug.contactId = contactId;

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

            // Get Xero account code from system settings (default to '200' for Sales)
            const { data: accountCodeSetting } = await supabase
              .from('system_settings')
              .select('setting_value')
              .eq('setting_key', 'xero_sales_account_code')
              .maybeSingle();
            
            const xeroAccountCode = accountCodeSetting?.setting_value || '200';
            xeroDebug.accountCodeUsed = xeroAccountCode;
            
            // Calculate due date (30 days from now)
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const dueDateString = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD format
            
            // Determine reference: PO number or "TBC" if supply later was selected
            const invoiceReference = poToFollow ? 'TBC' : (purchaseOrderNumber || 'TBC');
            
            // Build line item with optional tracking for Project
            const lineItem = {
              Description: lineDescription,
              Quantity: 1,
              UnitAmount: validatedRemainingBalance,
              AccountCode: xeroAccountCode
            };
            
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
              Status: 'AUTHORISED'
            };

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
            
            // Get response as text first to handle both JSON and XML errors
            const responseText = await invoiceResponse.text();
            xeroDebug.invoiceResponseRaw = responseText.substring(0, 500); // First 500 chars for debugging
            
            let invoiceData = null;
            try {
              invoiceData = JSON.parse(responseText);
              xeroDebug.invoiceResponseBody = invoiceData;
            } catch (parseError) {
              xeroDebug.invoiceResponseBody = responseText.substring(0, 500);
              xeroDebug.parseError = 'Response was not JSON: ' + responseText.substring(0, 200);
            }

            if (invoiceData && invoiceData.Invoices && invoiceData.Invoices.length > 0) {
              const invoice = invoiceData.Invoices[0];
              xeroInvoiceResult = {
                invoice_id: invoice.InvoiceID,
                invoice_number: invoice.InvoiceNumber,
                total: invoice.Total,
                status: invoice.Status
              };
              
              // Update all booking records with Xero invoice ID and number
              // PDF is fetched on-demand from Xero (single source of truth)
              const { error: updateError } = await supabase
                .from('booking')
                .update({
                  xero_invoice_id: invoice.InvoiceID,
                  xero_invoice_number: invoice.InvoiceNumber
                })
                .eq('booking_group_reference', bookingReference);
              
              if (updateError) {
                console.error('[createOneOffEventBooking] Failed to update bookings with Xero data:', updateError);
                xeroDebug.updateError = updateError.message;
              } else {
                console.log('[createOneOffEventBooking] Bookings updated with Xero invoice ID:', invoice.InvoiceNumber);
              }
            }
          }
        } catch (xeroError) {
          xeroDebug.error = xeroError.message;
          xeroDebug.errorStack = xeroError.stack;
          // Don't fail the booking, just log the error
        }
      }
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

    // Decrement ticket class availability if ticket class has limited tickets
    if (ticketClassId && event.pricing_config?.ticket_classes && createdBookings.length > 0) {
      try {
        const ticketClasses = event.pricing_config.ticket_classes;
        const ticketClassIndex = ticketClasses.findIndex(tc => tc.id === ticketClassId);
        
        if (ticketClassIndex !== -1) {
          const ticketClass = ticketClasses[ticketClassIndex];
          // Only decrement if ticket class has limited availability (not unlimited)
          if (ticketClass.available_count !== null && ticketClass.available_count !== undefined && !ticketClass.is_unlimited_tickets) {
            const ticketsToDecrement = createdBookings.length;
            const newAvailableCount = Math.max(0, Number(ticketClass.available_count) - ticketsToDecrement);
            
            // Update the ticket class in pricing_config
            const updatedTicketClasses = [...ticketClasses];
            updatedTicketClasses[ticketClassIndex] = {
              ...ticketClass,
              available_count: newAvailableCount
            };
            
            const updatedPricingConfig = {
              ...event.pricing_config,
              ticket_classes: updatedTicketClasses
            };
            
            await supabase
              .from('event')
              .update({ pricing_config: updatedPricingConfig })
              .eq('id', eventId);
            
            console.log(`[createOneOffEventBooking] Decremented ticket class '${ticketClass.name}' availability: ${ticketClass.available_count} -> ${newAvailableCount}`);
          }
        }
      } catch (ticketClassErr) {
        console.error(`[createOneOffEventBooking] Ticket class availability decrement failed:`, ticketClassErr.message);
        // Don't fail the booking, just log the error
      }
    }

    // Send Zoom confirmation emails if this is a Zoom webinar event
    const emailResults = [];
    if (event.zoom_webinar_id && zoomRegistrationResults.length > 0) {
      console.log('[createOneOffEventBooking] Sending Zoom confirmation emails to attendees...');
      
      // Fetch webinar join_url for fallback
      const { data: webinarData } = await supabase
        .from('zoom_webinar')
        .select('join_url, start_time')
        .eq('id', event.zoom_webinar_id)
        .single();
      
      for (const attendee of bookingAttendees) {
        const zoomResult = zoomRegistrationResults.find(r => r.email === attendee.email);
        
        // Use the personalized join_url from registration, or fall back to webinar's general join_url
        const joinUrl = zoomResult?.join_url || webinarData?.join_url;
        
        if (joinUrl) {
          const emailResult = await sendZoomEventConfirmationEmail(
            attendee,
            { title: event.title, start_time: event.start_date || webinarData?.start_time },
            joinUrl,
            'webinar'
          );
          emailResults.push({ email: attendee.email, ...emailResult });
        } else {
          console.log(`[createOneOffEventBooking] No join_url available for ${attendee.email} - skipping email`);
          emailResults.push({ email: attendee.email, success: false, error: 'No Zoom join URL available' });
        }
      }
    }
    
    // Check if this is a Zoom meeting (not webinar) and send emails
    let matchingMeeting = null;
    if (!event.zoom_webinar_id && event.zoom_meeting_id) {
      const { data: meetingData } = await supabase
        .from('zoom_meeting')
        .select('*')
        .eq('id', event.zoom_meeting_id)
        .single();
      
      if (meetingData) {
        matchingMeeting = meetingData;
        console.log('[createOneOffEventBooking] Found Zoom meeting, sending confirmation emails...');
        
        for (const attendee of bookingAttendees) {
          const joinUrl = meetingData.join_url;
          
          if (joinUrl) {
            const emailResult = await sendZoomEventConfirmationEmail(
              attendee,
              { title: event.title, start_time: event.start_date || meetingData.start_time },
              joinUrl,
              'meeting'
            );
            emailResults.push({ email: attendee.email, ...emailResult });
          } else {
            console.log(`[createOneOffEventBooking] No meeting join_url available for ${attendee.email}`);
            emailResults.push({ email: attendee.email, success: false, error: 'No Zoom meeting join URL available' });
          }
        }
      }
    }

    const response = {
      success: true,
      booking_reference: bookingReference,
      booking_group_reference: bookingReference, // Base reference for grouping
      bookings: createdBookings,
      payment_details: {
        total_cost: totalCost,
        voucher_amount: voucherAmountApplied,
        training_fund_amount: validatedTrainingFundAmount,
        account_amount: paymentMethod === 'account' ? validatedRemainingBalance : 0,
        card_amount: paymentMethod === 'card' ? validatedRemainingBalance : 0
      },
      xero_invoice: xeroInvoiceResult
    };

    // Add Zoom registration results if applicable
    if (event.zoom_webinar_id) {
      response.zoom_registration = {
        webinar_id: event.zoom_webinar_id,
        registrations: zoomRegistrationResults,
        email_results: emailResults,
        all_successful: zoomRegistrationResults.every(r => r.success !== false)
      };
    } else if (matchingMeeting) {
      response.zoom_meeting = {
        meeting_found: true,
        email_results: emailResults
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

      // Fallback: check if organizationId is actually a zoho_account_id
      if (!org) {
        const { data: orgByZoho } = await supabase
          .from('organization')
          .select('*')
          .eq('zoho_account_id', organizationId)
          .maybeSingle();
        org = orgByZoho;
      }
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

  async syncBackstageEvents() {
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

  async applyDiscountCode(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { code, memberEmail, eventId, amount } = params;

    if (!code) {
      return { valid: false, error: 'Discount code is required' };
    }

    const { data: discountCodes } = await supabase
      .from('discount_code')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true);

    if (!discountCodes || discountCodes.length === 0) {
      return { valid: false, error: 'Invalid discount code' };
    }

    const discountCode = discountCodes[0];

    if (discountCode.expiry_date && new Date(discountCode.expiry_date) < new Date()) {
      return { valid: false, error: 'Discount code has expired' };
    }

    if (discountCode.max_uses && discountCode.times_used >= discountCode.max_uses) {
      return { valid: false, error: 'Discount code has reached maximum uses' };
    }

    let discountAmount = 0;
    if (discountCode.discount_type === 'percentage') {
      discountAmount = (amount * discountCode.discount_value) / 100;
    } else {
      discountAmount = discountCode.discount_value;
    }

    return {
      valid: true,
      discount_code_id: discountCode.id,
      discount_type: discountCode.discount_type,
      discount_value: discountCode.discount_value,
      discount_amount: Math.min(discountAmount, amount),
      final_amount: Math.max(0, amount - discountAmount)
    };
  },

  async createJobPostingPaymentIntent(params) {
    if (!stripe) throw new Error('Stripe not configured');
    
    // Frontend sends: amount, currency, metadata: { job_posting_id, contact_email, company_name, job_title }
    const { amount, currency = 'gbp', metadata = {} } = params;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      metadata: {
        type: 'job_posting',
        job_posting_id: metadata.job_posting_id || '',
        job_title: metadata.job_title || '',
        company_name: metadata.company_name || '',
        contact_email: metadata.contact_email || ''
      }
    });

    return { 
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    };
  },

  async setPublicHomePage(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { slug } = params;
    const settingKey = 'public_home_page_slug';
    
    console.log(`[setPublicHomePage] Setting home page to: ${slug || '(none)'}`);

    // First try to find existing setting
    const { data: existingSettings, error: fetchError } = await supabase
      .from('system_settings')
      .select('*')
      .eq('setting_key', settingKey);

    if (fetchError) {
      console.error('[setPublicHomePage] Error fetching settings:', fetchError);
      throw new Error(fetchError.message);
    }

    const existingSetting = existingSettings?.[0];

    if (existingSetting) {
      // Update existing setting
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

      console.log('[setPublicHomePage] Updated existing setting:', data);
      return { success: true, data };
    } else {
      // Create new setting
      const { data, error } = await supabase
        .from('system_settings')
        .insert({
          setting_key: settingKey,
          setting_value: slug || ''
        })
        .select()
        .single();

      if (error) {
        console.error('[setPublicHomePage] Error creating setting:', error);
        throw new Error(error.message);
      }

      console.log('[setPublicHomePage] Created new setting:', data);
      return { success: true, data };
    }
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

    // FIRST: Try to get member from session (portal users - most reliable)
    if (req) {
      const sessionMember = await getSessionMember(req);
      if (sessionMember) {
        member = sessionMember;
        console.log('[createJobPostingMember] Found member via session:', member.id, member.email);
      } else {
        console.log('[createJobPostingMember] No session member found');
      }
    }

    // FALLBACK: Try email lookup with case-insensitive matching
    if (!member && memberEmail) {
      const normalizedEmail = memberEmail.toLowerCase().trim();
      console.log('[createJobPostingMember] Falling back to email lookup:', normalizedEmail);
      
      const { data: emailMember, error: emailError } = await supabase
        .from('member')
        .select('*')
        .eq('email', normalizedEmail)
        .single();
      
      if (emailMember && !emailError) {
        member = emailMember;
        console.log('[createJobPostingMember] Found member via email:', member.id, member.email);
      } else {
        console.warn('[createJobPostingMember] Email lookup failed:', emailError?.message);
      }
    }

    if (!member) {
      console.error('[createJobPostingMember] Member not found via session or email');
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

    const { data: jobPosting, error } = await supabase
      .from('job_posting')
      .insert({
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
        attachment_names
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
        attachment_names
      })
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, job_id: jobPosting.id, job_posting: jobPosting };
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
    if (!supabase) throw new Error('Supabase not configured');
    
    const { accessToken } = params;
    const ZOHO_BACKSTAGE_PORTAL_ID = process.env.ZOHO_BACKSTAGE_PORTAL_ID || '20108049755';

    if (!accessToken) {
      return { error: 'Missing access token' };
    }

    const baseUrl = 'https://www.zohoapis.eu/backstage/v3';
    const url = `${baseUrl}/portals/${ZOHO_BACKSTAGE_PORTAL_ID}/events?status=live`;

    const eventsResponse = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    });

    if (!eventsResponse.ok) {
      const errorText = await eventsResponse.text();
      return { error: 'Failed to fetch events from Backstage', details: errorText };
    }

    const eventsData = await eventsResponse.json();
    const events = eventsData.events || [];

    if (events.length === 0) {
      return { success: true, synced: 0, errors: 0, total: 0, message: 'No events found' };
    }

    let syncedCount = 0;
    let errorCount = 0;
    const errors = [];

    const { data: allExistingEvents } = await supabase.from('event').select('*');

    for (const event of events) {
      try {
        const programTag = event.tags && event.tags.length > 0 ? event.tags[0] : null;

        const ticketClassesUrl = `${baseUrl}/portals/${ZOHO_BACKSTAGE_PORTAL_ID}/events/${event.id}/ticket_classes`;
        const ticketClassesResponse = await fetch(ticketClassesUrl, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
        });

        let ticketTypeId = null;
        let ticketPrice = 0;
        let availableSeats = 0;

        if (ticketClassesResponse.ok) {
          const ticketClassesData = await ticketClassesResponse.json();
          const ticketClasses = ticketClassesData.ticket_classes || [];

          let memberTicket = ticketClasses.find(tc =>
            tc.translation?.name?.toLowerCase() === 'member' || tc.ticket_class_type_string === 'free'
          );

          if (!memberTicket && ticketClasses.length > 0) {
            memberTicket = ticketClasses[0];
          }

          if (memberTicket) {
            ticketTypeId = memberTicket.id.toString();
            ticketPrice = parseFloat(memberTicket.amount || 0);
            availableSeats = parseInt((memberTicket.quantity || 0) - (memberTicket.sold || 0));
          }
        }

        const eventData = {
          title: event.name,
          description: event.description || '',
          program_tag: programTag,
          start_date: event.start_time,
          end_date: event.end_time,
          location: event.venue?.name || 'Online',
          ticket_price: ticketPrice,
          available_seats: availableSeats,
          backstage_event_id: event.id.toString(),
          backstage_ticket_type_id: ticketTypeId,
          image_url: event.banner_url || event.thumbnail_url || null,
          last_synced: new Date().toISOString()
        };

        const existingEvent = allExistingEvents?.find(e => e.backstage_event_id === eventData.backstage_event_id);

        if (existingEvent) {
          await supabase.from('event').update(eventData).eq('id', existingEvent.id);
        } else {
          await supabase.from('event').insert(eventData);
        }

        syncedCount++;
      } catch (error) {
        errors.push({ eventId: event.id, error: error.message });
        errorCount++;
      }
    }

    return { success: true, synced: syncedCount, errors: errorCount, total: events.length, errorDetails: errors.length > 0 ? errors : undefined };
  },

  async syncEventsFromBackstage(params) {
    return this.syncBackstageEvents(params);
  },

  async syncOrganizationContacts(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { organizationId } = params;

    if (!organizationId) {
      return { success: false, error: 'Organization ID is required' };
    }

    const { data: allOrgs } = await supabase.from('organization').select('*');
    let org = allOrgs?.find(o => o.id === organizationId);
    if (!org) {
      org = allOrgs?.find(o => o.zoho_account_id === organizationId);
    }

    if (!org || !org.zoho_account_id) {
      return { success: false, error: 'Organization not found or not linked to Zoho' };
    }

    const accessToken = await getValidZohoAccessToken();

    let allContacts = [];
    let page = 1;
    const perPage = 200;
    let hasMore = true;

    while (hasMore) {
      const criteria = `(Account_Name:equals:${org.name})`;
      const contactFields = 'id,Email,First_Name,Last_Name,Account_Name';
      const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}&fields=${contactFields}&page=${page}&per_page=${perPage}`;

      const response = await fetch(searchUrl, {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
      });

      if (!response.ok) break;

      let data;
      try {
        data = await response.json();
      } catch (e) {
        break;
      }

      if (data.data && data.data.length > 0) {
        allContacts = allContacts.concat(data.data);
        hasMore = data.info?.more_records || false;
        page++;
      } else {
        hasMore = false;
      }
    }

    if (allContacts.length === 0) {
      await supabase.from('organization').update({ contacts_synced_at: new Date().toISOString() }).eq('id', org.id);
      return { success: true, synced_count: 0, created: 0, updated: 0, deactivated: 0 };
    }

    const { data: existingContacts } = await supabase.from('organization_contact').select('*').eq('organization_id', org.id);

    const existingByZohoId = {};
    (existingContacts || []).forEach(contact => { existingByZohoId[contact.zoho_contact_id] = contact; });

    const contactsToCreate = [];
    const contactsToUpdate = [];
    const zohoIdsFound = new Set();

    for (const zohoContact of allContacts) {
      zohoIdsFound.add(zohoContact.id);
      if (!zohoContact.Email) continue;

      const contactData = {
        organization_id: org.id,
        zoho_contact_id: zohoContact.id,
        email: zohoContact.Email,
        first_name: zohoContact.First_Name || '',
        last_name: zohoContact.Last_Name || '',
        is_active: true,
        last_synced: new Date().toISOString()
      };

      if (existingByZohoId[zohoContact.id]) {
        contactsToUpdate.push({ id: existingByZohoId[zohoContact.id].id, ...contactData });
      } else {
        contactsToCreate.push(contactData);
      }
    }

    const contactsToDeactivate = (existingContacts || []).filter(c => !zohoIdsFound.has(c.zoho_contact_id) && c.is_active);

    if (contactsToCreate.length > 0) {
      await supabase.from('organization_contact').insert(contactsToCreate);
    }

    for (const contact of contactsToUpdate) {
      const { id, ...updateData } = contact;
      await supabase.from('organization_contact').update(updateData).eq('id', id);
    }

    for (const contact of contactsToDeactivate) {
      await supabase.from('organization_contact').update({ is_active: false, last_synced: new Date().toISOString() }).eq('id', contact.id);
    }

    await supabase.from('organization').update({ contacts_synced_at: new Date().toISOString() }).eq('id', org.id);

    return { success: true, synced_count: allContacts.length, created: contactsToCreate.length, updated: contactsToUpdate.length, deactivated: contactsToDeactivate.length };
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
      const { data: allOrgs } = await supabase.from('organization').select('*');
      let org = allOrgs?.find(o => o.id === organizationId);
      if (!org) org = allOrgs?.find(o => o.zoho_account_id === organizationId);

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

    const ZOHO_FLOW_WEBHOOK_URL = process.env.ZOHO_FLOW_CANCEL_WEBHOOK_URL ||
      'https://flow.zoho.eu/20108063378/flow/webhook/incoming?zapikey=1001.ee25c218c557d7dddb0eed4f3e0e981a.70bb4e51162d59156ab4899ad8bcc38c&isdebug=false';

    try {
      const response = await fetch(ZOHO_FLOW_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, cancel_reason: cancelReason })
      });

      if (response.ok) {
        return { success: true, message: 'Ticket cancelled successfully' };
      }
    } catch (e) {}

    return { success: true, message: 'Ticket marked as cancelled. Backstage sync may take a moment.', warning: 'Backstage API call failed but local status updated' };
  },

  async cancelBackstageOrder(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { orderId, cancelReason = "Cancelled by member" } = params;

    if (!orderId) {
      return { success: false, error: 'Missing required parameter: orderId' };
    }

    const { data: allBookings } = await supabase.from('booking').select('*');
    const booking = allBookings?.find(b => b.backstage_order_id === orderId);

    if (!booking) {
      return { success: false, error: 'No booking found with this Backstage order ID' };
    }

    const { data: allEvents } = await supabase.from('event').select('*');
    const event = allEvents?.find(e => e.id === booking.event_id);

    if (!event || !event.backstage_event_id) {
      return { success: false, error: 'Event not found or missing Backstage event ID' };
    }

    const accessToken = await getValidZohoAccessToken();
    const portalId = process.env.ZOHO_BACKSTAGE_PORTAL_ID || "20108049755";
    const baseUrl = "https://www.zohoapis.eu/backstage/v3";
    const orderUrl = `${baseUrl}/portals/${portalId}/events/${event.backstage_event_id}/orders/${orderId}`;

    const attempts = [];

    try {
      const response1 = await fetch(orderUrl, {
        method: 'PUT',
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled', cancel_reason: cancelReason })
      });

      attempts.push({ method: 'PUT', status: response1.status, success: response1.ok });

      if (response1.ok) {
        await supabase.from('booking').update({ status: 'cancelled' }).eq('id', booking.id);
        return { success: true, method: 'PUT', message: 'Order cancelled successfully' };
      }
    } catch (e) {
      attempts.push({ method: 'PUT', error: e.message });
    }

    try {
      const response2 = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', cancel_reason: cancelReason })
      });

      attempts.push({ method: 'POST action', status: response2.status, success: response2.ok });

      if (response2.ok) {
        await supabase.from('booking').update({ status: 'cancelled' }).eq('id', booking.id);
        return { success: true, method: 'POST (action parameter)', message: 'Order cancelled successfully' };
      }
    } catch (e) {
      attempts.push({ method: 'POST action', error: e.message });
    }

    try {
      const refundUrl = `${orderUrl}/refund`;
      const response3 = await fetch(refundUrl, {
        method: 'POST',
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancel_reason: cancelReason, refund_amount: 0 })
      });

      attempts.push({ method: 'POST refund', url: refundUrl, status: response3.status, success: response3.ok });

      if (response3.ok) {
        await supabase.from('booking').update({ status: 'cancelled' }).eq('id', booking.id);
        return { success: true, method: 'POST (refund endpoint)', message: 'Order cancelled successfully' };
      }
    } catch (e) {
      attempts.push({ method: 'POST refund', error: e.message });
    }

    return {
      success: false,
      message: 'All cancellation attempts failed. Zoho Flow webhook approach recommended.',
      attempts,
      orderUrl,
      portalId,
      backstageEventId: event.backstage_event_id,
      recommendation: 'Consider using Zoho Flow webhook to handle cancellations'
    };
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

  async zohoContactWebhook(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const contactData = params.data || params;

    if (!contactData.id || !contactData.Email) {
      return { success: false, error: 'Missing required contact data' };
    }

    let organizationId = null;
    if (contactData.Account_Name?.id) {
      const { data: allOrgs } = await supabase.from('organization').select('*');
      const org = allOrgs?.find(o => o.zoho_account_id === contactData.Account_Name.id);
      if (org) organizationId = org.id;
    }

    if (!organizationId) {
      return { success: true, message: 'Contact not associated with a synced organization' };
    }

    const { data: existingContacts } = await supabase.from('organization_contact').select('*').eq('zoho_contact_id', contactData.id);

    const contactRecord = {
      organization_id: organizationId,
      zoho_contact_id: contactData.id,
      email: contactData.Email,
      first_name: contactData.First_Name || '',
      last_name: contactData.Last_Name || '',
      is_active: true,
      last_synced: new Date().toISOString()
    };

    if (existingContacts && existingContacts.length > 0) {
      await supabase.from('organization_contact').update(contactRecord).eq('id', existingContacts[0].id);
      return { success: true, action: 'updated', contact_id: existingContacts[0].id };
    } else {
      const { data: newContact } = await supabase.from('organization_contact').insert(contactRecord).select().single();
      return { success: true, action: 'created', contact_id: newContact?.id };
    }
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
            has_job_posting_access = !isResourceExcluded(excludedFeatures, 'page_PostJob');
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

  async createStripePaymentIntent(params) {
    if (!stripe) throw new Error('Stripe not configured');
    
    const { amount, currency = 'gbp', metadata = {}, memberEmail } = params;

    if (!amount || amount <= 0) {
      return { error: 'Invalid amount' };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      metadata: { ...metadata, member_email: memberEmail }
    });

    return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  },

  async getStripePublishableKey() {
    const key = process.env.STRIPE_PUBLISHABLE_KEY || process.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      return { error: 'Stripe publishable key not configured' };
    }
    return { publishableKey: key };
  },

  async validateUser(params) {
    return this.validateMember(params);
  },

  async syncAllOrganizationsFromZoho(params = {}) {
    if (!supabase) throw new Error('Supabase not configured');
    
    // Chunked sync: fetch and process limited records per call
    const { page_token: inputPageToken, max_pages = 3 } = params;
    
    try {
      console.log('[syncAllOrganizationsFromZoho] Getting Zoho access token...');
      
      const accessToken = await getValidZohoAccessToken();
      
      // Pre-load existing organizations for fast lookups
      const { data: existingOrgs } = await supabase.from('organization').select('id, zoho_account_id');
      const existingByZohoId = {};
      (existingOrgs || []).forEach(org => {
        if (org.zoho_account_id) {
          existingByZohoId[org.zoho_account_id] = org;
        }
      });

      // Parse input token - format: "cursor:TOKEN" or "page:N"
      let pageToken = null;
      let page = 1;
      if (inputPageToken) {
        if (inputPageToken.startsWith('cursor:')) {
          pageToken = inputPageToken.substring(7);
        } else if (inputPageToken.startsWith('page:')) {
          page = parseInt(inputPageToken.substring(5), 10) || 1;
        }
      }
      
      const perPage = 200;
      let pagesProcessed = 0;
      let totalFetched = 0;
      let created = 0;
      let updated = 0;
      let hasMore = true;
      let nextPageToken = null;

      console.log(`[syncAllOrganizationsFromZoho] Starting sync (max ${max_pages} pages per call, starting page ${page})...`);

      while (hasMore && pagesProcessed < max_pages) {
        const accountFields = 'id,Account_Name,Training_Fund_Balance,Purchase_Order_Enabled,Email_Domains';
        let accountsUrl;
        if (pageToken) {
          // Cursor-based pagination (for records beyond 2000)
          accountsUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts?fields=${accountFields}&per_page=${perPage}&page_token=${pageToken}`;
        } else {
          // Offset-based pagination (for first 2000 records)
          accountsUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts?fields=${accountFields}&page=${page}&per_page=${perPage}`;
        }
        
        const response = await fetch(accountsUrl, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[syncAllOrganizationsFromZoho] Failed to fetch accounts:', response.status, errorText);
          return { success: false, error: `Zoho API error: ${response.status} - ${errorText}` };
        }

        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
          const accounts = data.data;
          totalFetched += accounts.length;
          pagesProcessed++;
          
          console.log(`[syncAllOrganizationsFromZoho] Page ${pagesProcessed}: processing ${accounts.length} accounts`);
          
          // Process this batch - prepare bulk operations
          const toInsert = [];
          const toUpdate = [];
          
          for (const account of accounts) {
            const orgData = {
              zoho_account_id: account.id,
              name: account.Account_Name || 'Unnamed Organization',
              website: account.Website || null,
              phone: account.Phone || null,
              industry: account.Industry || null,
              account_type: account.Account_Type || null,
              billing_street: account.Billing_Street || null,
              billing_city: account.Billing_City || null,
              billing_state: account.Billing_State || null,
              billing_code: account.Billing_Code || null,
              billing_country: account.Billing_Country || null,
              last_synced: new Date().toISOString()
            };

            if (existingByZohoId[account.id]) {
              toUpdate.push({ id: existingByZohoId[account.id].id, ...orgData });
            } else {
              toInsert.push(orgData);
              existingByZohoId[account.id] = { id: 'pending' };
            }
          }
          
          // Bulk insert new organizations
          if (toInsert.length > 0) {
            const { error: insertError } = await supabase.from('organization').insert(toInsert);
            if (insertError) {
              console.error('[syncAllOrganizationsFromZoho] Bulk insert error:', insertError.message);
            } else {
              created += toInsert.length;
            }
          }
          
          // Bulk update existing organizations (batch of 50 at a time)
          const updateBatchSize = 50;
          for (let i = 0; i < toUpdate.length; i += updateBatchSize) {
            const batch = toUpdate.slice(i, i + updateBatchSize);
            await Promise.all(batch.map(({ id, ...updateData }) => 
              supabase.from('organization').update(updateData).eq('id', id)
            ));
            updated += batch.length;
          }
          
          // Check for next page - encode pagination type in token
          if (data.info && data.info.next_page_token) {
            // Zoho provided a cursor for next page
            pageToken = data.info.next_page_token;
            nextPageToken = `cursor:${data.info.next_page_token}`;
            page++;
          } else if (data.info && data.info.more_records) {
            // More records using offset pagination
            page++;
            pageToken = null;
            nextPageToken = `page:${page}`;
          } else {
            hasMore = false;
            nextPageToken = null;
          }
        } else {
          hasMore = false;
          nextPageToken = null;
        }
      }

      const isComplete = !hasMore || !nextPageToken;
      console.log(`[syncAllOrganizationsFromZoho] Chunk complete: ${created} created, ${updated} updated, complete: ${isComplete}`);

      return { 
        success: true, 
        synced: totalFetched, 
        created, 
        updated,
        complete: isComplete,
        next_page_token: nextPageToken,
        message: isComplete 
          ? `Sync complete: ${totalFetched} organizations (${created} created, ${updated} updated)`
          : `Synced ${totalFetched} organizations so far... (${created} created, ${updated} updated) - continuing...`
      };
    } catch (err) {
      console.error('[syncAllOrganizationsFromZoho] Error:', err);
      return { success: false, error: err.message };
    }
  },

  async syncAllMembersFromZoho(params = {}) {
    if (!supabase) throw new Error('Supabase not configured');
    
    // Chunked sync: fetch and process limited records per call
    const { page_token: inputPageToken, max_pages = 3 } = params;
    
    try {
      const accessToken = await getValidZohoAccessToken();
      
      // Pre-load existing members and organizations for fast lookups
      console.log('[syncAllMembersFromZoho] Loading existing members and organizations...');
      const { data: existingMembers } = await supabase.from('member').select('id, email, zoho_contact_id');
      const existingByZohoId = {};
      const existingByEmail = {};
      (existingMembers || []).forEach(member => {
        if (member.zoho_contact_id) {
          existingByZohoId[member.zoho_contact_id] = member;
        }
        if (member.email) {
          existingByEmail[member.email.toLowerCase()] = member;
        }
      });

      const { data: orgs } = await supabase.from('organization').select('id, zoho_account_id');
      const orgByZohoId = {};
      (orgs || []).forEach(org => {
        if (org.zoho_account_id) {
          orgByZohoId[org.zoho_account_id] = org;
        }
      });

      // Parse input token - format: "cursor:TOKEN" or "page:N"
      let pageToken = null;
      let page = 1;
      if (inputPageToken) {
        if (inputPageToken.startsWith('cursor:')) {
          pageToken = inputPageToken.substring(7);
        } else if (inputPageToken.startsWith('page:')) {
          page = parseInt(inputPageToken.substring(5), 10) || 1;
        }
      }
      
      const perPage = 200;
      let pagesProcessed = 0;
      let totalFetched = 0;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let hasMore = true;
      let nextPageToken = null;

      console.log(`[syncAllMembersFromZoho] Starting sync (max ${max_pages} pages per call, starting page ${page})...`);

      while (hasMore && pagesProcessed < max_pages) {
        const contactFields = 'id,Email,First_Name,Last_Name,Account_Name';
        let contactsUrl;
        if (pageToken) {
          // Cursor-based pagination (for records beyond 2000)
          contactsUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts?fields=${contactFields}&per_page=${perPage}&page_token=${pageToken}`;
        } else {
          // Offset-based pagination (for first 2000 records)
          contactsUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts?fields=${contactFields}&page=${page}&per_page=${perPage}`;
        }
        
        const response = await fetch(contactsUrl, {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[syncAllMembersFromZoho] Failed to fetch contacts:', response.status, errorText);
          return { success: false, error: `Zoho API error: ${response.status} - ${errorText}` };
        }

        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
          const contacts = data.data;
          totalFetched += contacts.length;
          pagesProcessed++;
          
          console.log(`[syncAllMembersFromZoho] Page ${pagesProcessed}: processing ${contacts.length} contacts`);
          
          // Process this batch immediately
          const toInsert = [];
          const toUpdate = [];
          
          for (const contact of contacts) {
            if (!contact.Email) {
              skipped++;
              continue;
            }

            let organizationId = null;
            if (contact.Account_Name && contact.Account_Name.id) {
              const linkedOrg = orgByZohoId[contact.Account_Name.id];
              if (linkedOrg) {
                organizationId = linkedOrg.id;
              }
            }

            const memberData = {
              zoho_contact_id: contact.id,
              email: contact.Email,
              first_name: contact.First_Name || '',
              last_name: contact.Last_Name || '',
              organization_id: organizationId,
              last_synced: new Date().toISOString()
            };

            const existingMember = existingByZohoId[contact.id] || existingByEmail[contact.Email.toLowerCase()];

            if (existingMember) {
              toUpdate.push({ id: existingMember.id, ...memberData });
            } else {
              toInsert.push(memberData);
              existingByZohoId[contact.id] = { id: 'pending', zoho_contact_id: contact.id };
              existingByEmail[contact.Email.toLowerCase()] = { id: 'pending', email: contact.Email };
            }
          }

          // Bulk insert new members
          if (toInsert.length > 0) {
            const { error: insertError } = await supabase.from('member').insert(toInsert);
            if (insertError) {
              console.error('[syncAllMembersFromZoho] Bulk insert error:', insertError.message);
            } else {
              created += toInsert.length;
            }
          }

          // Bulk update existing members (batch of 50 at a time with parallel execution)
          const updateBatchSize = 50;
          for (let i = 0; i < toUpdate.length; i += updateBatchSize) {
            const batch = toUpdate.slice(i, i + updateBatchSize);
            await Promise.all(batch.map(({ id, ...updateData }) => 
              supabase.from('member').update(updateData).eq('id', id)
            ));
            updated += batch.length;
          }
          
          // Check for next page - encode pagination type in token
          if (data.info && data.info.next_page_token) {
            // Zoho provided a cursor for next page
            pageToken = data.info.next_page_token;
            nextPageToken = `cursor:${data.info.next_page_token}`;
            page++;
          } else if (data.info && data.info.more_records) {
            // More records using offset pagination
            page++;
            pageToken = null;
            nextPageToken = `page:${page}`;
          } else {
            hasMore = false;
            nextPageToken = null;
          }
        } else {
          hasMore = false;
          nextPageToken = null;
        }
      }

      const isComplete = !hasMore || !nextPageToken;
      console.log(`[syncAllMembersFromZoho] Chunk complete: ${created} created, ${updated} updated, ${skipped} skipped, complete: ${isComplete}`);

      return { 
        success: true, 
        synced: totalFetched, 
        created, 
        updated,
        skipped,
        complete: isComplete,
        next_page_token: nextPageToken,
        message: isComplete 
          ? `Sync complete: ${totalFetched} members (${created} created, ${updated} updated, ${skipped} skipped)`
          : `Synced ${totalFetched} members so far... (${created} created, ${updated} updated) - continuing...`
      };
    } catch (err) {
      console.error('[syncAllMembersFromZoho] Error:', err);
      return { success: false, error: err.message };
    }
  },

  async exportAllData() {
    return { success: false, error: 'Data export should be triggered from admin panel in development environment' };
  },

  async sendTeamMemberInvite() {
    return { success: false, error: 'Team member invites require email configuration' };
  },

  async renameResourceSubcategory(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { oldName, newName, category } = params;

    if (!oldName || !newName) {
      return { success: false, error: 'Both oldName and newName are required' };
    }

    const { data: resources } = await supabase.from('resource').select('*').eq('subcategory', oldName);

    if (!resources || resources.length === 0) {
      return { success: true, message: 'No resources found with that subcategory', updated: 0 };
    }

    for (const resource of resources) {
      await supabase.from('resource').update({ subcategory: newName }).eq('id', resource.id);
    }

    return { success: true, updated: resources.length };
  },

  async handleJobPostingPaymentWebhook(params) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { paymentIntentId, status } = params;

    if (!paymentIntentId) {
      return { success: false, error: 'Missing payment intent ID' };
    }

    if (status === 'succeeded') {
      const { data: jobPostings } = await supabase.from('job_posting').select('*').eq('stripe_payment_intent_id', paymentIntentId);

      if (jobPostings && jobPostings.length > 0) {
        await supabase.from('job_posting').update({ payment_status: 'paid', status: 'active' }).eq('id', jobPostings[0].id);
        return { success: true, job_posting_id: jobPostings[0].id };
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

  async getZohoAuthUrl(params, req) {
    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    
    if (!ZOHO_CLIENT_ID) {
      return { error: 'Zoho OAuth not configured' };
    }

    const accountsDomain = ZOHO_CRM_API_DOMAIN.includes('.eu') ? 'https://accounts.zoho.eu' : 'https://accounts.zoho.com';
    const redirectUri = req ? `${req.headers.origin || `https://${req.headers.host}`}/api/functions/zohoOAuthCallback` : '';

    const authUrl = `${accountsDomain}/oauth/v2/auth?` + new URLSearchParams({
      scope: 'ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.accounts.ALL,zohobackstage.portal.READ,zohobackstage.event.READ,zohobackstage.eventticket.READ,zohobackstage.order.READ,zohobackstage.order.CREATE,zohobackstage.attendee.READ',
      client_id: ZOHO_CLIENT_ID,
      response_type: 'code',
      access_type: 'offline',
      redirect_uri: redirectUri,
      prompt: 'consent'
    }).toString();

    return { authUrl };
  },

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
      const token = await getZoomAccessToken();
      
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

    const token = await getZoomAccessToken();
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

  async getXeroAuthUrl(params, req) {
    // Debug: log which env vars are present
    const debug = {
      hasClientId: !!XERO_CLIENT_ID,
      hasRedirectUri: !!XERO_REDIRECT_URI,
      redirectUriValue: XERO_REDIRECT_URI ? XERO_REDIRECT_URI.substring(0, 30) + '...' : 'NOT SET'
    };
    console.log('getXeroAuthUrl debug:', debug);
    
    if (!XERO_CLIENT_ID || !XERO_REDIRECT_URI) {
      throw new Error(`Xero not configured - hasClientId: ${!!XERO_CLIENT_ID}, hasRedirectUri: ${!!XERO_REDIRECT_URI}`);
    }

    const authUrl = `https://login.xero.com/identity/connect/authorize?` + new URLSearchParams({
      response_type: 'code',
      client_id: XERO_CLIENT_ID,
      redirect_uri: XERO_REDIRECT_URI,
      scope: 'offline_access accounting.transactions accounting.contacts openid profile email',
      state: 'xero_auth'
    }).toString();

    return { authUrl };
  },

  async xeroOAuthCallback(params, req) {
    if (!supabase) throw new Error('Supabase not configured');
    
    const { code, error: oauthError } = params;

    if (oauthError) {
      throw new Error(`Xero OAuth error: ${oauthError}`);
    }

    if (!code) {
      throw new Error('No authorization code received');
    }

    if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET || !XERO_REDIRECT_URI) {
      throw new Error('Xero credentials not configured');
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: XERO_REDIRECT_URI
      }).toString()
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(`Failed to exchange code for token: ${JSON.stringify(tokenData)}`);
    }

    // Get tenant connections
    const connectionsResponse = await fetch('https://api.xero.com/connections', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    const connections = await connectionsResponse.json();
    const tenantId = connections[0]?.tenantId;

    if (!tenantId) {
      throw new Error('No Xero tenant found');
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

    // Store or update token
    const { data: existingTokens } = await supabase
      .from('xero_token')
      .select('id');

    if (existingTokens && existingTokens.length > 0) {
      await supabase
        .from('xero_token')
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
          tenant_id: tenantId
        })
        .eq('id', existingTokens[0].id);
    } else {
      await supabase
        .from('xero_token')
        .insert({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
          tenant_id: tenantId
        });
    }

    return {
      success: true,
      message: 'Xero authentication successful',
      tenant_id: tenantId
    };
  },

  async refreshXeroToken(params) {
    if (!supabase) throw new Error('Supabase not configured');

    if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) {
      throw new Error('Xero credentials not configured');
    }

    const { data: tokens } = await supabase
      .from('xero_token')
      .select('*');

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
        'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
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

  async createXeroInvoice(params) {
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
      internalReference
    } = params;

    if (!organizationName || !programName || totalCost === undefined || !totalTickets) {
      throw new Error('Missing required parameters: organizationName, programName, totalCost, totalTickets');
    }

    // Get valid Xero token
    const { accessToken, tenantId } = await getValidXeroAccessToken();

    // Find or create contact
    const contactId = await findOrCreateXeroContact(accessToken, tenantId, organizationName);

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
        Status: 'DRAFT',
        DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        LineItems: [{
          Description: description,
          Quantity: totalTickets,
          UnitAmount: unitPrice,
          AccountCode: '200'
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

    if (!purchaseOrderNumber) {
      throw new Error('Missing required parameter: purchaseOrderNumber');
    }

    // First, get the booking to find the Xero invoice ID and verify ownership
    const { data: booking, error: fetchError } = await supabase
      .from('booking')
      .select('xero_invoice_id, xero_invoice_number, member_id')
      .eq('booking_group_reference', bookingGroupReference)
      .not('xero_invoice_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      throw new Error(`Failed to fetch booking: ${fetchError.message}`);
    }

    if (!booking || !booking.xero_invoice_id) {
      throw new Error('No Xero invoice found for this booking');
    }

    // Verify ownership - the authenticated member must own this booking
    if (booking.member_id !== memberId) {
      throw new Error('Not authorized to update this booking');
    }

    // Get valid Xero token
    const { accessToken, tenantId } = await getValidXeroAccessToken();

    // Update the invoice reference in Xero using POST to the specific invoice
    const updatePayload = {
      Invoices: [{
        InvoiceID: booking.xero_invoice_id,
        Reference: purchaseOrderNumber
      }]
    };

    console.log('[updateXeroInvoicePO] Updating invoice reference in Xero:', booking.xero_invoice_id, 'with PO:', purchaseOrderNumber);

    const updateResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatePayload)
    });

    const updateData = await updateResponse.json();

    if (!updateResponse.ok || !updateData.Invoices || updateData.Invoices.length === 0) {
      throw new Error(`Failed to update invoice reference: ${JSON.stringify(updateData)}`);
    }

    const updatedInvoice = updateData.Invoices[0];
    console.log('[updateXeroInvoicePO] Invoice reference updated in Xero:', updatedInvoice.InvoiceNumber);

    // Update booking records with PO number (PDF is fetched on-demand from Xero)
    const { error: updateError } = await supabase
      .from('booking')
      .update({
        purchase_order_number: purchaseOrderNumber,
        po_to_follow: false
      })
      .eq('booking_group_reference', bookingGroupReference);

    if (updateError) {
      throw new Error(`Failed to update booking PO number: ${updateError.message}`);
    }

    console.log('[updateXeroInvoicePO] Booking PO number updated');

    return {
      success: true,
      invoice_id: booking.xero_invoice_id,
      invoice_number: booking.xero_invoice_number,
      reference: purchaseOrderNumber
    };
  },

  async getXeroConnectionStatus(params) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data: tokens } = await supabase
      .from('xero_token')
      .select('expires_at, tenant_id');

    if (!tokens || tokens.length === 0) {
      return {
        connected: false,
        message: 'Xero not connected. Please authenticate.'
      };
    }

    const token = tokens[0];
    const expiresAt = new Date(token.expires_at);
    const now = new Date();

    return {
      connected: true,
      tenant_id: token.tenant_id,
      expires_at: token.expires_at,
      is_expired: expiresAt <= now
    };
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
  const oauthCallbackFunctions = ['xeroOAuthCallback', 'zohoOAuthCallback'];
  
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
