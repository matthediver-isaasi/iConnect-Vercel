import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { uploadFileWithProgress } from '@/lib/tenantUpload';
import { serializeCertificatePlaceholder } from '@/lib/cpdCertificateContract';
import CertificatePlaceholderEditor, { editablePlaceholder } from './CertificatePlaceholderEditor';
import { certificateKeys, certificateRequest, CERTIFICATE_LIMIT, inspectCertificatePdf } from './useAwardCertificates';

export default function CertificateTemplateEditor({ tenant, templates, latest, ready, onSaved, onReload, onDirtyChange, onBusyChange }) {
  const [name, setName] = useState(''), [fields, setFields] = useState([]), [pages, setPages] = useState([]);
  const [sourceId, setSourceId] = useState(''), [file, setFile] = useState(null), [sourcePath, setSourcePath] = useState('');
  const [target, setTarget] = useState(null), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [progress, setProgress] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = !!(name || sourceId || file || fields.length || target);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const targetLatest = target && latest.find(item => item.series_id === target.series_id);
  const stale = target && (!targetLatest || targetLatest.revision !== target.revision);
  const loadSource = async (id, nextFile) => {
    if (pending.current || !ready) return;
    if ((fields.length || sourceId || file) && !window.confirm('Change the source PDF? Existing text placements are kept for an uploaded PDF; loading a saved source replaces placements with that version. Review all bounds.')) return;
    pending.current = true; setBusy(true); setError('');
    try {
      tenant.assertCurrent();
      if (nextFile && (!/\.pdf$/i.test(nextFile.name) || (nextFile.type && nextFile.type !== 'application/pdf'))) throw new Error('Choose a PDF file.');
      const blob = nextFile || await certificateRequest(tenant, `/api/awards/certificates?templateId=${encodeURIComponent(id)}`, { pdf: true });
      const dimensions = await inspectCertificatePdf(blob);
      tenant.assertCurrent();
      if (!alive.current) return;
      if (id) {
        const source = templates.find(item => item.id === id);
        if (!source || !Array.isArray(source.placeholders)) throw new Error('The source version is unavailable. Reload the complete library.');
        setFields(source.placeholders.map(editablePlaceholder)); if (!name) setName(source.name);
      }
      setPages(dimensions); setSourceId(id || ''); setFile(nextFile || null); setSourcePath(''); setNotice('Source inspected. Placements use this PDF’s actual page sizes; save creates an immutable template version.');
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const save = async event => {
    event.preventDefault();
    if (pending.current || !ready || blocked || stale) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let attempted = false;
    try {
      tenant.assertCurrent();
      if (!name.trim() || name.length > 300 || !pages.length || (!file && !sourceId)) throw new Error('Name and an inspected source PDF are required.');
      const placeholders = fields.map((field, index) => {
        if (!certificateKeys.includes(field.key) || !Number.isInteger(Number(field.page)) || !pages[Number(field.page) - 1]) throw new Error(`Placement ${index + 1}: choose a supported value and valid PDF page.`);
        const box = pages[Number(field.page) - 1], values = ['x', 'y', 'width', 'height', 'font_size', 'minimum_font_size'].map(key => Number(field[key] ?? (key === 'minimum_font_size' ? 4 : NaN)));
        const [x, y, width, height, font, minimum] = values;
        if (['x', 'y', 'width', 'height', 'font_size'].some(key => field[key] === '') || !values.every(Number.isFinite)
          || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > box.width || y + height > box.height || font < 4 || font > 144 || minimum < 4 || minimum > font) throw new Error(`Placement ${index + 1}: check page bounds and font sizes. No coordinates were silently adjusted.`);
        const serialized = serializeCertificatePlaceholder({ ...field, display_order: index, sample: '' });
        return field.missing_policy === 'literal' && !field.required ? { ...serialized, missing_policy: 'literal' } : serialized;
      });
      let path = sourcePath;
      if (file && !path) {
        const uploaded = await uploadFileWithProgress(file, { type: 'awards-certificate-template', isPrivate: true, maxSizeBytes: CERTIFICATE_LIMIT,
          onProgress: value => { if (alive.current) setProgress(value); } });
        tenant.assertCurrent();
        if (!alive.current) return;
        path = uploaded.storage_path;
        if (uploaded.bucket !== 'private-uploads' || !path?.startsWith(`${tenant.tenantId}/awards-certificate-template/`) || path.includes('..') || /[%\\\0\r\n?#]/.test(path)) throw new Error('The upload did not confirm a private source in the current tenant. No template was saved.');
        setSourcePath(path);
      }
      tenant.assertCurrent(); if (!alive.current) return;
      attempted = true;
      const result = await certificateRequest(tenant, '/api/awards/certificates', { body: { command: 'template', seriesId: target?.series_id || null,
        revision: target?.revision || 0, name: name.trim(), ...(sourceId ? { sourceTemplateId: sourceId } : { sourcePath: path }), placeholders } });
      if (!result.template?.id || result.template.revision !== (target?.revision || 0) + 1 || (target && result.template.series_id !== target.series_id)) throw new Error('The server did not confirm the expected immutable template version.');
      if (!alive.current) return;
      setNotice(`Saved “${result.template.name}”, version ${result.template.revision}. This did not generate or issue a certificate.`);
      setName(''); setFields([]); setPages([]); setSourceId(''); setFile(null); setSourcePath(''); setTarget(null);
      await onSaved();
    } catch (failure) { if (alive.current) { setError(`${failure.message}${attempted ? ' Reload the complete library and inspect for a saved version before retrying; creation may already have succeeded. Draft inputs are retained unless a save was explicitly confirmed.' : ''}`); if (attempted) setBlocked(true); } }
    finally { pending.current = false; if (alive.current) { setBusy(false); setProgress(null); } }
  };
  return <section className="border-t pt-5 space-y-4">
    <h3 className="font-semibold">Reusable certificate artwork</h3>
    <p className="awards-help">Save a new template series or append a version to an explicitly selected series. Existing versions and issued PDFs are never overwritten.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    {blocked && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { await onReload(); tenant.assertCurrent(); if (alive.current) { setBlocked(false); setNotice('Library reloaded. Check for a version already saved before explicitly trying again. Draft source and placements are retained.'); } } catch (failure) { if (alive.current) setError(failure.message); } finally { if (alive.current) setBusy(false); } }}>Reconcile template library (keep draft)</Button>}
    <form onSubmit={save} className="space-y-4"><fieldset disabled={busy || !ready} className="space-y-4">
      <Label htmlFor="certificate-name">Template name</Label><Input id="certificate-name" required maxLength={300} value={name} onChange={e => setName(e.target.value)} />
      <label className="block text-sm">Save destination<select className="awards-select mt-1 w-full" value={target?.series_id || ''} onChange={e => setTarget(latest.find(item => item.series_id === e.target.value) || null)}>
        <option value="">New template series</option>{latest.map(item => <option value={item.series_id} key={item.id}>{item.name} — append after version {item.revision}</option>)}</select></label>
      {target && <p className="awards-help">Captured expected series revision: {target.revision}. Choosing a save destination never replaces the source PDF or placements.</p>}
      {stale && <div role="alert" className="space-y-2 text-sm"><p>The selected series changed. Your draft is unchanged; review the latest version before rebasing.</p>{targetLatest && <Button type="button" size="sm" variant="outline" onClick={() => { if (window.confirm(`Use version ${targetLatest.revision} as the expected series revision? Your existing source and placements will NOT be replaced.`)) setTarget(targetLatest); }}>Use latest expected revision</Button>}</div>}
      <div className="grid gap-4 md:grid-cols-2"><label className="block text-sm">Use a saved PDF and layout<select className="awards-select mt-1 w-full" value={sourceId} onChange={e => { if (e.target.value) loadSource(e.target.value); }}><option value="">Choose an explicit source version</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name} — version {item.revision}</option>)}</select></label>
        <label className="block text-sm">Or upload source PDF (private, maximum 10 MB)<input className="block mt-2 max-w-full text-sm" type="file" accept="application/pdf,.pdf" onChange={e => { const selected = e.target.files?.[0]; e.target.value = ''; if (selected) loadSource('', selected); }} />{file && <span className="awards-help block mt-2">{file.name}</span>}</label></div>
      <CertificatePlaceholderEditor fields={fields} pages={pages} disabled={busy || !ready} onChange={setFields} />
      {progress !== null && <div role="status" className="awards-help">Uploading private source PDF: {progress}%</div>}
      <Button type="submit" disabled={busy || blocked || stale || !name.trim() || !pages.length}>{busy ? 'Saving template…' : target ? 'Save immutable template version' : 'Save new reusable template'}</Button>
    </fieldset></form>
  </section>;
}
