import { handleCpdTemplates } from '../_lib/cpdCertificateTemplatesApi.js';

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  return handleCpdTemplates(req, res, 'collection');
}