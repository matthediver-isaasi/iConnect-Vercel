// Explicitly approved inbox tests only. Never imports the application or database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { validateFixtureImage } from './fixture-image.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), 'generated');
const args = process.argv.slice(2);
const send = args.includes('--send');
const option = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const run = option('--run');
assert(/^[a-zA-Z0-9-]{1,48}$/.test(run || ''), 'Supply a unique --run label');
const from = option('--from');
const recipients = (option('--to') || '').split(',').filter(Boolean);
const validAddress = value => /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value || '');
assert(validAddress(from), 'Supply the explicitly approved --from address');
assert(recipients.length > 0 && recipients.every(validAddress), 'Supply approved --to addresses');
const domain = from.split('@')[1];
const cid = 'fixture-image@example.invalid';
const image = readFileSync(join(root, 'assets/fixture-image.png'));
validateFixtureImage(image);
const cases = [
  ['received-minimal', 'send-ready-received-columns'],
  ['generated-three', 'send-ready-gmail-columns'],
  ['generated-two', 'gmail-columns-two'],
  ['generated-60-40', 'gmail-columns-60-40'],
  ['received-full-length', 'full-length/received-full-length'],
];
const base64 = data => Buffer.from(data).toString('base64').match(/.{1,76}/g).join('\r\n');
const messages = [];
for (const [label, basename] of cases) {
  for (const [suffix, variant] of [['before', 'BASELINE'], ['after', 'CANDIDATE']]) {
    const html = readFileSync(join(root, `${basename}.${suffix}.html`), 'utf8');
    assert(!/<script\b|\bon\w+\s*=/i.test(html), 'Executable markup is not allowed');
    assert(!/\b(?:href|src|background|poster|action)=["'](?:https?:|\/\/)/i.test(html), 'Remote resources are not allowed');
    assert(!/url\(\s*['"]?https?:/i.test(html), 'Remote CSS resources are not allowed');
    assert(!/\b[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html), 'Private address in fixture');
    assert(html.includes(`cid:${cid}`), 'Missing inline fixture image');
    for (const [inboxIndex, to] of recipients.entries()) {
      const subject = `[BNMS layout ${run}] ${label} ${variant}`;
      const boundary = `isolated-${run}-${label}-${variant}`;
      const mime = [
        `From: BNMS <${from}>`, `To: ${to}`, `Subject: ${subject}`,
        'MIME-Version: 1.0', `Content-Type: multipart/related; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64', '', base64(html),
        `--${boundary}`, 'Content-Type: image/png; name="fixture-image.png"',
        'Content-Transfer-Encoding: base64', `Content-ID: <${cid}>`,
        'Content-Disposition: inline; filename="fixture-image.png"', '', base64(image),
        `--${boundary}--`, '',
      ].join('\r\n');
      messages.push({ to, subject, mime, label, variant, inbox: inboxIndex + 1,
        htmlBytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') });
    }
  }
}
console.log(JSON.stringify({ mode: send ? 'send' : 'dry-run', run, messageCount: messages.length,
  cases: messages.filter(m => m.inbox === 1).map(({ label, variant, htmlBytes, sha256 }) => ({ label, variant, htmlBytes, sha256 })) }));
if (send) {
  const key = process.env.MAILGUN_LAYOUT_TEST_API_KEY || process.env.MAILGUN_API_KEY;
  assert(key, 'Mailgun credential unavailable');
  // Exclusive journal creation prevents an accidental repeat of the same run.
  // A transport timeout leaves an uncertain outcome: inspect provider events,
  // never automatically retry or delete this journal.
  const receiptPath = `/tmp/bnms-layout-${run}.json`;
  const journal = { run, startedAt: new Date().toISOString(), from, recipients,
    imageSha256: createHash('sha256').update(image).digest('hex'), results: [] };
  writeFileSync(receiptPath, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
  const client = new Mailgun(formData).client({
    username: 'api', key,
    url: 'https://api.eu.mailgun.net', timeout: 20000,
  });
  // A domain sending key need not have permission to read domain configuration.
  // The approved domain was independently verified active before this run.
  for (const message of messages) {
    const { to, mime, ...evidence } = message;
    const receipt = { ...evidence, status: 'attempting', attemptedAt: new Date().toISOString() };
    journal.results.push(receipt);
    writeFileSync(receiptPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
    try {
      const accepted = await client.messages.create(domain, {
        from: `BNMS <${from}>`, to: [to], subject: message.subject, message: Buffer.from(mime),
        'o:tracking': 'no', 'o:tracking-clicks': 'no', 'o:tracking-opens': 'no',
      });
      receipt.status = 'accepted';
      receipt.messageId = accepted.id;
      receipt.acceptedAt = new Date().toISOString();
    } catch (error) {
      receipt.httpStatus = error.status || error.statusCode || null;
      receipt.providerError = String(error.details || error.message || 'No detail')
        .split(key).join('[redacted]').slice(0, 500);
      receipt.status = [400, 401, 403, 404, 422].includes(receipt.httpStatus)
        ? 'rejected' : 'failed-or-uncertain';
      writeFileSync(receiptPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
      console.error(JSON.stringify({ label: message.label, variant: message.variant, inbox: message.inbox, status: receipt.status, httpStatus: receipt.httpStatus }));
      process.exitCode = 1;
      break;
    }
    writeFileSync(receiptPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ label: message.label, variant: message.variant, inbox: message.inbox, status: receipt.status }));
  }
  console.log(`Private transport journal: ${receiptPath}`);
}