import { supabase } from '../../_lib/database.js';
import { speakerAwardStaff, privateSpeakerResponse } from '../../_lib/speakerAwardAccess.js';

export function createSpeakerCertificateTemplatesHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  return async (req, res) => {
    privateSpeakerResponse(res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const actor = await speakerAwardStaff(req, dependencies, { templates: true });
      if (!actor) return res.status(403).json({ error: 'Forbidden' });
      const { data, error } = await db.from('cpd_certificate_template').select('id,name')
        .eq('tenant_id', actor.tenantId).eq('status', 'active').order('name').order('id');
      if (error) throw error;
      return res.status(200).json({ templates: data || [] });
    } catch {
      return res.status(500).json({ error: 'Failed to load active certificate templates' });
    }
  };
}

export default createSpeakerCertificateTemplatesHandler();