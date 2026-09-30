#!/usr/bin/env node
/**
 * One-shot, idempotent backfill for task #531.
 *
 * Brief `87fbd44f-4437-4202-9b35-998a411a48a6` had its
 * `copyright_submission_id` wiped to NULL by an earlier "Send copyright form"
 * re-send (and/or by toggling "Copyright form required" off-then-on), even
 * though form submission `067e1620-d07b-46a9-aa6a-e8d61cce0373` for the
 * matching copyright form/tenant had already been received.
 *
 * This script:
 *   1. Re-fetches the brief and submission and verifies tenant_id and
 *      form_id match before writing anything.
 *   2. Sets `article_brief.copyright_submission_id` back to the submission id
 *      (and `copyright_required = true` if it was toggled off).
 *   3. If no `article_brief_inbox_item` of type `copyright_submitted` exists
 *      for this brief+submission combination, inserts one whose `metadata`
 *      mirrors the shape produced by `api/public/form-submission.js`
 *      (form_id, form_title, submitter_email, submitter_name, file_count,
 *      and `files` if any). Existing inbox items are NOT duplicated.
 *
 * Re-running the script is safe: the brief update is a no-op if the link is
 * already in place, and the inbox insert is gated on a check for an existing
 * `copyright_submitted` item with the same submission_id in `metadata`.
 *
 * Required env: DEV_SUPABASE_URL + DEV_SUPABASE_SERVICE_KEY (or
 * SUPABASE_URL + SUPABASE_SERVICE_KEY when run against the same project from
 * a deployed environment).
 *
 * The submission row itself is NOT modified.
 */
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.DEV_SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('SUPABASE_URL/SUPABASE_SERVICE_KEY (or DEV_*) must be set');
  process.exit(1);
}
const supa = createClient(SUPA_URL, SUPA_KEY);

const BRIEF_ID = '87fbd44f-4437-4202-9b35-998a411a48a6';
const SUBMISSION_ID = '067e1620-d07b-46a9-aa6a-e8d61cce0373';

async function main() {
  const { data: brief, error: briefErr } = await supa
    .from('article_brief')
    .select('id, tenant_id, copyright_form_id, copyright_form_sent_at, copyright_submission_id, copyright_required')
    .eq('id', BRIEF_ID)
    .maybeSingle();
  if (briefErr || !brief) {
    throw new Error(`Failed to load brief ${BRIEF_ID}: ${briefErr?.message || 'not found'}`);
  }

  const { data: submission, error: subErr } = await supa
    .from('form_submission')
    .select('id, form_id, tenant_id, submission_data')
    .eq('id', SUBMISSION_ID)
    .maybeSingle();
  if (subErr || !submission) {
    throw new Error(`Failed to load submission ${SUBMISSION_ID}: ${subErr?.message || 'not found'}`);
  }

  if (submission.tenant_id !== brief.tenant_id) {
    throw new Error('Refusing to link: submission.tenant_id does not match brief.tenant_id');
  }
  if (brief.copyright_form_id && submission.form_id !== brief.copyright_form_id) {
    throw new Error(`Refusing to link: submission.form_id (${submission.form_id}) does not match brief.copyright_form_id (${brief.copyright_form_id})`);
  }

  // The `form` table doesn't expose a `title` column in this schema; the
  // public form-submission inbox writer falls back to null when `form.title`
  // is undefined, so reading `name` (and treating `title` as missing) produces
  // the same result.
  const { data: form, error: formErr } = await supa
    .from('form')
    .select('id, name, fields')
    .eq('id', submission.form_id)
    .maybeSingle();
  if (formErr || !form) {
    throw new Error(`Failed to load form ${submission.form_id}: ${formErr?.message || 'not found'}`);
  }

  // Build inbox metadata in the same shape as api/public/form-submission.js.
  const fields = form.fields || [];
  const data = submission.submission_data || {};
  let submitterEmail = null;
  let submitterFirstName = null;
  let submitterLastName = null;
  const uploadedFiles = [];

  for (const field of fields) {
    const value = data?.[field.id];
    if (value === undefined || value === null || value === '') continue;

    if (field.type === 'email' || field.id?.toLowerCase().includes('email')) {
      if (!submitterEmail && typeof value === 'string') submitterEmail = value;
    }
    if (field.type === 'text') {
      const idLower = (field.id || '').toLowerCase();
      const labelLower = (field.label || '').toLowerCase();
      if (idLower.includes('first_name') || labelLower.includes('first name')) {
        if (!submitterFirstName) submitterFirstName = value;
      }
      if (idLower.includes('last_name') || labelLower.includes('last name')) {
        if (!submitterLastName) submitterLastName = value;
      }
    }
    if (field.type === 'file') {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (entry && entry.file_url) {
            uploadedFiles.push({
              file_name: entry.file_name || null,
              file_url: entry.file_url,
              field_label: field.label || null,
            });
          }
        }
      } catch {
        // ignore non-JSON file values
      }
    }
  }

  const submitterName = [submitterFirstName, submitterLastName].filter(Boolean).join(' ').trim() || null;
  const inboxMetadata = {
    submission_id: submission.id,
    form_id: submission.form_id,
    form_title: form.title || form.name || null,
    submitter_email: submitterEmail,
    submitter_name: submitterName,
    file_count: uploadedFiles.length,
  };
  if (uploadedFiles.length > 0) {
    inboxMetadata.files = uploadedFiles.slice(0, 10);
  }

  // Step 2a: back-link the submission. Idempotent: a no-op when already set.
  const briefUpdate = { copyright_submission_id: submission.id };
  if (!brief.copyright_required) briefUpdate.copyright_required = true;
  const { error: updErr } = await supa
    .from('article_brief')
    .update(briefUpdate)
    .eq('id', BRIEF_ID)
    .eq('tenant_id', brief.tenant_id);
  if (updErr) throw new Error(`Failed to update brief: ${updErr.message}`);
  console.log('Brief link ensured:', briefUpdate);

  // Step 2b: insert inbox item only if one does not already exist for this
  // brief+submission combination.
  const { data: existingInbox, error: existingErr } = await supa
    .from('article_brief_inbox_item')
    .select('id, event_type, metadata')
    .eq('article_brief_id', BRIEF_ID)
    .eq('event_type', 'copyright_submitted');
  if (existingErr) throw new Error(`Failed to check existing inbox items: ${existingErr.message}`);
  const alreadyExists = (existingInbox || []).some((item) => item.metadata?.submission_id === submission.id);
  if (alreadyExists) {
    console.log('Inbox item already exists for this submission; skipping insert');
  } else {
    const { data: inserted, error: inboxErr } = await supa
      .from('article_brief_inbox_item')
      .insert({
        tenant_id: brief.tenant_id,
        article_brief_id: BRIEF_ID,
        event_type: 'copyright_submitted',
        metadata: inboxMetadata,
      })
      .select('id')
      .single();
    if (inboxErr) throw new Error(`Failed to insert inbox item: ${inboxErr.message}`);
    console.log('Inbox item created:', inserted.id);
  }

  console.log('DONE');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
