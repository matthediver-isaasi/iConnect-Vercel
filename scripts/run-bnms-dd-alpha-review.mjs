#!/usr/bin/env node
// Bootstrap the existing OAuth client to the pinned DEST before module loading.
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {main}=await import('./bnms-dd-alpha-review.mjs');
await main().catch(e=>{console.error(JSON.stringify({error:e.message,importWrites:0}));process.exitCode=1;});