import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  Eye,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

const quillModules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: [] }],
    ["link"],
    ["clean"],
  ],
};
const quillFormats = [
  "header",
  "bold", "italic", "underline", "strike",
  "color", "background",
  "list", "bullet",
  "align",
  "link",
];

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
    audience_roles: [],
  };
}

export default function GroupEmailPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState(null);
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

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-email")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: qualifying = [], isLoading: loadingGroups, isError: groupsError } = useQuery({
    queryKey: ["member-campaigns", "qualifying-groups"],
    queryFn: async () => {
      const res = await fetch("/api/member-campaigns/qualifying-groups", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 403) return [];
        throw new Error("Failed to load groups");
      }
      const data = await res.json();
      return data.groups || [];
    },
    enabled: accessChecked,
  });

  useEffect(() => {
    if (qualifying.length > 0 && !activeGroupId) {
      setActiveGroupId(qualifying[0].id);
    }
  }, [qualifying, activeGroupId]);

  // Hard-redirect non-qualifying members away from /GroupEmail — the task
  // spec requires the page be invisible to anyone without permission, and
  // any direct URL navigation should bounce.
  useEffect(() => {
    if (accessChecked && !loadingGroups && !groupsError && qualifying.length === 0) {
      toast.error("You don't have permission to send group emails.");
      const redirectTimer = setTimeout(() => {
        window.location.href = createPageUrl("MemberGroups");
      }, 1200);
      return () => clearTimeout(redirectTimer);
    }
  }, [accessChecked, loadingGroups, groupsError, qualifying.length]);

  const activeGroup = useMemo(
    () => qualifying.find((g) => g.id === activeGroupId) || null,
    [qualifying, activeGroupId]
  );

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
      setCompose({
        id: full.id,
        name: full.name || "",
        subject: full.subject || "",
        from_name: full.from_name || activeGroup?.name || "",
        preheader: full.preheader || "",
        html_content: full.html_content || "",
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
    const isUpdate = !!compose.id;
    const url = isUpdate ? `/api/member-campaigns/${compose.id}` : "/api/member-campaigns";
    const method = isUpdate ? "PATCH" : "POST";
    const body = isUpdate
      ? {
          name: compose.name,
          subject: compose.subject,
          from_name: compose.from_name,
          preheader: compose.preheader,
          html_content: compose.html_content,
          audience_roles: compose.audience_roles,
        }
      : {
          groupId: activeGroupId,
          name: compose.name,
          subject: compose.subject,
          from_name: compose.from_name,
          preheader: compose.preheader,
          html_content: compose.html_content,
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

  if (!accessChecked || loadingGroups) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (qualifying.length === 0) {
    // Redirect handled above; render a brief blocking placeholder to avoid
    // a flash of empty-state content.
    return (
      <div className="p-8 flex items-center justify-center" data-testid="redirect-no-access">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" data-testid="page-group-email">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Mail className="w-5 h-5" /> Group Email
          </h1>
          <p className="text-sm text-muted-foreground">Email the members of your group.</p>
        </div>
        <div className="flex items-center gap-2">
          {qualifying.length > 1 && (
            <Select value={activeGroupId || ""} onValueChange={setActiveGroupId}>
              <SelectTrigger className="w-64" data-testid="select-active-group">
                <SelectValue placeholder="Choose a group..." />
              </SelectTrigger>
              <SelectContent>
                {qualifying.map((g) => (
                  <SelectItem key={g.id} value={g.id} data-testid={`option-group-${g.id}`}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={() => openCompose(null)} data-testid="button-new-campaign">
            <Plus className="w-4 h-4 mr-2" /> New campaign
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-base">
            {activeGroup ? activeGroup.name : "Campaigns"} <span className="text-xs text-muted-foreground font-normal">— your campaigns only</span>
          </CardTitle>
          <Badge variant="outline" data-testid="badge-caller-role">{activeGroup?.callerRole}</Badge>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{compose.id ? "Edit campaign" : "New campaign"}</DialogTitle>
            <DialogDescription>
              Audience is locked to <strong>{activeGroup?.name}</strong>. Optionally narrow by role.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
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

            <div>
              <Label className="mb-1 block">Body</Label>
              <ReactQuill
                theme="snow"
                value={compose.html_content}
                onChange={(html) => setCompose({ ...compose, html_content: html })}
                modules={quillModules}
                formats={quillFormats}
                style={{ minHeight: 240 }}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
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

          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
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
