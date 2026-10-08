// Destination-only additive migration. Does not invoke a worker or backfill.
import { readFileSync } from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';

const db = await connectDestination();
try {
  await db.query(readFileSync(new URL('../supabase/migrations/202612050005_event_accounting_queue.sql', import.meta.url), 'utf8'));
  console.log('Applied event accounting queue migration to pinned destination Supabase. No financial replay.');
} finally {
  await db.end();
}
