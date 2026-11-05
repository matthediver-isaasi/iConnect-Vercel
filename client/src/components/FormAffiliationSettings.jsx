import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const QUERY_KEY = ["member-affiliation-settings", "forms"];
const DEFAULT_CONFIG = { version: 1, enabled: false, fieldId: null, mappings: [], fallbackFormId: null, linkText: "Update my affiliations", helpText: "" };
const selectClass = "flex min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

async function request(method, body, signal) {
  const response = await fetch("/api/member-affiliation-settings?mode=forms", {
    method, credentials: "include", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Unable to ${method === "GET" ? "load" : "save"} form affiliation settings (${response.status}).`);
  if (!Number.isInteger(data?.version) || data?.config?.version !== 1 || !Array.isArray(data.config.mappings) || !Array.isArray(data.metadata?.fields) || !Array.isArray(data.metadata?.forms)) {
    throw new Error("Form affiliation settings are incomplete. Please reload before editing.");
  }
  return data;
}

export default function FormAffiliationSettings({ onModeChange }) {
  const queryClient = useQueryClient();
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const [snapshot, setSnapshot] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: QUERY_KEY, queryFn: ({ signal }) => request("GET", null, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => {
    if (query.data && !snapshot) {
      setSnapshot(query.data);
      setConfig({ ...DEFAULT_CONFIG, ...query.data.config });
      onModeChangeRef.current?.(query.data.config.enabled === true);
    }
  }, [query.data, snapshot]);
  const fields = snapshot?.metadata.fields || [];
  const forms = snapshot?.metadata.forms || [];
  const field = fields.find(item => item.id === config.fieldId);
  const dirty = !!snapshot && JSON.stringify(config) !== JSON.stringify({ ...DEFAULT_CONFIG, ...snapshot.config });
  const formIssue = id => {
    if (!id) return "Choose a form.";
    const form = forms.find(item => item.id === id);
    return !form ? "This saved form is no longer available. Choose another form." : form.eligible !== true ? (form.reason || "This form cannot be used for profile affiliations.") : null;
  };
  const issues = [
    ...(config.mappings.length && !field ? ["Choose an available member field for your matching rules."] : []),
    ...config.mappings.flatMap((mapping, index) => [
      ...(mapping.value === "" ? [`Rule ${index + 1}: enter an exact field value.`] : []),
      ...(formIssue(mapping.formId) ? [`Rule ${index + 1}: ${formIssue(mapping.formId)}`] : []),
    ]),
    ...(config.fallbackFormId && formIssue(config.fallbackFormId) ? [`Fallback: ${formIssue(config.fallbackFormId)}`] : []),
    ...(!config.linkText.trim() ? ["Enter the text for the member's update link."] : []),
  ];
  function update(key, value) {
    setConfig(old => ({ ...old, [key]: value }));
    setError(""); setMessage("");
  }
  function updateMapping(index, key, value) {
    update("mappings", config.mappings.map((item, position) => position === index ? { ...item, [key]: value } : item));
  }
  function move(index, direction) {
    const next = [...config.mappings];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    update("mappings", next);
  }
  function accept(data) {
    setSnapshot(data); setConfig({ ...DEFAULT_CONFIG, ...data.config });
    queryClient.setQueryData(QUERY_KEY, data);
    onModeChangeRef.current?.(data.config.enabled === true);
  }
  async function save() {
    if (!snapshot || saving || (config.enabled && issues.length)) return;
    setSaving(true); setError(""); setMessage("");
    try {
      accept(await request("PUT", { version: snapshot.version, config }));
      setMessage("Form affiliation settings saved.");
    } catch (err) { setError(`${err.message} Your edits have been kept.`); }
    finally { setSaving(false); }
  }
  function formSelect(id, value, onChange, optional = false) {
    return <select id={id} className={selectClass} value={value || ""} onChange={event => onChange(event.target.value || null)}>
      <option value="">{optional ? "No fallback — updates unavailable without a match" : "Choose a form"}</option>
      {value && !forms.some(item => item.id === value) && <option value={value}>Unavailable saved form ({value})</option>}
      {forms.map(item => <option key={item.id} value={item.id} disabled={item.eligible !== true}>{item.name}{item.eligible !== true ? ` — ${item.reason || "Unavailable"}` : ""}</option>)}
    </select>;
  }
  return <Card className="mb-6 overflow-hidden">
    <CardHeader className="border-b border-blue-100 bg-blue-50/40">
      <CardTitle className="flex items-start gap-3 leading-snug"><FileText className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />Profile affiliations through forms</CardTitle>
      <CardDescription>Choose which form members use to update their organisations and departments. Join and renewal forms stay unchanged.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5 pt-6" aria-busy={query.isFetching || saving}>
      {(error || query.error) && <div role="alert" className="space-y-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        <p>{error || query.error.message}</p>
        {query.error && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading form settings</Button>}
      </div>}
      {message && <p role="status" className="text-sm text-green-700">{message}</p>}
      {query.isLoading ? <div role="status" className="space-y-3"><span className="sr-only">Loading form affiliation settings</span><Skeleton className="h-16 w-full" /><Skeleton className="h-32 w-full" /></div> : snapshot && <fieldset disabled={saving || query.isFetching || !!query.error} className="min-w-0 space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4">
          <div className="space-y-1"><Label htmlFor="form-affiliations-enabled">Use forms for profile affiliation updates</Label><p id="form-affiliations-help" className="text-sm text-muted-foreground">Off by default. When on, this replaces the legacy profile editor without deleting its settings. Form updates apply automatically; no manual due diligence review is required.</p></div>
          <Switch id="form-affiliations-enabled" aria-describedby="form-affiliations-help" checked={config.enabled === true} onCheckedChange={value => update("enabled", value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="form-affiliation-field">Match a member field</Label>
          <select id="form-affiliation-field" className={selectClass} value={config.fieldId || ""} onChange={event => update("fieldId", event.target.value || null)}>
            <option value="">No matching field — use fallback only</option>
            {config.fieldId && !field && <option value={config.fieldId}>Unavailable saved field ({config.fieldId})</option>}
            {fields.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <p className="text-sm text-muted-foreground">Use a core or custom member field, such as country. Rules compare exact values in the order below; the first match wins.</p>
        </div>
        <section aria-labelledby="form-affiliation-rules" className="space-y-3">
          <h3 id="form-affiliation-rules" className="font-semibold">Form routing rules</h3>
          {!config.mappings.length && <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">No matching rules yet. Members use the fallback form, if one is selected.</div>}
          <ol className="space-y-3">
            {config.mappings.map((mapping, index) => <li key={index} className="min-w-0 space-y-3 rounded-lg border bg-muted/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">Rule {index + 1}</span><div className="flex gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={index === 0} aria-label={`Move rule ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></Button>
                <Button type="button" size="sm" variant="ghost" disabled={index === config.mappings.length - 1} aria-label={`Move rule ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></Button>
                <Button type="button" size="sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => update("mappings", config.mappings.filter((_, position) => position !== index))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
              </div></div>
              <div className="grid min-w-0 gap-3 md:grid-cols-2">
                <div className="min-w-0 space-y-2"><Label htmlFor={`affiliation-value-${index}`}>Field value equals</Label><Input id={`affiliation-value-${index}`} value={mapping.value} list="affiliation-field-values" onChange={event => updateMapping(index, "value", event.target.value)} /></div>
                <div className="min-w-0 space-y-2"><Label htmlFor={`affiliation-form-${index}`}>Open form</Label>{formSelect(`affiliation-form-${index}`, mapping.formId, value => updateMapping(index, "formId", value || ""))}</div>
              </div>
            </li>)}
          </ol>
          <datalist id="affiliation-field-values">{(field?.options || []).map((option, index) => {
            const value = typeof option === "object" && option !== null ? option.value ?? option.id ?? option.label : option;
            return <option key={index} value={String(value ?? "")}>{typeof option === "object" && option !== null ? option.label || String(value ?? "") : String(value ?? "")}</option>;
          })}</datalist>
          <Button type="button" variant="outline" onClick={() => update("mappings", [...config.mappings, { value: "", formId: "" }])}>Add matching rule</Button>
        </section>
        <div className="space-y-2"><Label htmlFor="affiliation-fallback-form">Fallback form — optional</Label>{formSelect("affiliation-fallback-form", config.fallbackFormId, value => update("fallbackFormId", value), true)}<p className="text-sm text-muted-foreground">Used when no rule matches. Without a fallback, unmatched members see that affiliation updates are unavailable. They will not be sent to the legacy editor.</p></div>
        <div className="space-y-2"><Label htmlFor="affiliation-form-link-text">Member link text</Label><Input id="affiliation-form-link-text" value={config.linkText} onChange={event => update("linkText", event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="affiliation-form-help-text">Member help text</Label><textarea id="affiliation-form-help-text" className={`${selectClass} min-h-20`} value={config.helpText} onChange={event => update("helpText", event.target.value)} /></div>
        {issues.length > 0 && <div role={config.enabled ? "alert" : "status"} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-medium">Review before enabling form updates</p><ul className="mt-2 list-disc space-y-1 pl-5">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul><p className="mt-2">You can turn form updates off and save these choices for later.</p></div>}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" disabled={!dirty || (config.enabled && issues.length > 0)} onClick={save}>{saving ? "Saving settings…" : "Save form affiliation settings"}</Button>
          <Button type="button" variant="outline" disabled={!dirty} onClick={() => { setConfig({ ...DEFAULT_CONFIG, ...snapshot.config }); setError(""); setMessage(""); }}>Cancel form settings edits</Button>
          <Button type="button" variant="outline" onClick={async () => {
            if (dirty && !window.confirm("Reload saved form affiliation settings? This discards your unsaved form routing edits only.")) return;
            const result = await query.refetch();
            if (result.data && !result.error) { accept(result.data); setError(""); setMessage(""); }
          }}>Reload saved form settings</Button>
        </div>
      </fieldset>}
    </CardContent>
  </Card>;
}
