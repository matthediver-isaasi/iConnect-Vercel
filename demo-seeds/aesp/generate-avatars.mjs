// AESP demo avatar generation pass.
//
// IMAGE GENERATION IS AGENT-RUN ONLY — `generateImage` is available only in
// the Replit agent's CodeExecution sandbox, not in the Node.js seed runtime.
// This module provides:
//
//   buildAvatarPrompt(member)          → AI prompt string for one member
//   runAvatarGenerationPass(...)       → full pass: generate + upload + link
//
// See the "Avatar generation pass" section of demo-seeds/README.md for the
// complete runbook and copy-pasteable CodeExecution snippet.

import { createClient } from '@supabase/supabase-js';
import {
  listDemoMembersNeedingAvatars,
  uploadDemoAvatar,
  applyDemoMemberAvatar,
  DEMO_AVATAR_BUCKET,
} from '../avatars.mjs';

// ---------------------------------------------------------------------------
// Name → appearance clues
// ---------------------------------------------------------------------------

// First names whose gender presentation is clearly feminine in UK context.
const FEMININE_FIRST = new Set([
  'amelia', 'sophie', 'niamh', 'charlotte', 'mei', 'fatima', 'isla',
  'hannah', 'eleri', 'lucy', 'zainab', 'aoife', 'bethan', 'freya',
  'kirsty', 'megan', 'rosie', 'leila', 'alice', 'sian', 'poppy',
  'erin', 'holly', 'anika', 'priya', 'yuki', 'rhiannon', 'emily',
  'sarah', 'aisha', 'chloe', 'rebecca',
]);

// First names whose gender presentation is clearly masculine in UK context.
const MASCULINE_FIRST = new Set([
  'oliver', 'kwame', 'tomasz', 'ibrahim', 'dylan', 'callum', 'george',
  'ravi', 'marcus', 'sanjay', 'ewan', 'patrick', 'adebayo', 'liam',
  'stephen', 'nathan', 'omar', 'douglas', 'emeka', 'harish', 'connor',
  'gareth', 'femi', 'viktor', 'jonathan', 'fraser', 'tariq', 'cormac',
  'james', 'peter', 'daniel', 'thomas',
]);

// Name tokens → heritage clue for the AI prompt.
// The agent uses these as appearance descriptors, not as identity statements.
const SOUTH_ASIAN_FIRST  = new Set(['priya', 'ravi', 'sanjay', 'harish', 'anika', 'fatima', 'zainab', 'tariq', 'ibrahim', 'omar', 'aisha']);
const SOUTH_ASIAN_LAST   = new Set(['patel', 'sharma', 'nair', 'chandra', 'iqbal', 'rahim', 'begum', 'hussain', 'ahmed', 'saleh']);
const EAST_ASIAN_FIRST   = new Set(['mei', 'yuki']);
const EAST_ASIAN_LAST    = new Set(['chen', 'tanaka']);
const WEST_AFRICAN_FIRST = new Set(['kwame', 'adebayo', 'emeka', 'femi']);
const WEST_AFRICAN_LAST  = new Set(['okafor', 'osei', 'adeyemi', 'boateng', 'nwosu']);
const EAST_EUR_LAST      = new Set(['kowalski', 'novak', 'sokolova']);

/**
 * Derive a concise appearance description from a member's name.
 * Returns a short string like "South Asian" or "" (neutral / no clue).
 */
function inferHeritage(firstName, lastName) {
  const fn = (firstName || '').toLowerCase();
  const ln = (lastName || '').toLowerCase();
  if (EAST_ASIAN_FIRST.has(fn) || EAST_ASIAN_LAST.has(ln)) return 'East Asian';
  if (WEST_AFRICAN_FIRST.has(fn) || WEST_AFRICAN_LAST.has(ln)) return 'Black British';
  if (SOUTH_ASIAN_FIRST.has(fn) || SOUTH_ASIAN_LAST.has(ln)) return 'South Asian';
  if (EAST_EUR_LAST.has(ln)) return 'Eastern European';
  return ''; // default: no appearance qualifier → model picks
}

/**
 * Derive approximate age range from job title seniority.
 */
function inferAgeRange(jobTitle) {
  const t = (jobTitle || '').toLowerCase();
  if (/\b(student|bsc|msc|phd researcher)\b/.test(t)) return 'mid-20s';
  if (/\b(graduate|junior|assistant|trainee)\b/.test(t)) return 'late 20s to early 30s';
  if (/\b(former|retired)\b/.test(t)) return '60s';
  if (/\b(director|head of|chief|professor|president|vice.chair)\b/.test(t)) return 'late 40s to 50s';
  if (/\b(senior|principal|lead|manager|specialist|advisor)\b/.test(t)) return 'late 30s to mid-40s';
  return 'early to mid-30s';
}

/**
 * Derive gender presentation clue from first name.
 * Returns 'woman', 'man', or '' (neutral → let the model choose).
 */
function inferGender(firstName) {
  const fn = (firstName || '').toLowerCase();
  if (FEMININE_FIRST.has(fn)) return 'woman';
  if (MASCULINE_FIRST.has(fn)) return 'man';
  return 'person';
}

// ---------------------------------------------------------------------------
// Public: prompt builder
// ---------------------------------------------------------------------------

/**
 * Build an AI image prompt for a professional headshot of a demo member.
 *
 * @param {object} member  Row from the `member` table:
 *   { first_name, last_name, job_title }
 * @returns {string}  Prompt string to pass to the image-generation model.
 */
export function buildAvatarPrompt(member) {
  const { first_name: first, last_name: last, job_title: jobTitle } = member;

  const gender  = inferGender(first);
  const age     = inferAgeRange(jobTitle);
  const heritage = inferHeritage(first, last);

  const appearanceClause = [
    heritage,
    age,
    gender,
  ].filter(Boolean).join(' ');

  const jobClause = jobTitle
    ? `, dressed in professional business-casual attire appropriate for a UK environmental consultancy`
    : '';

  return (
    `Professional headshot photograph of a ${appearanceClause}` +
    `${jobClause}. ` +
    `Neutral light grey or off-white studio background. Soft, even professional lighting. ` +
    `Person looking directly at the camera with a warm, confident expression. ` +
    `Square crop, head and shoulders framing. Photorealistic, high-quality, ` +
    `suitable for a professional membership directory profile photo. ` +
    `No text, no logos, no watermarks.`
  );
}

// ---------------------------------------------------------------------------
// Public: full generation pass
// ---------------------------------------------------------------------------

/**
 * Find demo members missing a headshot and generate+upload one for each.
 *
 * @param {object} opts
 *   sb          — Supabase client (service role, pointing at DEST)
 *   tenantId    — AESP demo tenant UUID
 *   generateFn  — async (prompt: string) => Buffer<JPEG>
 *                 In CodeExecution this is a thin wrapper around generateImage().
 *   demoDomain  — override demo email domain (default 'aesp.example.com')
 *   bucket      — storage bucket name (default DEMO_AVATAR_BUCKET)
 *   log         — logger (default console.log)
 *   concurrency — how many to generate in parallel (default 3)
 *
 * @returns {{ generated: number, skipped: number, errors: number }}
 */
export async function runAvatarGenerationPass({
  sb,
  tenantId,
  generateFn,
  demoDomain,
  bucket = DEMO_AVATAR_BUCKET,
  log = console.log,
  concurrency = 3,
}) {
  const members = await listDemoMembersNeedingAvatars(
    sb, tenantId, demoDomain ? { demoDomain } : {},
  );

  if (members.length === 0) {
    log('[demo-avatar-gen] No members need a headshot — nothing to do.');
    return { generated: 0, skipped: 0, errors: 0 };
  }

  log(`[demo-avatar-gen] ${members.length} member(s) need a headshot. Starting generation…`);

  let generated = 0, skipped = 0, errors = 0;
  const queue = [...members];

  // Process in sliding-window batches to cap parallelism.
  const processOne = async (m) => {
    const prompt = buildAvatarPrompt(m);
    const label  = `${m.first_name} ${m.last_name} <${m.email}>`;
    log(`[demo-avatar-gen] generating: ${label}`);
    log(`[demo-avatar-gen]   prompt: ${prompt}`);
    try {
      const buffer = await generateFn(prompt, m);
      const url = await uploadDemoAvatar(sb, { tenantId, email: m.email, buffer, bucket });
      const applied = await applyDemoMemberAvatar({ sb, tenantId, memberId: m.id, url, log });
      if (applied) {
        generated++;
        log(`[demo-avatar-gen] ✓ ${label}`);
      } else {
        skipped++;
        log(`[demo-avatar-gen] ~ ${label} — already has a photo, skipped`);
      }
    } catch (err) {
      errors++;
      log(`[demo-avatar-gen] ✗ ${label} — ${err.message}`);
    }
  };

  // Slide a window of `concurrency` promises.
  const active = [];
  for (const m of queue) {
    const p = processOne(m).then(() => active.splice(active.indexOf(p), 1));
    active.push(p);
    if (active.length >= concurrency) await Promise.race(active);
  }
  await Promise.all(active);

  log(`[demo-avatar-gen] done — generated ${generated}, skipped ${skipped}, errors ${errors}`);
  return { generated, skipped, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (node demo-seeds/aesp/generate-avatars.mjs)
// ---------------------------------------------------------------------------
// This module is NOT directly runnable for image generation because
// generateImage is only available in the Replit agent's CodeExecution sandbox.
// Running it directly prints instructions.

if (process.argv[1] && process.argv[1].endsWith('generate-avatars.mjs')) {
  console.log(`
This module is not directly runnable — image generation is agent-only.
See "Avatar generation pass" in demo-seeds/README.md for the runbook
and CodeExecution snippet.
`);
}
