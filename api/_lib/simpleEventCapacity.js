// Only explicit total-mode rows use the new authority. Never infer a historical maximum.
export async function projectSimpleEventCapacity(db, rows, { includeLegacy = false } = {}) {
  return Promise.all((rows || []).map(async (row) => {
    if (!(row.capacity_mode === 'total' || includeLegacy && row.capacity_mode === 'legacy') || row.is_complex) return row;
    const { data, error } = await db.rpc('simple_event_capacity', { p_event_id: row.id });
    if (error || !data || data.used == null) {
      throw new Error('Event availability is temporarily unavailable');
    }
    return {
      ...row,
      available_seats: row.capacity_mode === 'total' ? data.remaining : row.available_seats,
      capacity_used: data.used,
      capacity_booked: data.confirmed,
      capacity_commercial: data.commercial_unused,
      is_unlimited_registration: row.capacity_mode === 'total' ? data.total === null : row.is_unlimited_registration,
    };
  }));
}
