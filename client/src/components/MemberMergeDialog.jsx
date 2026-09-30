import { useEffect, useMemo, useState } from "react";
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
  return str.length > 80 ? `${str.slice(0, 80)}…` : str;
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === "" || value === "[]";
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
  const [selectedCore, setSelectedCore] = useState([]);
  const [selectedCustom, setSelectedCustom] = useState([]);
  const [includeEngagement, setIncludeEngagement] = useState(false);
  const [sourceDisposal, setSourceDisposal] = useState("reassign");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const sourceId = direction === "into-current" ? otherMember?.id : currentMember?.id;
  const targetId = direction === "into-current" ? currentMember?.id : otherMember?.id;

  const orgName = (orgId) => organizations.find((o) => o.id === orgId)?.name || (orgId ? "Unknown organisation" : "—");

  useEffect(() => {
    if (!open) {
      setStep(1); setSearch(""); setOtherMember(null); setDirection("into-current");
      setSelectedCore([]); setSelectedCustom([]); setIncludeEngagement(false);
      setSourceDisposal("reassign"); setPreview(null);
    }
  }, [open]);

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

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const data = await apiPost({ action: "preview", sourceId, targetId });
      setPreview(data);
      // Default disposal: full merge when same org, keep-as-deleted question when different.
      setSourceDisposal(data.sameOrganisation ? "reassign" : "anonymise");
      setStep(2);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const mergeMutation = useMutation({
    mutationFn: () => apiPost({
      action: "execute",
      sourceId,
      targetId,
      coreFields: selectedCore,
      customFieldIds: selectedCustom,
      includeEngagement,
      sourceDisposal,
    }),
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
        key: field,
        label: CORE_FIELD_LABELS[field] || field,
        sourceValue: displaySv,
        targetValue: displayTv,
        deEmphasised: isEmptyValue(sv) || sv === tv,
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
        key: f.id,
        label: f.label || f.name || "Custom field",
        sourceValue: formatValue(sv),
        targetValue: formatValue(tv),
        deEmphasised: isEmptyValue(sv) || sv === tv,
      };
    });
  }, [preview, customFields]);

  const toggle = (list, setList, key) =>
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const sameOrg = preview?.sameOrganisation;
  const eng = preview?.sourceEngagement;

  const renderComparisonRow = (row, checked, onToggle, testPrefix) => (
    <div
      key={row.key}
      className={`grid grid-cols-[24px_1fr_1fr_1fr] items-center gap-2 px-2 py-1.5 rounded text-sm ${row.deEmphasised ? "opacity-50" : ""} ${checked ? "bg-blue-50" : ""}`}
      data-testid={`${testPrefix}-${row.key}`}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} data-testid={`checkbox-${testPrefix}-${row.key}`} />
      <span className="font-medium text-slate-700 truncate">{row.label}</span>
      <span className="truncate" title={row.sourceValue}>{row.sourceValue}</span>
      <span className="truncate text-slate-600" title={row.targetValue}>{row.targetValue}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="w-5 h-5" /> Merge member records
          </DialogTitle>
          <DialogDescription>
            {step === 1 && "Select the other member record involved and which record to keep."}
            {step === 2 && "Choose which values to copy from the old (source) record onto the record you're keeping."}
            {step === 3 && "Engagement statistics and what happens to the old record."}
            {step === 4 && "Review and confirm the merge."}
          </DialogDescription>
        </DialogHeader>

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
                  onClick={() => setOtherMember(m)}
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
            {otherMember && (
              <div className="space-y-2">
                <Label>Which record should be kept?</Label>
                <RadioGroup value={direction} onValueChange={setDirection}>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="into-current" id="merge-dir-current" data-testid="radio-keep-current" />
                    <Label htmlFor="merge-dir-current" className="font-normal cursor-pointer">
                      Keep <strong>{`${currentMember?.first_name || ""} ${currentMember?.last_name || ""}`.trim() || currentMember?.email}</strong> (this record) — merge the other record into it
                    </Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="into-other" id="merge-dir-other" data-testid="radio-keep-other" />
                    <Label htmlFor="merge-dir-other" className="font-normal cursor-pointer">
                      Keep <strong>{`${otherMember.first_name || ""} ${otherMember.last_name || ""}`.trim() || otherMember.email}</strong> — merge this record into it
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            )}
          </div>
        )}

        {step === 2 && preview && (
          <div className="space-y-4">
            <div className="grid grid-cols-[24px_1fr_1fr_1fr] gap-2 px-2 text-xs font-semibold text-slate-500 uppercase">
              <span />
              <span>Field</span>
              <span className="flex items-center gap-1">Source (old) <ArrowRight className="w-3 h-3" /></span>
              <span>Target (kept)</span>
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-800 mb-1 px-2">Profile fields</div>
              {coreRows.map((row) => renderComparisonRow(row, selectedCore.includes(row.key), () => toggle(selectedCore, setSelectedCore, row.key), "merge-core"))}
            </div>
            {customRows.length > 0 && (
              <div>
                <div className="text-sm font-semibold text-slate-800 mb-1 px-2">Custom fields</div>
                {customRows.map((row) => renderComparisonRow(row, selectedCustom.includes(row.key), () => toggle(selectedCustom, setSelectedCustom, row.key), "merge-custom"))}
              </div>
            )}
            <p className="text-xs text-slate-500">Tick a field to copy the source value onto the kept record. Faded rows are identical or empty on the source.</p>
          </div>
        )}

        {step === 3 && preview && (
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

        {step === 4 && preview && (
          <div className="space-y-3 text-sm">
            <div className="rounded border border-slate-200 p-3 space-y-2">
              <div>
                <span className="text-slate-500">Merging:</span>{" "}
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

        <DialogFooter className="gap-2">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={mergeMutation.isPending} data-testid="button-merge-back">
              Back
            </Button>
          )}
          {step === 1 && (
            <Button onClick={loadPreview} disabled={!otherMember || previewLoading} data-testid="button-merge-next-1">
              {previewLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Next
            </Button>
          )}
          {(step === 2 || step === 3) && (
            <Button onClick={() => setStep(step + 1)} data-testid={`button-merge-next-${step}`}>Next</Button>
          )}
          {step === 4 && (
            <Button
              variant="destructive"
              onClick={() => mergeMutation.mutate()}
              disabled={mergeMutation.isPending}
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
