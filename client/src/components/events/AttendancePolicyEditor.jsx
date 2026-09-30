import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  describeAttendancePolicy,
  normalizeAttendancePolicy,
  resolveAttendancePolicy,
} from "@/lib/attendancePolicy";

export default function AttendancePolicyEditor({
  value,
  onChange,
  allowInheritance = false,
  parentPolicy = null,
  targetSupported = true,
  providerAvailability = { zoom: true, teams: true },
  label = 'Attendance tracking',
  testId = 'attendance-policy',
}) {
  const policy = normalizeAttendancePolicy(value, { inherit: allowInheritance });
  const effective = allowInheritance
    ? resolveAttendancePolicy(parentPolicy, policy)
    : policy;
  const update = (patch) => onChange({ ...policy, ...patch });

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" data-testid={testId}>
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-slate-500">
          Mark confirmed attendees using the provider's post-event attendance report.
        </p>
      </div>

      {allowInheritance && (
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label>Inherit event attendance policy</Label>
            <p className="text-xs text-slate-500">Use the event default for this attendance target.</p>
          </div>
          <Switch
            checked={policy.attendance_policy_inherit}
            onCheckedChange={(checked) => update({ attendance_policy_inherit: checked })}
            data-testid={`${testId}-inherit`}
          />
        </div>
      )}

      {(!allowInheritance || !policy.attendance_policy_inherit) && (
        <>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Track online attendance</Label>
          <p className="text-xs text-slate-500">Supported for linked Zoom and Microsoft Teams meetings.</p>
            </div>
            <Switch
              checked={policy.attendance_tracking_enabled}
              onCheckedChange={(checked) => update({ attendance_tracking_enabled: checked })}
              data-testid={`${testId}-enabled`}
            />
          </div>
          {policy.attendance_tracking_enabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Provider</Label>
                <Select
                  value={policy.attendance_provider}
                  onValueChange={(provider) => update({ attendance_provider: provider })}
                >
                  <SelectTrigger data-testid={`${testId}-provider`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zoom">Zoom</SelectItem>
                    <SelectItem value="teams" disabled={providerAvailability.teams === false}>Microsoft Teams</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Qualifying duration (minutes)</Label>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={policy.attendance_threshold_minutes}
                  onChange={(event) => update({
                    attendance_threshold_minutes: Number.parseInt(event.target.value, 10) || 1,
                  })}
                  data-testid={`${testId}-threshold`}
                />
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-xs font-medium text-slate-600" data-testid={`${testId}-effective`}>
        Effective policy: {describeAttendancePolicy(effective)}
      </p>
      {effective.attendance_tracking_enabled && !targetSupported && (
        <p className="text-xs text-amber-700" role="alert">
          Link a supported {effective.attendance_provider === 'teams' ? 'Teams meeting' : 'Zoom meeting or webinar'} to use attendance tracking for this target.
        </p>
      )}
    </div>
  );
}