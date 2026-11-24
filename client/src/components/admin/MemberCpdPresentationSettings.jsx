import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MEMBER_CPD_LABEL_MAX_LENGTH } from '@shared/memberCpdPresentation.js';

export default function MemberCpdPresentationSettings({ settings, onChange, disabled }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="show-member-cpd-points">Show CPD points and history on member records</Label>
          <p className="text-sm text-slate-500">Hides the points balance, history and their controls on member records only. Speaker Awards and their certificates remain available. The self-service CPD page is unchanged.</p>
        </div>
        <Switch id="show-member-cpd-points" checked={settings.show_member_cpd_points}
          disabled={disabled} onCheckedChange={checked => onChange({ show_member_cpd_points: checked })} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="member-cpd-tab-label">Member CPD tab label</Label>
        <Input id="member-cpd-tab-label" value={settings.member_cpd_tab_label}
          maxLength={MEMBER_CPD_LABEL_MAX_LENGTH} disabled={disabled}
          onChange={event => onChange({ member_cpd_tab_label: event.target.value })} />
        <p className="text-sm text-slate-500">Up to {MEMBER_CPD_LABEL_MAX_LENGTH} characters. Leave blank to use “CPD points”. Applies to member records only.</p>
      </div>
    </div>
  );
}
