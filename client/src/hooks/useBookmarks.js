import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const API_BASE = "/api/bookmarks";

const DEFAULT_CATEGORY_ORDER = ["blog_post", "news_post", "event", "resource", "forum_thread"];

async function fetchBookmarks() {
  const res = await fetch(`${API_BASE}/enriched`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch bookmarks");
  const data = await res.json();
  return { bookmarks: data.bookmarks || [], categoryOrder: data.category_order || null };
}

async function fetchMyBookmarkIds() {
  const res = await fetch(API_BASE, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch bookmarks");
  const data = await res.json();
  return data.bookmarks || [];
}

export function useBookmarks() {
  const queryClient = useQueryClient();

  const { data: enrichedData = { bookmarks: [], categoryOrder: null }, isLoading } = useQuery({
    queryKey: ["bookmarks", "enriched"],
    queryFn: fetchBookmarks,
    staleTime: 5000,
  });

  const enrichedBookmarks = enrichedData.bookmarks;
  const categoryOrder = enrichedData.categoryOrder || DEFAULT_CATEGORY_ORDER;

  const { data: rawBookmarks = [] } = useQuery({
    queryKey: ["bookmarks", "ids"],
    queryFn: fetchMyBookmarkIds,
    staleTime: 5000,
  });

  const isBookmarked = useCallback(
    (entityType, entityId) => {
      return rawBookmarks.some(
        (b) => b.entity_type === entityType && b.entity_id === entityId
      );
    },
    [rawBookmarks]
  );

  const toggleBookmark = useCallback(
    async (entityType, entityId) => {
      const existing = isBookmarked(entityType, entityId);
      const method = existing ? "DELETE" : "POST";

      const res = await fetch(API_BASE, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
      });

      if (!res.ok) throw new Error("Failed to toggle bookmark");

      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      return !existing;
    },
    [isBookmarked, queryClient]
  );

  const reorderCategories = useCallback(
    async (newOrder) => {
      const res = await fetch(`${API_BASE}/reorder`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "categories", category_order: newOrder }),
      });
      if (!res.ok) throw new Error("Failed to reorder categories");
      await queryClient.invalidateQueries({ queryKey: ["bookmarks", "enriched"] });
    },
    [queryClient]
  );

  const reorderItems = useCallback(
    async (entityType, orderedIds) => {
      const res = await fetch(`${API_BASE}/reorder`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "items", entity_type: entityType, ordered_ids: orderedIds }),
      });
      if (!res.ok) throw new Error("Failed to reorder items");
      await queryClient.invalidateQueries({ queryKey: ["bookmarks", "enriched"] });
    },
    [queryClient]
  );

  const grouped = {
    blog_post: enrichedBookmarks.filter((b) => b.entity_type === "blog_post"),
    resource: enrichedBookmarks.filter((b) => b.entity_type === "resource"),
    news_post: enrichedBookmarks.filter((b) => b.entity_type === "news_post"),
    event: enrichedBookmarks.filter((b) => b.entity_type === "event"),
    forum_thread: enrichedBookmarks.filter((b) => b.entity_type === "forum_thread"),
  };

  return {
    bookmarks: enrichedBookmarks,
    grouped,
    categoryOrder,
    isBookmarked,
    toggleBookmark,
    reorderCategories,
    reorderItems,
    isLoading,
    totalCount: enrichedBookmarks.length,
  };
}
