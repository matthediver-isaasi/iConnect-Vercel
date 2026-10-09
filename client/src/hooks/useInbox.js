import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "../api/base44Client";
import { inboxActionBody, inboxBulkBody, inboxDetailPath, inboxSearchKeys, invalidateInboxViews } from "../lib/inboxSources.mjs";

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
    latestSource: data.latestSource || data.latestMessageSource || null,
    latestSentAt: data.latestSentAt || null,
  };
}

const EMPTY_UNREAD_SUMMARY = {
  unreadCount: 0,
  latestSubject: null,
  latestMessageId: null,
  latestSource: null,
  latestSentAt: null,
};

export async function fetchInboxMessageBody(recipientId, source) {
  const res = await fetch(inboxDetailPath(recipientId, source), { credentials: "include" });
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
  return data;
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
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const invalidate = useCallback(async () => {
    await invalidateInboxViews(queryClient);
  }, [queryClient]);

  const act = useCallback(
    async (recipientId, action, folderId, source) => {
      const body = inboxActionBody(recipientId, action, folderId, source);
      await postAction(body);
      await invalidate();
    },
    [invalidate]
  );

  // The optional fifth argument adds project mentions without breaking callers.
  const actBulk = useCallback(
    async (campaignIds, transactionalIds, action, folderId, projectIds = []) => {
      const body = inboxBulkBody(campaignIds, transactionalIds, action, folderId, projectIds);
      if (!body) return;
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
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return data || EMPTY_UNREAD_SUMMARY;
}

export function useInboxUnreadCount({ enabled = true } = {}) {
  return useInboxUnreadSummary({ enabled }).unreadCount;
}

// Server-side body search; expose source-qualified identities to the list.
// Resolve legacy bare IDs against the current list without fetching bodies.
export function useInboxBodyMatches(query) {
  const queryClient = useQueryClient();
  const q = (query || "").trim();
  const enabled = q.length >= 2;
  const { data, isFetching } = useQuery({
    queryKey: ["inbox", "search", q],
    queryFn: () => fetchInboxBodyMatches(q),
    enabled,
    staleTime: 30000,
  });
  return {
    matchingRecipientIds: enabled && data ? inboxSearchKeys(data, queryClient.getQueryData(["inbox"])?.messages || []) : null,
    isSearching: enabled && isFetching && !data,
  };
}
