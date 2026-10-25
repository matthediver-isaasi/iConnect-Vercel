import { useQuery } from "@tanstack/react-query";
import { adminFetch } from "@/lib/adminFetch";

export async function waitingListRequest(url, options = {}, tenantId) {
  const response = await adminFetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
  }, tenantId);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to update the waiting list. Please try again.');
  return data;
}

export function useEventWaitingList(memberInfo, { admin = false, eventId, eventKind } = {}) {
  return useQuery({
    queryKey: ['event-waiting-list', memberInfo?.tenant_id, memberInfo?.id, admin, eventId, eventKind],
    enabled: !!memberInfo?.id && (!admin || !!eventId),
    queryFn: ({ signal }) => waitingListRequest(admin
      ? `/api/admin/event-waiting-list?${new URLSearchParams({ event_id: eventId, event_kind: eventKind })}`
      : '/api/member/event-waiting-list', { signal }, memberInfo?.tenant_id),
    retry: false,
  });
}
