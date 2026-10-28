export const CPD_TEXT_EXAMPLE = 'This course provides {{number_of_cpd_points}} CPD credits in accordance with the CPD Scheme of The Royal College of Radiologists';
export function isMissingAuthoredCertificateText(field) {
  return field.text_template == null
    && /^text\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(field.key || field.placeholder_key || '');
}
export function validateCertificateText(text) {
  if (text == null) return;
  if (typeof text !== 'string' || text.length > 10000) throw new Error('Certificate text must be at most 10000 characters');
  const rest = text.replace(/\{\{\s*number_of_cpd_points\s*\}\}/g, '');
  if (/[{}]/.test(rest)) throw new Error('Unsupported certificate token. Only {{number_of_cpd_points}} is supported.');
}
export function certificateDependencies(field) {
  if (field.text_template == null) return [field.placeholder_key || field.key];
  validateCertificateText(field.text_template);
  return /\{\{\s*number_of_cpd_points\s*\}\}/.test(field.text_template) ? ['cpd.cpd_points'] : [];
}
export function resolveCertificateText(field, values = {}) {
  validateCertificateText(field.text_template);
  const raw = values['cpd.cpd_points'];
  const valid = (typeof raw === 'number' || typeof raw === 'string')
    && String(raw).trim() !== '' && Number.isFinite(Number(raw));
  if (certificateDependencies(field).length && !valid) return null;
  return field.text_template.replace(/\{\{\s*number_of_cpd_points\s*\}\}/g, () => String(Number(raw)));
}
// Display-only decoration, applied before either renderer measures the text.
export function certificateDisplayValue(key, value) {
  if (key !== 'cpd.cpd_points' || value == null || !String(value).trim()) return value;
  const text = String(value);
  if (/\s+points\s*$/i.test(text)) return text;
  return `${text} points`;
}