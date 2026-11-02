import { useEffect, useRef, useState } from "react";
import { loadMemberAffiliationSnapshot } from "./memberAffiliationApi";

export const MEMBER_AFFILIATION_SNAPSHOT = "__member_affiliation_snapshot";
const EMPTY_IDS = Object.freeze([]);
const plainObject = value => value && typeof value === "object" && !Array.isArray(value);

export function normalizeMemberAffiliations(data) {
  if (data?.active === false) return { active: false, managedFieldIds: EMPTY_IDS };
  if (data?.active !== true || typeof data.snapshotToken !== "string" || !data.snapshotToken
    || !plainObject(data.values) || !Array.isArray(data.managedFieldIds)
    || data.managedFieldIds.some(id => typeof id !== "string" || !id || id.startsWith("__"))) {
    throw new Error("Your current affiliations could not be verified. Please retry loading them.");
  }
  const managedFieldIds = [...new Set(data.managedFieldIds)];
  // Only the server-declared managed answers may seed the form. Neither
  // respondent identity nor an arbitrary server key is submission authority.
  const values = Object.fromEntries(managedFieldIds
    .filter(id => Object.prototype.hasOwnProperty.call(data.values, id))
    .map(id => [id, data.values[id]]));
  if (managedFieldIds.some(id => !Object.prototype.hasOwnProperty.call(values, id))) {
    throw new Error("Some current affiliations are missing. Please retry before submitting.");
  }
  return { active: true, snapshotToken: data.snapshotToken, values, managedFieldIds };
}

export function memberAffiliationSubmissionValues(values, state) {
  const answers = Object.fromEntries(Object.entries(values || {})
    .filter(([key]) => key !== MEMBER_AFFILIATION_SNAPSHOT));
  // Do not trust a token restored from a draft, URL prefill or previous form.
  return state.active && state.snapshotToken
    ? { ...answers, [MEMBER_AFFILIATION_SNAPSHOT]: state.snapshotToken }
    : answers;
}

export function affiliationCommitConfirmed(result) {
  return ["applied", "already_applied", "awaiting_review"].includes(result?.member_affiliations?.status);
}

// One fresh snapshot per form/viewer session, never a focus refetch. Wait for
// defaults and draft restoration before applying it, then let edits stand.
export function useMemberAffiliations({
  formId, tenantId, principalId, enabled = true, ready = true, requireActive = false, setFormValues,
}) {
  const identity = JSON.stringify([formId, tenantId || null, principalId || null]);
  const [request, setRequest] = useState(null);
  const [appliedIdentity, setAppliedIdentity] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const applied = useRef(null);
  const setValuesRef = useRef(setFormValues);
  setValuesRef.current = setFormValues;
  const required = enabled && !!formId;
  const current = request?.identity === identity ? request : null;
  const data = current?.data;

  useEffect(() => {
    if (!required) return undefined;
    if (applied.current?.identity === identity) return undefined;
    const controller = new AbortController();
    // A viewer switch must not expose or submit the previous viewer's answers.
    if (applied.current && applied.current.identity !== identity) {
      const oldIds = new Set([...applied.current.managedFieldIds, MEMBER_AFFILIATION_SNAPSHOT]);
      setValuesRef.current(previous => Object.fromEntries(
        Object.entries(previous).filter(([key]) => !oldIds.has(key)),
      ));
      applied.current = null;
    }
    setAppliedIdentity(null);
    setRequest({ identity, data: null, error: null });
    async function load() {
      try {
        const body = await loadMemberAffiliationSnapshot(formId, { signal: controller.signal, tenantId });
        const normalized = normalizeMemberAffiliations(body);
        if (requireActive && !normalized.active) {
          throw new Error("This form’s affiliation settings changed. Reload the form before submitting.");
        }
        if (!controller.signal.aborted) setRequest({ identity, data: normalized, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setRequest({ identity, data: null, error });
      }
    }
    load();
    return () => controller.abort();
  }, [identity, required, formId, tenantId, attempt, requireActive]);

  useEffect(() => {
    if (!required || !ready || !data?.active || applied.current?.identity === identity) return;
    // Initial fresh baseline wins over defaults and restored draft mappings.
    // This effect is not keyed by values/callbacks and cannot replay on edits.
    applied.current = { identity, managedFieldIds: data.managedFieldIds };
    setValuesRef.current(previous => ({
      ...previous, ...data.values, [MEMBER_AFFILIATION_SNAPSHOT]: data.snapshotToken,
    }));
    setAppliedIdentity(identity);
  }, [required, ready, data, identity]);

  const retry = () => setAttempt(value => value + 1);
  return {
    active: required && data?.active === true,
    snapshotToken: required && data?.active && appliedIdentity === identity ? data.snapshotToken : null,
    managedFieldIds: required ? data?.managedFieldIds || EMPTY_IDS : EMPTY_IDS,
    pending: required && (!data || (data.active && appliedIdentity !== identity)),
    error: required && current?.error ? {
      message: current.error.message || "We couldn't load your current affiliations. Please retry.",
      retry,
    } : null,
    retry,
  };
}
