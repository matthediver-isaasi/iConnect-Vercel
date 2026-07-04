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

async function fetchUnreadCount() {
  const res = await fetch(`${API_BASE}/unread-count`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load unread count");
  const data = await res.json();
  return data.unreadCount || 0;
}

export async function fetchInboxMessageBody(recipientId) {
  const res = await fetch(`${API_BASE}/${recipientId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load message");
  const data = await res.json();
  return data.message;
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
    async (recipientId, action, folderId) => {
      await postAction({ recipient_id: recipientId, action, folder_id: folderId });
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
    createFolder,
    renameFolder,
    deleteFolder,
  };
}

export function useInboxUnreadCount({ enabled = true } = {}) {
  const { data = 0 } = useQuery({
    queryKey: ["inbox", "unread"],
    queryFn: fetchUnreadCount,
    enabled,
    staleTime: 30000,
    refetchInterval: 60000,
  });
  return data;
}
