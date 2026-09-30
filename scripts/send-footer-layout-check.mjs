// Explicit, single-recipient transport check. No application/database imports.
// Usage: node scripts/send-footer-layout-check.mjs --send TO FROM WIDTH [eu|us] [SENDING_DOMAIN]
import Mailgun from 'mailgun.js';
import formData from 'form-data';
import sharp from 'sharp';
import { wrapEmailFooter } from '../api/_lib/emailFooterLayout.js';

const [confirmation, to, from, widthArg, regionArg, sendingDomainArg] = process.argv.slice(2);
const width = Number(widthArg);
const singleAddress = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
if (confirmation !== '--send' || !singleAddress.test(to || '')
    || !singleAddress.test(from || '') || ![500, 600, 700].includes(width)) {
  throw new Error('Explicit --send, one recipient, one sender and width 500/600/700 are required.');
}
if (!process.env.MAILGUN_LAYOUT_TEST_API_KEY) throw new Error('MAILGUN_LAYOUT_TEST_API_KEY is required.');
// Mailgun's verified sending domain can differ from the approved From address.
const domain = sendingDomainArg || from.split('@')[1];
if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) throw new Error('Invalid sending domain.');
const region = regionArg || process.env.MAILGUN_REGION || 'eu';
if (!['eu', 'us'].includes(region)) throw new Error('Unsupported Mailgun region.');
const client = new Mailgun(formData).client({
  username: 'api',
  key: process.env.MAILGUN_LAYOUT_TEST_API_KEY,
  timeout: 15000,
  url: region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net',
});
const image = await sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="180">'
  + '<rect width="900" height="180" fill="#c94c4c"/>'
  + '<rect width="300" height="180" fill="#264f73"/>'
  + '<rect x="600" width="300" height="180" fill="#f6c344"/></svg>',
)).png().toBuffer();

// This mirrors the already-constrained inner HTML supplied by sendEmail.
// CID avoids tracking and third-party image requests.
const footer = `<table role="presentation" width="900" cellpadding="0" cellspacing="0" border="0" style="max-width:100%;width:100%;background-color:#17324d;"><tr><td><img src="cid:footer-check.png" width="900" alt="Blue, red and yellow image test" style="display:block;max-width:100%;height:auto;"></td></tr><tr><td style="padding:16px;color:#f6c344;font-family:Arial,sans-serif;font-size:16px;line-height:24px;">Synthetic ${width}px footer<br>All three image bands should remain visible.<br><a href="https://example.com/" style="color:#7ee0c3;">Untracked example link</a><br>END OF FOOTER — this line must be visible.</td></tr></table>`;
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background-color:#f1f5f9;">'
  + `<p style="margin:16px;font-family:Arial,sans-serif;">Footer layout check: ${width}px maximum desktop width. On mobile, the footer should fit without horizontal scrolling. This is synthetic test content, not a campaign.</p>`
  + wrapEmailFooter(footer, width)
  + '</body></html>';

try {
  const response = await client.messages.create(domain, {
    from,
    to: [to],
    subject: `[Footer layout check] ${width}px — mobile and Outlook`,
    text: `Synthetic ${width}px footer layout check. Please view the HTML message in Gmail and classic Outlook.`,
    html,
    inline: [{ filename: 'footer-check.png', data: image, contentType: 'image/png' }],
    'o:tracking': 'no',
    'o:tracking-clicks': 'no',
    'o:tracking-opens': 'no',
  });
  console.log(JSON.stringify({ width, accepted: Boolean(response.id), messageId: response.id }));
} catch (error) {
  // Never dump SDK errors: request configuration may contain credentials.
  console.error(JSON.stringify({ width, accepted: false, status: error.status || null,
    note: 'Transport failed or outcome is uncertain. Inspect delivery before retrying.' }));
  process.exitCode = 1;
}