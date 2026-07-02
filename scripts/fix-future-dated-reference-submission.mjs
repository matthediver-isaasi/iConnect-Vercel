import { createClient } from '@supabase/supabase-js';

const SUBMISSION_ID = '5f369976-2c60-4b0b-a023-25d7849ae626';
const CONTRACT_INSTANCE_ID = '06d212eb-db57-4742-9574-f8f32985cec5';
const SIGNER_EMAIL = 'areebah.shahid@pyca.org.pk';
const BAD_DATE = '2026-10-30T18:23:00+00:00';
const FIXED_DATE = '2025-10-30T18:23:00+00:00';

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

function normalizeTs(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

const BAD_ISO = new Date(BAD_DATE).toISOString();
const FIXED_ISO = new Date(FIXED_DATE).toISOString();

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Submission:        ${SUBMISSION_ID}`);
  console.log(`Contract instance: ${CONTRACT_INSTANCE_ID}`);
  console.log(`Signer email:      ${SIGNER_EMAIL}`);
  console.log(`Bad date:          ${BAD_ISO}`);
  console.log(`Fixed date:        ${FIXED_ISO}`);
  console.log('');

  // --- form_submission ---
  const { data: sub, error: subErr } = await supabase
    .from('form_submission')
    .select('id, created_date, submission_data')
    .eq('id', SUBMISSION_ID)
    .single();
  if (subErr || !sub) {
    console.error('Failed to load form_submission:', subErr);
    process.exit(1);
  }

  console.log('--- form_submission BEFORE ---');
  console.log('created_date:                ', sub.created_date);
  console.log('submission_data.override_date:', sub.submission_data?.override_date);

  const newSubmissionData = {
    ...(sub.submission_data || {}),
    override_date: FIXED_ISO,
  };

  const subCreatedNorm = normalizeTs(sub.created_date);
  const subOverrideNorm = normalizeTs(sub.submission_data?.override_date);
  const subAlreadyFixed = subCreatedNorm === FIXED_ISO && subOverrideNorm === FIXED_ISO;
  if (subAlreadyFixed) {
    console.log('form_submission already correct; skipping update.');
  }

  // --- contract_instance ---
  const { data: inst, error: instErr } = await supabase
    .from('contract_instance')
    .select('id, sent_at, created_at, updated_at, signers')
    .eq('id', CONTRACT_INSTANCE_ID)
    .single();
  if (instErr || !inst) {
    console.error('Failed to load contract_instance:', instErr);
    process.exit(1);
  }

  console.log('');
  console.log('--- contract_instance BEFORE ---');
  console.log('sent_at:    ', inst.sent_at);
  console.log('created_at: ', inst.created_at);
  console.log('updated_at: ', inst.updated_at);
  console.log('signers:    ', JSON.stringify(inst.signers, null, 2));

  const existingSigners = Array.isArray(inst.signers) ? inst.signers : [];
  let matchedSignerIdx = -1;
  const updatedSigners = existingSigners.map((s, i) => {
    if ((s?.email || '').toLowerCase() === SIGNER_EMAIL.toLowerCase()) {
      matchedSignerIdx = i;
      return {
        ...s,
        signed_at: FIXED_ISO,
        added_at: FIXED_ISO,
      };
    }
    return s;
  });
  if (matchedSignerIdx < 0) {
    console.error(`No signer with email ${SIGNER_EMAIL} found on contract_instance.`);
    process.exit(1);
  }

  console.log('');
  console.log('--- contract_instance AFTER (planned) ---');
  console.log('sent_at:    ', FIXED_ISO);
  console.log('created_at: ', FIXED_ISO);
  console.log('updated_at: <now()>');
  console.log(`signers[${matchedSignerIdx}].signed_at:`, FIXED_ISO);
  console.log(`signers[${matchedSignerIdx}].added_at: `, FIXED_ISO);

  if (!APPLY) {
    console.log('');
    console.log('Dry-run complete. Re-run with --apply to write changes.');
    return;
  }

  // --- APPLY ---
  if (!subAlreadyFixed) {
    const { error: updSubErr } = await supabase
      .from('form_submission')
      .update({
        created_date: FIXED_ISO,
        submission_data: newSubmissionData,
      })
      .eq('id', SUBMISSION_ID);
    if (updSubErr) {
      console.error('form_submission update failed:', updSubErr);
      process.exit(1);
    }
    console.log('form_submission updated.');
  }

  const { error: updInstErr } = await supabase
    .from('contract_instance')
    .update({
      sent_at: FIXED_ISO,
      created_at: FIXED_ISO,
      updated_at: new Date().toISOString(),
      signers: updatedSigners,
    })
    .eq('id', CONTRACT_INSTANCE_ID);
  if (updInstErr) {
    console.error('contract_instance update failed:', updInstErr);
    process.exit(1);
  }
  console.log('contract_instance updated.');

  // --- verify ---
  const { data: subAfter } = await supabase
    .from('form_submission')
    .select('id, created_date, submission_data')
    .eq('id', SUBMISSION_ID)
    .single();
  const { data: instAfter } = await supabase
    .from('contract_instance')
    .select('id, sent_at, created_at, updated_at, signers')
    .eq('id', CONTRACT_INSTANCE_ID)
    .single();

  console.log('');
  console.log('--- form_submission AFTER ---');
  console.log('created_date:                ', subAfter.created_date);
  console.log('submission_data.override_date:', subAfter.submission_data?.override_date);
  console.log('');
  console.log('--- contract_instance AFTER ---');
  console.log('sent_at:    ', instAfter.sent_at);
  console.log('created_at: ', instAfter.created_at);
  console.log('updated_at: ', instAfter.updated_at);
  console.log('signers:    ', JSON.stringify(instAfter.signers, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
