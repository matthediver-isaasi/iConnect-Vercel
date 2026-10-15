// Read current published outcomes, never historical matches or raw Zoom names.
// This is additive to check-in evidence; it neither creates attendance nor awards CPD.
export async function recordedAudienceAttendance(db, tenantId, bookingType, bookingIds) {
  const attended = new Set();
  const ids = [...new Set(bookingIds.filter(Boolean))];
  for (let start = 0; start < ids.length; start += 200) {
    for (let offset = 0; ;) {
      const { data, error } = await db.from('attendance_current_outcome')
        .select('booking_id,attendance_target_id,provider,attendance_target!inner(id)')
        .eq('tenant_id', tenantId).eq('booking_type', bookingType).eq('status', 'attended')
        .eq('attendance_target.tenant_id', tenantId)
        .not('attendance_target.tracking_enabled', 'is', false)
        .in('booking_id', ids.slice(start, start + 200))
        .order('booking_id').order('attendance_target_id').order('provider')
        .range(offset, offset + 199);
      if (error || !Array.isArray(data)) {
        throw Object.assign(new Error('Unable to verify recorded event attendance', { cause: error }), {
          code: error?.code, status: error?.status, retryable: error?.retryable,
        });
      }
      if (!data.length) break;
      for (const row of data) attended.add(row.booking_id);
      offset += data.length;
    }
  }
  return attended;
}
