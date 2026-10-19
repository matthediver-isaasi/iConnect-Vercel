// Missing/legacy content follows the directory setting; reject unknown modes.
export function resolveDirectoryCarouselOrganisationNameDisplay(value) {
  return ['show', 'hide'].includes(value) ? value : 'inherit';
}

// Explicit identity wins over the legacy slug. Do not infer a primary source
// from an empty slug: existing unconfigured blocks must stay unconfigured.
export function resolveDirectoryCarouselSource(content = {}) {
  const source = ['primary-member', 'primary-organization', 'dynamic'].includes(content.source)
    ? content.source
    : 'dynamic';
  const directoryId = source === 'dynamic' ? String(content.directoryId || '') : '';
  const directorySlug = source === 'dynamic' ? String(content.directorySlug || '') : '';
  return {
    source,
    directoryId,
    directorySlug,
    configured: source !== 'dynamic' || !!(directoryId || directorySlug),
    identity: `${source}:${directoryId || directorySlug}`,
  };
}

// This only maps the carousel API's safe projection; it never fetches member
// profiles or raw directory detail data to fill in withheld fields.
export function presentDirectoryCarouselRecord(record, entityType) {
  const member = entityType === 'member' || record.entity_type === 'member';
  return {
    ...record,
    entity_type: member ? 'member' : 'organization',
    name: member ? (record.name || record.display_name || 'Member') : (record.name || null),
    logo_url: member ? (record.photo_url || record.profile_photo_url || record.image_url || null) : (record.logo_url || null),
  };
}

export function resolveDirectoryCarouselPerView(value) {
  const size = Number(value);
  return Number.isFinite(size) ? Math.min(50, Math.max(1, Math.floor(size))) : 3;
}

export async function discoverDirectoryCarouselSources(entity) {
  const directories = [];
  const seen = new Set();
  // Use an explicit bounded batch size rather than relying on a server's
  // default page size or fetching only the first 100 configurations.
  for (let offset = 0; ;) {
    const batch = await entity.list({ limit: 100, offset, sort: { id: 'asc' } });
    if (!Array.isArray(batch)) throw new Error('Directory discovery returned an invalid response.');
    if (batch.length === 0) break;
    let added = 0;
    for (const directory of batch) {
      if (!seen.has(directory.id)) {
        seen.add(directory.id);
        directories.push(directory);
        added += 1;
      }
    }
    if (!added) throw new Error('Directory discovery could not load the next page.');
    offset += batch.length;
  }
  return directories
    .filter((directory) => directory.is_active === true && ['member', 'organization'].includes(directory.entity_type))
    .sort((a, b) => String(a.name || a.slug || '').localeCompare(String(b.name || b.slug || '')));
}
