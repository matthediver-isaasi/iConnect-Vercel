import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { dryRun = false } = req.body || {};

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
    const token = await getZoomAccessToken(req);

    // Step 1: Process all zoom_meeting records
    const { data: zoomMeetings, error: meetingsError } = await supabase
      .from('zoom_meeting')
      .select('id, zoom_meeting_id, start_time, duration_minutes, timezone, topic')
      .eq('tenant_id', tenantId)
      .not('zoom_meeting_id', 'is', null)
      .neq('status', 'cancelled');

    if (meetingsError) {
      console.error('[ZoomSync] Error fetching zoom_meeting records:', meetingsError);
      return res.status(500).json({ error: 'Failed to fetch zoom meetings from database' });
    }

    console.log(`[ZoomSync] Found ${zoomMeetings?.length || 0} zoom meetings to sync for tenant ${tenantId}`);

    // Build a set of zoom_meeting_ids we've processed
    const processedZoomMeetingIds = new Set();

    for (const meeting of (zoomMeetings || [])) {
      results.zoomMeetingsProcessed++;
      processedZoomMeetingIds.add(meeting.zoom_meeting_id);
      
      try {
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );

        if (!zoomResponse.ok) {
          if (zoomResponse.status === 404) {
            results.details.push({
              type: 'zoom_meeting',
              meetingId: meeting.id,
              zoomMeetingId: meeting.zoom_meeting_id,
              topic: meeting.topic,
              status: 'not_found_in_zoom',
              message: 'Meeting no longer exists in Zoom'
            });
            continue;
          }
          const errorText = await zoomResponse.text();
          results.errors.push({
            type: 'zoom_meeting',
            meetingId: meeting.id,
            zoomMeetingId: meeting.zoom_meeting_id,
            error: `Zoom API error: ${zoomResponse.status} - ${errorText}`
          });
          continue;
        }

        const zoomData = await zoomResponse.json();
        
        const zoomStartTime = zoomData.start_time;
        const zoomDuration = zoomData.duration;
        const zoomTimezone = zoomData.timezone;

        // Guard for recurring meetings without fixed start time
        if (!zoomStartTime || zoomDuration === undefined || zoomDuration === null) {
          results.details.push({
            type: 'zoom_meeting',
            meetingId: meeting.id,
            zoomMeetingId: meeting.zoom_meeting_id,
            topic: meeting.topic,
            status: 'skipped',
            message: 'Recurring or no-fixed-time meeting - cannot sync times',
            zoomType: zoomData.type
          });
          continue;
        }

        const dbStartTime = meeting.start_time ? new Date(meeting.start_time).toISOString() : null;
        const zoomStartTimeNormalized = new Date(zoomStartTime).toISOString();
        
        const startTimeChanged = dbStartTime !== zoomStartTimeNormalized;
        const durationChanged = meeting.duration_minutes !== zoomDuration;
        const timezoneChanged = meeting.timezone !== zoomTimezone;

        if (!startTimeChanged && !durationChanged && !timezoneChanged) {
          results.details.push({
            type: 'zoom_meeting',
            meetingId: meeting.id,
            zoomMeetingId: meeting.zoom_meeting_id,
            topic: meeting.topic,
            status: 'no_changes',
            message: 'Already in sync'
          });
          continue;
        }

        const endTime = new Date(new Date(zoomStartTime).getTime() + (zoomDuration * 60 * 1000)).toISOString();

        const detail = {
          type: 'zoom_meeting',
          meetingId: meeting.id,
          zoomMeetingId: meeting.zoom_meeting_id,
          topic: meeting.topic,
          status: dryRun ? 'would_update' : 'updated',
          changes: {
            start_time: startTimeChanged ? { from: dbStartTime, to: zoomStartTimeNormalized } : null,
            duration_minutes: durationChanged ? { from: meeting.duration_minutes, to: zoomDuration } : null,
            timezone: timezoneChanged ? { from: meeting.timezone, to: zoomTimezone } : null
          },
          calculated_end_time: endTime
        };

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
            results.errors.push({
              type: 'zoom_meeting',
              meetingId: meeting.id,
              error: `Failed to update zoom_meeting: ${updateMeetingError.message}`
            });
            continue;
          }

          results.zoomMeetingsUpdated++;

          // Update linked events
          const { data: linkedEvents, error: eventsError } = await supabase
            .from('event')
            .select('id, title, start_date, end_date')
            .eq('tenant_id', tenantId)
            .eq('zoom_meeting_id', meeting.zoom_meeting_id);

          if (eventsError) {
            console.error('[ZoomSync] Error fetching linked events:', eventsError);
          } else if (linkedEvents && linkedEvents.length > 0) {
            detail.updatedEvents = [];
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
                results.errors.push({
                  type: 'event',
                  meetingId: meeting.id,
                  eventId: event.id,
                  error: `Failed to update event: ${updateEventError.message}`
                });
              } else {
                results.eventsUpdated++;
                detail.updatedEvents.push({
                  eventId: event.id,
                  title: event.title,
                  previousStartDate: event.start_date,
                  previousEndDate: event.end_date,
                  newStartDate: zoomStartTimeNormalized,
                  newEndDate: endTime
                });
              }
            }
          }
        } else {
          // Dry run - still report what would happen
          const { data: linkedEvents } = await supabase
            .from('event')
            .select('id, title, start_date, end_date')
            .eq('tenant_id', tenantId)
            .eq('zoom_meeting_id', meeting.zoom_meeting_id);

          if (linkedEvents && linkedEvents.length > 0) {
            detail.wouldUpdateEvents = linkedEvents.map(event => ({
              eventId: event.id,
              title: event.title,
              currentStartDate: event.start_date,
              currentEndDate: event.end_date,
              wouldBeStartDate: zoomStartTimeNormalized,
              wouldBeEndDate: endTime
            }));
          }
        }

        results.details.push(detail);

      } catch (error) {
        console.error(`[ZoomSync] Error processing meeting ${meeting.id}:`, error);
        results.errors.push({
          type: 'zoom_meeting',
          meetingId: meeting.id,
          zoomMeetingId: meeting.zoom_meeting_id,
          error: error.message || 'Unknown error'
        });
      }
    }

    // Step 2: Check for orphaned events (events with zoom_meeting_id that have no matching zoom_meeting record)
    const { data: allEventsWithZoom, error: eventsWithZoomError } = await supabase
      .from('event')
      .select('id, title, zoom_meeting_id, start_date, end_date')
      .eq('tenant_id', tenantId)
      .not('zoom_meeting_id', 'is', null);

    if (eventsWithZoomError) {
      console.error('[ZoomSync] Error fetching events with zoom_meeting_id:', eventsWithZoomError);
    } else if (allEventsWithZoom) {
      for (const event of allEventsWithZoom) {
        // Skip if we already processed this zoom_meeting_id
        if (processedZoomMeetingIds.has(event.zoom_meeting_id)) {
          continue;
        }

        results.orphanedEvents++;

        // Try to fetch from Zoom API directly
        try {
          const zoomResponse = await fetch(
            `https://api.zoom.us/v2/meetings/${event.zoom_meeting_id}`,
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`
              }
            }
          );

          if (!zoomResponse.ok) {
            results.details.push({
              type: 'orphaned_event',
              eventId: event.id,
              eventTitle: event.title,
              zoomMeetingId: event.zoom_meeting_id,
              status: 'orphaned_zoom_not_found',
              message: 'Event has zoom_meeting_id but no local zoom_meeting record, and meeting not found in Zoom'
            });
            continue;
          }

          const zoomData = await zoomResponse.json();

          // Guard for recurring meetings
          if (!zoomData.start_time || zoomData.duration === undefined) {
            results.details.push({
              type: 'orphaned_event',
              eventId: event.id,
              eventTitle: event.title,
              zoomMeetingId: event.zoom_meeting_id,
              status: 'orphaned_no_fixed_time',
              message: 'Orphaned event links to recurring/no-fixed-time meeting'
            });
            continue;
          }

          const zoomStartTimeNormalized = new Date(zoomData.start_time).toISOString();
          const endTime = new Date(new Date(zoomData.start_time).getTime() + (zoomData.duration * 60 * 1000)).toISOString();

          const detail = {
            type: 'orphaned_event',
            eventId: event.id,
            eventTitle: event.title,
            zoomMeetingId: event.zoom_meeting_id,
            status: dryRun ? 'would_update' : 'updated',
            changes: {
              start_date: { from: event.start_date, to: zoomStartTimeNormalized },
              end_date: { from: event.end_date, to: endTime }
            },
            zoomTopic: zoomData.topic,
            message: 'Event has zoom_meeting_id but no local zoom_meeting record - synced directly from Zoom'
          };

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

            if (updateEventError) {
              results.errors.push({
                type: 'orphaned_event',
                eventId: event.id,
                error: `Failed to update orphaned event: ${updateEventError.message}`
              });
              continue;
            }
            results.eventsUpdated++;
          }

          results.details.push(detail);

        } catch (error) {
          results.errors.push({
            type: 'orphaned_event',
            eventId: event.id,
            zoomMeetingId: event.zoom_meeting_id,
            error: error.message || 'Failed to fetch from Zoom API'
          });
        }
      }
    }

    console.log(`[ZoomSync] Sync complete. Zoom meetings: ${results.zoomMeetingsProcessed} processed, ${results.zoomMeetingsUpdated} updated. Events: ${results.eventsProcessed} processed, ${results.eventsUpdated} updated. Orphaned: ${results.orphanedEvents}. Errors: ${results.errors.length}`);

    return res.json({
      success: true,
      dryRun,
      summary: {
        zoomMeetingsProcessed: results.zoomMeetingsProcessed,
        zoomMeetingsUpdated: dryRun ? 0 : results.zoomMeetingsUpdated,
        eventsProcessed: dryRun ? 0 : results.eventsProcessed,
        eventsUpdated: dryRun ? 0 : results.eventsUpdated,
        orphanedEventsFound: results.orphanedEvents,
        errors: results.errors.length,
        noChanges: results.details.filter(d => d.status === 'no_changes').length,
        notFoundInZoom: results.details.filter(d => d.status === 'not_found_in_zoom').length,
        skippedRecurring: results.details.filter(d => d.status === 'skipped').length
      },
      details: results.details,
      errors: results.errors
    });

  } catch (error) {
    console.error('[ZoomSync] Sync failed:', error);
    return res.status(500).json({ 
      error: error.message || 'Sync failed',
      partialResults: results
    });
  }
}
