import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { certificateRequest, downloadCertificate } from './useAwardCertificates';

export default function CertificateIssuance({ tenant, templates, outcomes, issues, ready, onIssued, onDirtyChange, onBusyChange }) {
  const [templateId, setTemplateId] = useState(''), [outcomeId, setOutcomeId] = useState(''), [recipientMode, setRecipientMode] = useState('');
  const [recipientName, setRecipientName] = useState(''), [reason, setReason] = useState(''), [preview, setPreview] = useState(null), [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const draft = { templateId, outcomeId, ...(recipientMode === 'external' ? { recipientName: recipientName.trim() } : {}) };
  const signature = JSON.stringify(draft);
  const dirty = !!(templateId || outcomeId || recipientName || reason || recipientMode);
  const existingIssue = issues.find(item => item.outcome_revision_id === outcomeId);
  const valid = ready && !blocked && !existingIssue && templates.some(item => item.id === templateId) && outcomes.some(item => item.id === outcomeId)
    && recipientMode && (recipientMode !== 'external' || !!recipientName.trim());
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  useEffect(() => { setPreview(null); }, [signature]);
  const currentOutcome = outcomes.find(item => item.id === outcomeId);
  const previewPdf = async () => {
    if (pending.current || !valid) return;
    pending.current = true; setBusy(true); setError(''); setPreview(null); setNotice('');
    try {
      const blob = await certificateRequest(tenant, '/api/awards/certificates', { body: { command: 'preview', ...draft }, pdf: true });
      tenant.assertCurrent(); if (!alive.current) return;
      setPreview({ signature, payload: { ...draft }, blob });
      setNotice('Preview ready. Download and review this server-rendered PDF before explicitly approving immutable generation. This has not issued anything.');
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const issue = async () => {
    if (pending.current || !confirmation || !ready || blocked || existingIssue) return;
    pending.current = true; setBusy(true); setError('');
    let confirmed = false;
    try {
      const result = await certificateRequest(tenant, '/api/awards/certificates', { body: { command: 'issue', ...confirmation.payload, approved: true, reason: confirmation.reason } });
      if (!result.id || typeof result.replayed !== 'boolean' || result.delivery !== 'unchanged' || result.sent !== false) throw new Error('The server did not confirm immutable issuance.');
      confirmed = true;
      if (!alive.current) return;
      setNotice(`${result.replayed ? 'Existing immutable issue confirmed' : 'Certificate issued'} (${result.id}). Delivery and release are unchanged. No email was sent.`);
      setConfirmation(null); setPreview(null); setReason(''); setTemplateId(''); setOutcomeId(''); setRecipientMode(''); setRecipientName('');
      await onIssued();
    } catch (failure) { if (alive.current) { setBlocked(true); setError(confirmed ? `Issuance was confirmed, but current records could not be refreshed. Do not generate again. Reconcile the records below. ${failure.message}` : `${failure.message} Inputs and confirmation are retained. Reload current certificate/outcome records before retrying; generation may already have succeeded.`); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="border-t pt-5 space-y-4">
    <h3 className="font-semibold">Preview & issue an award certificate</h3>
    <p className="awards-help">Only approved, certificate-enabled outcome records returned by the server are offered. Issuance rechecks that the decision is current. Recipient handling is explicit; member names always come from the server. External names require approval here.</p>
    {!outcomes.length && <div className="rounded-lg border border-dashed p-5 awards-help">No approved certificate-enabled outcomes are available. This does not approve a decision, release an outcome or send a message.</div>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    {blocked && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => { if (pending.current) return; pending.current = true; setBusy(true); try { await onIssued(); tenant.assertCurrent(); if (alive.current) { setBlocked(false); setConfirmation(null); setPreview(null); setNotice('Records reloaded. Inspect existing issues, then generate a new preview before another explicit confirmation.'); } } catch (failure) { if (alive.current) setError(failure.message); } finally { pending.current = false; if (alive.current) setBusy(false); } }}>Reconcile issuance (keep selections and reason)</Button>}
    <fieldset disabled={busy || !ready || !!confirmation} className="space-y-4">
      <label className="block text-sm">Template version<select className="awards-select mt-1 w-full" value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">Choose a latest template version</option>{templateId && !templates.some(item => item.id === templateId) && <option value={templateId} disabled>Retained version {templateId} — no longer a latest choice; select explicitly</option>}{templates.map(item => <option key={item.id} value={item.id}>{item.name} — version {item.revision}</option>)}</select></label>
      <label className="block text-sm">Approved outcome<select className="awards-select mt-1 w-full" value={outcomeId} onChange={e => { setOutcomeId(e.target.value); setRecipientMode(''); setRecipientName(''); setPreview(null); }}><option value="">Choose an approved outcome</option>{outcomeId && !outcomes.some(item => item.id === outcomeId) && <option value={outcomeId} disabled>Retained decision {outcomeId} — unavailable in loaded approved choices</option>}{outcomes.map(item => <option key={item.id} value={item.id}>{item.category_snapshot?.name || 'Award category'} — application {item.application_id} — decision revision {item.revision}</option>)}</select></label>
      {currentOutcome && <p className="awards-help">Application ID: {currentOutcome.application_id}. {existingIssue ? `Immutable issue ${existingIssue.id} already uses template ID ${existingIssue.template_id}. Generation is disabled for this outcome; its PDF and recipient cannot be replaced here.` : 'No issue is present for this outcome in the complete loaded issue history.'}</p>}
      <label className="block text-sm">Recipient handling<select className="awards-select mt-1 w-full" value={recipientMode} onChange={e => setRecipientMode(e.target.value)}><option value="">Choose explicitly</option><option value="member">Member — server-resolved name</option><option value="external">External recipient — explicitly approved name</option></select></label>
      {recipientMode === 'external' && <label className="block text-sm">Approved external certificate name<Input required maxLength={300} value={recipientName} onChange={e => setRecipientName(e.target.value)} /><span className="awards-help block mt-1">Used only for an external application. If the server identifies a member application, its member name is used instead; review the actual preview PDF.</span></label>}
      <div className="flex gap-2 flex-wrap"><Button type="button" variant="outline" disabled={!valid || busy} onClick={previewPdf}>{busy ? 'Preparing PDF…' : 'Generate server preview'}</Button>
        {preview?.signature === signature && <Button type="button" variant="outline" onClick={() => { tenant.assertCurrent(); downloadCertificate(preview.blob, 'award-certificate-preview.pdf'); setPreview(old => old ? { ...old, downloaded: true } : old); }}>Download preview for review</Button>}</div>
      <label className="block text-sm">Generation approval reason<Textarea required maxLength={20000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <Button type="button" disabled={!valid || busy || !reason.trim() || !preview?.downloaded || preview.signature !== signature} onClick={() => {
        setConfirmation({ payload: { ...preview.payload }, reason: reason.trim(), template: templates.find(item => item.id === templateId), outcome: { ...currentOutcome } });
      }}>Review immutable issuance…</Button>
    </fieldset>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) setConfirmation(null); }}><DialogContent><DialogHeader><DialogTitle>Approve immutable certificate generation</DialogTitle><DialogDescription>This records an immutable PDF for the snapshotted outcome and template. It does not send email, authorise delivery or change recipient release.</DialogDescription></DialogHeader>
      {confirmation && <div className="text-sm space-y-3"><p>{confirmation.template?.name} — template version {confirmation.template?.revision}</p><p>Application: {confirmation.outcome.application_id}; approved decision revision {confirmation.outcome.revision}.</p><p>{confirmation.payload.recipientName ? `Approved external-name input: ${confirmation.payload.recipientName}. Member-linked applications ignore this input and use the member name.` : 'Recipient handling: server-resolved member name. External applications require an approved external name.'}</p><p className="whitespace-pre-wrap break-words">Reason: {confirmation.reason}</p><p>Member name and issue date are resolved again by the server at generation. If another request already issued this outcome, the existing PDF is retained instead of applying these new selections.</p></div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {existingIssue && <p role="alert" className="awards-help">An immutable issue is now present in the loaded records. Close this dialog and inspect the issue history; no replacement will be generated.</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Close (keep inputs)</Button><Button type="button" disabled={busy || !ready || blocked || !!existingIssue} onClick={issue}>{busy ? 'Confirming issuance…' : 'Approve and generate certificate'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
