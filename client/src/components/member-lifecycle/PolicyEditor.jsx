import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_LIFECYCLE_POLICY, LIFECYCLE_ACTIVITIES, validateLifecyclePolicy } from "../../../../shared/memberLifecyclePolicy.mjs";
import { Notice, Panel, words } from "./LifecycleUI";

const roleFields = [
  ["formerRoleId", "Former-member destination", "Role applied after membership grace ends.", false],
  ["guestRoleId", "CPD guest destination", "Role for former members with recent qualifying activity.", false],
  ["guestRoleIds", "Existing guest classifications", "Select existing roles classified as guests. A role is not evidence of membership history.", true],
  ["eventOnlyRoleIds", "Attendance-only guest classifications", "Only recorded event attendance qualifies for these roles.", true],
];
const periods = [
  ["formerRetentionYears", "Former-member retention (years)", "Calendar years after membership grace expiry."],
  ["guestInactivityYears", "Qualifying inactivity (years)", "Calendar years since the last reliable qualifying activity."],
  ["archiveReviewYears", "Archive retention (years)", "Calendar years after archiving before deletion review, not automatic disposal."],
];

function clonePolicy(policy) {
  return Object.fromEntries(Object.keys(DEFAULT_LIFECYCLE_POLICY).map(key => [key, policy[key]]));
}

export default function PolicyEditor({ config, pending, onSave, onDirty }) {
  // Mounted per authoritative revision. Defaults are a schema, not a fallback
  // for unavailable tenant policy or invented tenant configuration.
  const [draft, setDraft] = useState(() => clonePolicy(config.policy));
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const canEdit = config.permissions.configure === true;
  const disabled = !canEdit || !!pending;
  const change = (key, value) => {
    setDraft(old => ({ ...old, [key]: value }));
    setDirty(true);
    onDirty(true);
    setError(null);
  };
  const save = async (event) => {
    event.preventDefault();
    try {
      const policy = validateLifecyclePolicy(draft);
      const knownRoles = new Set(config.roles.map(role => role.id));
      for (const [key, , , multiple] of roleFields) {
        const values = multiple ? policy[key] : policy[key] ? [policy[key]] : [];
        if (values.some(value => !knownRoles.has(value))) throw new Error("Remove unavailable role mappings and select existing tenant roles.");
      }
      const outcome = await onSave(policy);
      if (outcome) { setDirty(false); onDirty(false); }
    } catch (err) { setError(err.message); }
  };
  return <Panel step="01 / Configure" title="Retention policy" description={`Policy revision ${config.revision}. Saving pauses automation and requires fresh impact approval.`}>
    <form className="ml-panel-body space-y-6" onSubmit={save}>
      {!canEdit && <Notice title="Read-only policy">You can inspect the policy but do not have configuration permission.</Notice>}
      {config.revision === 0 && <Notice title="Draft not yet saved">Save this tenant’s initial policy before generating an impact preview. Saving does not enable automation.</Notice>}
      <fieldset disabled={disabled} className="space-y-5">
        <legend className="mb-3 font-semibold">Dates & retention</legend>
        <label className="ml-field"><span>Tenant timezone</span><Input value={draft.timezone ?? ""} onChange={event => change("timezone", event.target.value)} required placeholder="IANA timezone, e.g. Europe/London" />
          <small>Calendar anniversaries use this timezone. Original occurrence dates, not import or edit dates, determine activity.</small></label>
        <div className="ml-fields">{periods.map(([key, label, help]) => <label key={key} className="ml-field"><span>{label}</span>
          <Input type="number" min="0" max="100" step="1" required value={draft[key] ?? ""} onChange={event => change(key, event.target.value === "" ? "" : Number(event.target.value))} />
          <small>{help}</small></label>)}</div>
      </fieldset>
      <fieldset disabled={disabled} className="space-y-3 border-t pt-5">
        <legend className="font-semibold">Qualifying activity</legend>
        <p className="ml-muted text-xs">Choose at least one. Real portal logins exclude masquerading, session refreshes and administrator inspection. Missing evidence causes a hold, not assumed inactivity.</p>
        {LIFECYCLE_ACTIVITIES.map(activity => <label className="ml-check" key={activity}>
          <input type="checkbox" checked={draft.activities?.includes(activity) === true} onChange={event => change("activities", event.target.checked ? [...(draft.activities || []), activity] : draft.activities.filter(value => value !== activity))} />
          <span>{words(activity)}</span></label>)}
      </fieldset>
      <fieldset disabled={disabled} className="space-y-4 border-t pt-5">
        <legend className="font-semibold">Existing role mappings</legend>
        <p className="ml-muted text-xs">Lifecycle state is separate from entitlement, billing and team-administrator access. No roles are created. Missing or invalid destinations block transitions.</p>
        {!config.roles.length && <Notice tone="warning" title="No roles available">Role transitions cannot be configured until existing tenant roles are available.</Notice>}
        <div className="ml-fields">{roleFields.map(([key, label, help, multiple]) => {
          const selected = multiple ? draft[key] || [] : draft[key] ? [draft[key]] : [];
          const missing = selected.filter(id => !config.roles.some(role => role.id === id));
          return <label className="ml-field" key={key}><span>{label}</span>
            <select className="ml-select" multiple={multiple} value={multiple ? selected : draft[key] || ""} onChange={event => change(key, multiple ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value || null)}>
              {!multiple && <option value="">No destination selected</option>}
              {missing.map(id => <option key={id} value={id}>Unavailable role: {id}</option>)}
              {config.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select>
            <small>{help}{multiple ? " Use Ctrl / Command to select or deselect multiple roles." : ""}</small>
            {missing.length > 0 && <small role="alert">A selected role is unavailable. Replace or remove it before saving.</small>}
          </label>;
        })}</div>
      </fieldset>
      <fieldset disabled={disabled} className="space-y-4 border-t pt-5">
        <legend className="font-semibold">Reviewer notifications</legend>
        <label className="ml-check"><input type="checkbox" checked={draft.notificationsEnabled === true} onChange={event => change("notificationsEnabled", event.target.checked)} /><span>Notify authorised reviewers about approaching and actual review eligibility</span></label>
        <label className="ml-field"><span>Notification lead time (days)</span><Input type="number" min="0" max="365" step="1" required value={draft.notificationLeadDays ?? ""} onChange={event => change("notificationLeadDays", event.target.value === "" ? "" : Number(event.target.value))} /><small>Notifications do not grant approval or authorise disposal.</small></label>
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      {dirty && <Notice tone="warning">Unsaved changes are not included in an impact preview. Save first; saving disables the current policy.</Notice>}
      {canEdit && <div className="flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" disabled={!!pending || (!dirty && config.revision !== 0)}><Save aria-hidden="true" className="h-4 w-4" />{pending === "save" ? "Saving & pausing…" : "Save policy & pause"}</Button>
        <Button type="button" variant="ghost" disabled={!!pending || !dirty} onClick={() => { setDraft(clonePolicy(config.policy)); setDirty(false); onDirty(false); setError(null); }}>Discard changes</Button>
      </div>}
    </form>
  </Panel>;
}
