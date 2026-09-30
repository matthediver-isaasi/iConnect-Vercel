import { base44 } from "@/api/base44Client";

function getStoredMemberIdentifier() {
  try {
    const raw = localStorage.getItem('agcas_member');
    if (!raw) return null;
    const member = JSON.parse(raw);
    if (member?.sessionExpiry && new Date(member.sessionExpiry) < new Date()) return null;
    return member?.email || member?.id || null;
  } catch {
    return null;
  }
}

// Resource views are unique per resource/member in the database, so this
// best-effort helper is safe to call from cards embedded outside /Resources.
export async function recordEmbeddedResourceView(resourceId) {
  const userIdentifier = getStoredMemberIdentifier();
  if (!resourceId || !userIdentifier) return;
  try {
    await base44.entities.ResourceView.create({
      resource_id: resourceId,
      user_identifier: userIdentifier,
      is_member: true,
      viewed_at: new Date().toISOString(),
    });
  } catch {
    // Duplicate views and signed-out/embed contexts must not block navigation.
  }
}