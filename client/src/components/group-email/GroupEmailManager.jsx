import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { maybeEmitPlanQuotaFromBody } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Mail,
  Plus,
  Send,
  Loader2,
  TestTube2,
  Calendar as CalendarIcon,
  BarChart3,
  Trash2,
  Users,
  FileText,
  MousePointerClick,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { extractDynamicSlots } from "@/components/email-builder/types";
import { ReadOnlyBlockPreview, SlotEditContext } from "@/components/email-builder/BlockRenderer";

// design_json may be persisted as a JSON string or an object depending on the
// source (entity REST vs. campaign row). Normalize to an object (or null).
function normalizeDesign(design) {
  if (!design) return null;
  if (typeof design === "string") {
    try {
      const parsed = JSON.parse(design);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof design === "object" ? design : null;
}

// A template is "visual" (eligible for Group Email composition) when it was
// authored in the visual builder: editor_type 'visual' AND a normalizable
// design_json carrying a blocks array. Legacy plain-HTML templates fail this.
function isVisualTemplate(tpl) {
  if (!tpl) return false;
  if (tpl.editor_type !== "visual") return false;
  const design = normalizeDesign(tpl.design_json);
  return !!(design && Array.isArray(design.blocks));
}

// Replace every {{token}} occurrence in an HTML/text string with its slot value.
// Mirrors applyDynamicSlotValues in api/_lib/campaignService.js for client preview.
function fillDynamicSlots(input, slotValues) {
  if (!input || !slotValues) return input || "";
  return String(input).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, token) => {
    return Object.prototype.hasOwnProperty.call(slotValues, token)
      ? (slotValues[token] ?? "")
      : match;
  });
}

const STATUS_VARIANTS = {
  draft: "outline",
  scheduled: "secondary",
  sending: "default",
  sent: "default",
  paused: "secondary",
  cancelled: "destructive",
  failed: "destructive",
};

function formatDateTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch (_e) {
    return value;
  }
}

function blankComposeState() {
  return {
    id: null,
    name: "",
    subject: "",
    from_name: "",
    preheader: "",
    html_content: "",
    design_json: null,
    template_id: "",
    slotValues: {},
    hiddenSlots: [],
    audience_roles: [],
  };
}

/**
 * Self-contained Group Email campaign manager scoped to a single member group.
 *
 * Encapsulates the campaign list (with per-campaign send stats), the
 * create/edit compose dialog, the test-send dialog, and the per-campaign
 * stats dialog. All endpoints and behavior are identical to the standalone
 * /GroupEmail page — only the group-selection dropdown lives outside this
 * component, so the same UI can be embedded on a member group's detail page
 * with the group pre-selected.
 *
 * Props:
 *  - group: the qualifying-group entry { id, name, roles, callerRole }.
 *  - heading: optional node/string for the section heading.
 *  - showRoleBadge: when true, renders the caller's role badge in the header.
 */
export default function GroupEmailManager({ group, heading = "Email campaigns", showRoleBadge = true }) {
  const { memberInfo } = useMemberAccess();
  const queryClient = useQueryClient();

  const activeGroup = group || null;
  const activeGroupId = activeGroup?.id || null;

  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState(blankComposeState());
  const [recipientPreview, setRecipientPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testEmails, setTestEmails] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [statsCampaign, setStatsCampaign] = useState(null);
  const previewDebounceRef = useRef(null);

  const { data: campaigns = [], isLoading: loadingCampaigns, refetch: refetchCampaigns } = useQuery({
    queryKey: ["member-campaigns", "list", activeGroupId],
    queryFn: async () => {
      const res = await fetch(`/api/member-campaigns?groupId=${activeGroupId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load campaigns");
      const data = await res.json();
      return data.campaigns || [];
    },
    enabled: !!activeGroupId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (Array.isArray(data) && data.some((c) => c.status === "sending" || c.status === "preparing")) {
        return 5000;
      }
      return false;
    },
  });

  const { data: emailTemplates = [], isLoading: loadingTemplates } = useQuery({
    queryKey: ["email-templates", "for-group-email"],
    queryFn: async () => {
      const list = await base44.entities.EmailTemplate.list("-created_at");
      return Array.isArray(list) ? list : [];
    },
    enabled: composeOpen,
  });

  // Group Email only composes against visual-builder templates: editor_type
  // 'visual' AND a usable design_json with blocks. Legacy plain-HTML templates
  // are intentionally excluded from the picker (they have no fill-in slots and
  // belong to the ReactQuill flow in EmailTemplateManagement).
  const visualTemplates = emailTemplates.filter(isVisualTemplate);

  const applyTemplateToCompose = (templateId) => {
    if (!templateId) {
      setCompose((prev) => ({
        ...prev,
        template_id: "",
        design_json: null,
        slotValues: {},
        hiddenSlots: [],
        html_content: "",
      }));
      return;
    }
    const tpl = emailTemplates.find((t) => String(t.id) === String(templateId));
    if (!tpl) return;
    const design = normalizeDesign(tpl.design_json);
    const slots = design ? extractDynamicSlots(design) : [];
    const slotValues = {};
    slots.forEach((s) => {
      slotValues[s.token] = s.defaultValue ?? "";
      if (s.linkToken) slotValues[s.linkToken] = s.defaultLink ?? "";
    });
    setCompose((prev) => ({
      ...prev,
      template_id: String(templateId),
      design_json: design,
      slotValues,
      hiddenSlots: [],
      html_content: tpl.body || "",
      subject: prev.subject || tpl.subject || "",
    }));
  };

  const openCompose = async (campaign = null) => {
    if (campaign) {
      // The list endpoint only returns summary fields, so hydrate the full
      // editable record (html_content, design_json, from_name, preheader,
      // target_audiences) before opening the editor — otherwise a save
      // would clobber those fields with empty strings.
      let full = campaign;
      try {
        const res = await fetch(`/api/member-campaigns/${campaign.id}`, { credentials: "include" });
        if (res.ok) {
          full = await res.json();
        } else {
          toast.error("Failed to load draft for editing");
          return;
        }
      } catch (_e) {
        toast.error("Failed to load draft for editing");
        return;
      }

      const segment = Array.isArray(full.target_audiences) ? full.target_audiences[0] : null;
      const design = normalizeDesign(full.design_json);
      const savedSlotValues = (design && design.slotValues && typeof design.slotValues === "object")
        ? design.slotValues
        : {};
      // Ensure every slot present in the design has an entry (new slots fall back
      // to their design-time default). Text/image slots use `token`; buttons also
      // carry a `linkToken` for the link URL.
      const slotValues = {};
      const validTokens = new Set();
      if (design) {
        extractDynamicSlots(design).forEach((s) => {
          validTokens.add(s.token);
          slotValues[s.token] = Object.prototype.hasOwnProperty.call(savedSlotValues, s.token)
            ? savedSlotValues[s.token]
            : (s.defaultValue ?? "");
          if (s.linkToken) {
            validTokens.add(s.linkToken);
            slotValues[s.linkToken] = Object.prototype.hasOwnProperty.call(savedSlotValues, s.linkToken)
              ? savedSlotValues[s.linkToken]
              : (s.defaultLink ?? "");
          }
        });
      }
      const savedHidden = (design && Array.isArray(design.hiddenSlots)) ? design.hiddenSlots : [];
      const hiddenSlots = savedHidden.filter((t) => validTokens.has(t));
      setCompose({
        id: full.id,
        name: full.name || "",
        subject: full.subject || "",
        from_name: full.from_name || activeGroup?.name || "",
        preheader: full.preheader || "",
        html_content: full.html_content || "",
        design_json: design,
        template_id: full.email_template_id ? String(full.email_template_id) : "",
        slotValues,
        hiddenSlots,
        audience_roles: segment && Array.isArray(segment.roles) ? segment.roles : [],
      });
    } else {
      setCompose({
        ...blankComposeState(),
        from_name: activeGroup?.name || "",
      });
    }
    setRecipientPreview(null);
    setScheduledAt("");
    setComposeOpen(true);
  };

  // Debounced recipient preview whenever audience roles change.
  useEffect(() => {
    if (!composeOpen || !activeGroupId) return;
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(async () => {
      try {
        setPreviewLoading(true);
        const res = await fetch("/api/member-campaigns/send", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaignId: "preview",
            preview: true,
            groupId: activeGroupId,
            audienceRoles: compose.audience_roles,
          }),
        });
        if (!res.ok) throw new Error("Preview failed");
        const data = await res.json();
        setRecipientPreview(data);
      } catch (err) {
        setRecipientPreview({ recipientCount: null, error: err.message });
      } finally {
        setPreviewLoading(false);
      }
    }, 250);
    return () => previewDebounceRef.current && clearTimeout(previewDebounceRef.current);
  }, [composeOpen, activeGroupId, compose.audience_roles]);

  const saveDraft = async () => {
    if (!compose.name.trim() || !compose.subject.trim()) {
      toast.error("Name and subject are required.");
      return null;
    }
    // Content can only come from a selected template, so an empty body means no
    // template has been chosen yet. Legacy drafts already carry html_content and
    // therefore stay editable/sendable without re-selecting a template.
    if (!compose.html_content || !compose.html_content.trim()) {
      toast.error("Please choose an email template.");
      return null;
    }
    const isUpdate = !!compose.id;
    const url = isUpdate ? `/api/member-campaigns/${compose.id}` : "/api/member-campaigns";
    const method = isUpdate ? "PATCH" : "POST";
    // Fold the per-send slot values into the design so the server can inject
    // them at send time (parseCampaignDesign reads design_json.slotValues).
    const designToSave = compose.design_json
      ? { ...compose.design_json, slotValues: compose.slotValues || {}, hiddenSlots: compose.hiddenSlots || [] }
      : null;
    const body = isUpdate
      ? {
          name: compose.name,
          subject: compose.subject,
          from_name: compose.from_name,
          preheader: compose.preheader,
          html_content: compose.html_content,
          design_json: designToSave,
          email_template_id: compose.template_id || null,
          audience_roles: compose.audience_roles,
        }
      : {
          groupId: activeGroupId,
          name: compose.name,
          subject: compose.subject,
          from_name: compose.from_name,
          preheader: compose.preheader,
          html_content: compose.html_content,
          design_json: designToSave,
          email_template_id: compose.template_id || null,
          audience_roles: compose.audience_roles,
        };

    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to save draft");
      return null;
    }
    const saved = await res.json();
    setCompose((prev) => ({ ...prev, id: saved.id }));
    queryClient.invalidateQueries({ queryKey: ["member-campaigns", "list", activeGroupId] });
    return saved;
  };

  const handleSaveDraft = async () => {
    const saved = await saveDraft();
    if (saved) toast.success("Draft saved");
  };

  const handleSendNow = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    if (!confirm(`Send to ${recipientPreview?.recipientCount ?? "all qualifying"} recipients?`)) return;
    setSending(true);
    try {
      const res = await fetch("/api/member-campaigns/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: saved.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        maybeEmitPlanQuotaFromBody(data);
        throw new Error(data.error || "Failed to send");
      }
      toast.success(data.message || "Campaign sending");
      setComposeOpen(false);
      refetchCampaigns();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleSchedule = async () => {
    if (!scheduledAt) {
      toast.error("Pick a date and time first.");
      return;
    }
    const saved = await saveDraft();
    if (!saved) return;
    setScheduling(true);
    try {
      const res = await fetch("/api/member-campaigns/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: saved.id, scheduledAt: new Date(scheduledAt).toISOString() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        maybeEmitPlanQuotaFromBody(data);
        throw new Error(data.error || "Failed to schedule");
      }
      toast.success("Scheduled");
      setComposeOpen(false);
      refetchCampaigns();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setScheduling(false);
    }
  };

  const handleTestSend = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    const list = (testEmails || memberInfo?.email || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) {
      toast.error("Enter at least one address.");
      return;
    }
    setTestSending(true);
    try {
      const res = await fetch("/api/member-campaigns/test-send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: saved.id, testEmails: list }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to send test");
      toast.success(data.message || "Test sent");
      setTestDialogOpen(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTestSending(false);
    }
  };

  const handleDelete = async (campaign) => {
    if (!confirm(`Delete draft "${campaign.name}"?`)) return;
    const res = await fetch(`/api/member-campaigns/${campaign.id}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to delete");
      return;
    }
    toast.success("Deleted");
    refetchCampaigns();
  };

  const toggleAudienceRole = (role) => {
    const set = new Set(compose.audience_roles || []);
    if (set.has(role)) set.delete(role);
    else set.add(role);
    setCompose({ ...compose, audience_roles: Array.from(set) });
  };

  // Click-to-edit context for the interactive campaign preview. The dynamic
  // block previews (BlockRenderer) read this off SlotEditContext to render the
  // filled-in value with inline editing + a hide toggle.
  const changeSlotValue = (token, value) =>
    setCompose((prev) => ({ ...prev, slotValues: { ...(prev.slotValues || {}), [token]: value } }));
  const toggleHiddenSlot = (token) =>
    setCompose((prev) => {
      const set = new Set(prev.hiddenSlots || []);
      if (set.has(token)) set.delete(token);
      else set.add(token);
      return { ...prev, hiddenSlots: Array.from(set) };
    });
  const slotEditCtx = {
    slotValues: compose.slotValues || {},
    hiddenSlots: compose.hiddenSlots || [],
    onChangeSlot: changeSlotValue,
    onToggleHidden: toggleHiddenSlot,
  };
  const composeSlots = compose.design_json ? extractDynamicSlots(compose.design_json) : [];
  const hiddenCount = (compose.hiddenSlots || []).length;

  if (!activeGroupId) return null;

  return (
    <div className="space-y-4" data-testid="group-email-manager">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Mail className="w-5 h-5 text-slate-600" />
          <h2 className="text-lg font-semibold text-slate-900" data-testid="text-group-email-heading">
            {heading}
          </h2>
          {showRoleBadge && activeGroup?.callerRole && (
            <Badge variant="outline" data-testid="badge-caller-role">{activeGroup.callerRole}</Badge>
          )}
        </div>
        <Button onClick={() => openCompose(null)} data-testid="button-new-campaign">
          <Plus className="w-4 h-4 mr-2" /> New campaign
        </Button>
      </div>

      {loadingCampaigns ? (
        <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : campaigns.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground" data-testid="empty-campaigns">
          No campaigns yet. Click "New campaign" to compose one.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Opened</TableHead>
              <TableHead className="text-right">Clicked</TableHead>
              <TableHead className="text-right">Bounced</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={c.id} data-testid={`row-member-campaign-${c.id}`}>
                <TableCell>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground truncate max-w-[260px]">{c.subject}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant={STATUS_VARIANTS[c.status] || "outline"}>{c.status}</Badge>
                    {c.status === "scheduled" && c.scheduled_at && (
                      <span className="text-xs text-muted-foreground">{formatDateTime(c.scheduled_at)}</span>
                    )}
                    {c.status === "sent" && c.sent_at && (
                      <span className="text-xs text-muted-foreground">{formatDateTime(c.sent_at)}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">{c.sent_count || 0}/{c.total_recipients || 0}</TableCell>
                <TableCell className="text-right">{c.opened_count || 0}</TableCell>
                <TableCell className="text-right">{c.clicked_count || 0}</TableCell>
                <TableCell className="text-right">{c.bounced_count || 0}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1 flex-wrap">
                    {c.status === "draft" && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openCompose(c)} data-testid={`button-edit-${c.id}`}>
                          Edit
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(c)} data-testid={`button-delete-${c.id}`}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {(c.status === "sent" || c.status === "sending") && (
                      <Button size="sm" variant="ghost" onClick={() => setStatsCampaign(c)} data-testid={`button-stats-${c.id}`}>
                        <BarChart3 className="w-4 h-4 mr-1" /> Stats
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="max-w-[95vw] w-[1150px] max-h-[92vh] p-0 gap-0 overflow-hidden flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-4 border-b">
            <DialogTitle>{compose.id ? "Edit campaign" : "New campaign"}</DialogTitle>
            <DialogDescription>
              Audience is locked to <strong>{activeGroup?.name}</strong>. Optionally narrow by role.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-2 flex-1 min-h-0 overflow-hidden">
            {/* Left column: campaign settings */}
            <div className="overflow-y-auto px-6 py-5 space-y-4 lg:border-r">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="campaign-name">Internal name *</Label>
                  <Input id="campaign-name" value={compose.name} onChange={(e) => setCompose({ ...compose, name: e.target.value })} data-testid="input-campaign-name" />
                </div>
                <div>
                  <Label htmlFor="campaign-subject">Subject *</Label>
                  <Input id="campaign-subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} data-testid="input-campaign-subject" />
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="from-name">From name</Label>
                  <Input id="from-name" value={compose.from_name} onChange={(e) => setCompose({ ...compose, from_name: e.target.value })} data-testid="input-from-name" />
                  <p className="text-xs text-muted-foreground mt-1">
                    Sender address is fixed to your tenant's verified email address — set by your admin.
                  </p>
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="preheader">Preheader (optional)</Label>
                  <Input id="preheader" value={compose.preheader} onChange={(e) => setCompose({ ...compose, preheader: e.target.value })} data-testid="input-preheader" />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="template-select">Email template *</Label>
                <Select
                  value={compose.template_id || ""}
                  onValueChange={(v) => applyTemplateToCompose(v)}
                >
                  <SelectTrigger id="template-select" data-testid="select-email-template">
                    <SelectValue placeholder={loadingTemplates ? "Loading templates…" : "Choose a template"} />
                  </SelectTrigger>
                  <SelectContent>
                    {visualTemplates.length === 0 && !loadingTemplates && (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No visual templates available.</div>
                    )}
                    {visualTemplates.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)} data-testid={`option-template-${t.id}`}>
                        {t.name || t.subject || "Untitled template"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Pick one of your tenant's email templates. Templates built with the visual builder let you fill in or hide dynamic content directly in the preview.
                </p>
              </div>

              {composeSlots.length > 0 && (
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2" data-testid="hint-dynamic-editing">
                  <MousePointerClick className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    This template has {composeSlots.length} dynamic {composeSlots.length === 1 ? "element" : "elements"}. Click any highlighted area in the preview to edit it, or use its hide control to remove it from the sent email.
                    {hiddenCount > 0 && (
                      <> <strong>{hiddenCount}</strong> currently hidden.</>
                    )}
                  </span>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Label>Audience filter (optional)</Label>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {previewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> :
                      recipientPreview?.recipientCount != null ? `${recipientPreview.recipientCount} recipients` : "—"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave empty to email everyone in the group. Otherwise, only members with one of the selected roles will be emailed.
                </p>
                <div className="flex flex-wrap gap-2">
                  {(activeGroup?.roles || []).map((r) => {
                    const checked = (compose.audience_roles || []).includes(r);
                    return (
                      <label key={r} className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-sm cursor-pointer hover-elevate"
                        data-testid={`label-audience-role-${r}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAudienceRole(r)}
                          className="w-4 h-4"
                          data-testid={`checkbox-audience-role-${r}`}
                        />
                        <span>{r}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col md:flex-row md:items-end gap-3 border-t pt-4">
                <div className="flex-1">
                  <Label htmlFor="schedule-at">Schedule for</Label>
                  <Input id="schedule-at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} data-testid="input-schedule-at" />
                </div>
                <Button variant="outline" onClick={handleSchedule} disabled={scheduling || !scheduledAt} data-testid="button-schedule">
                  {scheduling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CalendarIcon className="w-4 h-4 mr-2" />}
                  Schedule
                </Button>
              </div>
            </div>

            {/* Right column: interactive preview */}
            <div className="overflow-y-auto bg-muted/40 px-6 py-5">
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <Label className="m-0">Preview</Label>
              </div>
              {compose.design_json ? (
                <SlotEditContext.Provider value={slotEditCtx}>
                  <div className="rounded-md overflow-hidden bg-white shadow-sm" data-testid="interactive-compose-preview">
                    <ReadOnlyBlockPreview
                      blocks={compose.design_json.blocks}
                      globalStyles={compose.design_json.globalStyles}
                    />
                  </div>
                </SlotEditContext.Provider>
              ) : compose.html_content ? (
                <div className="border rounded-md overflow-hidden bg-white">
                  <iframe
                    srcDoc={fillDynamicSlots(compose.html_content, compose.slotValues)}
                    title="Email preview"
                    className="w-full border-0"
                    style={{ minHeight: 400 }}
                    sandbox="allow-same-origin"
                    data-testid="iframe-compose-preview"
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground" style={{ minHeight: 400 }} data-testid="text-no-preview">
                  Choose a template to see a preview.
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2 px-6 py-4 border-t">
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" onClick={() => setComposeOpen(false)} data-testid="button-cancel-compose">Cancel</Button>
              <Button variant="outline" onClick={handleSaveDraft} data-testid="button-save-draft">Save draft</Button>
              <Button variant="outline" onClick={() => setTestDialogOpen(true)} data-testid="button-test-send">
                <TestTube2 className="w-4 h-4 mr-2" /> Test send
              </Button>
            </div>
            <Button onClick={handleSendNow} disabled={sending} data-testid="button-send-now">
              {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
              Send now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a test</DialogTitle>
            <DialogDescription>Up to 5 comma-separated addresses. Defaults to your own.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="test-emails">Test recipients</Label>
            <Textarea
              id="test-emails"
              rows={2}
              value={testEmails}
              onChange={(e) => setTestEmails(e.target.value)}
              placeholder={memberInfo?.email || "you@example.com"}
              data-testid="input-test-emails"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleTestSend} disabled={testSending} data-testid="button-confirm-test-send">
              {testSending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
              Send test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StatsDialog campaign={statsCampaign} onClose={() => setStatsCampaign(null)} />
    </div>
  );
}

const RECIPIENT_STATUS_VARIANTS = {
  pending: "outline",
  queued: "outline",
  sent: "secondary",
  delivered: "secondary",
  opened: "default",
  clicked: "default",
  bounced: "destructive",
  failed: "destructive",
  unsubscribed: "destructive",
  complained: "destructive",
};

function StatsDialog({ campaign, onClose }) {
  const open = !!campaign;
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) { setFilter("all"); setSearch(""); }
  }, [open]);

  const { data: statsData, isLoading: loadingStats } = useQuery({
    queryKey: ["member-campaigns", "stats", campaign?.id],
    queryFn: async () => {
      const res = await fetch(`/api/member-campaigns/${campaign.id}?stats=true`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    enabled: open,
  });

  const { data: recipientsData, isLoading: loadingRecipients } = useQuery({
    queryKey: ["member-campaigns", "recipients", campaign?.id],
    queryFn: async () => {
      const res = await fetch(`/api/member-campaigns/${campaign.id}?recipients=true`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load recipients");
      return res.json();
    },
    enabled: open,
  });

  const stats = statsData?.stats || {};
  const recipients = recipientsData?.recipients || [];

  const filteredRecipients = useMemo(() => {
    return recipients.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (search.trim() && !(r.email || "").toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [recipients, filter, search]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Campaign stats</DialogTitle>
          <DialogDescription>{campaign?.name}</DialogDescription>
        </DialogHeader>

        {loadingStats ? (
          <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              ["Recipients", stats.total ?? campaign?.total_recipients ?? 0],
              ["Sent", stats.sent ?? campaign?.sent_count ?? 0],
              ["Delivered", stats.delivered ?? campaign?.delivered_count ?? 0],
              ["Opened", stats.opened ?? campaign?.opened_count ?? 0],
              ["Clicked", stats.clicked ?? campaign?.clicked_count ?? 0],
              ["Bounced", stats.bounced ?? campaign?.bounced_count ?? 0],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent className="p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-xl font-semibold" data-testid={`stat-${label.toLowerCase()}`}>{value}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Card className="mt-4">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm">Per-recipient detail</CardTitle>
            <Badge variant="outline">{filteredRecipients.length} of {recipients.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Search email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
                data-testid="input-recipient-search"
              />
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="w-44" data-testid="select-recipient-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="delivered">Delivered</SelectItem>
                  <SelectItem value="opened">Opened</SelectItem>
                  <SelectItem value="clicked">Clicked</SelectItem>
                  <SelectItem value="bounced">Bounced</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
                  <SelectItem value="complained">Complained</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {loadingRecipients ? (
              <div className="py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : filteredRecipients.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground" data-testid="empty-recipients">
                No recipients match this view.
              </div>
            ) : (
              <div className="border rounded-md max-h-80 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Opens</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRecipients.map((r) => (
                      <TableRow key={r.id} data-testid={`row-recipient-${r.id}`}>
                        <TableCell className="font-mono text-xs">{r.email}</TableCell>
                        <TableCell>
                          <Badge variant={RECIPIENT_STATUS_VARIANTS[r.status] || "outline"}>{r.status || "pending"}</Badge>
                          {r.error_message && (
                            <div className="text-xs text-destructive mt-1 truncate max-w-[260px]" title={r.error_message}>
                              {r.error_message}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{r.open_count || 0}</TableCell>
                        <TableCell className="text-right">{r.click_count || 0}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-close-stats">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
