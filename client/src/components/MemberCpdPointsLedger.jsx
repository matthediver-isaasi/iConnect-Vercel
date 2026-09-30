import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Loader2, RotateCcw, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

async function request(path, options) {
  const response = await fetch(path, { credentials: 'include', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'CPD points request failed');
  return body;
}

export default function MemberCpdPointsLedger({ memberId, enabled, canCorrect, children }) {
  const queryClient = useQueryClient();
  const [correction, setCorrection] = useState(null);
  const [reason, setReason] = useState('');
  const [points, setPoints] = useState('');
  const queryKey = ['member-cpd-points', memberId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    enabled: enabled && canCorrect && !!memberId,
    queryFn: () => request(`/api/admin/member-cpd-points?member_id=${encodeURIComponent(memberId)}`),
  });
  const mutation = useMutation({
    mutationFn: (payload) => request('/api/admin/member-cpd-points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setCorrection(null);
      setReason('');
      setPoints('');
      toast.success('CPD points correction recorded');
    },
    onError: (err) => toast.error(err.message),
  });

  if (!canCorrect || !enabled) return children ? children({}) : null;
  const entries = data?.entries || [];
  const reversed = new Set(entries.filter((entry) => entry.reversal_of).map((entry) => entry.reversal_of));
  const total = entries.reduce((sum, entry) => sum + Number(entry.points_value || 0), 0);
  const open = (action, entry) => {
    setCorrection({ action, entry, correctionKey: crypto.randomUUID() });
    setReason('');
    setPoints('');
  };
  const submit = () => mutation.mutate({
    member_id: memberId,
    ledger_entry_id: correction.entry.id,
    action: correction.action,
    reason,
    ...(correction.action === 'adjust'
      ? { points_value: points, correction_key: correction.correctionKey } : {}),
  });
  const renderActions = (item) => {
    const entry = entries.find(({ id }) => id === item.id) || item;
    if (isLoading || error || !entry || !['event_award', 'imported_award'].includes(entry.entry_kind)) return null;
    return (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => open('adjust', entry)}>
          <Plus className="w-3.5 h-3.5 mr-1" />Adjust
        </Button>
        <Button size="sm" variant="outline" disabled={item.is_reversed || reversed.has(entry.id)}
          onClick={() => open('reverse', entry)}>
          <RotateCcw className="w-3.5 h-3.5 mr-1" />{item.is_reversed || reversed.has(entry.id) ? 'Reversed' : 'Reverse'}
        </Button>
      </div>
    );
  };

  return (
    <>
      {children ? <>
      {children({
        renderActions,
        correctionStatus: isLoading ? 'Loading correction controls…'
          : error ? `Could not load correction controls: ${error.message}` : null,
      })}
      {entries.some(entry => !['event_award', 'imported_award'].includes(entry.entry_kind)) && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">Recent correction audit</summary>
          <p className="text-sm text-muted-foreground my-2">Corrections among the latest 200 ledger entries, newest recorded first.</p>
          {entries.filter(entry => !['event_award', 'imported_award'].includes(entry.entry_kind)).map(entry => (
            <div key={entry.id} className="border-t py-3 text-sm">
              <p>{entry.entry_kind.replaceAll('_', ' ')} · {entry.points_value} points</p>
              <p>Recorded: {new Date(entry.created_at).toLocaleString()}</p>
              {entry.reason && <p>Reason: {entry.reason}</p>}
              {entry.created_by && <p>Actor: {entry.created_by}</p>}
            </div>
          ))}
        </details>
      )}
      </> : <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Award className="w-5 h-5 text-blue-600" /> CPD Points
          </CardTitle>
          <div className="text-sm font-semibold" data-testid="cpd-points-total">{total.toFixed(2)} total</div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : error ? (
            <p className="text-sm text-red-600">{error.message}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-slate-500">No CPD points entries found.</p>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => {
                const isAward = ['event_award', 'imported_award'].includes(entry.entry_kind);
                return (
                  <div key={entry.id} className="rounded-lg border p-3" data-testid={`cpd-entry-${entry.id}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-sm">
                          {entry.activity_title || entry.ticket_name_snapshot || 'Event CPD points'}
                        </p>
                        <p className="text-xs text-slate-500">
                          {new Date(entry.created_at).toLocaleString()} · {entry.entry_kind.replaceAll('_', ' ')}
                        </p>
                        {entry.reason && <p className="text-xs mt-1">Reason: {entry.reason}</p>}
                        {entry.created_by && <p className="text-xs text-slate-500">Actor: {entry.created_by}</p>}
                      </div>
                      <div className={`font-semibold ${Number(entry.points_value) < 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {Number(entry.points_value) > 0 ? '+' : ''}{entry.points_value}
                      </div>
                    </div>
                    {isAward && (
                      <div className="flex gap-2 mt-3">
                        <Button size="sm" variant="outline" onClick={() => open('adjust', entry)}>
                          <Plus className="w-3.5 h-3.5 mr-1" /> Adjust
                        </Button>
                        <Button size="sm" variant="outline" disabled={reversed.has(entry.id)}
                          onClick={() => open('reverse', entry)}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1" />
                          {reversed.has(entry.id) ? 'Reversed' : 'Reverse'}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>}
      <Dialog open={!!correction} onOpenChange={(openState) => !openState && setCorrection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{correction?.action === 'reverse' ? 'Reverse CPD award' : 'Add CPD adjustment'}</DialogTitle>
            <DialogDescription>
              This appends a new audit entry. The original ledger entry will not be changed or deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {correction?.action === 'adjust' && (
              <div className="space-y-2">
                <Label htmlFor="cpd-adjustment">Signed points adjustment</Label>
                <Input id="cpd-adjustment" value={points} onChange={(e) => setPoints(e.target.value)}
                  placeholder="e.g. 2.5 or -1" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="cpd-reason">Reason</Label>
              <Textarea id="cpd-reason" value={reason} maxLength={500}
                onChange={(e) => setReason(e.target.value)} placeholder="Explain why this correction is needed" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrection(null)}>Cancel</Button>
            <Button disabled={mutation.isPending || !reason.trim()
              || (correction?.action === 'adjust' && (!points || Number(points) === 0))}
              onClick={submit}>
              {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Record correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}