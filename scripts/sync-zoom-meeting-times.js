#!/usr/bin/env node

/**
 * Sync Zoom Meeting Times Script
 * 
 * This script syncs meeting times from Zoom API to the local database.
 * It updates both zoom_meeting and event tables.
 * 
 * Usage:
 *   node scripts/sync-zoom-meeting-times.js <tenant_id> [--dry-run]
 * 
 * Examples:
 *   node scripts/sync-zoom-meeting-times.js abc123-def456 --dry-run   # Preview changes
 *   node scripts/sync-zoom-meeting-times.js abc123-def456             # Apply changes
 *   node scripts/sync-zoom-meeting-times.js --list-tenants            # List all tenants
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

async function getZoomAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials not configured (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${accountId}`
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get Zoom access token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  return cachedToken;
}

async function listTenants() {
  const { data: tenants, error } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .order('name');

  if (error) {
    console.error('Error fetching tenants:', error.message);
    return;
  }

  console.log('\nAvailable tenants:\n');
  console.log('ID'.padEnd(40) + 'Name'.padEnd(30) + 'Slug');
  console.log('-'.repeat(90));
  for (const tenant of tenants || []) {
    console.log(`${tenant.id.padEnd(40)}${(tenant.name || '').padEnd(30)}${tenant.slug || ''}`);
  }
  console.log('\nUsage: node scripts/sync-zoom-meeting-times.js <tenant_id> [--dry-run]');
}

async function syncZoomMeetingTimes(tenantId, dryRun = false) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Zoom Meeting Time Sync${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = {
    zoomMeetingsProcessed: 0,
    zoomMeetingsUpdated: 0,
    eventsProcessed: 0,
    eventsUpdated: 0,
    orphanedEvents: 0,
    errors: [],
    details: []
  };

  try {
    const token = await getZoomAccessToken();
    console.log('Got Zoom access token\n');

    // Step 1: Process all zoom_meeting records
    const { data: zoomMeetings, error: meetingsError } = await supabase
      .from('zoom_meeting')
      .select('id, zoom_meeting_id, start_time, duration_minutes, timezone, topic')
      .eq('tenant_id', tenantId)
      .not('zoom_meeting_id', 'is', null)
      .neq('status', 'cancelled');

    if (meetingsError) {
      console.error('Error fetching zoom_meeting records:', meetingsError.message);
      return;
    }

    console.log(`Found ${zoomMeetings?.length || 0} zoom meetings to sync\n`);

    const processedZoomMeetingIds = new Set();

    for (const meeting of (zoomMeetings || [])) {
      results.zoomMeetingsProcessed++;
      processedZoomMeetingIds.add(meeting.zoom_meeting_id);

      try {
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}`,
          {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          }
        );

        if (!zoomResponse.ok) {
          if (zoomResponse.status === 404) {
            console.log(`  [SKIP] ${meeting.topic} - Meeting not found in Zoom`);
            results.details.push({
              type: 'zoom_meeting',
              topic: meeting.topic,
              status: 'not_found_in_zoom'
            });
            continue;
          }
          const errorText = await zoomResponse.text();
          results.errors.push({ meetingId: meeting.id, error: `Zoom API: ${zoomResponse.status}` });
          continue;
        }

        const zoomData = await zoomResponse.json();

        const zoomStartTime = zoomData.start_time;
        const zoomDuration = zoomData.duration;
        const zoomTimezone = zoomData.timezone;

        if (!zoomStartTime || zoomDuration === undefined) {
          console.log(`  [SKIP] ${meeting.topic} - Recurring/no-fixed-time meeting`);
          results.details.push({
            type: 'zoom_meeting',
            topic: meeting.topic,
            status: 'skipped_recurring'
          });
          continue;
        }

        const dbStartTime = meeting.start_time ? new Date(meeting.start_time).toISOString() : null;
        const zoomStartTimeNormalized = new Date(zoomStartTime).toISOString();

        const startTimeChanged = dbStartTime !== zoomStartTimeNormalized;
        const durationChanged = meeting.duration_minutes !== zoomDuration;
        const timezoneChanged = meeting.timezone !== zoomTimezone;

        if (!startTimeChanged && !durationChanged && !timezoneChanged) {
          console.log(`  [OK] ${meeting.topic} - Already in sync`);
          results.details.push({
            type: 'zoom_meeting',
            topic: meeting.topic,
            status: 'no_changes'
          });
          continue;
        }

        const endTime = new Date(new Date(zoomStartTime).getTime() + (zoomDuration * 60 * 1000)).toISOString();

        console.log(`  [${dryRun ? 'WOULD UPDATE' : 'UPDATE'}] ${meeting.topic}`);
        if (startTimeChanged) {
          console.log(`    start_time: ${dbStartTime} -> ${zoomStartTimeNormalized}`);
        }
        if (durationChanged) {
          console.log(`    duration: ${meeting.duration_minutes} -> ${zoomDuration} minutes`);
        }
        if (timezoneChanged) {
          console.log(`    timezone: ${meeting.timezone} -> ${zoomTimezone}`);
        }

        if (!dryRun) {
          const { error: updateMeetingError } = await supabase
            .from('zoom_meeting')
            .update({
              start_time: zoomStartTimeNormalized,
              duration_minutes: zoomDuration,
              timezone: zoomTimezone,
              updated_at: new Date().toISOString()
            })
            .eq('id', meeting.id)
            .eq('tenant_id', tenantId);

          if (updateMeetingError) {
            results.errors.push({ meetingId: meeting.id, error: updateMeetingError.message });
            continue;
          }

          results.zoomMeetingsUpdated++;

          // Update linked events
          const { data: linkedEvents, error: eventsError } = await supabase
            .from('event')
            .select('id, title, start_date, end_date')
            .eq('tenant_id', tenantId)
            .eq('zoom_meeting_id', meeting.zoom_meeting_id);

          if (!eventsError && linkedEvents?.length > 0) {
            for (const event of linkedEvents) {
              results.eventsProcessed++;
              const { error: updateEventError } = await supabase
                .from('event')
                .update({
                  start_date: zoomStartTimeNormalized,
                  end_date: endTime,
                  updated_at: new Date().toISOString()
                })
                .eq('id', event.id)
                .eq('tenant_id', tenantId);

              if (updateEventError) {
                results.errors.push({ eventId: event.id, error: updateEventError.message });
              } else {
                results.eventsUpdated++;
                console.log(`    -> Updated event: ${event.title}`);
              }
            }
          }
        }

        results.details.push({
          type: 'zoom_meeting',
          topic: meeting.topic,
          status: dryRun ? 'would_update' : 'updated'
        });

      } catch (error) {
        console.error(`  [ERROR] ${meeting.topic}: ${error.message}`);
        results.errors.push({ meetingId: meeting.id, error: error.message });
      }
    }

    // Step 2: Check for orphaned events
    console.log('\nChecking for orphaned events...');
    
    const { data: allEventsWithZoom, error: eventsWithZoomError } = await supabase
      .from('event')
      .select('id, title, zoom_meeting_id, start_date, end_date')
      .eq('tenant_id', tenantId)
      .not('zoom_meeting_id', 'is', null);

    if (!eventsWithZoomError && allEventsWithZoom) {
      for (const event of allEventsWithZoom) {
        if (processedZoomMeetingIds.has(event.zoom_meeting_id)) {
          continue;
        }

        results.orphanedEvents++;

        try {
          const zoomResponse = await fetch(
            `https://api.zoom.us/v2/meetings/${event.zoom_meeting_id}`,
            {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${token}` }
            }
          );

          if (!zoomResponse.ok) {
            console.log(`  [ORPHAN] ${event.title} - Zoom meeting ${event.zoom_meeting_id} not found`);
            continue;
          }

          const zoomData = await zoomResponse.json();

          if (!zoomData.start_time || zoomData.duration === undefined) {
            console.log(`  [ORPHAN] ${event.title} - Recurring meeting, cannot sync`);
            continue;
          }

          const zoomStartTimeNormalized = new Date(zoomData.start_time).toISOString();
          const endTime = new Date(new Date(zoomData.start_time).getTime() + (zoomData.duration * 60 * 1000)).toISOString();

          console.log(`  [${dryRun ? 'WOULD UPDATE ORPHAN' : 'UPDATE ORPHAN'}] ${event.title}`);
          console.log(`    start_date: ${event.start_date} -> ${zoomStartTimeNormalized}`);
          console.log(`    end_date: ${event.end_date} -> ${endTime}`);

          if (!dryRun) {
            results.eventsProcessed++;
            const { error: updateEventError } = await supabase
              .from('event')
              .update({
                start_date: zoomStartTimeNormalized,
                end_date: endTime,
                updated_at: new Date().toISOString()
              })
              .eq('id', event.id)
              .eq('tenant_id', tenantId);

            if (!updateEventError) {
              results.eventsUpdated++;
            }
          }

        } catch (error) {
          results.errors.push({ eventId: event.id, error: error.message });
        }
      }
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`Zoom meetings processed: ${results.zoomMeetingsProcessed}`);
    console.log(`Zoom meetings updated: ${dryRun ? '0 (dry run)' : results.zoomMeetingsUpdated}`);
    console.log(`Events processed: ${dryRun ? '0 (dry run)' : results.eventsProcessed}`);
    console.log(`Events updated: ${dryRun ? '0 (dry run)' : results.eventsUpdated}`);
    console.log(`Orphaned events found: ${results.orphanedEvents}`);
    console.log(`Errors: ${results.errors.length}`);
    
    if (results.errors.length > 0) {
      console.log('\nErrors:');
      for (const err of results.errors) {
        console.log(`  - ${JSON.stringify(err)}`);
      }
    }

    if (dryRun) {
      console.log('\n** This was a dry run. Run without --dry-run to apply changes. **');
    }

  } catch (error) {
    console.error('\nFatal error:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--list-tenants')) {
  listTenants();
} else if (args.length === 0) {
  console.log('Usage: node scripts/sync-zoom-meeting-times.js <tenant_id> [--dry-run]');
  console.log('       node scripts/sync-zoom-meeting-times.js --list-tenants');
  process.exit(1);
} else {
  const tenantId = args.find(arg => !arg.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  
  if (!tenantId) {
    console.error('Error: tenant_id is required');
    process.exit(1);
  }
  
  syncZoomMeetingTimes(tenantId, dryRun);
}
