import { normalizeEmailDesign } from '../components/email-builder/types';
import { sanitizeHtml } from '../components/email-builder/sanitize';

const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function campaignPdfHtml(campaign) {
  let design = campaign.design_json;
  try { if (typeof design === 'string') design = JSON.parse(design); } catch { design = null; }
  let html = campaign.html_content || '';
  for (const token of Array.isArray(design?.hiddenSlots) ? design.hiddenSlots : []) {
    if (typeof token !== 'string' || !token) continue;
    const safe = regexEscape(token);
    html = html.replace(new RegExp(`<!--\\s*DYN_BLOCK:START:${safe}\\s*-->[\\s\\S]*?<!--\\s*DYN_BLOCK:END:${safe}\\s*-->`, 'gi'), '');
  }
  const rich = new Set(Array.isArray(design?.richSlots) ? design.richSlots : []);
  for (const [token, value] of Object.entries(design?.slotValues || {})) {
    if (!token || token.toLowerCase() === 'event_survey_url') continue;
    const replacement = rich.has(token) ? sanitizeHtml(String(value ?? '')) : escape(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    html = html.replace(new RegExp(`\\{\\{\\s*${regexEscape(token)}\\s*\\}\\}`, 'gi'), () => replacement);
  }
  return html;
}

// Resolve only campaign-authored slots. Standard member/event tokens remain
// generic. Convert to static blocks rather than enabling editing context/chrome.
export function campaignPdfDesign(value) {
  const design = normalizeEmailDesign(value);
  if (!design) return null;
  const slots = design.slotValues || {};
  const hidden = new Set(Array.isArray(design.hiddenSlots) ? design.hiddenSlots : []);
  const rich = new Set(Array.isArray(design.richSlots) ? design.richSlots : []);
  const has = token => Object.prototype.hasOwnProperty.call(slots, token);
  const visit = blocks => blocks.filter(block => !block.hidden && !hidden.has(block.token)).map(block => {
    if (block.type === 'dynamic_text' && has(block.token)) {
      const content = rich.has(block.token) ? sanitizeHtml(String(slots[block.token] ?? '')) : `<p>${escape(slots[block.token]).replace(/\r\n|\r|\n/g, '<br>')}</p>`;
      return { ...block, type: 'text', content };
    }
    if (block.type === 'dynamic_image' && has(block.token)) {
      return { ...block, type: 'image', src: String(slots[block.token] ?? '') };
    }
    if (block.type === 'dynamic_button') return {
      ...block, type: 'button',
      content: has(block.token) ? String(slots[block.token] ?? '') : block.content,
      href: has(block.linkToken) ? String(slots[block.linkToken] ?? '') : block.href,
    };
    return { ...block,
      ...(block.children ? { children: visit(block.children) } : {}),
      ...(block.columns ? { columns: block.columns.map(column => ({ ...column, blocks: visit(column.blocks) })) } : {}),
    };
  });
  return { ...design, blocks: visit(design.blocks) };
}
