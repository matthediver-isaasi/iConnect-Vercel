import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function request(url, options) {
  const response = await fetch(url, { credentials: 'include', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The document request failed. Please try again.');
  return data;
}

export function MemberDocumentUpload({ memberId }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const client = useQueryClient();
  const upload = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setMessage(null);
    if (!file.size || file.size > 2 * 1024 * 1024) {
      setMessage({ error: true, text: 'Choose a non-empty document of up to 2 MB.' });
      event.target.value = '';
      return;
    }
    setBusy(true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('The file could not be read.'));
        reader.readAsDataURL(file);
      });
      await request(`/api/admin/members/${memberId}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: { name: file.name, base64 } }),
      });
      await client.invalidateQueries({ queryKey: ['member-notes', memberId] });
      setMessage({ text: 'Document uploaded and saved in the notes below.' });
    } catch (error) {
      setMessage({ error: true, text: error.message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return <div className="space-y-2 rounded-md border p-3">
    <input ref={input} type="file" className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.png,.jpg,.jpeg"
      aria-label="Choose member document" onChange={upload} disabled={busy} />
    <Button type="button" variant="outline" disabled={busy || !memberId} onClick={() => input.current?.click()}>
      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
      {busy ? 'Uploading document…' : 'Upload document'}
    </Button>
    <p className="text-xs text-muted-foreground">PDF, Word, Excel, text, CSV or images, up to 2 MB each. Documents are private and saved as notes on this member’s record.</p>
    {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-sm text-destructive' : 'text-sm'}>{message.text}</p>}
  </div>;
}

export function MemberNoteDocuments({ memberId, note }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const download = async index => {
    setPending(index);
    setError('');
    try {
      const { url } = await request(`/api/admin/members/${memberId}/notes?documentNoteId=${encodeURIComponent(note.id)}&documentIndex=${index}`);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.rel = 'noopener noreferrer';
      anchor.click();
    } catch (error) {
      setError(error.message);
    } finally {
      setPending(null);
    }
  };
  return <div className="space-y-2">
    {(note.attachments || []).map((file, index) => file.storage_path ? <Button key={index} type="button"
      variant="outline" className="h-auto max-w-full whitespace-normal text-left" disabled={pending !== null} onClick={() => download(index)}>
      {pending === index ? <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" /> : <Download className="mr-2 h-4 w-4 shrink-0" />}
      <span className="break-all">{file.file_name} {file.file_size ? `(${Math.ceil(file.file_size / 1024)} KB)` : ''}</span>
    </Button> : null)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
