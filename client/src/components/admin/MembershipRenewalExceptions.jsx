import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/adminFetch';
import { Button } from '@/components/ui/button';

const endpoint = '/api/admin/membership-renewal-journey';
const selectClass = 'block w-full rounded-md border bg-background p-2 text-sm';
const classKey = (fieldId, value) => JSON.stringify([fieldId, value]);

function invalidReason(rule, roles, classes, forms) {
  if (rule.matchType === 'role') {
    if (!roles.some(role => role.id === rule.roleId)) return 'Choose an available current role.';
  } else if (rule.matchType === 'membership_class') {
    if (!classes.some(item => item.fieldId === rule.fieldId && item.value === rule.classValue)) {
      return 'Choose an available purchased membership class.';
    }
  } else return 'Choose a supported match type.';
  if (!['same_schedule', 'questionnaire'].includes(rule.route)) return 'Choose a supported renewal route.';
  if ((rule.route === 'questionnaire' || rule.formId) && !forms.some(form => form.id === rule.formId)) {
    return 'Choose an available authenticated, active form.';
  }
  return '';
}

export default function MembershipRenewalExceptions({ tenantId }) {
  const [data, setData] = useState(null);
  const [rules, setRules] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const requestId = useRef(0);
  const scope = useRef(tenantId);
  scope.current = tenantId;

  async function request(options) {
    const response = await adminFetch(endpoint, options || {}, tenantId);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Renewal exceptions could not be loaded. Please try again.');
    return body;
  }

  async function load() {
    const id = ++requestId.current;
    const tenant = tenantId;
    setBusy(true); setError(''); setMessage(''); setConfirmReload(false); setConfirmRemove(null);
    try {
      const result = await request();
      if (id !== requestId.current || scope.current !== tenant) return;
      setData(result);
      setRules(result.exceptions?.rules || []);
    } catch (e) {
      if (id === requestId.current && scope.current === tenant) {
        setError(e.message); setData(null);
      }
    } finally {
      if (id === requestId.current && scope.current === tenant) setBusy(false);
    }
  }

  useEffect(() => {
    setData(null); setRules([]); setError(''); setMessage('');
    if (tenantId) void load();
    else setBusy(false);
    return () => { requestId.current += 1; };
  }, [tenantId]);

  const roles = Array.isArray(data?.roles) ? data.roles : [];
  const classes = Array.isArray(data?.classes) ? data.classes : [];
  const forms = Array.isArray(data?.forms) ? data.forms : [];
  const available = Boolean(tenantId && data?.exceptionsAvailable === true
    && Number.isInteger(data?.exceptions?.revision) && Array.isArray(data?.exceptions?.rules)
    && Array.isArray(data?.roles) && Array.isArray(data?.classes) && Array.isArray(data?.forms));
  const dirty = Boolean(data && JSON.stringify(rules) !== JSON.stringify(data.exceptions?.rules || []));
  const invalid = rules.some(rule => invalidReason(rule, roles, classes, forms));
  const disabled = busy || !available;

  function update(id, patch) {
    setRules(current => current.map(rule => rule.id === id ? { ...rule, ...patch } : rule));
    setMessage(''); setConfirmRemove(null);
  }

  function add() {
    setRules(current => [...current, {
      id: crypto.randomUUID(), matchType: 'membership_class', roleId: null,
      fieldId: null, classValue: null, route: 'same_schedule', formId: null, restrictToClass: false,
    }]);
    setMessage('');
  }

  async function save(event) {
    event.preventDefault();
    if (disabled || invalid || !dirty) return;
    const id = ++requestId.current;
    const tenant = tenantId;
    setBusy(true); setError(''); setMessage(''); setConfirmRemove(null);
    try {
      const result = await request({
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_exceptions', expectedRevision: data.exceptions.revision, rules }),
      });
      if (id !== requestId.current || scope.current !== tenant) return;
      if (!Number.isInteger(result.exceptions?.revision) || !Array.isArray(result.exceptions?.rules)) {
        throw new Error('The server did not confirm the saved exceptions. Reload to check their status.');
      }
      setData(current => ({ ...current, exceptions: result.exceptions }));
      setRules(result.exceptions.rules);
      setMessage('Renewal exceptions saved. The default journey, memberships and payments have not been changed.');
    } catch (e) {
      if (id === requestId.current && scope.current === tenant) setError(e.message);
    } finally {
      if (id === requestId.current && scope.current === tenant) setBusy(false);
    }
  }

  return <section className="mt-8 border-t pt-6" aria-labelledby="renewal-exceptions-title" aria-busy={busy}>
    <h3 id="renewal-exceptions-title" className="text-lg font-semibold">Renewal journey exceptions</h3>
    <p className="mt-1 text-sm text-muted-foreground">Use a different renewal journey for a particular role or purchased membership class. These exceptions are saved separately from the default journey above.</p>
    <div className="my-4 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium">Prefer membership class for lasting category rules</p>
      <p className="mt-1 text-muted-foreground">A purchased membership class still matches after a member becomes Former. A role rule matches only their current role: changing that role can stop the rule matching.</p>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error} {data ? 'Your edits are still shown. Reload to get the latest settings before retrying a revision conflict.' : 'Use Reload exceptions to try again.'}</p>}
    {message && <p role="status" className="mb-3 text-sm">{message}</p>}
    {busy && !data && <div role="status" className="mb-4 space-y-2">
      <span className="text-sm text-muted-foreground">Loading renewal exceptions…</span>
      <div aria-hidden="true" className="h-16 rounded-md bg-muted motion-safe:animate-pulse" />
    </div>}
    {!busy && !available && <p role="status" className="mb-4 rounded-md border p-3 text-sm">
      Renewal exceptions are unavailable. No exception changes can be saved. The default journey settings above remain separate.
    </p>}
    <form onSubmit={save} className="space-y-4">
      <fieldset disabled={disabled} className="min-w-0 space-y-4">
        <legend className="sr-only">Configure renewal exceptions</legend>
        {data && rules.length === 0 && <div className="rounded-md border border-dashed p-4">
          <p className="text-sm font-medium">No renewal exceptions</p>
          <p className="mt-1 text-sm text-muted-foreground">{dirty ? 'Save exceptions to remove all saved exceptions.' : 'Members use the default journey unless you add an exception.'}</p>
        </div>}
        {rules.map((rule, index) => {
          const reason = invalidReason(rule, roles, classes, forms);
          const selectedClass = classKey(rule.fieldId, rule.classValue);
          const classExists = classes.some(item => classKey(item.fieldId, item.value) === selectedClass);
          return <div key={rule.id} className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-medium">Exception {index + 1}</h4>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRemove(rule.id)}>Remove exception {index + 1}</Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-2"><span className="text-sm font-medium">Match members by</span>
                <select className={selectClass} value={rule.matchType} onChange={e => update(rule.id, { matchType: e.target.value, roleId: null, fieldId: null, classValue: null })}>
                  {!['membership_class', 'role'].includes(rule.matchType) && <option value={rule.matchType}>Saved match type is unavailable</option>}
                  <option value="membership_class">Purchased membership class (recommended)</option>
                  <option value="role">Current role</option>
                </select>
              </label>
              {rule.matchType === 'role' ? <label className="block space-y-2"><span className="text-sm font-medium">Current role</span>
                <select required className={selectClass} value={rule.roleId || ''} onChange={e => update(rule.id, { roleId: e.target.value || null })}>
                  <option value="">Choose a role</option>
                  {rule.roleId && !roles.some(role => role.id === rule.roleId) && <option value={rule.roleId}>Saved role is unavailable — choose a replacement</option>}
                  {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </label> : rule.matchType === 'membership_class' && <label className="block space-y-2"><span className="text-sm font-medium">Purchased membership class</span>
                <select required className={selectClass} value={rule.fieldId != null && rule.classValue != null ? selectedClass : ''} onChange={e => {
                  const [fieldId, classValue] = e.target.value ? JSON.parse(e.target.value) : [null, null];
                  update(rule.id, { fieldId, classValue });
                }}>
                  <option value="">Choose a membership class</option>
                  {rule.fieldId != null && rule.classValue != null && !classExists && <option value={selectedClass}>Saved membership class is unavailable — choose a replacement</option>}
                  {classes.map(item => <option key={classKey(item.fieldId, item.value)} value={classKey(item.fieldId, item.value)}>{item.label}</option>)}
                </select>
              </label>}
              <label className="block space-y-2"><span className="text-sm font-medium">Renewal route</span>
                <select className={selectClass} value={rule.route} onChange={e => update(rule.id, { route: e.target.value })}>
                  {!['same_schedule', 'questionnaire'].includes(rule.route) && <option value={rule.route}>Saved route is unavailable</option>}
                  <option value="same_schedule">Go directly to renewal payment</option>
                  <option value="questionnaire">Start with a questionnaire</option>
                </select>
                <span className="block text-sm text-muted-foreground">Go directly to a renewal payment form, or ask questions first.</span>
              </label>
              <label className="block space-y-2"><span className="text-sm font-medium">{rule.route === 'questionnaire' ? 'Renewal questionnaire' : 'Direct renewal payment form (optional)'}</span>
                <select required={rule.route === 'questionnaire'} className={selectClass} value={rule.formId || ''} onChange={e => update(rule.id, { formId: e.target.value || null })}>
                  <option value="">{rule.route === 'questionnaire' ? 'Choose a form' : 'Use the original portal renewal link'}</option>
                  {rule.formId && !forms.some(form => form.id === rule.formId) && <option value={rule.formId}>Saved form is unavailable — choose a replacement</option>}
                  {[...forms].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(form => <option key={form.id} value={form.id}>{form.name || 'Unnamed form'}</option>)}
                </select>
                <span className="block text-sm text-muted-foreground">{rule.route === 'questionnaire'
                  ? 'Choose the starting questionnaire. Only active forms requiring login are listed.'
                  : 'Choose a payment-only renewal form here, not a questionnaire. Leave empty to use the portal’s original configured renewal link, not the default questionnaire above. Only active forms requiring login are listed.'}</span>
              </label>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={Boolean(rule.restrictToClass)} onChange={e => update(rule.id, { restrictToClass: e.target.checked })} />
              <span>Keep the purchased membership category during self-service renewal
                <span className="mt-1 block text-muted-foreground">Members retain their purchased category. This does not lock them to a historic schedule ID.</span>
              </span>
            </label>
            {reason && <p className="text-sm text-red-600">{reason} Replace the unavailable choice or remove this exception before saving.</p>}
            {confirmRemove === rule.id && <div role="group" aria-label={`Confirm removal of exception ${index + 1}`} className="space-y-2 border-t pt-3">
              <p className="text-sm">Remove this exception? The change only takes effect when you save exceptions.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="destructive" size="sm" onClick={() => {
                  setRules(current => current.filter(item => item.id !== rule.id)); setConfirmRemove(null); setMessage('');
                }}>Confirm removal</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button>
              </div>
            </div>}
          </div>;
        })}
        <Button type="button" variant="outline" onClick={add}>Add exception</Button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={disabled || invalid || !dirty}>{busy && data ? 'Please wait…' : 'Save exceptions'}</Button>
        <Button type="button" variant="outline" disabled={busy || !tenantId} onClick={() => dirty ? setConfirmReload(true) : void load()}>Reload exceptions</Button>
        {dirty && <span className="text-sm text-muted-foreground">Unsaved exception changes</span>}
      </div>
      {confirmReload && <div className="space-y-2 rounded-md border p-3" role="group" aria-label="Discard unsaved exception changes">
        <p className="text-sm">Reload and discard your unsaved exception changes?</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={load}>Discard changes and reload</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmReload(false)}>Keep editing</Button>
        </div>
      </div>}
    </form>
  </section>;
}
