// Repairs visual email templates whose design_json contains duplicated
// dynamic-block tokens (from the old Duplicate behaviour that only
// regenerated the top-level block id). For each affected template:
//   1. design_json is repaired with normalizeDuplicateDynamicTokens (later
//      occurrences get fresh dynamic_N tokens; slotValues copied over).
//   2. the stored body HTML is rewritten in place: for each rename, the k-th
//      DYN_BLOCK region of the old token (in document order, matching block
//      order in the design) gets its markers and {{token}} / {{linkToken}}
//      occurrences rewritten to the new tokens. This avoids re-running the
//      browser-only MJML converter server-side.
//
// Saved campaign drafts are intentionally NOT touched: they carry their own
// pinned design_json + html whose tokens are internally consistent.
//
// Usage:
//   node scripts/repair-duplicate-dynamic-tokens.mjs                 # dry-run, all tenants
//   node scripts/repair-duplicate-dynamic-tokens.mjs --apply         # apply
//   node scripts/repair-duplicate-dynamic-tokens.mjs --name "CoP Group Template A" [--apply]
import { createClient } from '@supabase/supabase-js';
import { normalizeDuplicateDynamicTokens } from '../client/src/components/email-builder/types.js';

const url = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Missing DEST supabase env'); process.exit(1); }
const supabase = createClient(url, key);

const APPLY = process.argv.includes('--apply');
const nameIdx = process.argv.indexOf('--name');
const NAME = nameIdx !== -1 ? process.argv[nameIdx + 1] : null;

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Find the [start,end) bounds of the n-th (0-based) DYN_BLOCK region for a
// token in html, or null.
function findNthRegion(html, token, n) {
  const re = new RegExp(
    `<!--\\s*DYN_BLOCK:START:${escRe(token)}\\s*-->[\\s\\S]*?<!--\\s*DYN_BLOCK:END:${escRe(token)}\\s*-->`,
    'g'
  );
  let m; let i = 0;
  while ((m = re.exec(html)) !== null) {
    if (i === n) return { start: m.index, end: m.index + m[0].length, text: m[0] };
    i += 1;
  }
  return null;
}

// Apply renames to the body html. Process per old token from highest
// occurrence index down so earlier region indices stay stable.
function rewriteBodyHtml(html, renames) {
  if (!html) return { html, misses: renames.length };
  let out = html;
  let misses = 0;
  const sorted = [...renames].sort((a, b) => b.occurrence - a.occurrence);
  for (const r of sorted) {
    const region = findNthRegion(out, r.oldToken, r.occurrence);
    if (!region) { misses += 1; continue; }
    let text = region.text
      .replaceAll(`DYN_BLOCK:START:${r.oldToken}`, `DYN_BLOCK:START:${r.newToken}`)
      .replaceAll(`DYN_BLOCK:END:${r.oldToken}`, `DYN_BLOCK:END:${r.newToken}`);
    text = text.replace(new RegExp(`\\{\\{\\s*${escRe(r.oldToken)}\\s*\\}\\}`, 'g'), `{{${r.newToken}}}`);
    if (r.oldLinkToken && r.newLinkToken) {
      text = text.replace(new RegExp(`\\{\\{\\s*${escRe(r.oldLinkToken)}\\s*\\}\\}`, 'g'), `{{${r.newLinkToken}}}`);
    }
    out = out.slice(0, region.start) + text + out.slice(region.end);
  }
  return { html: out, misses };
}

function parseDesign(d) {
  if (!d) return null;
  if (typeof d === 'string') { try { return JSON.parse(d); } catch { return null; } }
  return typeof d === 'object' ? d : null;
}

async function main() {
  let query = supabase
    .from('email_template')
    .select('id, tenant_id, name, editor_type, design_json, body')
    .eq('editor_type', 'visual');
  if (NAME) query = query.eq('name', NAME);

  const { data: rows, error } = await query;
  if (error) throw error;
  console.log(`Scanning ${rows.length} visual template(s)${NAME ? ` named "${NAME}"` : ''}...`);

  let affected = 0;
  for (const row of rows) {
    const design = parseDesign(row.design_json);
    if (!design || !Array.isArray(design.blocks)) continue;
    const { design: repaired, changed, renames } = normalizeDuplicateDynamicTokens(design);
    if (!changed) continue;
    affected += 1;
    console.log(`\n[${row.tenant_id}] "${row.name}" (${row.id}): ${renames.length} token rename(s)`);
    renames.forEach((r) => console.log(`  ${r.oldToken} (occurrence ${r.occurrence}) -> ${r.newToken}`));

    const { html: newBody, misses } = rewriteBodyHtml(row.body || '', renames);
    if (misses > 0) {
      console.warn(`  WARNING: ${misses} rename(s) had no matching DYN_BLOCK region in body html; body left partially rewritten only where matched.`);
    }

    if (!APPLY) { console.log('  (dry-run, not applied)'); continue; }
    const { error: upErr } = await supabase
      .from('email_template')
      .update({ design_json: repaired, body: newBody, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (upErr) { console.error(`  FAILED to update: ${upErr.message}`); process.exitCode = 1; }
    else console.log('  Applied.');
  }
  console.log(`\nDone. ${affected} template(s) with duplicate tokens${APPLY ? ' repaired' : ' (dry-run)'}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
