import { useEffect, useRef, useState } from "react";
import { projectTaskRequest } from "@/components/sales/useSalesProjectTasks";
import { availableInboxCard, inboxCardError } from "./boardMentionHelpers.mjs";

// A link is consumed once, not on every board refresh or modal close.
// Manual opening/closing cancels any pending link request so it cannot steal focus.
export function useInboxCardDeepLink({ boardId, search, ready, onOpenCard }) {
  const cardId = new URLSearchParams(search).get("cardId");
  const key = cardId ? JSON.stringify([boardId, cardId]) : null;
  const consumed = useRef(null);
  const controller = useRef(null);
  const callback = useRef(onOpenCard);
  callback.current = onOpenCard;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState({ key: null, loading: false, error: "" });
  const [attempt, setAttempt] = useState(0);
  const previousKey = useRef(key);

  const cancel = () => {
    controller.current?.abort();
    consumed.current = currentKey.current;
    setState({ key: currentKey.current, loading: false, error: "" });
  };
  const retry = () => {
    consumed.current = null;
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    if (previousKey.current !== key) {
      previousKey.current = key;
      consumed.current = null;
    }
  }, [key]);

  useEffect(() => {
    if (!ready || !boardId || !cardId || consumed.current === key) return;
    const request = new AbortController();
    controller.current = request;
    setState({ key, loading: true, error: "" });
    const open = async () => {
      try {
        // Never use cached board cards to authorize a deep link.
        const result = await projectTaskRequest(`/api/projects/cards/${encodeURIComponent(cardId)}`, { signal: request.signal });
        if (request.signal.aborted) return;
        const card = availableInboxCard(result, boardId);
        if (String(card.id) !== cardId) throw new Error("This card could not be found.");
        consumed.current = key;
        setState({ key, loading: false, error: "" });
        callback.current(card);
      } catch (error) {
        if (request.signal.aborted) return;
        consumed.current = key;
        setState({ key, loading: false, error: inboxCardError(error) });
      }
    };
    void open();
    return () => request.abort();
  }, [boardId, cardId, key, ready, attempt]);

  return {
    loading: state.key === key && state.loading,
    error: state.key === key ? state.error : "",
    cancel,
    retry,
  };
}
