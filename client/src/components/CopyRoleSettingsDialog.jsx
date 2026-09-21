import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { copyRoleSettings } from '@/lib/roleSettingsCopy';

export default function CopyRoleSettingsDialog({ roles, onClose, onCopied }) {
  const [sourceRoleId, setSourceRoleId] = useState('');
  const [targetRoleId, setTargetRoleId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const source = roles.find(role => role.id === sourceRoleId);
  const target = roles.find(role => role.id === targetRoleId);
  const valid = source && target && sourceRoleId !== targetRoleId;
  const mutation = useMutation({
    mutationFn: () => copyRoleSettings(sourceRoleId, targetRoleId),
    onSuccess: role => onCopied(role),
  });
  const select = (setter, value) => {
    setter(value);
    setConfirmed(false);
    mutation.reset();
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent onEscapeKeyDown={event => { if (mutation.isPending) event.preventDefault(); }}
        onPointerDownOutside={event => { if (mutation.isPending) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Copy settings to an existing role</DialogTitle>
          <DialogDescription>
            Unlike Duplicate, this replaces settings on an existing role. Only saved settings are copied.
            Save or discard any open role or Member Preferences drafts before continuing, including in other tabs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="copy-role-source">Copy from (source role)</Label>
          <select id="copy-role-source" className="w-full rounded-md border p-2" value={sourceRoleId}
            disabled={mutation.isPending} onChange={event => select(setSourceRoleId, event.target.value)}>
            <option value="">Select source role</option>
            {roles.map(role => <option key={role.id} value={role.id} disabled={role.id === targetRoleId}>{role.name}</option>)}
          </select>
          <Label htmlFor="copy-role-target">Replace settings on (target role)</Label>
          <select id="copy-role-target" className="w-full rounded-md border p-2" value={targetRoleId}
            disabled={mutation.isPending} onChange={event => select(setTargetRoleId, event.target.value)}>
            <option value="">Select target role</option>
            {roles.map(role => <option key={role.id} value={role.id} disabled={role.id === sourceRoleId}>{role.name}</option>)}
          </select>
        </div>
        {valid && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          <p>Replace all access settings and Member Preferences role field permissions on <strong>{target.name}</strong> with
            those from <strong>{source.name}</strong>? Existing target restrictions and permissions will be replaced, not merged.
            The target role's identity and member assignments stay unchanged. This cannot be undone here.</p>
          <label className="mt-3 flex items-start gap-2">
            <input type="checkbox" checked={confirmed} disabled={mutation.isPending}
              onChange={event => setConfirmed(event.target.checked)} />
            <span>I confirm replacing settings on {target.name} with saved settings from {source.name} and discarding stale editor drafts.</span>
          </label>
        </div>}
        {mutation.isError && <p role="alert" className="text-sm text-red-700">{mutation.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!valid || !confirmed || mutation.isPending}
            onClick={() => mutation.mutate()}>{mutation.isPending ? 'Copying settings…' : 'Replace target settings'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}