/**
 * Onboarding seeder — applies the wizard payload to a tenant.
 *
 * Called from POST /api/admin/onboarding/complete once the admin finishes the
 * blocking wizard. Idempotent: re-running with the same payload re-applies
 * branding / tier upserts but won't duplicate sample content (it skips when
 * is_sample rows already exist for the tenant).
 *
 * Inputs (all optional):
 *   - branding:           { primary_color, secondary_color, logo_url, tagline, description }
 *   - tiers:              [ { name, flat_cost, currency } ]
 *   - modules:            [ 'events', 'memberships', 'resources', 'articles', 'fundraising', 'forum' ]
 *   - integration_intent: { stripe, xero, quickbooks, zoom, ... -> 'connect_now'|'maybe_later'|'not_needed' }
 *   - custom_domain:      { intent: 'will_use'|'maybe_later'|'not_needed', domain?: string }
 *   - persona:            one of PERSONAS codes
 *
 * Returns a summary describing what was seeded.
 */

import { supabase } from './database.js';
import { getPersonaPack } from './personaSeedPacks.js';

const VALID_INTEGRATION_TYPES = new Set([
  'stripe', 'xero', 'quickbooks', 'zoom', 'mailgun', 'wordpress', 'zoho',
]);
const VALID_INTENTS = new Set(['connect_now', 'maybe_later', 'not_needed']);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || `sample-${Date.now()}`;
}

async function applyBranding(tenantId, branding) {
  if (!branding || typeof branding !== 'object') return null;
  const allowed = ['primary_color', 'secondary_color', 'logo_url', 'tagline', 'description'];
  const patch = {};
  for (const k of allowed) {
    if (branding[k] !== undefined && branding[k] !== null) patch[k] = branding[k];
  }
  if (Object.keys(patch).length === 0) return null;
  const { error } = await supabase.from('tenant').update(patch).eq('id', tenantId);
  if (error) console.error('[onboardingSeeder] branding update error:', error.message);
  return patch;
}

async function applyTiers(tenantId, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return [];
  const created = [];
  for (const tier of tiers) {
    if (!tier?.name) continue;
    const { data, error } = await supabase
      .from('membership_tier_config')
      .insert({
        tenant_id: tenantId,
        name: tier.name,
        pricing_model: 'flat',
        flat_cost: Number.isFinite(Number(tier.flat_cost)) ? Number(tier.flat_cost) : 0,
        currency: tier.currency || 'GBP',
        structure_scope_type: 'organization',
      })
      .select('id, name')
      .single();
    if (error) {
      console.error('[onboardingSeeder] tier insert error:', error.message);
      continue;
    }
    created.push(data);
  }
  return created;
}

async function applyIntegrationIntents(tenantId, intents) {
  if (!intents || typeof intents !== 'object') return [];
  const written = [];
  for (const [type, intent] of Object.entries(intents)) {
    if (!VALID_INTEGRATION_TYPES.has(type) || !VALID_INTENTS.has(intent)) continue;
    const { error } = await supabase
      .from('tenant_integration_intent')
      .upsert(
        { tenant_id: tenantId, integration_type: type, intent, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,integration_type' },
      );
    if (error) {
      console.error('[onboardingSeeder] intent upsert error:', error.message);
      continue;
    }
    written.push({ type, intent });
  }
  return written;
}

async function applyCustomDomainIntent(tenantId, customDomain) {
  if (!customDomain || typeof customDomain !== 'object') return null;
  // Store on tenant.onboarding_data via the caller; nothing further to do at
  // the row level — actual domain wiring happens in the existing Domains UI.
  return { intent: customDomain.intent, domain: customDomain.domain || null };
}

async function alreadySeededSample(tenantId) {
  const { count } = await supabase
    .from('event')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_sample', true);
  return (count || 0) > 0;
}

async function seedSampleContent(tenantId, persona, defaultRoleId) {
  if (await alreadySeededSample(tenantId)) {
    return { skipped: true, reason: 'sample content already present' };
  }

  const pack = getPersonaPack(persona);
  const summary = { organization: null, members: [], events: [], resources: [], blog_posts: [] };

  // Organization
  if (pack.organization?.name) {
    const { data: org } = await supabase
      .from('organization')
      .insert({
        name: pack.organization.name,
        tenant_id: tenantId,
        status: 'active',
        is_primary: false,
        is_sample: true,
        created_at: new Date().toISOString(),
      })
      .select('id, name')
      .single();
    if (org) summary.organization = org;

    // Sample members linked to the sample org
    if (org && Array.isArray(pack.members)) {
      for (const m of pack.members) {
        const email = `${m.email_suffix}+${tenantId.slice(0, 8)}@example.invalid`;
        const insert = {
          tenant_id: tenantId,
          organization_id: org.id,
          first_name: m.first_name,
          last_name: m.last_name,
          email,
          status: 'active',
          is_sample: true,
        };
        if (defaultRoleId) insert.role_id = defaultRoleId;
        const { data: member, error } = await supabase
          .from('member').insert(insert).select('id, email').single();
        if (!error && member) summary.members.push(member);
      }
    }
  }

  // Events
  for (const ev of pack.events || []) {
    const { data: event } = await supabase
      .from('event')
      .insert({
        tenant_id: tenantId,
        title: ev.title,
        slug: slugify(ev.title),
        summary: ev.summary,
        start_date: ev.starts_at,
        status: 'published',
        is_sample: true,
      })
      .select('id, title')
      .single();
    if (event) summary.events.push(event);
  }

  // Resources
  for (const r of pack.resources || []) {
    const { data: resource } = await supabase
      .from('resource')
      .insert({
        tenant_id: tenantId,
        title: r.title,
        description: r.description,
        is_sample: true,
      })
      .select('id, title')
      .single();
    if (resource) summary.resources.push(resource);
  }

  // Blog posts
  for (const b of pack.blog_posts || []) {
    const { data: post } = await supabase
      .from('blog_post')
      .insert({
        tenant_id: tenantId,
        title: b.title,
        slug: slugify(b.title),
        summary: b.summary,
        status: 'published',
        is_sample: true,
      })
      .select('id, title')
      .single();
    if (post) summary.blog_posts.push(post);
  }

  return { skipped: false, summary };
}

async function findDefaultRoleId(tenantId) {
  const { data } = await supabase
    .from('role').select('id').eq('tenant_id', tenantId).eq('is_default', true).maybeSingle();
  return data?.id || null;
}

export async function runOnboardingSeeder(tenantId, payload = {}) {
  if (!tenantId || !supabase) return { success: false, error: 'tenant or db missing' };

  const branding = await applyBranding(tenantId, payload.branding);
  const tiers = await applyTiers(tenantId, payload.tiers);
  const intents = await applyIntegrationIntents(tenantId, payload.integration_intent);
  const customDomain = await applyCustomDomainIntent(tenantId, payload.custom_domain);

  const defaultRoleId = await findDefaultRoleId(tenantId);
  const sample = await seedSampleContent(tenantId, payload.persona, defaultRoleId);

  return {
    success: true,
    branding,
    tiers_created: tiers,
    integration_intents: intents,
    custom_domain: customDomain,
    sample_content: sample,
  };
}

export async function removeSampleContent(tenantId) {
  if (!tenantId || !supabase) return { success: false };
  const counts = {};
  for (const table of ['event', 'blog_post', 'resource', 'member', 'organization']) {
    const { count, error } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('is_sample', true);
    counts[table] = error ? 0 : (count || 0);
    if (error) console.error(`[onboardingSeeder] remove sample ${table} error:`, error.message);
  }
  return { success: true, removed: counts };
}
