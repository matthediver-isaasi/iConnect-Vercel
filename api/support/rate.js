// Public support-ticket satisfaction rating endpoint (no login required).
//
// GET  /api/support/rate?ticket=<id>&exp=<ms>&sig=<hmac>&score=<1-5>
//   Validates the HMAC-signed token minted when the resolution email was sent,
//   records the rating (one per ticket — re-clicking updates), and renders a
//   thank-you page with an optional comment form and the option to change the
//   score.
// POST /api/support/rate  (form-urlencoded ticket/exp/sig/comment[/score])
//   Saves the optional free-text comment (and score change) from the thank-you page.

import { supabase } from '../_lib/database.js';
import { verifyRatingToken, normalizeRatingScore } from '../_lib/supportCsat.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(res, status, title, bodyHtml) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(status).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
  .card { max-width: 480px; margin: 48px auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color: #334155; }
  .muted { color: #64748b; font-size: 13px; }
  .scores a { display: inline-block; width: 40px; height: 40px; line-height: 40px; text-align: center; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; color: #1e293b; font-size: 16px; font-weight: bold; text-decoration: none; margin-right: 6px; }
  .scores a.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; font-family: inherit; font-size: 14px; min-height: 90px; }
  button { margin-top: 12px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 10px 20px; font-size: 14px; cursor: pointer; }
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`);
}

function parseBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  try {
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (!supabase) {
    return page(res, 500, 'Unavailable', '<h1>Service unavailable</h1><p>Please try again later.</p>');
  }

  const params = req.method === 'POST' ? parseBody(req) : (req.query || {});
  const ticketId = typeof params.ticket === 'string' ? params.ticket : '';
  const exp = params.exp;
  const sig = params.sig;

  if (!ticketId || !verifyRatingToken(ticketId, exp, sig)) {
    return page(res, 400, 'Link expired', `
      <h1>This rating link is no longer valid</h1>
      <p>The link may have expired. If you'd still like to rate your support experience, you can do so from the Support page after logging in.</p>`);
  }

  const { data: ticket, error: ticketErr } = await supabase
    .from('support_ticket')
    .select('id, subject, status, satisfaction_rating, satisfaction_comment')
    .eq('id', ticketId)
    .maybeSingle();

  if (ticketErr || !ticket) {
    return page(res, 404, 'Not found', '<h1>Ticket not found</h1><p>This support ticket no longer exists.</p>');
  }
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return page(res, 400, 'Ticket reopened', `
      <h1>This ticket has been reopened</h1>
      <p>Ratings can be left once the ticket is resolved again. Thanks for your patience!</p>`);
  }

  const score = normalizeRatingScore(params.score);
  const comment = typeof params.comment === 'string' ? params.comment.trim().slice(0, 2000) : undefined;
  const isPost = req.method === 'POST';

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Build the update: GET with a score records/updates the rating;
  // POST saves the comment (and any score change from the form).
  const update = {};
  if (score) {
    update.satisfaction_rating = score;
    update.satisfaction_rated_at = new Date().toISOString();
  }
  if (isPost && comment !== undefined) {
    update.satisfaction_comment = comment || null;
  }

  if (Object.keys(update).length > 0) {
    const { error: updateErr } = await supabase
      .from('support_ticket')
      .update(update)
      .eq('id', ticketId);
    if (updateErr) {
      console.error('[support/rate] Failed to record rating:', updateErr.message);
      return page(res, 500, 'Error', '<h1>Something went wrong</h1><p>We could not save your rating. Please try again.</p>');
    }
  }

  const effectiveScore = score || ticket.satisfaction_rating || null;
  const effectiveComment = isPost && comment !== undefined ? comment : (ticket.satisfaction_comment || '');
  const safeSubject = escapeHtml(ticket.subject || 'your support ticket');
  const tokenQs = `ticket=${encodeURIComponent(ticketId)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;

  if (!effectiveScore) {
    // Valid token but no score chosen yet — show the score picker.
    const links = [1, 2, 3, 4, 5]
      .map((s) => `<a href="/api/support/rate?${tokenQs}&score=${s}" data-testid="link-rate-${s}">${s}</a>`)
      .join('');
    return page(res, 200, 'Rate your support experience', `
      <h1>How satisfied are you with the support you received?</h1>
      <p>Ticket: <strong>${safeSubject}</strong></p>
      <p class="scores">${links}</p>
      <p class="muted">1 = very dissatisfied, 5 = very satisfied</p>`);
  }

  const links = [1, 2, 3, 4, 5]
    .map((s) => `<a href="/api/support/rate?${tokenQs}&score=${s}" class="${s === effectiveScore ? 'active' : ''}" data-testid="link-rate-${s}">${s}</a>`)
    .join('');

  const savedNote = isPost
    ? '<p class="muted">Your feedback has been saved. You can close this page.</p>'
    : '';

  return page(res, 200, 'Thank you for your feedback', `
    <h1>Thank you for your feedback!</h1>
    <p>You rated <strong>${safeSubject}</strong> a <strong>${effectiveScore} / 5</strong>. Click a different score to change it:</p>
    <p class="scores">${links}</p>
    ${savedNote}
    <form method="POST" action="/api/support/rate">
      <input type="hidden" name="ticket" value="${escapeHtml(ticketId)}">
      <input type="hidden" name="exp" value="${escapeHtml(String(exp))}">
      <input type="hidden" name="sig" value="${escapeHtml(String(sig))}">
      <input type="hidden" name="score" value="${effectiveScore}">
      <p style="margin-bottom:6px;"><label for="comment">Anything you'd like to add? (optional)</label></p>
      <textarea id="comment" name="comment" maxlength="2000" data-testid="input-rating-comment">${escapeHtml(effectiveComment)}</textarea>
      <br>
      <button type="submit" data-testid="button-submit-rating-comment">Save comment</button>
    </form>`);
}
