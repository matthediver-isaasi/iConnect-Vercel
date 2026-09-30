/**
 * Fix script to align event.start_date/end_date with zoom_meeting times
 * Zoom is the source of truth - this updates events to match.
 * 
 * Usage:
 *   node scripts/fix-event-zoom-time-sync.js <tenant-id> --dry-run   # Preview changes
 *   node scripts/fix-event-zoom-time-sync.js <tenant-id>             # Apply changes
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

async function fixEventZoomSync(tenantId, dryRun = false) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Fix Event <-> Zoom Meeting Time Sync${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`${'='.repeat(70)}\n`);

  const { data: events, error: eventError } = await supabase
    .from('event')
    .select('id, title, start_date, end_date, tenant_id, zoom_meeting_id')
    .eq('tenant_id', tenantId)
    .not('zoom_meeting_id', 'is', null);

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

  let fixedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const event of events) {
    const zm = zoomMeetingMap.get(event.zoom_meeting_id);

    if (!zm) {
      console.log(`  [SKIP] ${event.title} - Zoom meeting not found in database`);
      skippedCount++;
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
      console.log(`  [OK] ${event.title} - Already in sync`);
      continue;
    }

    console.log(`  [FIX] ${event.title}`);
    console.log(`         Event start:  ${formatDate(eventStart)} -> ${formatDate(zoomStart)}`);
    if (eventEnd && zoomEnd) {
      console.log(`         Event end:    ${formatDate(eventEnd)} -> ${formatDate(zoomEnd)}`);
    }
    console.log(`         Difference:   ${startDiffMinutes} minutes`);

    if (!dryRun) {
      const updateData = {
        start_date: zoomStart.toISOString()
      };
      
      if (zoomEnd) {
        updateData.end_date = zoomEnd.toISOString();
      }

      const { error: updateError } = await supabase
        .from('event')
        .update(updateData)
        .eq('id', event.id);

      if (updateError) {
        console.log(`         [ERROR] Failed to update: ${updateError.message}`);
        errorCount++;
      } else {
        console.log(`         [UPDATED]`);
        fixedCount++;
      }
    } else {
      console.log(`         (would update)`);
      fixedCount++;
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Events processed: ${events.length}`);
  console.log(`  Fixed:   ${fixedCount}${dryRun ? ' (dry run)' : ''}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Errors:  ${errorCount}`);
  
  if (dryRun && fixedCount > 0) {
    console.log(`\n** This was a dry run. Run without --dry-run to apply changes. **`);
  }
}

const args = process.argv.slice(2);
const tenantId = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!tenantId) {
  console.error('Usage: node scripts/fix-event-zoom-time-sync.js <tenant-id> [--dry-run]');
  process.exit(1);
}

fixEventZoomSync(tenantId, dryRun).catch(console.error);
