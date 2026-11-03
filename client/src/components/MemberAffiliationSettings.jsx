import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const EMPTY_CONFIG = {
  enabled: false, memberDepartmentDefinitionId: null, departmentOrganizationDefinitionId: null,
  secondaryMemberDefinitionId: null, secondaryOrganizationDefinitionId: null, secondaryLabelFieldId: null,
};
async function request(method, body, signal) {
  const response = await fetch("/api/member-affiliation-settings", {
    method, credentials: "include", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || data?.message || (typeof data?.error === "string" && data.error) || `Unable to ${method === "GET" ? "load" : "save"} affiliation settings (${response.status}).`);
  if (!data?.config || !Number.isInteger(data.version) || !Array.isArray(data.metadata?.relationships) || !Array.isArray(data.metadata?.objects) || !data.metadata?.fields) throw new Error("Affiliation settings are incomplete. Editing remains unavailable.");
  return data;
}

export default function MemberAffiliationSettings() {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState(null);
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["member-affiliation-settings"], queryFn: ({ signal }) => request("GET", null, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  // Never replace an administrative draft on a background cache update.
  useEffect(() => {
    if (query.data && !snapshot) {
      setSnapshot(query.data);
      setConfig({ ...EMPTY_CONFIG, ...query.data.config });
    }
  }, [query.data, snapshot]);
  const dirty = !!snapshot && JSON.stringify(config) !== JSON.stringify({ ...EMPTY_CONFIG, ...snapshot.config });
  const relationships = snapshot?.metadata.relationships || [];
  const objects = snapshot?.metadata.objects || [];
  function side(definition, prefix) {
    const objectId = definition[`${prefix}_custom_object_id`];
    const object = objects.find(item => item.id === objectId);
    return object?.plural_label || object?.label || object?.name || definition[`${prefix}_kind`] || "Unknown";
  }
  function update(key, value) {
    setConfig(old => ({ ...old, [key]: value }));
    setMessage("");
    setError("");
  }
  const secondaryDefinitions = [config.secondaryMemberDefinitionId, config.secondaryOrganizationDefinitionId].map(id => relationships.find(item => item.id === id));
  const customIds = definition => definition ? [definition.source_custom_object_id, definition.target_custom_object_id].filter(Boolean) : [];
  const assignmentIds = customIds(secondaryDefinitions[0]).filter(id => customIds(secondaryDefinitions[1]).includes(id));
  const fields = assignmentIds.flatMap(objectId => (snapshot?.metadata.fields[objectId] || []).map(field => ({ ...field, objectId })));
  const secondaryIncomplete = !!config.secondaryMemberDefinitionId !== !!config.secondaryOrganizationDefinitionId;
  const missingRequired = config.enabled && (!config.memberDepartmentDefinitionId || !config.departmentOrganizationDefinitionId);
  async function save() {
    if (!snapshot || saving || secondaryIncomplete || missingRequired) return;
    setSaving(true);
    setError("");
    try {
      const data = await request("PUT", { version: snapshot.version, config });
      setSnapshot(data);
      setConfig({ ...EMPTY_CONFIG, ...data.config });
      queryClient.setQueryData(["member-affiliation-settings"], data);
      setMessage("Affiliation settings saved.");
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return (
    <Card className="mb-6">
      <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5 text-blue-600" />Member affiliation editing</CardTitle><CardDescription>Allow members to manage their own organisations and departments. Disabled by default; saved separately from page layout.</CardDescription></CardHeader>
      <CardContent className="space-y-5">
        {(error || query.error) && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error || query.error.message}</p>}
        {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        {query.isLoading ? <Skeleton className="h-32 w-full" /> : !snapshot ? <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading settings</Button> : (
          <fieldset disabled={saving || !!query.error} className="min-w-0 space-y-4">
            <div className="flex items-center justify-between gap-4"><Label htmlFor="member-affiliations-enabled">Enable own-member affiliation editing</Label><Switch id="member-affiliations-enabled" checked={config.enabled === true} onCheckedChange={value => update("enabled", value)} /></div>
            <p className="text-xs text-slate-500">Each option shows its actual source and target. Member, department, and assignment sides are inferred from these definitions, not from their names. Unsupported combinations will be rejected by the server.</p>
            {[
              ["memberDepartmentDefinitionId", "Member ↔ department relationship"],
              ["departmentOrganizationDefinitionId", "Department ↔ organisation relationship"],
              ["secondaryMemberDefinitionId", "Secondary assignment ↔ member relationship (optional)"],
              ["secondaryOrganizationDefinitionId", "Secondary assignment ↔ organisation relationship (optional)"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`affiliation-${key}`}>{label}</Label>
                <select id={`affiliation-${key}`} className="flex h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm" value={config[key] || ""} onChange={event => update(key, event.target.value || null)}>
                  <option value="">Not configured</option>
                  {config[key] && !relationships.some(item => item.id === config[key]) && <option value={config[key]}>Unavailable definition ({config[key]}) — retained</option>}
                  {relationships.map(item => <option key={item.id} value={item.id}>{item.label || item.name || item.id} — Source: {side(item, "source")} → Target: {side(item, "target")} [{item.id}]</option>)}
                </select>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="affiliation-label-field">Secondary assignment label field (optional)</Label>
              <select id="affiliation-label-field" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={config.secondaryLabelFieldId || ""} onChange={event => update("secondaryLabelFieldId", event.target.value || null)}>
                <option value="">Use default label</option>
                {config.secondaryLabelFieldId && !fields.some(item => item.id === config.secondaryLabelFieldId) && <option value={config.secondaryLabelFieldId}>Unavailable field ({config.secondaryLabelFieldId}) — retained</option>}
                {fields.map(item => <option key={item.id} value={item.id}>{item.label || item.field_label || item.name || item.id} [{item.id}]</option>)}
              </select>
              <p className="text-xs text-slate-500">Fields belong to the shared assignment object in the two secondary relationships. Select both secondary definitions to view fields.</p>
            </div>
            {secondaryIncomplete && <p role="alert" className="text-sm text-red-700">Choose both secondary relationships, or clear both.</p>}
            {missingRequired && <p role="alert" className="text-sm text-red-700">Choose both department relationships before enabling editing.</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!dirty || saving || secondaryIncomplete || missingRequired} onClick={save}>{saving ? "Saving settings…" : "Save affiliation settings"}</Button>
              <Button type="button" variant="outline" disabled={!dirty || saving} onClick={() => { setConfig({ ...EMPTY_CONFIG, ...snapshot.config }); setError(""); setMessage(""); }}>Cancel settings edits</Button>
              <Button type="button" variant="outline" disabled={saving || query.isFetching} onClick={async () => {
                if (!window.confirm("Reload saved affiliation settings? This discards your unsaved affiliation settings only.")) return;
                const result = await query.refetch();
                if (result.data && !result.error) { setSnapshot(result.data); setConfig({ ...EMPTY_CONFIG, ...result.data.config }); setError(""); setMessage(""); }
              }}>Reload saved settings</Button>
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
