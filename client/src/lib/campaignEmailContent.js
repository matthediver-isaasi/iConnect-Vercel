import { normalizeEmailDesign } from '../components/email-builder/types.js';

// Only the campaign's own snapshot is authoritative on reopen. A linked
// template may have changed since the campaign HTML was written.
export function resolveCampaignContent(campaign = {}) {
  const design_json = normalizeEmailDesign(campaign.design_json);
  const html_content = campaign.html_content || '';
  return {
    html_content,
    design_json,
    editorMode: design_json || !html_content.trim() ? 'visual' : 'html',
  };
}

export function applyCampaignTemplate(previous, template) {
  return {
    ...previous,
    email_template_id: template.id,
    subject: previous.subject || template.subject || '',
    from_name: previous.from_name || template.from_name || '',
    from_email: previous.from_email || template.from_email || '',
    html_content: template.body || '',
    // Explicit HTML templates may retain stale design_json from past edits.
    design_json: template.editor_type === 'html' ? null : normalizeEmailDesign(template.design_json),
  };
}