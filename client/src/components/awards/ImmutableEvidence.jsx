import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { validateEvidenceReview } from '@/lib/awardEvidenceReader';
import JudgingReview from './JudgingReview';

export default function ImmutableEvidence({ scopeKey, enabled = true, assertCurrent, loadReview, loadAttachment, title = 'Immutable submitted evidence' }) {
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(null);
  const callbacks = useRef();
  callbacks.current = { assertCurrent, loadReview, loadAttachment };
  const live = useRef();
  live.current = { scopeKey, enabled };
  useLayoutEffect(() => {
    setState(null);
    if (!enabled || !opened) return;
    const controller = new AbortController();
    let active = true;
    const check = () => {
      if (!active || controller.signal.aborted || live.current.scopeKey !== scopeKey || !live.current.enabled) throw new DOMException('Evidence scope changed.', 'AbortError');
      callbacks.current.assertCurrent();
    };
    (async () => {
      try {
        check();
        const data = validateEvidenceReview(await callbacks.current.loadReview(controller.signal));
        check(); setState({ scopeKey, attempt, data });
      } catch (error) {
        if (active && !controller.signal.aborted) setState({ scopeKey, attempt, error });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [scopeKey, enabled, opened, attempt]);
  const current = enabled && state?.scopeKey === scopeKey && state.attempt === attempt ? state : null;
  const authority = {
    ready: !!current?.data, scopeKey: JSON.stringify([scopeKey, attempt, current?.data?.applicationVersionId]),
    assertCurrent() {
      if (!enabled || !live.current.enabled || live.current.scopeKey !== scopeKey) throw new Error('Evidence access changed. Reopen current evidence.');
      callbacks.current.assertCurrent();
    },
  };
  return <section className="rounded-lg border p-4 space-y-4" aria-label={title}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold text-sm">{title}</h3>
      <Button type="button" size="sm" variant="outline" disabled={!enabled || (opened && !current)} onClick={() => { setOpened(true); setAttempt(value => value + 1); }}>{!opened ? 'View saved evidence and files' : current?.error ? 'Retry evidence' : 'Refresh saved evidence'}</Button>
    </div>
    <p className="awards-help">Read-only saved evidence, separate from all unsaved answers and assessment drafts. Viewing does not adopt a version for judges.</p>
    {!enabled ? <p role="alert" className="awards-help">Current access must be verified before evidence can be shown.</p>
      : opened && !current ? <div role="status" aria-label="Loading immutable evidence"><Skeleton className="h-24 w-full" /></div>
        : current?.error ? <p role="alert" className="text-sm text-destructive">{current.error.message} Previously loaded evidence has been cleared. Local drafts are unchanged.</p>
          : current?.data && <><p className="awards-help break-all">Evidence version: {current.data.applicationVersionId}</p><JudgingReview review={current.data.review} authority={authority}
            onAccessLost={error => {
              if (live.current.scopeKey === scopeKey && live.current.enabled) setState({ scopeKey, attempt, error });
            }}
            requestAttachment={async (attachmentId, options) => {
              authority.assertCurrent();
              return callbacks.current.loadAttachment(attachmentId, options);
            }} /></>}
  </section>;
}
