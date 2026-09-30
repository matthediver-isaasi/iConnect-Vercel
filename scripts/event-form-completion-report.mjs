#!/usr/bin/env node
/**
 * Event form completion report (read-only).
 *
 * Reports which attendees of an event have and haven't completed a specific
 * event-linked custom form. Resolves the event automatically from the form's
 * related_event_id — the operator only supplies the form id.
 *
 * This is a one-off diagnostic to validate the data is reachable before a
 * proper in-app report is built. It makes NO writes.
 *
 * How matching works:
 *   - The canonical join key between bookings and submissions is the
 *     attendee/submitter EMAIL, compared lower-cased + trimmed.
 *   - In practice `form_submission.submitted_by_email` is frequently NULL
 *     (public/event forms collect the email inside an ordinary form field
 *     rather than via authentication), so for each submission we fall back to
 *     extracting an email from `submission_data` the same way the public
 *     submission endpoint does: prefer email-typed / email-named fields, then
 *     any value that parses as an email address.
 *
 * Both event shapes are handled:
 *   - Standard events  -> `booking` table.
 *   - Complex events   -> `complex_event_booking` table.
 * The script reports which path(s) produced bookings.
 *
 * Cancelled bookings are excluded from the completed/not-completed totals and
 * listed separately so the report reflects active attendees.
 *
 * DB access: destination (prod) Supabase via @supabase/supabase-js with the
 * service-role key (REST endpoint is IPv4-reachable from this workspace; the
 * direct Postgres host is not — see replit.md "Database connection"). Env vars
 * are resolved defensively, preferring the canonical DEST_* names.
 *
 * Usage:
 *   node scripts/event-form-completion-report.mjs                 # default example form id
 *   node scripts/event-form-completion-report.mjs --form=<uuid>   # any event-linked form
 */

import { createClient } from '@supabase/supabase-js';

const DEFAULT_FORM_ID = 'c6bf9742-5e4b-4972-9b0e-b4a08b8cee79';

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});

const FORM_ID = (typeof args.form === 'string' && args.form) || DEFAULT_FORM_ID;

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing Supabase credentials. Set DEST_SUPABASE_URL and DEST_SUPABASE_KEY.'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const normEmail = (v) =>
  typeof v === 'string' ? v.trim().toLowerCase() : null;

const isEmail = (v) =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

const fullName = (first, last) =>
  [first, last].filter(Boolean).join(' ').trim() || '(no name)';

/**
 * Fetch every row of a table matching the given event_id/tenant_id, paging
 * past PostgREST's 1000-row default cap.
 */
async function fetchAll(table, columns, eventId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .range(from, from + pageSize - 1);
    if (error) return { error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { rows };
}

async function fetchAllSubmissions(formId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await supabase
      .from('form_submission')
      .select('id, submitted_by_email, submitted_by_name, submission_data, created_date')
      .eq('form_id', formId)
      .eq('tenant_id', tenantId)
      .range(from, from + pageSize - 1);
    if (error) return { error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { rows };
}

/**
 * Extract a submitter email from a submission, mirroring the public form
 * submission endpoint: prefer the persisted column, then email-typed /
 * email-named form fields, then any value in submission_data that parses as
 * an email.
 */
function extractSubmissionEmail(submission, fields) {
  if (isEmail(submission.submitted_by_email)) {
    return submission.submitted_by_email.trim();
  }
  const data = submission.submission_data || {};
  for (const field of fields) {
    if (!field || !field.id) continue;
    const idLower = (field.id || '').toLowerCase();
    const labelLower = (field.label || '').toLowerCase();
    const looksLikeEmail =
      field.type === 'email' ||
      idLower.includes('email') || idLower.includes('e-mail') ||
      labelLower.includes('email') || labelLower.includes('e-mail');
    if (!looksLikeEmail) continue;
    const val = data[field.id];
    if (isEmail(val)) return val.trim();
  }
  for (const value of Object.values(data)) {
    if (isEmail(value)) return value.trim();
  }
  return null;
}

/**
 * Pull first/last name out of a submission's data by matching name-like form
 * fields — only used to label unmatched submissions, never for the join.
 */
function extractSubmissionName(submission, fields) {
  if (submission.submitted_by_name) return submission.submitted_by_name;
  const data = submission.submission_data || {};
  let first = null;
  let last = null;
  for (const field of fields) {
    if (!field || !field.id) continue;
    const idLower = (field.id || '').toLowerCase();
    const labelLower = (field.label || '').toLowerCase();
    const val = data[field.id];
    if (typeof val !== 'string' || !val.trim()) continue;
    if (!first && (idLower.includes('first') || labelLower.includes('first name'))) first = val.trim();
    if (!last && (idLower.includes('last') || labelLower.includes('last name') || labelLower.includes('surname'))) last = val.trim();
  }
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || null;
}

async function main() {
  console.log('=== Event Form Completion Report ===');
  console.log('Form id:', FORM_ID);
  console.log('');

  const { data: form, error: formError } = await supabase
    .from('form')
    .select('id, name, tenant_id, is_event_related, related_event_id, fields')
    .eq('id', FORM_ID)
    .maybeSingle();

  if (formError) {
    console.error('Failed to fetch form:', formError.message);
    process.exit(1);
  }
  if (!form) {
    console.error('No form found with id', FORM_ID);
    process.exit(1);
  }

  const tenantId = form.tenant_id;
  const fields = Array.isArray(form.fields) ? form.fields : [];

  console.log('Form name:', form.name);
  console.log('Tenant id:', tenantId);

  if (!form.is_event_related || !form.related_event_id) {
    console.error('');
    console.error(
      'This form is not linked to an event (is_event_related=' +
        form.is_event_related +
        ', related_event_id=' +
        form.related_event_id +
        '). Nothing to report.'
    );
    process.exit(0);
  }

  const eventId = form.related_event_id;

  // Resolve event from either standard or complex events.
  const [{ data: event }, { data: complexEvent }] = await Promise.all([
    supabase.from('event').select('id, title, status, is_complex').eq('id', eventId).maybeSingle(),
    supabase.from('complex_event').select('id, title, status').eq('id', eventId).maybeSingle(),
  ]);

  const eventTitle = event?.title || complexEvent?.title || '(unknown event)';
  console.log('Linked event id:', eventId);
  console.log('Linked event:', eventTitle);
  console.log('');

  // Gather attendees from both booking tables (an event lives in one of them).
  const { rows: bookings, error: bookingError } = await fetchAll(
    'booking',
    'id, attendee_email, attendee_first_name, attendee_last_name, member_id, status',
    eventId,
    tenantId
  );
  if (bookingError) {
    console.error('Failed to fetch bookings:', bookingError.message);
    process.exit(1);
  }

  const { rows: complexBookings, error: complexBookingError } = await fetchAll(
    'complex_event_booking',
    'id, attendee_email, attendee_first_name, attendee_last_name, member_id, status',
    eventId,
    tenantId
  );
  if (complexBookingError) {
    console.error('Failed to fetch complex event bookings:', complexBookingError.message);
    process.exit(1);
  }

  const usedPaths = [];
  if (bookings.length) usedPaths.push(`booking (${bookings.length})`);
  if (complexBookings.length) usedPaths.push(`complex_event_booking (${complexBookings.length})`);
  console.log('Booking source:', usedPaths.length ? usedPaths.join(', ') : 'NONE — event has no bookings');

  const allBookings = [
    ...bookings.map((b) => ({ ...b, _source: 'booking' })),
    ...complexBookings.map((b) => ({ ...b, _source: 'complex_event_booking' })),
  ];

  // De-duplicate attendees by lower-cased email. A later confirmed booking
  // upgrades a cancelled one for the same email.
  const attendeesByEmail = new Map();
  const noEmailBookings = [];
  for (const b of allBookings) {
    const email = normEmail(b.attendee_email);
    if (!email) {
      noEmailBookings.push(b);
      continue;
    }
    const cancelled = b.status === 'cancelled';
    const existing = attendeesByEmail.get(email);
    if (!existing) {
      attendeesByEmail.set(email, {
        email,
        name: fullName(b.attendee_first_name, b.attendee_last_name),
        memberId: b.member_id || null,
        cancelled,
        source: b._source,
      });
    } else if (existing.cancelled && !cancelled) {
      // Prefer an active booking over a cancelled one for the same email.
      existing.cancelled = false;
      existing.name = fullName(b.attendee_first_name, b.attendee_last_name);
      existing.memberId = b.member_id || existing.memberId;
      existing.source = b._source;
    }
  }

  // Gather submissions and resolve each submitter's email.
  const { rows: submissions, error: submissionError } = await fetchAllSubmissions(FORM_ID, tenantId);
  if (submissionError) {
    console.error('Failed to fetch form submissions:', submissionError.message);
    process.exit(1);
  }

  const submittedEmails = new Set();
  const submissionsByEmail = new Map();
  const submissionsNoEmail = [];
  for (const s of submissions) {
    const email = normEmail(extractSubmissionEmail(s, fields));
    if (!email) {
      submissionsNoEmail.push(s);
      continue;
    }
    submittedEmails.add(email);
    if (!submissionsByEmail.has(email)) {
      submissionsByEmail.set(email, {
        email,
        name: extractSubmissionName(s, fields),
      });
    }
  }

  // Match attendees against submissions.
  const activeAttendees = [...attendeesByEmail.values()].filter((a) => !a.cancelled);
  const cancelledAttendees = [...attendeesByEmail.values()].filter((a) => a.cancelled);

  activeAttendees.sort((a, b) => a.name.localeCompare(b.name));

  const completed = [];
  const notCompleted = [];
  for (const a of activeAttendees) {
    if (submittedEmails.has(a.email)) completed.push(a);
    else notCompleted.push(a);
  }

  // Submissions whose email matches no active attendee (mismatches to flag).
  const attendeeEmailSet = new Set(activeAttendees.map((a) => a.email));
  const unmatchedSubmissions = [...submissionsByEmail.values()].filter(
    (s) => !attendeeEmailSet.has(s.email)
  );

  console.log('');
  console.log('=== Attendee completion ===');
  for (const a of activeAttendees) {
    const status = submittedEmails.has(a.email) ? 'Completed    ' : 'Not completed';
    console.log(`[${status}] ${a.name} <${a.email}>`);
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(
    `${activeAttendees.length} active attendees: ${completed.length} completed, ${notCompleted.length} not completed`
  );
  if (cancelledAttendees.length) {
    console.log(`${cancelledAttendees.length} cancelled booking(s) excluded from totals.`);
  }
  if (noEmailBookings.length) {
    console.log(`${noEmailBookings.length} booking(s) had no attendee email and could not be matched.`);
  }
  console.log(`${submissions.length} total submissions (${submittedEmails.size} distinct emails resolved).`);
  if (submissionsNoEmail.length) {
    console.log(`${submissionsNoEmail.length} submission(s) had no resolvable email.`);
  }

  if (unmatchedSubmissions.length) {
    console.log('');
    console.log('=== Submissions not matching any active attendee ===');
    console.log('(email is the only reliable join key — these may indicate typos, guest emails, or cancelled bookings)');
    for (const s of unmatchedSubmissions.sort((a, b) => a.email.localeCompare(b.email))) {
      const cancelledMatch = cancelledAttendees.find((c) => c.email === s.email);
      const note = cancelledMatch ? ' (matches a CANCELLED booking)' : '';
      console.log(`  - ${s.name || '(no name)'} <${s.email}>${note}`);
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
