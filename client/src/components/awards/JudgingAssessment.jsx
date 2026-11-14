import React, { useEffect, useRef, useState } from 'react';
import { Check, LockKeyhole, Save } from 'lucide-react';
import { calculateAssessment, formatScore, validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { judgingRequest, deadlineText } from './judgingClient';

function shownScore(score) {
  if (!score) return null;
  try { return formatScore(score); } catch { return null; }
}

export default function JudgingAssessment({ data, summary, onDirtyChange, onBusyChange, onSaved }) {
  const [answers, setAnswers] = useState(() => data.assessment?.answers || {});
  const [savedAnswers, setSavedAnswers] = useState(() => JSON.stringify(data.assessment?.answers || {}));
  const [assessment, setAssessment] = useState(data.assessment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [clock, setClock] = useState(Date.now);
  const retryRequest = useRef(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange, onSaved });
  callbacks.current = { onDirtyChange, onBusyChange, onSaved };
  const dirty = JSON.stringify(answers) !== savedAnswers;
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => { mounted.current = false; clearInterval(timer); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const definition = data.criteria?.definition;
  let definitionError = '';
  try { validateCriteria(definition); } catch (failure) { definitionError = failure.message; }
  const submitted = assessment?.state === 'submitted';
  const expired = summary.deadline && Number.isFinite(Date.parse(summary.deadline)) && Date.parse(summary.deadline) <= clock;
  const apiRestriction = error?.status === 401 ? 'Your judging session needs to be verified again. Responses are retained here, but saving is disabled.'
    : error?.status === 403 || error?.status === 404 ? 'The server reports that this assessment is unavailable. Responses are retained in read-only mode.'
      : error?.status === 409 ? 'The server revision changed. This editor is read-only until you reload the assignment.' : '';
  const restriction = !['none','cleared'].includes(data.assignment.conflict) ? 'This assignment has a conflict and is read-only.'
    : summary.roundState !== 'judging' ? 'This round is not open for judging. The assessment is read-only.'
      : expired ? 'The round deadline has passed. The assessment is read-only.'
        : assessment && !['draft', 'submitted','reopened'].includes(assessment.state) ? 'This assessment is not editable in its current state.' : apiRestriction;
  const locked = submitted || Boolean(restriction) || Boolean(definitionError);
  const change = (id, patch) => {
    if (locked || busy) return;
    setAnswers(old => ({ ...old, [id]: { ...old[id], ...patch } }));
    retryRequest.current = null; setNotice(''); setFieldErrors([]); setError(null);
  };
  const validate = submit => {
    try {
      const result = calculateAssessment(definition, answers, { final: submit });
      setFieldErrors(submit ? result.errors : []); return true;
    } catch (failure) {
      setError(failure); setFieldErrors(failure.details || []); return false;
    }
  };
  const save = async submit => {
    if (pending.current || locked || !validate(submit)) return;
    const base = {
      assignmentId: data.assignment.id, expectedRevision: assessment?.revision || 0, submit,
      criteriaVersionId: data.assignment.criteriaVersionId, applicationVersionId: data.assignment.applicationVersionId,
      answers,
    };
    const signature = JSON.stringify(base);
    if (retryRequest.current?.signature !== signature) retryRequest.current = { signature, payload: { ...base, requestId: crypto.randomUUID() } };
    const request = retryRequest.current;
    pending.current = true; setBusy(true); setError(null); setNotice(''); setConfirmSubmit(false);
    try {
      const result = await judgingRequest('/api/judging/assessment', { body: request.payload });
      if (!Number.isInteger(result.revision) || !result.id || result.state !== (submit ? 'submitted' : 'draft')) {
        throw new Error('The server did not confirm the expected assessment revision. Retry the unchanged request before editing.');
      }
      if (!mounted.current) return;
      const next = { ...result, answers: request.payload.answers, exact_score: result.score ?? null };
      setAssessment(next); setSavedAnswers(JSON.stringify(request.payload.answers)); retryRequest.current = null;
      setNotice(submit ? 'Assessment submitted. This revision is now read-only.' : 'Draft saved to the server.');
      callbacks.current.onSaved(next);
    } catch (failure) {
      if (mounted.current) { setError(failure); setFieldErrors(failure.details || []); }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const score = shownScore(assessment?.exact_score);
  return <Card className="min-w-0 shadow-sm">
    <CardHeader className="border-b"><div className="flex justify-between gap-3"><div><p className="awards-kicker mb-2">Your assessment</p><CardTitle className="text-xl">{submitted ? 'Submitted assessment' : 'Assessment worksheet'}</CardTitle></div>
      <span className="awards-status" data-state={assessment?.state || 'draft'}>{assessment?.state || 'Not started'}</span></div>
      <p className="awards-help">Deadline: {deadlineText(summary.deadline)}</p><p className="awards-help">{assessment ? `Saved revision ${assessment.revision}` : 'No saved assessment yet'}{score !== null ? ` · Your saved score ${score} / 100` : ''}</p>
    </CardHeader>
    <CardContent className="pt-5">
      {(submitted || restriction) && <div className="flex items-start gap-2 p-4 rounded-lg bg-slate-50 text-sm mb-5"><LockKeyhole className="h-4 w-4 shrink-0 mt-0.5" /><p>{submitted ? 'This submitted revision is locked. Changes require an authorised reopening.' : restriction}</p></div>}
      {definitionError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 p-4 mb-5">The assigned criteria cannot be edited: {definitionError}. Contact the awards administrator.</p>}
      {!definitionError && <>
        <p className="awards-help mb-5">{definition.optionalPolicy === 'renormalise' ? 'Optional unanswered scores are excluded and answered weights are renormalised. No answered scored criteria means no final score.' : 'An unanswered optional scored criterion means this assessment has no final ranking score.'}</p>
        <form noValidate onSubmit={event => { event.preventDefault(); save(false); }}>
          <fieldset disabled={locked || busy} className="space-y-5">
            <legend className="sr-only">Assessment responses</legend>
            {definition.criteria.map((criterion, index) => <ResponseCriterion key={criterion.id} criterion={criterion} index={index}
              answer={answers[criterion.id] || {}} errors={fieldErrors.filter(item => item.criterionId === criterion.id)}
              onChange={patch => change(criterion.id, patch)} />)}
          </fieldset>
          {!locked && <div className="flex flex-wrap items-center justify-between gap-3 mt-6 border-t pt-5">
            <span className="awards-help">{busy ? 'Saving to server…' : dirty ? 'Unsaved responses' : assessment ? 'All responses saved' : 'Not saved yet'}</span>
            <div className="flex flex-wrap gap-2"><Button type="submit" variant="outline" disabled={busy || (!dirty && Boolean(assessment) && !error)}><Save className="h-4 w-4 mr-2" />Save draft</Button>
              <Button type="button" disabled={busy} onClick={() => { setError(null); if (validate(true)) setConfirmSubmit(true); }}><Check className="h-4 w-4 mr-2" />Submit assessment</Button></div>
          </div>}
        </form>
      </>}
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 mt-5">
        <p className="font-medium">{error.status === 401 ? 'Sign in or reopen your judging invitation to continue.' : error.message}</p>
        <p className="mt-2">Your responses remain in this editor. They are not confirmed saved. {apiRestriction ? 'Copy any needed responses before reloading the assignment or leaving to verify your session.' : 'An unchanged retry uses the same request identifier. Editing a response starts a new request.'}</p>
        {retryRequest.current && !locked && <Button type="button" size="sm" variant="outline" className="mt-3" disabled={busy} onClick={() => {
          if (retryRequest.current.payload.submit) setConfirmSubmit(true); else save(false);
        }}>{retryRequest.current.payload.submit ? 'Retry submission…' : 'Retry unchanged save'}</Button>}
      </div>}
      {notice && <p role="status" className="text-sm text-emerald-800 mt-4">{notice}</p>}
      {submitted && !score && assessment?.scoringComplete === false && <p className="awards-help mt-3">Submitted without a final ranking score under the configured optional-score policy.</p>}
      <Dialog open={confirmSubmit} onOpenChange={open => { if (!busy) setConfirmSubmit(open); }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Submit your assessment?</DialogTitle><DialogDescription>This saves a submitted revision and locks your responses. Check your scores and comments before confirming. Submission does not publish results.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmSubmit(false)}>Keep reviewing</Button><Button disabled={busy || locked} onClick={() => save(true)}>Confirm submission</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}

export function ResponseCriterion({ criterion, index, answer, errors, onChange }) {
  const id = `judge-${criterion.id}`;
  const valueError = errors.some(error => error.code === 'required');
  const commentError = errors.some(error => error.code === 'comment_required');
  const numeric = criterion.type === 'numeric';
  const choices = criterion.type === 'rating' ? criterion.options.map(option => ({ value: option.key, label: `${option.key} (${option.value})` }))
    : criterion.type === 'yes_no' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
      : criterion.type === 'pass_fail' ? [{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }] : null;
  return <fieldset className="rounded-lg border p-4 space-y-3 min-w-0">
    <legend className="px-1 text-sm font-semibold break-words">{index + 1}. {criterion.title}</legend>
    <p id={`${id}-help`} className="awards-help">{criterion.required ? 'Response required' : 'Optional response'}{numeric || criterion.type === 'rating' ? ` · ${criterion.weight}% weight · range ${criterion.min}–${criterion.max}` : criterion.type === 'text' ? ' · Not scored' : ` · ${criterion.effect} effect · Not scored`}</p>
    <div className="awards-field"><Label htmlFor={`${id}-value`}>{numeric ? 'Score' : 'Response'}{criterion.required ? ' (required)' : ''}</Label>
      {choices ? <select id={`${id}-value`} className="awards-select" value={answer.value ?? ''} aria-required={criterion.required} aria-invalid={valueError} aria-describedby={`${id}-help${valueError ? ` ${id}-value-error` : ''}`} onChange={event => onChange({ value: event.target.value })}><option value="">No response selected</option>{choices.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
        : numeric ? <Input id={`${id}-value`} type="number" step="any" min={criterion.min} max={criterion.max} value={answer.value ?? ''} aria-required={criterion.required} aria-invalid={valueError} aria-describedby={`${id}-help${valueError ? ` ${id}-value-error` : ''}`} onChange={event => onChange({ value: event.target.value })} />
          : <Textarea id={`${id}-value`} rows={4} maxLength={20000} value={answer.value ?? ''} aria-required={criterion.required} aria-invalid={valueError} aria-describedby={`${id}-help${valueError ? ` ${id}-value-error` : ''}`} onChange={event => onChange({ value: event.target.value })} />}
      {valueError && <p id={`${id}-value-error`} className="text-sm text-red-700">A response is required.</p>}
    </div>
    <div className="awards-field"><Label htmlFor={`${id}-comment`}>Comment {criterion.commentsRequired ? '(required with a response)' : '(optional)'}</Label><Textarea id={`${id}-comment`} rows={3} maxLength={20000} value={answer.comment ?? ''} aria-invalid={commentError} aria-describedby={commentError ? `${id}-comment-error` : undefined} onChange={event => onChange({ comment: event.target.value })} />
      {commentError && <p id={`${id}-comment-error`} className="text-sm text-red-700">A comment is required for this response.</p>}
    </div>
  </fieldset>;
}
