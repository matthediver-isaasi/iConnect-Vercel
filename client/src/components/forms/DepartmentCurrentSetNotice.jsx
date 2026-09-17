import { Checkbox } from '@/components/ui/checkbox';

/**
 * Deliberate acknowledgement prevents a failed/partial prefill from being
 * mistaken for a request to archive an entire current section.
 */
export default function DepartmentCurrentSetNotice({
  state,
  blockedReason,
}) {
  if (!state?.active) return null;
  const departmentLabel = state.currentSet?.department?.label
    || state.currentSet?.department?.name
    || state.departmentId
    || 'Department';
  if (state.loading) {
    return <p className="text-sm text-slate-600" data-testid="department-current-set-loading">Loading current Department data…</p>;
  }
  if (state.error || blockedReason?.includes('could not be loaded')
      || blockedReason?.includes('incomplete') || blockedReason?.includes('valid Department link')
      || blockedReason?.includes('safely applied') || blockedReason?.includes('stale')
      || blockedReason?.includes('changed')) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="department-current-set-error">
        {blockedReason || 'Current Department data could not be loaded. Reload before saving.'}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-slate-700" data-testid="department-current-set-review">
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