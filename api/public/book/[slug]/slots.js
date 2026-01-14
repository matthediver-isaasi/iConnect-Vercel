import { supabase } from '../../../_lib/database.js';
import { format, parse, addMinutes, isBefore, isAfter, startOfDay, addDays } from 'date-fns';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

function generateSlots(workingHours, agentTimezone, slotMinutes, bufferMinutes, dateStr, existingBookings) {
  const slots = [];
  
  const targetDate = parse(dateStr, 'yyyy-MM-dd', new Date());
  const dayOfWeek = formatInTimeZone(targetDate, agentTimezone, 'EEEE').toLowerCase();
  
  const dayHours = workingHours[dayOfWeek] || [];
  if (dayHours.length === 0) return slots;

  const now = new Date();
  const totalSlotTime = slotMinutes + bufferMinutes;

  for (const period of dayHours) {
    const [startHour, startMin] = period.start.split(':').map(Number);
    const [endHour, endMin] = period.end.split(':').map(Number);

    const periodStartLocal = new Date(targetDate);
    periodStartLocal.setHours(startHour, startMin, 0, 0);
    const periodStart = fromZonedTime(periodStartLocal, agentTimezone);

    const periodEndLocal = new Date(targetDate);
    periodEndLocal.setHours(endHour, endMin, 0, 0);
    const periodEnd = fromZonedTime(periodEndLocal, agentTimezone);

    let currentSlot = new Date(periodStart);

    while (addMinutes(currentSlot, slotMinutes) <= periodEnd) {
      const slotEnd = addMinutes(currentSlot, slotMinutes);
      
      const hasConflict = existingBookings.some(booking => {
        const bookingStart = new Date(booking.starts_at);
        const bookingEnd = new Date(booking.ends_at);
        return isBefore(currentSlot, bookingEnd) && isAfter(slotEnd, bookingStart);
      });

      const isPast = isBefore(currentSlot, now);

      if (!hasConflict && !isPast) {
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
    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('id')
      .eq('booking_slug', slug)
      .single();

    if (!identity) {
      return res.status(404).json({ error: 'Booking page not found' });
    }

    const { data: memberships } = await supabase
      .from('tenant_membership')
      .select('tenant_id')
      .eq('identity_id', identity.id)
      .eq('status', 'active')
      .limit(1);

    if (!memberships || memberships.length === 0) {
      return res.status(404).json({ error: 'Booking page not available' });
    }

    const tenantId = memberships[0].tenant_id;

    const { data: profile } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (!profile) {
      return res.status(404).json({ error: 'Booking page not active' });
    }

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
        existingBookings || []
      );
      currentDate = addDays(currentDate, 1);
    }

    return res.json({
      slots: slotsByDate,
      timezone: profile.timezone,
      slotMinutes: profile.default_slot_minutes
    });
  } catch (err) {
    console.error('[Slots] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
