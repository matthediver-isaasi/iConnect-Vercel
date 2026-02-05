#!/usr/bin/env node

/**
 * Backfill tenant_id for zoom_meeting and zoom_webinar tables
 * 
 * This script populates the tenant_id column by deriving it from linked events.
 * 
 * Usage:
 *   node scripts/backfill-zoom-tenant-id.js [--dry-run]
 * 
 * Examples:
 *   node scripts/backfill-zoom-tenant-id.js --dry-run   # Preview changes
 *   node scripts/backfill-zoom-tenant-id.js             # Apply changes
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required');
  process.exit(1);
}

// Using service_role key bypasses RLS policies
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
});

async function backfillZoomTenantId(dryRun = false) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backfill Zoom Tables tenant_id${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = {
    zoomMeetings: { total: 0, needsUpdate: 0, updated: 0, noLinkedEvent: 0 },
    zoomWebinars: { total: 0, needsUpdate: 0, updated: 0, noLinkedEvent: 0 },
    errors: []
  };

  try {
    // ============================================
    // STEP 1: Backfill zoom_meeting table
    // ============================================
    console.log('Processing zoom_meeting table...\n');

    const { data: zoomMeetings, error: meetingsError } = await supabase
      .from('zoom_meeting')
      .select('id, zoom_meeting_id, topic, tenant_id');

    if (meetingsError) {
      console.error('Error fetching zoom_meeting records:', meetingsError.message);
      results.errors.push({ table: 'zoom_meeting', error: meetingsError.message });
    } else {
      results.zoomMeetings.total = zoomMeetings?.length || 0;
      console.log(`Found ${results.zoomMeetings.total} zoom_meeting records`);

      for (const meeting of (zoomMeetings || [])) {
        // Skip if already has tenant_id
        if (meeting.tenant_id) {
          continue;
        }

        results.zoomMeetings.needsUpdate++;

        // Find linked events to get tenant_id
        const { data: linkedEvents, error: eventError } = await supabase
          .from('event')
          .select('tenant_id')
          .eq('zoom_meeting_id', meeting.zoom_meeting_id);

        if (eventError) {
          results.errors.push({ 
            table: 'zoom_meeting', 
            id: meeting.id, 
            error: eventError.message 
          });
          continue;
        }

        if (!linkedEvents || linkedEvents.length === 0) {
          console.log(`  [NO LINKED EVENT] ${meeting.topic || meeting.id} (zoom_meeting_id: ${meeting.zoom_meeting_id})`);
          results.zoomMeetings.noLinkedEvent++;
          continue;
        }

        // Check for conflicting tenant_ids
        const uniqueTenantIds = [...new Set(linkedEvents.map(e => e.tenant_id).filter(Boolean))];
        if (uniqueTenantIds.length > 1) {
          console.log(`  [CONFLICT] ${meeting.topic || meeting.id} - Multiple tenants: ${uniqueTenantIds.join(', ')}`);
          results.errors.push({
            table: 'zoom_meeting',
            id: meeting.id,
            error: `Multiple tenant_ids found: ${uniqueTenantIds.join(', ')}`
          });
          continue;
        }

        const tenantId = uniqueTenantIds[0];

        console.log(`  [${dryRun ? 'WOULD UPDATE' : 'UPDATE'}] ${meeting.topic || meeting.id}`);
        console.log(`    tenant_id: NULL -> ${tenantId}`);

        if (!dryRun) {
          const { error: updateError } = await supabase
            .from('zoom_meeting')
            .update({ tenant_id: tenantId })
            .eq('id', meeting.id);

          if (updateError) {
            results.errors.push({ 
              table: 'zoom_meeting', 
              id: meeting.id, 
              error: updateError.message 
            });
          } else {
            results.zoomMeetings.updated++;
          }
        }
      }
    }

    // ============================================
    // STEP 2: Backfill zoom_webinar table
    // ============================================
    console.log('\nProcessing zoom_webinar table...\n');

    const { data: zoomWebinars, error: webinarsError } = await supabase
      .from('zoom_webinar')
      .select('id, zoom_webinar_id, topic, tenant_id');

    if (webinarsError) {
      console.error('Error fetching zoom_webinar records:', webinarsError.message);
      results.errors.push({ table: 'zoom_webinar', error: webinarsError.message });
    } else {
      results.zoomWebinars.total = zoomWebinars?.length || 0;
      console.log(`Found ${results.zoomWebinars.total} zoom_webinar records`);

      for (const webinar of (zoomWebinars || [])) {
        // Skip if already has tenant_id
        if (webinar.tenant_id) {
          continue;
        }

        results.zoomWebinars.needsUpdate++;

        // Find linked events to get tenant_id (webinars might use zoom_webinar_id column)
        const { data: linkedEvents, error: eventError } = await supabase
          .from('event')
          .select('tenant_id')
          .eq('zoom_webinar_id', webinar.zoom_webinar_id);

        if (eventError) {
          results.errors.push({ 
            table: 'zoom_webinar', 
            id: webinar.id, 
            error: eventError.message 
          });
          continue;
        }

        if (!linkedEvents || linkedEvents.length === 0) {
          console.log(`  [NO LINKED EVENT] ${webinar.topic || webinar.id} (zoom_webinar_id: ${webinar.zoom_webinar_id})`);
          results.zoomWebinars.noLinkedEvent++;
          continue;
        }

        // Check for conflicting tenant_ids
        const uniqueTenantIds = [...new Set(linkedEvents.map(e => e.tenant_id).filter(Boolean))];
        if (uniqueTenantIds.length > 1) {
          console.log(`  [CONFLICT] ${webinar.topic || webinar.id} - Multiple tenants: ${uniqueTenantIds.join(', ')}`);
          results.errors.push({
            table: 'zoom_webinar',
            id: webinar.id,
            error: `Multiple tenant_ids found: ${uniqueTenantIds.join(', ')}`
          });
          continue;
        }

        const tenantId = uniqueTenantIds[0];

        console.log(`  [${dryRun ? 'WOULD UPDATE' : 'UPDATE'}] ${webinar.topic || webinar.id}`);
        console.log(`    tenant_id: NULL -> ${tenantId}`);

        if (!dryRun) {
          const { error: updateError } = await supabase
            .from('zoom_webinar')
            .update({ tenant_id: tenantId })
            .eq('id', webinar.id);

          if (updateError) {
            results.errors.push({ 
              table: 'zoom_webinar', 
              id: webinar.id, 
              error: updateError.message 
            });
          } else {
            results.zoomWebinars.updated++;
          }
        }
      }
    }

    // ============================================
    // SUMMARY
    // ============================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    
    console.log('\nzoom_meeting table:');
    console.log(`  Total records: ${results.zoomMeetings.total}`);
    console.log(`  Needed update: ${results.zoomMeetings.needsUpdate}`);
    console.log(`  Updated: ${dryRun ? '0 (dry run)' : results.zoomMeetings.updated}`);
    console.log(`  No linked event: ${results.zoomMeetings.noLinkedEvent}`);

    console.log('\nzoom_webinar table:');
    console.log(`  Total records: ${results.zoomWebinars.total}`);
    console.log(`  Needed update: ${results.zoomWebinars.needsUpdate}`);
    console.log(`  Updated: ${dryRun ? '0 (dry run)' : results.zoomWebinars.updated}`);
    console.log(`  No linked event: ${results.zoomWebinars.noLinkedEvent}`);

    if (results.errors.length > 0) {
      console.log(`\nErrors: ${results.errors.length}`);
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
const dryRun = args.includes('--dry-run');

backfillZoomTenantId(dryRun);
