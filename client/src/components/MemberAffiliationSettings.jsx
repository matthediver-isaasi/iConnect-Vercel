import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import AffiliationChoice from "./AffiliationChoice";
import FormAffiliationSettings from "./FormAffiliationSettings";
import { EMPTY_CONFIG, affiliationChoices, affiliationValidation } from "./memberAffiliationSettingsModel.js";

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
  const [formsEnabled, setFormsEnabled] = useState(null);
  return <>
    <FormAffiliationSettings onModeChange={setFormsEnabled} />
    {formsEnabled === false && <LegacyMemberAffiliationSettings />}
    {formsEnabled === true && <p className="mb-6 text-sm text-muted-foreground">Legacy relationship settings are retained. Turn off form-based updates to review or edit them.</p>}
  </>;
}

function LegacyMemberAffiliationSettings() {
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
  // A snapshot owns both metadata and version. Background refresh must never
  // replace a draft, including unknown IDs or a previously valid selection.
  useEffect(() => {
    if (query.data && !snapshot) {
      setSnapshot(query.data);
      setConfig({ ...EMPTY_CONFIG, ...query.data.config });
    }
  }, [query.data, snapshot]);
  const dirty = !!snapshot && JSON.stringify(config) !== JSON.stringify({ ...EMPTY_CONFIG, ...snapshot.config });
  const metadata = snapshot?.metadata || { relationships: [], objects: [], fields: {} };
  const choices = affiliationChoices(config, metadata);
  const validation = affiliationValidation(config, metadata, choices);
  const hasAdditional = !!(config.secondaryMemberDefinitionId || config.secondaryOrganizationDefinitionId || config.secondaryLabelFieldId);
  const busy = saving || !!query.error;
  function update(key, value) {
    // Deliberately update only the requested key. Dependents stay visible for
    // review, not silently reset when a parent selection changes.
    setConfig(old => ({ ...old, [key]: value }));
    setMessage("");
    setError("");
  }
  async function save() {
    if (!snapshot || saving || !validation.valid) return;
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
  function choice(name, title, help, prerequisite, emptyLabel) {
    return <AffiliationChoice name={name} title={title} help={help} value={config[name]} options={choices[name]}
      onChange={value => update(name, value)} disabled={busy} prerequisite={prerequisite}
      issue={validation.issues[name]} emptyLabel={emptyLabel} />;
  }
  return (
    <Card className="mb-6 overflow-hidden">
      <CardHeader className="border-b border-blue-100 bg-blue-50/40">
        <CardTitle className="flex items-start gap-3 leading-snug"><Building2 className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />Let members update their organisation and departments</CardTitle>
        <CardDescription>Let members choose existing organisations and departments on their profile. Renewal forms stay unchanged. These settings are saved separately from your page layout.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        {(error || query.error) && <div role="alert" className="space-y-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{error || query.error.message}</p>
          <p>Your edits have been kept. Try saving again, or reload saved settings to review the latest version.</p>
          {query.error && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading settings</Button>}
        </div>}
        {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        {query.isLoading ? <div aria-label="Loading organisation settings" className="space-y-3"><Skeleton className="h-14 w-full" /><Skeleton className="h-32 w-full" /></div> : !snapshot ? (
          <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading settings</Button>
        ) : (
          <>
            <fieldset disabled={busy} className="min-w-0 space-y-6">
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4">
                <div className="space-y-1"><Label htmlFor="member-affiliations-enabled">Allow updates from member profiles</Label><p id="affiliation-toggle-help" className="text-sm text-muted-foreground">Off by default. Members can select existing records, not create new ones.</p></div>
                <Switch id="member-affiliations-enabled" aria-describedby="affiliation-toggle-help" checked={config.enabled === true} onCheckedChange={value => update("enabled", value)} />
              </div>
              <section aria-labelledby="affiliation-departments-heading" className="space-y-5">
                <div><h3 id="affiliation-departments-heading" className="font-semibold">Department setup</h3><p className="mt-1 text-sm text-muted-foreground">Choose the department records first, then how each department belongs to an organisation. Only compatible, active choices are offered.</p></div>
                {choice("memberDepartmentDefinitionId", "How are members linked to departments?", "Choose the connection that lets a member belong to more than one department.", null, "Choose a department connection")}
                {choice("departmentOrganizationDefinitionId", "Which organisation owns each department?", "This must use the same department records, with one owning organisation per department.", !choices.departmentReady ? "Choose a compatible department connection first." : null, "Choose an organisation connection")}
              </section>
              <details key={hasAdditional ? "configured" : "optional"} open={hasAdditional ? true : undefined} className="rounded-lg border px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold">Additional organisations <span className="font-normal text-muted-foreground">— optional{hasAdditional ? ", configured choices to review" : ""}</span></summary>
                <div className="mt-4 space-y-5">
                  <p className="text-sm text-muted-foreground">Use this only if members can have organisations beyond their main organisation. These need their own records, separate from departments.</p>
                  {choice("secondaryMemberDefinitionId", "How are additional organisations recorded for a member?", "Choose records owned by a single member.", !choices.ownerReady ? "Complete the department setup first." : null, "Do not use additional organisation records")}
                  {choice("secondaryOrganizationDefinitionId", "Which organisation does each additional record refer to?", "Choose the organisation connection for the same additional records.", !choices.assignmentReady ? "Choose how additional organisations are recorded first." : null, "Choose an additional organisation connection")}
                  {choice("secondaryLabelFieldId", "What description should members see?", "Choose a text field on the additional records, or use the default description if no field is required.", !choices.assignmentOwnerReady ? "Choose both additional organisation connections first." : null, "Use the default description")}
                  {hasAdditional && <Button type="button" variant="outline" onClick={() => {
                    if (!window.confirm("Remove the additional organisation setup from this draft? This does not delete any member records. Save settings to apply the change.")) return;
                    setConfig(old => ({ ...old, secondaryMemberDefinitionId: null, secondaryOrganizationDefinitionId: null, secondaryLabelFieldId: null }));
                    setError(""); setMessage("");
                  }}>Remove additional organisation setup</Button>}
                </div>
              </details>
              {validation.policyIssue && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{validation.policyIssue}</p>}
              <section aria-labelledby="affiliation-summary-heading" className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/40 p-4 text-sm">
                <h3 id="affiliation-summary-heading" className="font-semibold">What members will be able to do</h3>
                {!config.enabled ? <p>Member profile updates are off. Your setup is kept for later; renewal forms stay unchanged.</p> : !validation.valid ? <p>Setup needs review before it can be saved with member updates on. Resolve the guidance above, or turn updates off to keep your choices for later.</p> : <>
                  <p>Members can update their main organisation and choose existing {choices.departmentName} belonging to their organisations.</p>
                  <p>{hasAdditional ? `They can also manage additional organisations using ${choices.assignmentName}.` : "Additional organisation updates are not included."}</p>
                  <p>Members cannot create organisations or departments here. Renewal forms stay unchanged.</p>
                </>}
              </section>
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-muted-foreground">Technical details</summary>
                <div className="mt-3 space-y-3 rounded-md border bg-muted/20 p-3">
                  <p>Connections are checked using their actual endpoint types, record IDs, and access rules, never their names. IDs below are for administrator troubleshooting only.</p>
                  <p>Saved version: {snapshot.version}</p>
                  <dl className="space-y-3">
                    {Object.keys(EMPTY_CONFIG).filter(key => key !== "enabled").map(key => {
                      const definition = choices.find(config[key]);
                      return <div key={key} className="min-w-0"><dt className="font-medium">{key}</dt><dd className="break-all font-mono text-xs">{config[key] || "Not configured"}
                        {definition && <span className="mt-1 block">Source: {definition.source_kind} ({definition.source_custom_object_id || "core record"}); target: {definition.target_kind} ({definition.target_custom_object_id || "core record"}); status: {definition.status}; cardinality: {definition.cardinality}</span>}
                      </dd></div>;
                    })}
                  </dl>
                </div>
              </details>
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button type="button" disabled={!dirty || busy || !validation.valid} onClick={save}>{saving ? "Saving settings…" : "Save affiliation settings"}</Button>
                <Button type="button" variant="outline" disabled={!dirty || busy} onClick={() => { setConfig({ ...EMPTY_CONFIG, ...snapshot.config }); setError(""); setMessage(""); }}>Cancel settings edits</Button>
              </div>
            </fieldset>
            <Button type="button" variant="outline" disabled={saving || query.isFetching} onClick={async () => {
              if (!window.confirm("Reload saved affiliation settings? This discards your unsaved affiliation settings only.")) return;
              const result = await query.refetch();
              if (result.data && !result.error) { setSnapshot(result.data); setConfig({ ...EMPTY_CONFIG, ...result.data.config }); setError(""); setMessage(""); }
            }}>Reload saved settings</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
