export function defaultSubmitterCopyMessage() {
  return "Hi,\n\nThank you for your submission to {{form_name}}{{tenant_name}}. A Word (DOCX) copy of your responses is attached for your records.\n\nIf you didn't request this email, you can safely ignore it.";
}

export function getSubmitterCopyMessage(form) {
  return typeof form?.submitter_copy_email_message === 'string' && form.submitter_copy_email_message.trim()
    ? form.submitter_copy_email_message
    : defaultSubmitterCopyMessage();
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function renderSubmitterCopyMessage(form, tenantName) {
  const text = getSubmitterCopyMessage(form).replace(/\{\{(form_name|tenant_name)\}\}/g,
    (_, key) => key === 'form_name' ? (form?.name || 'our form') : (tenantName ? ` (${tenantName})` : ''));
  return text.split(/\r?\n\s*\r?\n/).map(paragraph =>
    `<p>${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}
