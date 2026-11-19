import React from 'react';

export default function EventCapacitySummary({ booked, commercial, used, unlimited, total }) {
  const capacity = total === '' || total == null ? null : Number(total);
  const known = Number.isSafeInteger(capacity) && capacity >= 0 && used != null;
  const belowUsage = !unlimited && known && capacity < used;
  return (
    <p className="text-sm" role="status" data-testid="event-capacity-summary">
      Booked: {booked ?? 'Unavailable'} · Other committed places: {commercial ?? 'Unavailable'} · Remaining: {
        unlimited ? 'Unlimited' : known ? Math.max(0, capacity - used) : 'Unavailable'}
      {belowUsage ? ' — Total is below current usage. No additional places can be purchased.' : ''}
    </p>
  );
}
