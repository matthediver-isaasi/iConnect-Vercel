import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { useMemberChangeSession } from '@/hooks/useMemberChangeSession';
import { useExternalAwardApplicant } from '@/hooks/useExternalAwardApplicant';
import { usePageLayoutDecision } from '@/contexts/LayoutContext';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { applicantUuid, applicantRequest, applicantApplicationsKey } from '@/components/awards/useAwardApplications';
import { externalApplicantRequest } from '@/components/awards/externalApplicantRequest';
import ApplicantEvidence from '@/components/awards/ApplicantEvidence';
import { amendmentFileCells, amendmentValidationErrors, assertAmendmentScope, authorisedAmendmentUpload, cloneEvidence, directoryEvidenceTypes, editableEvidenceField, rebaseAmendmentEvidence, sameEvidence, uploadAmendmentFile } from '@/components/awards/amendmentEvidence';
import { getSavedFormFieldValue } from '@/lib/formRelationshipDropdown';
import { recordSelectionOptionScope } from '@/lib/formConditionalCopyMode';
import { containsFormNotListedValue, FORM_NOT_LISTED_LABELS_KEY, resolveRawFormNotListedText } from '../../../../shared/formNotListedChoice.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../../../shared/formRepeatableRows.js';
import FormRenderer from './FormRenderer';
import { FormAmendmentUploadContext } from './FormAmendmentUploadContext';
import '@/components/awards/awards.css';

function RetainedEvidence({ value, depth = 0 }) {
  if (value == null || value === '') return <span>No saved answer.</span>;
  if (depth > 5) return <span>Additional nested evidence is retained unchanged.</span>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { return <RetainedEvidence value={JSON.parse(value)} depth={depth + 1} />; } catch { /* Plain text remains plain text. */ }
  }
  if (typeof value !== 'object') return <span className="whitespace-pre-wrap break-words">{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</span>;
  if (Array.isArray(value)) return <ul className="list-inside list-disc space-y-1">{value.map((item, index) => <li key={index}><RetainedEvidence value={item} depth={depth + 1} /></li>)}</ul>;
  if (typeof value.file_name === 'string') return <span>{value.file_name} — saved file evidence retained; no new upload required unless replaced.</span>;
  const entries = Object.entries(value).filter(([key]) => !/token|secret|password|url|path|session|client|card|iban/i.test(key));
  return entries.length ? <dl className="space-y-2">{entries.map(([key, item]) => <div key={key}><dt className="font-medium break-words">{key.replaceAll('_', ' ')}</dt><dd><RetainedEvidence value={item} depth={depth + 1} /></dd></div>)}</dl> : <span>Existing private evidence is retained unchanged. Technical payment/access data is not displayed.</span>;
}

function SavedFieldEvidence({ field, value, answers, displaySnapshot = {}, originalValue, recordedLabel }) {
  const label = recordedLabel ?? (Object.hasOwn(displaySnapshot, field.id) ? displaySnapshot[field.id] : undefined);
  const ids = Array.isArray(value) ? value : [value];
  if (directoryEvidenceTypes.has(field.type) && ids.length && ids.every(id => applicantUuid.test(id || ''))
    && typeof label === 'string' && sameEvidence(value, originalValue)) {
    return <div className="space-y-2"><p className="whitespace-pre-wrap break-words">{label}</p>
      <p className="awards-help">Immutable recorded display label; no directory lookup.</p>
      <details><summary className="cursor-pointer text-xs">Saved reference IDs (unchanged)</summary><RetainedEvidence value={value} /></details></div>;
  }
  if (isRepeatableRowField(field) && Array.isArray(value)) {
    const children = repeatableRowChildren(field);
    return <ol className="space-y-4">{value.map((row, index) => {
      const originalRow = Array.isArray(originalValue) && typeof row?._row_id === 'string'
        ? originalValue.find(item => item?._row_id === row._row_id) : undefined;
      return <li key={row?._row_id || index} className="rounded-lg border p-3 space-y-2"><p className="font-medium">Saved row {index + 1}</p>
        {children.map(child => {
          const key = JSON.stringify([row?._row_id, child.id]);
          return <div key={child.id}><p className="text-sm font-medium">{child.label || child.id}</p><SavedFieldEvidence field={child} value={row?.[child.id]}
            originalValue={originalRow?.[child.id]} answers={row}
            recordedLabel={originalRow && sameEvidence(row?.[child.id], originalRow?.[child.id]) && label && typeof label === 'object' && Object.hasOwn(label, key) ? label[key] : undefined} /></div>;
        })}
      </li>;
    })}</ol>;
  }
  if (directoryEvidenceTypes.has(field.type) && containsFormNotListedValue(value)) {
    const recorded = answers?.[FORM_NOT_LISTED_LABELS_KEY]?.[field.id];
    const text = resolveRawFormNotListedText(field, answers || {});
    return <div className="space-y-1"><p className="whitespace-pre-wrap break-words">{typeof recorded === 'string' && recorded ? recorded : 'Saved Other selection'}</p>
      {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
      <p className="awards-help">Retained saved evidence only. No linked record is created or edited.</p></div>;
  }
  if (['payment', 'membership_payment', 'sales_bundle', 'sales_cart', 'sales_cart_view', 'password'].includes(field.type)
    || /password|client[_ ]?secret|access[_ ]?token|session[_ ]?token/i.test(`${field.name || ''} ${field.label || ''}`)) {
    return <span>Existing financial/access answers are retained unchanged. Sensitive technical details are not displayed and no action runs.</span>;
  }
  if (field.type === 'signature') return <span>{value ? 'Signature evidence retained in the immutable answers. The editable local control, when supported, uses no signing provider or separate upload action.' : 'No signature recorded.'}</span>;
  return <RetainedEvidence value={value} />;
}

// This branch deliberately never mounts standard FormView's payment-return,
// checkout, entity-prefill, draft/resume, copy-email or submission pipelines.
// All editable questions use the very same FormRenderer as standard FormView.
export default function AwardAmendmentFormView(props) {
  // Separate mounted branches: external access never even invokes the normal
  // member-session hook, and neither branch mounts StandardFormView.
  return props.externalApplicant ? <ExternalAmendment {...props} /> : <MemberAmendment {...props} />;
}

function statusHref(session, tenantSlug, applicationId) {
  const params = new URLSearchParams({ applicationId });
  if (session.externalApplicant && tenantSlug) params.set('tenant', tenantSlug);
  return `${session.externalApplicant ? '/award-application' : '/award-applications'}?${params}`;
}

function ExternalAmendment({ applicationId, slug, incompatibleRoute = false }) {
  usePageLayoutDecision({ forcePublicLayout: true, publicChrome: 'both' });
  const authority = useExternalAwardApplicant(applicationId);
  return <main className="awards-workspace min-h-[100dvh] max-w-3xl mx-auto px-4 py-8 space-y-6">
    <header className="awards-intro p-6 space-y-2"><p className="awards-kicker">Secure applicant evidence amendment</p><h1 className="text-2xl font-semibold">Correct your application evidence</h1><p className="text-sm leading-6">This private application grant is not a member session. No payment, account creation or original form entity actions run. Judges retain their assigned evidence until an administrator explicitly adopts the revised version.</p></header>
    {!applicantUuid.test(applicationId || '') || incompatibleRoute
      ? <p role="alert" className="rounded-lg border p-5">This external amendment route is invalid or conflicts with another authority. Reopen the original application link; no ordinary form flow was opened.</p>
      : authority.status !== 'ready' ? <p role="alert" className="rounded-lg border p-5 text-sm">{authority.error}</p>
        : <LoadAmendment key={JSON.stringify([authority.scopeKey, applicationId, slug])} session={authority} tenantSlug={authority.tenantSlug} applicationId={applicationId} slug={slug} request={externalApplicantRequest} />}
  </main>;
}

function MemberAmendment({ applicationId, slug, incompatibleRoute = false }) {
  const session = useMemberChangeSession();
  const location = useLocation();
  let tenantSlug = null, scopeError = '';
  try { tenantSlug = getTenantSlugFromLocation(); } catch { scopeError = 'Your organisation context could not be read. Restore browser access and reload.'; }
  const valid = applicantUuid.test(applicationId || '') && !incompatibleRoute;
  return <main className="awards-workspace min-h-[100dvh] max-w-3xl mx-auto px-4 py-8 space-y-6">
    <header className="awards-intro p-6 space-y-2"><p className="awards-kicker">Member-private evidence amendment</p><h1 className="text-2xl font-semibold">Correct your application evidence</h1><p className="text-sm leading-6">This does not pay again, create or update member records, or run the original form’s entity actions. Judges continue using their assigned evidence until an administrator explicitly adopts a new version.</p></header>
    {!valid ? <p role="alert" className="rounded-lg border p-5">This amendment link is invalid or conflicts with another form authority. No submission or payment controls have been opened.</p>
      : session.status === 'loading' ? <Skeleton className="h-48 w-full" />
        : session.status !== 'ready' ? <Card><CardContent className="p-6 space-y-4"><h2 className="font-semibold">Member sign-in required</h2><p className="text-sm">Amendments are available only to the member who owns this application. External continuation is not available here.</p><a className="text-sm underline" href={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}>Sign in with your member account</a><Button variant="outline" onClick={() => window.location.reload()}>Reload access</Button></CardContent></Card>
          : scopeError ? <p role="alert">{scopeError}</p>
            : <LoadAmendment key={JSON.stringify([session.scopeKey, tenantSlug, applicationId, slug])} session={session} tenantSlug={tenantSlug} applicationId={applicationId} slug={slug} />}
  </main>;
}

function LoadAmendment({ session, tenantSlug, applicationId, slug, request = applicantRequest }) {
  const query = useQuery({
    queryKey: [session.externalApplicant ? 'external-award-amendment-editor' : 'member-award-amendment-editor', session.scopeKey, tenantSlug, applicationId, slug],
    queryFn: async ({ signal }) => {
      const authority = await request(session, tenantSlug, { applicationId, edit: true, signal });
      if (slug && authority.formSlug !== slug) throw new Error('The form in this link is not the application’s authorised form.');
      assertAmendmentScope(session, tenantSlug);
      const form = authority.form;
      assertAmendmentScope(session, tenantSlug);
      if (form?.id !== authority.formId || form.tenant_id !== authority.tenantId || form.slug !== authority.formSlug || !Array.isArray(form.fields)
        || form.fields.some(field => !field || typeof field.id !== 'string' || typeof field.type !== 'string')
        || new Set(form.fields.map(field => field.id)).size !== form.fields.length) throw new Error('The owner-authorised form projection does not match the amendment form/tenant. No public form, member-cookie or ordinary submission fallback is used.');
      return { authority, form };
    },
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (query.isPending) return <div role="status" aria-label="Loading authorised application evidence" className="space-y-4"><Skeleton className="h-12 w-2/3" /><Skeleton className="h-48 w-full" /></div>;
  if (query.isError) return <Card><CardContent className="p-6 space-y-4"><p role="alert" className="text-sm">{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry loading {session.externalApplicant ? 'secure applicant' : 'member'} amendment authority</Button><Link className="block text-sm underline" to={session.externalApplicant ? statusHref(session, tenantSlug, applicationId) : '/award-applications'}>Return to {session.externalApplicant ? 'application status' : 'my applications'}</Link></CardContent></Card>;
  return <AmendmentEditor session={session} tenantSlug={tenantSlug} initialAuthority={query.data.authority} form={query.data.form} request={request} />;
}

function AmendmentEditor({ session, tenantSlug, initialAuthority, form, request }) {
  const queryClient = useQueryClient();
  const [authority, setAuthority] = useState(initialAuthority);
  const [values, setValues] = useState(() => cloneEvidence(initialAuthority.answers));
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [frozen, setFrozen] = useState(null);
  const [review, setReview] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [controlsPending, setControlsPending] = useState(false);
  const [validity, setValidity] = useState({});
  const [choicesDenied, setChoicesDenied] = useState(false);
  const choicesDeniedRef = useRef(false);
  const choiceStates = useRef({});
  const choiceOptions = useRef({});
  const [reattach, setReattach] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState(null);
  const pending = useRef(false), uploadCount = useRef(0), alive = useRef(false), controllers = useRef(new Set());
  const localControls = useRef(new Set());
  useEffect(() => { alive.current = true; return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);
  const changed = !sameEvidence(values, authority.answers);
  const dirty = !success && (changed || !!reason || !!frozen || !!reattach.length || busy || uploads > 0 || controlsPending);
  const guard = usePopupUnsavedChanges({ dirty, isDirty: () => pending.current || uploadCount.current > 0 || localControls.current.size > 0 || dirty });
  const deadlineOpen = Date.parse(authority.deadline) > Date.now();
  const choiceAccess = { existingChoiceAccess: authority.existingChoiceAccess === true && !choicesDenied && form.form_type !== 'survey' };
  const editable = field => editableEvidenceField(field, getSavedFormFieldValue(authority.answers, field), form.fields, choiceAccess);
  const blockedCount = form.fields.filter(field => !editable(field) && field.type !== 'instructions').length;
  const validationErrors = amendmentValidationErrors(form.fields, values, authority.answers, choiceAccess);
  const valid = changed && !!reason.trim() && reason.length <= 2000 && JSON.stringify(values).length <= 500000 && !reattach.length && deadlineOpen
    && !controlsPending && !validationErrors.length && !Object.values(validity).includes(false);
  const checkScope = () => {
    try { assertAmendmentScope(session, tenantSlug); return true; }
    catch (failure) { if (alive.current) setError(failure.message); return false; }
  };
  const uploadContext = {
    locked: busy || !!frozen || !!success,
    choiceScopeKey: JSON.stringify([session.scopeKey, authority.tenantId, authority.formId, authority.version, requestId]),
    choiceTenantSlug: tenantSlug,
    canQueryChoices: field => !choicesDeniedRef.current && choiceAccess.existingChoiceAccess
      && editableEvidenceField(field, getSavedFormFieldValue(authority.answers, field), form.fields, choiceAccess),
    assertChoiceAccess: field => {
      assertAmendmentScope(session, tenantSlug);
      if (choicesDeniedRef.current || !choiceAccess.existingChoiceAccess || !editable(field)) throw new Error('Ordinary form choice access is not available.');
    },
    onChoiceState: (id, status) => {
      choiceStates.current[id] = status;
      if (status !== 'unavailable' || choicesDeniedRef.current || !alive.current) return;
      choicesDeniedRef.current = true; setChoicesDenied(true);
      // A denied directory lookup is not authority to retain a locally edited
      // linked selection. Preserve every unrelated draft and the reason.
      setValues(old => {
        const next = { ...old };
        for (const field of form.fields.filter(field => directoryEvidenceTypes.has(field.type))) {
          const saved = getSavedFormFieldValue(authority.answers, field);
          if (saved === undefined) delete next[field.id]; else next[field.id] = cloneEvidence(saved);
        }
        return next;
      });
      setValidity(old => Object.fromEntries(Object.entries(old).filter(([id]) => !form.fields.some(field => field.id === id && directoryEvidenceTypes.has(field.type)))));
      setNotice('Ordinary form choice access could not be verified. Linked answers were restored to their saved values and are read-only. Other evidence edits and your reason were kept. No application token fallback or automatic choice retry was used.');
    },
    setControlPending: (id, waiting) => {
      if (waiting) localControls.current.add(id); else localControls.current.delete(id);
      if (alive.current) setControlsPending(localControls.current.size > 0);
    },
    uploadFile: async ({ file, fieldId, formId }) => {
      if (pending.current || frozen || success || formId !== authority.formId
        || !authorisedAmendmentUpload(form.fields, values, authority.answers, fieldId)) throw new Error('This amendment is locked or the exact top-level/row file control is not authorised.');
      const controller = new AbortController();
      controllers.current.add(controller); uploadCount.current += 1; setUploads(uploadCount.current);
      try {
        return await uploadAmendmentFile({ session, tenantSlug, tenantId: authority.tenantId, formId, requestId, file, signal: controller.signal });
      } finally {
        controllers.current.delete(controller); uploadCount.current -= 1;
        if (alive.current) setUploads(uploadCount.current);
      }
    },
  };
  const startRevisedIntent = async () => {
    if (pending.current || uploadCount.current || localControls.current.size || !frozen) return;
    if (!window.confirm('Start a different amendment intent? This reloads current application authority/version while retaining your editable answers and reason. The previous request may already have committed. Any non-retained replacement files must be uploaded again under a NEW amendment request; you may instead explicitly keep the currently saved file. No retry is sent automatically.')) return;
    pending.current = true; setBusy(true); setError('');
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const current = await request(session, tenantSlug, { applicationId: authority.applicationId, edit: true, signal: controller.signal });
      if (current.tenantId !== authority.tenantId || current.formId !== form.id || current.formSlug !== authority.formSlug) throw new Error('The authorised tenant or bound form changed. Your answers remain here; reload your application before continuing.');
      if (!sameEvidence(current.form, form)) throw new Error('The owner-authorised form definition changed. Your current answers and reason remain here. Return to application status and explicitly reload the editor to reconcile the changed definition; it will not silently replace this worksheet.');
      assertAmendmentScope(session, tenantSlug);
      if (!alive.current) return;
      if (form.fields.some(field => directoryEvidenceTypes.has(field.type) && !sameEvidence(getSavedFormFieldValue(authority.answers, field), getSavedFormFieldValue(values, field)))
        && (current.existingChoiceAccess !== true || choicesDeniedRef.current)) throw new Error('Ordinary form permission for edited linked choices is no longer verified. Your frozen request and other edits were retained; no linked edit was silently rebased.');
      const rebased = rebaseAmendmentEvidence(form.fields, authority.answers, values, current.answers, choiceAccess);
      setAuthority(current); setValues(rebased.answers); setReattach(rebased.reattach);
      setRequestId(crypto.randomUUID()); setFrozen(null); setAttempted(false); setReview(false); setAcknowledged(false); setValidity({});
      setNotice('Current application authority/version reloaded. Locally edited safe answers and reason were retained; untouched and read-only fields now follow the current saved version. Concurrent changes to an edited field would have stopped this reconciliation without overwriting any edited children. Compare retained edits with current saved answers before confirming. Every listed replacement file cell requires re-upload under this new request or an explicit choice to keep its currently saved file/empty cell.');
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { controllers.current.delete(controller); pending.current = false; if (alive.current) setBusy(false); }
  };
  const submit = async event => {
    event.preventDefault();
    if (pending.current || uploadCount.current || localControls.current.size || !frozen || !acknowledged || success) return;
    if (!attempted && choicesDeniedRef.current && form.fields.some(field => directoryEvidenceTypes.has(field.type)
      && !sameEvidence(getSavedFormFieldValue(frozen.answers, field), getSavedFormFieldValue(authority.answers, field)))) {
      setError('Ordinary choice access was lost. No new linked change can be submitted. The frozen request is retained for reconciliation; return to application status to reload current authority.'); return;
    }
    if (!attempted && Date.parse(authority.deadline) <= Date.now()) { setError('The amendment deadline has passed. No new amendment was submitted; your evidence and reason remain here.'); return; }
    pending.current = true; setBusy(true); setAttempted(true); setError('');
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const result = await request(session, tenantSlug, { payload: frozen, signal: controller.signal });
      assertAmendmentScope(session, tenantSlug);
      if (!alive.current) return;
      setSuccess(result); setReview(false);
      queryClient.invalidateQueries({ queryKey: session.externalApplicant ? ['external-award-applicant-status', session.scopeKey, authority.applicationId] : applicantApplicationsKey(session, tenantSlug), refetchType: 'none' });
    } catch (failure) { if (alive.current) setError(`${failure.message} Your answers, reason and exact request were retained. Retry only the unchanged frozen request, or explicitly reload authority and start a different intent.`); }
    finally { controllers.current.delete(controller); pending.current = false; if (alive.current) setBusy(false); }
  };
  if (success) return <Card><CardHeader><CardTitle>Evidence amendment confirmed</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm">{authority.reference}: the server confirmed a new evidence version. Judges’ assigned evidence is unchanged until an administrator explicitly adopts it.</p><p className="awards-help">No payment, member creation/update, original entity actions, submission-copy email or automatic judging adoption was initiated.</p><p className="awards-help break-all">Evidence version: {success.applicationVersionId}</p><ApplicantEvidence session={session} tenantSlug={tenantSlug} applicationId={authority.applicationId} version={success.applicationVersionId} /><Link className="text-sm underline" to={statusHref(session, tenantSlug, authority.applicationId)}>Return to this application’s status</Link></CardContent></Card>;
  return <FormAmendmentUploadContext.Provider value={uploadContext}><div className="space-y-6">
    <ApplicantEvidence session={session} tenantSlug={tenantSlug} applicationId={authority.applicationId} version={authority.version} enabled={!busy && uploads === 0} />
    <Card><CardHeader><CardTitle className="text-lg">{form.title || form.name || 'Application evidence'} · {authority.reference}</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="awards-help">{session.externalApplicant ? 'Application' : 'Member application'} version {authority.version}. Amendment deadline: {new Date(authority.deadline).toISOString()} (UTC).</p>
      <p className="text-sm">Saved evidence was loaded once. There is no member/profile prefill or original submission automation in this mode. Unchanged retained file answers are kept intact; replacement files are uploaded privately against this amendment’s own submission ID.</p>
      <p className="awards-help">Local drawn/typed signatures, address lookup/manual address controls, grouped text questions and supported static repeatable rows use the original form controls. Grouped/repeatable containers are editable only when every child is safe. Original submissions remain immutable and judge adoption remains a separate administrator action.</p>
      <p className="awards-help">Existing directory choices {choiceAccess.existingChoiceAccess ? 'require your current ordinary form access; an application link does not authorise directory access.' : 'are read-only without separately verified ordinary form access.'} Other/new-record creation is unavailable. Surveys, private managed composites and directory controls inside composite rows are not supported here.</p>
      {blockedCount > 0 && <p role="note" className="rounded-lg border p-3 text-sm">{blockedCount} managed, financial or unsupported widget{blockedCount === 1 ? ' is' : 's are'} read-only below. Financial/payment and entity-create widgets never mount here. A container with unsupported children, dynamic option sources or incompatible saved shapes stays wholly read-only; its saved answers remain intact.</p>}
    </CardContent></Card>
    {notice && <p role="status" className="rounded-lg border p-4 text-sm">{notice}</p>}
    <fieldset disabled={busy || !!frozen || uploads > 0} className="space-y-5">
      {form.fields.map(field => {
        const value = getSavedFormFieldValue(values, field), saved = getSavedFormFieldValue(authority.answers, field);
        return <Card key={field.id}><CardContent className="p-5 space-y-3">
          {directoryEvidenceTypes.has(field.type) && <div className="rounded-lg border p-3 text-sm"><p className="awards-help mb-2">Originally saved linked answer (any recorded labels are retained; no directory lookup is used for this display)</p><SavedFieldEvidence field={field} value={saved} originalValue={saved} answers={authority.answers} displaySnapshot={authority.displaySnapshot} /></div>}
          {editable(field) || field.type === 'instructions' ? <FormRenderer field={directoryEvidenceTypes.has(field.type) ? { ...field, not_listed_choice: { ...field.not_listed_choice, enabled: false } } : field} value={value} formId={form.id} formSlug={authority.formSlug}
            allFields={form.fields} allFormValues={values} preserveValueWhenUnavailable
            onRecordSelectionOptionsChange={directoryEvidenceTypes.has(field.type) ? (id, state) => { choiceOptions.current[id] = state; } : undefined}
            onValidityChange={(id, valid) => setValidity(old => old[id] === valid ? old : { ...old, [id]: valid })}
            disabled={!editable(field) || busy || !!frozen || uploads > 0} onChange={value => {
              if (!editable(field) || pending.current || frozen || !alive.current) return;
              const cells = amendmentFileCells(field, value);
              if (!checkScope()) return;
              setValues(old => ({ ...old, [field.id]: value }));
              setReattach(old => old.flatMap(entry => {
                if (entry.rootId !== field.id) return [entry];
                const cell = cells.find(candidate => candidate.key === entry.key);
                // Canonical row controls project an empty null/undefined file
                // cell as ''. Editing a sibling must not count that harmless
                // empty representation change as a replacement/retention choice.
                const empty = value => value == null || value === '';
                return cell && (sameEvidence(cell.value, entry.restored) || (empty(cell.value) && empty(entry.restored)))
                  ? [{ ...entry, index: cell.index, path: cell.path, label: cell.label }] : [];
              }));
            }} /> : <div className="space-y-2"><h2 className="font-medium text-sm">{field.label || field.name || 'Saved form field'}</h2><p className="awards-help">Read-only in evidence-only amendments ({field.type}). No widget action will run.</p><div className="text-sm rounded-lg border p-3"><SavedFieldEvidence field={field} value={value} answers={values} displaySnapshot={authority.displaySnapshot} originalValue={saved} /></div></div>}
          {!sameEvidence(value, saved) && <details className="text-sm"><summary className="cursor-pointer awards-help">Compare with the current saved answer</summary><div className="mt-2 p-3 border rounded-lg"><SavedFieldEvidence field={field} value={saved} originalValue={saved} answers={authority.answers} displaySnapshot={authority.displaySnapshot} /></div></details>}
          {reattach.filter(entry => entry.rootId === field.id).map(entry => <div key={entry.key} role="alert" className="text-sm text-amber-900 space-y-2"><p>{entry.label}: your prior replacement is not attached to this new request. Upload this file again, or explicitly keep the currently saved file (or saved empty cell) restored in this control. Edits to other row cells do not resolve this choice.</p><Button type="button" variant="outline" onClick={() => setReattach(old => old.filter(candidate => candidate.key !== entry.key))}>Keep this currently saved file/empty cell instead</Button></div>)}
        </CardContent></Card>;
      })}
      <Card><CardContent className="p-5 space-y-3"><label htmlFor="award-amendment-reason" className="block font-medium text-sm">Reason for correcting evidence (required)</label><Textarea id="award-amendment-reason" required maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /><p className="awards-help">This reason accompanies the evidence history. It does not request or perform judging adoption.</p></CardContent></Card>
    </fieldset>
    {uploads > 0 && <div role="status" className="space-y-2"><Skeleton className="h-3 w-full" /><p className="awards-help">Uploading private evidence. Wait before reviewing or leaving this application.</p></div>}
    {controlsPending && <p role="status" className="awards-help">Finish drawing or preparing the local signature before freezing or leaving this worksheet.</p>}
    {validationErrors.length > 0 && <div role="alert" className="rounded-lg border p-4 text-sm"><p className="font-medium">Complete the editable evidence controls before review.</p><ul className="list-disc pl-5 mt-2">{validationErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
    {error && <p role="alert" className="text-sm text-red-800 whitespace-pre-wrap">{error}</p>}
    {JSON.stringify(values).length > 500000 && <p role="alert" className="text-sm text-red-800">The retained answers exceed the amendment API’s evidence size limit. No submission is available and no saved answer has been removed to work around it. Contact the association for help.</p>}
    {!deadlineOpen && <p role="alert" className="text-sm text-amber-900">The loaded amendment deadline has passed. New intents cannot be submitted. An identical attempted request may only be retried explicitly to resolve its server outcome.</p>}
    <div className="flex flex-wrap gap-3">
      {!frozen ? <Button type="button" disabled={busy || uploads > 0 || !valid} onClick={() => {
        if (Date.parse(authority.deadline) <= Date.now()) { setError('The amendment deadline has passed. Your evidence and reason remain here; no new request was created.'); return; }
        if (pending.current || uploadCount.current || localControls.current.size || !valid) return;
        if (form.fields.some(field => directoryEvidenceTypes.has(field.type)
          && !sameEvidence(getSavedFormFieldValue(values, field), getSavedFormFieldValue(authority.answers, field))
          && (!choiceAccess.existingChoiceAccess || choicesDeniedRef.current || choiceStates.current[field.id] !== 'resolved'))) {
          setError('Current ordinary form choices must finish loading successfully before linked evidence can be frozen. Saved answers and unrelated edits are retained.'); return;
        }
        const invalidChoice = form.fields.find(field => {
          if (!directoryEvidenceTypes.has(field.type) || !editable(field)) return false;
          const current = getSavedFormFieldValue(values, field);
          const parentId = field.parent_field_id || field.organisation_group_parent_field_id;
          const parent = form.fields.find(candidate => candidate.id === parentId);
          const changedScope = parent && !sameEvidence(getSavedFormFieldValue(values, parent), getSavedFormFieldValue(authority.answers, parent));
          if (!changedScope && sameEvidence(current, getSavedFormFieldValue(authority.answers, field))) return false;
          if (current == null || current === '' || (Array.isArray(current) && !current.length)) return false;
          const available = choiceOptions.current[field.id];
          return available?.status !== 'resolved' || available.scope !== recordSelectionOptionScope(field, form.fields, values)
            || (Array.isArray(current) ? current : [current]).some(id => !available.options.some(option => String(option.id) === String(id)));
        });
        if (invalidChoice) {
          setError(`${invalidChoice.label || invalidChoice.id}: this linked answer does not match current canonical choices for its selected parent/scope. Select a currently available record; saved evidence and other edits are retained.`); return;
        }
        if (!checkScope()) return;
        setFrozen(cloneEvidence({ command: 'amend', applicationId: authority.applicationId, version: authority.version, reason: reason.trim(), requestId, answers: values }));
        setReview(true); setAcknowledged(false); setError('');
      }}>Review evidence-only amendment…</Button> : <>
        <Button type="button" disabled={busy || uploads > 0} onClick={() => { setReview(true); setAcknowledged(false); }}>{attempted ? 'Review exact frozen retry…' : 'Review frozen amendment…'}</Button>
        <Button type="button" variant="outline" disabled={busy || uploads > 0} onClick={startRevisedIntent}>Edit as a new request (reload authority)…</Button>
      </>}
      <Link className="text-sm underline self-center" to={statusHref(session, tenantSlug, authority.applicationId)}>Back to application status</Link>
    </div>
    <Dialog open={review} onOpenChange={open => { if (!busy) setReview(open); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{attempted ? 'Explicitly retry the identical amendment?' : 'Confirm evidence-only correction'}</DialogTitle><DialogDescription>No new payment or member/entity pipeline will run. Judges retain their currently assigned evidence until separate administrator adoption.</DialogDescription></DialogHeader>
      {frozen && <form className="space-y-4" onSubmit={submit}><p className="text-sm">{authority.reference} · expected application version {frozen.version}.</p><p className="text-sm whitespace-pre-wrap break-words">Reason: {frozen.reason}</p><details className="text-sm"><summary className="cursor-pointer">Review the frozen evidence answers</summary><dl className="mt-3 space-y-4">{form.fields.map(field => <div key={field.id}><dt className="font-medium">{field.label || field.name || 'Form field'}</dt><dd><SavedFieldEvidence field={field} value={getSavedFormFieldValue(frozen.answers, field)} answers={frozen.answers} displaySnapshot={authority.displaySnapshot} originalValue={getSavedFormFieldValue(authority.answers, field)} /></dd></div>)}</dl></details>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" required checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>I confirm this changes review evidence only. There is no further payment, member record creation/update, original entity action or automatic judge adoption. Administrators must separately adopt revised evidence before judges reassess it.</span></label>
        {attempted && <p className="awards-help">The same request ID, application version, answers and reason will be reused byte-for-byte. A missing response is not proof that the earlier amendment failed. There is no automatic retry.</p>}
        {error && <p role="alert" className="text-sm text-red-800 whitespace-pre-wrap">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setReview(false)}>Keep draft and go back</Button><Button type="submit" disabled={busy || uploads > 0 || !acknowledged || (!attempted && !deadlineOpen)}>{busy ? 'Awaiting server confirmation…' : attempted ? 'Retry identical evidence amendment' : 'Confirm evidence-only amendment'}</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog>
    <Dialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}><DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Leave unsaved amendment evidence?</DialogTitle><DialogDescription>{busy || uploads > 0 || controlsPending ? 'Wait for the current request, private upload or local signature preparation before leaving.' : 'Your local answers, correction reason and any exact retry context will be lost. Leaving does not submit or undo an amendment.'}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" variant="destructive" disabled={busy || uploads > 0 || controlsPending} onClick={guard.discard}>Discard local draft and leave</Button></DialogFooter></DialogContent></Dialog>
  </div></FormAmendmentUploadContext.Provider>;
}
