import React, { useEffect, useId, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import { loadAffiliationConfig, saveAffiliationConfig, loadAffiliationDiscovery } from "./memberAffiliationApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isRepeatableRowField, repeatableRowChildren } from "../../../../shared/formRepeatableRows.js";
import { relationshipEndpointDescriptor } from "@/lib/structuredRelationshipActions";

export const emptyAffiliationConfig = () => ({
  version: 1,
  enabled: false,
  primaryOrganizationFieldIds: [],
  primaryDepartmentsFieldId: null,
  memberDepartmentDefinitionId: null,
  departmentOrganizationDefinitionId: null,
  additionalSitesFieldId: null,
  secondaryOrganizationFieldId: null,
  secondaryDepartmentsFieldId: null,
  secondaryObjectId: null,
  secondaryMemberDefinitionId: null,
  secondaryOrganizationDefinitionId: null,
  secondaryLabelFieldId: null,
  dueDiligenceReviewFormId: null,
});

const organizationField = field => ["organisation_dropdown", "organization_dropdown"].includes(field.type);
const option = field => ({ value: String(field.id), label: field.label || field.name || field.singular_label || field.object_key || "Unnamed field" });

export function affiliationRelationshipOptions(definitions, kind, objectId) {
  return definitions.filter(definition => {
    if (definition.status && definition.status !== "active") return false;
    const endpoints = ["source", "target"].map(side => relationshipEndpointDescriptor(definition, side));
    return endpoints.some(endpoint => endpoint?.kind === kind)
      && endpoints.some(endpoint => endpoint?.kind === "custom_object"
        && (!objectId || String(endpoint.customObjectId) === String(objectId)));
  }).map(definition => ({
    value: String(definition.id),
    label: definition.name || definition.label || definition.source_label || definition.relationship_key || "Unnamed relationship",
  }));
}

export function departmentOrganizationRelationshipOptions(definitions, memberDefinitionId) {
  if (!memberDefinitionId || !affiliationRelationshipOptions(definitions, "member")
    .some(item => item.value === String(memberDefinitionId))) return [];
  const definition = definitions.find(item => String(item.id) === String(memberDefinitionId));
  const department = ["source", "target"]
    .map(side => relationshipEndpointDescriptor(definition, side))
    .find(endpoint => endpoint?.kind === "custom_object");
  return department?.customObjectId
    ? affiliationRelationshipOptions(definitions, "organization", department.customObjectId) : [];
}

function MappingSelect({ id, label, value, options, onChange, help }) {
  const unavailable = value && !options.some(item => item.value === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Select value={value || "__none__"} onValueChange={next => onChange(next === "__none__" ? null : next)}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Not configured</SelectItem>
          {unavailable && <SelectItem value={value}>Unavailable selection — review mapping</SelectItem>}
          {options.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {unavailable && <p className="text-xs text-amber-700">The saved selection is not available. It has not been removed.</p>}
      {help && <p className="text-xs text-slate-500">{help}</p>}
    </div>
  );
}

// Reset drafts at form/session boundaries; never carry configuration between tenants.
export default function MemberAffiliationSettings(props) {
  if (!props.formId) return null;
  return (
    <Card className="mt-6 border-slate-200" data-testid="member-affiliation-settings">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Building2 className="h-5 w-5 text-blue-600" aria-hidden="true" />
          Member affiliation settings
        </CardTitle>
        <p className="text-sm text-muted-foreground">Map self-service renewal affiliations. Saved separately from the form.</p>
      </CardHeader>
      <CardContent>
        {props.tenantContext?.status === "ready"
          ? <AffiliationSession key={`${props.formId}:${props.tenantContext.scopeKey}`} {...props} />
          : <p role="status" className="text-sm text-muted-foreground">
            {props.tenantContext?.status === "loading" ? "Verifying settings access…" : "Your session could not be verified. Reload before configuring affiliations."}
          </p>}
      </CardContent>
    </Card>
  );
}

function AffiliationSession({
  formId, tenantContext, persistedForm, metadata: providedMetadata,
  metadataLoading, metadataError, onRetryMetadata,
}) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [discovery, setDiscovery] = useState({ loading: !providedMetadata, data: null, error: null });
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [reviewFormName, setReviewFormName] = useState("");
  const active = useRef(false);
  const contextRef = useRef(tenantContext);
  contextRef.current = tenantContext;
  const busy = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const context = contextRef.current;
    setLoading(true);
    setError("");
    async function load() {
      try {
        context.assertCurrent();
        const data = await loadAffiliationConfig(formId, { signal: controller.signal, context });
        if (!Object.prototype.hasOwnProperty.call(data, "config")) throw new Error("Unexpected settings response. Retry loading.");
        if (controller.signal.aborted) return;
        const config = { ...emptyAffiliationConfig(), ...data.config };
        setDraft(config);
        setSaved(config);
        setReviewFormName(data.reviewForm?.name || "");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message || "Unable to load settings.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [formId, reload]);

  useEffect(() => {
    if (providedMetadata) return undefined;
    const controller = new AbortController();
    setDiscovery({ loading: true, data: null, error: null });
    loadAffiliationDiscovery(formId, { context: contextRef.current, signal: controller.signal })
      .then(data => {
        if (!Array.isArray(data.objects) || !Array.isArray(data.relationships)
          || !data.fields || typeof data.fields !== "object" || data.complete !== true) {
          throw new Error("Discovery is incomplete. Retry before saving these mappings.");
        }
        if (!controller.signal.aborted) setDiscovery({ loading: false, data, error: null });
      }).catch(error => {
        if (!controller.signal.aborted) setDiscovery({ loading: false, data: null, error });
      });
    return () => controller.abort();
  }, [formId, providedMetadata, discoveryAttempt]);
  const metadata = providedMetadata || discovery.data || { objects: [], fields: {}, relationships: [] };
  const discoveryError = metadataError || discovery.error;
  const discovering = metadataLoading || (!providedMetadata && discovery.loading);
  const ownerAccess = persistedForm?.require_authentication === true
    && persistedForm?.mutation_access_policy?.mode === "authenticated_owner";
  const fields = persistedForm?.fields || [];
  const organizations = fields.filter(organizationField);
  const relationships = fields.filter(field => field.type === "relationship_dropdown");
  const repeatables = fields.filter(isRepeatableRowField);
  const children = repeatableRowChildren(repeatables.find(field => field.id === draft?.additionalSitesFieldId));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const discoveryUnavailable = discovering || Boolean(discoveryError);
  const departmentOrganizationOptions = departmentOrganizationRelationshipOptions(
    metadata.relationships, draft?.memberDepartmentDefinitionId);
  const departmentMappingInvalid = Boolean(draft?.memberDepartmentDefinitionId)
    && !departmentOrganizationOptions.some(item => item.value === draft?.departmentOrganizationDefinitionId);
  const edit = patch => {
    setDraft(current => ({ ...current, ...patch }));
    setMessage("");
  };
  const select = (key, label, options, help) => (
    <MappingSelect id={`${id}-${key}`} key={key} label={label} value={draft[key]}
      options={options} help={help} onChange={value => edit({ [key]: value })} />
  );

  async function save() {
    if (busy.current || departmentMappingInvalid) return;
    busy.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    const context = contextRef.current;
    const config = { ...draft, version: 1 };
    try {
      context.assertCurrent();
      const data = await saveAffiliationConfig(formId, config, { context });
      if (!active.current) return;
      if (!data.config || typeof data.config !== "object") throw new Error("Saved settings were not confirmed. Retry loading before continuing.");
      setSaved(data.config);
      setDraft(data.config);
      setReviewFormName(data.reviewForm?.name || "");
      setMessage("Affiliation settings saved. No member data was changed.");
    } catch (failure) {
      if (active.current) setError(failure.message || "Unable to save settings. Your choices have been kept.");
    } finally {
      busy.current = false;
      if (active.current) setSaving(false);
    }
  }

  if (loading) return <div role="status" aria-label="Loading affiliation settings" className="space-y-3">
    <div className="h-5 w-2/3 rounded bg-slate-100" /><div className="h-16 rounded bg-slate-100" />
  </div>;
  if (!draft) return <div role="alert" className="space-y-3 text-sm">
    <p>{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>Retry loading settings</Button>
  </div>;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-slate-700">
        Existing join forms remain add-only unless affiliation renewal is explicitly enabled.
        Renewal can replace the member’s configured affiliations, including removing links no longer selected.
        Saving these settings does not change member data or publish this form.
      </div>
      <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <p className="font-medium">Review new organisation and department names</p>
        <p>Not-listed names are saved for Due Diligence review, not automatically created.
          Existing affiliations stay unchanged while renewal and normal payment checks continue.</p>
        <p className="text-xs text-slate-500">On first enable, saving creates a dedicated affiliation-only review workflow.
          It does not modify this form’s existing Due Diligence configuration or run join actions.</p>
        {draft.dueDiligenceReviewFormId && <p className="text-xs">
          Dedicated review form: {reviewFormName || "Affiliation review"}
        </p>}
      </div>
      {!ownerAccess && <p className="text-sm text-amber-800">
        Enabling requires saved authentication and the “Logged-in record owner” access policy in Submission settings.
        Login alone is not sufficient. Save the form first, then return here.
      </p>}
      {draft.version !== 1 && <p role="alert" className="text-sm text-amber-800">This configuration uses an unsupported version. Do not overwrite it with this editor.</p>}
      <fieldset disabled={saving || draft.version !== 1} className="space-y-5">
        <div className="flex items-start gap-3">
          <Switch id={`${id}-enabled`} checked={draft.enabled} disabled={!ownerAccess && !draft.enabled}
            onCheckedChange={enabled => edit({ enabled })} />
          <div className="space-y-1">
            <Label htmlFor={`${id}-enabled`}>Enable self-service affiliation renewal</Label>
            <p className="text-xs text-slate-500">Turning this off retains the mappings below. Changes take effect only after saving these settings.</p>
          </div>
        </div>
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-slate-800">Primary organisation and departments</h4>
          <p className="text-xs text-slate-500">Options use saved form fields only. Save new or edited fields in the builder before mapping them here.</p>
          <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium">Primary organisation fields</legend>
            {organizations.length === 0 && <p className="text-xs text-slate-500">No organisation dropdowns in the saved form.</p>}
            {organizations.map(field => (
              <div key={field.id} className="flex items-center gap-2">
                <Checkbox id={`${id}-org-${field.id}`} checked={draft.primaryOrganizationFieldIds.includes(field.id)}
                  onCheckedChange={checked => edit({ primaryOrganizationFieldIds: checked === true
                    ? [...draft.primaryOrganizationFieldIds, field.id]
                    : draft.primaryOrganizationFieldIds.filter(value => value !== field.id) })} />
                <Label htmlFor={`${id}-org-${field.id}`} className="text-sm font-normal">{field.label || "Unnamed organisation field"}</Label>
              </div>
            ))}
            {draft.primaryOrganizationFieldIds.filter(value => !organizations.some(field => field.id === value)).map(value => (
              <div key={value} className="flex flex-wrap items-center justify-between gap-2 text-xs text-amber-800">
                <span>Unavailable organisation field — selection retained</span>
                <Button type="button" variant="outline" size="sm" onClick={() => edit({
                  primaryOrganizationFieldIds: draft.primaryOrganizationFieldIds.filter(item => item !== value),
                })}>Remove unavailable mapping</Button>
              </div>
            ))}
          </fieldset>
          <div className="grid gap-4 md:grid-cols-2">
            {select("primaryDepartmentsFieldId", "Primary departments field", relationships.map(option))}
            {select("memberDepartmentDefinitionId", "Member–department relationship",
              affiliationRelationshipOptions(metadata.relationships, "member"))}
            {select("departmentOrganizationDefinitionId", "Organisation–department relationship",
              departmentOrganizationOptions,
              "Required when a member–department relationship is configured. Choose the direct active relationship from an organisation to the same department custom object. Existing mappings are retained when you change the member relationship.")}
          </div>
          {departmentMappingInvalid && !discoveryUnavailable && <p role="alert" className="text-sm text-amber-800">
            Select an active organisation–department relationship for the selected member relationship’s department object before saving.
          </p>}
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <h4 className="text-sm font-medium text-slate-800">Additional sites (optional)</h4>
          <p className="text-xs text-slate-500">Choose the repeatable field, then its organisation and department children. Existing child mappings are retained if you change the repeatable field; review them before saving.</p>
          {select("additionalSitesFieldId", "Additional sites repeatable field", repeatables.map(option))}
          <div className="grid gap-4 md:grid-cols-2">
            {select("secondaryOrganizationFieldId", "Site organisation child", children.filter(organizationField).map(option))}
            {select("secondaryDepartmentsFieldId", "Site departments child", children.filter(field => field.type === "relationship_dropdown").map(option))}
            {select("secondaryObjectId", "Additional-site custom object", metadata.objects.map(option))}
            {select("secondaryLabelFieldId", "Custom object label field", (metadata.fields[draft.secondaryObjectId] || []).map(option))}
            {select("secondaryMemberDefinitionId", "Site–member relationship",
              draft.secondaryObjectId ? affiliationRelationshipOptions(metadata.relationships, "member", draft.secondaryObjectId) : [])}
            {select("secondaryOrganizationDefinitionId", "Site–organisation relationship",
              draft.secondaryObjectId ? affiliationRelationshipOptions(metadata.relationships, "organization", draft.secondaryObjectId) : [])}
          </div>
        </div>
      </fieldset>
      {discoveryUnavailable && <div role="status" className="space-y-2 text-sm text-amber-800">
        <p>{discovering ? "Loading custom objects and relationships…" : "Custom object discovery failed. Existing selections are retained; saving is paused."}</p>
        {discoveryError && <Button type="button" variant="outline" onClick={() => providedMetadata
          ? onRetryMetadata?.() : setDiscoveryAttempt(value => value + 1)}>Retry discovery</Button>}
      </div>}
      {error && <p role="alert" className="text-sm text-red-700">{error} Your choices have been kept.</p>}
      {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <Button type="button" onClick={save} disabled={saving || !dirty || draft.version !== 1
          || departmentMappingInvalid
          || (draft.enabled && (!ownerAccess || discoveryUnavailable))}>
          {saving ? "Saving settings…" : "Save affiliation settings"}
        </Button>
        <Button type="button" variant="outline" disabled={saving || !dirty} onClick={() => {
          setDraft(saved); setError(""); setMessage("Unsaved affiliation changes discarded.");
        }}>Discard changes</Button>
        {dirty && <span className="text-xs text-slate-500">Unsaved affiliation changes</span>}
      </div>
    </div>
  );
}
