import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Booking IDs that need invoices
const BOOKINGS_TO_BACKFILL = [
  'de435914-43db-4527-af39-9b6db1af79f7', // £150 card payment (guest)
  '138be3ff-90b7-4024-9cf4-9a9e8f670595', // £1130 card payment
  'bee71b84-b8dc-4126-83c4-00e66eb92363'  // £850 account payment with PO
];

// Decrypt helper
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[Xero] Cannot decrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[Xero] Decryption error:', e.message);
    return null;
  }
}

function decryptCredentials(credentials) {
  if (!credentials) return {};
  const decrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string' && value.includes(':')) {
      decrypted[key] = decrypt(value);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted;
}

// Helper: Get Xero credentials from database
async function getXeroCredentials(appTenantId) {
  const { data: integration, error } = await supabase
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', appTenantId)
    .eq('integration_type', 'xero')
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[Xero] Error fetching credentials:', error);
    throw new Error('Failed to fetch Xero credentials');
  }

  if (!integration) {
    return null;
  }

  const decrypted = decryptCredentials(integration.credentials);
  
  return {
    client_id: decrypted.client_id || null,
    client_secret: decrypted.client_secret || null,
    is_enabled: integration.is_enabled
  };
}

// Helper: Get valid Xero access token (refreshes if needed)
async function getValidXeroAccessToken(appTenantId) {
  const { data: tokens, error: tokenError } = await supabase
    .from('xero_token')
    .select('*')
    .eq('app_tenant_id', appTenantId);

  if (tokenError || !tokens || tokens.length === 0) {
    throw new Error('No Xero token found for this tenant');
  }

  const token = tokens[0];
  
  if (token.tenant_id === 'PENDING_SELECTION') {
    throw new Error('Xero authentication incomplete');
  }
  
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesFromNow) {
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  console.log('[Xero] Token expired or expiring soon, refreshing...');
  const xeroCredentials = await getXeroCredentials(appTenantId);

  if (!xeroCredentials || !xeroCredentials.client_id || !xeroCredentials.client_secret) {
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

  console.log('[Xero] Token refreshed successfully');
  return { accessToken: tokenData.access_token, tenantId: token.tenant_id };
}

// Helper: Find or create Xero contact
async function findOrCreateXeroContact(accessToken, tenantId, contactInfo) {
  const info = {
    name: contactInfo.name || 'Unknown',
    email: contactInfo.email,
    isOrganization: contactInfo.isOrganization || false
  };

  console.log(`[Xero] Finding/creating contact: ${info.name}`);

  // Search for existing contact by name
  const escapedName = info.name.replace(/"/g, '\\"');
  const contactSearchResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${escapedName}"`)}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json'
      }
    }
  );

  const contactData = await contactSearchResponse.json();
  
  if (contactData.Contacts && contactData.Contacts.length > 0) {
    console.log(`[Xero] Found existing contact: ${contactData.Contacts[0].ContactID}`);
    return contactData.Contacts[0].ContactID;
  }

  // Create new contact
  console.log(`[Xero] Creating new contact: ${info.name}`);
  const contactPayload = {
    Name: info.name,
    EmailAddress: info.email || undefined
  };

  const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Contacts: [contactPayload] })
  });

  const newContactData = await createContactResponse.json();
  
  if (newContactData.Contacts && newContactData.Contacts.length > 0) {
    console.log(`[Xero] Created new contact: ${newContactData.Contacts[0].ContactID}`);
    return newContactData.Contacts[0].ContactID;
  }

  throw new Error('Failed to create Xero contact');
}

async function backfillInvoiceForBooking(bookingId) {
  console.log(`\n========================================`);
  console.log(`Processing booking: ${bookingId}`);
  console.log(`========================================`);

  // Fetch booking with all related data
  const { data: bookings, error: bookingError } = await supabase
    .from('booking')
    .select(`
      id,
      booking_group_reference,
      total_cost,
      account_amount,
      voucher_amount,
      training_fund_amount,
      payment_method,
      purchase_order_number,
      po_to_follow,
      stripe_payment_intent_id,
      ticket_class_name,
      ticket_price,
      xero_invoice_id,
      member_id,
      organization_id,
      event_id,
      attendee_first_name,
      attendee_last_name,
      attendee_email,
      tenant_id,
      is_guest_booking
    `)
    .eq('booking_group_reference', (await supabase.from('booking').select('booking_group_reference').eq('id', bookingId).single()).data.booking_group_reference);

  if (bookingError || !bookings || bookings.length === 0) {
    console.error(`Failed to fetch booking: ${bookingError?.message}`);
    return;
  }

  const booking = bookings[0];
  const allBookingsInGroup = bookings;

  // Check if already has invoice
  if (booking.xero_invoice_id) {
    console.log(`Booking already has Xero invoice: ${booking.xero_invoice_id} - skipping`);
    return;
  }

  const appTenantId = booking.tenant_id;
  console.log(`Tenant ID: ${appTenantId}`);
  console.log(`Payment method: ${booking.payment_method}`);
  console.log(`Total cost: £${booking.total_cost}`);
  console.log(`Account amount: £${booking.account_amount || 0}`);
  console.log(`Voucher amount: £${booking.voucher_amount || 0}`);
  console.log(`Training fund amount: £${booking.training_fund_amount || 0}`);
  console.log(`PO number: ${booking.purchase_order_number || 'none'}`);
  console.log(`Stripe PI: ${booking.stripe_payment_intent_id || 'none'}`);

  // Calculate remaining balance (amount to invoice)
  const voucherAmount = booking.voucher_amount || 0;
  const trainingFundAmount = booking.training_fund_amount || 0;
  const remainingBalance = booking.total_cost - voucherAmount - trainingFundAmount;

  if (remainingBalance <= 0) {
    console.log(`No remaining balance to invoice (fully covered by vouchers/training funds)`);
    return;
  }

  console.log(`Remaining balance to invoice: £${remainingBalance}`);

  // Get member and organization info
  let member = null;
  let org = null;

  if (booking.member_id) {
    const { data: memberData } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, organization_id')
      .eq('id', booking.member_id)
      .single();
    member = memberData;
  }

  if (booking.organization_id) {
    const { data: orgData } = await supabase
      .from('organization')
      .select('id, name')
      .eq('id', booking.organization_id)
      .single();
    org = orgData;
  }

  // Get event info
  const { data: event } = await supabase
    .from('event')
    .select('id, title, internal_reference, pricing_config, tenant_id')
    .eq('id', booking.event_id)
    .single();

  if (!event) {
    console.error(`Event not found for booking`);
    return;
  }

  console.log(`Event: ${event.title}`);
  console.log(`Organization: ${org?.name || 'none'}`);
  console.log(`Is guest booking: ${booking.is_guest_booking}`);

  // Resolve invoice contact (same logic as normal flow)
  // Priority: org > guest attendee > member
  let invoiceContactInfo = null;
  
  if (org) {
    invoiceContactInfo = {
      name: org.name,
      email: null,
      isOrganization: true
    };
    console.log(`Invoice to organization: ${org.name}`);
  } else if (booking.is_guest_booking) {
    // Guest booking - use attendee info from booking record
    const guestName = `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim();
    invoiceContactInfo = {
      name: guestName || booking.attendee_email,
      email: booking.attendee_email,
      isOrganization: false
    };
    console.log(`Invoice to guest: ${invoiceContactInfo.name}`);
  } else if (member) {
    const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim();
    invoiceContactInfo = {
      name: memberName || member.email,
      email: member.email,
      isOrganization: false
    };
    console.log(`Invoice to member: ${invoiceContactInfo.name}`);
  }

  if (!invoiceContactInfo || !invoiceContactInfo.name) {
    console.error(`Cannot determine invoice contact - skipping`);
    return;
  }

  // Check Xero settings
  const { data: xeroSettings } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'xero_invoice_enabled')
    .eq('tenant_id', appTenantId)
    .maybeSingle();

  const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';
  
  if (!xeroInvoiceEnabled) {
    console.log(`Xero invoice creation not enabled for this tenant - skipping`);
    return;
  }

  try {
    const { accessToken, tenantId } = await getValidXeroAccessToken(appTenantId);
    console.log(`Got Xero access token`);

    // Find or create contact
    const contactId = await findOrCreateXeroContact(accessToken, tenantId, invoiceContactInfo);

    // Build attendee list for description
    const attendeeList = allBookingsInGroup.map(b => {
      const firstName = b.attendee_first_name || '';
      const lastName = b.attendee_last_name || '';
      return `${firstName} ${lastName}`.trim() || b.attendee_email;
    }).join('\n');

    // Build financial breakdown
    const ticketUnitPrice = booking.ticket_price || (booking.total_cost / allBookingsInGroup.length);
    const ticketSubtotal = ticketUnitPrice * allBookingsInGroup.length;

    let financialBreakdown = [];
    financialBreakdown.push(`${allBookingsInGroup.length} x ${booking.ticket_class_name || 'Ticket'} @ £${ticketUnitPrice.toFixed(2)} = £${ticketSubtotal.toFixed(2)}`);

    if (voucherAmount > 0) {
      financialBreakdown.push(`Voucher applied: -£${voucherAmount.toFixed(2)}`);
    }
    if (trainingFundAmount > 0) {
      financialBreakdown.push(`Training fund applied: -£${trainingFundAmount.toFixed(2)}`);
    }
    financialBreakdown.push(`Total to invoice: £${remainingBalance.toFixed(2)}`);

    const lineDescriptionParts = [
      `Event: ${event.title || 'Event'}`,
      `Reference: ${event.internal_reference || 'N/A'}`,
      `Ticket class: ${booking.ticket_class_name || 'Standard'}`,
      `Attendees: ${allBookingsInGroup.length}`,
      attendeeList,
      '',
      '----------',
      'Financial Breakdown:',
      ...financialBreakdown
    ];
    const lineDescription = lineDescriptionParts.join('\n');

    // Get account code setting
    const { data: accountCodeSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_sales_account_code')
      .eq('tenant_id', appTenantId)
      .maybeSingle();

    const xeroAccountCode = accountCodeSetting?.setting_value || '200';

    // Get invoice status setting
    const { data: invoiceStatusSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'xero_invoice_status')
      .eq('tenant_id', appTenantId)
      .maybeSingle();
    
    const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

    // Calculate due date (30 days from booking creation, or from now for backfill)
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateString = dueDate.toISOString().split('T')[0];

    // Determine reference based on payment method
    // Card payments: use Stripe reference or TBC
    // Account payments: use PO number or TBC
    let invoiceReference;
    if (booking.payment_method === 'card') {
      invoiceReference = booking.stripe_payment_intent_id ? `Stripe: ${booking.stripe_payment_intent_id.slice(-8)}` : 'TBC';
    } else {
      invoiceReference = booking.po_to_follow ? 'TBC' : (booking.purchase_order_number || 'TBC');
    }

    // Build line item
    const lineItem = {
      Description: lineDescription,
      Quantity: 1,
      UnitAmount: remainingBalance,
      AccountCode: xeroAccountCode
    };

    // Add tracking for Projects if internal_reference is set
    if (event.internal_reference) {
      lineItem.Tracking = [{
        Name: 'Projects',
        Option: event.internal_reference
      }];
    }

    // Create invoice
    const invoicePayload = {
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      DueDate: dueDateString,
      LineItems: [lineItem],
      Reference: invoiceReference,
      Status: xeroInvoiceStatus
    };

    console.log(`Creating invoice - Amount: £${remainingBalance.toFixed(2)}, Reference: ${invoiceReference}, Status: ${xeroInvoiceStatus}`);

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

    const responseText = await invoiceResponse.text();
    let invoiceData = null;
    
    try {
      invoiceData = JSON.parse(responseText);
    } catch (parseError) {
      console.error(`Failed to parse response: ${responseText.substring(0, 200)}`);
      return;
    }

    if (invoiceData && invoiceData.Invoices && invoiceData.Invoices.length > 0) {
      const invoice = invoiceData.Invoices[0];
      console.log(`Invoice created: ${invoice.InvoiceNumber} (${invoice.InvoiceID})`);

      // Update all booking records with Xero invoice ID
      const { error: updateError } = await supabase
        .from('booking')
        .update({
          xero_invoice_id: invoice.InvoiceID,
          xero_invoice_number: invoice.InvoiceNumber
        })
        .eq('booking_group_reference', booking.booking_group_reference);

      if (updateError) {
        console.error(`Failed to update bookings: ${updateError.message}`);
      } else {
        console.log(`Updated ${allBookingsInGroup.length} booking(s) with invoice ID`);
      }

      // Record payment in Xero if this was a Stripe payment AND invoice is AUTHORISED
      if (booking.payment_method === 'card' && booking.stripe_payment_intent_id && invoice.Status === 'AUTHORISED') {
        try {
          const { data: stripeBankCodeSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'xero_stripe_bank_account_code')
            .eq('tenant_id', appTenantId)
            .maybeSingle();

          const stripeBankAccountCode = stripeBankCodeSetting?.setting_value;
          
          if (stripeBankAccountCode) {
            console.log(`Recording Stripe payment - Bank Account: ${stripeBankAccountCode}`);
            
            // Get bank account ID
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
              const paymentPayload = {
                Invoice: { InvoiceID: invoice.InvoiceID },
                Account: { AccountID: bankAccount.AccountID },
                Date: new Date().toISOString().split('T')[0],
                Amount: remainingBalance,
                Reference: `Stripe: ${booking.stripe_payment_intent_id}`
              };

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
                console.log(`Payment recorded: ${paymentData.Payments[0].PaymentID}`);
              } else {
                console.error(`Failed to record payment: ${JSON.stringify(paymentData).substring(0, 500)}`);
              }
            } else {
              console.warn(`Bank account not found for code: ${stripeBankAccountCode}`);
            }
          } else {
            console.log(`Stripe bank account code not configured - payment not recorded`);
          }
        } catch (paymentError) {
          console.error(`Error recording payment: ${paymentError.message}`);
        }
      } else if (booking.payment_method === 'card' && booking.stripe_payment_intent_id && invoice.Status !== 'AUTHORISED') {
        console.log(`Skipping payment recording - invoice is ${invoice.Status} (must be AUTHORISED)`);
      }
    } else {
      console.error(`Invoice creation failed`);
      if (invoiceData?.Elements) {
        invoiceData.Elements.forEach((element) => {
          if (element.ValidationErrors) {
            element.ValidationErrors.forEach((ve) => {
              console.error(`Validation error: ${ve.Message}`);
            });
          }
        });
      }
      console.error(`Response: ${JSON.stringify(invoiceData).substring(0, 500)}`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
}

async function main() {
  console.log('==============================================');
  console.log('XERO INVOICE BACKFILL SCRIPT');
  console.log('==============================================');
  console.log(`Processing ${BOOKINGS_TO_BACKFILL.length} bookings...`);

  for (const bookingId of BOOKINGS_TO_BACKFILL) {
    await backfillInvoiceForBooking(bookingId);
  }

  console.log('\n==============================================');
  console.log('BACKFILL COMPLETE');
  console.log('==============================================');
}

main().catch(console.error);
