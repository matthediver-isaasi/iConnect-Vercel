// Tenant-scoped event time-clash check.
// This is an advisory warning aid only — it must NEVER block saving. If the
// request fails for any reason we report "no clashes" so the save proceeds.
export async function checkEventClashes({ windows, excludeEventId = null, excludeComplexEventId = null }) {
  try {
    const resp = await fetch('/api/events/check-clashes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ windows, excludeEventId, excludeComplexEventId }),
    });
    if (!resp.ok) {
      return { hasClashes: false, clashes: [], error: true };
    }
    const data = await resp.json();
    return {
      hasClashes: data?.hasClashes === true,
      clashes: Array.isArray(data?.clashes) ? data.clashes : [],
    };
  } catch (err) {
    console.error('[checkEventClashes] failed:', err);
    return { hasClashes: false, clashes: [], error: true };
  }
}
