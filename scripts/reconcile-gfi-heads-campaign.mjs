// Targeted, provider-evidence-only repair. Never sends messages.
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';

const campaignId = '03283dc2-2f68-42b8-9388-33c07defa667';
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const domain = 'mail.graduatefutures.org';
const normalizeId = value => String(value || '').replace(/^<|>$/g, '');

export function matchAcceptance(rows, events, id = campaignId) {
  const byEmail = new Map();
  for (const event of events) {
    if (event.event !== 'accepted' || event['user-variables']?.iconn_campaign_id !== id) continue;
    if (event.flags?.['is-test-mode'] !== false) throw new Error('Live provider provenance required');
    const email = event.recipient?.toLowerCase();
    const messageId = normalizeId(event.message?.headers?.['message-id']);
    if (!email || !messageId || !event.id || !Number.isFinite(event.timestamp)) throw new Error('Incomplete provider evidence');
    const previous = byEmail.get(email);
    if (previous && normalizeId(previous.message.headers['message-id']) !== messageId) throw new Error('Multiple sends require review');
    if (!previous || event.timestamp < previous.timestamp) byEmail.set(email, event);
  }
  if (new Set(rows.map(row => row.email.toLowerCase())).size !== rows.length ||
      byEmail.size !== rows.length) throw new Error('Audience and provider evidence differ');
  return rows.map(row => {
    const event = byEmail.get(row.email.toLowerCase());
    if (!event || (row.mailgun_message_id && normalizeId(row.mailgun_message_id) !== normalizeId(event.message.headers['message-id']))) {
      throw new Error('Recipient provider identity conflict');
    }
    if (row.delivery_is_test !== false) throw new Error('Recipient live provenance missing');
    return { row, event, messageId: normalizeId(event.message.headers['message-id']), sentAt: new Date(event.timestamp * 1000).toISOString() };
  });
}

async function loadEvidence() {
  const base = `https://api.eu.mailgun.net/v3/${domain}/events`;
  let url = new URL(base);
  for (const [key, value] of Object.entries({
    begin: Date.parse('2026-10-23T12:00:00Z') / 1000,
    end: Date.parse('2026-10-23T12:04:00Z') / 1000,
    ascending: 'yes', limit: 300, event: 'accepted',
  })) url.searchParams.set(key, value);
  const events = [];
  for (let page = 0; page < 10; page++) {
    if (url.origin !== 'https://api.eu.mailgun.net' || !url.pathname.startsWith(`/v3/${domain}/events`)) throw new Error('Unexpected provider pagination');
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`api:${process.env.MAILGUN_EVENTS_API_KEY}`).toString('base64')}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Provider evidence unavailable: ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.items)) throw new Error('Invalid provider response');
    events.push(...result.items);
    if (!result.items.length || !result.paging?.next) return events;
    url = new URL(result.paging.next);
  }
  throw new Error('Provider evidence pagination incomplete');
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => !['--apply', '--preflight'].includes(arg))) throw new Error('Invalid arguments');
  const apply = args.includes('--apply');
  const events = await loadEvidence();
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const lock = apply ? ' FOR UPDATE' : '';
    const campaign = (await db.query(`SELECT id,name,status,sent_at,completed_at,sent_count,total_recipients,is_test_mode,archived_at,updated_at
      FROM email_campaign WHERE id=$1 AND tenant_id=$2${lock}`, [campaignId, tenantId])).rows[0];
    if (!campaign || campaign.is_test_mode || campaign.archived_at || !['sending', 'sent'].includes(campaign.status)) throw new Error('Campaign state changed');
    const rows = (await db.query(`SELECT id,email,status,sent_at,mailgun_message_id,delivery_is_test
      FROM email_campaign_recipient WHERE campaign_id=$1 ORDER BY id${lock}`, [campaignId])).rows;
    if (rows.length !== 238 || campaign.total_recipients !== 238) throw new Error('Pinned audience changed');
    const matches = matchAcceptance(rows, events);
    const missing = matches.filter(({ row }) => !row.sent_at || !row.mailgun_message_id);
    if (missing.some(({ row }) => !['processing', 'clicked', 'opened', 'delivered', 'sent'].includes(row.status))) throw new Error('Unexpected unresolved state');
    const completed = matches.map(match => match.sentAt).sort().at(-1);
    if (Date.parse(completed) < new Date(campaign.sent_at).getTime()) throw new Error('Provider completion precedes campaign');
    if (apply && !missing.length && campaign.status === 'sent' && campaign.sent_count === 238
        && new Date(campaign.completed_at).getTime() === Date.parse(completed)) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ mode: 'already-reconciled', campaignId, writesPerformed: false, sendsPerformed: 0 }));
      return;
    }
    if (apply) {
      for (const { row, event, messageId, sentAt } of matches) {
        const raw = { ...event, _iconnect_verified_provider: true,
          _iconnect_reconciliation: { reason: 'Mailgun accepted all recipients; local final-batch persistence was missing',
            recorded_at: new Date().toISOString(), previous_campaign: campaign,
            previous_recipient: { status: row.status, sent_at: row.sent_at, mailgun_message_id: row.mailgun_message_id },
            completion_basis: 'Latest accepted event across the entire pinned audience' } };
        await db.query(`INSERT INTO email_event(tenant_id,campaign_id,recipient_id,event_type,email,mailgun_message_id,mailgun_event_id,raw_event,event_timestamp)
          SELECT $1::uuid,$2::uuid,$3::uuid,'accepted',$4::varchar,$5::varchar,$6::varchar,$7::jsonb,$8::timestamptz
          WHERE NOT EXISTS(SELECT 1 FROM email_event WHERE campaign_id=$2::uuid AND mailgun_event_id=$6::varchar)`,
        [tenantId,campaignId,row.id,row.email,messageId,event.id,JSON.stringify(raw),sentAt]);
        if (!row.sent_at || !row.mailgun_message_id) {
          await db.query(`UPDATE email_campaign_recipient SET sent_at=COALESCE(sent_at,$3::timestamptz),
            mailgun_message_id=COALESCE(mailgun_message_id,$4),
            status=CASE WHEN status='processing' THEN 'sent' ELSE status END
            WHERE id=$1 AND campaign_id=$2`, [row.id,campaignId,sentAt,messageId]);
        }
      }
      await db.query(`UPDATE email_campaign SET status='sent',sent_count=238,completed_at=$3,updated_at=now()
        WHERE id=$1 AND tenant_id=$2`, [campaignId,tenantId,completed]);
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preflight', campaignId,
      matchedRecipients: matches.length, missingLocalEvidence: missing.length,
      providerCompletedAt: completed, sendsPerformed: 0 }));
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
