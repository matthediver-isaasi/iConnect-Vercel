import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { judgingRequest } from './judgingClient';

export default function JudgeConflictDeclaration({ assignment, disabled, onSaved, onDirtyChange, onBusyChange }) {
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onSaved, onDirtyChange, onBusyChange });
  callbacks.current = { onSaved, onDirtyChange, onBusyChange };
  const dirty = open && Boolean(conflict || reason);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const close = () => {
    if (busy || (dirty && !window.confirm('Discard this unsaved conflict declaration?'))) return;
    setOpen(false); setConflict(''); setReason(''); setError('');
  };
  if (['potential', 'confirmed'].includes(assignment.conflict)) return <p className="awards-help mt-3">A declared conflict requires administrator review; it cannot be cleared here.</p>;
  return <div className="mt-3">
    <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setOpen(true); setConflict(''); setReason(''); setError(''); }}>Declare conflict status</Button>
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Declare your conflict status</DialogTitle><DialogDescription>Application {assignment.applicationReference}. Potential conflicts restrict assessment access. A confirmed conflict recuses this assignment. Declared conflicts require administrator review to clear.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={async event => {
          event.preventDefault();
          if (pending.current || !conflict || (conflict !== 'none' && !reason.trim())) return;
          if (conflict === 'none' && !window.confirm('Confirm that you have no conflict of interest for this application?')) return;
          pending.current = true; setBusy(true); setError('');
          try {
            const result = await judgingRequest('/api/judging/conflict', { body: { assignmentId: assignment.id, version: assignment.version, conflict, reason: reason.trim() } });
            if (result.assignment_id !== assignment.id || result.conflict !== conflict || !Number.isInteger(result.version)) throw new Error('The server did not confirm the declaration. Refresh before retrying.');
            if (!mounted.current) return;
            setOpen(false); setConflict(''); setReason('');
            callbacks.current.onSaved(result);
          } catch (failure) { if (mounted.current) setError(failure.message); }
          finally { pending.current = false; if (mounted.current) setBusy(false); }
        }}>
          <div className="awards-field"><Label htmlFor={`conflict-${assignment.id}`}>Conflict declaration</Label><select id={`conflict-${assignment.id}`} className="awards-select" value={conflict} required disabled={busy} onChange={event => setConflict(event.target.value)}>
            <option value="" disabled>Choose explicitly</option><option value="none">No conflict of interest</option><option value="potential">Potential conflict</option><option value="confirmed">Confirmed conflict</option>
          </select></div>
          <div className="awards-field"><Label htmlFor={`conflict-reason-${assignment.id}`}>Reason {conflict && conflict !== 'none' ? '(required)' : '(optional for no conflict)'}</Label><Textarea id={`conflict-reason-${assignment.id}`} maxLength={10000} required={Boolean(conflict && conflict !== 'none')} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>
          {error && <p role="alert" className="text-sm text-red-800">{error} Your declaration is not confirmed saved. The entered reason is retained.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !conflict || (conflict !== 'none' && !reason.trim())}>{busy ? 'Saving…' : 'Save declaration'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
