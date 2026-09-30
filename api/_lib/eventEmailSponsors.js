import { resolveEventEmailContext } from './eventEmailContext.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

const pattern = () => /\{\{event_sponsors\}\}|\[\[event\.sponsors\]\]/gi;
// Encode template delimiters too: public names/URLs are data, never another
// pass of campaign/booking/member template instructions.
const escape = value => String(value ?? '').replace(/[&<>"'{}\[\]]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;', '[': '&#91;', ']': '&#93;' }[c]));
export const usesEventSponsors = campaign => pattern().test(`${campaign?.subject || ''}\n${campaign?.html_content || ''}\n${JSON.stringify(campaign?.design_json || null)}`);

function safeUrl(value, base) {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return '';
  try {
    if (!/^https?:\/\//i.test(value) && !(base && /^\/(?!\/)/.test(value))) return '';
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function replaceEventSponsors(body, fragment) {
  let html = String(body || '');
  if (/<[^>]*(?:\{\{event_sponsors\}\}|\[\[event\.sponsors\]\])[^>]*>/i.test(html)) {
    throw new Error('Event sponsors: use a standalone body block, never an attribute, button URL or link href.');
  }
  // Rich-text editors wrap a standalone inserted token in a paragraph.
  html = html.replace(/<p\b[^>]*>\s*(?:(?:<span\b[^>]*>|<strong>|<em>)\s*)*(\{\{event_sponsors\}\}|\[\[event\.sponsors\]\])\s*(?:(?:<\/span>|<\/strong>|<\/em>)\s*)*<\/p>/gi, '$1');
  const token = pattern();
  let match;
  while ((match = token.exec(html))) {
    const before = html.slice(0, match.index);
    const stack = [];
    for (const tag of before.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
      const name = tag[1].toLowerCase();
      if (tag[0][1] === '/') { const i = stack.lastIndexOf(name); if (i >= 0) stack.splice(i); }
      else if (!['br', 'img', 'hr', 'input', 'meta', 'link'].includes(name)) stack.push(name);
    }
    if (stack.some(name => ['p', 'a', 'span', 'strong', 'em', 'h1', 'h2', 'h3', 'button', 'script', 'style'].includes(name))) {
      throw new Error('Event sponsors: place the token in its own body paragraph, outside links and inline text.');
    }
  }
  return html.replace(pattern(), () => fragment);
}

export async function resolveCampaignEventSponsors(db, campaign, tenantId) {
  if (!usesEventSponsors(campaign)) return null;
  if (pattern().test(campaign.subject || '')) throw new Error('Event sponsors: body block only; not supported in subjects.');
  replaceEventSponsors(campaign.html_content, '');
  const context = campaign.event_survey_context;
  const event = await resolveEventEmailContext(db, context, tenantId);
  if (event.sponsor_display_mode === 'hidden') return '';
  async function rows(query) {
    const { data, error } = await query;
    if (error) throw new Error('Event sponsors: could not load public sponsors. Please retry.');
    return data || [];
  }
  const assignments = await rows(db.from('event_sponsor_assignment').select('sponsor_id')
    .eq('tenant_id', tenantId).eq('event_id', event.id).eq('event_type', context.event_type === 'event' ? 'simple' : 'complex'));
  if (!assignments.length) return '';
  const sponsors = await rows(db.from('event_sponsor').select('id,name,logo_url,website_url,category_id')
    .eq('tenant_id', tenantId).in('id', assignments.map(a => a.sponsor_id)));
  const categories = await rows(db.from('event_sponsor_category').select('id,name,display_order')
    .eq('tenant_id', tenantId).order('display_order', { ascending: true }));
  const ordered = assignments.map(a => sponsors.find(s => s.id === a.sponsor_id)).filter(Boolean);
  const groups = categories.map(c => ({ name: c.name, sponsors: ordered.filter(s => s.category_id === c.id) })).filter(g => g.sponsors.length);
  const other = ordered.filter(s => !s.category_id);
  if (other.length) groups.push({ name: groups.length ? 'Other Sponsors' : '', sponsors: other });
  if (!groups.length) return '';
  const { data: tenant, error } = await db.from('tenant').select('slug,domain').eq('id', tenantId).maybeSingle();
  if (error || !tenant?.slug) throw new Error('Event sponsors: the tenant public URL is unavailable.');
  const base = getTenantTrustedBaseUrl(null, tenant);
  const content = groups.map(group => {
    const heading = group.name ? `<tr><td style="padding:12px 0;font-weight:bold;">${escape(group.name)}</td></tr>` : '';
    return heading + group.sponsors.sort((a, b) => a.name.localeCompare(b.name)).map(s => {
      const name = escape(s.name);
      const logo = safeUrl(s.logo_url, base);
      const website = safeUrl(s.website_url);
      const item = `${logo ? `<img src="${escape(logo)}" alt="${name}" width="120" style="display:block;width:120px;max-width:120px;max-height:80px;height:auto;border:0;" /><br />` : ''}${name}`;
      return `<tr><td style="padding:12px 0;font-family:Arial,sans-serif;font-size:14px;">${website ? `<a href="${escape(website)}" style="color:#334155;text-decoration:none;">${item}</a>` : item}</td></tr>`;
    }).join('');
  }).join('');
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;"><tbody>${content}</tbody></table>`;
}