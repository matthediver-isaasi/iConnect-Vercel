export function upcomingZoomOptions(items, query = '', now = Date.now()) {
  const search = query.trim().toLocaleLowerCase();
  return (items || []).filter(item =>
    item.status === 'scheduled' &&
    Number.isFinite(Date.parse(item.start_time)) &&
    Date.parse(item.start_time) > now &&
    (!search || String(item.topic || '').toLocaleLowerCase().includes(search))
  ).sort((a, b) =>
    String(a.topic || '').localeCompare(String(b.topic || ''), 'en', { sensitivity: 'base' }) ||
    String(a.id).localeCompare(String(b.id))
  );
}
