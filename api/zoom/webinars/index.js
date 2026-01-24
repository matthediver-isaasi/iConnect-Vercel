import { supabase } from '../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.method === 'GET') {
    try {
      const { status, upcoming } = req.query;
      
      let query = supabase
        .from('zoom_webinar')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('start_time', { ascending: true });
      
      if (status) {
        query = query.eq('status', status);
      }
      
      if (upcoming === 'true') {
        query = query.gte('start_time', new Date().toISOString());
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('[Zoom] List webinars error:', error);
        return res.status(500).json({ error: 'Failed to list webinars' });
      }
      
      return res.json(data || []);
    } catch (error) {
      console.error('[Zoom] List webinars error:', error);
      return res.status(500).json({ error: error.message || 'Failed to list webinars' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { 
        topic, 
        agenda, 
        start_time, 
        duration_minutes = 60, 
        timezone = 'Europe/London',
        registration_required = false,
        host_id,
        panelists = [],
        created_by_member_id
      } = req.body;
      
      if (!topic || !start_time) {
        return res.status(400).json({ error: 'topic and start_time are required' });
      }
      
      const token = await getZoomAccessToken(req);
      
      let userId = host_id || 'me';
      
      // Note: We pass start_time as local time (without Z suffix) so Zoom applies the timezone correctly
      // The frontend sends time as "YYYY-MM-DDTHH:MM:SS" and we pass it directly to let Zoom use the timezone field
      const webinarPayload = {
        topic,
        type: 5,
        start_time: start_time,
        duration: duration_minutes,
        timezone,
        agenda: agenda || '',
        settings: {
          host_video: true,
          panelists_video: true,
          practice_session: true,
          hd_video: true,
          approval_type: registration_required ? 0 : 2,
          registration_type: registration_required ? 1 : undefined,
          audio: 'both',
          auto_recording: 'cloud',
          enforce_login: false,
          close_registration: false,
          show_share_button: true,
          allow_multiple_devices: true,
          on_demand: true
        }
      };
      
      console.log('[Zoom] Creating webinar:', JSON.stringify(webinarPayload, null, 2));
      
      const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/webinars`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(webinarPayload)
      });
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Create webinar error:', errorText);
        return res.status(zoomResponse.status).json({ 
          error: 'Failed to create Zoom webinar', 
          details: errorText 
        });
      }
      
      const zoomData = await zoomResponse.json();
      
      console.log('[Zoom] Webinar created:', zoomData.id);
      
      const { data: webinar, error: dbError } = await supabase
        .from('zoom_webinar')
        .insert({
          tenant_id: tenantId,
          topic,
          agenda,
          start_time,
          duration_minutes,
          timezone,
          registration_required,
          zoom_webinar_id: String(zoomData.id),
          zoom_host_id: zoomData.host_id,
          join_url: zoomData.join_url,
          registration_url: zoomData.registration_url,
          password: zoomData.password,
          status: 'scheduled',
          created_by_member_id
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('[Zoom] DB save error:', dbError);
        return res.status(500).json({ error: 'Webinar created on Zoom but failed to save locally' });
      }
      
      if (panelists.length > 0) {
        const panelistResults = [];
        
        for (const panelist of panelists) {
          try {
            const panelistResponse = await fetch(
              `https://api.zoom.us/v2/webinars/${zoomData.id}/panelists`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  panelists: [{
                    name: panelist.name,
                    email: panelist.email
                  }]
                })
              }
            );
            
            if (panelistResponse.ok) {
              const panelistData = await panelistResponse.json();
              // Zoom returns panelist ID inside the panelists array
              const zoomPanelistId = panelistData.panelists?.[0]?.id || panelistData.id;
              console.log('[Zoom] Panelist added, response:', JSON.stringify(panelistData));
              
              const { data: savedPanelist } = await supabase
                .from('zoom_webinar_panelist')
                .insert({
                  webinar_id: webinar.id,
                  name: panelist.name,
                  email: panelist.email,
                  role: panelist.role || 'panelist',
                  zoom_panelist_id: zoomPanelistId,
                  status: 'invited'
                })
                .select()
                .single();
              
              panelistResults.push({ success: true, panelist: savedPanelist });
            } else {
              const errorText = await panelistResponse.text();
              console.error('[Zoom] Panelist add error:', errorText);
              panelistResults.push({ success: false, email: panelist.email, error: errorText });
            }
          } catch (pError) {
            console.error('[Zoom] Panelist error:', pError);
            panelistResults.push({ success: false, email: panelist.email, error: pError.message });
          }
        }
        
        return res.json({ success: true, webinar, panelistResults });
      } else {
        return res.json({ success: true, webinar });
      }
    } catch (error) {
      console.error('[Zoom] Create webinar error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create webinar' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
