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
  Copy, KeyRound, ArrowDown, ArrowUp, ArrowUpDown, Link2, Download
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
  const [showRelinkSamples, setShowRelinkSamples] = useState(false);

  // One-time import from Zoho
  const [importingOrgs, setImportingOrgs] = useState(false);
  const [importingMembers, setImportingMembers] = useState(false);
  const [importOrgsSummary, setImportOrgsSummary] = useState(null);
  const [importMembersSummary, setImportMembersSummary] = useState(null);

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

  const relinkOrganisations = async () => {
    if (!confirm("This will look up every organisation in Zoho by the configured unique key and update the stored Zoho record id. It does not change any field values. Continue?")) return;
    setRelinking(true);
    setRelinkError(null);
    try {
      const r = await fetch("/api/admin/zoho-crm-sync/relink-organisations", {
        method: "POST",
        credentials: "include"
      });
      const d = await r.json();
      if (r.ok) {
        setRelinkSummary(d.summary);
        setRelinkConfig(d.config || null);
        setRelinkSamples(Array.isArray(d.samples) ? d.samples : []);
        toast({
          title: "Re-link complete",
          description: `${d.summary.relinked} re-linked, ${d.summary.already_linked} already linked, ${d.summary.no_match} no match, ${d.summary.ambiguous} ambiguous, ${d.summary.failed} failed`
        });
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

  const copyText = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast({ title: "Copied to clipboard" }),
      () => toast({ variant: "destructive", title: "Copy failed" })
    );
  };

  useEffect(() => {
    loadMapping(entityType);
    loadIconnectFields(entityType);
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

  const loadMapping = async (et) => {
    setLoadingMapping(true);
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

  const updateMapping = (patch) => setMapping(prev => ({ ...prev, ...patch }));

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
        toast({ title: "Mapping saved", description: `${entityType} sync configuration updated` });
      } else {
        toast({ variant: "destructive", title: "Save failed", description: d.error });
      }
    } finally {
      setSavingMapping(false);
    }
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
    return [
      ...iconnectFields.core.map(f => ({ value: f.key, label: `${f.label}`, type: f.type })),
      ...iconnectFields.custom.map(f => ({ value: f.key, label: `${f.label} (custom)`, type: f.type }))
    ];
  }, [iconnectFields]);

  const writableZohoFields = useMemo(() => {
    return zohoFields.filter(f => !f.read_only);
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
                          <TableHead>Zoho Field</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(mapping?.field_mappings || []).map((row, idx) => (
                          <TableRow key={idx} data-testid={`row-mapping-${idx}`}>
                            <TableCell>
                              <Select
                                value={row.iconnect_field || ""}
                                onValueChange={(v) => {
                                  const opt = allIconnectOptions.find(o => o.value === v);
                                  updateRow(idx, { iconnect_field: v, iconnect_field_type: opt?.type });
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
                            <TableCell>
                              <Select
                                value={row.zoho_field || ""}
                                onValueChange={(v) => {
                                  const f = writableZohoFields.find(z => z.api_name === v);
                                  updateRow(idx, { zoho_field: v, zoho_field_label: f?.field_label });
                                }}
                              >
                                <SelectTrigger data-testid={`select-zoho-field-${idx}`}>
                                  <SelectValue placeholder="Select Zoho field" />
                                </SelectTrigger>
                                <SelectContent>
                                  {writableZohoFields.map(f => (
                                    <SelectItem key={f.api_name} value={f.api_name}>
                                      {f.field_label} ({f.api_name}){f.required ? " *" : ""}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
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
                        ))}
                        {(!mapping?.field_mappings || mapping.field_mappings.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">
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
                  </div>
                </>
              )}
            </CardContent>
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
                    disabled={importingOrgs || importingMembers}
                    data-testid="button-import-organisations"
                  >
                    {importingOrgs ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                    Import organisations from Zoho
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runImport('members')}
                    disabled={importingOrgs || importingMembers}
                    data-testid="button-import-members"
                  >
                    {importingMembers ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                    Import members from Zoho
                  </Button>
                </div>
              </div>
            </CardHeader>
            {(importOrgsSummary || importMembersSummary || importingOrgs || importingMembers) && (
              <CardContent className="space-y-4">
                {(importingOrgs || importingMembers) && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-import-progress">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Importing {importingOrgs ? 'organisations' : 'members'} from Zoho — this can take several minutes for large tenants. Please keep this tab open.
                  </div>
                )}
                {importOrgsSummary && (
                  <div data-testid="text-import-orgs-summary">
                    <div className="text-xs uppercase text-muted-foreground mb-2">Organisations ({importOrgsSummary.zoho_module})</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium">{importOrgsSummary.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Created</div><div className="font-medium text-green-600">{importOrgsSummary.created}</div></div>
                      <div><div className="text-xs text-muted-foreground">Updated</div><div className="font-medium">{importOrgsSummary.updated}</div></div>
                      <div><div className="text-xs text-muted-foreground">Skipped</div><div className="font-medium">{importOrgsSummary.skipped}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive">{importOrgsSummary.failed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Pages</div><div className="font-medium">{importOrgsSummary.pages}</div></div>
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
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium">{importMembersSummary.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Created</div><div className="font-medium text-green-600">{importMembersSummary.created}</div></div>
                      <div><div className="text-xs text-muted-foreground">Updated</div><div className="font-medium">{importMembersSummary.updated}</div></div>
                      <div><div className="text-xs text-muted-foreground">Skipped</div><div className="font-medium">{importMembersSummary.skipped}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive">{importMembersSummary.failed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Pages</div><div className="font-medium">{importMembersSummary.pages}</div></div>
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
              </CardContent>
            )}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={relinkOrganisations}
                  disabled={relinking}
                  data-testid="button-relink-organisations"
                >
                  {relinking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
                  Re-link organisations
                </Button>
              </div>
            </CardHeader>
            {(relinkError || relinkSummary || relinkConfig) && (
              <CardContent className="space-y-3">
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

                {relinkSummary && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm" data-testid="text-relink-summary">
                      <div><div className="text-xs text-muted-foreground">Processed</div><div className="font-medium">{relinkSummary.processed}</div></div>
                      <div><div className="text-xs text-muted-foreground">Re-linked</div><div className="font-medium text-green-600">{relinkSummary.relinked}</div></div>
                      <div><div className="text-xs text-muted-foreground">Already linked</div><div className="font-medium">{relinkSummary.already_linked}</div></div>
                      <div><div className="text-xs text-muted-foreground">No match</div><div className="font-medium">{relinkSummary.no_match}</div></div>
                      <div><div className="text-xs text-muted-foreground">Ambiguous</div><div className="font-medium">{relinkSummary.ambiguous}</div></div>
                      <div><div className="text-xs text-muted-foreground">Failed</div><div className="font-medium text-destructive">{relinkSummary.failed}</div></div>
                    </div>
                    {relinkSummary.skipped_no_value > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {relinkSummary.skipped_no_value} organisation(s) skipped because the local unique-key field was empty.
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
                        <TableCell className="text-xs max-w-xs truncate" title={l.error_message || l.zoho_record_id || ""}>
                          {l.error_message || l.zoho_record_id || "—"}
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
    </div>
  );
}
