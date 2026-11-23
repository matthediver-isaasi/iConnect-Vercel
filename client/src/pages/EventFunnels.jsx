import React from 'react';
import { Link } from 'react-router-dom';
import EventFunnelSettings from '@/components/events/EventFunnelSettings';

export default function EventFunnels() {
  return <main className="w-full min-w-0 px-3 py-6 sm:px-6 lg:px-8" data-testid="event-funnels-page">
    <header className="mb-6">
      <Link to="/Events" className="text-sm text-muted-foreground hover:underline">Back to events</Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Event funnels</h1>
      <p className="mt-2 text-muted-foreground">Create connected event and ticket offers that lead to one checkout.</p>
    </header>
    <EventFunnelSettings standalone />
  </main>;
}
