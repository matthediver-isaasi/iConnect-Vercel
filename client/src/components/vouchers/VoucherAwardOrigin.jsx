import React from 'react';
import { Button } from '@/components/ui/button';

export default function VoucherAwardOrigin({ query, voucherId }) {
  if (query.isError) return (
    <div className="text-sm text-amber-800 mt-2" role="alert">
      Speaker award origins could not be loaded.
      <Button variant="link" size="sm" disabled={query.isFetching}
        onClick={event => { event.stopPropagation(); query.refetch(); }}>
        Retry award origins
      </Button>
    </div>
  );
  if (query.isPending) return <p className="text-sm text-slate-500 mt-2" role="status">Loading speaker award origins…</p>;
  const origins = query.data?.[voucherId];
  if (!origins?.length) return null;
  return (
    <section aria-label="Speaker award origin" className="text-sm text-slate-600 mt-2">
      <p className="font-medium">Speaker award origin</p>
      {origins.map((origin, index) => (
        <dl key={index} className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
          <dt>Speaker</dt><dd>{origin.speaker || 'Unavailable'}</dd>
          <dt>Event</dt><dd>{origin.event || 'Unavailable'}</dd>
          <dt>Event internal reference</dt><dd>{origin.event_internal_reference || 'Unavailable'}</dd>
        </dl>
      ))}
    </section>
  );
}
