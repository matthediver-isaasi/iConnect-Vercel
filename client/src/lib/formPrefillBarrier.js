// Required sources, not TanStack's isLoading flag, define the barrier.
// A disabled query can be pending/idle forever; never register it as required.
export function prefillQueryState(queries = []) {
  const required = queries.filter(item => item.required);
  const paused = required.find(item => item.query?.fetchStatus === 'paused');
  const failure = required.find(item => !item.query?.isFetching
    && (item.query?.isError || item.query?.status === 'error'));
  return {
    pending: required.some(item => item.query?.status !== 'success' || item.query?.isFetching),
    error: failure || paused ? {
      message: paused
        ? 'Loading data is paused. Check your connection, then retry.'
        : `We couldn't load ${failure.label || 'the form data'}. Please retry.`,
      retry: () => Promise.all(required.filter(item => item.query?.status !== 'success' || item.query?.fetchStatus === 'paused')
        .map(item => item.query?.refetch?.())),
    } : null,
  };
}

export function combinePrefillStates(...states) {
  const error = states.find(state => state?.error)?.error || null;
  return { locked: !!error || states.some(state => state?.pending || state?.locked), error };
}

export function initialPrefillState({ expected, applied, initialized, queries }) {
  if (!expected || (applied && initialized)) return { pending: false, ready: true, error: null };
  const queryState = prefillQueryState(queries);
  return {
    ...queryState,
    pending: true,
    ready: !!initialized && !queryState.pending && !queryState.error,
  };
}
