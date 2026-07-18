import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Check } from "lucide-react";

const CREATIVITY_OPTIONS = [
  { value: "strict", label: "Strict (brand rules only)" },
  { value: "brand_led", label: "Brand-led (default)" },
  { value: "expressive", label: "Expressive" },
];

const OPERATION_LABELS = {
  generation: "Full generations",
  section_generation: "Section generations",
  edit: "Edits",
  redesign: "Redesigns",
  image_generation: "Images generated",
  image_edit: "Image edits",
  visual_review: "Visual reviews",
};

function NumberField({ id, label, value, onChange, hint }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={`input-${id}`}
        type="number"
        min="0"
        value={value === null || value === undefined ? "" : value}
        placeholder="Unlimited"
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({ id, label, checked, onChange, hint }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} data-testid={`switch-${id}`} checked={!!checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function AiDesignStudio() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(null);
  const [summary, setSummary] = useState(null);
  const [blockedCount, setBlockedCount] = useState(0);
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function loadData() {
    try {
      const resp = await fetch("/api/admin/ai-design-studio", { credentials: "include" });
      if (resp.status === 401 || resp.status === 403) { navigate("/admin/login"); return; }
      const json = await resp.json();
      if (!resp.ok) setError(json.error || "Failed to load AI Design Studio settings.");
      else {
        setSettings(json.settings);
        setSummary(json.summary);
        setBlockedCount(json.blockedCount || 0);
      }
    } catch {
      setError("Network error loading AI Design Studio settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function set(key, value) {
    setSaved(false);
    setSettings((s) => ({ ...s, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const resp = await fetch("/api/admin/ai-design-studio", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const json = await resp.json();
      if (!resp.ok) setError(json.error || "Failed to save settings.");
      else { setSettings(json.settings); setSaved(true); }
    } catch {
      setError("Network error saving settings.");
    } finally {
      setSaving(false);
    }
  }

  async function loadReport() {
    setReportLoading(true);
    try {
      const resp = await fetch("/api/admin/ai-design-studio?report=usage", { credentials: "include" });
      const json = await resp.json();
      if (resp.ok) setReport(json);
    } finally {
      setReportLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">AI Design Studio</h1>
        <p className="text-sm text-muted-foreground">
          Control how the AI Design Studio works for your organisation — allowances, creativity levels and brand guidance.
        </p>
      </div>

      {error && (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      )}

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle>This month's usage</CardTitle>
            <CardDescription>
              Estimated cost is approximate — actual provider billing may differ.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div data-testid="stat-generations">
              <p className="text-2xl font-semibold">{summary.generations}</p>
              <p className="text-xs text-muted-foreground">Generations{settings?.monthlyGenerationAllowance != null ? ` of ${settings.monthlyGenerationAllowance}` : ""}</p>
            </div>
            <div data-testid="stat-images">
              <p className="text-2xl font-semibold">{summary.images}</p>
              <p className="text-xs text-muted-foreground">Images{settings?.monthlyImageAllowance != null ? ` of ${settings.monthlyImageAllowance}` : ""}</p>
            </div>
            <div data-testid="stat-cost">
              <p className="text-2xl font-semibold">${(summary.estimatedCost || 0).toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Estimated cost</p>
            </div>
            <div data-testid="stat-blocked">
              <p className="text-2xl font-semibold">{blockedCount}</p>
              <p className="text-xs text-muted-foreground">Blocked requests</p>
            </div>
          </CardContent>
        </Card>
      )}

      {settings && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Access & creativity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ToggleRow id="enabled" label="Enable AI Design Studio" checked={settings.enabled} onChange={(v) => set("enabled", v)} hint="When off, no one in this organisation can use AI generation or editing." />
              <ToggleRow id="allowImageGeneration" label="Allow AI image generation" checked={settings.allowImageGeneration} onChange={(v) => set("allowImageGeneration", v)} />
              <ToggleRow id="allowGeneratedIllustration" label="Allow AI illustration" checked={settings.allowGeneratedIllustration} onChange={(v) => set("allowGeneratedIllustration", v)} hint="When off, the AI never draws illustration elements (photographic imagery still follows the setting above)." />
              <ToggleRow id="allowAiCopy" label="Allow AI copywriting" checked={settings.allowAiCopy} onChange={(v) => set("allowAiCopy", v)} hint="When off, the AI only reuses your existing wording and never writes new copy." />
              <ToggleRow id="requireFactualApproval" label="Require approval for factual changes" checked={settings.requireFactualApproval} onChange={(v) => set("requireFactualApproval", v)} hint="When on, changes touching prices, dates or names need an explicit confirmation before they apply." />
              <ToggleRow id="experimentalLayouts" label="Allow experimental layouts" checked={settings.experimentalLayouts} onChange={(v) => set("experimentalLayouts", v)} hint="When off, the AI sticks to conventional, proven layout patterns." />
              <div className="grid sm:grid-cols-2 gap-4 pt-2">
                <div className="space-y-1">
                  <Label>Default creativity level</Label>
                  <Select value={settings.defaultCreativity} onValueChange={(v) => set("defaultCreativity", v)}>
                    <SelectTrigger data-testid="select-default-creativity"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CREATIVITY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Permitted creativity levels</Label>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {CREATIVITY_OPTIONS.map((o) => {
                      const on = settings.permittedCreativity?.includes(o.value);
                      return (
                        <Badge
                          key={o.value}
                          variant={on ? "default" : "outline"}
                          className="cursor-pointer"
                          data-testid={`badge-creativity-${o.value}`}
                          onClick={() => {
                            const cur = settings.permittedCreativity || [];
                            const next = on ? cur.filter((c) => c !== o.value) : [...cur, o.value];
                            if (next.length > 0) set("permittedCreativity", next);
                          }}
                        >
                          {o.value.replace("_", "-")}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Usage allowances</CardTitle>
              <CardDescription>Leave a field empty for no limit.</CardDescription>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-2 gap-4">
              <NumberField id="monthlyGenerationAllowance" label="Monthly generations" value={settings.monthlyGenerationAllowance} onChange={(v) => set("monthlyGenerationAllowance", v)} />
              <NumberField id="monthlyImageAllowance" label="Monthly AI images" value={settings.monthlyImageAllowance} onChange={(v) => set("monthlyImageAllowance", v)} />
              <NumberField id="perUserHourlyLimit" label="Per-person hourly requests" value={settings.perUserHourlyLimit} onChange={(v) => set("perUserHourlyLimit", v)} />
              <NumberField id="maxPromptLength" label="Maximum prompt length (characters)" value={settings.maxPromptLength} onChange={(v) => set("maxPromptLength", v)} />
              <NumberField id="maxReviewCycles" label="Visual review correction cycles" value={settings.maxReviewCycles} onChange={(v) => set("maxReviewCycles", v)} hint="Hard-capped at 3." />
              <NumberField id="hardCostLimit" label="Monthly spend limit (USD, estimated)" value={settings.hardCostLimit} onChange={(v) => set("hardCostLimit", v)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Brand guidance</CardTitle>
              <CardDescription>
                Layered on top of your branding (colours, fonts, logos) for every AI generation.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="toneOfVoice">Tone of voice</Label>
                <Textarea id="toneOfVoice" data-testid="input-toneOfVoice" rows={2} value={settings.toneOfVoice || ""} onChange={(e) => set("toneOfVoice", e.target.value)} placeholder="e.g. Warm, plain-spoken, no jargon" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="illustrationGuidance">Illustration guidance</Label>
                <Textarea id="illustrationGuidance" data-testid="input-illustrationGuidance" rows={2} value={settings.illustrationGuidance || ""} onChange={(e) => set("illustrationGuidance", e.target.value)} placeholder="e.g. Flat, geometric shapes in brand colours" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="photographyGuidance">Photography guidance</Label>
                <Textarea id="photographyGuidance" data-testid="input-photographyGuidance" rows={2} value={settings.photographyGuidance || ""} onChange={(e) => set("photographyGuidance", e.target.value)} placeholder="e.g. Natural light, real people, no stocky poses" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="disallowedTreatments">Never use</Label>
                <Textarea id="disallowedTreatments" data-testid="input-disallowedTreatments" rows={2} value={settings.disallowedTreatments || ""} onChange={(e) => set("disallowedTreatments", e.target.value)} placeholder="e.g. Drop shadows, gradients, clip art" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="preferredExamplePages">Preferred example pages</Label>
                <Textarea id="preferredExamplePages" data-testid="input-preferredExamplePages" rows={2} value={settings.preferredExamplePages || ""} onChange={(e) => set("preferredExamplePages", e.target.value)} placeholder="e.g. /about-us, /annual-conference — pages whose layout and style the AI should take cues from" />
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving} data-testid="button-save-settings">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save settings"}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="text-saved">
                <Check className="h-4 w-4" /> Saved
              </span>
            )}
          </div>
        </>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Usage report</CardTitle>
            <CardDescription>Recent AI activity this month, by person and operation.</CardDescription>
          </div>
          <Button variant="outline" onClick={loadReport} disabled={reportLoading} data-testid="button-load-report">
            {reportLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : report ? "Refresh" : "Load report"}
          </Button>
        </CardHeader>
        {report && (
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {Object.entries(report.summary?.byOperation || {}).map(([op, n]) => (
                <Badge key={op} variant="secondary" data-testid={`badge-op-${op}`}>
                  {OPERATION_LABELS[op] || op}: {n}
                </Badge>
              ))}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(report.events || []).slice(0, 50).map((e) => (
                  <TableRow key={e.id} data-testid={`row-event-${e.id}`}>
                    <TableCell className="whitespace-nowrap text-xs">{new Date(e.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs">{report.members?.[e.member_id] || "—"}</TableCell>
                    <TableCell className="text-xs">{OPERATION_LABELS[e.operation] || e.operation}</TableCell>
                    <TableCell>
                      <Badge variant={e.status === "blocked" ? "destructive" : e.status === "failed" ? "outline" : "secondary"}>
                        {e.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">${Number(e.estimated_cost || 0).toFixed(3)}</TableCell>
                  </TableRow>
                ))}
                {(report.events || []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground">No AI activity this month.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
