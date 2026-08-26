import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clearTeamsMeeting, hasTeamsMeeting, normalizeTeamsMeeting } from '@/lib/teamsMeeting';

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Microsoft Teams request failed');
    error.code = body.code;
    throw error;
  }
  return body;
}

export default function TeamsMeetingConfig({
  value = {},
  onChange,
  subject,
  startDateTime,
  endDateTime,
  timezone = 'UTC',
  testId = 'teams-meeting',
}) {
  const meeting = normalizeTeamsMeeting(value);
  const [mode, setMode] = useState('create');
  const [joinUrl, setJoinUrl] = useState(meeting.teams_join_web_url || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data: health, isLoading } = useQuery({
    queryKey: ['/api/teams/meetings', 'health'],
    queryFn: () => request('/api/teams/meetings'),
    staleTime: 30000,
    retry: false,
  });

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request('/api/teams/meetings', {
        method: 'POST',
        body: JSON.stringify(mode === 'link'
          ? { action: 'link', joinUrl }
          : { action: 'create', subject, startDateTime, endDateTime, timezone }),
      });
      onChange(normalizeTeamsMeeting(result.meeting));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return <div className="text-sm text-slate-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Checking Microsoft connection…</div>;
  }

  if (!health?.connected || health?.status !== 'active') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert" data-testid={`${testId}-disconnected`}>
        <AlertCircle className="mr-2 inline h-4 w-4" />
        Connect or reconnect the Microsoft organiser account before adding a Teams meeting.
        <Button type="button" variant="link" className="h-auto px-2 text-amber-900" onClick={() => { window.location.href = '/api/auth/outlook?teamsOrganizer=true'; }}>
          Connect Microsoft <ExternalLink className="ml-1 h-3 w-3" />
        </Button>
      </div>
    );
  }

  if (!health?.meetingManagementSupported) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert" data-testid={`${testId}-consent`}>
        <AlertCircle className="mr-2 inline h-4 w-4" />
        {health?.message || 'This Microsoft connection is missing consent for Teams meeting management and attendance reports.'}
        <Button type="button" variant="link" className="h-auto px-2 text-amber-900" onClick={() => { window.location.href = '/api/auth/outlook?teamsOrganizer=true'; }}>
          Grant consent <ExternalLink className="ml-1 h-3 w-3" />
        </Button>
      </div>
    );
  }

  if (hasTeamsMeeting(meeting)) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4" data-testid={`${testId}-linked`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-emerald-900"><CheckCircle2 className="mr-2 inline h-4 w-4" />Teams meeting linked</p>
            <p className="mt-1 text-xs text-emerald-800">Organiser: {meeting.teams_organiser_email || 'Microsoft organiser'}</p>
            <a className="text-xs text-emerald-800 underline" href={meeting.teams_join_web_url} target="_blank" rel="noreferrer">Open join link</a>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(clearTeamsMeeting())}>
            <Unlink className="mr-1 h-3 w-3" /> Detach
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4" data-testid={testId}>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant={mode === 'create' ? 'default' : 'outline'} onClick={() => setMode('create')}>Create meeting</Button>
        <Button type="button" size="sm" variant={mode === 'link' ? 'default' : 'outline'} onClick={() => setMode('link')}>Link existing</Button>
      </div>
      {mode === 'link' ? (
        <div className="space-y-1">
          <Label>Teams join URL</Label>
          <Input value={joinUrl} onChange={(event) => setJoinUrl(event.target.value)} placeholder="https://teams.microsoft.com/l/meetup-join/…" />
        </div>
      ) : (
        <p className="text-xs text-slate-600">Create a Teams meeting using this item's title, dates, timezone, and connected organiser.</p>
      )}
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <Button type="button" size="sm" disabled={busy || (mode === 'link' ? !joinUrl : !subject || !startDateTime || !endDateTime)} onClick={submit}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {mode === 'link' ? 'Link Teams meeting' : 'Create Teams meeting'}
      </Button>
    </div>
  );
}
