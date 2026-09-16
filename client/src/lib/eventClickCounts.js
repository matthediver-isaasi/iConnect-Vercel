const MAX_EVENT_IDS = 500;

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0))];
}

function normalizeCountMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id, count]) => typeof id === 'string' && Number.isFinite(Number(count)) && Number(count) >= 0)
      .map(([id, count]) => [id, Number(count)]),
  );
}

export function normalizeEventClickCounts(value) {
  return {
    simple: normalizeCountMap(value?.simple),
    complex: normalizeCountMap(value?.complex),
  };
}

export async function fetchEventClickCounts({
  simpleEventIds = [],
  complexEventIds = [],
  fetchImpl = typeof fetch === 'function' ? fetch : null,
} = {}) {
  const simpleIds = normalizeIds(simpleEventIds);
  const complexIds = normalizeIds(complexEventIds);
  if (!fetchImpl) throw new Error('Fetch is unavailable');

  const taggedEventIds = [
    ...simpleIds.map((id) => ({ id, kind: 'simple' })),
    ...complexIds.map((id) => ({ id, kind: 'complex' })),
  ];
  const batches = [];
  for (let index = 0; index < taggedEventIds.length; index += MAX_EVENT_IDS) {
    batches.push(taggedEventIds.slice(index, index + MAX_EVENT_IDS));
  }

  const responses = await Promise.all(batches.map(async (events) => {
    const response = await fetchImpl('/api/admin/events/click-counts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        simpleEventIds: events.filter((event) => event.kind === 'simple').map((event) => event.id),
        complexEventIds: events.filter((event) => event.kind === 'complex').map((event) => event.id),
      }),
    });
    if (!response.ok) throw new Error('Failed to load event click counts');

    const data = await response.json();
    return normalizeEventClickCounts(data?.counts);
  }));

  return responses.reduce(
    (merged, counts) => ({
      simple: { ...merged.simple, ...counts.simple },
      complex: { ...merged.complex, ...counts.complex },
    }),
    { simple: {}, complex: {} },
  );
}