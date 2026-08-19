export const JOB_FEED_MANAGED_FIELDS = Object.freeze([
  'external_source',
  'external_id',
  'external_url',
  'source_attribution',
  'external_last_seen_at',
]);

export function hasManagedJobProvenance(body) {
  return JOB_FEED_MANAGED_FIELDS.some(
    field => body?.[field] !== undefined && body?.[field] !== null && body?.[field] !== ''
  );
}

export function stripManagedJobProvenance(body = {}) {
  const clean = { ...body };
  for (const field of JOB_FEED_MANAGED_FIELDS) delete clean[field];
  return clean;
}