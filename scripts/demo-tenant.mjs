// Demo tenant management CLI (Task #3540).
//
// Usage:
//   node scripts/demo-tenant.mjs <seedKey> <command> [--size=small|medium|large] [--db=dest|dev]
//
// Commands:
//   status   Show install state, seed version and last-seeded metadata
//   seed     Create the tenant if missing, then (re)apply the seed data.
//            Idempotent: re-running does not duplicate records.
//   reset    Remove exactly the seeded rows (from the manifest), then reseed.
//   delete   Remove the entire demo tenant (refuses unless tenant is marked
//            as a demo tenant).
//
// Seed definitions live in demo-seeds/<seedKey>/definition.mjs. The engine
// (demo-seeds/engine.mjs) is generic; new demo tenants only need a new
// definition module.
//
// Safety: all writes go to the selected database only and are scoped to the
// demo tenant. No emails, Mailgun provisioning, payments or webhooks fire.
// Optional env: DEMO_SEED_PASSWORD — fixed password for demo persona logins
// (otherwise a random one is generated and printed once, never stored in git).

const args = process.argv.slice(2);
const seedKey = args[0];
const command = args[1];
const sizeArg = args.find(a => a.startsWith('--size='))?.split('=')[1];
const adoptExisting = args.includes('--adopt-existing-tenant');
const dbArg = args.find(a => a.startsWith('--db='))?.split('=')[1] || 'dest';

if (!seedKey || !['status', 'seed', 'reset', 'delete'].includes(command)) {
  console.error('Usage: node scripts/demo-tenant.mjs <seedKey> <status|seed|reset|delete> [--size=small|medium|large] [--db=dest|dev]');
  process.exit(1);
}

// Point the shared api/_lib/database.js client (used by provisionTenantService)
// at the selected database BEFORE importing anything that reads it. In this
// workspace the default SUPABASE_URL is the stale legacy snapshot; DEST is
// the real multi-tenant database.
if (dbArg === 'dev') {
  if (!process.env.DEV_SUPABASE_URL || !process.env.DEV_SUPABASE_SERVICE_KEY) {
    console.error('DEV_SUPABASE_URL / DEV_SUPABASE_SERVICE_KEY are required for --db=dev');
    process.exit(1);
  }
  process.env.SUPABASE_URL = process.env.DEV_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEV_SUPABASE_SERVICE_KEY;
} else {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY are required');
    process.exit(1);
  }
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { seedDemoTenant, resetDemoData, deleteDemoTenant, demoTenantStatus } = await import('../demo-seeds/engine.mjs');
const { provisionTenant } = await import('../api/_lib/provisionTenantService.js');

let definition;
try {
  definition = (await import(`../demo-seeds/${seedKey}/definition.mjs`)).default;
} catch (e) {
  console.error(`Unknown seed '${seedKey}': ${e.message}`);
  process.exit(1);
}

const started = Date.now();
try {
  if (command === 'status') {
    console.log(JSON.stringify(await demoTenantStatus(definition, { sb }), null, 2));
  } else if (command === 'seed') {
    const { tenant, manifest, adminSetup } = await seedDemoTenant(definition, { sb, provisionTenant, size: sizeArg, adoptExisting });
    console.log('\n=== SEED COMPLETE ===');
    console.log('Tenant   :', tenant.slug, tenant.id);
    console.log('Version  :', manifest.version);
    console.log('Counts   :', JSON.stringify(manifest.counts));
    if (adminSetup) console.log('Owner    :', adminSetup.email, '/', adminSetup.password);
  } else if (command === 'reset') {
    await resetDemoData(definition, { sb });
    const { tenant, manifest } = await seedDemoTenant(definition, { sb, provisionTenant, size: sizeArg });
    console.log('\n=== RESET + RESEED COMPLETE ===');
    console.log('Tenant   :', tenant.slug, tenant.id);
    console.log('Counts   :', JSON.stringify(manifest.counts));
  } else if (command === 'delete') {
    await deleteDemoTenant(definition, { sb });
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
