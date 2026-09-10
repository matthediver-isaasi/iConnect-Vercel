import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseOrganisationDirectoryFilterOverrides } from "../../../shared/organisationDirectoryFilters.js";

const EMPTY = Object.freeze({});

async function readResponse(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || "Unable to save directory filters");
  if (!payload || !Object.hasOwn(payload, "overrides")) {
    throw new Error("Invalid directory filter settings response");
  }
  return parseOrganisationDirectoryFilterOverrides(payload?.overrides);
}

/** Local edits overlay server state; refetches never replace unsaved choices. */
export function useOrganisationDirectoryFilterSettings({ enabled, identity }) {
  const queryClient = useQueryClient();
  const queryKey = ["organisation-directory-filter-settings", identity];
  const [draft, setDraft] = useState({ identity, changes: EMPTY });
  const changes = draft.identity === identity ? draft.changes : EMPTY;
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => readResponse(await fetch(
      "/api/organisation-directory/filters?settings=true",
      { credentials: "include", cache: "no-store", signal },
    )),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  return {
    ...query,
    overrides: { ...(query.data || EMPTY), ...changes },
    setOverride(key, checked) {
      setDraft(previous => ({
        identity,
        changes: {
          ...(previous.identity === identity ? previous.changes : EMPTY),
          [key]: checked === true,
        },
      }));
    },
    async save() {
      if (!enabled || !query.isSuccess || query.isFetching) {
        throw new Error("Wait for directory filter settings to load before saving");
      }
      const savedChanges = changes;
      if (!Object.keys(savedChanges).length) return;
      const overrides = await readResponse(await fetch(
        "/api/organisation-directory/filters?settings=true",
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: savedChanges }),
        },
      ));
      queryClient.setQueryData(queryKey, overrides);
      setDraft(previous => {
        if (previous.identity !== identity) return previous;
        const remaining = { ...previous.changes };
        for (const [key, value] of Object.entries(savedChanges)) {
          if (remaining[key] === value) delete remaining[key];
        }
        return { identity, changes: remaining };
      });
      await queryClient.invalidateQueries({ queryKey: ["organisation-directory-filters"] });
    },
  };
}