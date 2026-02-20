import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase credentials');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

export default async function handler(req, res) {
  const token = req.query.token;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    return handleGet(req, res, supabase, token);
  } else if (req.method === 'POST') {
    return handleAddParticipant(req, res, supabase, token);
  } else if (req.method === 'DELETE') {
    return handleRemoveParticipant(req, res, supabase, token);
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

async function getBookingWithValidation(supabase, token) {
  const { data: booking, error } = await supabase
    .from('event_group_booking')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !booking) {
    return { booking: null, error: 'Group booking not found' };
  }

  if (booking.status !== 'active') {
    return { booking, error: 'This group booking is no longer active' };
  }

  const { data: event } = await supabase
    .from('event')
    .select('id, title, start_date, end_date, location, is_online, timezone, pricing_config')
    .eq('id', booking.event_id)
    .single();

  const ticketClass = event?.pricing_config?.ticket_classes?.find(
    tc => tc.id === booking.ticket_class_id
  );

  const cutoffDate = ticketClass?.group_cutoff_date || null;
  const isPastCutoff = cutoffDate && new Date() > new Date(cutoffDate);

  const { data: participants } = await supabase
    .from('event_group_booking_participant')
    .select('*')
    .eq('group_booking_id', booking.id)
    .order('added_at', { ascending: true });

  return {
    booking,
    event,
    ticketClass,
    participants: participants || [],
    cutoffDate,
    isPastCutoff,
    error: null
  };
}

async function handleGet(req, res, supabase, token) {
  try {
    const result = await getBookingWithValidation(supabase, token);

    if (result.error && !result.booking) {
      return res.status(404).json({ error: result.error });
    }

    const { booking, event, ticketClass, participants, cutoffDate, isPastCutoff } = result;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, name, slug, logo_url, primary_color')
      .eq('id', booking.tenant_id)
      .single();

    return res.status(200).json({
      booking: {
        id: booking.id,
        booker_email: booking.booker_email,
        booker_first_name: booking.booker_first_name,
        booker_last_name: booking.booker_last_name,
        group_size: booking.group_size,
        status: booking.status,
        booking_reference: booking.booking_reference,
        created_at: booking.created_at
      },
      event: event ? {
        id: event.id,
        title: event.title,
        start_date: event.start_date,
        end_date: event.end_date,
        location: event.location,
        is_online: event.is_online,
        timezone: event.timezone
      } : null,
      ticket_class: ticketClass ? {
        name: ticketClass.name,
        price: ticketClass.price,
        group_size: ticketClass.group_size
      } : null,
      participants,
      cutoff_date: cutoffDate,
      is_past_cutoff: isPastCutoff,
      spots_remaining: booking.group_size - (participants?.length || 0),
      tenant: tenant ? {
        name: tenant.name,
        logo_url: tenant.logo_url,
        primary_color: tenant.primary_color
      } : null
    });
  } catch (error) {
    console.error('[GroupBooking] GET error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleAddParticipant(req, res, supabase, token) {
  try {
    const { email, first_name, last_name } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const result = await getBookingWithValidation(supabase, token);

    if (result.error && !result.booking) {
      return res.status(404).json({ error: result.error });
    }

    if (result.error) {
      return res.status(403).json({ error: result.error });
    }

    const { booking, participants, isPastCutoff } = result;

    if (isPastCutoff) {
      return res.status(403).json({ error: 'The cut-off date has passed. No further changes can be made to this group booking.' });
    }

    if (participants.length >= booking.group_size) {
      return res.status(400).json({ error: `This group is full (maximum ${booking.group_size} participants).` });
    }

    const duplicate = participants.find(p => p.email.toLowerCase() === normalizedEmail);
    if (duplicate) {
      return res.status(409).json({ error: 'This email address has already been added to the group.' });
    }

    const { data: participant, error: insertError } = await supabase
      .from('event_group_booking_participant')
      .insert({
        group_booking_id: booking.id,
        tenant_id: booking.tenant_id,
        email: normalizedEmail,
        first_name: first_name?.trim() || null,
        last_name: last_name?.trim() || null
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return res.status(409).json({ error: 'This email address has already been added to the group.' });
      }
      console.error('[GroupBooking] Insert participant error:', insertError);
      return res.status(500).json({ error: 'Failed to add participant' });
    }

    const newCount = participants.length + 1;

    return res.status(201).json({
      success: true,
      participant,
      spots_remaining: booking.group_size - newCount,
      total_participants: newCount
    });
  } catch (error) {
    console.error('[GroupBooking] POST error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleRemoveParticipant(req, res, supabase, token) {
  try {
    const { participant_id } = req.body;

    if (!participant_id) {
      return res.status(400).json({ error: 'Participant ID is required' });
    }

    const result = await getBookingWithValidation(supabase, token);

    if (result.error && !result.booking) {
      return res.status(404).json({ error: result.error });
    }

    if (result.error) {
      return res.status(403).json({ error: result.error });
    }

    const { booking, isPastCutoff, participants } = result;

    if (isPastCutoff) {
      return res.status(403).json({ error: 'The cut-off date has passed. No further changes can be made to this group booking.' });
    }

    const participantExists = participants.find(p => p.id === participant_id);
    if (!participantExists) {
      return res.status(404).json({ error: 'Participant not found in this group booking.' });
    }

    const { error: deleteError } = await supabase
      .from('event_group_booking_participant')
      .delete()
      .eq('id', participant_id)
      .eq('group_booking_id', booking.id);

    if (deleteError) {
      console.error('[GroupBooking] Delete participant error:', deleteError);
      return res.status(500).json({ error: 'Failed to remove participant' });
    }

    const newCount = participants.length - 1;

    return res.status(200).json({
      success: true,
      spots_remaining: booking.group_size - newCount,
      total_participants: newCount
    });
  } catch (error) {
    console.error('[GroupBooking] DELETE error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
