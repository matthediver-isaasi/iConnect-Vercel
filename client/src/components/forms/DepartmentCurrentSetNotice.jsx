import { Checkbox } from '@/components/ui/checkbox';
import { currentSetIdentityName } from '@/lib/departmentCurrentSet';

/**
 * Deliberate acknowledgement prevents a failed/partial prefill from being
 * mistaken for a request to archive an entire current section.
 */
export default function DepartmentCurrentSetNotice({
  state,
  blockedReason,
}) {
  if (!state?.active) return null;
  const departmentLabel = currentSetIdentityName(state.displayIdentity?.department?.label)
    || currentSetIdentityName(state.displayIdentity?.department?.name)
    || 'Department unavailable';
  const organizationLabel = state.displayIdentity?.organization?.status === 'available'
    ? currentSetIdentityName(state.displayIdentity.organization.name) || 'Organisation unavailable'
    : 'Organisation unavailable';
  if (state.loading || state.identityLoading) {
    return <p className="text-sm text-slate-600" data-testid="department-current-set-loading">Loading current Department data…</p>;
  }
  if (!state.departmentId) {
    if (state.optionsLoading) {
      return <p className="text-sm text-slate-600" data-testid="department-current-set-options-loading">Loading your assigned Departments…</p>;
    }
    if (state.error) {
      return (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="department-current-set-error">
          {state.error.message || 'Your assigned Departments could not be loaded. Reload and try again.'}
        </div>
      );
    }
    if (!state.departmentOptions?.length) {
      return (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="department-current-set-no-options">
          No Department is assigned to your account for this form.
        </div>
      );
    }
    return (
      <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-slate-700" data-testid="department-current-set-picker">
        <label htmlFor="department-current-set-picker" className="font-medium">Choose the Department to update</label>
        <select
          id="department-current-set-picker"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2"
          value=""
          onChange={event => state.selectDepartment?.(event.target.value)}
        >
          <option value="" disabled>Select a Department</option>
          {state.departmentOptions.map(option => (
            <option key={option.id} value={option.id}>{currentSetIdentityName(option.label) || currentSetIdentityName(option.name) || 'Department name unavailable'}</option>
          ))}
        </select>
        <p className="text-xs text-slate-600">Only Departments assigned to your signed-in account are shown.</p>
      </div>
    );
  }
  if (state.error || blockedReason?.includes('could not be loaded')
      || blockedReason?.includes('incomplete') || blockedReason?.includes('valid Department link')
      || blockedReason?.includes('safely applied') || blockedReason?.includes('stale')
      || blockedReason?.includes('changed')) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="department-current-set-error">
        {state.error?.message || blockedReason || 'Current Department data could not be loaded. Reload before saving.'}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-slate-700" data-testid="department-current-set-review">
      <section aria-label="Workforce survey identity" data-testid="department-current-set-identity" className="rounded-md border border-blue-200 bg-white p-4 text-left">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-sm font-medium text-slate-600">Organisation</dt>
            <dd className="mt-1 break-words text-lg font-semibold text-slate-900">{organizationLabel}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm font-medium text-slate-600">Department</dt>
            <dd className="mt-1 break-words text-lg font-semibold text-slate-900">{departmentLabel}</dd>
          </div>
        </dl>
      </section>
      <p>
        Editing the current Workforce and Equipment sets for <strong>{departmentLabel}</strong>.
        Existing blank serial numbers and installation years are retained; new equipment requires them.
      </p>
      {(state.currentSet?.workforce?.legacy || state.currentSet?.equipment?.legacy) && (
        <p className="text-amber-800">
          Some saved values use legacy choices. They remain available for review and will be preserved unless changed.
        </p>
      )}
      {['workforce', 'equipment'].map(section => (
        <label key={section} className="flex items-start gap-2">
          <Checkbox
            checked={state.acknowledgements?.[section] === true}
            onCheckedChange={checked => state.setAcknowledgements(previous => ({
              ...previous,
              [section]: checked === true,
            }))}
            data-testid={`acknowledge-current-${section}`}
          />
          <span>
            I have reviewed the complete current {section === 'workforce' ? 'Workforce' : 'Equipment'} set,
            including any removals or an intentionally empty section.
          </span>
        </label>
      ))}
    </div>
  );
}