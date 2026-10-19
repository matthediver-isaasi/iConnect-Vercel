// Read-only extraction/coverage evidence against the verified DEST REST API.
// No source claims, embeddings, index writes or source-setting changes.
import { createClient } from '@supabase/supabase-js';
import { buildIEditGenerationSnapshot } from '../api/_lib/memberContentIEditGeneration.js';
import { validateDestinationRestUrl } from './recover-member-content-index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(tenant|page)=([0-9a-f-]{36})$/i.exec(arg);
  if (!match) throw new Error('Usage: node scripts/inspect-iedit-knowledge.mjs --tenant=<uuid> --page=<uuid>');
  return [match[1], match[2]];
}));
if (!args.tenant || !args.page) throw new Error('--tenant and --page are required');
const supabase = createClient(validateDestinationRestUrl(process.env.DEST_SUPABASE_URL),
  process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
const { data: settings, error } = await supabase.from('member_ai_settings')
  .select('allowed_content_types').eq('tenant_id', args.tenant).maybeSingle();
if (error) throw new Error(`Settings read failed: ${error.code || 'unavailable'}`);
const snapshot = await buildIEditGenerationSnapshot({
  supabase, tenantId: args.tenant, sourceId: args.page,
  // This is a read-only projection probe, NOT a claimed or published generation.
  claim: { generation: 1 },
  visibilityCtx: { tenantId: args.tenant, isAuthenticated: false },
});
console.log(JSON.stringify({
  mode: 'read-only guest extraction; no claims, model calls or publication',
  project: 'lvmzliemqnieeoruhkik', tenantId: args.tenant, pageId: args.page,
  eligible: !!snapshot.item, title: snapshot.item?.title, link: snapshot.metadata?.link,
  enabledBySavedSettings: settings ? settings.allowed_content_types?.includes('iedit_page') === true : null,
  settingsNote: settings ? 'Saved choices are unchanged.' : 'No saved settings; runtime defaults apply after release.',
  chunks: snapshot.chunks.length,
  contentCharacters: snapshot.chunks.reduce((total, chunk) => total + chunk.content.length, 0),
  coverage: snapshot.coverage,
}, null, 2));
