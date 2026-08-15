// Demo organisation logos — storage + linking helpers.
//
// AI logos are generated OUTSIDE this module (image generation is not
// available to the server/seed runtime); this module owns everything else:
// deterministic storage paths, uploads, and the provenance-safe write of
// organization.logo_url.
//
// Provenance rule (same as demo member avatars): an organisation's existing
// logo_url is NEVER replaced — writes are fill-null only, enforced at the
// database with a compare-and-set, so an admin-uploaded or concurrently-set
// logo always wins.

import crypto from 'crypto';

export const DEMO_LOGO_BUCKET = 'demo-avatars';

/** Deterministic per-org storage path so re-runs overwrite, not duplicate. */
export function demoLogoStoragePath(tenantId, orgName) {
  const key = crypto.createHash('sha1').update(String(orgName).trim()).digest('hex');
  return `${tenantId}/org-logo-${key}.png`;
}

/**
 * Demo organisations eligible for a logo: rows on the tenant that carry the
 * seed's provenance marker (is_sample = true) with an empty logo_url. The
 * is_sample predicate is required: it prevents accidentally overwriting a
 * manually-configured logo on a real organisation that happens to share the
 * same tenant.
 */
export async function listDemoOrgsNeedingLogos(sb, tenantId) {
  const { data, error } = await sb
    .from('organization')
    .select('id, name, logo_url')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .is('logo_url', null)
    .order('name')
    .limit(2000);
  if (error) throw new Error(`demo logo org list failed: ${error.message}`);
  return data || [];
}

/** Upload (upsert) a PNG/JPEG buffer to the deterministic path; returns the public URL. */
export async function uploadDemoLogo(sb, { tenantId, orgName, buffer, contentType = 'image/png', bucket = DEMO_LOGO_BUCKET }) {
  const path = demoLogoStoragePath(tenantId, orgName);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`demo logo upload failed for ${orgName}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo logo public URL missing for ${orgName}`);
  return data.publicUrl;
}

/**
 * Fill-null-only write of organization.logo_url. The UPDATE itself
 * re-checks logo_url IS NULL (compare-and-set), so a logo assigned
 * between read and write is never overwritten. Returns true when the org
 * ends up with the given URL.
 */
export async function applyDemoOrgLogo({ sb, tenantId, orgId, url, log = console.log }) {
  const { data: org, error } = await sb
    .from('organization').select('id, name, logo_url')
    .eq('id', orgId).eq('tenant_id', tenantId).eq('is_sample', true).maybeSingle();
  if (error) throw new Error(`org lookup failed: ${error.message}`);
  if (!org) throw new Error('organization row not found among the demo tenant\'s sample orgs');
  if (org.logo_url === url) return true;
  if (org.logo_url) {
    log(`[demo-logo] ${org.name || orgId} keeps existing logo; not replacing`);
    return false;
  }
  const { data: updRows, error: upErr } = await sb
    .from('organization').update({ logo_url: url })
    .eq('id', orgId).eq('tenant_id', tenantId).eq('is_sample', true)
    .is('logo_url', null)
    .select('id');
  if (upErr) throw new Error(`logo link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-logo] ${org.name || orgId} got a logo concurrently; not overwriting`);
    return false;
  }
  return true;
}

/**
 * Seed-time pass: link organisations missing a logo to ALREADY-GENERATED logos
 * in storage (matched by deterministic path). The seed runtime cannot
 * generate images, so orgs without a stored logo are counted and
 * reported — callers should warn, never fail the seed over this.
 * Returns { linked, missing } (missing = demo orgs with no stored logo).
 */
export async function linkExistingDemoLogos({ sb, tenantId, bucket = DEMO_LOGO_BUCKET, log = console.log }) {
  const orgs = await listDemoOrgsNeedingLogos(sb, tenantId);
  if (orgs.length === 0) return { linked: 0, missing: 0 };

  // One listing of the tenant's folder beats a per-org existence probe.
  const stored = new Set();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error } = await sb.storage.from(bucket).list(tenantId, { limit: 1000, offset });
    if (error) throw new Error(`demo logo storage list failed: ${error.message}`);
    for (const f of files || []) stored.add(`${tenantId}/${f.name}`);
    if (!files || files.length < 1000) break;
  }

  let linked = 0, missing = 0;
  for (const org of orgs) {
    const path = demoLogoStoragePath(tenantId, org.name);
    if (!stored.has(path)) { missing++; continue; }
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    if (await applyDemoOrgLogo({ sb, tenantId, orgId: org.id, url: data.publicUrl, log })) linked++;
  }
  if (missing > 0) {
    log(`[demo-logo] warning: ${missing} demo org(s) have no generated logo in storage yet — run the logo generation pass to fill them`);
  }
  return { linked, missing };
}
