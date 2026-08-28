import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, Check, Copy, Download, FilePlus2, FileText, Move, Plus, Save,
  Trash2, Upload, ZoomIn,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import * as pdfjs from 'pdfjs-dist';
import {
  calculateFitScale, moveBox, normalizeBox, pointsToPixels, resizeBox,
} from '@/lib/cpdCertificateGeometry';
import {
  certificateSampleValues, certificateTemplateEndpoints, formatCertificateValue,
  serializeCertificatePlaceholder,
} from '@/lib/cpdCertificateContract';

const CAPABILITY = 'cpd.certificate-templates';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
const EMPTY_PAGE = { width: 842, height: 595 };
const BUILTIN_FIELDS = [
  ['member.full_name', 'Member full name', 'Alex Morgan'],
  ['member.first_name', 'Member first name', 'Alex'],
  ['member.last_name', 'Member last name', 'Morgan'],
  ['member.email', 'Member email', 'alex.morgan@example.org'],
  ['member.membership_number', 'Membership number', 'MEM-00123'],
  ['cpd.activity_title', 'Activity title', 'Professional development activity'],
  ['cpd.activity_date', 'Activity date', '28 February 2026'],
  ['cpd.cpd_hours', 'CPD hours', '7.5'],
  ['cpd.cpd_points', 'CPD points', '8'],
  ['cpd.certificate_number', 'Certificate number', 'CPD-000123'],
  ['organisation.name', 'Organisation name', 'Example Institute'],
  ['event.name', 'Event name', 'Annual Conference 2026'],
  ['event.start_date', 'Event start date', '28 February 2026'],
  ['event.end_date', 'Event end date', '1 March 2026'],
];
const DEFAULT_FIELD = {
  page: 1, x: 72, y: 72, width: 250, height: 32, font_family: 'Helvetica',
  font_size: 18, minimum_font_size: 8, font_weight: 'normal', font_style: 'normal', color: '#111827', align: 'left',
  vertical_align: 'middle', multiline: false, shrink_to_fit: true, required: false,
  date_format: 'date:long', number_format: 'number', sample: '', default_value: '',
};

async function api(path = '', options = {}) {
  const response = await fetch(`/api/cpd-certificate-templates${path}`, {
    credentials: 'include',
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function unwrapList(data) {
  return Array.isArray(data) ? data : data?.templates || data?.fields || data?.items || data?.data || [];
}

function unwrapTemplate(data) {
  return data?.template || data?.data || data;
}

function templateFields(template) {
  const design = template?.design || template?.layout || {};
  return design.fields || template?.fields || template?.placeholders || [];
}

function templatePages(template) {
  const pages = template?.pdf_metadata?.pages || template?.source_geometry || template?.pages || template?.design?.pages;
  if (Array.isArray(pages) && pages.length) {
    return pages.map((page, index) => ({
      number: page.number || page.page_number || page.pageNumber || index + 1,
      width: Number(page.width || page.width_points) || EMPTY_PAGE.width,
      height: Number(page.height || page.height_points) || EMPTY_PAGE.height,
      rotation: Number(page.rotation || 0),
    }));
  }
  return [EMPTY_PAGE];
}

function normalizeField(field) {
  return {
    ...DEFAULT_FIELD, ...field,
    id: field.id || crypto.randomUUID(),
    key: field.key || field.data_key || field.placeholder_key,
    label: field.label || field.field_label || field.placeholder_key,
    page: Number(field.page ?? field.page_number) || 1,
    align: field.align || field.alignment || field.text_alignment || 'left',
    color: field.color || field.text_colour || '#111827',
    sample: field.sample ?? field.sample_value ?? '',
    default_value: field.default_value ?? '',
    multiline: field.multiline ?? field.overflow_policy === 'wrap',
    shrink_to_fit: field.shrink_to_fit ?? field.overflow_policy === 'shrink',
    required: field.required ?? field.missing_policy === 'error',
    date_format: field.date_format || field.format || DEFAULT_FIELD.date_format,
  };
}

function draftFromResponse(data) {
  const template = unwrapTemplate(data);
  const fields = data?.placeholders || data?.fields || templateFields(template);
  return {
    ...template,
    pdf_url: data?.pdf_url || data?.signed_url || template?.pdf_url,
    fields: (fields || []).map(normalizeField),
  };
}

function AccessGate({ children }) {
  const {
    authResolved, isFeatureExcluded, isRoleLoading, memberInfo, memberRole,
  } = useMemberAccess();
  if (!authResolved || isRoleLoading) {
    return <div className="p-12 text-center text-slate-500">Checking access…</div>;
  }
  // A tenant-dashboard account is not itself a portal capability. It must be
  // linked to a member with a real configurable role, exactly like the API.
  if (!memberInfo?.role_id || !memberRole || isFeatureExcluded(CAPABILITY)) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <Card><CardContent className="p-10 text-center">
          <h1 className="text-xl font-semibold">Access denied</h1>
          <p className="text-slate-600 mt-2">Your role does not include CPD certificate template management.</p>
        </CardContent></Card>
      </div>
    );
  }
  return children;
}

export default function CPDCertificateTemplates() {
  const { templateId } = useParams();
  return <AccessGate>{templateId ? <TemplateDesigner id={templateId} /> : <TemplateLibrary />}</AccessGate>;
}

function TemplateLibrary() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cpd-certificate-templates'],
    queryFn: () => api(),
  });
  const templates = unwrapList(data);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['cpd-certificate-templates'] });
  const action = async (item, action, message) => {
    try {
      const endpoints = certificateTemplateEndpoints(item.id);
      const result = action === 'duplicate'
        ? await fetch(endpoints.duplicate, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); })
        : await fetch(endpoints.lifecycle, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expectedVersion: item.version }) }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); });
      await refresh();
      toast.success(message);
      if (action === 'duplicate' && unwrapTemplate(result)?.id) {
        navigate(`/CPDCertificateTemplates/${unwrapTemplate(result).id}`);
      }
    } catch (e) { toast.error(e.message); }
  };
  const remove = async (item) => {
    if (!window.confirm(`Permanently delete “${item.name || item.title}”?`)) return;
    try {
      await api(`/${item.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: item.version }) });
      await refresh();
      toast.success('Template deleted');
    } catch (e) { toast.error(e.message); }
  };
  const create = async () => {
    if (!name.trim() || !file) return toast.error('Enter a name and choose a PDF');
    try {
      const form = new FormData();
      form.append('name', name.trim());
      form.append('description', description.trim());
      form.append('file', file);
      const result = unwrapTemplate(await api('', { method: 'POST', body: form }));
      await refresh();
      setCreating(false);
      toast.success('Template created');
      if (result?.id) navigate(`/CPDCertificateTemplates/${result.id}`);
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap justify-between gap-4">
          <div><h1 className="text-3xl font-bold">CPD Certificate Templates</h1>
            <p className="text-slate-600 mt-1">Design data-driven certificates over an uploaded PDF.</p></div>
          <Button onClick={() => setCreating(v => !v)}><FilePlus2 className="w-4 h-4 mr-2" />New template</Button>
        </div>
        {creating && <Card><CardHeader><CardTitle>Create template</CardTitle></CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-3 items-end">
            <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
            <div><Label>Description</Label><Input value={description} onChange={e => setDescription(e.target.value)} /></div>
            <div><Label>Background PDF</Label><Input ref={fileRef} type="file" accept="application/pdf"
              onChange={e => setFile(e.target.files?.[0] || null)} /></div>
            <Button onClick={create}>Create & design</Button>
          </CardContent></Card>}
        {isLoading && <p className="text-slate-500">Loading templates…</p>}
        {error && <p className="text-red-600">{error.message}</p>}
        {!isLoading && !templates.length && <Card><CardContent className="py-16 text-center text-slate-500">
          No certificate templates have been created.</CardContent></Card>}
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {templates.map(item => <Card key={item.id}>
            <CardHeader><div className="flex justify-between gap-2"><CardTitle className="text-lg">{item.name || item.title}</CardTitle>
              <Badge variant="outline">{item.status || (item.is_active ? 'active' : 'draft')}</Badge></div></CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-2">{item.description || 'No description'}</p>
              <p className="text-xs text-slate-500 mb-4">{item.source_filename || item.original_filename || 'PDF'} · {item.source_page_count || item.page_count || templatePages(item).length} page(s)
                {item.updated_at ? ` · Updated ${new Date(item.updated_at).toLocaleDateString()}` : ''}</p>
              <div className="flex flex-wrap gap-2">
                {item.status !== 'active' ? <Button size="sm" onClick={() => navigate(`/CPDCertificateTemplates/${item.id}`)}>Edit</Button> : <Badge variant="outline">Active · preview only</Badge>}
                <Button size="sm" variant="outline" onClick={() => navigate(`/CPDCertificateTemplates/${item.id}?preview=1`)}>Preview</Button>
                <Button size="sm" variant="outline" onClick={() => action(item, 'duplicate', 'Template duplicated')}><Copy className="w-4 h-4" /></Button>
                {item.status === 'draft' && <Button size="sm" variant="outline" onClick={() => action(item, 'submit_review', 'Template submitted for review')}>Submit review</Button>}
                {item.status === 'in_review' && <><Button size="sm" variant="outline" onClick={() => action(item, 'approve', 'Template approved')}>Approve</Button><Button size="sm" variant="outline" onClick={() => action(item, 'return_draft', 'Template returned to draft')}>Return draft</Button></>}
                {item.status === 'approved' && <><Button size="sm" variant="outline" onClick={() => action(item, 'activate', 'Template activated')}><Check className="w-4 h-4 mr-1" />Activate</Button><Button size="sm" variant="outline" onClick={() => action(item, 'return_draft', 'Template returned to draft')}>Return draft</Button></>}
                {item.status !== 'archived' && <Button size="sm" variant="outline" onClick={() => action(item, 'archive', 'Template archived')}><Archive className="w-4 h-4" /></Button>}
                <Button size="sm" variant="outline" className="text-red-600" onClick={() => remove(item)}><Trash2 className="w-4 h-4" /></Button>
              </div>
            </CardContent>
          </Card>)}
        </div>
      </div>
    </div>
  );
}

function TemplateDesigner({ id }) {
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const uploadRef = useRef(null);
  const interaction = useRef(null);
  const [draft, setDraft] = useState(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState('fit-width');
  const [scale, setScale] = useState(1);
  const [preview, setPreview] = useState(() => new URLSearchParams(window.location.search).get('preview') === '1');
  const [saving, setSaving] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['cpd-certificate-template', id],
    queryFn: () => api(`/${id}`),
  });
  const source = data ? draftFromResponse(data) : null;
  useEffect(() => {
    if (!source) return;
    const next = source;
    setDraft(next);
    setSavedSnapshot(JSON.stringify(next));
  }, [data]);
  useEffect(() => {
    let cancelled = false;
    api(`/${id}/source`).then(result => {
      if (!cancelled) setSourceUrl(result.signedUrl || '');
    }).catch(() => { if (!cancelled) setSourceUrl(''); });
    return () => { cancelled = true; };
  }, [id, draft?.version]);
  const dirty = draft && JSON.stringify(draft) !== savedSnapshot;
  const pages = useMemo(() => templatePages(draft), [draft]);
  const page = pages[currentPage - 1] || pages[0];
  const selected = draft?.fields?.find(field => field.id === selectedId);

  useEffect(() => {
    const resize = () => {
      const box = containerRef.current?.getBoundingClientRect();
      setScale(calculateFitScale(zoom, { width: Math.max(200, (box?.width || 900) - 24), height: window.innerHeight - 250 }, page, 1));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [zoom, page]);
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = e => { e.preventDefault(); e.returnValue = ''; };
    const links = e => {
      const link = e.target.closest?.('a[href]');
      if (link && !window.confirm('Discard unsaved certificate changes?')) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', links, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', links, true); };
  }, [dirty]);
  useEffect(() => {
    const move = e => {
      if (!interaction.current) return;
      const { startX, startY, original, type } = interaction.current;
      const next = type === 'resize'
        ? resizeBox(original, e.clientX - startX, e.clientY - startY, scale, page)
        : moveBox(original, e.clientX - startX, e.clientY - startY, scale, page);
      setDraft(old => ({ ...old, fields: old.fields.map(f => f.id === original.id ? { ...f, ...next } : f) }));
    };
    const up = () => { interaction.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [scale, page]);

  const update = patch => setDraft(old => ({ ...old, fields: old.fields.map(f => f.id === selectedId ? { ...f, ...patch } : f) }));
  const addField = field => {
    const next = normalizeBox({ ...DEFAULT_FIELD, id: crypto.randomUUID(), key: field.key, label: field.label, sample: field.sample || field.label, page: currentPage }, page);
    setDraft(old => ({ ...old, fields: [...old.fields, next] }));
    setSelectedId(next.id);
  };
  const deleteField = () => {
    setDraft(old => ({ ...old, fields: old.fields.filter(f => f.id !== selectedId) }));
    setSelectedId(null);
  };
  const duplicateField = () => {
    if (!selected) return;
    const copy = normalizeBox({ ...selected, id: crypto.randomUUID(), x: selected.x + 10, y: selected.y + 10 }, page);
    setDraft(old => ({ ...old, fields: [...old.fields, copy] }));
    setSelectedId(copy.id);
  };
  const nudge = e => {
    if (!selected || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    e.preventDefault();
    const amount = e.shiftKey ? 10 : 1;
    update(normalizeBox({ ...selected, x: selected.x + (e.key === 'ArrowRight' ? amount : e.key === 'ArrowLeft' ? -amount : 0), y: selected.y + (e.key === 'ArrowDown' ? amount : e.key === 'ArrowUp' ? -amount : 0) }, page));
  };
  useEffect(() => {
    window.addEventListener('keydown', nudge);
    return () => window.removeEventListener('keydown', nudge);
  });

  const save = async () => {
    setSaving(true);
    try {
      const placeholders = draft.fields.map((field, displayOrder) =>
        serializeCertificatePlaceholder({ ...field, display_order: displayOrder }));
      const payload = {
        name: draft.name,
        description: draft.description,
        expectedVersion: draft.version,
        placeholders,
      };
      const result = unwrapTemplate(await api(`/${id}`, { method: 'PUT', body: JSON.stringify(payload) })) || payload;
      const next = draftFromResponse({ ...payload, ...result, placeholders: result.placeholders || payload.placeholders });
      setDraft(next); setSavedSnapshot(JSON.stringify(next)); toast.success('Template saved');
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };
  const replacePdf = async file => {
    if (!file) return;
    if (!window.confirm('Replacing the PDF may change page sizes. Review every field position after upload. Continue?')) return;
    const form = new FormData();
    form.append('file', file);
    form.append('expectedVersion', String(draft.version));
    try {
      const result = unwrapTemplate(await api(`/${id}/source`, { method: 'PUT', body: form }));
      setDraft(old => ({ ...old, ...result }));
      setSourceUrl('');
      toast.warning('PDF replaced. Review all pages and field positions before activating.');
    } catch (e) { toast.error(e.message); }
  };
  const testPdf = async () => {
    if (missing.length && !window.confirm(`${missing.length} field(s) have no sample value and will be blank. Generate the test PDF anyway?`)) return;
    try {
      const values = certificateSampleValues(draft.fields);
      const response = await fetch(certificateTemplateEndpoints(id).render, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || 'Could not generate test PDF');
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${draft.name || 'certificate'}-test.pdf`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(e.message); }
  };
  const leave = () => { if (!dirty || window.confirm('Discard unsaved certificate changes?')) navigate('/CPDCertificateTemplates'); };
  const missing = draft?.fields?.filter(f => !String(f.sample || f.default_value || '').trim()) || [];
  const isActive = draft.status === 'active';

  if (isLoading || !draft) return <div className="p-12 text-center">{error ? error.message : 'Loading designer…'}</div>;
  return (
    <div className="min-h-screen bg-slate-100" onKeyDown={nudge}>
      <header className="sticky top-0 z-30 bg-white border-b px-4 py-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={leave}>Templates</Button>
        <Input className="w-60" value={draft.name || draft.title || ''} onChange={e => setDraft(old => ({ ...old, name: e.target.value }))} />
        {dirty && <Badge variant="outline" className="text-amber-700">Unsaved</Badge>}
        <div className="flex-1" />
        {!isActive && <><Button variant="outline" onClick={() => uploadRef.current?.click()}><Upload className="w-4 h-4 mr-2" />Replace PDF</Button>
        <input hidden ref={uploadRef} type="file" accept="application/pdf" onChange={e => replacePdf(e.target.files?.[0])} /></>}
        <Button variant="outline" onClick={testPdf} disabled={dirty}
          title={dirty ? 'Save the template before generating a test PDF' : undefined}>
          <Download className="w-4 h-4 mr-2" />Test PDF
        </Button>
        {!isActive && <Button variant="outline" onClick={() => setPreview(v => !v)}>{preview ? 'Edit' : 'Preview'}</Button>}
        {!isActive && <Button onClick={save} disabled={!dirty || saving}><Save className="w-4 h-4 mr-2" />{saving ? 'Saving…' : 'Save'}</Button>}
      </header>
      {missing.length > 0 && <div className="bg-amber-50 border-b border-amber-200 px-5 py-2 text-sm text-amber-900">
        Preview warning: {missing.length} field(s) have no sample value.
      </div>}
      <div className="grid xl:grid-cols-[260px_minmax(480px,1fr)_300px]">
        {!preview && !isActive && <aside className="bg-white border-r p-4 space-y-5">
          <section><h2 className="font-semibold mb-2">Built-in fields</h2>
            <div className="space-y-1">{BUILTIN_FIELDS.map(([key, label, sample]) =>
              <Button key={key} variant="ghost" size="sm" className="w-full justify-start" onClick={() => addField({ key, label, sample })}><Plus className="w-3 h-3 mr-2" />{label}</Button>)}</div></section>
          <section><h2 className="font-semibold mb-2">Custom fields</h2>
            <CustomFieldForm onAdd={addField} />
          </section>
        </aside>}
        <main className="min-w-0">
          <div className="bg-white border-b p-2 flex justify-center items-center gap-2">
            <Label>Page</Label><select className="border rounded h-9 px-2" value={currentPage} onChange={e => setCurrentPage(Number(e.target.value))}>
              {pages.map((_, i) => <option key={i} value={i + 1}>{i + 1} of {pages.length}</option>)}</select>
            <ZoomIn className="w-4 h-4 ml-3" />
            <select className="border rounded h-9 px-2" value={zoom} onChange={e => setZoom(e.target.value.startsWith('fit') ? e.target.value : Number(e.target.value))}>
              <option value="fit-width">Fit width</option><option value="fit-page">Fit page</option>
              <option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option>
            </select>
            <span className="text-xs text-slate-500">{Math.round(scale * 100)}% · {page.width} × {page.height} pt</span>
          </div>
          <div ref={containerRef} className="overflow-auto p-6 min-h-[calc(100vh-116px)]">
            <div className="relative mx-auto bg-white shadow-xl overflow-hidden" style={{ width: pointsToPixels(page.width, scale), height: pointsToPixels(page.height, scale) }}>
              {sourceUrl ? <PdfPage sourceUrl={sourceUrl} pageNumber={currentPage} scale={scale} /> :
                <div className="absolute inset-0 grid place-items-center text-slate-400"><FileText />PDF unavailable</div>}
              {draft.fields.filter(f => Number(f.page || 1) === currentPage).map(field => {
                const active = field.id === selectedId;
                const rawValue = field.sample || field.default_value;
                const value = preview
                  ? (rawValue ? formatCertificateValue(rawValue, field) : `Missing: ${field.label || field.key}`)
                  : `{{${field.key}}}`;
                return <div key={field.id} onPointerDown={e => {
                  if (preview) return; e.preventDefault(); setSelectedId(field.id);
                  interaction.current = { startX: e.clientX, startY: e.clientY, original: field, type: 'move' };
                }} className={`absolute overflow-hidden ${preview ? '' : `cursor-move border ${active ? 'border-blue-600 bg-blue-50/30' : 'border-dashed border-blue-400'}`}`}
                  style={{ left: pointsToPixels(field.x, scale), top: pointsToPixels(field.y, scale), width: pointsToPixels(field.width, scale), height: pointsToPixels(field.height, scale),
                    color: field.color, fontFamily: field.font_family, fontSize: pointsToPixels(field.font_size, scale), fontWeight: field.font_weight, fontStyle: field.font_style,
                    textAlign: field.align, whiteSpace: field.multiline ? 'pre-wrap' : 'nowrap', display: 'flex', alignItems: field.vertical_align === 'top' ? 'flex-start' : field.vertical_align === 'bottom' ? 'flex-end' : 'center',
                    justifyContent: field.align === 'center' ? 'center' : field.align === 'right' ? 'flex-end' : 'flex-start',
                  }} title={`${field.x.toFixed?.(1) ?? field.x}, ${field.y.toFixed?.(1) ?? field.y} pt`}>
                  {preview
                    ? <PreviewText field={field} value={value} scale={scale} />
                    : <span className="overflow-hidden text-ellipsis" style={{ maxWidth: '100%' }}>{value}</span>}
                  {!preview && active && <button aria-label="Resize field" className="absolute right-0 bottom-0 w-3 h-3 bg-blue-600 cursor-se-resize"
                    onPointerDown={e => { e.stopPropagation(); interaction.current = { startX: e.clientX, startY: e.clientY, original: field, type: 'resize' }; }} />}
                </div>;
              })}
            </div>
          </div>
        </main>
        {!preview && !isActive && <aside className="bg-white border-l p-4 overflow-y-auto max-h-[calc(100vh-65px)]">
          {!selected ? <p className="text-sm text-slate-500">Select a field to edit it. Drag to move; use arrow keys for 1 pt nudges and Shift + arrow for 10 pt.</p> :
            <FieldInspector field={selected} update={update} duplicate={duplicateField} remove={deleteField} pages={pages} />}
        </aside>}
      </div>
    </div>
  );
}

function PdfPage({ sourceUrl, pageNumber, scale }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let task;
    const render = async () => {
      try {
        const document = await pdfjs.getDocument(sourceUrl).promise;
        const pdfPage = await document.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        task = pdfPage.render({ canvasContext: context, viewport });
        await task.promise;
      } catch (error) {
        // Source URLs are short-lived; the adjacent designer remains usable
        // and the source endpoint will be requested again on reload.
        if (!cancelled) console.error('Could not render certificate PDF', error);
      }
    };
    render();
    return () => { cancelled = true; task?.cancel(); };
  }, [sourceUrl, pageNumber, scale]);
  return <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} className="absolute inset-0 pointer-events-none" />;
}

function PreviewText({ field, value, scale }) {
  const ref = useRef(null);
  const preferred = pointsToPixels(field.font_size, scale);
  const minimum = pointsToPixels(field.minimum_font_size || 4, scale);
  const [fontSize, setFontSize] = useState(preferred);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let next = preferred;
    element.style.fontSize = `${next}px`;
    if (field.shrink_to_fit !== false) {
      while (next > minimum && (element.scrollWidth > element.clientWidth + 0.5 || element.scrollHeight > element.clientHeight + 0.5)) {
        next = Math.max(minimum, next - 0.5);
        element.style.fontSize = `${next}px`;
      }
    }
    setFontSize(next);
  }, [field.height, field.minimum_font_size, field.multiline, field.shrink_to_fit, field.width, minimum, preferred, value]);
  return <span ref={ref} className="block overflow-hidden text-ellipsis w-full max-h-full"
    style={{
      fontSize,
      lineHeight: field.line_height || 1.2,
      whiteSpace: field.multiline ? 'pre-wrap' : 'nowrap',
      overflowWrap: field.multiline ? 'anywhere' : 'normal',
    }}>{value}</span>;
}

function CustomFieldForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const add = () => {
    const cleanKey = key.trim();
    if (!label.trim() || !/^[a-z][a-z0-9_.-]*$/i.test(cleanKey)) {
      toast.error('Enter a label and a valid data key, such as cpd.learning_outcome');
      return;
    }
    onAdd({ key: cleanKey, label: label.trim(), sample: '' });
    setLabel(''); setKey(''); setOpen(false);
  };
  if (!open) return <Button variant="outline" size="sm" className="w-full mb-2" onClick={() => setOpen(true)}><Plus className="w-3 h-3 mr-2" />Add custom placeholder</Button>;
  return <div className="border rounded p-2 space-y-2 mb-2">
    <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" />
    <Input value={key} onChange={e => setKey(e.target.value)} placeholder="Data key, e.g. course.module" />
    <div className="flex gap-1"><Button size="sm" onClick={add}>Add</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
  </div>;
}

function FieldInspector({ field, update, duplicate, remove, pages }) {
  const setNumber = key => e => update({ [key]: Number(e.target.value) });
  const isDate = field.field_type === 'date' || field.key?.includes('date') || field.key?.includes('issued_at');
  const isNumber = field.field_type === 'number' || field.key?.includes('hours');
  return <div className="space-y-4">
    <div><h2 className="font-semibold">{field.label || field.key}</h2><code className="text-xs text-slate-500">{field.key}</code></div>
    <div><Label>Field label</Label><Input value={field.label || ''} onChange={e => update({ label: e.target.value })} /></div>
    <div><Label>Data key</Label><Input value={field.key || ''} onChange={e => update({ key: e.target.value })} /></div>
    <div><Label>Field type</Label><select className="border rounded h-9 w-full" value={field.field_type || (isDate ? 'date' : isNumber ? 'number' : 'text')} onChange={e => update({ field_type: e.target.value })}><option>text</option><option>date</option><option>number</option></select></div>
    <div className="grid grid-cols-2 gap-2">
      <div><Label>Page</Label><select className="border rounded h-9 w-full" value={field.page} onChange={setNumber('page')}>{pages.map((_, i) => <option key={i}>{i + 1}</option>)}</select></div>
      {['x', 'y', 'width', 'height'].map(key => <div key={key}><Label>{key[0].toUpperCase() + key.slice(1)} (pt)</Label><Input type="number" step="0.5" value={field[key]} onChange={setNumber(key)} /></div>)}
    </div>
    <div><Label>Sample / preview value</Label><textarea className="border rounded p-2 w-full min-h-16" value={field.sample || ''} onChange={e => update({ sample: e.target.value })} /></div>
    <div><Label>Default value when data is missing</Label><Input value={field.default_value || ''} onChange={e => update({ default_value: e.target.value })} /></div>
    <div><Label>Font family</Label><select className="border rounded h-9 w-full" value={field.font_family} onChange={e => update({ font_family: e.target.value })}>
      <option value="Helvetica">Helvetica</option><option value="Times">Times Roman</option><option value="Courier">Courier</option>
    </select></div>
    <div className="grid grid-cols-2 gap-2">
      <div><Label>Font size (pt)</Label><Input type="number" min="4" max="144" value={field.font_size} onChange={setNumber('font_size')} /></div>
      <div><Label>Minimum size</Label><Input type="number" min="4" max="144" value={field.minimum_font_size} onChange={setNumber('minimum_font_size')} /></div>
      <div><Label>Colour</Label><Input type="color" value={field.color} onChange={e => update({ color: e.target.value })} /></div>
      <div><Label>Weight</Label><select className="border rounded h-9 w-full" value={field.font_weight} onChange={e => update({ font_weight: e.target.value })}><option value="normal">Regular</option><option value="bold">Bold</option></select></div>
      <div><Label>Style</Label><select className="border rounded h-9 w-full" value={field.font_style} onChange={e => update({ font_style: e.target.value })}><option value="normal">Normal</option><option value="italic">Italic</option></select></div>
      <div><Label>Alignment</Label><select className="border rounded h-9 w-full" value={field.align} onChange={e => update({ align: e.target.value })}><option>left</option><option>center</option><option>right</option></select></div>
      <div><Label>Vertical</Label><select className="border rounded h-9 w-full" value={field.vertical_align} onChange={e => update({ vertical_align: e.target.value })}><option>top</option><option>middle</option><option>bottom</option></select></div>
    </div>
    {isDate && <div><Label>Date format</Label><Input value={field.date_format || ''} onChange={e => update({ date_format: e.target.value })} placeholder="D MMMM YYYY" /></div>}
    {isNumber && <div><Label>Number format</Label><Input value={field.number_format || ''} onChange={e => update({ number_format: e.target.value })} placeholder="0.##" /></div>}
    {[['multiline', 'Allow multiple lines'], ['shrink_to_fit', 'Shrink text to fit'], ['required', 'Warn when missing']].map(([key, label]) =>
      <div className="flex items-center justify-between" key={key}><Label>{label}</Label><Switch checked={!!field[key]} onCheckedChange={value => update({ [key]: value })} /></div>)}
    <div className="flex gap-2 pt-2"><Button variant="outline" onClick={duplicate}><Copy className="w-4 h-4 mr-1" />Duplicate</Button>
      <Button variant="outline" className="text-red-600" onClick={remove}><Trash2 className="w-4 h-4" /></Button></div>
    <p className="text-xs text-slate-500 flex gap-1"><Move className="w-3 h-3" />All geometry is stored in PDF points (1/72 inch), independent of zoom.</p>
  </div>;
}