/**
 * AI Design Studio — usage metering, allowances & cost estimates
 * (Task #2852, spec §27).
 *
 * Pure decision logic (`evaluateAllowance`) is separated from the Supabase
 * wrappers so limits are unit-testable without a database. The discriminated
 * result shape mirrors api/_lib/planQuota.js: `{ ok: true, warning? }` or
 * `{ ok: false, status, body }` ready to feed to res.status().json().
 */

import crypto from 'node:crypto';

/** Operation types recorded in ai_usage_event (spec §27 distinctions). */
export const AI_OPERATIONS = [
  'generation',            // full composition creation
  'section_generation',    // single-section creation
  'edit',                  // content/layout patch proposal accepted
  'redesign',              // section/complete redesign
  'image_generation',
  'image_edit',
  'visual_review',
];

/** Which operations count against the monthly GENERATION allowance. */
const GENERATION_OPS = new Set(['generation', 'section_generation', 'edit', 'redesign', 'visual_review']);
/** Which operations count against the monthly IMAGE allowance. */
const IMAGE_OPS = new Set(['image_generation', 'image_edit']);

/** Rough per-unit cost estimates (USD) — reported as ESTIMATES only. */
export const COST_ESTIMATES = {
  textCall: 0.003,   // one gpt-4o-mini json call (avg prompt+completion)
  image: 0.04,       // one gpt-image-1 image
  reviewCycle: 0.01, // one vision review pass
};

export function estimateCost(units = {}) {
  const textCalls = Number(units.textCalls) || 0;
  const images = Number(units.images) || 0;
  const reviewCycles = Number(units.reviewCycles) || 0;
  const cost = textCalls * COST_ESTIMATES.textCall
    + images * COST_ESTIMATES.image
    + reviewCycles * COST_ESTIMATES.reviewCycle;
  return Math.round(cost * 100000) / 100000;
}

/** Duplicate-submission window (same user, same op, same prompt). */
export const DEDUPE_WINDOW_MS = 30 * 1000;
/** Per-user rate-limit window. */
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export function makeDedupeHash({ tenantId, memberId, operation, prompt }) {
  return crypto
    .createHash('sha256')
    .update([tenantId || '', memberId || '', operation || '', String(prompt || '').trim().toLowerCase()].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

export function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function blocked(code, message, extra = {}) {
  return {
    ok: false,
    status: code === 'AI_RATE_LIMITED' || code === 'AI_DUPLICATE_SUBMISSION' ? 429 : 403,
    body: { error: message, code, ...extra },
  };
}

/**
 * Pure allowance decision. All usage numbers are pre-fetched by the caller.
 *
 * @param {object} args
 * @param {object} args.settings   effective studio settings
 * @param {string} args.operation  one of AI_OPERATIONS
 * @param {number} args.monthGenerations  generation-family events this month (tenant)
 * @param {number} args.monthImages       image-family events this month (tenant)
 * @param {number} args.monthCost         estimated cost this month (tenant, USD)
 * @param {number} args.userHourEvents    this user's events in the last hour
 * @param {boolean} args.isDuplicate      identical submission inside the dedupe window
 * @param {number} [args.promptLength]
 * @param {string} [args.creativity]
 * @returns {{ok:true, warning?:object} | {ok:false, status:number, body:object}}
 */
export function evaluateAllowance({
  settings,
  operation,
  monthGenerations = 0,
  monthImages = 0,
  monthCost = 0,
  userHourEvents = 0,
  isDuplicate = false,
  promptLength,
  creativity,
}) {
  const s = settings || {};
  if (s.enabled === false) {
    return blocked('AI_STUDIO_DISABLED', 'AI Design Studio is disabled for this organisation.');
  }
  if (creativity && Array.isArray(s.permittedCreativity) && !s.permittedCreativity.includes(creativity)) {
    return blocked('AI_CREATIVITY_NOT_PERMITTED', `The "${creativity}" creativity level is not permitted for this organisation.`);
  }
  if (Number.isFinite(promptLength) && Number.isFinite(s.maxPromptLength) && promptLength > s.maxPromptLength) {
    return blocked('AI_PROMPT_TOO_LONG', `The prompt is too long (maximum ${s.maxPromptLength} characters).`, { maxPromptLength: s.maxPromptLength });
  }
  if (isDuplicate) {
    return blocked('AI_DUPLICATE_SUBMISSION', 'This looks like a duplicate of a request you just made. Please wait a moment before retrying.');
  }
  if (Number.isFinite(s.perUserHourlyLimit) && s.perUserHourlyLimit !== null && userHourEvents >= s.perUserHourlyLimit) {
    return blocked('AI_RATE_LIMITED', 'You have reached your hourly AI request limit. Please try again later.');
  }
  if (IMAGE_OPS.has(operation)) {
    if (s.allowImageGeneration === false) {
      return blocked('AI_IMAGES_DISABLED', 'AI image generation is disabled for this organisation.');
    }
    if (Number.isFinite(s.monthlyImageAllowance) && s.monthlyImageAllowance !== null && monthImages >= s.monthlyImageAllowance) {
      return blocked('AI_IMAGE_LIMIT', 'This organisation has used its monthly AI image allowance.', { allowance: s.monthlyImageAllowance, used: monthImages });
    }
  }
  if (GENERATION_OPS.has(operation)
    && Number.isFinite(s.monthlyGenerationAllowance) && s.monthlyGenerationAllowance !== null
    && monthGenerations >= s.monthlyGenerationAllowance) {
    return blocked('AI_MONTHLY_LIMIT', 'This organisation has used its monthly AI generation allowance.', { allowance: s.monthlyGenerationAllowance, used: monthGenerations });
  }
  if (Number.isFinite(s.hardCostLimit) && s.hardCostLimit !== null && monthCost >= s.hardCostLimit) {
    return blocked('AI_COST_LIMIT', 'This organisation has reached its monthly AI spending limit.', { limit: s.hardCostLimit });
  }

  // Warning threshold (soft): flag when the dominant allowance crosses N%.
  let warning;
  const pct = Number.isFinite(s.warningThresholdPct) ? s.warningThresholdPct : 80;
  if (GENERATION_OPS.has(operation) && Number.isFinite(s.monthlyGenerationAllowance) && s.monthlyGenerationAllowance > 0) {
    const usedPct = (monthGenerations / s.monthlyGenerationAllowance) * 100;
    if (usedPct >= pct) {
      warning = { code: 'AI_USAGE_WARNING', message: `This organisation has used ${Math.floor(usedPct)}% of its monthly AI generation allowance.`, usedPct: Math.floor(usedPct) };
    }
  }
  if (IMAGE_OPS.has(operation) && Number.isFinite(s.monthlyImageAllowance) && s.monthlyImageAllowance > 0) {
    const usedPct = (monthImages / s.monthlyImageAllowance) * 100;
    if (usedPct >= pct) {
      warning = { code: 'AI_USAGE_WARNING', message: `This organisation has used ${Math.floor(usedPct)}% of its monthly AI image allowance.`, usedPct: Math.floor(usedPct) };
    }
  }
  return { ok: true, ...(warning ? { warning } : {}) };
}

/** Aggregate ai_usage_event rows into a month summary (pure). */
export function summarizeUsageRows(rows = []) {
  const summary = {
    totalEvents: 0,
    generations: 0,
    images: 0,
    reviews: 0,
    estimatedCost: 0,
    byOperation: {},
    byMember: {},
  };
  for (const r of rows) {
    if (!r || r.status === 'blocked') continue;
    summary.totalEvents += 1;
    if (GENERATION_OPS.has(r.operation) && r.operation !== 'visual_review') summary.generations += 1;
    if (IMAGE_OPS.has(r.operation)) summary.images += 1;
    if (r.operation === 'visual_review') summary.reviews += 1;
    summary.estimatedCost += Number(r.estimated_cost) || 0;
    summary.byOperation[r.operation] = (summary.byOperation[r.operation] || 0) + 1;
    if (r.member_id) summary.byMember[r.member_id] = (summary.byMember[r.member_id] || 0) + 1;
  }
  summary.estimatedCost = Math.round(summary.estimatedCost * 100000) / 100000;
  return summary;
}

// ---------------------------------------------------------------------------
// Supabase wrappers
// ---------------------------------------------------------------------------

/**
 * Gather the live counters and run the allowance decision for one request.
 * Never throws on counter-read failures — metering must not take the product
 * down; on read failure counters default to 0 (fail-open, logged).
 */
export async function checkAiUsageAllowance(supabase, {
  tenantId, memberId, settings, operation, prompt, creativity,
}) {
  const { start } = monthWindow();
  const dedupeHash = makeDedupeHash({ tenantId, memberId, operation, prompt });
  let monthGenerations = 0;
  let monthImages = 0;
  let monthCost = 0;
  let userHourEvents = 0;
  let isDuplicate = false;
  try {
    const sinceHour = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const sinceDedupe = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const [monthRes, hourRes, dupRes] = await Promise.all([
      supabase
        .from('ai_usage_event')
        .select('operation, estimated_cost, status')
        .eq('tenant_id', tenantId)
        .gte('created_at', start)
        .limit(5000),
      memberId
        ? supabase
          .from('ai_usage_event')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId)
          .neq('status', 'blocked')
          .gte('created_at', sinceHour)
        : Promise.resolve({ count: 0 }),
      prompt
        ? supabase
          .from('ai_usage_event')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('dedupe_hash', dedupeHash)
          .neq('status', 'blocked')
          .gte('created_at', sinceDedupe)
        : Promise.resolve({ count: 0 }),
    ]);
    const rows = monthRes?.data || [];
    for (const r of rows) {
      if (r.status === 'blocked') continue;
      if (IMAGE_OPS.has(r.operation)) monthImages += 1;
      else if (GENERATION_OPS.has(r.operation)) monthGenerations += 1;
      monthCost += Number(r.estimated_cost) || 0;
    }
    userHourEvents = hourRes?.count || 0;
    isDuplicate = (dupRes?.count || 0) > 0;
  } catch (err) {
    console.error('[aiUsage] counter read failed (fail-open):', err.message);
  }
  const decision = evaluateAllowance({
    settings, operation, monthGenerations, monthImages, monthCost,
    userHourEvents, isDuplicate,
    promptLength: prompt !== undefined ? String(prompt || '').length : undefined,
    creativity,
  });
  return { ...decision, dedupeHash };
}

/** Record one usage/audit event. Failures are logged, never thrown. */
export async function recordAiUsageEvent(supabase, {
  tenantId, memberId = null, pageId = null, compositionId = null, sectionId = null,
  operation, model = null, units = {}, status = 'succeeded', dedupeHash = null,
}) {
  try {
    await supabase.from('ai_usage_event').insert({
      tenant_id: tenantId,
      member_id: memberId,
      page_id: pageId,
      composition_id: compositionId,
      section_id: sectionId,
      operation,
      model,
      units,
      estimated_cost: estimateCost(units),
      status,
      dedupe_hash: dedupeHash,
    });
  } catch (err) {
    console.error('[aiUsage] failed to record usage event:', err.message);
  }
}
