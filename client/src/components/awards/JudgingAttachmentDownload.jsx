import { useLayoutEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { judgingAttachmentRequest } from './judgingClient';

function downloadName(value) {
  const leaf = typeof value === 'string' ? value.split(/[\\/]/).pop() : '';
  let name = (leaf || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `attachment-${name}`;
  return Array.from(name).slice(0, 180).join('') || 'award-attachment';
}

export default function JudgingAttachmentDownload({ attachment, assignmentId, authority, requestAttachment, onAccessLost }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const pending = useRef(null);
  const resources = useRef(new Map());
  const filename = downloadName(attachment.name);
  useLayoutEffect(() => {
    mounted.current = true;
    setBusy(false); setError(''); setNotice('');
    const urls = resources.current;
    return () => {
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
      for (const [url, timer] of urls) { window.clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    };
  }, [assignmentId, attachment.id, authority?.scopeKey, authority?.ready]);
  const download = async () => {
    if (pending.current || !authority?.ready) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError(''); setNotice('');
    let url;
    let anchor;
    try {
      const blob = requestAttachment
        ? await requestAttachment(attachment.id, { authority, signal: controller.signal })
        : await judgingAttachmentRequest(assignmentId, attachment.id, { authority, signal: controller.signal });
      if (!mounted.current || pending.current !== controller || controller.signal.aborted) return;
      authority.assertCurrent();
      url = URL.createObjectURL(blob);
      // Track immediately so every exception/context change can revoke it.
      resources.current.set(url, null);
      anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; anchor.rel = 'noopener';
      anchor.hidden = true;
      document.body.appendChild(anchor);
      authority.assertCurrent();
      if (controller.signal.aborted) throw new DOMException('Attachment download cancelled.', 'AbortError');
      anchor.click();
      // Do not claim the browser saved a file to disk.
      setNotice('Complete file verified. Download handed to your browser.');
      const retainedUrl = url;
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(retainedUrl);
        resources.current.delete(retainedUrl);
      }, 1000);
      resources.current.set(url, timer);
      url = null;
    } catch (failure) {
      if (mounted.current && pending.current === controller && !controller.signal.aborted && failure.name !== 'AbortError') {
        let accessLost = [401, 403, 404, 410].includes(failure.status);
        // Authority can expire before the owning React tree has committed a
        // new scope. Clear its stale projection without touching worksheet data.
        try { authority.assertCurrent(); } catch { accessLost = true; }
        if (accessLost) onAccessLost?.(failure);
        setError(failure.message || 'This attachment could not be downloaded. Try again manually.');
      }
    } finally {
      anchor?.remove();
      if (url) {
        window.clearTimeout(resources.current.get(url));
        resources.current.delete(url);
        URL.revokeObjectURL(url);
      }
      if (pending.current === controller) {
        pending.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  return <li className="rounded-lg border p-3 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0"><p className="break-words font-medium">{attachment.label || 'Attachment'}</p><p className="awards-help break-words">{filename}</p></div>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={busy || !authority?.ready}
        aria-busy={busy} aria-label={`${busy ? 'Downloading' : error ? 'Retry download of' : 'Download'} ${filename}`} onClick={download}>
        <Download className="mr-2 h-4 w-4" aria-hidden="true" />{busy ? 'Downloading…' : error ? 'Retry download' : 'Download'}
      </Button>
      {busy && <Button type="button" size="sm" variant="outline" aria-label={`Cancel download of ${filename}`} onClick={() => {
        pending.current?.abort();
        setNotice('Download cancelled. No file was handed to your browser.');
      }}>Cancel download</Button>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error} No partial file was retained. Local draft responses have not been changed.</p>}
    {notice && <p role="status" className="awards-help mt-3">{notice}</p>}
    {!authority?.ready && <p className="awards-help mt-3">Current evidence access must be verified before downloading.</p>}
  </li>;
}
