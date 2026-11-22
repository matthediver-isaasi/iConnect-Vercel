import { useCallback, useEffect, useRef, useState } from "react";

const ENDPOINT = "/api/admin/member-lifecycle";
const idle = () => ({ data: null, loading: false, error: null });

export async function lifecycleRequest(query = "", body, method = "POST") {
  let response;
  try {
    response = await fetch(`${ENDPOINT}${query}`, {
      method: body === undefined ? "GET" : method,
      credentials: "include",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("Member lifecycle service is unreachable. No outcome has been confirmed. Reconnect and reload before retrying.");
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const explanation = typeof json?.error === "string" ? json.error : json?.error?.message || json?.message;
    throw new Error(explanation || (response.status === 403
      ? "You do not have permission for this action."
      : response.status === 409
        ? "This record or policy changed. Reload the latest evidence and review your decision again."
        : `Member lifecycle service unavailable (HTTP ${response.status}). No outcome has been confirmed.`));
  }
  if (!json || typeof json !== "object") throw new Error("The lifecycle service returned an invalid response. Reload before continuing.");
  return json;
}

export function useMemberLifecycle() {
  const [config, setConfig] = useState({ ...idle(), loading: true });
  const [review, setReview] = useState(idle);
  const [detail, setDetail] = useState(idle);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const alive = useRef(true);
  const serial = useRef({ config: 0, review: 0, detail: 0, preview: 0 });
  const selected = useRef(null);
  const currentConfig = useRef(null);
  const lock = useRef(false);
  const reviewAllowed = useRef(false);
  const safe = (fn) => { if (alive.current) fn(); };

  const loadConfig = useCallback(async () => {
    const ticket = ++serial.current.config;
    safe(() => setConfig(old => ({ ...old, loading: true, error: null })));
    try {
      const data = await lifecycleRequest();
      if (!data.policy || !data.permissions || !Array.isArray(data.roles) || data.revision == null
        || typeof data.executionReady !== "boolean" || typeof data.enabled !== "boolean"
        || !Array.isArray(data.readinessIssues)) throw new Error("Incomplete policy response. Configuration and execution are unavailable.");
      if (!alive.current || ticket !== serial.current.config) return null;
      currentConfig.current = data;
      reviewAllowed.current = data.permissions.view === true && data.executionReady === true;
      setConfig({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (alive.current && ticket === serial.current.config) {
        currentConfig.current = null;
        reviewAllowed.current = false;
        setConfig({ data: null, loading: false, error: error.message });
      }
      return null;
    }
  }, []);

  const loadReview = useCallback(async (cursor = null) => {
    if (!reviewAllowed.current) return;
    const ticket = ++serial.current.review;
    safe(() => setReview(old => ({ ...old, loading: true, error: null, ...(cursor ? {} : { data: null }) })));
    try {
      const data = await lifecycleRequest(`?section=review${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(data.items)) throw new Error("Incomplete review response. Records could not be verified.");
      if (!alive.current || ticket !== serial.current.review) return;
      setReview(old => ({ data: { ...data, items: cursor ? [...(old.data?.items || []), ...data.items] : data.items }, loading: false, error: null }));
    } catch (error) {
      if (alive.current && ticket === serial.current.review) setReview(old => ({ ...old, loading: false, error: error.message }));
    }
  }, []);

  const loadDetail = useCallback(async (memberId = selected.current) => {
    const ticket = ++serial.current.detail;
    if (memberId && !reviewAllowed.current) return null;
    selected.current = memberId;
    if (!memberId) { safe(() => setDetail(idle())); return null; }
    safe(() => setDetail({ data: null, loading: true, error: null }));
    try {
      const data = await lifecycleRequest(`?section=detail&memberId=${encodeURIComponent(memberId)}`);
      if (data.memberId !== memberId || data.revision == null || !Array.isArray(data.blockers)
        || data.evidence == null || data.audit == null) throw new Error("Incomplete member evidence. Decisions are unavailable until evidence reloads.");
      if (!alive.current || ticket !== serial.current.detail) return null;
      setDetail({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (alive.current && ticket === serial.current.detail) setDetail({ data: null, loading: false, error: error.message });
      return null;
    }
  }, []);

  const reload = useCallback(async () => {
    ++serial.current.preview;
    safe(() => setPreview(null));
    const configTicket = serial.current.config + 1;
    const data = await loadConfig();
    if (!alive.current || configTicket !== serial.current.config) return null;
    if (data?.permissions.view === true && data.executionReady === true) {
      await Promise.all([loadReview(), selected.current ? loadDetail() : Promise.resolve()]);
    } else {
      ++serial.current.review;
      ++serial.current.detail;
      selected.current = null;
      safe(() => { setReview(idle()); setDetail(idle()); });
    }
    return data;
  }, [loadConfig, loadReview, loadDetail]);

  // One mutation at a time; each result (including failures/ambiguous network
  // outcomes) is followed by authoritative reads. Nothing is updated optimistically.
  const mutate = useCallback(async (key, body, method = "POST", { keepPreview = false } = {}) => {
    if (lock.current) return null;
    if (method !== "PUT" && body?.action !== "preview" && currentConfig.current?.executionReady !== true) {
      safe(() => setFeedback({ tone: "error", message: "Preparation only: record decisions and execution controls are unavailable until the server reports execution ready." }));
      return null;
    }
    lock.current = true;
    // Fence reads started before this write: a late response must never replace
    // the subsequent authoritative reload.
    ++serial.current.config;
    ++serial.current.review;
    ++serial.current.detail;
    safe(() => { setPending(key); setFeedback(null); });
    const previewTicket = ++serial.current.preview;
    if (!keepPreview) safe(() => setPreview(null));
    let result = null;
    let failure = null;
    try { result = await lifecycleRequest("", body, method); }
    catch (error) { failure = error; }
    const authoritative = await loadConfig();
    if (reviewAllowed.current) await Promise.all([loadReview(), selected.current ? loadDetail() : Promise.resolve()]);
    if (alive.current) {
      setPending(null);
      if (failure) {
        setPreview(null);
        setFeedback({ tone: "error", message: failure.message });
      }
      else if (!authoritative) setFeedback({ tone: "error", message: "The request returned, but the latest policy could not be verified. Reload before continuing; do not assume the action failed." });
      else if (!key.startsWith("preview") && !key.endsWith("_preview")) setFeedback({ tone: "success", message: "Server response received. Policy and member evidence have been reloaded; verify the current state below." });
    }
    lock.current = false;
    return failure || !authoritative ? null : { result, authoritative, previewTicket };
  }, [loadConfig, loadReview, loadDetail]);

  const runPreview = useCallback(async (previous = null) => {
    const revision = currentConfig.current?.revision;
    if (revision == null) return;
    const outcome = await mutate(previous ? "preview_more" : "preview", {
      action: "preview",
      ...(previous ? { previewId: previous.previewId, cursor: previous.nextCursor } : {}),
    }, "POST", { keepPreview: !!previous });
    if (!outcome || !alive.current || outcome.previewTicket !== serial.current.preview) return;
    const data = outcome.result;
    if (!data.previewId || data.revision !== revision || outcome.authoritative.revision !== revision
      || !Array.isArray(data.items) || typeof data.complete !== "boolean" || !data.counts
      || (previous && data.previewId !== previous.previewId)
      || (previous && data.nextCursor && data.nextCursor === previous.nextCursor)) {
      setPreview(null);
      setFeedback({ tone: "error", message: "The impact preview is incomplete, stale or invalid. Generate a fresh preview; approval remains blocked." });
      return;
    }
    setPreview({ ...data, items: previous ? [...previous.items, ...data.items] : data.items });
  }, [mutate]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      Object.keys(serial.current).forEach(key => { ++serial.current[key]; });
    };
  }, [reload]);

  return { config, review, detail, preview, pending, feedback, reload, loadReview, loadDetail, mutate, runPreview };
}
