export function parseGalleryDirectoryPagination(query = {}) {
  const rawPage = Number.parseInt(String(query.page || ''), 10);
  const rawPageSize = Number.parseInt(String(query.limit || ''), 10);
  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    pageSize: Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.min(rawPageSize, 48)
      : 12,
  };
}

export function buildGalleryDirectoryPage({
  galleries, access, covers, page, pageSize, isAuthenticated = false,
}) {
  const allowed = (galleries || []).filter((gallery, index) =>
    gallery.is_public || (isAuthenticated && access[index]?.allowed === true)
  );
  const total = allowed.length;
  const start = (page - 1) * pageSize;
  const selected = allowed.slice(start, start + pageSize);
  const coverById = new Map((covers || []).map((cover) => [cover.id, cover]));
  return {
    galleries: selected.map((gallery) => ({
      id: gallery.id,
      title: gallery.title,
      description: gallery.description,
      slug: gallery.slug,
      is_public: gallery.is_public,
      cover_photo: gallery.cover_photo_id
        ? coverById.get(gallery.cover_photo_id) || null
        : null,
    })),
    total,
    page,
    pageSize,
  };
}