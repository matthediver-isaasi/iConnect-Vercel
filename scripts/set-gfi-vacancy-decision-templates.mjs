/**
 * set-gfi-vacancy-decision-templates.mjs
 *
 * One-off data configuration: set the vacancy decision email templates on all
 * GFI member groups.
 *
 * Hard-pinned to the Graduate Futures Institute (GFI) tenant.
 * Defaults to DRY-RUN. Pass --apply to commit the changes.
 *
 * Usage:
 *   node scripts/set-gfi-vacancy-decision-templates.mjs           # dry-run
 *   node scripts/set-gfi-vacancy-decision-templates.mjs --apply   # write
 *
 * Templates resolved by name at runtime (not hardcoded ids) so the script
 * aborts loudly if either template is missing or not unique for this tenant.
 */

import { createClient } from '@supabase/supabase-js';

const GFI_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const APPROVAL_TEMPLATE_NAME = 'CoP - Successful leadership role';
const DECLINE_TEMPLATE_NAME = 'CoP - Unsuccessful leadership role';

const apply = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function resolveTemplate(name) {
  const { data, error } = await supabase
    .from('email_template')
    .select('id, name, tenant_id')
    .eq('tenant_id', GFI_TENANT_ID)
    .eq('name', name);

  if (error) {
    console.error(`ERROR: Failed to query email_template for "${name}":`, error);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.error(`ERROR: No email template found with name "${name}" for GFI tenant.`);
    process.exit(1);
  }
  if (data.length > 1) {
    console.error(`ERROR: Multiple email templates found with name "${name}" for GFI tenant — cannot proceed safely.`);
    data.forEach(t => console.error(`  id=${t.id} name="${t.name}"`));
    process.exit(1);
  }
  return data[0];
}

async function main() {
  console.log('=== GFI Vacancy Decision Email Template Configuration ===');
  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY-RUN (no changes)'}`);
  console.log(`Tenant: Graduate Futures Institute (${GFI_TENANT_ID})\n`);

  // Step 1: Resolve templates by name at runtime.
  console.log('Resolving email templates by name...');
  const approvalTemplate = await resolveTemplate(APPROVAL_TEMPLATE_NAME);
  const declineTemplate = await resolveTemplate(DECLINE_TEMPLATE_NAME);

  console.log(`  Approval → "${approvalTemplate.name}" (${approvalTemplate.id})`);
  console.log(`  Decline  → "${declineTemplate.name}" (${declineTemplate.id})\n`);

  // Step 2: Fetch all GFI member groups.
  const { data: groups, error: groupsErr } = await supabase
    .from('member_group')
    .select('id, name, approval_email_template_id, decline_email_template_id')
    .eq('tenant_id', GFI_TENANT_ID)
    .order('name');

  if (groupsErr) {
    console.error('ERROR: Failed to fetch member groups:', groupsErr);
    process.exit(1);
  }

  console.log(`Found ${groups.length} member group(s) for GFI:\n`);
  groups.forEach(g => {
    const approvalOk = g.approval_email_template_id === approvalTemplate.id;
    const declineOk = g.decline_email_template_id === declineTemplate.id;
    const alreadySet = approvalOk && declineOk;
    const tag = alreadySet ? '[already set]' : '[needs update]';
    console.log(`  ${tag} ${g.name}`);
    if (!approvalOk) {
      console.log(`    approval: ${g.approval_email_template_id || '(null)'} → ${approvalTemplate.id}`);
    }
    if (!declineOk) {
      console.log(`    decline:  ${g.decline_email_template_id || '(null)'} → ${declineTemplate.id}`);
    }
  });

  const toUpdate = groups.filter(
    g =>
      g.approval_email_template_id !== approvalTemplate.id ||
      g.decline_email_template_id !== declineTemplate.id
  );

  console.log(`\n${toUpdate.length} group(s) need updating (${groups.length - toUpdate.length} already correct).`);

  if (!apply) {
    console.log('\nDRY-RUN complete. Re-run with --apply to commit changes.');
    return;
  }

  if (toUpdate.length === 0) {
    console.log('\nAll groups already have the correct templates. Nothing to do.');
    return;
  }

  // Step 3: Apply updates.
  console.log('\nApplying updates...');
  let successCount = 0;
  let failCount = 0;

  for (const group of toUpdate) {
    const { error: updateErr } = await supabase
      .from('member_group')
      .update({
        approval_email_template_id: approvalTemplate.id,
        decline_email_template_id: declineTemplate.id,
      })
      .eq('id', group.id)
      .eq('tenant_id', GFI_TENANT_ID);

    if (updateErr) {
      console.error(`  FAIL: ${group.name} (${group.id}):`, updateErr.message);
      failCount++;
    } else {
      console.log(`  OK:   ${group.name}`);
      successCount++;
    }
  }

  console.log(`\nUpdated ${successCount} group(s); ${failCount} failure(s).`);

  if (failCount > 0) {
    console.error('ERROR: Some updates failed. See above.');
    process.exit(1);
  }

  // Step 4: Verify — re-query and confirm all groups now have the correct ids.
  console.log('\n=== Verification ===');
  const { data: verified, error: verifyErr } = await supabase
    .from('member_group')
    .select('id, name, approval_email_template_id, decline_email_template_id')
    .eq('tenant_id', GFI_TENANT_ID)
    .order('name');

  if (verifyErr) {
    console.error('ERROR: Verification query failed:', verifyErr);
    process.exit(1);
  }

  let allCorrect = true;
  verified.forEach(g => {
    const approvalOk = g.approval_email_template_id === approvalTemplate.id;
    const declineOk = g.decline_email_template_id === declineTemplate.id;
    if (!approvalOk || !declineOk) {
      allCorrect = false;
      console.error(`  FAIL: ${g.name}`);
      if (!approvalOk) console.error(`    approval: ${g.approval_email_template_id} (expected ${approvalTemplate.id})`);
      if (!declineOk) console.error(`    decline:  ${g.decline_email_template_id} (expected ${declineTemplate.id})`);
    } else {
      console.log(`  OK: ${g.name}`);
    }
  });

  if (!allCorrect) {
    console.error(`\nERROR: Verification failed — some groups still have incorrect template ids.`);
    process.exit(1);
  }

  console.log(`\nVerification passed: ${verified.length}/${verified.length} GFI member groups correctly configured.`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
