import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiRequest } from "@/lib/queryClient";
import { publishProjectCardUpdate } from "@/lib/projectBoardCache";

const stores = new WeakMap();
function storeFor(client) {
  if (!stores.has(client)) {
    const store = { ids: new Set(), listeners: new Set() };
    store.subscribe = listener => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    };
    store.snapshot = () => store.ids;
    store.set = (id, pending) => {
      store.ids = new Set(store.ids);
      if (pending) store.ids.add(id);
      else store.ids.delete(id);
      store.listeners.forEach(listener => listener());
    };
    stores.set(client, store);
  }
  return stores.get(client);
}

// One synchronous per-card guard shared by the board and detail modal.
export function useProjectCardCompletion() {
  const client = useQueryClient();
  const store = storeFor(client);
  const pendingIds = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const toggle = async (card, canEdit) => {
    if (!canEdit || !card?.id || store.ids.has(card.id)) return;
    store.set(card.id, true);
    try {
      const { card: saved } = await apiRequest("PATCH", `/api/projects/cards/${card.id}`, {
        is_complete: !card.is_complete,
      });
      // Publish only this action's fields, not a stale snapshot of other edits.
      await publishProjectCardUpdate(client, card.id, {
        is_complete: saved.is_complete, completed_at: saved.completed_at,
        completed_by: saved.completed_by,
      });
    } catch (error) {
      toast.error(error.message || "Could not update card completion");
    } finally {
      store.set(card.id, false);
    }
  };
  return { pendingIds, isPending: id => store.ids.has(id), toggle };
}
