import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

async function readCsvSettings(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Keep the contract error below useful when the endpoint returns HTML or
    // an empty response.
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || "Unable to load CSV download settings");
  }
  if (!payload || typeof payload.allowCsvDownload !== "boolean") {
    throw new Error("Invalid CSV download settings response");
  }
  return payload.allowCsvDownload;
}

/**
 * The CSV permission is intentionally kept separate from the legacy system
 * settings document. Local edits remain visible while the query is
 * refetched, but a failed load never turns the permission on.
 */
export function useOrganisationDirectoryCsvSettings({ enabled, identity }) {
  const queryClient = useQueryClient();
  const queryKey = ["organisation-directory-csv-settings", identity];
  const [draft, setDraft] = useState({ identity, value: null });
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => readCsvSettings(await fetch(
      "/api/organisation-directory/csv-settings",
      {
        credentials: "include",
        cache: "no-store",
        signal,
      },
    )),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const draftValue = draft.identity === identity ? draft.value : null;
  const allowCsvDownload = query.isSuccess && !query.isError
    ? (typeof draftValue === "boolean" ? draftValue : query.data === true)
    : false;

  return {
    ...query,
    // Missing, malformed, or failed settings are always treated as off.
    allowCsvDownload,
    setAllowCsvDownload(value) {
      if (value !== true && value !== false) return;
      setDraft({ identity, value });
    },
    async save() {
      if (!enabled || !query.isSuccess || query.isError || query.isFetching) {
        throw new Error("Wait for CSV download settings to load before saving");
      }
      const value = allowCsvDownload === true;
      const savedValue = await readCsvSettings(await fetch(
        "/api/organisation-directory/csv-settings",
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowCsvDownload: value }),
        },
      ));

      queryClient.setQueryData(queryKey, savedValue);
      setDraft(previous => (
        previous.identity === identity && previous.value === value
          ? { identity, value: null }
          : previous
      ));
      await queryClient.invalidateQueries({
        queryKey: ["organisation-directory-csv-settings"],
      });
      // The directory page receives this permission from its authoritative
      // filters metadata response, rather than from this settings endpoint.
      await queryClient.invalidateQueries({
        queryKey: ["organisation-directory-filters"],
      });
    },
  };
}