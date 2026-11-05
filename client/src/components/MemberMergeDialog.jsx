import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Search, ArrowRight, AlertTriangle, GitMerge } from "lucide-react";
import { toast } from "sonner";
import { isDeletedMember } from "@/utils";
import MemberMergeComparison from "./MemberMergeComparison";

const CORE_FIELD_LABELS = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  mobile: "Mobile",
  landline: "Landline",
  job_title: "Job title",
  biography: "Biography",
  profile_photo_url: "Profile photo",
  linkedin_url: "LinkedIn",
  twitter_url: "Twitter / X",
  show_in_directory: "Show in directory",
  organization_id: "Organisation",
};

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const str = String(value);
  // Multi-select custom values are stored as JSON arrays.
  if (str.startsWith("[")) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr.join(", ");
    } catch { /* fall through */ }
  }
  return str;
}

async function apiPost(body) {
  const res = await fetch("/api/admin/members/merge", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/**
 * Admin "Merge member" flow.
 * Props:
 * - open / onOpenChange
 * - currentMember: the member whose page the dialog was opened from
 * - customFields: preference field definitions (entity_scope 'member')
 * - organizations: org list for name labels
 * - onMerged(result, { sourceId, targetId }): called after a successful merge
 */
export default function MemberMergeDialog({ open, onOpenChange, currentMember, customFields = [], organizations = [], onMerged }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [search, setSearch] = useState("");
  const [otherMember, setOtherMember] = useState(null);
  // direction: 'into-current' => current member is the TARGET (kept), other is source
  const [direction, setDirection] = useState("into-current");
  // Explicit choices belong to member identities, not source/target roles.
  const [choices, setChoices] = useState({});
  const [includeEngagement, setIncludeEngagement] = useState(false);
  const [sourceDisposal, setSourceDisposal] = useState("reassign");
  const [previewRequested, setPreviewRequested] = useState(false);
  const disposalDefaultDirection = useRef(null);

  const sourceId = direction === "into-current" ? otherMember?.id : currentMember?.id;
  const targetId = direction === "into-current" ? currentMember?.id : otherMember?.id;

  const orgName = (orgId) => organizations.find((o) => o.id === orgId)?.name || (orgId ? "Unknown organisation" : "—");

  useEffect(() => {
      disposalDefaultDirection.current = null;
      setStep(1); setSearch(""); setOtherMember(null); setDirection("into-current");
      setChoices({}); setIncludeEngagement(false);
      setSourceDisposal("reassign"); setPreviewRequested(false);
  }, [open, currentMember?.id]);

  const { data: searchResults = [], isFetching: searching } = useQuery({
    queryKey: ["member-merge-search", search],
    enabled: open && search.trim().length >= 2,
    queryFn: async () => {
      const res = await fetch(`/api/admin/members/paginated?search=${encodeURIComponent(search.trim())}&limit=10`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const rows = data.members || data.data || [];
      return rows.filter((m) => m.id !== currentMember?.id && !isDeletedMember(m));
    },
  });

  const { data: preview, isFetching: previewLoading, error: previewError, refetch: retryPreview } = useQuery({
    queryKey: ["member-merge-preview", sourceId, targetId],
    enabled: open && previewRequested && !!sourceId && !!targetId,
    queryFn: () => apiPost({ action: "preview", sourceId, targetId }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const previewReady = previewRequested && !previewLoading && !previewError
    && preview?.source?.id === sourceId && preview?.target?.id === targetId;

  useEffect(() => {
    const directionKey = JSON.stringify([sourceId, targetId]);
    // A refresh may suspend readiness, but must never replace the admin's
    // disposal decision. Defaults belong only to a new pair/direction.
    if (previewReady && disposalDefaultDirection.current !== directionKey) {
      disposalDefaultDirection.current = directionKey;
      setSourceDisposal(preview.sameOrganisation ? "reassign" : "anonymise");
    }
  }, [sourceId, targetId, previewReady, preview?.sameOrganisation]);

  const chooseOther = (member) => {
    if (member.id !== otherMember?.id) {
      disposalDefaultDirection.current = null;
      setChoices({});
      setPreviewRequested(false);
      setIncludeEngagement(false);
      setDirection("into-current");
    }
    setOtherMember(member);
  };
  const selectedCore = (preview?.copyableCoreFields || []).filter(key => choices[`core:${key}`] === sourceId);
  const selectedCustom = customFields.filter(field => choices[`custom:${field.id}`] === sourceId).map(field => field.id);

  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!previewReady) throw new Error("Refresh the merge preview before continuing.");
      return apiPost({
      action: "execute",
      sourceId,
      targetId,
      coreFields: selectedCore,
      customFieldIds: selectedCustom,
      includeEngagement,
      sourceDisposal,
      });
    },
    onSuccess: (result) => {
      toast.success("Members merged successfully");
      (result.warnings || []).forEach((w) => toast.warning(w));
      queryClient.invalidateQueries({ queryKey: ["member"] });
      queryClient.invalidateQueries({ queryKey: ["members"] });
      queryClient.invalidateQueries({ queryKey: ["member-pref-values"] });
      queryClient.invalidateQueries({ queryKey: ["member-notes"] });
      onOpenChange(false);
      onMerged?.(result, { sourceId, targetId });
    },
    onError: (err) => toast.error(err.message || "Merge failed"),
  });

  const source = preview?.source;
  const target = preview?.target;

  const coreRows = useMemo(() => {
    if (!preview) return [];
    return (preview.copyableCoreFields || []).map((field) => {
      const sv = source?.[field];
      const tv = target?.[field];
      const displaySv = field === "organization_id" ? orgName(sv) : formatValue(sv);
      const displayTv = field === "organization_id" ? orgName(tv) : formatValue(tv);
      return {
        key: `core:${field}`,
        section: "Profile fields",
        label: CORE_FIELD_LABELS[field] || field,
        values: { [source.id]: displaySv, [target.id]: displayTv },
      };
    });
  }, [preview, organizations]);

  const customRows = useMemo(() => {
    if (!preview) return [];
    const srcMap = Object.fromEntries((preview.sourcePreferenceValues || []).map((v) => [v.field_id, v.value]));
    const tgtMap = Object.fromEntries((preview.targetPreferenceValues || []).map((v) => [v.field_id, v.value]));
    return customFields.map((f) => {
      const sv = srcMap[f.id];
      const tv = tgtMap[f.id];
      return {
        key: `custom:${f.id}`,
        section: "Custom fields",
        label: f.label || f.name || "Custom field",
        values: { [source.id]: formatValue(sv), [target.id]: formatValue(tv) },
      };
    });
  }, [preview, customFields]);

  const sameOrg = preview?.sameOrganisation;
  const eng = preview?.sourceEngagement;
  const memberClassField = customFields.find(f => f.name === "member_class")
    || customFields.find(f => String(f.label || "").trim().toLowerCase() === "member class");
  // Header context always describes the original records, not the selected
  // merge values or whichever record is currently marked as the survivor.
  const memberClasses = preview && memberClassField ? Object.fromEntries([
    [source.id, preview.sourcePreferenceValues],
    [target.id, preview.targetPreferenceValues],
  ].map(([id, values]) => {
    const value = values?.find(v => v.field_id === memberClassField.id)?.value;
    return [id, value == null || value === "" ? "Not set" : formatValue(value)];
  })) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-2xl max-h-[85dvh] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="w-5 h-5" /> Merge member records
          </DialogTitle>
          <DialogDescription>
            {step === 1 && "Find and select the other member record to merge."}
            {step === 2 && "Choose the record to keep, then select one value for each field. Yellow marks the kept record; green marks selected values."}
            {step === 3 && "Engagement statistics and what happens to the old record."}
            {step === 4 && "Review and confirm the merge."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain" data-testid="merge-scroll-body">
        {step === 1 && (
          <div className="space-y-4">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Search members by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-merge-search"
              />
            </div>
            {searching && <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Searching…</div>}
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {searchResults.map((m) => (
                <button
                  key={m.id}
                  type="button"
                   onClick={() => chooseOther(m)}
                  className={`w-full text-left px-3 py-2 rounded border text-sm ${otherMember?.id === m.id ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}
                  data-testid={`merge-candidate-${m.id}`}
                >
                  <div className="font-medium">{`${m.first_name || ""} ${m.last_name || ""}`.trim() || m.email}</div>
                  <div className="text-slate-500">{m.email}{m.organization_id ? ` • ${orgName(m.organization_id)}` : ""}</div>
                </button>
              ))}
              {search.trim().length >= 2 && !searching && searchResults.length === 0 && (
                <div className="text-sm text-slate-500 px-1">No matching members found.</div>
              )}
            </div>
          </div>
        )}

        {step > 1 && !previewReady && (
          <div role={previewError ? "alert" : "status"} className="p-3 text-sm">
            {previewError ? <>{previewError.message} <Button variant="outline" onClick={() => retryPreview()}>Retry preview</Button></> : "Loading record comparison…"}
          </div>
        )}
        {step === 2 && (
          <MemberMergeComparison
            members={[currentMember, otherMember].filter(Boolean).map(m => [source, target].find(record => record?.id === m.id) || m)}
            targetId={targetId}
            onTargetChange={id => setDirection(id === currentMember.id ? "into-current" : "into-other")}
            rows={previewReady ? [...coreRows, ...customRows] : []}
            choices={choices}
            memberClasses={memberClasses}
            onChoose={(key, id) => setChoices(previous => ({ ...previous, [key]: id }))}
            disabled={!previewReady}
          />
        )}

        {step === 3 && previewReady && (
          <div className="space-y-5">
            <div className="flex items-start gap-2">
              <Checkbox
                id="merge-engagement"
                checked={includeEngagement}
                onCheckedChange={(v) => setIncludeEngagement(!!v)}
                data-testid="checkbox-merge-engagement"
              />
              <div>
                <Label htmlFor="merge-engagement" className="cursor-pointer">Include engagement statistics</Label>
                <p className="text-sm text-slate-500 mt-1">
                  Folds the source's engagement totals into the kept record's opening balances so its engagement score reflects the person's full history.
                  {eng && (
                    <span className="block mt-1">
                      Source totals: {eng.eventsAttended} events, {eng.articlesPublished} articles, {eng.jobsPosted} jobs, {eng.awards} awards, {eng.engagementAwards} engagement awards.
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>What happens to the source (old) record?</Label>
              <Alert>
                <AlertTriangle className="w-4 h-4" />
                <AlertDescription>
                  Removing or anonymising the source does not cancel Stripe or GoCardless payments.
                  Unresolved recurring agreements block these options. Resolve billing separately with
                  explicit cancellation authority, or leave the source untouched. Financial history is retained.
                </AlertDescription>
              </Alert>
              {!sameOrg && (
                <Alert>
                  <AlertTriangle className="w-4 h-4" />
                  <AlertDescription>
                    The two records belong to <strong>different organisations</strong> ({orgName(source?.organization_id)} vs {orgName(target?.organization_id)}).
                    Keeping the source as an anonymised deleted member preserves its organisation's engagement history; a full merge moves that history to the kept record's organisation.
                  </AlertDescription>
                </Alert>
              )}
              <RadioGroup value={sourceDisposal} onValueChange={setSourceDisposal}>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="reassign" id="disposal-reassign" data-testid="radio-disposal-reassign" />
                  <Label htmlFor="disposal-reassign" className="font-normal cursor-pointer">
                    <strong>Full merge</strong> — reassign all history (bookings, group roles, submissions, messages…) to the kept record, then remove the source record.
                    {!sameOrg && " The source organisation loses this history."}
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="anonymise" id="disposal-anonymise" data-testid="radio-disposal-anonymise" />
                  <Label htmlFor="disposal-anonymise" className="font-normal cursor-pointer">
                    <strong>Keep as anonymised deleted member</strong> — the source is anonymised via the normal deletion flow; its history stays with {orgName(source?.organization_id)}.
                    {!sameOrg && " Recommended when the organisations differ."}
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="keep" id="disposal-keep" data-testid="radio-disposal-keep" />
                  <Label htmlFor="disposal-keep" className="font-normal cursor-pointer">
                    <strong>Leave the source untouched</strong> — copy-only merge; both records remain.
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>
        )}

        {step === 4 && previewReady && (
          <div className="space-y-3 text-sm">
            <div className="rounded border border-slate-200 p-3 space-y-2">
              <div>
                <span className="text-slate-500">Merging source into kept record:</span>{" "}
                <strong>{`${source?.first_name || ""} ${source?.last_name || ""}`.trim() || source?.email}</strong> ({source?.email})
                {" "}<ArrowRight className="w-3 h-3 inline" />{" "}
                <strong>{`${target?.first_name || ""} ${target?.last_name || ""}`.trim() || target?.email}</strong> ({target?.email})
              </div>
              <div>
                <span className="text-slate-500">Fields copied:</span>{" "}
                {selectedCore.length === 0 && selectedCustom.length === 0
                  ? "none"
                  : [
                      ...selectedCore.map((f) => CORE_FIELD_LABELS[f] || f),
                      ...selectedCustom.map((id) => { const f = customFields.find((cf) => cf.id === id); return f?.label || f?.name || "custom field"; }),
                    ].join(", ")}
              </div>
              <div>
                <span className="text-slate-500">Engagement statistics:</span>{" "}
                {includeEngagement ? "copied to the kept record's opening balances" : "not copied"}
              </div>
              <div>
                <span className="text-slate-500">Source record:</span>{" "}
                {sourceDisposal === "reassign" && <Badge variant="destructive">Full merge — history reassigned, source removed</Badge>}
                {sourceDisposal === "anonymise" && <Badge variant="secondary">Kept as anonymised deleted member</Badge>}
                {sourceDisposal === "keep" && <Badge variant="outline">Left untouched</Badge>}
              </div>
            </div>
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>This cannot be undone. Please double-check the details above.</AlertDescription>
            </Alert>
          </div>
        )}

        </div>
        <DialogFooter className="shrink-0 gap-2">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={mergeMutation.isPending} data-testid="button-merge-back">
              Back
            </Button>
          )}
          {step === 1 && (
            <Button onClick={() => { setPreviewRequested(true); setStep(2); }} disabled={!otherMember} data-testid="button-merge-next-1">
              {previewLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Next
            </Button>
          )}
          {(step === 2 || step === 3) && (
            <Button onClick={() => setStep(step + 1)} disabled={!previewReady} data-testid={`button-merge-next-${step}`}>Next</Button>
          )}
          {step === 4 && (
            <Button
              variant="destructive"
              onClick={() => mergeMutation.mutate()}
              disabled={mergeMutation.isPending || !previewReady}
              data-testid="button-merge-confirm"
            >
              {mergeMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <GitMerge className="w-4 h-4 mr-1" />}
              Merge members
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
