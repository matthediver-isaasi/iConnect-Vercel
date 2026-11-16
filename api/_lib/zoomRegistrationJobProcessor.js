// Dependency-injected processor: no browser session or open dialog is needed.
export async function processZoomJob(job, io) {
  const totals = { registered: 0, existing: 0, pending: 0, denied: 0, missingEmail: 0, failed: 0, skipped: 0, emailed: 0, uncertainEmails: 0, ...job.totals };
  const save = async patch => {
    await io.save(job, { ...patch, totals, updated_at: new Date().toISOString() });
    Object.assign(job, patch);
  };
  try {
    if (!await io.targetMatches(job)) {
      await save({ status: 'stopped', last_error: 'Zoom target changed. Start a new registration operation for the current target.', lease_until: null });
      return;
    }
    if (job.cursor >= job.booking_ids.length) {
      await save({ status: totals.failed || totals.uncertainEmails || totals.pending || totals.denied || totals.missingEmail ? 'attention' : 'completed', lease_until: null });
      return;
    }
    const bookingId = job.booking_ids[job.cursor];
    const booking = await io.booking(job, bookingId);
    if (!booking || booking.status !== 'confirmed') totals.skipped++;
    else if (!booking.attendee_email?.trim()) totals.missingEmail++;
    else {
      const registration = await io.register(job, booking);
      if (registration.outcome === 'failed') throw new Error(registration.error || 'Zoom registration failed');
      const key = registration.outcome === 'new' ? 'registered' : registration.outcome;
      totals[key in totals ? key : 'failed']++;
      if (job.email_requested && registration.join_url) {
        if (job.email_claimed_for === bookingId) {
          // The provider may have accepted the previous send. Never replay it.
          totals.uncertainEmails++;
        } else {
          if (!await io.targetMatches(job)) throw new Error('Zoom target changed before email delivery');
          // Do not checkpoint registration counters until the booking finishes.
          await io.save(job, { email_claimed_for: bookingId });
          job.email_claimed_for = bookingId;
          const sent = await io.email(job, booking, registration.join_url);
          if (sent) totals.emailed++;
          else totals.uncertainEmails++;
        }
      }
    }
    await save({
      cursor: job.cursor + 1, attempts: 0, email_claimed_for: null,
      status: 'queued', lease_until: null, last_error: null,
      available_at: new Date().toISOString(),
    });
  } catch (error) {
    // A failed checkpoint is allowed to expire; provider reconciliation makes
    // replay safe and a persisted email claim prevents a repeated send.
    const attempts = job.attempts + 1;
    await io.save(job, {
      attempts, status: attempts >= 4 ? 'attention' : 'queued',
      last_error: error.message, lease_until: null,
      available_at: new Date(Date.now() + Math.min(900, 30 * 2 ** attempts) * 1000).toISOString(),
    });
  }
}
