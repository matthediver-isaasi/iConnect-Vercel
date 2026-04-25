import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import {
  Loader2, Plus, RefreshCw, Save, Trash2, AlertTriangle, CheckCircle2, XCircle, Eye,
  Copy, KeyRound, ArrowDown, ArrowUp, ArrowUpDown, Link2, Download, Shuffle
} from "lucide-react";

const ENTITY_OPTIONS = [
  { value: "member", label: "Members" },
  { value: "organization", label: "Organisations" }
];

const DEFAULT_UNIQUE_KEY = {
  Contacts: "Email",
  Leads: "Email",
  Accounts: "Account_Name"
};

const SYNC_DIRECTIONS = [
  { value: "outbound", label: "Outbound only (iConnect → Zoho)" },
  { value: "inbound", label: "Inbound only (Zoho → iConnect)" },
  { value: "bidirectional", label: "Bidirectional" }
];

const CONFLICT_POLICIES = [
  { value: "last_write_wins", label: "Last write wins (compare timestamps)" },
  { value: "zoho_wins", label: "Zoho always wins" },
  { value: "iconnect_wins", label: "iConnect always wins" }
];

const UNMATCHED_POLICIES = [
  { value: "ignore", label: "Ignore (log and skip)" },
  { value: "create", label: "Create new iConnect record" },
  { value: "queue", label: "Queue for admin review" }
];

function directionBadge(d) {
  if (d === "inbound") return <Badge variant="secondary"><ArrowDown className="h-3 w-3 mr-1" />inbound</Badge>;
  if (d === "outbound") return <Badge variant="secondary"><ArrowUp className="h-3 w-3 mr-1" />outbound</Badge>;
  return <Badge variant="outline"><ArrowUpDown className="h-3 w-3 mr-1" />{d || "—"}</Badge>;
}

function emptyMappingRow() {
  return { iconnect_field: "", zoho_field: "", iconnect_field_type: "", zoho_field_label: "" };
}

// Allowed values for an iConnect field option (core or custom). Returns
// `[{ label, value }]` or `null` when the field is free-text / not picklist-like.
function getIconnectAllowedValues(opt) {
  if (!opt) return null;
  const av = opt.allowed_values;
  if (!Array.isArray(av) || av.length === 0) return null;
  return av;
}

// Allowed values for a Zoho field. Returns `[{ label, value }]` or `null`.
function getZohoAllowedValues(field) {
  if (!field) return null;
  if ((field.data_type || "").toLowerCase() === "boolean") {
    return [
      { label: "True", value: "true" },
      { label: "False", value: "false" }
    ];
  }
  const pl = field.pick_list_values;
  if (Array.isArray(pl) && pl.length > 0) {
    return pl
      .map(p => {
        const value = p.actual_value ?? p.display_value;
        const label = p.display_value ?? p.actual_value;
        if (value == null || value === "") return null;
        return { label: String(label), value: String(value) };
      })
      .filter(Boolean);
  }
  return null;
}

function formatDiffValue(v) {
  if (v === null || v === undefined) return <span className="text-muted-foreground italic">empty</span>;
  if (typeof v === 'object') return <code className="text-xs">{JSON.stringify(v)}</code>;
  if (v === '') return <span className="text-muted-foreground italic">empty</span>;
  return <span>{String(v)}</span>;
}

const OUTCOME_BADGE_VARIANT = {
  created: 'default',
  updated: 'default',
  no_change: 'secondary',
  ambiguous: 'destructive',
  no_mapped_values: 'secondary',
  failed: 'destructive'
};

const SKIPPED_REASON_LABEL = {
  zoho_empty: 'Zoho value empty',
  iconnect_populated: 'iConnect already populated',
  match: 'Already matches',
  iconnect_to_zoho_backfill: 'iConnect → Zoho backfill'
};

function SingleRecordResult({ result, entityType }) {
  const {
    outcome,
    matched,
    matchedBy,
    diffs = [],
    message,
    dryRun,
    zoho_module,
    skipped_fields = [],
    backfilled_fields = [],
    backfill_failed = null
  } = result || {};
  const outcomeLabel = outcome.replace(/_/g, ' ');
  const [showSkipped, setShowSkipped] = useState(false);
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3" data-testid="panel-single-result">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase text-muted-foreground">{dryRun ? 'Preview' : 'Sync result'}</span>
        <Badge variant={OUTCOME_BADGE_VARIANT[outcome] || 'secondary'} data-testid="badge-single-outcome">{outcomeLabel}</Badge>
        {zoho_module && <span className="text-xs text-muted-foreground">module: <code>{zoho_module}</code></span>}
      </div>
      {matched ? (
        <div className="text-sm" data-testid="text-single-matched">
          <span className="text-muted-foreground">Matched iConnect {entityType}:</span>{' '}
          <code className="text-xs">{matched.id}</code>
          {matched.naturalKey?.value && (
            <span className="text-muted-foreground"> · {matched.naturalKey.field}: <span className="text-foreground">{String(matched.naturalKey.value)}</span></span>
          )}
          {matchedBy && (
            <span className="text-muted-foreground"> · matched by: {matchedBy.replace(/_/g, ' ')}</span>
          )}
        </div>
      ) : outcome === 'created' ? (
        <div className="text-sm text-muted-foreground" data-testid="text-single-matched">
          No existing iConnect {entityType} matched — a new record {dryRun ? 'would be' : 'was'} created.
        </div>
      ) : null}
      {message && (
        <p className="text-xs text-muted-foreground" data-testid="text-single-message">{message}</p>
      )}
      {diffs.length > 0 ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Scope</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Zoho value</TableHead>
                <TableHead>Current iConnect value</TableHead>
                <TableHead>{dryRun ? 'Would write' : 'Wrote'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diffs.map((d, i) => (
                <TableRow key={`${d.scope}-${d.field}-${i}`} data-testid={`row-diff-${d.field}`}>
                  <TableCell><Badge variant="outline" className="text-xs">{d.scope}</Badge></TableCell>
                  <TableCell><code className="text-xs">{d.field}</code></TableCell>
                  <TableCell>{formatDiffValue(d.zohoValue)}</TableCell>
                  <TableCell>{formatDiffValue(d.beforeValue)}</TableCell>
                  <TableCell>{formatDiffValue(d.afterValue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        outcome !== 'ambiguous' && outcome !== 'no_mapped_values' && (
          <p className="text-xs text-muted-foreground">No field changes.</p>
        )
      )}
      {Array.isArray(backfilled_fields) && backfilled_fields.length > 0 && (
        <div className="space-y-2 rounded-md border bg-background p-3" data-testid="panel-backfill-fields">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={backfill_failed ? 'destructive' : 'default'}
              className="text-xs"
              data-testid="badge-backfill-status"
            >
              {dryRun
                ? `Will push to Zoho (${backfilled_fields.length})`
                : backfill_failed
                  ? `Push to Zoho failed (${backfilled_fields.length})`
                  : `Pushed to Zoho (${backfilled_fields.length})`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              iConnect values will fill empty Zoho fields on the matched record.
            </span>
          </div>
          {backfill_failed?.error && (
            <p className="text-xs text-destructive" data-testid="text-backfill-error">
              {backfill_failed.error}
            </p>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>iConnect field</TableHead>
                  <TableHead>Zoho field</TableHead>
                  <TableHead>iConnect value (will be sent)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backfilled_fields.map((b, i) => (
                  <TableRow key={`backfill-${b.zoho_field}-${i}`} data-testid={`row-backfill-${b.zoho_field}`}>
                    <TableCell><code className="text-xs">{b.iconnect_field}</code></TableCell>
                    <TableCell><code className="text-xs">{b.zoho_field}</code></TableCell>
                    <TableCell>{formatDiffValue(b.iconnect_value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {Array.isArray(skipped_fields) && skipped_fields.length > 0 && (
        <Collapsible open={showSkipped} onOpenChange={setShowSkipped}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-2 text-xs"
              data-testid="button-toggle-skipped-fields"
            >
              {showSkipped ? 'Hide' : 'Why no changes?'} ({skipped_fields.length} skipped field{skipped_fields.length === 1 ? '' : 's'})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="overflow-x-auto pt-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>iConnect field</TableHead>
                    <TableHead>Zoho field</TableHead>
                    <TableHead>Zoho value</TableHead>
                    <TableHead>Current iConnect value</TableHead>
                    <TableHead className="w-44">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skipped_fields.map((s, i) => (
                    <TableRow key={`skip-${s.iconnect_field}-${i}`} data-testid={`row-skipped-${s.iconnect_field}`}>
                      <TableCell><code className="text-xs">{s.iconnect_field}</code></TableCell>
                      <TableCell><code className="text-xs">{s.zoho_field}</code></TableCell>
                      <TableCell>{formatDiffValue(s.zoho_value)}</TableCell>
                      <TableCell>{formatDiffValue(s.iconnect_value)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs" data-testid={`badge-skip-reason-${s.iconnect_field}`}>
                          {SKIPPED_REASON_LABEL[s.reason] || s.reason}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function rowHasValueMap(row) {
  const vm = row?.value_map;
  if (!vm || typeof vm !== "object") return false;
  const i2z = vm.iconnect_to_zoho;
  const z2i = vm.zoho_to_iconnect;
  if (i2z && typeof i2z === "object" && Object.keys(i2z).length > 0) return true;
  if (z2i && typeof z2i === "object" && Object.keys(z2i).length > 0) return true;
  return false;
}

// RFC 4180 escape: wrap in double quotes if the value contains a comma,
// double quote, or newline; double up any embedded quotes.
function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells) {
  return cells.map(escapeCsvCell).join(",");
}

// Serialise a row's value_map into a single human-readable cell, e.g.
// `iconnect_to_zoho: a=>x; b=>y | zoho_to_iconnect: x=>a`.
function serializeValueMap(vm) {
  if (!vm || typeof vm !== "object") return "";
  const parts = [];
  const i2z = vm.iconnect_to_zoho;
  if (i2z && typeof i2z === "object") {
    const entries = Object.entries(i2z).filter(([k]) => k !== "");
    if (entries.length > 0) {
      parts.push(`iconnect_to_zoho: ${entries.map(([k, v]) => `${k}=>${v ?? ""}`).join("; ")}`);
    }
  }
  const z2i = vm.zoho_to_iconnect;
  if (z2i && typeof z2i === "object") {
    const entries = Object.entries(z2i).filter(([k]) => k !== "");
    if (entries.length > 0) {
      parts.push(`zoho_to_iconnect: ${entries.map(([k, v]) => `${k}=>${v ?? ""}`).join("; ")}`);
    }
  }
  return parts.join(" | ");
}

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function AdminZohoCrmSync() {
  const { toast } = useToast();

  const [connected, setConnected] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [entityType, setEntityType] = useState("member");
  const [modules, setModules] = useState([]);
  const [zohoFields, setZohoFields] = useState([]);
  const [iconnectFields, setIconnectFields] = useState({ core: [], custom: [] });
  const [mapping, setMapping] = useState(null);
  const [loadingMapping, setLoadingMapping] = useState(true);
  const [savingMapping, setSavingMapping] = useState(false);
  // Per-row override that forces the Zoho-field cell into manual-input mode
  // (used for Zoho "Public" fields that are hidden from the metadata API).
  const [manualEntryRows, setManualEntryRows] = useState(() => new Set());

  // Sync log state
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [logEntityFilter, setLogEntityFilter] = useState("all");
  const [logDirectionFilter, setLogDirectionFilter] = useState("all");
  const [logActionFilter, setLogActionFilter] = useState("all");
  const [activeTab, setActiveTab] = useState("mapping");
  const [viewLog, setViewLog] = useState(null);

  // "Find a missing field" diagnostic
  const [findFieldQuery, setFindFieldQuery] = useState("");
  const [findFieldModule, setFindFieldModule] = useState("Accounts");
  const [findFieldRecordId, setFindFieldRecordId] = useState("");
  const [findFieldSearching, setFindFieldSearching] = useState(false);
  const [findFieldResult, setFindFieldResult] = useState(null);

  // Webhook config
  const [webhookInfo, setWebhookInfo] = useState(null);
  const [loadingWebhook, setLoadingWebhook] = useState(false);
  const [regeneratingSecret, setRegeneratingSecret] = useState(false);

  // Re-link to Zoho
  const [relinking, setRelinking] = useState(false);
  const [relinkSummary, setRelinkSummary] = useState(null);
  const [relinkConfig, setRelinkConfig] = useState(null);
  const [relinkSamples, setRelinkSamples] = useState([]);
  const [relinkError, setRelinkError] = useState(null);
  const [relinkWarning, setRelinkWarning] = useState(null);
  const [showRelinkSamples, setShowRelinkSamples] = useState(false);
  // Cursor + cumulative counters for resumable re-link runs. Each server
  // invocation advances through a slice of orgs within its 50s budget; the
  // next click sends `relinkCursor` as `startAfterId` so we pick up where
  // we left off instead of re-validating the earlier records.
  const [relinkCursor, setRelinkCursor] = useState(null);
  const [relinkTotals, setRelinkTotals] = useState(null);
  const [relinkCompleted, setRelinkCompleted] = useState(false);

  // Value translation modal
  const [translationModal, setTranslationModal] = useState(null); // { idx, iconnectAllowed, zohoAllowed, draft: { iconnect_to_zoho, zoho_to_iconnect } }

  // One-time import from Zoho
  const [importingOrgs, setImportingOrgs] = useState(false);
  const [importingMembers, setImportingMembers] = useState(false);
  const [importOrgsSummary, setImportOrgsSummary] = useState(null);
  const [importMembersSummary, setImportMembersSummary] = useState(null);

  // Single-record manual sync (preview / live), nested inside the One-time
  // import card. Lets admins dry-run a specific Zoho record before kicking
  // off a full bulk import.
  const [singleEntityType, setSingleEntityType] = useState("organization");
  const [singleRecordId, setSingleRecordId] = useState("");
  const [singlePreviewing, setSinglePreviewing] = useState(false);
  const [singleSyncing, setSingleSyncing] = useState(false);
  const [singleResult, setSingleResult] = useState(null);
  const [singleError, setSingleError] = useState(null);

  useEffect(() => {
    checkConnection();
    loadModules();
    loadWebhookInfo();
  }, []);

  const loadWebhookInfo = async () => {
    setLoadingWebhook(true);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/webhook-url", { credentials: "include" });
      const d = await r.json();
      if (r.ok) setWebhookInfo(d);
    } finally {
      setLoadingWebhook(false);
    }
  };

  const regenerateSecret = async () => {
    if (!confirm("Regenerating the secret will break any existing Zoho workflow rules until you update them. Continue?")) return;
    setRegeneratingSecret(true);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/webhook-url", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate" })
      });
      const d = await r.json();
      if (r.ok) {
        setWebhookInfo(d);
        toast({ title: "Secret regenerated", description: "Update your Zoho workflow rules with the new secret." });
      } else {
        toast({ variant: "destructive", title: "Regenerate failed", description: d.error });
      }
    } finally {
      setRegeneratingSecret(false);
    }
  };

  const resetRelinkProgress = () => {
    setRelinkCursor(null);
    setRelinkTotals(null);
    setRelinkCompleted(false);
    setRelinkSummary(null);
    setRelinkConfig(null);
    setRelinkSamples([]);
    setRelinkError(null);
    setRelinkWarning(null);
  };

  const relinkOrganisations = async () => {
    const isResuming = relinkCursor !== null && !relinkCompleted;
    if (!isResuming) {
      if (!confirm("This will look up every organisation in Zoho by the configured unique key and update the stored Zoho record id. It does not change any field values. Continue?")) return;
    }
    setRelinking(true);
    setRelinkError(null);
    setRelinkWarning(null);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/relink-organisations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isResuming ? { startAfterId: relinkCursor } : {})
      });
      // The server may return a non-JSON response when Vercel kills the
      // function on timeout (it serves an HTML gateway error page). Parse
      // defensively so the user gets a clear message instead of a raw
      // `SyntaxError: Unexpected token <` from JSON.parse.
      let d = null;
      let parseError = null;
      try {
        d = await r.json();
      } catch (parseErr) {
        parseError = parseErr;
      }
      if (parseError) {
        const msg = r.status === 504 || r.status === 502
          ? "Request timed out — the re-link took too long. Try again, or process in smaller batches."
          : `Server error (${r.status}) — the request may have timed out for large datasets. Try again.`;
        setRelinkError(msg);
        toast({ variant: "destructive", title: "Re-link failed", description: msg });
        return;
      }
      if (r.ok) {
        setRelinkSummary(d.summary);
        setRelinkConfig(d.config || null);
        setRelinkSamples(Array.isArray(d.samples) ? d.samples : []);
        const isTruncated = !!(d.truncated || (d.summary && d.summary.truncated));
        // Accumulate counters across successive partial runs so the banner
        // reflects real forward progress rather than resetting each click.
        const s = d.summary || {};
        setRelinkTotals(prev => {
          const base = (isResuming && prev) ? prev : {
            processed: 0, relinked: 0, already_linked: 0,
            no_match: 0, ambiguous: 0, failed: 0, skipped_no_value: 0, runs: 0
          };
          return {
            processed: base.processed + (s.processed || 0),
            relinked: base.relinked + (s.relinked || 0),
            already_linked: base.already_linked + (s.already_linked || 0),
            no_match: base.no_match + (s.no_match || 0),
            ambiguous: base.ambiguous + (s.ambiguous || 0),
            failed: base.failed + (s.failed || 0),
            skipped_no_value: base.skipped_no_value + (s.skipped_no_value || 0),
            runs: base.runs + 1
          };
        });
        if (isTruncated) {
          const nextCursor = d.last_processed_id ?? s.last_processed_id ?? null;
          setRelinkCursor(nextCursor);
          setRelinkCompleted(false);
          const warnMsg = `Time budget reached after processing ${s.processed ?? 0} organisation(s) in this run. Click "Continue re-link" to resume with the remaining records.`;
          setRelinkWarning(warnMsg);
          toast({
            title: "Re-link partially complete",
            description: warnMsg
          });
        } else {
          setRelinkCursor(null);
          setRelinkCompleted(true);
          toast({
            title: "Re-link complete",
            description: `${s.relinked} re-linked, ${s.already_linked} already linked, ${s.no_match} no match, ${s.ambiguous} ambiguous, ${s.failed} failed`
          });
        }
        loadLogs();
      } else {
        setRelinkError(d.error || `Server returned ${r.status}`);
        toast({ variant: "destructive", title: "Re-link failed", description: d.error });
      }
    } catch (err) {
      setRelinkError(err.message || String(err));
      toast({ variant: "destructive", title: "Re-link failed", description: err.message });
    } finally {
      setRelinking(false);
    }
  };

  const openRelinkLogs = () => {
    setLogEntityFilter("organization");
    setLogActionFilter("relink");
    setLogDirectionFilter("all");
    setStatusFilter("all");
    setActiveTab("logs");
  };

  const runImport = async (kind) => {
    if (importingOrgs || importingMembers || singlePreviewing || singleSyncing) return;
    const label = kind === 'organisations' ? 'organisations' : 'members';
    if (!confirm(
      `This will paginate through every ${label[0].toUpperCase() + label.slice(1).replace(/s$/, '')} record in Zoho CRM and create or update the matching iConnect record. ` +
      `Existing iConnect values are preserved when the corresponding Zoho field is empty. The import is idempotent and safe to re-run. Continue?`
    )) return;

    const setRunning = kind === 'organisations' ? setImportingOrgs : setImportingMembers;
    const setSummary = kind === 'organisations' ? setImportOrgsSummary : setImportMembersSummary;
    setRunning(true);
    setSummary(null);
    try {
      const r = await fetch(`/api/admin/zoho-crm-sync/import-${kind === 'organisations' ? 'organisations' : 'members'}`, {
        method: "POST",
        credentials: "include"
      });
      const d = await r.json();
      if (r.ok) {
        setSummary(d.summary);
        toast({
          title: `${kind === 'organisations' ? 'Organisation' : 'Member'} import complete`,
          description: `Processed ${d.summary.processed}: ${d.summary.created} created, ${d.summary.updated} updated, ${d.summary.skipped} skipped, ${d.summary.failed} failed`
        });
        loadLogs();
      } else {
        toast({ variant: "destructive", title: "Import failed", description: d.error });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Import failed", description: err.message });
    } finally {
      setRunning(false);
    }
  };

  const runSingleRecordImport = async (dryRun) => {
    if (singlePreviewing || singleSyncing || importingOrgs || importingMembers) return;
    const trimmed = singleRecordId.trim();
    if (!trimmed) {
      toast({ variant: "destructive", title: "Zoho record id required" });
      return;
    }
    if (!dryRun && !confirm(
      `Sync Zoho ${singleEntityType === 'organization' ? 'Account/Lead' : 'Contact/Lead'} ${trimmed} into iConnect now? ` +
      `This will create or update the matching iConnect record using the configured field mappings.`
    )) return;
    const setRunning = dryRun ? setSinglePreviewing : setSingleSyncing;
    setRunning(true);
    setSingleResult(null);
    setSingleError(null);
    try {
      const r = await fetch('/api/admin/zoho-crm-sync/import-single-record', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: singleEntityType,
          zohoRecordId: trimmed,
          dryRun
        })
      });
      const d = await r.json();
      if (r.ok) {
        setSingleResult({ ...d.result, dryRun });
        toast({
          title: dryRun ? 'Preview ready' : `Sync ${d.result.outcome}`,
          description: `Outcome: ${d.result.outcome}${d.result.matched ? ` — matched iConnect ${singleEntityType} ${d.result.matched.id}` : ''}`
        });
        if (!dryRun) loadLogs();
      } else {
        setSingleError(d.error || 'Request failed');
        toast({ variant: 'destructive', title: 'Failed', description: d.error });
      }
    } catch (err) {
      setSingleError(err.message);
      toast({ variant: 'destructive', title: 'Failed', description: err.message });
    } finally {
      setRunning(false);
    }
  };

  const copyText = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast({ title: "Copied to clipboard" }),
      () => toast({ variant: "destructive", title: "Copy failed" })
    );
  };

  useEffect(() => {
    loadMapping(entityType);
    loadIconnectFields(entityType);
    // Re-link progress is tied to the organisation mapping specifically;
    // switching entities invalidates any in-flight cursor so a fresh run
    // starts from the top once the user returns to organisations.
    resetRelinkProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType]);

  useEffect(() => {
    if (mapping?.zoho_module) {
      loadZohoFields(mapping.zoho_module);
    } else {
      setZohoFields([]);
    }
  }, [mapping?.zoho_module]);

  const checkConnection = async () => {
    setCheckingConnection(true);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/metadata?resource=connection", { credentials: "include" });
      const d = await r.json();
      setConnected(!!d.connected);
    } catch {
      setConnected(false);
    } finally {
      setCheckingConnection(false);
    }
  };

  const loadModules = async () => {
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/metadata?resource=modules", { credentials: "include" });
      const d = await r.json();
      if (r.ok) setModules(d.modules || []);
    } catch (err) {
      console.error("Modules load error:", err);
    }
  };

  const loadIconnectFields = async (et) => {
    try {
      const r = await fetch(`/api/admin/zoho-crm-sync/metadata?resource=iconnect-fields&entity_type=${et}`, { credentials: "include" });
      const d = await r.json();
      if (r.ok) setIconnectFields({ core: d.core || [], custom: d.custom || [] });
    } catch (err) {
      console.error("iConnect fields load error:", err);
    }
  };

  const loadZohoFields = async (mod) => {
    try {
      const r = await fetch(`/api/admin/zoho-crm-sync/metadata?resource=fields&module=${encodeURIComponent(mod)}`, { credentials: "include" });
      const d = await r.json();
      if (r.ok) setZohoFields(d.fields || []);
      else toast({ variant: "destructive", title: "Failed to load Zoho fields", description: d.error });
    } catch (err) {
      console.error("Zoho fields load error:", err);
    }
  };

  const runFindField = async () => {
    const q = findFieldQuery.trim();
    if (!q) return;
    setFindFieldSearching(true);
    setFindFieldResult(null);
    try {
      const recId = (findFieldRecordId || "").trim();
      let url = `/api/admin/zoho-crm-sync/metadata?resource=find-field&module=${encodeURIComponent(findFieldModule || "Accounts")}&q=${encodeURIComponent(q)}`;
      if (recId) url += `&record_id=${encodeURIComponent(recId)}`;
      const r = await fetch(url, { credentials: "include" });
      const d = await r.json();
      if (r.ok) {
        setFindFieldResult(d);
      } else {
        toast({ variant: "destructive", title: "Search failed", description: d.error || "Unknown error" });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Search failed", description: String(err?.message || err) });
    } finally {
      setFindFieldSearching(false);
    }
  };

  const loadMapping = async (et) => {
    setLoadingMapping(true);
    // Reset per-row UI state — index-based and not meaningful across reloads.
    setManualEntryRows(new Set());
    try {
      const r = await fetch(`/api/admin/zoho-crm-sync/mappings?entity_type=${et}`, { credentials: "include" });
      const d = await r.json();
      if (r.ok) {
        const found = (d.mappings || []).find(m => m.entity_type === et);
        if (found) {
          setMapping(found);
        } else {
          const defaultModule = et === "organization" ? "Accounts" : "Contacts";
          setMapping({
            entity_type: et,
            zoho_module: defaultModule,
            unique_key_field: DEFAULT_UNIQUE_KEY[defaultModule],
            is_enabled: false,
            field_mappings: [],
            sync_direction: "outbound",
            conflict_policy: "last_write_wins",
            unmatched_policy: "ignore"
          });
        }
      }
    } finally {
      setLoadingMapping(false);
    }
  };

  const updateMapping = (patch) => {
    // Changing relink-critical config mid-flight invalidates any in-flight
    // cursor — resuming after `last_processed_id` under a new Zoho module
    // or unique key would silently skip earlier orgs under the new mapping.
    if (entityType === "organization" && patch && (
      Object.prototype.hasOwnProperty.call(patch, "zoho_module") ||
      Object.prototype.hasOwnProperty.call(patch, "unique_key_field")
    )) {
      if (relinkCursor !== null || relinkTotals || relinkCompleted) {
        resetRelinkProgress();
      }
    }
    setMapping(prev => ({ ...prev, ...patch }));
  };

  const updateRow = (idx, patch) => {
    setMapping(prev => {
      const rows = [...(prev.field_mappings || [])];
      rows[idx] = { ...rows[idx], ...patch };
      return { ...prev, field_mappings: rows };
    });
  };

  const addRow = () => {
    setMapping(prev => ({ ...prev, field_mappings: [...(prev.field_mappings || []), emptyMappingRow()] }));
  };

  const removeRow = (idx) => {
    setMapping(prev => ({ ...prev, field_mappings: prev.field_mappings.filter((_, i) => i !== idx) }));
    // Shift down any forced-manual indices above the removed row so the set
    // keeps pointing at the same logical rows after the splice.
    setManualEntryRows(prev => {
      const next = new Set();
      for (const i of prev) {
        if (i === idx) continue;
        next.add(i > idx ? i - 1 : i);
      }
      return next;
    });
  };

  const saveMapping = async () => {
    if (!mapping?.zoho_module || !mapping?.unique_key_field) {
      toast({ variant: "destructive", title: "Missing required fields", description: "Module and unique key field are required" });
      return;
    }
    setSavingMapping(true);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/mappings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: mapping.entity_type,
          zoho_module: mapping.zoho_module,
          unique_key_field: mapping.unique_key_field,
          is_enabled: !!mapping.is_enabled,
          field_mappings: mapping.field_mappings || [],
          sync_direction: mapping.sync_direction || "outbound",
          conflict_policy: mapping.conflict_policy || "last_write_wins",
          unmatched_policy: mapping.unmatched_policy || "ignore"
        })
      });
      const d = await r.json();
      if (r.ok) {
        setMapping(d.mapping);
        // Saved mapping may change the effective unique key / module /
        // field mappings relative to whatever an in-flight relink cursor
        // was built against, so start fresh from the top on next click.
        if (entityType === "organization" && (relinkCursor !== null || relinkTotals || relinkCompleted)) {
          resetRelinkProgress();
        }
        toast({ title: "Mapping saved", description: `${entityType} sync configuration updated` });
      } else {
        toast({ variant: "destructive", title: "Save failed", description: d.error });
      }
    } finally {
      setSavingMapping(false);
    }
  };

  const exportMappingCsv = () => {
    const rows = mapping?.field_mappings || [];
    if (rows.length === 0) {
      toast({
        variant: "destructive",
        title: "Nothing to export",
        description: "Add at least one field mapping before exporting."
      });
      return;
    }

    const entityLabel = mapping?.entity_type === "organization" ? "organisation" : (mapping?.entity_type || entityType);
    const lines = [];

    // Small header section with the surrounding mapping context so the
    // client has full context (module, unique key, sync direction, etc.).
    lines.push(csvRow(["Setting", "Value"]));
    lines.push(csvRow(["Entity type", mapping?.entity_type || entityType]));
    lines.push(csvRow(["Zoho module", mapping?.zoho_module || ""]));
    lines.push(csvRow(["Unique key field", mapping?.unique_key_field || ""]));
    lines.push(csvRow(["Sync direction", mapping?.sync_direction || ""]));
    lines.push(csvRow(["Conflict policy", mapping?.conflict_policy || ""]));
    lines.push(csvRow(["Unmatched policy", mapping?.unmatched_policy || ""]));
    lines.push(csvRow(["Enabled", mapping?.is_enabled ? "yes" : "no"]));
    lines.push(csvRow(["Exported on", todayIsoDate()]));
    lines.push("");

    // Field mappings table.
    lines.push(csvRow([
      "iConnect Field",
      "iConnect Field Type",
      "Zoho API Name",
      "Zoho Field Label",
      "Value Map"
    ]));
    for (const row of rows) {
      const iOpt = allIconnectOptions.find(o => o.value === row.iconnect_field);
      const zField = zohoFields.find(z => z.api_name === row.zoho_field);
      lines.push(csvRow([
        iOpt?.label || row.iconnect_field || "",
        row.iconnect_field_type || iOpt?.type || "",
        row.zoho_field || "",
        row.zoho_field_label || zField?.field_label || "",
        serializeValueMap(row.value_map)
      ]));
    }

    const csv = lines.join("\r\n");
    // BOM so Excel opens UTF-8 cleanly.
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zoho-crm-mapping-${entityLabel}-${todayIsoDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadLogs = async () => {
    setLoadingLogs(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (logEntityFilter !== "all") params.set("entity_type", logEntityFilter);
      if (logDirectionFilter !== "all") params.set("direction", logDirectionFilter);
      if (logActionFilter !== "all") params.set("action", logActionFilter);
      const r = await fetch(`/api/admin/zoho-crm-sync/logs?${params}`, { credentials: "include" });
      const d = await r.json();
      if (r.ok) setLogs(d.logs || []);
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, logEntityFilter, logDirectionFilter, logActionFilter]);

  const retryLog = async (logId) => {
    setRetryingId(logId);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/logs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", log_id: logId })
      });
      const d = await r.json();
      if (r.ok) {
        toast({
          title: d.result?.status === "success" ? "Retry succeeded" : "Retry completed",
          description: d.result?.status === "failed" ? (d.result.error_message || "Failed again") : `Status: ${d.result?.status || "unknown"}`,
          variant: d.result?.status === "failed" ? "destructive" : "default"
        });
        loadLogs();
      } else {
        toast({ variant: "destructive", title: "Retry failed", description: d.error });
      }
    } finally {
      setRetryingId(null);
    }
  };

  const allIconnectOptions = useMemo(() => {
    const opts = [
      ...iconnectFields.core.map(f => ({
        value: f.key, label: `${f.label}`, type: f.type,
        allowed_values: f.allowed_values
      })),
      ...iconnectFields.custom.map(f => ({
        value: f.key, label: `${f.label} (custom)`, type: f.type,
        allowed_values: f.allowed_values
      }))
    ];
    return opts.sort((a, b) => (a.label || "").localeCompare(b.label || "", undefined, { sensitivity: "base" }));
  }, [iconnectFields]);

  const openTranslationModal = (idx) => {
    const row = mapping?.field_mappings?.[idx];
    if (!row) return;
    const iOpt = allIconnectOptions.find(o => o.value === row.iconnect_field);
    const zField = zohoFields.find(z => z.api_name === row.zoho_field);
    const iAllowed = getIconnectAllowedValues(iOpt) || [];
    const zAllowed = getZohoAllowedValues(zField) || [];
    setTranslationModal({
      idx,
      iconnectField: row.iconnect_field,
      zohoField: row.zoho_field,
      iconnectAllowed: iAllowed,
      zohoAllowed: zAllowed,
      draft: {
        iconnect_to_zoho: { ...(row.value_map?.iconnect_to_zoho || {}) },
        zoho_to_iconnect: { ...(row.value_map?.zoho_to_iconnect || {}) }
      }
    });
  };

  const setTranslationPair = (direction, key, value) => {
    setTranslationModal(prev => {
      if (!prev) return prev;
      const next = { ...prev.draft[direction] };
      if (value === "" || value == null) delete next[key];
      else next[key] = value;
      return { ...prev, draft: { ...prev.draft, [direction]: next } };
    });
  };

  const saveTranslationModal = () => {
    if (!translationModal) return;
    const { idx, draft } = translationModal;
    const i2zClean = Object.fromEntries(Object.entries(draft.iconnect_to_zoho).filter(([k, v]) => k !== "" && v !== "" && v != null));
    const z2iClean = Object.fromEntries(Object.entries(draft.zoho_to_iconnect).filter(([k, v]) => k !== "" && v !== "" && v != null));
    const hasAny = Object.keys(i2zClean).length > 0 || Object.keys(z2iClean).length > 0;
    updateRow(idx, {
      value_map: hasAny
        ? {
            ...(Object.keys(i2zClean).length > 0 ? { iconnect_to_zoho: i2zClean } : {}),
            ...(Object.keys(z2iClean).length > 0 ? { zoho_to_iconnect: z2iClean } : {})
          }
        : undefined
    });
    setTranslationModal(null);
  };

  const writableZohoFields = useMemo(() => {
    return zohoFields
      .filter(f => !f.read_only)
      .slice()
      .sort((a, b) => (a.field_label || "").localeCompare(b.field_label || "", undefined, { sensitivity: "base" }));
  }, [zohoFields]);

  const sortedZohoFields = useMemo(() => {
    return zohoFields
      .slice()
      .sort((a, b) => (a.field_label || "").localeCompare(b.field_label || "", undefined, { sensitivity: "base" }));
  }, [zohoFields]);

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">Zoho CRM Sync</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Map iConnect member and organisation fields to Zoho CRM. Records are pushed in real time on create and update.
          </p>
        </div>
        {checkingConnection ? (
          <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Checking</Badge>
        ) : connected ? (
          <Badge className="bg-green-500/20 text-green-700 border-green-500/30" data-testid="badge-connected">
            <CheckCircle2 className="h-3 w-3 mr-1" />Connected to Zoho CRM
          </Badge>
        ) : (
          <Badge variant="destructive" data-testid="badge-disconnected">
            <AlertTriangle className="h-3 w-3 mr-1" />Not connected — connect Zoho in Integrations first
          </Badge>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="mapping" data-testid="tab-mapping">Field Mapping</TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs">Sync Log</TabsTrigger>
        </TabsList>

        <TabsContent value="mapping" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Mapping Configuration</CardTitle>
                  <CardDescription>Choose the entity, target Zoho module, and field mappings.</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="entity-select" className="text-sm">Entity</Label>
                  <Select value={entityType} onValueChange={setEntityType}>
                    <SelectTrigger id="entity-select" className="w-[180px]" data-testid="select-entity-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENTITY_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingMapping ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Zoho Module</Label>
                      <Select
                        value={mapping?.zoho_module || ""}
                        onValueChange={(v) => updateMapping({ zoho_module: v, unique_key_field: DEFAULT_UNIQUE_KEY[v] || mapping?.unique_key_field })}
                      >
                        <SelectTrigger data-testid="select-zoho-module">
                          <SelectValue placeholder="Select module" />
                        </SelectTrigger>
                        <SelectContent>
                          {modules.map(m => (
                            <SelectItem key={m.api_name} value={m.api_name}>{m.plural_label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Unique Key (duplicate check)</Label>
                      <Select
                        value={mapping?.unique_key_field || ""}
                        onValueChange={(v) => updateMapping({ unique_key_field: v })}
                      >
                        <SelectTrigger data-testid="select-unique-key">
                          <SelectValue placeholder="Select field" />
                        </SelectTrigger>
                        <SelectContent>
                          {writableZohoFields.map(f => (
                            <SelectItem key={f.api_name} value={f.api_name}>{f.field_label} ({f.api_name})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-3 pt-7">
                      <Switch
                        checked={!!mapping?.is_enabled}
                        onCheckedChange={(v) => updateMapping({ is_enabled: v })}
                        data-testid="switch-mapping-enabled"
                      />
                      <Label>Sync enabled</Label>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Sync Direction</Label>
                      <Select
                        value={mapping?.sync_direction || "outbound"}
                        onValueChange={(v) => updateMapping({ sync_direction: v })}
                      >
                        <SelectTrigger data-testid="select-sync-direction">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SYNC_DIRECTIONS.map(d => (
                            <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Inbound and bidirectional require the webhook (or the 15-minute reconciliation poller) to be configured in Zoho.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>Conflict Policy</Label>
                      <Select
                        value={mapping?.conflict_policy || "last_write_wins"}
                        onValueChange={(v) => updateMapping({ conflict_policy: v })}
                        disabled={(mapping?.sync_direction || "outbound") === "outbound"}
                      >
                        <SelectTrigger data-testid="select-conflict-policy">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONFLICT_POLICIES.map(p => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Applies when an inbound update arrives and the iConnect record has been edited since the last sync.
                      </p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label>When Zoho sends a record with no matching iConnect record</Label>
                      <Select
                        value={mapping?.unmatched_policy || "ignore"}
                        onValueChange={(v) => updateMapping({ unmatched_policy: v })}
                        disabled={(mapping?.sync_direction || "outbound") === "outbound"}
                      >
                        <SelectTrigger data-testid="select-unmatched-policy">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {UNMATCHED_POLICIES.map(p => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        "Create" inserts a new member/organization populated from the mapped fields. "Queue" logs the record as pending so an admin can resolve it manually.
                      </p>
                    </div>
                  </div>

                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>iConnect Field</TableHead>
                          <TableHead className="w-12"></TableHead>
                          <TableHead>Zoho Field</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(mapping?.field_mappings || []).map((row, idx) => {
                          const iOpt = allIconnectOptions.find(o => o.value === row.iconnect_field);
                          const zField = zohoFields.find(z => z.api_name === row.zoho_field);
                          const iAllowed = getIconnectAllowedValues(iOpt);
                          const zAllowed = getZohoAllowedValues(zField);
                          const translatable = !!(iAllowed && zAllowed);
                          const hasMap = rowHasValueMap(row);
                          return (
                            <TableRow key={idx} data-testid={`row-mapping-${idx}`}>
                              <TableCell>
                                <Select
                                  value={row.iconnect_field || ""}
                                  onValueChange={(v) => {
                                    const opt = allIconnectOptions.find(o => o.value === v);
                                    const patch = { iconnect_field: v, iconnect_field_type: opt?.type };
                                    if (v !== row.iconnect_field && rowHasValueMap(row)) patch.value_map = undefined;
                                    updateRow(idx, patch);
                                  }}
                                >
                                  <SelectTrigger data-testid={`select-iconnect-field-${idx}`}>
                                    <SelectValue placeholder="Select source" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {allIconnectOptions.map(opt => (
                                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="w-12 text-center">
                                {translatable ? (
                                  <Button
                                    variant={hasMap ? "default" : "outline"}
                                    size="icon"
                                    onClick={() => openTranslationModal(idx)}
                                    title={hasMap ? "Value translation configured" : "Set up value translation"}
                                    data-testid={`button-value-map-${idx}`}
                                  >
                                    <Shuffle className="h-4 w-4" />
                                  </Button>
                                ) : null}
                              </TableCell>
                              <TableCell>
                                {(() => {
                                  const isManual = manualEntryRows.has(idx) || (!!row.zoho_field && !sortedZohoFields.some(f => f.api_name === row.zoho_field));
                                  if (isManual) {
                                    return (
                                      <div className="flex items-center gap-2">
                                        <Input
                                          value={row.zoho_field || ""}
                                          placeholder="Type Zoho api_name (e.g. Organisation_overview)"
                                          onChange={(e) => {
                                            const v = e.target.value;
                                            const patch = { zoho_field: v, zoho_field_label: row.zoho_field_label || v };
                                            if (v !== row.zoho_field && rowHasValueMap(row)) patch.value_map = undefined;
                                            updateRow(idx, patch);
                                          }}
                                          data-testid={`input-zoho-field-manual-${idx}`}
                                        />
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            setManualEntryRows(prev => {
                                              const next = new Set(prev);
                                              next.delete(idx);
                                              return next;
                                            });
                                            updateRow(idx, { zoho_field: "", zoho_field_label: "" });
                                          }}
                                          data-testid={`button-zoho-field-use-dropdown-${idx}`}
                                        >
                                          Use dropdown
                                        </Button>
                                      </div>
                                    );
                                  }
                                  return (
                                    <Select
                                      value={row.zoho_field || ""}
                                      onValueChange={(v) => {
                                        if (v === "__manual__") {
                                          setManualEntryRows(prev => {
                                            const next = new Set(prev);
                                            next.add(idx);
                                            return next;
                                          });
                                          return;
                                        }
                                        const f = writableZohoFields.find(z => z.api_name === v);
                                        const patch = { zoho_field: v, zoho_field_label: f?.field_label };
                                        if (v !== row.zoho_field && rowHasValueMap(row)) patch.value_map = undefined;
                                        updateRow(idx, patch);
                                      }}
                                    >
                                      <SelectTrigger data-testid={`select-zoho-field-${idx}`}>
                                        <SelectValue placeholder="Select Zoho field" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {sortedZohoFields.map(f => (
                                          <SelectItem
                                            key={f.api_name}
                                            value={f.api_name}
                                            disabled={!!f.read_only}
                                          >
                                            {f.field_label} ({f.api_name}){f.required ? " *" : ""}{f.read_only ? " (read-only)" : ""}
                                          </SelectItem>
                                        ))}
                                        <SelectItem value="__manual__" data-testid={`select-zoho-field-manual-option-${idx}`}>
                                          Type api_name manually… (for hidden / Public fields)
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  );
                                })()}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeRow(idx)}
                                  data-testid={`button-remove-row-${idx}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {(!mapping?.field_mappings || mapping.field_mappings.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">
                              No field mappings yet. Click "Add field" to start.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={addRow} data-testid="button-add-row">
                      <Plus className="h-4 w-4 mr-2" />Add field
                    </Button>
                    <Button onClick={saveMapping} disabled={savingMapping} data-testid="button-save-mapping">
                      {savingMapping ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                      Save mapping
                    </Button>
                    <Button
                      variant="outline"
                      onClick={exportMappingCsv}
                      disabled={!mapping?.field_mappings || mapping.field_mappings.length === 0}
                      data-testid="button-export-mapping-csv"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Export CSV
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover-elevate" data-testid="trigger-find-field-card">
                  <CardTitle className="text-base">Find a missing field (diagnostic)</CardTitle>
                  <CardDescription>
                    Click to expand. Search Zoho live (no cache) across <code>/settings/fields?type=all</code>, <code>/settings/fields</code>, <code>/settings/layouts</code> and every per-layout detail to see whether Zoho is returning a particular field at all.
                  </CardDescription>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1 flex-1 min-w-[200px]">
                  <Label htmlFor="find-field-query">Field name or label</Label>
                  <Input
                    id="find-field-query"
                    placeholder="e.g. Organisation overview"
                    value={findFieldQuery}
                    onChange={(e) => setFindFieldQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runFindField(); }}
                    data-testid="input-find-field-query"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="find-field-module">Module</Label>
                  <Select value={findFieldModule} onValueChange={setFindFieldModule}>
                    <SelectTrigger id="find-field-module" className="w-[200px]" data-testid="select-find-field-module">
                      <SelectValue placeholder="Select module" />
                    </SelectTrigger>
                    <SelectContent>
                      {(modules.length > 0 ? modules : [{ api_name: 'Accounts', plural_label: 'Accounts' }, { api_name: 'Contacts', plural_label: 'Contacts' }, { api_name: 'Leads', plural_label: 'Leads' }]).map(m => (
                        <SelectItem key={m.api_name} value={m.api_name}>{m.plural_label || m.api_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 min-w-[260px]">
                  <Label htmlFor="find-field-record-id">Record ID (optional)</Label>
                  <Input
                    id="find-field-record-id"
                    placeholder="e.g. 4567890000001234567 — overrides auto-sample"
                    value={findFieldRecordId}
                    onChange={(e) => setFindFieldRecordId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runFindField(); }}
                    data-testid="input-find-field-record-id"
                  />
                  <p className="text-xs text-muted-foreground">Use when the field only appears on records using a specific layout.</p>
                </div>
                <Button
                  onClick={runFindField}
                  disabled={!findFieldQuery.trim() || findFieldSearching}
                  data-testid="button-find-field-search"
                >
                  {findFieldSearching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Search Zoho
                </Button>
              </div>

              {findFieldResult && (
                <div className="space-y-3 rounded-md border bg-muted/30 p-4" data-testid="panel-find-field-result">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={findFieldResult.matches.length > 0 ? "default" : "destructive"} data-testid="badge-find-field-match-count">
                      {findFieldResult.matches.length} match{findFieldResult.matches.length === 1 ? '' : 'es'}
                    </Badge>
                    {findFieldResult.errors && findFieldResult.errors.length > 0 && (
                      <Badge variant="destructive" data-testid="badge-find-field-error-count">
                        {findFieldResult.errors.length} error{findFieldResult.errors.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      module <code>{findFieldResult.module}</code> · query <code>{findFieldResult.query}</code> · fields[type=all]: {findFieldResult.counts?.fields_count_by_endpoint?.['type=all'] ?? '—'} · fields[default]: {findFieldResult.counts?.fields_count_by_endpoint?.default ?? '—'} · {findFieldResult.counts?.layouts_total ?? 0} layouts ({findFieldResult.counts?.layout_detail_calls ?? 0} detail calls{findFieldResult.counts?.layouts_skipped_cap ? `, ${findFieldResult.counts.layouts_skipped_cap} skipped` : ''}) · {findFieldResult.counts?.pinned_record_id ? (
                        <>record: pinned <code>{findFieldResult.counts.pinned_record_id}</code> ({findFieldResult.counts?.record_sample_keys ?? 0} keys) · rich-text: pinned record ({findFieldResult.counts?.rich_text_keys ?? 0} keys)</>
                      ) : (
                        <>records: {findFieldResult.counts?.records_probed ?? 0}/{findFieldResult.counts?.max_record_samples ?? 1} sampled ({findFieldResult.counts?.record_sample_keys ?? 0} keys on first) · rich-text: {findFieldResult.counts?.rich_text_probed ?? 0}/{findFieldResult.counts?.max_record_samples ?? 1} sampled ({findFieldResult.counts?.rich_text_keys ?? 0} keys)</>
                      )}
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <p className="text-sm flex-1" data-testid="text-find-field-conclusion">{findFieldResult.conclusion}</p>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(findFieldResult.conclusion || '');
                        toast({ title: "Copied", description: "Troubleshooting hint copied to clipboard." });
                      }}
                      data-testid="button-find-field-copy-conclusion"
                      title="Copy troubleshooting hint"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>

                  {findFieldResult.matches.length === 0 && Array.isArray(findFieldResult.counts?.rich_text_keys_seen) && findFieldResult.counts.rich_text_keys_seen.length > 0 && (
                    <div className="space-y-1.5" data-testid="block-rich-text-keys-seen">
                      <p className="text-xs font-medium text-muted-foreground">Rich-text fields visible on this module ({findFieldResult.counts.rich_text_keys_seen.length}):</p>
                      <div className="flex flex-wrap gap-1.5">
                        {findFieldResult.counts.rich_text_keys_seen.map((apiName) => (
                          <Badge key={apiName} variant="outline" data-testid={`badge-rich-text-key-${apiName}`}>
                            <code className="text-xs">{apiName}</code>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {findFieldResult.matches.length === 0 && Array.isArray(findFieldResult.counts?.record_sample_keys_list) && findFieldResult.counts.record_sample_keys_list.length > 0 && (
                    <details className="rounded-md border bg-background p-3" data-testid="block-record-sample-keys">
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        All record keys from{" "}
                        {findFieldResult.counts.record_sample_keys_source_id ? (
                          <>record <code>{findFieldResult.counts.record_sample_keys_source_id}</code></>
                        ) : (
                          <>sampled record</>
                        )}{" "}
                        ({findFieldResult.counts.record_sample_keys_list.length} keys, sorted) — scan for renamed/suffixed api_names
                      </summary>
                      <div className="mt-2 max-h-64 overflow-y-auto pr-1 flex flex-wrap gap-1.5">
                        {findFieldResult.counts.record_sample_keys_list.map((apiName) => (
                          <Badge
                            key={apiName}
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => {
                              navigator.clipboard.writeText(apiName);
                              toast({ title: "Copied", description: `api_name "${apiName}" copied to clipboard.` });
                            }}
                            data-testid={`badge-record-key-${apiName}`}
                            title="Click to copy api_name"
                          >
                            <code className="text-xs">{apiName}</code>
                          </Badge>
                        ))}
                      </div>
                    </details>
                  )}

                  {findFieldResult.matches.length > 0 && (
                    <div className="space-y-2">
                      {findFieldResult.matches.map((m, i) => (
                        <details key={i} className="rounded-md border bg-background p-3" data-testid={`row-find-field-match-${i}`}>
                          <summary className="cursor-pointer text-sm">
                            <span className="font-medium">{m.field?.field_label || m.field?.display_label || m.field?.api_name || m.field?.name || '(unnamed)'}</span>
                            <span className="text-muted-foreground"> — </span>
                            <code className="text-xs">{m.field?.api_name || m.field?.name || ''}</code>
                            <span className="text-muted-foreground"> · </span>
                            <Badge variant="secondary" className="ml-1">{m.source}</Badge>
                            {m.field?.data_type && <Badge variant="outline" className="ml-1">{m.field.data_type}</Badge>}
                            {m.field?.custom_field && <Badge variant="outline" className="ml-1">custom</Badge>}
                            {m.layout_name && <span className="text-xs text-muted-foreground ml-2">layout: {m.layout_name}</span>}
                            {m.section_name && <span className="text-xs text-muted-foreground ml-2">section: {m.section_name}</span>}
                          </summary>
                          <pre className="mt-2 text-xs whitespace-pre-wrap break-all bg-muted p-2 rounded">{JSON.stringify(m, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  )}

                  {findFieldResult.errors && findFieldResult.errors.length > 0 && (
                    <details className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                      <summary className="cursor-pointer text-sm text-destructive">{findFieldResult.errors.length} upstream error(s)</summary>
                      <pre className="mt-2 text-xs whitespace-pre-wrap break-all">{JSON.stringify(findFieldResult.errors, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2"><Download className="h-4 w-4" /> One-time import from Zoho CRM</CardTitle>
                  <CardDescription>
                    Bulk-import every organisation or member from Zoho CRM into iConnect using the configured field mappings. Existing iConnect values are preserved when the corresponding Zoho field is empty. The import is idempotent and safe to re-run.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runImport('organisations')}
                    disabled={importingOrgs || importingMembers || singlePreviewing || singleSyncing}
                    data-testid="button-import-organisations"
                  >
                    {importingOrgs ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                    Import organisations from Zoho
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runImport('members')}
                    disabled={importingOrgs || importingMembers || singlePreviewing || singleSyncing}
                    data-testid="button-import-members"
                  >
                    {importingMembers ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                    Import members from Zoho
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3 rounded-md border p-4">
                <div>
                  <h4 className="text-sm font-medium">Sync a single record</h4>
                  <p className="text-xs text-muted-foreground mt-1">
                    Pull one specific Zoho record through the same import pipeline. Use <span className="font-medium">Preview</span> to see exactly which fields would change without writing anything; use <span className="font-medium">Sync this record</span> to apply the changes. Useful for spot-checking before kicking off a full import.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="single-entity-type">Entity</Label>
                    <Select value={singleEntityType} onValueChange={setSingleEntityType}>
                      <SelectTrigger id="single-entity-type" className="w-[180px]" data-testid="select-single-entity-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="organization">Organisation</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 flex-1 min-w-[240px]">
                    <Label htmlFor="single-record-id">Zoho record id</Label>
                    <Input
                      id="single-record-id"
                      value={singleRecordId}
                      onChange={(e) => setSingleRecordId(e.target.value)}
                      placeholder="e.g. 5736850000001234567"
                      data-testid="input-single-record-id"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="default"
                    onClick={() => runSingleRecordImport(true)}
                    disabled={singlePreviewing || singleSyncing || importingOrgs || importingMembers || !singleRecordId.trim()}
                    data-testid="button-single-preview"
                  >
                    {singlePreviewing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
                    Preview
                  </Button>
                  <Button
                    variant="default"
                    size="default"
                    onClick={() => runSingleRecordImport(false)}
                    disabled={singlePreviewing || singleSyncing || importingOrgs || importingMembers || !singleRecordId.trim()}
                    data-testid="button-single-sync"
                  >
                    {singleSyncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                    Sync this record
                  </Button>
                </div>
                {singleError && (
                  <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="panel-single-error">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs uppercase text-muted-foreground">Result</span>
                      <Badge variant="destructive">error</Badge>
                    </div>
                    <p className="text-sm text-destructive" data-testid="text-single-error">{singleError}</p>
                  </div>
                )}
                {singleResult && (
                  <SingleRecordResult result={singleResult} entityType={singleEntityType} />
                )}
              </div>
              {(importingOrgs || importingMembers) && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-import-progress">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing {importingOrgs ? 'organisations' : 'members'} from Zoho — this can take several minutes for large tenants. Please keep this tab open.
                </div>
              )}
              {(importOrgsSummary || importMembersSummary) && (
                <div className="space-y-4">
                {importOrgsSummary && (
                  <div data-testid="text-import-orgs-summary">
                    <div className="text-xs uppercase text-muted-foreground mb-2">Organisations ({importOrgsSummary.zoho_module})</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium" data-testid="stat-orgs-processed">{importOrgsSummary.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Created</div><div className="font-medium text-green-600" data-testid="stat-orgs-created">{importOrgsSummary.created}</div></div>
                      <div><div className="text-xs text-muted-foreground">Updated</div><div className="font-medium" data-testid="stat-orgs-updated">{importOrgsSummary.updated}</div></div>
                      <div><div className="text-xs text-muted-foreground">Skipped</div><div className="font-medium" data-testid="stat-orgs-skipped">{importOrgsSummary.skipped}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive" data-testid="stat-orgs-failed">{importOrgsSummary.failed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Backfilled to Zoho</div><div className="font-medium" data-testid="stat-orgs-backfilled">{importOrgsSummary.backfilled ?? 0}</div></div>
                      <div><div className="text-xs text-muted-foreground">Backfill failed</div><div className="font-medium text-destructive" data-testid="stat-orgs-backfill-failed">{importOrgsSummary.backfill_failed ?? 0}</div></div>
                      <div><div className="text-xs text-muted-foreground">Pages</div><div className="font-medium" data-testid="stat-orgs-pages">{importOrgsSummary.pages}</div></div>
                    </div>
                    {importOrgsSummary.errors?.length > 0 && (
                      <p className="text-xs text-destructive mt-2">
                        First error: {importOrgsSummary.errors[0].error}
                      </p>
                    )}
                  </div>
                )}
                {importMembersSummary && (
                  <div data-testid="text-import-members-summary">
                    <div className="text-xs uppercase text-muted-foreground mb-2">Members ({importMembersSummary.zoho_module})</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium" data-testid="stat-members-processed">{importMembersSummary.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Created</div><div className="font-medium text-green-600" data-testid="stat-members-created">{importMembersSummary.created}</div></div>
                      <div><div className="text-xs text-muted-foreground">Updated</div><div className="font-medium" data-testid="stat-members-updated">{importMembersSummary.updated}</div></div>
                      <div><div className="text-xs text-muted-foreground">Skipped</div><div className="font-medium" data-testid="stat-members-skipped">{importMembersSummary.skipped}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive" data-testid="stat-members-failed">{importMembersSummary.failed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Backfilled to Zoho</div><div className="font-medium" data-testid="stat-members-backfilled">{importMembersSummary.backfilled ?? 0}</div></div>
                      <div><div className="text-xs text-muted-foreground">Backfill failed</div><div className="font-medium text-destructive" data-testid="stat-members-backfill-failed">{importMembersSummary.backfill_failed ?? 0}</div></div>
                      <div><div className="text-xs text-muted-foreground">Pages</div><div className="font-medium" data-testid="stat-members-pages">{importMembersSummary.pages}</div></div>
                    </div>
                    {importMembersSummary.errors?.length > 0 && (
                      <p className="text-xs text-destructive mt-2">
                        First error: {importMembersSummary.errors[0].error}
                      </p>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  See the Sync Log tab (filter by action <code>one_time_import</code>) for per-record details.
                </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Re-link Organisations to Zoho</CardTitle>
                  <CardDescription>
                    Use after switching Zoho Account modules (or any time stored Zoho record ids may be stale). Each organisation is searched in Zoho by the configured unique key, and its <code>zoho_crm_id</code> is updated. Field values are not changed — run the one-time import for that.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {(relinkCursor !== null || relinkTotals || relinkCompleted) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={resetRelinkProgress}
                      disabled={relinking}
                      data-testid="button-reset-relink"
                    >
                      Reset
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={relinkOrganisations}
                    disabled={relinking}
                    data-testid="button-relink-organisations"
                  >
                    {relinking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
                    {relinkCursor !== null && !relinkCompleted
                      ? "Continue re-link"
                      : "Re-link organisations"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            {(relinkError || relinkWarning || relinkSummary || relinkConfig || relinkTotals || relinkCompleted) && (
              <CardContent className="space-y-3">
                {relinkWarning && (
                  <div
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm flex items-start gap-2"
                    data-testid="text-relink-warning"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-medium">Re-link partially complete</div>
                      <div className="text-xs mt-0.5 break-words">{relinkWarning}</div>
                    </div>
                  </div>
                )}
                {relinkError && (
                  <div
                    className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2"
                    data-testid="text-relink-error"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-medium">Re-link failed</div>
                      <div className="text-xs mt-0.5 break-words">{relinkError}</div>
                      <div className="text-xs mt-1 text-muted-foreground">
                        Check that the organisation mapping is enabled, has a <code>unique_key_field</code> configured, and that the unique-key field is included in the field mappings.
                      </div>
                    </div>
                  </div>
                )}

                {relinkConfig && (
                  <div className="text-xs text-muted-foreground" data-testid="text-relink-config">
                    <span className="font-medium text-foreground">Configuration used:</span>{' '}
                    Zoho module <code>{relinkConfig.zoho_module}</code>, unique key{' '}
                    <code>{relinkConfig.unique_key_field}</code> paired with iConnect column{' '}
                    <code>{relinkConfig.local_key}</code>.
                  </div>
                )}

                {relinkTotals && (
                  <>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="text-xs uppercase text-muted-foreground">
                        {relinkCompleted
                          ? `Cumulative totals across ${relinkTotals.runs} run${relinkTotals.runs === 1 ? '' : 's'} — complete`
                          : `Cumulative totals across ${relinkTotals.runs} run${relinkTotals.runs === 1 ? '' : 's'} so far`}
                      </div>
                      {relinkCompleted && (
                        <Badge className="bg-green-500/20 text-green-700 border-green-500/30" data-testid="badge-relink-complete">
                          <CheckCircle2 className="h-3 w-3 mr-1" />Complete
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm" data-testid="text-relink-summary">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium">{relinkTotals.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Re-linked</div><div className="font-medium text-green-600">{relinkTotals.relinked}</div></div>
                      <div><div className="text-xs text-muted-foreground">Already linked</div><div className="font-medium">{relinkTotals.already_linked}</div></div>
                      <div><div className="text-xs text-muted-foreground">No match</div><div className="font-medium">{relinkTotals.no_match}</div></div>
                      <div><div className="text-xs text-muted-foreground">Ambiguous</div><div className="font-medium">{relinkTotals.ambiguous}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive">{relinkTotals.failed}</div></div>
                    </div>
                    {relinkTotals.skipped_no_value > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {relinkTotals.skipped_no_value} organisation(s) skipped because the local unique-key field was empty.
                      </p>
                    )}
                  </>
                )}

                {relinkSamples.length > 0 && (
                  <div className="border rounded-md">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm hover-elevate active-elevate-2"
                      onClick={() => setShowRelinkSamples(v => !v)}
                      data-testid="button-toggle-relink-samples"
                    >
                      <span className="font-medium">
                        Sample outcomes ({relinkSamples.length}{relinkSamples.length === 25 ? '+' : ''})
                      </span>
                      <span className="text-xs text-muted-foreground">{showRelinkSamples ? 'Hide' : 'Show'}</span>
                    </button>
                    {showRelinkSamples && (
                      <div className="border-t max-h-72 overflow-auto" data-testid="list-relink-samples">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Organisation</TableHead>
                              <TableHead>Local value</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Detail</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {relinkSamples.map((s, i) => (
                              <TableRow key={`${s.org_id}-${i}`} data-testid={`row-relink-sample-${s.org_id}`}>
                                <TableCell className="text-xs">{s.org_name || s.org_id?.slice(0, 8)}</TableCell>
                                <TableCell className="text-xs font-mono break-all">{String(s.local_value ?? '')}</TableCell>
                                <TableCell className="text-xs">
                                  {s.status === 'relinked' && <Badge className="bg-green-500/20 text-green-700 border-green-500/30">re-linked</Badge>}
                                  {s.status === 'already_linked' && <Badge variant="secondary">already linked</Badge>}
                                  {s.status === 'no_match' && <Badge variant="outline">no match</Badge>}
                                  {s.status === 'ambiguous' && <Badge variant="outline">ambiguous</Badge>}
                                  {s.status === 'skipped_no_value' && <Badge variant="outline">no value</Badge>}
                                  {s.status === 'failed' && <Badge variant="destructive">failed</Badge>}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground break-words">{s.message}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openRelinkLogs}
                    data-testid="button-view-relink-logs"
                  >
                    View in Sync Log
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Inbound Webhook</CardTitle>
                  <CardDescription>
                    Configure these in Zoho CRM under Setup → Automation → Workflow Rules → Webhooks. The secret authenticates inbound calls and is unique per tenant.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={regenerateSecret}
                  disabled={regeneratingSecret}
                  data-testid="button-regenerate-secret"
                >
                  {regeneratingSecret ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Regenerate secret
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loadingWebhook ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                </div>
              ) : webhookInfo ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs uppercase text-muted-foreground">Webhook URL (per Zoho module)</Label>
                    {Object.entries(webhookInfo.example_urls || {}).map(([mod, url]) => (
                      <div key={mod} className="flex items-center gap-2">
                        <Badge variant="outline" className="w-24 justify-center">{mod}</Badge>
                        <Input readOnly value={url} className="font-mono text-xs" data-testid={`input-webhook-url-${mod}`} />
                        <Button variant="ghost" size="icon" onClick={() => copyText(url)} data-testid={`button-copy-url-${mod}`}>
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs uppercase text-muted-foreground">Custom header</Label>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="w-24 justify-center">Header</Badge>
                      <Input readOnly value={webhookInfo.header_name || "X-Zoho-Webhook-Secret"} className="font-mono text-xs" data-testid="input-webhook-header" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="w-24 justify-center">Secret</Badge>
                      <Input readOnly type="password" value={webhookInfo.secret || ""} className="font-mono text-xs" data-testid="input-webhook-secret" />
                      <Button variant="ghost" size="icon" onClick={() => copyText(webhookInfo.secret || "")} data-testid="button-copy-secret">
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tip: as a fallback, you can append <code>&amp;secret=…</code> to the URL when Zoho cannot send custom headers. A reconciliation poller also runs every 15 minutes to catch missed events.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Webhook configuration unavailable.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Sync Log</CardTitle>
                  <CardDescription>
                    Most recent sync attempts. Failed attempts can be retried. <span className="font-medium">Skipped</span> rows include the reason a record was not written — open the row detail to see what to fix.
                  </CardDescription>
                  {(() => {
                    const recent = logs.filter(l => l.direction === 'inbound');
                    const inboundSkipped = recent.filter(l => l.status === 'skipped').length;
                    const inboundTotal = recent.length;
                    if (inboundTotal === 0) {
                      return (
                        <div className="mt-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5" data-testid="text-no-inbound-hint">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            No inbound sync activity recorded yet. If you expect Zoho updates to land here, check the Inbound Webhook section under Field Mapping — the Zoho-side workflow rule (or Zoho Flow) must POST to that URL with the secret header on every Account/Contact/Lead update.
                          </span>
                        </div>
                      );
                    }
                    if (inboundSkipped > 0) {
                      return (
                        <div className="mt-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5" data-testid="text-inbound-skipped-summary">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>{inboundSkipped} of the last {inboundTotal} inbound webhook calls were skipped — open the row detail to see why and adjust your mapping.</span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={logEntityFilter} onValueChange={setLogEntityFilter}>
                    <SelectTrigger className="w-[150px]" data-testid="select-log-entity-filter"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All entities</SelectItem>
                      <SelectItem value="member">Members</SelectItem>
                      <SelectItem value="organization">Organisations</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={logDirectionFilter} onValueChange={setLogDirectionFilter}>
                    <SelectTrigger className="w-[150px]" data-testid="select-log-direction-filter"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All directions</SelectItem>
                      <SelectItem value="outbound">Outbound</SelectItem>
                      <SelectItem value="inbound">Inbound</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[140px]" data-testid="select-log-status-filter"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="skipped">Skipped</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={logActionFilter} onValueChange={setLogActionFilter}>
                    <SelectTrigger className="w-[140px]" data-testid="select-log-action-filter"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      <SelectItem value="create">Create</SelectItem>
                      <SelectItem value="update">Update</SelectItem>
                      <SelectItem value="delete">Delete</SelectItem>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="relink">Relink</SelectItem>
                      <SelectItem value="import">Import</SelectItem>
                      <SelectItem value="one_time_import">One-time import (bulk)</SelectItem>
                      <SelectItem value="one_time_import_single">One-time import (single record)</SelectItem>
                      <SelectItem value="webhook">Webhook</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="icon" onClick={loadLogs} data-testid="button-refresh-logs">
                    <RefreshCw className={`h-4 w-4 ${loadingLogs ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Module</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Detail</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-6">
                          {loadingLogs ? "Loading..." : "No log entries match the current filters."}
                        </TableCell>
                      </TableRow>
                    ) : logs.map(l => (
                      <TableRow key={l.id} data-testid={`row-log-${l.id}`}>
                        <TableCell className="text-xs whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</TableCell>
                        <TableCell>{directionBadge(l.direction)}</TableCell>
                        <TableCell className="text-xs">{l.entity_type}<br /><span className="text-muted-foreground">{l.entity_id?.slice(0, 8)}…</span></TableCell>
                        <TableCell className="text-xs">{l.zoho_module || "—"}</TableCell>
                        <TableCell>
                          {l.status === "success" && <Badge className="bg-green-500/20 text-green-700 border-green-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />success</Badge>}
                          {l.status === "failed" && <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />failed</Badge>}
                          {l.status === "skipped" && <Badge variant="secondary">skipped</Badge>}
                          {l.status === "pending" && <Badge variant="outline">pending</Badge>}
                        </TableCell>
                        <TableCell className="text-xs">{l.action || "—"}</TableCell>
                        <TableCell className="text-xs max-w-xs">
                          <div className="truncate" title={l.error_message || l.zoho_record_id || ""}>
                            {l.error_message || l.zoho_record_id || "—"}
                          </div>
                          {Array.isArray(l.response_payload?.translation_warnings) && l.response_payload.translation_warnings.length > 0 && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] border-amber-500/50 text-amber-700 dark:text-amber-400"
                              data-testid={`badge-unmapped-${l.id}`}
                              title="Unmapped picklist values were forwarded as-is — open the log to see which fields"
                            >
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              {l.response_payload.translation_warnings.length} unmapped value{l.response_payload.translation_warnings.length > 1 ? 's' : ''}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setViewLog(l)} data-testid={`button-view-log-${l.id}`}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            {l.status === "failed" && l.entity_id && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={retryingId === l.id}
                                onClick={() => retryLog(l.id)}
                                data-testid={`button-retry-${l.id}`}
                              >
                                {retryingId === l.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!viewLog} onOpenChange={(o) => !o && setViewLog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sync log detail</DialogTitle>
            <DialogDescription>{viewLog && new Date(viewLog.created_at).toLocaleString()}</DialogDescription>
          </DialogHeader>
          {viewLog && (
            <div className="space-y-3 text-sm">
              <div><span className="font-medium">Entity:</span> {viewLog.entity_type} / {viewLog.entity_id}</div>
              <div><span className="font-medium">Module:</span> {viewLog.zoho_module || "—"}</div>
              <div><span className="font-medium">Status:</span> {viewLog.status}</div>
              {viewLog.zoho_record_id && <div><span className="font-medium">Zoho record:</span> {viewLog.zoho_record_id}</div>}
              {viewLog.error_message && (
                <div>
                  <div className="font-medium">Error</div>
                  <pre className="bg-muted rounded p-2 text-xs whitespace-pre-wrap">{viewLog.error_message}</pre>
                </div>
              )}
              {Array.isArray(viewLog.response_payload?.translation_warnings) && viewLog.response_payload.translation_warnings.length > 0 && (
                <div data-testid="panel-translation-warnings">
                  <div className="font-medium flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    Unmapped picklist values
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    These values were sent through unchanged because the field's value translation map didn't have an entry for them.
                    Open the field mapping and click <span className="font-medium">Translate values</span> to add a translation,
                    or update the picklist option in Zoho / iConnect to match.
                  </p>
                  <div className="border rounded-md mt-2 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-24">Direction</TableHead>
                          <TableHead>iConnect field</TableHead>
                          <TableHead>Zoho field</TableHead>
                          <TableHead>Unmapped value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {viewLog.response_payload.translation_warnings.map((w, i) => (
                          <TableRow key={`tw-${i}-${w.iconnect_field}-${w.unmapped_value}`} data-testid={`row-translation-warning-${i}`}>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {w.direction === 'iconnect_to_zoho'
                                  ? <><ArrowUp className="h-3 w-3 mr-1" />out</>
                                  : <><ArrowDown className="h-3 w-3 mr-1" />in</>}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs"><code>{w.iconnect_field}</code></TableCell>
                            <TableCell className="text-xs"><code>{w.zoho_field}</code></TableCell>
                            <TableCell className="text-xs"><code>{w.unmapped_value}</code></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
              {viewLog.request_payload && (
                <div>
                  <div className="font-medium">Request payload</div>
                  <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-60">{JSON.stringify(viewLog.request_payload, null, 2)}</pre>
                </div>
              )}
              {viewLog.response_payload && (
                <div>
                  <div className="font-medium">Response</div>
                  <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-60">{JSON.stringify(viewLog.response_payload, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!translationModal} onOpenChange={(o) => !o && setTranslationModal(null)}>
        <DialogContent className="max-w-5xl w-[95vw] flex flex-col max-h-[90vh] p-0" data-testid="dialog-value-translation">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>Value translation</DialogTitle>
            <DialogDescription>
              Map each Zoho value to its iConnect counterpart (and vice versa). Either side may be left
              blank — unmapped values pass through unchanged and a warning is recorded in the sync log.
            </DialogDescription>
          </DialogHeader>
          {translationModal && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm overflow-y-auto px-6 flex-1 min-h-0">
              <div className="space-y-2">
                <div className="font-medium">Zoho → iConnect</div>
                <div className="text-xs text-muted-foreground">
                  For each Zoho value, choose the iConnect value to write on inbound sync.
                </div>
                <div className="space-y-2">
                  {translationModal.zohoAllowed.length === 0 && (
                    <div className="text-xs text-muted-foreground">No Zoho values discovered.</div>
                  )}
                  {translationModal.zohoAllowed.map(zv => (
                    <div key={zv.value} className="flex items-center gap-2" data-testid={`row-z2i-${zv.value}`}>
                      <div className="flex-1 truncate" title={zv.label}>{zv.label}</div>
                      <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
                      <Select
                        value={translationModal.draft.zoho_to_iconnect[zv.value] || "__none__"}
                        onValueChange={(v) => setTranslationPair("zoho_to_iconnect", zv.value, v === "__none__" ? "" : v)}
                      >
                        <SelectTrigger className="flex-1" data-testid={`select-z2i-${zv.value}`}>
                          <SelectValue placeholder="(unmapped)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">(unmapped)</SelectItem>
                          {translationModal.iconnectAllowed.map(iv => (
                            <SelectItem key={iv.value} value={iv.value}>{iv.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <div className="font-medium">iConnect → Zoho</div>
                <div className="text-xs text-muted-foreground">
                  For each iConnect value, choose the Zoho value to send on outbound sync.
                </div>
                <div className="space-y-2">
                  {translationModal.iconnectAllowed.length === 0 && (
                    <div className="text-xs text-muted-foreground">No iConnect values discovered.</div>
                  )}
                  {translationModal.iconnectAllowed.map(iv => (
                    <div key={iv.value} className="flex items-center gap-2" data-testid={`row-i2z-${iv.value}`}>
                      <div className="flex-1 truncate" title={iv.label}>{iv.label}</div>
                      <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
                      <Select
                        value={translationModal.draft.iconnect_to_zoho[iv.value] || "__none__"}
                        onValueChange={(v) => setTranslationPair("iconnect_to_zoho", iv.value, v === "__none__" ? "" : v)}
                      >
                        <SelectTrigger className="flex-1" data-testid={`select-i2z-${iv.value}`}>
                          <SelectValue placeholder="(unmapped)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">(unmapped)</SelectItem>
                          {translationModal.zohoAllowed.map(zv => (
                            <SelectItem key={zv.value} value={zv.value}>{zv.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-2 border-t">
            <Button variant="outline" onClick={() => setTranslationModal(null)} data-testid="button-value-map-cancel">Cancel</Button>
            <Button onClick={saveTranslationModal} data-testid="button-value-map-save">Save</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
