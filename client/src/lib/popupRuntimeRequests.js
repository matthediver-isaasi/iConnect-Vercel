export const POPUP_REQUEST_TIMEOUT_MS = 10000;

// Race explicitly as well as aborting fetch: an uncooperative transport must
// not keep personalized content open indefinitely during revocation checks.
export async function boundedPopupRequest(request, query, options = {}) {
  const controller = new AbortController();
  const parent = options.signal;
  let timer;
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const abort = () => {
    controller.abort();
    rejectCancellation(new Error("Popup request cancelled."));
  };
  try {
    if (parent?.aborted) throw new Error("Popup request cancelled.");
    parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      rejectCancellation(new Error("Popup eligibility request timed out."));
    }, POPUP_REQUEST_TIMEOUT_MS);
    return await Promise.race([
      Promise.resolve().then(() => request(query, { ...options, signal: controller.signal })),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
