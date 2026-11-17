import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export async function synchroniseEventSpeakers(eventId) {
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/sync-speakers`, {
    method: 'POST', credentials: 'include',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Panelist synchronisation could not start');
  return data.job;
}

export default function ZoomSpeakerSyncStatus({ eventId, webinarId }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!eventId || !webinarId) return;
    let active = true;
    let timer;
    setJob(null); setError('');
    const load = async () => {
      try {
        const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/sync-speakers`, { credentials: 'include' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Panelist status unavailable');
        if (active) { setJob(data.job); setError(''); }
      } catch (e) { if (active) setError(e.message); }
      if (active) timer = setTimeout(load, 5000);
    };
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [eventId, webinarId]);
  if (!eventId || !webinarId) return null;
  const retry = async () => {
    setBusy(true); setError('');
    try { setJob(await synchroniseEventSpeakers(eventId)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 space-y-2 text-sm" data-testid="zoom-speaker-sync">
    <p role="status">{busy ? 'Synchronising speakers with Zoom…'
      : job?.status === 'completed' ? 'Event speakers are synchronised with Zoom panelists.'
      : job?.status === 'running' ? 'Speaker synchronisation is running.'
      : job?.status === 'pending' ? 'Speaker synchronisation is queued. It continues after you leave this page.'
      : job?.status === 'attention' ? 'Speaker synchronisation needs attention.'
      : 'Speaker synchronisation has not been checked yet.'}</p>
    {(error || job?.last_error) && <p role="alert">{error || job.last_error}</p>}
    <p>Panelists added directly in Zoom are preserved. Save speaker changes before synchronising.</p>
    <Button type="button" variant="outline" size="sm" disabled={busy || job?.status === 'running'} onClick={retry}>
      {busy ? 'Synchronising…' : 'Synchronise speakers'}
    </Button>
  </div>;
}
