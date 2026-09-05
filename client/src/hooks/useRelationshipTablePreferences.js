import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemberAccess } from "./useMemberAccess";
import { relationshipTablePreferenceKey } from "@/pages/customObjects/relationshipColumnHelpers.mjs";
import {
  relationshipRequest,
  relationshipRoutes,
} from "@/pages/customObjects/relationshipApi";

export function useRelationshipTablePreferences({
  definitionId,
  side,
  contextKind,
  objectId,
  enabled = true,
}) {
  const { memberInfo, isAdmin, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const key = relationshipTablePreferenceKey({
    memberId: memberInfo?.id,
    definitionId,
    side,
    contextKind,
    objectId,
  });
  const queryKey = ["relationship-table-preference", key];
  const canPersist = enabled && isAccessReady && isAdmin && Boolean(key);
  const url = relationshipRoutes.relationshipPanelPreference({ definitionId, side });
  const query = useQuery({
    queryKey,
    enabled: canPersist,
    staleTime: Infinity,
    queryFn: () => relationshipRequest(url),
  });
  const mutation = useMutation({
    mutationFn: ({ requestUrl, value }) => relationshipRequest(requestUrl, {
      method: "PATCH",
      body: JSON.stringify({ preference: value }),
    }),
    onSuccess: (data, variables) =>
      queryClient.setQueryData(
        ["relationship-table-preference", variables.preferenceKey],
        data,
      ),
  });
  const save = useCallback((value) => {
    if (!canPersist) return Promise.resolve(value);
    queryClient.setQueryData(queryKey, { preference: value });
    return mutation.mutateAsync({ requestUrl: url, preferenceKey: key, value })
      .then((data) => data.preference);
  }, [mutation, queryClient, key, url, canPersist]);
  return {
    preference: query.data?.preference || null,
    isLoading: query.isLoading,
    error: query.error,
    isSaving: mutation.isPending,
    canPersist,
    save,
  };
}