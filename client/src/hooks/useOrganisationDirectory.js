import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { isDirectoryEmbedLocation } from "@/hooks/useDirectoryObjectSources";

async function readJson(response, fallbackMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The status message below is more useful than a JSON parsing error.
  }
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || fallbackMessage);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * GET and POST both return authoritative field metadata. Whichever successful
 * response completed most recently wins, and only then are revoked/disabled
 * filter keys removed.
 */
export function useAuthoritativeDirectoryFilters(metadataQuery, resultsQuery, setFilters) {
  const fields = useMemo(() => (
    resultsQuery.isSuccess && resultsQuery.dataUpdatedAt >= metadataQuery.dataUpdatedAt
      ? resultsQuery.data.fields
      : (metadataQuery.data?.fields || [])
  ), [
    resultsQuery.isSuccess,
    resultsQuery.dataUpdatedAt,
    resultsQuery.data?.fields,
    metadataQuery.dataUpdatedAt,
    metadataQuery.data?.fields,
  ]);

  useEffect(() => {
    if (!metadataQuery.isSuccess && !resultsQuery.isSuccess) return;
    const allowed = new Set(fields.map(field => field.key));
    setFilters(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => allowed.has(key)));
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [metadataQuery.isSuccess, resultsQuery.isSuccess, fields, setFilters]);

  return fields;
}

export function useOrganisationDirectoryMetadata() {
  const { memberInfo, authResolved } = useMemberAccess();
  const enabled = Boolean(
    authResolved && memberInfo?.id && memberInfo?.tenant_id && !isDirectoryEmbedLocation()
  );
  return useQuery({
    queryKey: [
      "organisation-directory-filters",
      memberInfo?.tenant_id || null,
      memberInfo?.id || null,
      "metadata",
    ],
    enabled,
    queryFn: async () => {
      const response = await fetch("/api/organisation-directory/filters", {
        credentials: "include",
        cache: "no-store",
      });
      const payload = await readJson(response, "Unable to load directory filters");
      if (!payload || !Array.isArray(payload.fields)) {
        throw new Error("Invalid directory filters response");
      }
      return payload;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useOrganisationDirectoryOptions({
  fieldKey,
  search = "",
  page = 1,
  pageSize = 50,
  selected = [],
}) {
  const { memberInfo, authResolved } = useMemberAccess();
  const queryClient = useQueryClient();
  const authenticated = Boolean(
    authResolved && memberInfo?.id && memberInfo?.tenant_id && !isDirectoryEmbedLocation()
  );
  const stableSelected = Array.isArray(selected) ? selected : [];

  const query = useQuery({
    queryKey: [
      "organisation-directory-filters",
      memberInfo?.tenant_id || null,
      memberInfo?.id || null,
      "options",
      fieldKey || null,
      search,
      page,
      pageSize,
      stableSelected,
    ],
    enabled: Boolean(authenticated && fieldKey),
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/organisation-directory/filters", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "options",
          fieldKey,
          search,
          page,
          pageSize,
          selected: stableSelected,
        }),
      });
      const payload = await readJson(response, "Unable to load filter options");
      if (
        !payload
        || !Array.isArray(payload.options)
        || !Array.isArray(payload.selectedOptions)
        || !Array.isArray(payload.unavailableSelected)
        || !Number.isInteger(payload.total)
        || !Number.isInteger(payload.page)
        || !Number.isInteger(payload.pageSize)
      ) {
        throw new Error("Invalid directory filter options response");
      }
      return payload;
    },
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      const sameAuthorizationScope = (
        previousKey?.[1] === (memberInfo?.tenant_id || null)
        && previousKey?.[2] === (memberInfo?.id || null)
        && previousKey?.[4] === (fieldKey || null)
      );
      return sameAuthorizationScope ? previousData : undefined;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    if (!query.isError || ![400, 403, 409].includes(query.error?.status)) return;
    queryClient.invalidateQueries({
      queryKey: [
        "organisation-directory-filters",
        memberInfo?.tenant_id || null,
        memberInfo?.id || null,
        "metadata",
      ],
    });
  }, [
    query.isError,
    query.error,
    queryClient,
    memberInfo?.tenant_id,
    memberInfo?.id,
  ]);

  return query;
}

export function useOrganisationDirectoryResults(request, enabled = true) {
  const { memberInfo, authResolved } = useMemberAccess();
  const authenticated = Boolean(
    authResolved && memberInfo?.id && memberInfo?.tenant_id && !isDirectoryEmbedLocation()
  );
  return useQuery({
    queryKey: [
      "organisation-directory-filters",
      memberInfo?.tenant_id || null,
      memberInfo?.id || null,
      "results",
      request,
    ],
    enabled: Boolean(enabled && authenticated),
    queryFn: async () => {
      const response = await fetch("/api/organisation-directory/filters", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = await readJson(response, "Unable to load organisations");
      if (
        !payload
        || !Array.isArray(payload.organizations)
        || !Array.isArray(payload.fields)
        || !Number.isInteger(payload.total)
        || !Number.isInteger(payload.page)
        || !Number.isInteger(payload.pageSize)
      ) {
        throw new Error("Invalid organisation directory response");
      }
      return payload;
    },
    placeholderData: undefined,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
}
