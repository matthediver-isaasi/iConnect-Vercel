/**
 * Diagnostic script to check if event.start_date/end_date are in sync
 * with their linked zoom_meeting.start_time/duration
 * 
 * Usage:
 *   node scripts/check-event-zoom-time-sync.js                    # Check all tenants
 *   node scripts/check-event-zoom-time-sync.js <tenant-id>        # Check specific tenant
 */

import { createClient } from '@supabase/supabase-js';

const DEST_SUPABASE_URL = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('Error: DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(DEST_SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false }
});

function formatDate(date) {
  if (!date) return 'null';
  return new Date(date).toISOString();
}

function getTimeDiffMinutes(date1, date2) {
  if (!date1 || !date2) return null;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round((d1 - d2) / (1000 * 60));
}

async function checkEventZoomSync(tenantId = null) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Event <-> Zoom Meeting Time Sync Check`);
  if (tenantId) {
    console.log(`Tenant ID: ${tenantId}`);
  }
  console.log(`${'='.repeat(70)}\n`);

  let eventQuery = supabase
    .from('event')
    .select('id, title, start_date, end_date, tenant_id, zoom_meeting_id')
    .not('zoom_meeting_id', 'is', null);

  if (tenantId) {
    eventQuery = eventQuery.eq('tenant_id', tenantId);
  }

  const { data: events, error: eventError } = await eventQuery;

  if (eventError) {
    console.error('Error fetching events:', eventError);
    process.exit(1);
  }

  const zoomMeetingIds = [...new Set(events.map(e => e.zoom_meeting_id).filter(Boolean))];
  
  const { data: zoomMeetings, error: zmError } = await supabase
    .from('zoom_meeting')
    .select('id, topic, start_time, duration_minutes, timezone')
    .in('id', zoomMeetingIds);

  if (zmError) {
    console.error('Error fetching zoom meetings:', zmError);
    process.exit(1);
  }

  const zoomMeetingMap = new Map(zoomMeetings.map(zm => [zm.id, zm]));

  console.log(`Found ${events.length} events with linked Zoom meetings\n`);

  const inSync = [];
  const outOfSync = [];
  const orphaned = [];

  for (const event of events) {
    const zm = zoomMeetingMap.get(event.zoom_meeting_id);

    if (!zm) {
      orphaned.push({
        event,
        reason: 'Zoom meeting record not found'
      });
      continue;
    }

    const eventStart = new Date(event.start_date);
    const zoomStart = new Date(zm.start_time);
    
    const eventEnd = event.end_date ? new Date(event.end_date) : null;
    const zoomEnd = zm.duration_minutes 
      ? new Date(zoomStart.getTime() + zm.duration_minutes * 60 * 1000)
      : null;

    const startDiffMinutes = getTimeDiffMinutes(eventStart, zoomStart);
    const endDiffMinutes = eventEnd && zoomEnd ? getTimeDiffMinutes(eventEnd, zoomEnd) : null;

    const startInSync = Math.abs(startDiffMinutes) < 1;
    const endInSync = endDiffMinutes === null || Math.abs(endDiffMinutes) < 1;

    if (startInSync && endInSync) {
      inSync.push({ event, zm });
    } else {
      outOfSync.push({
        event,
        zm,
        startDiffMinutes,
        endDiffMinutes,
        eventStart,
        eventEnd,
        zoomStart,
        zoomEnd
      });
    }
  }

  if (outOfSync.length > 0) {
    console.log(`${'─'.repeat(70)}`);
    console.log(`OUT OF SYNC EVENTS (${outOfSync.length})`);
    console.log(`${'─'.repeat(70)}\n`);

    for (const item of outOfSync) {
      console.log(`  Event: ${item.event.title}`);
      console.log(`    Event ID: ${item.event.id}`);
      console.log(`    Zoom Meeting ID: ${item.event.zoom_meeting_id}`);
      console.log(`    `);
      console.log(`    Event start_date:  ${formatDate(item.eventStart)}`);
      console.log(`    Zoom start_time:   ${formatDate(item.zoomStart)}`);
      console.log(`    Start difference:  ${item.startDiffMinutes} minutes`);
      console.log(`    `);
      if (item.eventEnd) {
        console.log(`    Event end_date:    ${formatDate(item.eventEnd)}`);
        console.log(`    Zoom end (calc):   ${formatDate(item.zoomEnd)}`);
        console.log(`    End difference:    ${item.endDiffMinutes !== null ? item.endDiffMinutes + ' minutes' : 'N/A'}`);
      }
      console.log(`    Zoom timezone:     ${item.zm.timezone || 'not set'}`);
      console.log(`    Zoom duration:     ${item.zm.duration_minutes || 'not set'} minutes`);
      console.log();
    }
  }

  if (orphaned.length > 0) {
    console.log(`${'─'.repeat(70)}`);
    console.log(`ORPHANED EVENTS (${orphaned.length})`);
    console.log(`${'─'.repeat(70)}\n`);

    for (const item of orphaned) {
      console.log(`  [ORPHAN] ${item.event.title}`);
      console.log(`    Event ID: ${item.event.id}`);
      console.log(`    zoom_meeting_id: ${item.event.zoom_meeting_id}`);
      console.log(`    Reason: ${item.reason}`);
      console.log();
    }
  }

  console.log(`${'='.repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Total events with Zoom links: ${events.length}`);
  console.log(`  In sync:     ${inSync.length}`);
  console.log(`  Out of sync: ${outOfSync.length}`);
  console.log(`  Orphaned:    ${orphaned.length}`);
  console.log();

  if (outOfSync.length > 0) {
    console.log(`\nTo fix out-of-sync events, you can update them to match Zoom times.`);
    console.log(`Run with --fix flag to apply corrections (not yet implemented).`);
  }
}

const tenantId = process.argv[2] || null;
checkEventZoomSync(tenantId).catch(console.error);
