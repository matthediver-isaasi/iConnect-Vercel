import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseOrganisationDirectoryFilterOverrides, parseOrganisationDirectoryFilterModes } from "../../../shared/organisationDirectoryFilters.js";

const EMPTY = Object.freeze({});

async function readResponse(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || "Unable to save directory filters");
  if (!payload || !Object.hasOwn(payload, "overrides")) {
    throw new Error("Invalid directory filter settings response");
  }
  const modes = parseOrganisationDirectoryFilterModes({ $modes: payload.modes ?? {} });
  return {
    overrides: parseOrganisationDirectoryFilterOverrides(payload.overrides),
    fields: Array.isArray(payload.fields) ? payload.fields : [],
    modes,
  };
}

/** Local edits overlay server state; refetches never replace unsaved choices. */
export function useOrganisationDirectoryFilterSettings({ enabled, identity }) {
  const queryClient = useQueryClient();
  const queryKey = ["organisation-directory-filter-settings", identity];
  const [draft, setDraft] = useState({ identity, changes: EMPTY, modeChanges: EMPTY });
  const changes = draft.identity === identity ? draft.changes : EMPTY;
  const modeChanges = draft.identity === identity ? draft.modeChanges : EMPTY;
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
    overrides: { ...(query.data?.overrides || EMPTY), ...changes },
    fields: query.data?.fields || [],
    modes: { ...(query.data?.modes || EMPTY), ...modeChanges },
    setOverride(key, checked) {
      setDraft(previous => ({
        identity,
        modeChanges: previous.identity === identity ? previous.modeChanges : EMPTY,
        changes: {
          ...(previous.identity === identity ? previous.changes : EMPTY),
          [key]: checked === true,
        },
      }));
    },
    setMode(key, mode) {
      if (!["single", "multi"].includes(mode)) return;
      setDraft(previous => ({
        identity,
        changes: previous.identity === identity ? previous.changes : EMPTY,
        modeChanges: {
          ...(previous.identity === identity ? previous.modeChanges : EMPTY),
          [key]: mode,
        },
      }));
    },
    async save() {
      if (!enabled || !query.isSuccess || query.isFetching) {
        throw new Error("Wait for directory filter settings to load before saving");
      }
      const savedChanges = changes;
      const savedModes = modeChanges;
      if (!Object.keys(savedChanges).length && !Object.keys(savedModes).length) return;
      const payload = await readResponse(await fetch(
        "/api/organisation-directory/filters?settings=true",
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            changes: savedChanges,
            ...(Object.keys(savedModes).length ? { modeChanges: savedModes } : {}),
          }),
        },
      ));
      queryClient.setQueryData(queryKey, previous => ({
        ...payload,
        fields: previous?.fields || payload.fields,
      }));
      setDraft(previous => {
        if (previous.identity !== identity) return previous;
        const remaining = { ...previous.changes };
        for (const [key, value] of Object.entries(savedChanges)) {
          if (remaining[key] === value) delete remaining[key];
        }
        const remainingModes = { ...previous.modeChanges };
        for (const [key, value] of Object.entries(savedModes)) {
          if (remainingModes[key] === value) delete remainingModes[key];
        }
        return { identity, changes: remaining, modeChanges: remainingModes };
      });
      await queryClient.invalidateQueries({ queryKey: ["organisation-directory-filters"] });
      await queryClient.invalidateQueries({ queryKey: ["directory-public-config"] });
    },
  };
}