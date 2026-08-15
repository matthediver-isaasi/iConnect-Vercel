// Demo member avatars — storage + linking helpers.
//
// AI headshots are generated OUTSIDE this module (image generation is not
// available to the server/seed runtime); this module owns everything else:
// deterministic storage paths, uploads, and the provenance-safe write of
// member.profile_photo_url.
//
// Provenance rule (same as demo staff role/organisation links): a member's
// existing profile_photo_url is NEVER replaced — writes are fill-null only,
// enforced at the database with a compare-and-set, so an admin-uploaded or
// concurrently-set photo always wins.

import crypto from 'crypto';

export const DEMO_AVATAR_BUCKET = 'demo-avatars';

/** Deterministic per-member storage path so re-runs overwrite, not duplicate. */
export function demoAvatarStoragePath(tenantId, email) {
  const key = crypto.createHash('sha1').update(String(email).trim().toLowerCase()).digest('hex');
  return `${tenantId}/${key}.jpg`;
}

/**
 * Demo members eligible for an avatar: rows on the tenant that carry the
 * seed's provenance marker (is_sample = true — set on every seeded member
 * including the repaired owner) AND whose email is on the reserved demo
 * domain, with an empty profile_photo_url. Both predicates are required: the
 * domain alone would match a manually-created non-sample placeholder.
 */
export async function listDemoMembersNeedingAvatars(sb, tenantId, { demoDomain = 'aesp.example.com' } = {}) {
  const { data, error } = await sb
    .from('member')
    .select('id, email, first_name, last_name, job_title, profile_photo_url')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .ilike('email', `%@${demoDomain}`)
    .is('profile_photo_url', null)
    .order('email')
    .limit(2000);
  if (error) throw new Error(`demo avatar member list failed: ${error.message}`);
  return data || [];
}

/** Upload (upsert) a JPEG buffer to the deterministic path; returns the public URL. */
export async function uploadDemoAvatar(sb, { tenantId, email, buffer, bucket = DEMO_AVATAR_BUCKET }) {
  const path = demoAvatarStoragePath(tenantId, email);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw new Error(`demo avatar upload failed for ${email}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo avatar public URL missing for ${email}`);
  return data.publicUrl;
}

/**
 * Fill-null-only write of member.profile_photo_url. The UPDATE itself
 * re-checks profile_photo_url IS NULL (compare-and-set), so a photo assigned
 * between read and write is never overwritten. Returns true when the member
 * ends up with the given URL.
 */
export async function applyDemoMemberAvatar({ sb, tenantId, memberId, url, log = console.log }) {
  const { data: m, error } = await sb
    .from('member').select('id, email, profile_photo_url')
    .eq('id', memberId).eq('tenant_id', tenantId).eq('is_sample', true).maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!m) throw new Error('member row not found among the demo tenant\'s sample members');
  if (m.profile_photo_url === url) return true;
  if (m.profile_photo_url) {
    log(`[demo-avatar] ${m.email || memberId} keeps existing photo; not replacing`);
    return false;
  }
  const { data: updRows, error: upErr } = await sb
    .from('member').update({ profile_photo_url: url })
    .eq('id', memberId).eq('tenant_id', tenantId).eq('is_sample', true)
    .is('profile_photo_url', null)
    .select('id');
  if (upErr) throw new Error(`avatar link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-avatar] ${m.email || memberId} got a photo concurrently; not overwriting`);
    return false;
  }
  return true;
}

/**
 * Seed-time pass: link members missing a photo to ALREADY-GENERATED avatars
 * in storage (matched by deterministic path). The seed runtime cannot
 * generate images, so members without a stored avatar are counted and
 * reported — callers should warn, never fail the seed over this.
 * Returns { linked, missing } (missing = demo members with no stored avatar).
 */
export async function linkExistingDemoAvatars({ sb, tenantId, bucket = DEMO_AVATAR_BUCKET, demoDomain, log = console.log }) {
  const members = await listDemoMembersNeedingAvatars(sb, tenantId, demoDomain ? { demoDomain } : {});
  if (members.length === 0) return { linked: 0, missing: 0 };

  // One listing of the tenant's folder beats a per-member existence probe.
  const stored = new Set();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error } = await sb.storage.from(bucket).list(tenantId, { limit: 1000, offset });
    if (error) throw new Error(`demo avatar storage list failed: ${error.message}`);
    for (const f of files || []) stored.add(`${tenantId}/${f.name}`);
    if (!files || files.length < 1000) break;
  }

  let linked = 0, missing = 0;
  for (const m of members) {
    const path = demoAvatarStoragePath(tenantId, m.email);
    if (!stored.has(path)) { missing++; continue; }
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    if (await applyDemoMemberAvatar({ sb, tenantId, memberId: m.id, url: data.publicUrl, log })) linked++;
  }
  if (missing > 0) {
    log(`[demo-avatar] warning: ${missing} demo member(s) have no generated headshot in storage yet — run the avatar generation pass (see demo-seeds/README.md, "Images (avatars & logos)")`);
  }
  return { linked, missing };
}
