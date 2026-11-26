import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formSubmissionInvoice, formInvoiceFilename } from '../../../../shared/formSubmissionInvoice.js';

export default function SubmissionInvoiceActions({ submission }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const invoice = formSubmissionInvoice(submission);
  if (!invoice) return null;

  const openInvoice = async (mode) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(mode);
    setError('');
    // Reserve the tab during the user gesture so popup blockers do not reject
    // it after the authenticated fetch. Close it if retrieval fails.
    const tab = mode === 'view' ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    try {
      if (mode === 'view' && !tab) throw new Error('Allow pop-ups for this site to view the invoice, or use Download invoice.');
      const response = await fetch(`/api/form-submission-invoice/${encodeURIComponent(submission.id)}${mode === 'view' ? '?inline=true' : ''}`, { credentials: 'include' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Unable to retrieve the invoice. Please try again.');
      }
      const blob = await response.blob();
      if (!response.headers.get('content-type')?.includes('application/pdf')
        || await blob.slice(0, 5).text() !== '%PDF-') {
        throw new Error('The invoice service did not return a PDF. Please try again later.');
      }
      const url = URL.createObjectURL(blob);
      if (mode === 'view') tab.location.replace(url);
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = formInvoiceFilename(invoice.number, submission.id);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      // Allow the new tab/browser download time to consume the object URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      tab?.close();
      setError(err.message || 'Unable to retrieve the invoice. Please try again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {invoice.number ? `Invoice ${invoice.number}` : invoice.linked ? 'Invoice issued' : 'Invoice requested — accounting processing is pending.'}
      </p>
      {invoice.linked && <>
        <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => openInvoice('view')}>
          {busy === 'view' ? 'Opening invoice…' : 'View invoice'}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => openInvoice('download')}>
          {busy === 'download' ? 'Downloading invoice…' : 'Download invoice'}
        </Button>
      </>}
    </div>
    {busy && <span role="status" className="sr-only">Retrieving invoice PDF</span>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
  </div>;
}
