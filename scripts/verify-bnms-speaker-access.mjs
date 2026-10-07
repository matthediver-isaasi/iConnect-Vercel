// Read-only live data + real handlers, with injected identity (not a browser login).
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { hash } from './bnms-speaker-certificates.mjs';

async function main() {
  destinationTarget(process.env);
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const { createSpeakerCertificateHandler } = await import('../api/speaker-awards/certificate.js');
  const { createSpeakerAwardHistoryHandler } = await import('../api/_lib/speakerAwardHistory.js');
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY);
  const dir = 'private/bnms-speaker-certificates';
  const report = JSON.parse(await readFile(`${dir}/execute-report.json`, 'utf8'));
  const input = JSON.parse(await readFile(`${dir}/preview.json`, 'utf8'));
  const response = () => ({
    headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  });
  const check = (value, message) => { if (!value) throw new Error(message); };
  let allowed = 0;
  const restricted = [];
  for (const row of report.rows) {
    const member = input.members.find(m => m.id === row.member_id);
    const deps = { db, tenantContext: async () => null, sessionMember: async () => member };
    const res = response();
    await createSpeakerCertificateHandler(deps)({ method: 'GET', query: { id: row.id } }, res);
    if (res.code === 403) {
      restricted.push({ id: row.id, memberId: member.id, rolePresent: Boolean(member.role_id) });
      continue;
    }
    check(res.code === 200 && hash(res.body) === row.pdf_sha256, `Owner certificate handler failed (${res.code})`);
    const history = response();
    await createSpeakerAwardHistoryHandler({ ...deps, member: true })({
      method: 'GET', query: { page_size: '100' },
    }, history);
    check(history.code === 200 && history.body.awards.some(a => a.id === row.id && a.certificate.available),
      'Owner history handler failed');
    const denied = response();
    await createSpeakerCertificateHandler({
      ...deps, sessionMember: async () => ({ ...member, id: '00000000-0000-4000-8000-000000000001' }),
    })({ method: 'GET', query: { id: row.id, member_id: row.member_id } }, denied);
    check(denied.code === 404, 'Wrong-recipient access not denied');
    allowed++;
  }
  const denied = response();
  await createSpeakerCertificateHandler({ db, tenantContext: async () => null, sessionMember: async () => null })({
    method: 'GET', query: { id: report.rows[0].id },
  }, denied);
  check(denied.code === 403, 'Anonymous handler not denied');
  const result = { ownerCertificateAndHistory: allowed, wrongRecipientDenied: allowed,
    accessRestricted: restricted.length, restricted,
    anonymousDenied: true, identityInjected: true, authenticatedBrowserVerified: false };
  await writeFile(`${dir}/access-verification.json`, JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, restricted: undefined }));
}
main().catch(error => { console.error(`Access verification failed: ${error.code || error.message.slice(0, 90)}`); process.exitCode = 1; });
