import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BOUNCE_QUERY_KEY, bounceListKey, bounceListParams, canQueryMemberBounce, memberBounceKey, readBounceResponse, resolutionPayload } from "./bounceModel.mjs";

const ENDPOINT = "/api/admin/communications/bounces";

export function useBounceReport({ view, page, search, active = true }) {
  return useQuery({
    queryKey: bounceListKey(view, page, search),
    enabled: active,
    queryFn: async ({ signal }) => readBounceResponse(await fetch(`${ENDPOINT}?${bounceListParams(view, page, search)}`, { credentials: "include", signal })),
    staleTime: 15_000,
    retry: 1,
  });
}

export function useMemberBounce({ memberId, email, enabled = true }) {
  return useQuery({
    queryKey: memberBounceKey(memberId, email),
    enabled: enabled && canQueryMemberBounce(memberId, email),
    // No placeholder/previous data: an email edit must never retain the old badge.
    queryFn: async ({ signal }) => readBounceResponse(await fetch(`${ENDPOINT}?${new URLSearchParams({ memberId })}`, { credentials: "include", signal })),
    staleTime: 0,
    retry: 1,
  });
}

export function useResolveBounce() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, reason }) => readBounceResponse(await fetch(ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolutionPayload(item, reason)),
    })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [BOUNCE_QUERY_KEY] }),
  });
}
