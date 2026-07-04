import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "../api/base44Client";

const API_BASE = "/api/communication/inbox";

async function fetchInbox() {
  const res = await fetch(API_BASE, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load inbox");
  const data = await res.json();
  return {
    messages: data.messages || [],
    folders: data.folders || [],
    unreadCount: data.unreadCount || 0,
  };
}

async function fetchUnreadSummary() {
  const res = await fetch(`${API_BASE}/unread-count`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load unread count");
  const data = await res.json();
  return {
    unreadCount: data.unreadCount || 0,
    latestSubject: data.latestSubject || null,
    latestMessageId: data.latestMessageId || null,
    latestSentAt: data.latestSentAt || null,
  };
}

const EMPTY_UNREAD_SUMMARY = {
  unreadCount: 0,
  latestSubject: null,
  latestMessageId: null,
  latestSentAt: null,
};

export async function fetchInboxMessageBody(recipientId, source) {
  const qs = source === "transactional" ? "?source=transactional" : "";
  const res = await fetch(`${API_BASE}/${recipientId}${qs}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load message");
  const data = await res.json();
  return data.message;
}

async function fetchInboxBodyMatches(query) {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to search messages");
  const data = await res.json();
  return Array.isArray(data.recipientIds) ? data.recipientIds : [];
}

async function postAction(body) {
  const res = await fetch(API_BASE, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to update message");
  return res.json();
}

export function useInbox() {
  const queryClient = useQueryClient();

  const { data = { messages: [], folders: [], unreadCount: 0 }, isLoading, refetch } = useQuery({
    queryKey: ["inbox"],
    queryFn: fetchInbox,
    staleTime: 5000,
  });

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["inbox", "unread"] }),
    ]);
  }, [queryClient]);

  const act = useCallback(
    async (recipientId, action, folderId, source) => {
      const body = { action, folder_id: folderId };
      if (source === "transactional") body.transactional_id = recipientId;
      else body.recipient_id = recipientId;
      await postAction(body);
      await invalidate();
    },
    [invalidate]
  );

  // Bulk actions can span both message sources; pass campaign recipient ids and
  // transactional message ids separately so the endpoint routes each to the
  // right table.
  const actBulk = useCallback(
    async (campaignIds, transactionalIds, action, folderId) => {
      const cIds = Array.isArray(campaignIds) ? campaignIds.filter(Boolean) : [];
      const tIds = Array.isArray(transactionalIds) ? transactionalIds.filter(Boolean) : [];
      if (cIds.length === 0 && tIds.length === 0) return;
      const body = { action, folder_id: folderId };
      if (cIds.length > 0) body.recipient_ids = cIds;
      if (tIds.length > 0) body.transactional_ids = tIds;
      await postAction(body);
      await invalidate();
    },
    [invalidate]
  );

  const createFolder = useCallback(
    async (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      await base44.entities.MemberInboxFolder.create({ name: trimmed });
      await invalidate();
    },
    [invalidate]
  );

  const renameFolder = useCallback(
    async (folderId, name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      await base44.entities.MemberInboxFolder.update(folderId, { name: trimmed });
      await invalidate();
    },
    [invalidate]
  );

  const deleteFolder = useCallback(
    async (folderId) => {
      await base44.entities.MemberInboxFolder.delete(folderId);
      await invalidate();
    },
    [invalidate]
  );

  return {
    messages: data.messages,
    folders: data.folders,
    unreadCount: data.unreadCount,
    isLoading,
    refetch,
    act,
    actBulk,
    createFolder,
    renameFolder,
    deleteFolder,
  };
}

export function useInboxUnreadSummary({ enabled = true } = {}) {
  const { data } = useQuery({
    queryKey: ["inbox", "unread"],
    queryFn: fetchUnreadSummary,
    enabled,
    staleTime: 30000,
    refetchInterval: 60000,
  });
  return data || EMPTY_UNREAD_SUMMARY;
}

export function useInboxUnreadCount({ enabled = true } = {}) {
  return useInboxUnreadSummary({ enabled }).unreadCount;
}

// Server-side body search: returns the set of recipient ids (this member's own
// messages) whose rendered email body matches the query. Matching happens on the
// server against the same plain text the reading pane shows, so no bodies are
// fetched client-side.
export function useInboxBodyMatches(query) {
  const q = (query || "").trim();
  const enabled = q.length >= 2;
  const { data, isFetching } = useQuery({
    queryKey: ["inbox", "search", q],
    queryFn: () => fetchInboxBodyMatches(q),
    enabled,
    staleTime: 30000,
  });
  return {
    matchingRecipientIds: enabled ? data || null : null,
    isSearching: enabled && isFetching && !data,
  };
}
