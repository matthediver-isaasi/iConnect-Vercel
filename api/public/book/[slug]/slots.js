import { supabase } from '../../../_lib/database.js';
import { format, parse, addMinutes, isBefore, isAfter, startOfDay, addDays } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { getBusyTimes, getOutlookConnectionForIdentity } from '../../../outlook/calendar.js';

// Extract tenant slug from subdomain (e.g., gsf.iconn.app -> 'gsf')
function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    const potentialSlug = parts[0];
    if (!['www', 'api', 'localhost', '127'].includes(potentialSlug)) {
      return potentialSlug;
    }
  }
  return null;
}

function generateSlots(workingHours, agentTimezone, slotMinutes, bufferMinutes, dateStr, existingBookings, calendarBusyTimes = []) {
  const slots = [];
  
  // Parse date string as explicit date components to avoid timezone issues
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // Get day of week from the date string directly
  const tempDate = new Date(year, month - 1, day, 12, 0, 0); // noon to avoid DST issues
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayOfWeek = dayNames[tempDate.getDay()];
  
  console.log(`[Slots] Date: ${dateStr}, Day of week: ${dayOfWeek}, Working hours:`, workingHours?.[dayOfWeek]);
  
  const dayHours = workingHours?.[dayOfWeek] || [];
  if (dayHours.length === 0) {
    console.log(`[Slots] No hours configured for ${dayOfWeek}`);
    return slots;
  }

  const now = new Date();
  const totalSlotTime = slotMinutes + bufferMinutes;

  for (const period of dayHours) {
    if (!period.start || !period.end) {
      console.log(`[Slots] Invalid period:`, period);
      continue;
    }
    
    const [startHour, startMin] = period.start.split(':').map(Number);
    const [endHour, endMin] = period.end.split(':').map(Number);

    // Create dates in the agent's timezone
    const periodStartLocal = new Date(year, month - 1, day, startHour, startMin, 0, 0);
    const periodStart = fromZonedTime(periodStartLocal, agentTimezone);

    const periodEndLocal = new Date(year, month - 1, day, endHour, endMin, 0, 0);
    const periodEnd = fromZonedTime(periodEndLocal, agentTimezone);
    
    console.log(`[Slots] Period ${period.start}-${period.end}, UTC start: ${periodStart.toISOString()}, UTC end: ${periodEnd.toISOString()}`);

    let currentSlot = new Date(periodStart);

    while (addMinutes(currentSlot, slotMinutes) <= periodEnd) {
      const slotEnd = addMinutes(currentSlot, slotMinutes);
      
      // Check for conflicts with existing bookings in the system
      const hasBookingConflict = existingBookings.some(booking => {
        const bookingStart = new Date(booking.starts_at);
        const bookingEnd = new Date(booking.ends_at);
        return isBefore(currentSlot, bookingEnd) && isAfter(slotEnd, bookingStart);
      });

      // Check for conflicts with calendar busy times from Outlook
      const hasCalendarConflict = calendarBusyTimes.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return isBefore(currentSlot, busyEnd) && isAfter(slotEnd, busyStart);
      });

      const isPast = isBefore(currentSlot, now);

      if (!hasBookingConflict && !hasCalendarConflict && !isPast) {
        slots.push({
          start: currentSlot.toISOString(),
          end: slotEnd.toISOString()
        });
      }

      currentSlot = addMinutes(currentSlot, totalSlotTime);
    }
  }

  return slots;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug, date, days = 7 } = req.query;
  if (!slug) {
    return res.status(400).json({ error: 'Booking slug required' });
  }

  try {
    // Extract tenant from subdomain
    const host = req.headers.host || req.headers['x-forwarded-host'];
    const tenantSlug = getTenantSlugFromHost(host);
    
    console.log('[Slots] Host:', host, 'Tenant slug:', tenantSlug);

    // Find tenant by subdomain
    let tenantId = null;
    
    if (tenantSlug) {
      const { data: tenantData } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantSlug)
        .single();
      
      if (tenantData) {
        tenantId = tenantData.id;
      }
    }

    if (!tenantId) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('id')
      .eq('booking_slug', slug)
      .single();

    if (!identity) {
      return res.status(404).json({ error: 'Booking page not found' });
    }

    // Find availability profile for this identity AND this specific tenant
    const { data: profile, error: profileError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    console.log('[Slots] Profile query result:', { profile, profileError });

    if (!profile) {
      return res.status(404).json({ error: 'Booking page not active for this organization' });
    }
    
    console.log('[Slots] Working hours from profile:', JSON.stringify(profile.working_hours, null, 2));

    const numDays = Math.min(parseInt(days) || 7, 30);
    
    const agentTimezone = profile.timezone || 'Europe/London';
    const nowInAgentTz = toZonedTime(new Date(), agentTimezone);
    const startDateStr = date || format(nowInAgentTz, 'yyyy-MM-dd');
    
    const startDate = parse(startDateStr, 'yyyy-MM-dd', new Date());
    const endDate = addDays(startDate, numDays);
    
    const startDateUtc = fromZonedTime(startOfDay(startDate), agentTimezone);
    const endDateUtc = fromZonedTime(addDays(startOfDay(endDate), 1), agentTimezone);

    const { data: existingBookings } = await supabase
      .from('agent_booking')
      .select('starts_at, ends_at')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .gte('starts_at', startDateUtc.toISOString())
      .lte('starts_at', endDateUtc.toISOString());

    // Fetch calendar busy times from Outlook if connected
    let calendarBusyTimes = [];
    let calendarConnected = false;
    try {
      const outlookConnection = await getOutlookConnectionForIdentity(identity.id, tenantId);
      if (outlookConnection) {
        calendarConnected = true;
        calendarBusyTimes = await getBusyTimes(
          outlookConnection,
          startDateUtc.toISOString(),
          endDateUtc.toISOString(),
          agentTimezone
        );
        console.log(`[Slots] Found ${calendarBusyTimes.length} calendar busy times for agent`);
      }
    } catch (calendarError) {
      console.error('[Slots] Failed to fetch calendar busy times:', calendarError.message);
      // Continue without calendar data - don't fail the request
    }

    const slotsByDate = {};
    let currentDate = new Date(startDate);

    while (isBefore(currentDate, endDate)) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      slotsByDate[dateStr] = generateSlots(
        profile.working_hours,
        agentTimezone,
        profile.default_slot_minutes,
        profile.buffer_minutes,
        dateStr,
        existingBookings || [],
        calendarBusyTimes
      );
      currentDate = addDays(currentDate, 1);
    }

    return res.json({
      slots: slotsByDate,
      timezone: profile.timezone,
      slotMinutes: profile.default_slot_minutes,
      calendarConnected
    });
  } catch (err) {
    console.error('[Slots] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
