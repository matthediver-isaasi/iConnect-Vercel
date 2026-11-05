/**
 * Buckets are ordered runs, not a dictionary of initials. Never sort or fold
 * them: a database collation can place the same initial in several runs.
 */
export function groupAlphabetBuckets(buckets, pageSize) {
  const groups = [];
  for (const bucket of buckets || []) {
    if (!bucket || typeof bucket.label !== 'string'
      || !Number.isSafeInteger(bucket.offset) || bucket.offset < 0
      || !Number.isSafeInteger(bucket.count) || bucket.count <= 0
      || typeof bucket.id !== 'string' || !bucket.id) continue;
    const previous = groups.at(-1);
    const consecutive = previous && /^[A-Z]$/.test(previous.lastLabel)
      && /^[A-Z]$/.test(bucket.label)
      && bucket.label.charCodeAt(0) === previous.lastLabel.charCodeAt(0) + 1;
    if (consecutive && previous.offset + previous.count === bucket.offset
      && previous.count + bucket.count <= pageSize) {
      previous.count += bucket.count;
      previous.lastLabel = bucket.label;
      previous.label = `${previous.firstLabel}–${bucket.label}`;
    } else {
      groups.push({
        ...bucket,
        firstLabel: bucket.label,
        lastLabel: bucket.label,
        key: `${bucket.offset}:${bucket.id}`,
      });
    }
  }
  return groups;
}

export function alphabetTargetPage(offset, pageSize) {
  return Math.floor(offset / pageSize) + 1;
}

// Keep page and alphabet reads on the same filter/order contract. Empty wire
// filters are omitted; pagination and displayed fields are added by the caller.
export function crmListParams(values) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    (value !== '' || key === 'search') && value !== undefined && value !== null && value !== '{}'));
}
