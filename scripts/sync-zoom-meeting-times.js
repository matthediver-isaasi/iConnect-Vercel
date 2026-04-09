#!/usr/bin/env node

/**
 * Sync Zoom Meeting Times Script
 * 
 * This script syncs meeting/webinar times from Zoom API to the local database.
 * It fetches meetings from ALL Zoom users in the account and updates both 
 * zoom_meeting/zoom_webinar and event tables.
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
import crypto from 'crypto';

const DEST_SUPABASE_URL = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

if (!supabaseKey) {
  console.error('Error: DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(DEST_SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false }
});

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) return null;
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

let cachedToken = null;
let tokenExpiresAt = 0;

async function getZoomAccessTokenForTenant(tenantId) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const { data: integration, error } = await supabase
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('integration_type', 'zoom')
    .single();

  if (error || !integration) {
    throw new Error(`No Zoom integration found for tenant ${tenantId}. Configure credentials in Admin > Integrations.`);
  }

  if (!integration.is_enabled) {
    throw new Error(`Zoom integration is disabled for tenant ${tenantId}. Enable it in Admin > Integrations.`);
  }

  const credentials = decryptCredentials(integration.credentials);

  if (!credentials.account_id || !credentials.client_id || !credentials.client_secret) {
    throw new Error(`Incomplete Zoom credentials for tenant ${tenantId}. Update credentials in Admin > Integrations.`);
  }

  const basicAuth = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64');

  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${credentials.account_id}`
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

async function fetchAllZoomUsers(token) {
  const response = await fetch('https://api.zoom.us/v2/users?status=active&page_size=100', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Zoom users: ${response.status}`);
  }

  const data = await response.json();
  return data.users || [];
}

async function fetchAllMeetingsForUser(token, userId) {
  const meetings = [];
  let nextPageToken = '';

  do {
    const url = `https://api.zoom.us/v2/users/${userId}/meetings?type=upcoming&page_size=100${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      console.log(`    Warning: Could not fetch meetings for user ${userId}: ${response.status}`);
      break;
    }

    const data = await response.json();
    meetings.push(...(data.meetings || []));
    nextPageToken = data.next_page_token || '';
  } while (nextPageToken);

  return meetings;
}

async function fetchAllWebinarsForUser(token, userId) {
  const webinars = [];
  let nextPageToken = '';

  do {
    const url = `https://api.zoom.us/v2/users/${userId}/webinars?page_size=100${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      if (response.status === 400) {
        break;
      }
      console.log(`    Warning: Could not fetch webinars for user ${userId}: ${response.status}`);
      break;
    }

    const data = await response.json();
    webinars.push(...(data.webinars || []));
    nextPageToken = data.next_page_token || '';
  } while (nextPageToken);

  return webinars;
}

async function fetchMeetingDetails(token, meetingId) {
  const response = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch meeting ${meetingId}: ${response.status}`);
  }

  return response.json();
}

async function fetchWebinarDetails(token, webinarId) {
  const response = await fetch(`https://api.zoom.us/v2/webinars/${webinarId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch webinar ${webinarId}: ${response.status}`);
  }

  return response.json();
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
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Zoom Meeting & Webinar Time Sync${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`${'='.repeat(70)}\n`);

  const results = {
    zoomMeetingsProcessed: 0,
    zoomMeetingsUpdated: 0,
    zoomWebinarsProcessed: 0,
    zoomWebinarsUpdated: 0,
    eventsProcessed: 0,
    eventsUpdated: 0,
    orphanedEvents: 0,
    errors: []
  };

  try {
    const token = await getZoomAccessTokenForTenant(tenantId);
    console.log('Got Zoom access token from tenant credentials\n');

    console.log('Fetching all Zoom users...');
    const zoomUsers = await fetchAllZoomUsers(token);
    console.log(`Found ${zoomUsers.length} Zoom users:\n`);
    for (const user of zoomUsers) {
      console.log(`  - ${user.email} (${user.id})`);
    }
    console.log();

    console.log('Building Zoom meeting/webinar index from all users...');
    const zoomMeetingsMap = new Map();
    const zoomWebinarsMap = new Map();

    for (const user of zoomUsers) {
      const meetings = await fetchAllMeetingsForUser(token, user.id);
      for (const m of meetings) {
        zoomMeetingsMap.set(String(m.id), m);
      }
      
      const webinars = await fetchAllWebinarsForUser(token, user.id);
      for (const w of webinars) {
        zoomWebinarsMap.set(String(w.id), w);
      }
    }

    console.log(`  Indexed ${zoomMeetingsMap.size} meetings and ${zoomWebinarsMap.size} webinars from Zoom\n`);

    console.log(`${'─'.repeat(70)}`);
    console.log('Processing zoom_meeting records...');
    console.log(`${'─'.repeat(70)}\n`);

    const { data: dbMeetings, error: meetingsError } = await supabase
      .from('zoom_meeting')
      .select('id, zoom_meeting_id, start_time, duration_minutes, timezone, topic')
      .eq('tenant_id', tenantId)
      .not('zoom_meeting_id', 'is', null)
      .neq('status', 'cancelled');

    if (meetingsError) {
      console.error('Error fetching zoom_meeting records:', meetingsError.message);
      return;
    }

    console.log(`Found ${dbMeetings?.length || 0} zoom_meeting records in database\n`);

    for (const meeting of (dbMeetings || [])) {
      results.zoomMeetingsProcessed++;

      let zoomData = zoomMeetingsMap.get(meeting.zoom_meeting_id);
      
      if (!zoomData) {
        zoomData = await fetchMeetingDetails(token, meeting.zoom_meeting_id);
      }

      if (!zoomData) {
        console.log(`  [SKIP] ${meeting.topic} - Not found in Zoom`);
        continue;
      }

      const zoomStartTime = zoomData.start_time;
      const zoomDuration = zoomData.duration;
      const zoomTimezone = zoomData.timezone;

      if (!zoomStartTime || zoomDuration === undefined) {
        console.log(`  [SKIP] ${meeting.topic} - Recurring/no-fixed-time meeting`);
        continue;
      }

      const dbStartTime = meeting.start_time ? new Date(meeting.start_time).toISOString() : null;
      const zoomStartTimeNormalized = new Date(zoomStartTime).toISOString();

      const startTimeChanged = dbStartTime !== zoomStartTimeNormalized;
      const durationChanged = meeting.duration_minutes !== zoomDuration;
      const timezoneChanged = meeting.timezone !== zoomTimezone;

      if (!startTimeChanged && !durationChanged && !timezoneChanged) {
        console.log(`  [OK] ${meeting.topic} - Already in sync`);
        continue;
      }

      const endTime = new Date(new Date(zoomStartTime).getTime() + (zoomDuration * 60 * 1000)).toISOString();

      console.log(`  [${dryRun ? 'WOULD UPDATE' : 'UPDATE'}] ${meeting.topic}`);
      if (startTimeChanged) console.log(`    start_time: ${dbStartTime} -> ${zoomStartTimeNormalized}`);
      if (durationChanged) console.log(`    duration: ${meeting.duration_minutes} -> ${zoomDuration} min`);
      if (timezoneChanged) console.log(`    timezone: ${meeting.timezone} -> ${zoomTimezone}`);

      const { data: linkedEvents } = await supabase
        .from('event')
        .select('id, title')
        .eq('tenant_id', tenantId)
        .eq('zoom_meeting_id', meeting.id);

      if (linkedEvents?.length > 0) {
        for (const event of linkedEvents) {
          console.log(`    -> ${dryRun ? 'Would update' : 'Updated'} event: ${event.title}`);
        }
      }

      if (!dryRun) {
        const { error: updateError } = await supabase
          .from('zoom_meeting')
          .update({
            start_time: zoomStartTimeNormalized,
            duration_minutes: zoomDuration,
            timezone: zoomTimezone,
            updated_at: new Date().toISOString()
          })
          .eq('id', meeting.id)
          .eq('tenant_id', tenantId);

        if (updateError) {
          results.errors.push({ type: 'zoom_meeting', id: meeting.id, error: updateError.message });
          continue;
        }

        results.zoomMeetingsUpdated++;

        for (const event of (linkedEvents || [])) {
          results.eventsProcessed++;
          const { error: eventError } = await supabase
            .from('event')
            .update({ start_date: zoomStartTimeNormalized, end_date: endTime, timezone: zoomTimezone })
            .eq('id', event.id);

          if (!eventError) {
            results.eventsUpdated++;
          }
        }
      }
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log('Processing zoom_webinar records...');
    console.log(`${'─'.repeat(70)}\n`);

    const { data: dbWebinars, error: webinarsError } = await supabase
      .from('zoom_webinar')
      .select('id, zoom_webinar_id, start_time, duration_minutes, timezone, topic')
      .eq('tenant_id', tenantId)
      .not('zoom_webinar_id', 'is', null);

    if (webinarsError) {
      console.error('Error fetching zoom_webinar records:', webinarsError.message);
    } else {
      console.log(`Found ${dbWebinars?.length || 0} zoom_webinar records in database\n`);

      for (const webinar of (dbWebinars || [])) {
        results.zoomWebinarsProcessed++;

        let zoomData = zoomWebinarsMap.get(webinar.zoom_webinar_id);
        
        if (!zoomData) {
          zoomData = await fetchWebinarDetails(token, webinar.zoom_webinar_id);
        }

        if (!zoomData) {
          console.log(`  [SKIP] ${webinar.topic} - Not found in Zoom`);
          continue;
        }

        const zoomStartTime = zoomData.start_time;
        const zoomDuration = zoomData.duration;
        const zoomTimezone = zoomData.timezone;

        if (!zoomStartTime || zoomDuration === undefined) {
          console.log(`  [SKIP] ${webinar.topic} - Recurring/no-fixed-time webinar`);
          continue;
        }

        const dbStartTime = webinar.start_time ? new Date(webinar.start_time).toISOString() : null;
        const zoomStartTimeNormalized = new Date(zoomStartTime).toISOString();

        const startTimeChanged = dbStartTime !== zoomStartTimeNormalized;
        const durationChanged = webinar.duration_minutes !== zoomDuration;
        const timezoneChanged = webinar.timezone !== zoomTimezone;

        if (!startTimeChanged && !durationChanged && !timezoneChanged) {
          console.log(`  [OK] ${webinar.topic} - Already in sync`);
          continue;
        }

        const endTime = new Date(new Date(zoomStartTime).getTime() + (zoomDuration * 60 * 1000)).toISOString();

        console.log(`  [${dryRun ? 'WOULD UPDATE' : 'UPDATE'}] ${webinar.topic}`);
        if (startTimeChanged) console.log(`    start_time: ${dbStartTime} -> ${zoomStartTimeNormalized}`);
        if (durationChanged) console.log(`    duration: ${webinar.duration_minutes} -> ${zoomDuration} min`);
        if (timezoneChanged) console.log(`    timezone: ${webinar.timezone} -> ${zoomTimezone}`);

        const { data: linkedEvents } = await supabase
          .from('event')
          .select('id, title')
          .eq('tenant_id', tenantId)
          .eq('zoom_webinar_id', webinar.id);

        if (linkedEvents?.length > 0) {
          for (const event of linkedEvents) {
            console.log(`    -> ${dryRun ? 'Would update' : 'Updated'} event: ${event.title}`);
          }
        }

        if (!dryRun) {
          const { error: updateError } = await supabase
            .from('zoom_webinar')
            .update({
              start_time: zoomStartTimeNormalized,
              duration_minutes: zoomDuration,
              timezone: zoomTimezone,
              updated_at: new Date().toISOString()
            })
            .eq('id', webinar.id)
            .eq('tenant_id', tenantId);

          if (updateError) {
            results.errors.push({ type: 'zoom_webinar', id: webinar.id, error: updateError.message });
            continue;
          }

          results.zoomWebinarsUpdated++;

          for (const event of (linkedEvents || [])) {
            results.eventsProcessed++;
            const { error: eventError } = await supabase
              .from('event')
              .update({ start_date: zoomStartTimeNormalized, end_date: endTime, timezone: zoomTimezone })
              .eq('id', event.id);

            if (!eventError) {
              results.eventsUpdated++;
            }
          }
        }
      }
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log('Checking for orphaned events...');
    console.log(`${'─'.repeat(70)}\n`);

    const dbMeetingMap = new Map((dbMeetings || []).map(m => [m.id, m]));
    const dbWebinarMap = new Map((dbWebinars || []).map(w => [w.id, w]));

    const { data: allEventsWithZoom } = await supabase
      .from('event')
      .select('id, title, zoom_meeting_id, zoom_webinar_id')
      .eq('tenant_id', tenantId)
      .or('zoom_meeting_id.not.is.null,zoom_webinar_id.not.is.null');

    for (const event of (allEventsWithZoom || [])) {
      if (event.zoom_meeting_id) {
        const dbMeeting = dbMeetingMap.get(event.zoom_meeting_id);
        if (!dbMeeting) {
          results.orphanedEvents++;
          console.log(`  [ORPHAN] ${event.title} - zoom_meeting record not in DB`);
        } else if (dbMeeting.zoom_meeting_id && !zoomMeetingsMap.has(dbMeeting.zoom_meeting_id)) {
          const exists = await fetchMeetingDetails(token, dbMeeting.zoom_meeting_id);
          if (!exists) {
            results.orphanedEvents++;
            console.log(`  [ORPHAN] ${event.title} - Zoom meeting deleted from Zoom`);
          }
        }
      }
      if (event.zoom_webinar_id) {
        const dbWebinar = dbWebinarMap.get(event.zoom_webinar_id);
        if (!dbWebinar) {
          results.orphanedEvents++;
          console.log(`  [ORPHAN] ${event.title} - zoom_webinar record not in DB`);
        } else if (dbWebinar.zoom_webinar_id && !zoomWebinarsMap.has(dbWebinar.zoom_webinar_id)) {
          const exists = await fetchWebinarDetails(token, dbWebinar.zoom_webinar_id);
          if (!exists) {
            results.orphanedEvents++;
            console.log(`  [ORPHAN] ${event.title} - Zoom webinar deleted from Zoom`);
          }
        }
      }
    }

    if (results.orphanedEvents === 0) {
      console.log('  No orphaned events found.');
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(70)}`);
    console.log(`Zoom meetings processed: ${results.zoomMeetingsProcessed}`);
    console.log(`Zoom meetings updated: ${dryRun ? '0 (dry run)' : results.zoomMeetingsUpdated}`);
    console.log(`Zoom webinars processed: ${results.zoomWebinarsProcessed}`);
    console.log(`Zoom webinars updated: ${dryRun ? '0 (dry run)' : results.zoomWebinarsUpdated}`);
    console.log(`Events processed: ${dryRun ? '0 (dry run)' : results.eventsProcessed}`);
    console.log(`Events updated: ${dryRun ? '0 (dry run)' : results.eventsUpdated}`);
    console.log(`Orphaned events: ${results.orphanedEvents}`);
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
