/**
 * AI Design Studio — per-tenant governance settings (Task #2852, spec §28).
 *
 * One sanitized jsonb blob per tenant in `ai_design_studio_settings`.
 * Defaults live here; the DB row only stores explicit overrides. Branding
 * (colours, fonts, logos) is NOT duplicated here — the generation pipeline
 * already assembles it from tenant branding + installed fonts; this module
 * only carries the ADDITIONAL guidance fields the admin can set.
 */

import { CREATIVITY_LEVELS } from './aiCompositionPipeline.js';

export const AI_STUDIO_DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  defaultCreativity: 'brand_led',
  permittedCreativity: ['strict', 'brand_led', 'expressive'],
  allowImageGeneration: true,
  allowGeneratedIllustration: true,
  allowAiCopy: true,
  requireFactualApproval: true,
  // Usage allowances (spec §27). null = unlimited.
  monthlyGenerationAllowance: 100,
  monthlyImageAllowance: 150,
  maxAlternatives: 5,
  maxReviewCycles: 2,
  maxPromptLength: 2000,
  maxGeneratedAssetsPerComposition: 3,
  perUserHourlyLimit: 20,
  warningThresholdPct: 80,
  hardCostLimit: null, // USD/month; null = no hard spend cap
  // Brand guidance (free text, layered onto existing tenant branding).
  toneOfVoice: '',
  illustrationGuidance: '',
  photographyGuidance: '',
  disallowedTreatments: '',
  preferredExamplePages: '',
  experimentalLayouts: true,
});

const INT_FIELDS = [
  'monthlyGenerationAllowance', 'monthlyImageAllowance', 'maxAlternatives',
  'maxReviewCycles', 'maxPromptLength', 'maxGeneratedAssetsPerComposition',
  'perUserHourlyLimit', 'warningThresholdPct',
];
const BOOL_FIELDS = [
  'enabled', 'allowImageGeneration', 'allowGeneratedIllustration',
  'allowAiCopy', 'requireFactualApproval', 'experimentalLayouts',
];
const TEXT_FIELDS = [
  'toneOfVoice', 'illustrationGuidance', 'photographyGuidance', 'disallowedTreatments',
  'preferredExamplePages',
];
const MAX_GUIDANCE_CHARS = 1000;

/** Sanitize an arbitrary settings patch into a safe, complete settings object. */
export function sanitizeStudioSettings(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...AI_STUDIO_DEFAULT_SETTINGS };
  for (const k of BOOL_FIELDS) {
    if (typeof src[k] === 'boolean') out[k] = src[k];
  }
  for (const k of INT_FIELDS) {
    if (src[k] === null) { out[k] = null; continue; }
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  // Nullable allowances stay null only where default allows; warningThresholdPct is bounded.
  if (out.warningThresholdPct !== null) {
    out.warningThresholdPct = Math.min(100, Math.max(1, out.warningThresholdPct || 80));
  }
  if (src.hardCostLimit === null) out.hardCostLimit = null;
  else if (Number.isFinite(Number(src.hardCostLimit)) && Number(src.hardCostLimit) >= 0) {
    out.hardCostLimit = Number(src.hardCostLimit);
  }
  if (CREATIVITY_LEVELS.includes(src.defaultCreativity)) out.defaultCreativity = src.defaultCreativity;
  if (Array.isArray(src.permittedCreativity)) {
    const perm = src.permittedCreativity.filter((c) => CREATIVITY_LEVELS.includes(c));
    if (perm.length > 0) out.permittedCreativity = perm;
  }
  if (!out.permittedCreativity.includes(out.defaultCreativity)) {
    out.defaultCreativity = out.permittedCreativity[0];
  }
  for (const k of TEXT_FIELDS) {
    if (typeof src[k] === 'string') out[k] = src[k].slice(0, MAX_GUIDANCE_CHARS);
  }
  // Guard: maxPromptLength must stay usable.
  if (!out.maxPromptLength || out.maxPromptLength < 50) out.maxPromptLength = 50;
  return out;
}

/** Load effective settings for a tenant (defaults merged with stored row). */
export async function loadStudioSettings(supabase, tenantId) {
  if (!supabase || !tenantId) return { ...AI_STUDIO_DEFAULT_SETTINGS };
  const { data } = await supabase
    .from('ai_design_studio_settings')
    .select('settings')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return sanitizeStudioSettings({ ...AI_STUDIO_DEFAULT_SETTINGS, ...(data?.settings || {}) });
}

/** Persist sanitized settings (upsert). Returns the stored settings. */
export async function saveStudioSettings(supabase, tenantId, patch, updatedBy = null) {
  const settings = sanitizeStudioSettings(patch);
  const { error } = await supabase
    .from('ai_design_studio_settings')
    .upsert(
      { tenant_id: tenantId, settings, updated_by: updatedBy, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id' },
    );
  if (error) throw new Error(`Failed to save AI Design Studio settings: ${error.message}`);
  return settings;
}

/** Compose the extra guidance block appended to generation prompts. */
export function buildGuidanceSummary(settings) {
  const s = settings || AI_STUDIO_DEFAULT_SETTINGS;
  const lines = [];
  if (s.toneOfVoice) lines.push(`Tone of voice guidance: ${s.toneOfVoice}`);
  if (s.illustrationGuidance) lines.push(`Illustration guidance: ${s.illustrationGuidance}`);
  if (s.photographyGuidance) lines.push(`Photography guidance: ${s.photographyGuidance}`);
  if (s.disallowedTreatments) lines.push(`Never use these treatments: ${s.disallowedTreatments}`);
  if (s.preferredExamplePages) lines.push(`Preferred example pages to take layout/style cues from: ${s.preferredExamplePages}`);
  if (s.experimentalLayouts === false) lines.push('Stick to conventional, proven layout patterns only.');
  if (s.allowGeneratedIllustration === false) lines.push('Never add generated_illustration elements — illustration is disabled for this organisation.');
  if (s.allowAiCopy === false) lines.push('Do NOT write new marketing copy. Reuse only the exact wording provided in the brief/source content; you may trim or re-order it but never invent sentences, claims or slogans.');
  return lines.join('\n');
}
