export function reorderPortalMenu(rows, sourceId, destination, eligibleIds) {
  const item = rows.find(row => row.id === sourceId);
  if (!item) return rows;
  const siblings = rows.filter(row => (!eligibleIds || eligibleIds.includes(row.id)) && row.is_active && row.section === item.section
    && (row.parent_id || '') === (item.parent_id || ''))
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  const from = siblings.findIndex(row => row.id === sourceId);
  const to = destination === 'up' ? from - 1 : destination === 'down' ? from + 1
    : siblings.findIndex(row => row.id === destination);
  if (from < 0 || to < 0 || to >= siblings.length || from === to) return rows;
  // Preserve existing integer positions; repair duplicates only when necessary.
  let positions = siblings.map(row => row.display_order);
  if (positions.some(value => !Number.isInteger(value)) || new Set(positions).size !== positions.length) {
    const offset = (item.section === 'admin' ? 10000 : 0) + (item.parent_id ? 5000 : 0);
    positions = siblings.map((_, index) => offset + index);
  }
  const [moved] = siblings.splice(from, 1);
  siblings.splice(to, 0, moved);
  const order = new Map(siblings.map((row, index) => [row.id, positions[index]]));
  return rows.map(row => order.has(row.id) ? { ...row, display_order: order.get(row.id) } : row);
}

// Serialize saves, while accepting further local moves immediately. The next
// batch always compares the latest desired order with the last confirmed one.
export function createPortalMenuOrderQueue({ write, changed, persisted = () => {}, saved, failed }) {
  let confirmed, desired, running = false, stopped = false, recovering = false;
  async function flush() {
    if (running || stopped) return;
    running = true;
    try {
      while (desired) {
        const snapshot = desired;
        const previous = new Map(confirmed.map(row => [row.id, row.display_order]));
        const updates = snapshot.filter(row => previous.get(row.id) !== row.display_order);
        const results = await Promise.allSettled(updates.map(row => write(row.id, row.display_order)));
        if (results.some(result => result.status === 'rejected')) throw new Error('Menu order could not be fully saved.');
        confirmed = snapshot;
        if (desired === snapshot) {
          desired = null;
          persisted(snapshot);
          if (!stopped) saved(snapshot);
        }
      }
    } catch (error) {
      desired = null;
      recovering = true;
      if (!stopped) await failed(error);
    } finally {
      running = false;
      recovering = false;
    }
  }
  return {
    move(rows, id, destination, eligibleIds) {
      if (stopped || recovering) return;
      const current = desired || rows;
      const next = reorderPortalMenu(current, id, destination, eligibleIds);
      if (next === current) return;
      if (!running) confirmed = rows;
      desired = next;
      changed(next);
      void flush();
    },
    stop() { stopped = true; },
    start() { stopped = false; },
  };
}
