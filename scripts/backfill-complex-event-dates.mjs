#!/usr/bin/env node

/**
 * Backfill complex_event.start_date / end_date from session times.
 *
 * Iterates every complex_event and calls the shared
 * recomputeComplexEventDates helper, which sets start_date to the earliest
 * session start_time and end_date to the latest session end_time. Events
 * with status='tbc' or no sessions are skipped (helper returns updated=false).
 *
 * Usage:
 *   node scripts/backfill-complex-event-dates.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import { recomputeComplexEventDates } from '../api/_lib/complexEventDateSync.js';

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY (or SUPABASE_SERVICE_KEY) environment variable is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// In dry-run mode, wrap the client so .update() returns success without writing.
// This lets us reuse the shared recompute helper unchanged.
function makeDryRunClient(real) {
  return {
    from(table) {
      const builder = real.from(table);
      const origUpdate = builder.update.bind(builder);
      builder.update = (payload) => {
        const chain = origUpdate(payload);
        const origEq = chain.eq.bind(chain);
        chain.eq = (...args) => {
          const inner = origEq(...args);
          // Resolve to a no-op success when awaited
          inner.then = (resolve) => resolve({ data: null, error: null });
          return inner;
        };
        return chain;
      };
      return builder;
    },
  };
}

async function run() {
  console.log(`\n=== Backfill complex_event start_date / end_date ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const { data: events, error: eventsErr } = await supabase
    .from('complex_event')
    .select('id, tenant_id, slug, title, status, start_date, end_date');

  if (eventsErr) {
    console.error('Error fetching complex events:', eventsErr.message);
    process.exit(1);
  }

  console.log(`Found ${events.length} complex events to inspect\n`);

  const client = DRY_RUN ? makeDryRunClient(supabase) : supabase;
  const stats = { changed: 0, unchanged: 0, tbc: 0, noSessions: 0, errors: 0 };

  for (const event of events) {
    const result = await recomputeComplexEventDates(client, event.id, event.tenant_id);

    if (result.updated || (DRY_RUN && result.start_date && (event.start_date !== result.start_date || event.end_date !== result.end_date))) {
      console.log(`  [CHANGE] ${event.slug || event.id} "${event.title}"`);
      console.log(`           start: ${event.start_date} -> ${result.start_date}`);
      console.log(`           end:   ${event.end_date} -> ${result.end_date}`);
      stats.changed += 1;
    } else if (result.reason === 'tbc') {
      stats.tbc += 1;
    } else if (result.reason === 'no_sessions') {
      stats.noSessions += 1;
    } else if (result.reason === 'unchanged') {
      stats.unchanged += 1;
    } else if (result.reason) {
      console.error(`  [ERROR] ${event.slug || event.id}: ${result.reason}`);
      stats.errors += 1;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Changed:      ${stats.changed}${DRY_RUN ? ' (dry-run, not applied)' : ''}`);
  console.log(`  Unchanged:    ${stats.unchanged}`);
  console.log(`  TBC skipped:  ${stats.tbc}`);
  console.log(`  No sessions:  ${stats.noSessions}`);
  console.log(`  Errors:       ${stats.errors}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
