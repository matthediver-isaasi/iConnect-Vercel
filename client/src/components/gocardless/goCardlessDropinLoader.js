export const GOCARDLESS_DROPIN_INITIALISE_URL =
  'https://pay.gocardless.com/billing/static/dropin/v2/initialise.js';

// A document can host several payment surfaces, so loading is shared while
// every mounted consumer retains an independently cancelable subscription.
const documentLoads = new WeakMap();

function finish(record, error = null) {
  if (record.settled) return;
  record.settled = true;
  record.script.removeEventListener('load', record.onLoad);
  record.script.removeEventListener('error', record.onError);
  documentLoads.delete(record.document);
  if (error && record.owned && record.script.isConnected) record.script.remove();
  const subscribers = [...record.subscribers];
  record.subscribers.clear();
  for (const subscriber of subscribers) {
    if (error) subscriber.onError(error);
    else subscriber.onLoad(record.window.GoCardlessDropin);
  }
}

function createLoad(windowObj) {
  const documentObj = windowObj.document;
  let script = documentObj.querySelector(
    `script[src="${GOCARDLESS_DROPIN_INITIALISE_URL}"]`,
  );
  const owned = !script;
  if (!script) {
    script = documentObj.createElement('script');
    script.src = GOCARDLESS_DROPIN_INITIALISE_URL;
    script.async = true;
  }
  const record = {
    document: documentObj,
    window: windowObj,
    script,
    owned,
    settled: false,
    subscribers: new Set(),
    onLoad: null,
    onError: null,
  };
  record.onLoad = () => finish(
    record,
    windowObj.GoCardlessDropin
      ? null
      : new Error('GoCardless Drop-in loaded without exposing its SDK'),
  );
  record.onError = () => finish(record, new Error('Failed to load GoCardless Drop-in'));
  script.addEventListener('load', record.onLoad);
  script.addEventListener('error', record.onError);
  documentLoads.set(documentObj, record);
  if (owned) documentObj.head.appendChild(script);
  return record;
}

/**
 * Subscribe to the official v2 initialise script. Cancellation removes this
 * consumer and, when it was the last one, removes our still-hung script and
 * both DOM listeners so a later retry starts from a clean request.
 */
export function subscribeGoCardlessDropin({
  windowObj = window,
  onLoad,
  onError,
}) {
  if (windowObj.GoCardlessDropin) {
    let active = true;
    queueMicrotask(() => {
      if (active) onLoad(windowObj.GoCardlessDropin);
    });
    return () => { active = false; };
  }

  const record = documentLoads.get(windowObj.document) || createLoad(windowObj);
  const subscriber = { onLoad, onError };
  record.subscribers.add(subscriber);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    record.subscribers.delete(subscriber);
    if (!record.settled && record.subscribers.size === 0) {
      record.settled = true;
      record.script.removeEventListener('load', record.onLoad);
      record.script.removeEventListener('error', record.onError);
      documentLoads.delete(record.document);
      if (record.owned && record.script.isConnected) record.script.remove();
    }
  };
}