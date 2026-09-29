import { createHash } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { speakerAwardStaff, speakerAwardMember, speakerAwardUuid, privateSpeakerResponse } from '../_lib/speakerAwardAccess.js';

export function createSpeakerCertificateHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  return async (req, res) => {
    privateSpeakerResponse(res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const staff = await speakerAwardStaff(req, dependencies);
      const actor = staff || await speakerAwardMember(req, dependencies);
      if (!actor) return res.status(403).json({ error: 'Forbidden' });
      const id = req.query.id;
      if (!speakerAwardUuid(id)) return res.status(400).json({ error: 'Valid award id required' });
      const read = () => {
        let query = db.from('speaker_recognition')
          .select('id,tenant_id,member_id,status,certificate_status,pdf_path,pdf_sha256')
          .eq('tenant_id', actor.tenantId).eq('id', id);
        if (!staff) query = query.eq('member_id', actor.memberId);
        return query.maybeSingle();
      };
      const { data: row, error } = await read();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Certificate not found' });
      const available = value => value?.status === 'active' && value.certificate_status === 'issued'
        && value.pdf_path === `${actor.tenantId}/${id}.pdf` && /^[a-f0-9]{64}$/.test(value.pdf_sha256 || '');
      if (!available(row)) return res.status(409).json({ error: 'Certificate unavailable or revoked' });
      const stored = await db.storage.from('speaker-certificates').download(row.pdf_path);
      if (stored.error || !stored.data) throw new Error('Private artifact unavailable');
      const bytes = Buffer.from(await stored.data.arrayBuffer());
      if (bytes.subarray(0, 5).toString() !== '%PDF-'
        || createHash('sha256').update(bytes).digest('hex') !== row.pdf_sha256) throw new Error('Artifact integrity failure');
      // Recheck persisted recipient and revocation after asynchronous storage IO.
      const current = await read();
      if (current.error) throw current.error;
      if (!available(current.data) || current.data.pdf_sha256 !== row.pdf_sha256) {
        return res.status(409).json({ error: 'Certificate unavailable or revoked' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="speaker-certificate-${id}.pdf"`);
      return res.status(200).send(bytes);
    } catch {
      return res.status(503).json({ error: 'Certificate could not be loaded. Please try again.' });
    }
  };
}

export default createSpeakerCertificateHandler();