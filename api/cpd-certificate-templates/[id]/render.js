import { handleCpdTemplates } from '../../_lib/cpdCertificateTemplatesApi.js';

export default function handler(req, res) {
  return handleCpdTemplates(req, res, 'render');
}