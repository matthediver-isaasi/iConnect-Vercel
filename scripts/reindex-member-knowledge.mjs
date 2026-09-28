// Explicit single-source DEST backfill. Default is a read-only capability probe;
// an embedding allowance never implicitly authorizes a write or a provider call.
// Validate the deployed knowledge implementation in preview before production backfill.
// node scripts/reindex-member-knowledge.mjs --tenant=<uuid> --type=resource
//   --source=<uuid> [--apply --max-embedding-chunks=50]
import { createDestinationRestClient } from './recover-member-content-index.mjs';
import { reindexMemberContentItem, getDefaultOpenAIClient } from '../api/_lib/memberContentIndexer.js';
import { CONTENT_TYPES } from '../api/_lib/memberContentVisibility.js';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key,...value] = arg.replace(/^--/,'').split('=');
  return [key,value.length ? value.join('=') : true];
}));
for (const key of Object.keys(args)) {
  if (!['tenant','type','source','apply','max-embedding-chunks'].includes(key)) throw new Error('Unsupported knowledge backfill option');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuid.test(args.tenant) || !uuid.test(args.source) || !CONTENT_TYPES.includes(args.type)) {
  throw new Error('Explicit valid tenant, source and supported type are required');
}
const allowance = Number(args['max-embedding-chunks'] ?? 0);
if (!Number.isInteger(allowance) || allowance<0 || allowance>100) throw new Error('Embedding allowance must be 0–100');
const supabase = createDestinationRestClient();
const { data, error } = await supabase.rpc('publish_member_content_knowledge',{
  p_tenant_id:null,p_content_type:null,p_source_id:null,p_generation:null,p_claim_token:null,p_rows:[],
});
if (error || data !== false) {
  console.error(JSON.stringify({ready:false,errorCode:error?.code || 'KNOWLEDGE_PUBLISHER_UNAVAILABLE'}));
  process.exitCode=1;
} else if (args.apply !== true) {
  console.log(JSON.stringify({ready:true,dryRun:true,providerCalls:0,writes:0,maxEmbeddingChunks:allowance}));
} else {
  const openai = allowance>0 ? getDefaultOpenAIClient() : null;
  if (allowance>0 && !openai) throw new Error('Existing platform provider configuration is required; no credentials are copied by this runner');
  try {
    const result = await reindexMemberContentItem(args.type,{id:args.source,tenant_id:args.tenant},{
      supabase,openai,embeddingBudget:{maxEmbeddingChunks:allowance},
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ready:true,errorCode:error.code || 'KNOWLEDGE_INDEX_FAILED'}));
    process.exitCode=1;
  }
}