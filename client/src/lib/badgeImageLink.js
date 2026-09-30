const BADGE_IMAGE_ORIGIN = "https://vault.iconn.app";
const PUBLIC_STORAGE_PATH = "/storage/v1/object/public/";

// Sharing only: do not change persisted image URLs or the storage client.
export function resolveBadgeImageLink(value, supabaseUrl) {
  if (typeof value !== "string" || !supabaseUrl) return value;
  try {
    const source = new URL(supabaseUrl);
    const image = new URL(value);
    if (!["http:", "https:"].includes(source.protocol)
      || image.origin !== source.origin
      || image.username || image.password
      || !image.pathname.startsWith(PUBLIC_STORAGE_PATH)) return value;

    // Replace only the literal authority, preserving the original encoded suffix.
    const parts = value.match(/^https?:\/\/[^/?#]+(\/[^]*)$/i);
    if (!parts || !parts[1].startsWith(PUBLIC_STORAGE_PATH)) return value;
    return BADGE_IMAGE_ORIGIN + parts[1];
  } catch {
    return value;
  }
}