import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MEMBER_CPD_LABEL_MAX_LENGTH, memberCpdPresentation } from '@shared/memberCpdPresentation.js';

// Styled for the slate Admin Settings page. The stored value keeps its meaning:
// show_member_cpd_points === true (switch on) shows the points; false (switch off) hides them.
export default function MemberCpdPresentationSettings({ settings, onChange, disabled }) {
  const shown = memberCpdPresentation(settings).show_member_cpd_points;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 p-4 bg-slate-900/50 rounded-lg border border-slate-600">
        <div className="space-y-1">
          <Label htmlFor="show-member-cpd-points" className="text-slate-200 font-medium">
            Show CPD points balance and Points history on member records
          </Label>
          <p id="show-member-cpd-points-help" className="text-sm text-slate-400">
            On: the CPD points balance, Points history and their controls are shown on member records.
            Off: they are hidden on member records. Speaker Awards and their certificates stay visible either way,
            and the members’ self-service CPD page is unchanged.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            data-testid="status-member-cpd-points"
            aria-live="polite"
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${shown
              ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
              : 'border-slate-500 bg-slate-800 text-slate-300'}`}
          >
            {shown ? 'Shown' : 'Hidden'}
          </span>
          <Switch id="show-member-cpd-points" checked={shown}
            aria-describedby="show-member-cpd-points-help"
            disabled={disabled} onCheckedChange={checked => onChange({ show_member_cpd_points: checked })} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="member-cpd-tab-label" className="text-slate-200">Member CPD tab label</Label>
        <Input id="member-cpd-tab-label" value={settings.member_cpd_tab_label ?? ''}
          className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
          maxLength={MEMBER_CPD_LABEL_MAX_LENGTH} disabled={disabled}
          onChange={event => onChange({ member_cpd_tab_label: event.target.value })} />
        <p className="text-sm text-slate-400">Up to {MEMBER_CPD_LABEL_MAX_LENGTH} characters. Leave blank to use “CPD points”. Applies to member records only.</p>
      </div>
    </div>
  );
}
