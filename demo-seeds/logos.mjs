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
import { resolveDemoPrimaryOrganizationId } from './engine.mjs';

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
 * Fill-null-only link of the PRIMARY organisation's logo_url from the
 * tenant's branding (tenant.logo_url, falling back to header_logo_url).
 *
 * The primary organisation is created by provisioning with is_sample=false,
 * so the is_sample-scoped pass in linkExistingDemoLogos never touches it.
 * This function bridges that gap.
 *
 * Behaviour:
 *   - warn-don't-fail when the tenant has no branding logo yet
 *   - fill-null compare-and-set: an existing org logo is never replaced
 *   - returns true when the org ends up with a logo (linked or already set)
 */
export async function linkPrimaryOrgLogo({ sb, tenantId, log = console.log }) {
  // Resolve the primary org (throws if missing or ambiguous).
  const primaryOrgId = await resolveDemoPrimaryOrganizationId(sb, tenantId);

  // Read the tenant's branding logo.
  const { data: tenant, error: tErr } = await sb
    .from('tenant')
    .select('logo_url, header_logo_url')
    .eq('id', tenantId)
    .maybeSingle();
  if (tErr) throw new Error(`tenant branding lookup failed: ${tErr.message}`);
  const brandingLogo = tenant?.logo_url || tenant?.header_logo_url || null;
  if (!brandingLogo) {
    log('[demo-logo] warning: tenant has no branding logo yet — skipping primary org logo link');
    return false;
  }

  // Read the primary org's current logo_url.
  const { data: org, error: oErr } = await sb
    .from('organization')
    .select('id, name, logo_url')
    .eq('id', primaryOrgId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (oErr) throw new Error(`primary org lookup failed: ${oErr.message}`);
  if (!org) throw new Error('primary organisation row not found');

  if (org.logo_url) {
    log(`[demo-logo] primary org ${org.name || primaryOrgId} already has a logo; not replacing`);
    return false;
  }

  // Compare-and-set fill-null write (re-checks IS NULL so a concurrent set wins).
  const { data: updRows, error: upErr } = await sb
    .from('organization')
    .update({ logo_url: brandingLogo })
    .eq('id', primaryOrgId)
    .eq('tenant_id', tenantId)
    .is('logo_url', null)
    .select('id');
  if (upErr) throw new Error(`primary org logo link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-logo] primary org ${org.name || primaryOrgId} got a logo concurrently; not overwriting`);
    return false;
  }
  log(`[demo-logo] primary org ${org.name || primaryOrgId} linked to tenant branding logo`);
  return true;
}

/**
 * Seed-time pass: link organisations missing a logo to ALREADY-GENERATED logos
 * in storage (matched by deterministic path). The seed runtime cannot
 * generate images, so orgs without a stored logo are counted and
 * reported — callers should warn, never fail the seed over this.
 *
 * Also links the PRIMARY organisation's logo from the tenant's branding
 * (fill-null, warn-don't-fail).
 *
 * Returns { linked, missing } (missing = demo orgs with no stored logo).
 */
export async function linkExistingDemoLogos({ sb, tenantId, bucket = DEMO_LOGO_BUCKET, log = console.log }) {
  const orgs = await listDemoOrgsNeedingLogos(sb, tenantId);

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

  // Also link the primary org from tenant branding (warn-don't-fail).
  try {
    if (await linkPrimaryOrgLogo({ sb, tenantId, log })) linked++;
  } catch (e) {
    log(`[demo-logo] warning: primary org logo link failed — ${e.message}`);
  }

  return { linked, missing };
}
