// No database/provider dependencies: admissions are serialized, delivery is not.
export function campaignSendConcurrency(value = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(4, Math.floor(number))) : 2;
}

export async function drainCampaignRecipients({
  batchSize, concurrency = 1, deadline, now = Date.now,
  claim, gate, release, send, onMetrics,
}) {
  const startedAt = now();
  let attempted = 0, claimed = 0, sent = 0, failed = 0, processing = 0;
  let stoppedGate = null, stopReason = null, firstError = null;
  let admission = Promise.resolve();
  const timings = { claimMs: 0, gateMs: 0, sendMs: 0 };
  const normalStop = reason => ['batch_cap', 'empty_or_contended'].includes(reason);
  const stop = reason => {
    // Provider pressure is invocation-wide and must remain observable even
    // when another slot stopped first for consent/cancellation/deadline.
    if (reason === 'rate_limit' || (!stopReason || normalStop(stopReason))) stopReason = reason;
  };
  const expired = () => deadline != null && now() >= deadline;
  const timed = async (key, operation) => {
    const start = now();
    try { return await operation(); } finally { timings[key] += Math.max(0, now() - start); }
  };
  // Reserve one batch position before awaiting anything. A claim collision
  // consumes a position and yields, never reclaims a processing/ambiguous row.
  const admit = () => {
    const next = admission.then(async () => {
      if (stopReason) return null;
      if (expired()) { stop('deadline'); return null; }
      if (attempted >= batchSize) { stop('batch_cap'); return null; }
      attempted++;
      const [recipient] = await timed('claimMs', claim);
      if (!recipient) { stop('empty_or_contended'); return null; }
      claimed++;
      try {
        const currentGate = await timed('gateMs', gate);
        if (!currentGate.allowed || expired() || (stopReason && !normalStop(stopReason))) {
          if (!currentGate.allowed) stoppedGate ||= currentGate;
          stop(!currentGate.allowed ? (currentGate.cancelled ? 'cancelled' : currentGate.paused ? 'paused' : 'gate') : 'deadline');
          await release(recipient, currentGate.cancelled ? 'cancelled' : 'pending');
          return null;
        }
        return recipient;
      } catch (error) {
        // No send began. Release only this owned, definitively unsent row.
        stop('error');
        try { await release(recipient, 'pending'); } catch {}
        throw error;
      }
    });
    admission = next.catch(error => { firstError ||= error; stop('error'); });
    return next;
  };
  const slot = async () => {
    try {
      while (true) {
        const recipient = await admit();
        if (!recipient) return;
        const result = await timed('sendMs', () => send(recipient, {
          shouldStop: () => Boolean(stopReason && !normalStop(stopReason)),
          stop,
        }));
        if (result === 'sent') sent++;
        else if (result === 'failed') failed++;
        else if (result === 'processing') processing++;
        else if (result === 'rate_limited') { failed++; stop('rate_limit'); }
        else if (result === 'stopped') stop('recipient_stop');
      }
    } catch (error) {
      // send may have reached the provider: never release here.
      firstError ||= error;
      stop('error');
    }
  };
  // Never Promise.all's fail-fast return: even a failed claim/gate/provider
  // must wait for every started personalization/send/persistence operation.
  await Promise.allSettled(Array.from({ length: campaignSendConcurrency(concurrency) }, slot));
  const metrics = { concurrency: campaignSendConcurrency(concurrency), attempted, claimed,
    sent, failed, processing, elapsedMs: Math.max(0, now() - startedAt), stopReason, ...timings };
  onMetrics?.(metrics);
  if (firstError) throw firstError;
  return { sent, failed, stoppedGate, metrics };
}