import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { useSessionMemberRole } from '@/hooks/useSessionMemberRole';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import LoginForm from './LoginForm';

const refreshPrefixes = new Set([
  'event', 'event-by-slug', 'complex-event', 'complex-event-by-slug',
  'member_group_assignment', 'my-group-ids',
]);

// Layout's reload starts /auth/me; the similarly named access-hook method
// only reloads an already-authenticated member entity and cannot sign in.
export function useEventLogin() {
  const context = useLayoutContext();
  const role = useSessionMemberRole();
  const latest = useRef();
  latest.current = { ...context, ...role };
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef(null);
  const focusFallback = useRef(null);
  const openLogin = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();
    trigger.current = event?.currentTarget || document.activeElement;
    focusFallback.current = trigger.current?.closest('[data-event-login-context]');
    setOpen(true);
  }, []);

  const complete = async (expected) => {
    if (!expected?.id || !expected?.tenant_id) throw new Error('Sign-in could not be verified. Please try again.');
    // Remove previous-identity groups before enabling new authenticated queries.
    const groups = { predicate: q => ['member_group_assignment', 'my-group-ids'].includes(q.queryKey[0]) };
    await queryClient.cancelQueries(groups);
    queryClient.removeQueries(groups);
    if (!context.memberInfo) context.setEventLoginReturnPath?.(window.location.pathname + window.location.search);
    context.reloadMemberInfo({ preserveLayout: true });
    const previousSessionKey = latest.current.sessionRoleSnapshot?.session_key;
    // Wait for the new validation cycle, not a previous render or storage write.
    await new Promise(resolve => setTimeout(resolve, 50));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = latest.current;
      if (state.authResolved) {
        if (!state.sessionValidated || state.memberInfo?.id !== expected.id
          || state.memberInfo?.tenant_id !== expected.tenant_id) {
          throw new Error('Your session could not be refreshed. Please sign in again.');
        }
        if (state.roleStatus === 'error' || state.roleStatus === 'missing') {
          throw new Error('Your membership access could not be loaded. Please try signing in again.');
        }
        if (state.roleStatus === 'ready' && state.sessionRoleSnapshot?.session_key !== previousSessionKey) {
          await queryClient.invalidateQueries({ predicate: q => refreshPrefixes.has(q.queryKey[0]) }, { throwOnError: true });
          setOpen(false);
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Sign-in verification timed out. Please try again.');
  };

  const loginModal = (
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" hideCloseButton={busy}
        onInteractOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          else focusFallback.current?.focus({ preventScroll: true });
        }}>
        <DialogTitle>Sign in to book tickets</DialogTitle>
        <DialogDescription>Stay on this event while signing in to your member account.</DialogDescription>
        <LoginForm completionMode="in-place" onAuthenticated={complete} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
  return { openLogin, loginModal };
}