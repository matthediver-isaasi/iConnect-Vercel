// Every row is already owned by this invocation. No ambiguous provider outcome
// ever returns it to pending. No provider call is retried here.
export async function finishPreparedCampaignBatch({
  entries, deadline, now = Date.now, gate, revalidate, revalidateBatch, selectBatchSize, release, submit, persist,
}) {
  const expired = () => deadline != null && deadline - now() < 8000;
  if (!entries.length) return { sent: 0, failed: 0 };
  let ready = [];
  let submitted = false;
  try {
    if (expired()) { await release(entries); return { sent: 0, failed: 0, stopReason: 'deadline' }; }
    if (revalidateBatch) {
      const states = await revalidateBatch(entries);
      for (const entry of entries) {
        const state = states.get(entry.recipient.id);
        if (!['ready', 'unsubscribed', 'cancelled'].includes(state)) throw new Error('Incomplete eligibility result');
        if (state === 'ready') ready.push(entry);
      }
      for (const state of ['unsubscribed', 'cancelled']) {
        const excluded = entries.filter(e => states.get(e.recipient.id) === state);
        if (excluded.length) await release(excluded, state,
          state === 'cancelled' ? 'Hard-bounced address: campaign sends are paused' : null);
      }
    } else {
    for (let offset = 0; offset < entries.length; offset += 8) {
      if (expired()) { await release(entries); return { sent: 0, failed: 0, stopReason: 'deadline' }; }
      const outcomes = await Promise.allSettled(entries.slice(offset, offset + 8).map(async entry => {
        const state = await revalidate(entry);
        if (state === 'ready') ready.push(entry);
        else await release([entry], state,
          state === 'cancelled' ? 'Hard-bounced address: campaign sends are paused' : null);
      }));
      if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Batch eligibility could not be verified');
    }
    }
    // Only the fitting prefix can reach the provider. Release the untouched
    // remainder before submission; it will receive fresh checks next invocation.
    if (ready.length && selectBatchSize) {
      const size = selectBatchSize(ready);
      if (!Number.isInteger(size) || size < 1 || size > ready.length) throw new Error('Invalid batch selection');
      if (size < ready.length) {
        await release(ready.slice(size), 'pending');
        ready = ready.slice(0, size);
      }
    }
    const current = await gate();
    if (!current.allowed || expired()) {
      await release(ready, current.cancelled ? 'cancelled' : 'pending');
      return { sent: 0, failed: 0, stoppedGate: current.allowed ? null : current, stopReason: 'gate' };
    }
    if (!ready.length) return { sent: 0, failed: 0 };
    submitted = true;
    const result = await submit(ready);
    if (result.notSubmitted) {
      submitted = false;
      if (result.incompatible) return { sent: 0, failed: 0, fallback: ready };
      await release(ready);
      return { sent: 0, failed: 0, stopReason: result.provenanceError ? 'provenance_error' : 'deadline', error: result.error };
    }
    if (result.success) {
      await persist(ready, { status: 'sent', sent_at: new Date().toISOString(), mailgun_message_id: result.messageId });
      return { sent: ready.length, failed: 0, bulkRequests: 1 };
    }
    if (result.ambiguousEffect) return { sent: 0, failed: 0, processing: ready.length, stopReason: 'ambiguous' };
    await persist(ready, { status: 'failed', error_message: result.error || 'Mailgun batch rejected' });
    return { sent: 0, failed: ready.length, stopReason: result.rateLimited ? 'rate_limit' : 'provider_rejected' };
  } catch {
    // Includes successful provider acceptance followed by failed persistence.
    if (!submitted) await release(entries);
    return { sent: 0, failed: 0, processing: submitted ? ready.length : 0, stopReason: 'error' };
  }
}
