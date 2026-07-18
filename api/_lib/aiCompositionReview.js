/**
 * AI Composition visual review — Phase 4 (Task #2852, spec §13 stage 9).
 *
 * Bounded review-and-correct cycle: a vision-capable model reviews the
 * rendered composition (client-captured screenshots per breakpoint, plus the
 * structured document) against spacing/alignment/hierarchy/brand criteria,
 * and may propose a small corrective patch. Each cycle's patch is applied
 * through the SAME safety gates as any other edit (patch validation, schema
 * validation, protected-value diff must be empty) and the loop is hard-capped
 * by maxCycles. A failed or unsafe correction ends the loop with the last
 * valid document — never a broken one.
 *
 * Pure/DI: `callVision({ system, user, images })` returns raw string JSON.
 */

import { validateComposition, validatePatch } from './aiCompositionSchema.js';
import { applyPatch, diffProtectedValues } from './aiCompositionPatch.js';
import { runCompositionValidation } from './aiCompositionValidation.js';

export const MAX_REVIEW_CYCLES_CAP = 3;
export const REVIEW_SEVERITIES = ['minor', 'moderate', 'major'];

export function buildReviewPrompt({ doc, validation, brand, cycle }) {
  const system = `You are a senior art director reviewing a rendered web design at desktop, tablet and mobile breakpoints. Assess: alignment, spacing balance, visual hierarchy, colour/brand consistency, text legibility, awkward overlaps, and overall polish.
Respond ONLY with JSON:
{ "score": 1-10, "findings": [ { "severity": "minor"|"moderate"|"major", "issue": string, "elementId": string|null, "breakpoint": "desktop"|"tablet"|"mobile"|null } ], "ops": [PatchOp] }
Rules:
- "ops" may ONLY contain "update_style" operations (optionally with "breakpoint") and MUST be minimal, safe corrections for the findings. Empty array if the design is acceptable or a fix is risky.
- NEVER change text content, links, images, prices, dates or names.
- This is correction cycle ${cycle}; prefer no-ops over churn.`;
  const user = `BRAND:
"""
${brand ? JSON.stringify(brand).slice(0, 1500) : 'n/a'}
"""
AUTOMATED VALIDATION SUMMARY:
"""
${JSON.stringify({ critical: validation?.critical?.length || 0, warnings: (validation?.warnings || []).slice(0, 10) }).slice(0, 2000)}
"""
COMPOSITION DOCUMENT (structured source of truth):
"""
${JSON.stringify(doc).slice(0, 20000)}
"""`;
  return { system, user };
}

export function parseReviewResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    return { ok: false, error: 'Visual review returned an unreadable response.' };
  }
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
      .filter((f) => f && typeof f.issue === 'string')
      .slice(0, 20)
      .map((f) => ({
        severity: REVIEW_SEVERITIES.includes(f.severity) ? f.severity : 'minor',
        issue: String(f.issue).slice(0, 300),
        elementId: typeof f.elementId === 'string' ? f.elementId : null,
        breakpoint: ['desktop', 'tablet', 'mobile'].includes(f.breakpoint) ? f.breakpoint : null,
      }))
    : [];
  const ops = Array.isArray(parsed.ops) ? parsed.ops.slice(0, 10) : [];
  const score = Number.isFinite(Number(parsed.score))
    ? Math.max(1, Math.min(10, Number(parsed.score)))
    : null;
  return { ok: true, score, findings, ops };
}

/** Only cosmetic style tweaks are allowed from the reviewer. */
export function sanitizeReviewOps(ops) {
  return (ops || []).filter((op) => op && op.op === 'update_style');
}

/**
 * Run the bounded visual review loop.
 * Returns { doc, changed, cycles: [{ score, findings, applied, opCount }] }.
 * The returned doc is ALWAYS valid (falls back to the input on any failure).
 */
export async function runVisualReview({ doc, brand, callVision, images = [], maxCycles = 1 }) {
  const cap = Math.max(0, Math.min(MAX_REVIEW_CYCLES_CAP, Number(maxCycles) || 0));
  let current = doc;
  let changed = false;
  const cycles = [];
  for (let cycle = 1; cycle <= cap; cycle += 1) {
    const validation = runCompositionValidation(current);
    const { system, user } = buildReviewPrompt({ doc: current, validation, brand, cycle });
    let raw;
    try {
      raw = await callVision({ system, user, images });
    } catch (err) {
      cycles.push({ cycle, error: 'Visual review was unavailable.', applied: false });
      break;
    }
    const review = parseReviewResponse(raw);
    if (!review.ok) {
      cycles.push({ cycle, error: review.error, applied: false });
      break;
    }
    const ops = sanitizeReviewOps(review.ops);
    const record = {
      cycle, score: review.score, findings: review.findings, opCount: ops.length, applied: false,
    };
    if (ops.length === 0) {
      cycles.push(record);
      break; // nothing to fix → done
    }
    const patchCheck = validatePatch(ops);
    if (patchCheck.ok) {
      const applied = applyPatch(current, ops);
      if (applied.ok) {
        const next = applied.doc;
        const schemaCheck = validateComposition(next);
        const protectedDiff = diffProtectedValues(current, next);
        const nextValidation = runCompositionValidation(next);
        // Corrections may never introduce critical issues or touch protected values.
        if (schemaCheck.ok && protectedDiff.length === 0 && nextValidation.critical.length <= validation.critical.length) {
          current = next;
          changed = true;
          record.applied = true;
        }
      }
    }
    cycles.push(record);
    if (!record.applied) break; // unsafe correction → stop with last valid doc
  }
  return { doc: current, changed, cycles };
}
