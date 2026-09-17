import React, { useEffect, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { getActiveTenantId } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { verifyProtectedFormPassword } from '@/lib/protectedFormActions';

export default function ProtectedFormActionDialog({
  open,
  onOpenChange,
  formId,
  action = 'save',
  onAuthorized,
}) {
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState('password');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const isDeactivation = action === 'deactivate';

  useEffect(() => {
    if (!open) {
      setPassword('');
      setStage('password');
      setError('');
      setPending(false);
    }
  }, [open]);

  const close = () => {
    if (!pending) onOpenChange(false);
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    if (!password) {
      setError('Enter the protection password.');
      return;
    }

    setPending(true);
    setError('');
    try {
      if (isDeactivation) {
        await verifyProtectedFormPassword({
          formId,
          password,
          tenantId: getActiveTenantId(),
        });
        setStage('confirm');
        return;
      }
      await onAuthorized(password);
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError?.message || 'The protection password could not be validated.');
    } finally {
      setPending(false);
    }
  };

  const confirmDeactivation = async () => {
    setPending(true);
    setError('');
    try {
      await onAuthorized(password);
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError?.message || 'The form could not be deactivated.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) close();
    }}>
      <DialogContent
        aria-describedby="protected-form-dialog-description"
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {stage === 'confirm' ? 'Confirm form deactivation' : 'Protected form'}
          </DialogTitle>
          <DialogDescription id="protected-form-dialog-description">
            {stage === 'confirm'
              ? 'This form will be made inactive and removed from active use. It will not be deleted, and its configuration, submissions and associated data will remain intact.'
              : `Enter the protection password to ${isDeactivation ? 'deactivate' : 'save changes to'} this form.`}
          </DialogDescription>
        </DialogHeader>

        {stage === 'password' ? (
          <form onSubmit={submitPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="protected-form-password">Protection password</Label>
              <Input
                id="protected-form-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError('');
                }}
                disabled={pending}
                autoFocus
                data-testid="input-form-protection-password"
              />
            </div>
            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !password}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isDeactivation ? 'Validate password' : 'Save Form'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={confirmDeactivation}
                disabled={pending}
                data-testid="button-confirm-form-deactivation"
              >
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm Deactivate Form
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}