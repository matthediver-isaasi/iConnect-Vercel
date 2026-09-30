// AI Design Studio V2 — Phase 6 optional design-first workflow (Task #2910).
//
// Pure library behind the generate-v2 `visual` / `deconstruct` stages and the
// approved-visual similarity check:
//   1. Visual proposal — prompt text for gpt-image-1 desktop + mobile concept
//      images (brief + branding + content manifest + optional references).
//   2. Prompt-led revision loop — revision instructions accumulate into the
//      next concept prompt (conversation history lives on the job state).
//   3. Deconstruction — a vision call turns the APPROVED visual into layout
//      intent ONLY (sections, grid proportions, card recipes, background
//      regions, typography hierarchy, media placements, responsive intent).
//      The sanitizer strips every wording/link/fact carrier: the approved
//      visual is NEVER authoritative for copy, facts, links, semantics,
//      accessibility or functional components — those come from the
//      structured manifests.
//   4. Similarity — a vision compare between the rendered screenshots and the
//      approved visual; bounded repair cycles, then a WARNING fallback (the
//      build is delivered with a note, never rejected for similarity alone).
//
// Node-testable: no network/DB access here; all callers are injected.

const envInt = (name, fallback) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const envFloat = (name, fallback) => {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
};

/** Similarity score (0..1) the rendered build must reach vs the approved visual. */
export const VISUAL_SIMILARITY_THRESHOLD = envFloat('AIC_VISUAL_SIMILARITY_THRESHOLD', 0.7);
/** Configurable ceiling on similarity-driven repair cycles (default 2). */
export const MAX_VISUAL_REPAIR_CYCLES = envInt('AIC_MAX_VISUAL_REPAIR_CYCLES', 2);
/** Bounded revision history: only the most recent instructions ride along. */
export const MAX_VISUAL_REVISIONS = 10;

export const VISUAL_CONCEPT_BREAKPOINTS = [
  { breakpoint: 'desktop', aspectRatio: 'landscape' },
  { breakpoint: 'mobile', aspectRatio: 'portrait' },
];

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** One revision instruction, cleaned; null when unusable. */
export function normalizeRevisionInstruction(text) {
  const t = clean(text, 500);
  return t.length >= 3 ? t : null;
}

// ---------------------------------------------------------------------------
// 1 + 2. Visual concept prompt (initial and revised)
// ---------------------------------------------------------------------------

/**
 * Build the gpt-image-1 prompt for ONE breakpoint concept. `revisions` is the
 * ordered instruction history — every surviving instruction is restated so a
 * regenerated image honours the whole conversation, not just the last ask.
 */
export function buildVisualConceptPrompt({
  brief, brand = null, plan = null, options = {}, breakpoint = 'desktop', revisions = [],
}) {
  const lines = [];
  lines.push(`A high-fidelity ${breakpoint === 'mobile' ? 'MOBILE (narrow portrait, single column)' : 'DESKTOP (wide landscape)'} website design mockup — a flat UI design concept image, NOT a photo of a device. Clean edge-to-edge webpage layout filling the whole image.`);
  lines.push(`Purpose: ${clean(brief, 900)}`);
  if (brand?.name) lines.push(`Organisation: ${clean(brand.name, 120)}`);
  if (brand?.primaryColor) lines.push(`Primary brand colour ${clean(brand.primaryColor, 40)}${brand?.secondaryColor ? `, secondary ${clean(brand.secondaryColor, 40)}` : ''}.`);
  if (Array.isArray(brand?.fonts) && brand.fonts.length) {
    lines.push(`Typography in the style of ${brand.fonts.slice(0, 2).map((f) => clean(f, 60)).join(' and ')}.`);
  }
  if (brand?.tone) lines.push(`Tone: ${clean(brand.tone, 200)}`);
  if (options.direction) lines.push(`Visual direction: ${clean(options.direction, 300)}`);
  const sections = Array.isArray(plan?.sections) ? plan.sections : [];
  if (sections.length) {
    lines.push(`The page flows top to bottom through these sections in order: ${sections.slice(0, 10).map((s) => `${clean(s.purpose, 60) || 'section'} ("${clean(s.headline, 80)}")`).join('; ')}.`);
  }
  const creativity = options.creativity || 'brand_led';
  lines.push(creativity === 'strict'
    ? 'Stay very close to a conservative, established brand style.'
    : creativity === 'expressive'
      ? 'Be bold and visually adventurous while staying tasteful and on-brand.'
      : 'Balance brand consistency with fresh, modern ideas.');
  lines.push('Use realistic placeholder headlines and short greeked body text — the exact wording does not matter and will be replaced. No browser chrome, no device frame, no watermarks, no logos of real companies.');
  const revs = (revisions || []).map(normalizeRevisionInstruction).filter(Boolean).slice(-MAX_VISUAL_REVISIONS);
  if (revs.length) {
    lines.push(`REVISIONS the customer asked for — apply ALL of them: ${revs.map((r, i) => `(${i + 1}) ${r}`).join(' ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. Deconstruction of the approved visual → layout intent
// ---------------------------------------------------------------------------

export function buildDeconstructionPrompt({ plan = null } = {}) {
  const sections = Array.isArray(plan?.sections) ? plan.sections : [];
  const system = `You are a senior front-end architect reverse-engineering an APPROVED visual design concept (desktop and mobile mockup images attached) into a build blueprint. Respond ONLY with a JSON object:
{
  "sections": [ {
    "key": string,             // kebab-case identifier${sections.length ? ' — reuse the planned section keys where the visual clearly corresponds' : ''}
    "purpose": string,         // hero, proof, detail, call-to-action, …
    "layout": string,          // structural description: columns, alignment, flow
    "gridProportions": string, // e.g. "2fr 1fr", "3 equal columns", "60/40 split"
    "background": string,      // colour region / gradient / shape treatment (colours as hex or plain names)
    "cardRecipe": string,      // if cards appear: radius, elevation, internal layout — else ""
    "typography": string,      // hierarchy: relative sizes, weights, casing
    "mediaPlacement": string   // where imagery/illustration sits and its rough aspect — else ""
  } ],
  "responsiveIntent": string,  // how the mobile mockup recomposes the desktop layout
  "palette": [string]          // up to 6 dominant colours as hex codes
}

RULES:
- Describe STRUCTURE AND STYLE ONLY. Never transcribe wording, headlines, prices, dates, names, URLs or button labels from the images — the real copy comes from a separate approved content manifest.
- Never describe navigation bars, headers or footers even if the mockup shows them — they are out of scope.
- Keep every description implementable with plain CSS (grid/flex, colour, type scale).`;
  const user = sections.length
    ? `PLANNED SECTIONS (match visual regions to these keys where possible): ${sections.slice(0, 10).map((s) => `[${clean(s.key, 60)}] ${clean(s.purpose, 60)}`).join('; ')}. The first attached image is the approved DESKTOP concept, the second the approved MOBILE concept.`
    : 'The first attached image is the approved DESKTOP concept, the second the approved MOBILE concept.';
  return { system, user };
}

export function parseDeconstructionResponse(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '')); } catch {
    return { ok: false, errors: ['The deconstruction response was not valid JSON.'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['The deconstruction response was not an object.'] };
  }
  const blueprint = sanitizeDeconstruction(parsed);
  if (!blueprint || !blueprint.sections.length) {
    return { ok: false, errors: ['The deconstruction contained no usable sections.'] };
  }
  return { ok: true, blueprint };
}

// The approved visual carries NO authority over wording, facts, links,
// semantics, a11y or functional components. The sanitizer whitelists purely
// structural fields, strips URLs/emails from every value and drops quoted
// copy so nothing textual can leak from the mockup into the build contract.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w.+-]+@[\w-]+\.[\w.]+/gi;
const QUOTED_RE = /["“”'‘’][^"“”'‘’]{2,}["“”'‘’]/g;
const structural = (v, max = 300) => clean(String(v || '').replace(URL_RE, ' ').replace(QUOTED_RE, ' '), max);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function sanitizeDeconstruction(input) {
  if (!input || typeof input !== 'object') return null;
  const sections = (Array.isArray(input.sections) ? input.sections : [])
    .slice(0, 12)
    .map((s, i) => {
      if (!s || typeof s !== 'object') return null;
      const rawKey = clean(s.key, 60).toLowerCase();
      return {
        key: KEBAB_RE.test(rawKey) ? rawKey : `visual-section-${i + 1}`,
        purpose: structural(s.purpose, 80),
        layout: structural(s.layout, 300),
        gridProportions: structural(s.gridProportions, 120),
        background: structural(s.background, 200),
        cardRecipe: structural(s.cardRecipe, 300),
        typography: structural(s.typography, 300),
        mediaPlacement: structural(s.mediaPlacement, 200),
      };
    })
    .filter((s) => s && (s.layout || s.background || s.typography));
  return {
    sections,
    responsiveIntent: structural(input.responsiveIntent, 500),
    palette: (Array.isArray(input.palette) ? input.palette : [])
      .map((c) => clean(c, 20))
      .filter((c) => HEX_COLOR_RE.test(c))
      .slice(0, 6),
  };
}

/**
 * Prompt block injected into the code-generation prompt. Explicitly restates
 * manifest authority so the model never treats the mockup as a copy source.
 */
export function designBlueprintBlock(blueprint) {
  if (!blueprint || !Array.isArray(blueprint.sections) || !blueprint.sections.length) return '';
  const lines = blueprint.sections.map((s, i) => {
    const bits = [
      s.layout && `layout: ${s.layout}`,
      s.gridProportions && `grid: ${s.gridProportions}`,
      s.background && `background: ${s.background}`,
      s.cardRecipe && `cards: ${s.cardRecipe}`,
      s.typography && `type: ${s.typography}`,
      s.mediaPlacement && `media: ${s.mediaPlacement}`,
    ].filter(Boolean).join('; ');
    return `${i + 1}. [${s.key}] (${s.purpose || 'section'}) ${bits}`;
  });
  return `APPROVED VISUAL BLUEPRINT — reproduce this layout structure faithfully (the customer approved this exact visual concept; the concept images are attached):
${lines.join('\n')}
${blueprint.responsiveIntent ? `RESPONSIVE INTENT: ${blueprint.responsiveIntent}\n` : ''}${blueprint.palette?.length ? `DOMINANT PALETTE: ${blueprint.palette.join(', ')} (map onto the brand tokens where they conflict — brand tokens win)\n` : ''}THE VISUAL IS NOT AUTHORITATIVE FOR CONTENT: all wording, facts, prices, dates, links, actions and slots come ONLY from the brief, content manifest and actions/slots manifests — never transcribe text you think you see in the mockup, and never drop required actions, slots or accessibility structure to match it.
`;
}

// ---------------------------------------------------------------------------
// 4. Similarity compare (rendered build vs approved visual)
// ---------------------------------------------------------------------------

export function buildSimilarityPrompt({ breakpoints = [] } = {}) {
  const system = `You compare an APPROVED visual design concept with screenshots of the real coded implementation. Judge LAYOUT AND STYLE similarity only — structure, proportions, colour regions, typography hierarchy, media placement. The wording WILL differ by design (real copy replaced placeholder copy): text differences NEVER reduce the score. Respond ONLY with a JSON object:
{
  "similarity": number,        // 0.0 (unrecognisable) to 1.0 (faithful build of the concept)
  "differences": [string]      // up to 6 concrete layout/style divergences, most important first
}`;
  const user = `Attached in order: ${breakpoints.map((b) => `the rendered ${b} screenshot, then the approved ${b} concept`).join('; ')}. Score how faithfully the rendered implementation realises the approved concept's layout and style.`;
  return { system, user };
}

export function parseSimilarityResponse(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '')); } catch {
    return { ok: false, error: 'Similarity response was not valid JSON' };
  }
  const n = Number(parsed?.similarity);
  if (!Number.isFinite(n)) return { ok: false, error: 'Similarity response had no numeric score' };
  return {
    ok: true,
    similarity: Math.max(0, Math.min(1, n)),
    differences: (Array.isArray(parsed.differences) ? parsed.differences : [])
      .map((d) => clean(d, 300))
      .filter(Boolean)
      .slice(0, 6),
  };
}

/**
 * Decide what happens after one similarity compare.
 *
 * @returns { outcome: 'pass'|'repair'|'warn', reasons: string[] }
 *
 * Rules (tested):
 *  - Compare skipped/failed → pass with a skipped flag (infrastructure
 *    trouble is not evidence of a bad build — mirror of review semantics).
 *  - similarity >= threshold → pass.
 *  - Below threshold + repair budget left → repair.
 *  - Below threshold + budget exhausted → WARN, never reject: the build
 *    passed the functional/quality validation; similarity alone only ever
 *    downgrades to a delivered-with-warning outcome.
 */
export function decideSimilarityOutcome({
  status = 'compared',            // 'compared' | 'skipped'
  similarity = 0,
  differences = [],
  threshold = VISUAL_SIMILARITY_THRESHOLD,
  repairCycle = 0,
  maxRepairCycles = MAX_VISUAL_REPAIR_CYCLES,
} = {}) {
  if (status !== 'compared') {
    return { outcome: 'pass', reasons: [], skipped: true };
  }
  if (similarity >= threshold) return { outcome: 'pass', reasons: [] };
  const reasons = (differences.length ? differences : ['The rendered build diverges from the approved visual concept.'])
    .map((d) => `[visual-similarity] ${d}`);
  if (repairCycle < maxRepairCycles) return { outcome: 'repair', reasons };
  return { outcome: 'warn', reasons };
}

/**
 * Coerce a recorded similarity result into the WARNING shape used when a
 * design-first build is delivered despite diverging from the approved visual
 * (repair budget exhausted, or a similarity-driven repair chain failed
 * technically). Pure — never throws on missing input.
 */
export function buildVisualWarning(previous) {
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    status: 'warning',
  };
}

/**
 * Run the similarity compare with the injected vision caller. Never throws;
 * failure/timeout is a skipped compare.
 */
export async function runSimilarityCompare({
  callVision,
  renderedShots = [],   // [{ breakpoint, url }]
  conceptImages = {},   // { desktop: url, mobile: url }
  budgetMs = 30_000,
}) {
  if (typeof callVision !== 'function') {
    return { status: 'skipped', skipReason: 'Vision compare is not configured' };
  }
  const pairs = renderedShots
    .filter((s) => s?.url && conceptImages?.[s.breakpoint])
    .map((s) => ({ breakpoint: s.breakpoint, rendered: s.url, concept: conceptImages[s.breakpoint] }));
  if (!pairs.length) {
    return { status: 'skipped', skipReason: 'No comparable screenshots were captured' };
  }
  const prompt = buildSimilarityPrompt({ breakpoints: pairs.map((p) => p.breakpoint) });
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), Math.max(1, budgetMs));
    if (t.unref) t.unref();
  });
  try {
    const raw = await Promise.race([
      callVision({
        system: prompt.system,
        user: prompt.user,
        images: pairs.flatMap((p) => [
          { url: p.rendered, detail: 'low' },
          { url: p.concept, detail: 'low' },
        ]),
      }),
      timeout,
    ]);
    if (raw && raw.__timeout) {
      return { status: 'skipped', skipReason: `Compare exceeded its ${budgetMs}ms budget` };
    }
    const parsed = parseSimilarityResponse(raw);
    if (!parsed.ok) return { status: 'skipped', skipReason: parsed.error };
    return { status: 'compared', similarity: parsed.similarity, differences: parsed.differences };
  } catch (err) {
    return { status: 'skipped', skipReason: `Compare failed: ${err.message}` };
  }
}
