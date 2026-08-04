/**
 * DB-backed verification of the event_survey_assignment lifecycle guards
 * (Task #3331). Runs against the DEST database inside ONE transaction that is
 * ALWAYS rolled back — no data is left behind.
 *
 * Verifies, at the database boundary:
 *  1. Deleting an assignment that has a response is rejected (guard trigger).
 *  2. Deleting the survey FORM whose assignment has responses is rejected
 *     (the form_id cascade hits the same guard), so historic
 *     form_submission.survey_assignment_id attribution survives.
 *  3. Deleting the EVENT leaves the assignment row (event_id -> NULL) with
 *     its title/date snapshots intact.
 *  4. The response trigger bumped response_count/first/last timestamps.
 *  5. A response-less assignment DOES cascade away with its form.
 *
 * Usage: DEST_DATABASE_URL=... node scripts/verify-event-survey-assignment-guards.mjs
 */
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function expectReject(client, name, sql, params) {
  // Run in a savepoint so the outer transaction survives the expected error.
  await client.query('SAVEPOINT sp');
  try {
    await client.query(sql, params);
    check(name, false, 'statement unexpectedly succeeded');
  } catch (e) {
    check(name, /has responses; archive/.test(e.message), e.message);
  }
  await client.query('ROLLBACK TO SAVEPOINT sp');
}

async function run() {
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');

    const { rows: [tenant] } = await client.query(
      `INSERT INTO public.tenant (name) VALUES ('__esa_guard_test__') RETURNING id`);
    const { rows: [form] } = await client.query(
      `INSERT INTO public.form (tenant_id, name, slug, form_type)
       VALUES ($1, '__esa_guard_survey__', '__esa-guard-survey__', 'survey') RETURNING id`,
      [tenant.id]);
    const { rows: [event] } = await client.query(
      `INSERT INTO public.event (tenant_id, title, start_date)
       VALUES ($1, '__esa_guard_event__', now()) RETURNING id`,
      [tenant.id]);
    const { rows: [assignment] } = await client.query(
      `INSERT INTO public.event_survey_assignment
         (tenant_id, form_id, event_type, event_id, event_title, event_start_date, token, status, access_mode)
       VALUES ($1, $2, 'event', $3, '__esa_guard_event__', now(), '__esa_guard_token__', 'active', 'public')
       RETURNING id`,
      [tenant.id, form.id, event.id]);
    await client.query(
      `INSERT INTO public.form_submission (tenant_id, form_id, survey_assignment_id, event_id, submission_data)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [tenant.id, form.id, assignment.id, event.id]);

    // 4. counter trigger
    const { rows: [afterInsert] } = await client.query(
      `SELECT response_count, first_response_at, last_response_at
       FROM public.event_survey_assignment WHERE id = $1`, [assignment.id]);
    check('response trigger bumps count + timestamps',
      afterInsert.response_count === 1 && !!afterInsert.first_response_at && !!afterInsert.last_response_at,
      JSON.stringify(afterInsert));

    // 1. direct delete of responded assignment rejected
    await expectReject(client, 'deleting a responded assignment is rejected',
      'DELETE FROM public.event_survey_assignment WHERE id = $1', [assignment.id]);

    // 2. deleting the form is rejected via the cascade hitting the guard
    await expectReject(client, 'deleting the survey form with responded assignment is rejected',
      'DELETE FROM public.form WHERE id = $1', [form.id]);

    const { rows: [attrib] } = await client.query(
      `SELECT survey_assignment_id FROM public.form_submission WHERE survey_assignment_id = $1`,
      [assignment.id]);
    check('submission attribution intact after blocked deletes', !!attrib, 'attribution row missing');

    // 3. deleting the event detaches but preserves the assignment + snapshots
    await client.query('DELETE FROM public.event WHERE id = $1', [event.id]);
    const { rows: [afterEventDelete] } = await client.query(
      `SELECT event_id, event_title FROM public.event_survey_assignment WHERE id = $1`, [assignment.id]);
    check('event delete: assignment survives with snapshot',
      !!afterEventDelete && afterEventDelete.event_id === null && afterEventDelete.event_title === '__esa_guard_event__',
      JSON.stringify(afterEventDelete));

    // 6. Attribution coverage: two assignments (simple + complex) of ONE
    // survey — responses are independently filterable and correctly
    // attributed for both event types.
    const { rows: [complexEvent] } = await client.query(
      `INSERT INTO public.complex_event (tenant_id, title, slug)
       VALUES ($1, '__esa_guard_complex__', '__esa-guard-complex__') RETURNING id`,
      [tenant.id]);
    const { rows: [complexAssignment] } = await client.query(
      `INSERT INTO public.event_survey_assignment
         (tenant_id, form_id, event_type, complex_event_id, event_title, token, status, access_mode)
       VALUES ($1, $2, 'complex_event', $3, '__esa_guard_complex__', '__esa_guard_token_cx__', 'active', 'public')
       RETURNING id`,
      [tenant.id, form.id, complexEvent.id]);
    await client.query(
      `INSERT INTO public.form_submission (tenant_id, form_id, survey_assignment_id, complex_event_id, submission_data)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [tenant.id, form.id, complexAssignment.id, complexEvent.id]);

    const { rows: bySimple } = await client.query(
      `SELECT id, event_id, complex_event_id FROM public.form_submission
       WHERE form_id = $1 AND survey_assignment_id = $2`, [form.id, assignment.id]);
    const { rows: byComplex } = await client.query(
      `SELECT id, event_id, complex_event_id FROM public.form_submission
       WHERE form_id = $1 AND survey_assignment_id = $2`, [form.id, complexAssignment.id]);
    check('simple-event assignment responses independently filterable',
      bySimple.length === 1 && bySimple[0].complex_event_id === null, JSON.stringify(bySimple));
    check('complex-event assignment responses independently filterable + attributed',
      byComplex.length === 1 && byComplex[0].complex_event_id === complexEvent.id && byComplex[0].event_id === null,
      JSON.stringify(byComplex));

    // Complex-event deletion detaches the FK but the assignment snapshot keeps reporting alive.
    await client.query('DELETE FROM public.complex_event WHERE id = $1', [complexEvent.id]);
    const { rows: [cxAfter] } = await client.query(
      `SELECT complex_event_id, event_title FROM public.event_survey_assignment WHERE id = $1`,
      [complexAssignment.id]);
    check('complex event delete: assignment snapshot survives',
      !!cxAfter && cxAfter.complex_event_id === null && cxAfter.event_title === '__esa_guard_complex__',
      JSON.stringify(cxAfter));

    // 5. response-less assignment cascades with its form
    const { rows: [form2] } = await client.query(
      `INSERT INTO public.form (tenant_id, name, slug, form_type)
       VALUES ($1, '__esa_guard_survey2__', '__esa-guard-survey2__', 'survey') RETURNING id`,
      [tenant.id]);
    const { rows: [assignment2] } = await client.query(
      `INSERT INTO public.event_survey_assignment
         (tenant_id, form_id, event_type, event_title, token, status, access_mode)
       VALUES ($1, $2, 'event', 'x', '__esa_guard_token2__', 'active', 'public') RETURNING id`,
      [tenant.id, form2.id]);
    await client.query('DELETE FROM public.form WHERE id = $1', [form2.id]);
    const { rows: gone } = await client.query(
      'SELECT 1 FROM public.event_survey_assignment WHERE id = $1', [assignment2.id]);
    check('response-less assignment cascades with its form', gone.length === 0);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
  console.log(failures === 0 ? '\nAll guard checks passed (transaction rolled back).' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
