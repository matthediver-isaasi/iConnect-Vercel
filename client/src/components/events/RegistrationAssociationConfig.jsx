import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isProvisionableRole } from "@/utils/publicTicketMembers";
import { normalizeRegistrationAssociationConfig } from "@/lib/registrationAssociations";

function ScopeFilter({ scope, label, value, onChange }) {
  const id = useId();
  const fields = useQuery({
    queryKey: ["registration-association-fields", scope],
    queryFn: async () => {
      const result = await base44.entities.PreferenceField.list({
        filter: { is_active: true, entity_scope: scope }, sort: { display_order: "asc" },
      });
      return (result || []).filter(field => field.entity_scope === scope && field.is_active !== false);
    },
    enabled: value.enabled,
  });
  const field = fields.data?.find(item => item.id === value.field_id);
  const options = field?.field_type === "boolean"
    ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
    : (field?.options || []).map(option => ({ value: String(option.value ?? option), label: option.label || String(option.value ?? option) }));
  const updateValues = values => onChange({ ...value, values });
  return <div className="space-y-3 rounded-md border border-slate-200 p-4">
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id}>{label}</Label>
      <Switch id={id} checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled })} />
    </div>
    {value.enabled && <div className="space-y-3">
      {fields.isLoading ? <div className="h-10 animate-pulse rounded-md bg-slate-100" aria-label="Loading custom fields" /> :
        fields.isError ? <div role="alert" className="text-sm text-red-700">Unable to load custom fields. <Button type="button" variant="link" onClick={() => fields.refetch()}>Retry</Button></div> :
        <div className="space-y-2">
          <Label htmlFor={`${id}-field`}>Custom field filter</Label>
           <Select value={value.field_id || "all"} onValueChange={field_id => {
             if (!field_id) return; // Ignore Radix native-option hydration, not an explicit field change.
             if ((field_id === "all" ? null : field_id) !== value.field_id)
               onChange({ ...value, field_id: field_id === "all" ? null : field_id, values: [] });
           }}>
            <SelectTrigger id={`${id}-field`}><SelectValue placeholder="Choose a custom field" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All records (no filter)</SelectItem>
              {value.field_id && !field && <SelectItem value={value.field_id}>Previously selected field (unavailable)</SelectItem>}
              {(fields.data || []).map(item => <SelectItem key={item.id} value={item.id}>{item.label || item.field_key}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>}
      {value.field_id && <div className="space-y-2">
        <Label htmlFor={`${id}-value`}>Matching value *</Label>
        {!field ? <div role="status" className="text-sm text-slate-500">
          Saved matching values: {value.values.join("; ") || "None"}. Load the selected field to edit.
        </div> : options.length ? <>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" id={`${id}-value`} className="w-full justify-start">
                {value.values.length ? `${value.values.length} selected` : "Choose matching values"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-64 overflow-y-auto">
              <div role="group" aria-label={`${label}: matching values`}>
                {options.map(option => <label key={option.value} className="flex items-center gap-2 rounded p-2 text-sm">
                  <input type="checkbox" checked={value.values.includes(option.value)}
                    onChange={event => updateValues(event.target.checked
                      ? [...value.values, option.value] : value.values.filter(item => item !== option.value))} />
                  {option.label}
                </label>)}
              </div>
            </PopoverContent>
          </Popover>
          <ul className="flex flex-wrap gap-2" aria-label={`${label}: selected matching values`}>
            {value.values.map(item => <li key={item} className="flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-sm">
              {options.find(option => option.value === item)?.label || item}
              <button type="button" aria-label={`Remove ${options.find(option => option.value === item)?.label || item}`}
                onClick={() => updateValues(value.values.filter(next => next !== item))}>×</button>
            </li>)}
          </ul>
          <p className="text-xs text-slate-500">Records matching any selected value are included.</p>
        </> : <Input id={`${id}-value`} value={value.values[0] ?? ""} onChange={event => updateValues([event.target.value])} />}
      </div>}
    </div>}
  </div>;
}

export default function RegistrationAssociationConfig({ value, onChange, roles = [], loading = false }) {
  const id = useId();
  const config = normalizeRegistrationAssociationConfig(value);
  const enabled = config.organizations.enabled || config.groups.enabled;
  const eligible = roles.filter(isProvisionableRole);
  return <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby={`${id}-title`}>
    <div>
      <h3 id={`${id}-title`} className="text-base font-medium text-slate-900">Guest registration organisations and groups</h3>
      <p className="mt-1 text-sm text-slate-500">Let guests search existing organisations and groups by name. Guests can always choose Other and enter their organisation.</p>
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <ScopeFilter scope="organization" label="Enable organisations" value={config.organizations} onChange={next => onChange({ ...config, organizations: next })} />
      <ScopeFilter scope="organization_group" label="Enable organisation groups" value={config.groups} onChange={next => onChange({ ...config, groups: next })} />
    </div>
    {enabled && <div className="space-y-2">
      <Label htmlFor={`${id}-role`}>Role for associated registrants *</Label>
      <Select value={config.role_id || ""} disabled={loading} onValueChange={role_id => onChange({ ...config, role_id })}>
        <SelectTrigger id={`${id}-role`}><SelectValue placeholder={loading ? "Loading roles..." : "Select an eligible role"} /></SelectTrigger>
        <SelectContent>{eligible.map(role => <SelectItem key={role.id} value={String(role.id)}>{role.name}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-xs text-slate-500">Administrator roles and roles requiring an organisation, effective date or limited capacity are not available.</p>
      {!loading && !eligible.length && <p role="alert" className="text-sm text-amber-700">No eligible roles are available. Configure an eligible role before enabling this feature.</p>}
      {config.role_id && !eligible.some(role => String(role.id) === String(config.role_id)) && !loading && <p role="alert" className="text-sm text-amber-700">The saved role is no longer eligible. Select another role before saving.</p>}
    </div>}
  </section>;
}
