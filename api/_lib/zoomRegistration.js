// Provider authority for admin registration operations. Never return host URLs.
export function safeZoomAttendeeUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/(^|\.)zoom\.(us|com)$/.test(u.hostname)) return null;
    if (!/^\/(j|w)\/\d+/.test(u.pathname) || u.searchParams.has('zak') || u.searchParams.has('tk')) return null;
    return u.href;
  } catch { return null; }
}

export async function zoomRequest(token, path, options = {}) {
  const response = await fetch(`https://api.zoom.us/v2/${path}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Zoom request failed (HTTP ${response.status}). Check integration scopes and meeting configuration.`);
  return response.status === 204 ? null : response.json();
}

export async function readZoomRegistration(token, kind, id) {
  const data = await zoomRequest(token, `${kind}/${encodeURIComponent(id)}`);
  const approval = data.settings?.approval_type;
  if (![0, 1, 2].includes(approval)) throw new Error('Zoom registration setting is unavailable');
  return {
    topic: data.topic, numericId: String(data.id), start_time: data.start_time,
    timezone: data.timezone, duration_minutes: data.duration, type: data.type,
    registration_required: approval !== 2, approval_type: approval,
    join_url: safeZoomAttendeeUrl(data.join_url), checkedAt: new Date().toISOString(),
  };
}

export async function enableZoomRegistration(token, kind, id) {
  const before = await readZoomRegistration(token, kind, id);
  if (before.registration_required) return before;
  // Recurring/instant/PMI configurations need separate occurrence semantics.
  if (kind !== 'meetings' || before.type !== 2) throw new Error('Enable registration in Zoom for this configuration, then retry.');
  await zoomRequest(token, `${kind}/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ settings: { approval_type: 0, registration_type: 1 } }),
  });
  const after = await readZoomRegistration(token, kind, id);
  if (!after.registration_required) throw new Error('Zoom did not enable registration. No attendees were registered.');
  return after;
}

export async function listZoomRegistrations(token, kind, id) {
  const records = new Map();
  for (const status of ['approved', 'pending', 'denied']) {
    let next = '';
    const seen = new Set();
    do {
      const query = new URLSearchParams({ status, page_size: '300', next_page_token: next });
      const data = await zoomRequest(token, `${kind}/${encodeURIComponent(id)}/registrants?${query}`);
      if (!Array.isArray(data.registrants)) throw new Error('Incomplete Zoom registrant response');
      for (const row of data.registrants) {
        const email = row.email?.trim().toLowerCase();
        if (email && !records.has(email)) records.set(email, { ...row, status });
      }
      next = data.next_page_token || '';
      if (next && (seen.has(next) || seen.size >= 100)) throw new Error('Zoom pagination did not complete');
      seen.add(next);
    } while (next);
  }
  return records;
}

export async function registerWithZoom(token, kind, id, attendee, records) {
  const email = attendee.email?.trim().toLowerCase();
  if (!email) return { success: false, outcome: 'missing_email', error: 'Missing attendee email' };
  const existing = records.get(email);
  if (existing) return {
    success: existing.status === 'approved', already_registered: true,
    outcome: existing.status === 'approved' ? 'existing' : existing.status,
    join_url: existing.status === 'approved' ? existing.join_url || null : null,
  };
  try {
    const data = await zoomRequest(token, `${kind}/${encodeURIComponent(id)}/registrants`, {
      method: 'POST',
      body: JSON.stringify({ email, first_name: attendee.first_name || 'Guest', last_name: attendee.last_name || 'Attendee' }),
    });
    const status = data.join_url ? 'approved' : 'pending';
    records.set(email, { ...data, email, status });
    return { success: status === 'approved', outcome: status === 'approved' ? 'new' : 'pending', join_url: data.join_url || null };
  } catch (error) {
    // A timed-out/duplicate POST may have succeeded. Re-read rather than repost.
    const refreshed = await listZoomRegistrations(token, kind, id);
    const found = refreshed.get(email);
    if (found) {
      records.set(email, found);
      return { success: found.status === 'approved', already_registered: true, outcome: found.status === 'approved' ? 'existing' : found.status, join_url: found.status === 'approved' ? found.join_url || null : null };
    }
    return { success: false, outcome: 'failed', error: error.message };
  }
}
