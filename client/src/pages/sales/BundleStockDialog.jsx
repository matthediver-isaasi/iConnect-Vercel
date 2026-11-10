import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { parseBundleStock } from '@/lib/formBundles';

export default function BundleStockDialog({ row, saving, onSave, onClose, onRefresh }) {
  const stock = row.productStock || row.bundleStock;
  const kind = row.productStock ? 'product' : 'bundle';
  const [unlimited, setUnlimited] = useState(stock?.remaining === null);
  const [remaining, setRemaining] = useState(stock?.remaining ?? '');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (saving || conflict || !stock) return;
    setError('');
    try { await onSave({ id: row.id, remaining: parseBundleStock(unlimited, remaining), expectedVersion: stock.version }); }
    catch (err) {
      const stale = err.status === 409 || err.response?.status === 409;
      setConflict(stale);
      setError(stale ? 'Stock changed while you were editing. Reload current stock before making another change.' : err.message || 'Stock could not be saved. Please retry.');
    }
  };
  return <Dialog open onOpenChange={open => !open && !saving && onClose()}><DialogContent className="max-w-lg">
    <form onSubmit={submit} className="space-y-4"><DialogHeader><DialogTitle>Edit {kind} stock</DialogTitle><DialogDescription>{row.name}. Stock is managed separately from {kind} contents and pricing.</DialogDescription></DialogHeader>
      <div className="rounded-md border bg-muted/40 p-3 text-sm">Available: {stock ? stock.remaining === null ? 'Unlimited' : stock.remaining : 'Not loaded'} · Reserved: {stock?.reserved ?? 'Not loaded'}</div>
      {stock?.requiresAttention && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Reserved holds need administrator review. Editing available stock does not resolve these holds or confirm their payment status.</p>}
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={unlimited} disabled={saving || conflict} onCheckedChange={value => setUnlimited(value === true)} />Unlimited</label>
      {!unlimited && <div className="space-y-2"><Label htmlFor="bundle-stock-remaining">Available stock</Label><Input id="bundle-stock-remaining" type="number" min="0" step="1" required value={remaining} disabled={saving || conflict} onChange={event => setRemaining(event.target.value)} /></div>}
      <p className="text-xs text-muted-foreground">Selections are immutable after submission. Deleting a submission does not automatically restock. Adjust available stock here when needed; reserved stock is managed by the server.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {conflict && <Button type="button" variant="outline" onClick={onRefresh}>Reload current stock</Button>}
      <DialogFooter><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || conflict || !stock}>{saving ? 'Saving…' : 'Save stock'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
