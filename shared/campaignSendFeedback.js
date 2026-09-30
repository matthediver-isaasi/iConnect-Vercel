function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function firstDefined(result, keys) {
  for (const key of keys) {
    if (result?.[key] !== undefined && result?.[key] !== null) {
      return result[key];
    }
  }
  return undefined;
}

function plural(countValue, singular, pluralValue = `${singular}s`) {
  return countValue === 1 ? singular : pluralValue;
}

function failureDetail(result) {
  const details = [];
  const candidates = [
    ...(Array.isArray(result?.failures) ? result.failures : []),
    ...(Array.isArray(result?.errors) ? result.errors : []),
  ];

  for (const failure of candidates) {
    if (typeof failure === 'string') {
      details.push(failure);
      continue;
    }
    if (!failure || typeof failure !== 'object') continue;
    const reason = failure.error || failure.reason || failure.message;
    const recipient = failure.email || failure.recipient;
    if (reason) details.push(recipient ? `${recipient}: ${reason}` : String(reason));
  }

  const directError = result?.error || result?.errorMessage;
  if (directError) details.unshift(String(directError));
  return [...new Set(details)].slice(0, 3).join('; ');
}

function withFailures(message, failed, detail) {
  if (failed <= 0) return message;
  const failureText = `${failed} ${plural(failed, 'email')} failed`;
  return `${message} ${failureText}${detail ? `: ${detail}` : '.'}`;
}

/**
 * Convert the send endpoint response into deliberately narrow UI feedback.
 * "sent" from the endpoint means accepted by the email provider, not delivered.
 */
export function getCampaignSendFeedback(result = {}) {
  const status = String(result.status || '').toLowerCase();
  const accepted = count(firstDefined(result, ['acceptedCount', 'accepted', 'sent']));
  const delivered = count(firstDefined(result, ['deliveredCount', 'delivered']));
  const failed = count(firstDefined(result, ['failedCount', 'failed']))
    || (Array.isArray(result.failures) ? result.failures.length : 0)
    || (Array.isArray(result.errors) ? result.errors.length : 0);
  const explicitRemaining = firstDefined(result, ['remaining', 'pending', 'queuedCount', 'pendingCount']);
  const remaining = explicitRemaining === undefined
    ? count(result.queued) + count(result.processing)
    : count(explicitRemaining);
  const detail = failureDetail(result);
  const acceptedText = `${accepted} ${plural(accepted, 'email')} accepted by the provider`;

  if (status === 'cancelled' || result.cancelled === true) {
    const message = accepted > 0
      ? `Campaign cancelled. ${acceptedText}.`
      : 'Campaign cancelled before any emails were accepted by the provider.';
    return { type: 'warning', message: withFailures(message, failed, detail) };
  }

  if (status === 'queued' || status === 'pending' || status === 'preparing') {
    const lead = status === 'preparing' ? 'Campaign is preparing.' : 'Campaign queued.';
    const progress = accepted > 0 ? ` ${acceptedText}.` : ' No emails have been accepted yet.';
    const pending = remaining > 0 ? ` ${remaining} ${plural(remaining, 'email')} still queued.` : '';
    return {
      type: failed > 0 ? 'warning' : 'info',
      message: withFailures(`${lead}${progress}${pending}`, failed, detail),
    };
  }

  if (status === 'sending' || status === 'processing') {
    const progress = accepted > 0
      ? `Campaign sending continues. ${acceptedText}.`
      : 'Campaign sending has started; no emails have been accepted by the provider yet.';
    const pending = remaining > 0 ? ` ${remaining} ${plural(remaining, 'email')} still queued.` : '';
    return {
      type: failed > 0 ? 'warning' : 'info',
      message: withFailures(`${progress}${pending}`, failed, detail),
    };
  }

  if (status === 'paused') {
    const progress = accepted > 0
      ? `Campaign paused. ${acceptedText}.`
      : 'Campaign paused before any emails were accepted by the provider.';
    const pending = remaining > 0 ? ` ${remaining} ${plural(remaining, 'email')} remain queued.` : '';
    return {
      type: failed > 0 ? 'warning' : 'info',
      message: withFailures(`${progress}${pending}`, failed, detail),
    };
  }

  if (delivered > 0 && (status === 'delivered' || accepted === 0)) {
    const message = `${delivered} ${plural(delivered, 'email')} confirmed delivered.`;
    return { type: failed > 0 ? 'warning' : 'success', message: withFailures(message, failed, detail) };
  }

  if (accepted === 0) {
    const failureText = failed > 0
      ? `${failed} ${plural(failed, 'email')} failed${detail ? `: ${detail}` : '.'}`
      : (detail || 'Check the campaign audience and try again.');
    return {
      type: 'error',
      message: `No emails were accepted by the provider. ${failureText}`,
    };
  }

  const message = `${acceptedText}. Delivery is not yet confirmed.`;
  return {
    type: failed > 0 ? 'warning' : 'success',
    message: withFailures(message, failed, detail),
  };
}