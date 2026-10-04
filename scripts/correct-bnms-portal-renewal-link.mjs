// Targeted authored-content repair, not a migration or general design rewrite.
// Default: read-only inspection. --apply locks the published row and changes
// only the verified payment block's two destination settings.
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const PAGE = '40c78458-ac7a-497e-a26e-af914cf1cdfd';
export const BLOCK = 'block-mu6xe2ef-9pdrst';
export const DESTINATION = '/FormView?slug=membership-renewal';

export function correctPortalDesign(original) {
  const design = structuredClone(original);
  const matches = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id === BLOCK) matches.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(design);
  if (matches.length !== 1 || matches[0].type !== 'payment-details') throw Error('Target block changed');
  const content = matches[0].content;
  if (content.manageLink === '' && content.renewalLink === DESTINATION
      && content.renewalLinkNewTab === false) return { design, changed: false };
  if (content.manageLink !== DESTINATION || content.manageLinkText !== 'Renew subscription'
      || content.manageLinkNewTab !== false || content.renewalLink !== ''
      || content.renewalLinkNewTab !== false) throw Error('Authored links changed; review before repair');
  content.renewalLink = content.manageLink;
  content.manageLink = '';
  return { design, changed: true };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    const { rows } = await db.query(
      `SELECT canvas_design FROM i_edit_page
       WHERE id=$1 AND tenant_id=$2 AND slug='portal' AND status='published'
         AND builder_type='canvas' ${apply ? 'FOR UPDATE' : ''}`, [PAGE, TENANT]);
    if (rows.length !== 1) throw Error('Published portal identity changed');
    const { design, changed } = correctPortalDesign(rows[0].canvas_design);
    if (apply && changed) {
      const result = await db.query(
        'UPDATE i_edit_page SET canvas_design=$1 WHERE id=$2 AND tenant_id=$3 RETURNING canvas_design',
        [design, PAGE, TENANT]);
      if (result.rowCount !== 1 || correctPortalDesign(result.rows[0].canvas_design).changed) {
        throw Error('Repair verification failed');
      }
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ target: 'verified DEST', apply, changed, publishedOtherContent: false }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Portal repair failed; no unverified changes committed.'); process.exitCode = 1; });
}