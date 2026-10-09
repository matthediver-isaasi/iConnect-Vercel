import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  emptyBoardFilters, filterBoardCards, groupBoardCards, hasBoardFilters, normalizeSearchDocuments,
} from "./projectBoardFilters.mjs";

const EMPTY_CARDS = [];

export function useProjectBoardFilters(boardId, boardData, enabled) {
  // Scope immediately to the route so a board switch never requests with old criteria.
  const [state, setState] = useState(() => ({ boardId, filters: emptyBoardFilters() }));
  const filters = useMemo(() => state.boardId === boardId ? state.filters : emptyBoardFilters(), [state, boardId]);
  useEffect(() => {
    setState(current => current.boardId === boardId ? current : { boardId, filters: emptyBoardFilters() });
  }, [boardId]);
  const setFilters = next => setState({ boardId, filters: typeof next === "function" ? next(filters) : next });
  const clearFilters = () => setFilters(emptyBoardFilters());
  const [debounced, setDebounced] = useState({ boardId, keyword: "" });
  const keyword = filters.keyword.trim();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ boardId, keyword }), 250);
    return () => clearTimeout(timer);
  }, [keyword, boardId]);
  const settled = debounced.boardId === boardId && debounced.keyword === keyword;
  const search = useQuery({
    queryKey: ["project-board", boardId, "search-index"],
    enabled: Boolean(enabled && boardId && keyword && settled),
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/boards/${boardId}?searchIndex=true`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Could not load comment and activity search. Try again.");
      const data = await response.json();
      if (!Array.isArray(data.documents)) throw new Error("Search index is unavailable. Try again.");
      return data;
    },
  });
  const searchDocuments = useMemo(() => normalizeSearchDocuments(search.data?.documents), [search.data]);
  const searchStatus = !keyword ? "idle" : search.isError ? "error"
    : !settled || !search.data || search.isFetching ? "loading" : "ready";
  const cards = boardData?.cards || EMPTY_CARDS;
  const filteredCards = useMemo(() => filterBoardCards(cards, filters, boardData?.viewerIdentityId,
    searchDocuments, searchStatus === "ready" ? keyword : ""),
  [cards, filters, boardData?.viewerIdentityId, searchDocuments, searchStatus, keyword]);
  const cardsByList = useMemo(() => groupBoardCards(cards), [cards]);
  const filteredByList = useMemo(() => groupBoardCards(filteredCards), [filteredCards]);
  const active = hasBoardFilters(filters);
  return {
    filters, setFilters, clearFilters, active, filteredCards, cardsByList, filteredByList,
    searchStatus, searchError: search.error?.message, retrySearch: () => search.refetch(),
    noMatches: active && !filteredCards.length && (searchStatus === "idle" || searchStatus === "ready"),
  };
}
