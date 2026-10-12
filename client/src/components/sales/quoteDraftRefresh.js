// Keep the saved form visible until an authoritative read completes. Clearing
// its loaded identity first lets the old query cache hydrate it again.
export async function refreshSavedQuoteDraft({ refetch, normalize, submittedFingerprint, setForm, setSavedFingerprint }) {
  const result = await refetch();
  if (result.error) throw result.error;
  if (!result.data) throw new Error("The saved draft could not be reloaded.");
  const fresh = normalize(result.data);
  setSavedFingerprint(JSON.stringify(fresh));
  setForm(current => JSON.stringify(current) === submittedFingerprint ? fresh : current);
  return fresh;
}
