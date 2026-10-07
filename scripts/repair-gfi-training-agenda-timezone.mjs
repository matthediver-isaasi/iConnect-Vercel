import pg from 'pg';
import { createHash } from 'node:crypto';
import { deriveTrainingAgendaBounds } from '../shared/trainingAgendaBounds.js';

const project = 'lvmzliemqnieeoruhkik';
const id = '2e5ab247-a646-43da-bbb6-4d7a392c5182';
const slug = 'employability-and-career-education-strategy-and-inclusive-design-0627';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (args.some(a => a !== '--apply' && !/^--review=[a-f0-9]{64}$/.test(a))) throw new Error('Invalid arguments');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
if (new URL(process.env.DEST_SUPABASE_URL).hostname !== `${project}.supabase.co`) throw new Error('DEST mismatch');
const url = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${project}.supabase.co`].includes(url.hostname)
  || (url.port && url.port !== '5432')
  || (url.hostname.includes('pooler') && !decodeURIComponent(url.username).endsWith(`.${project}`))) throw new Error('DEST SQL mismatch');
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('CA unavailable');
const ca = await response.text();
const client = new pg.Client({ connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true, servername: url.hostname } });
try {
  await client.connect();
  await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'");
  // Parent + child table locks prevent concurrent agenda additions as well as edits.
  if (apply) await client.query('LOCK TABLE public.event_agenda_item IN SHARE MODE');
  const event = (await client.query(`SELECT to_jsonb(e) AS data FROM public.event e WHERE id=$1 ${apply ? 'FOR UPDATE' : ''}`, [id])).rows[0]?.data;
  const tenant = (await client.query('SELECT id,slug,name FROM public.tenant WHERE id=$1', [event?.tenant_id])).rows[0];
  const agenda = (await client.query('SELECT to_jsonb(a) AS data FROM public.event_agenda_item a WHERE event_id=$1 ORDER BY id', [id])).rows.map(r => r.data);
  if (!event || tenant?.slug !== 'gfi' || event.slug !== slug || event.timezone !== 'Europe/London'
    || !event.is_training || agenda.length !== 5 || agenda.some(a => a.tenant_id !== tenant.id)) throw new Error('Identity mismatch');
  const bounds = deriveTrainingAgendaBounds(agenda, event.timezone);
  if (bounds.errors.length || bounds.start !== '2027-06-10T08:15:00.000Z' || bounds.end !== '2027-07-02T15:15:00.000Z') throw new Error('Agenda changed');
  const unchanged = ({ start_date, end_date, updated_at, ...rest }) => rest;
  const review = hash({ event: unchanged(event), agenda });
  const current = [event.start_date, event.end_date].map(x => new Date(x).toISOString());
  const corrected = [bounds.start, bounds.end];
  const noop = JSON.stringify(current) === JSON.stringify(corrected);
  if (!noop && JSON.stringify(current) !== JSON.stringify(['2027-06-10T09:15:00.000Z', '2027-07-02T16:15:00.000Z'])) throw new Error('Bounds conflict');
  const triggers = (await client.query(`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='public.event'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  console.log(JSON.stringify({ project, tenant, id, review, before: current, expected: corrected, agenda: agenda.map(({id,start_date,start_time,end_date,end_time}) => ({id,start_date,start_time,end_date,end_time})), triggers, noop }, null, 2));
  if (apply) {
    if (!args.includes(`--review=${review}`)) throw new Error('Reviewed snapshot required');
    if (!noop) {
      const result = await client.query('UPDATE public.event SET start_date=$2,end_date=$3 WHERE id=$1 AND tenant_id=$4 RETURNING to_jsonb(event) AS data', [id, bounds.start, bounds.end, tenant.id]);
      if (result.rowCount !== 1 || hash(unchanged(result.rows[0].data)) !== hash(unchanged(event))) throw new Error('Unrelated event change');
    }
    const afterAgenda = (await client.query('SELECT to_jsonb(a) AS data FROM public.event_agenda_item a WHERE event_id=$1 ORDER BY id', [id])).rows.map(r => r.data);
    if (hash(afterAgenda) !== hash(agenda)) throw new Error('Agenda changed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ committed: true, rowsChanged: noop ? 0 : 1, after: corrected, agendaUnchanged: true }));
  } else await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Repair aborted (${error.code || error.message}); no transaction committed.`);
  process.exitCode = 1;
} finally { await client.end(); }
