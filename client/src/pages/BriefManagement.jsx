import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Search,
  Plus,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  Pencil,
  Eye,
  Trash2,
  XCircle,
  ArrowUpDown,
  Paperclip,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import MemberCombobox from "@/components/MemberCombobox";

const STATUS_CONFIG = {
  new: { label: "New", color: "#6b7280", icon: Clock },
  assigned: { label: "Assigned", color: "#3b82f6", icon: FileText },
  in_progress: { label: "In Progress", color: "#f59e0b", icon: Pencil },
  under_review: { label: "Under Review", color: "#a855f7", icon: Eye },
  changes_requested: { label: "Changes Requested", color: "#f97316", icon: AlertCircle },
  approved: { label: "Approved", color: "#22c55e", icon: CheckCircle },
  rejected: { label: "Rejected", color: "#ef4444", icon: XCircle },
};

const PRIORITY_CONFIG = {
  low: { label: "Low", color: "#6b7280" },
  medium: { label: "Medium", color: "#3b82f6" },
  high: { label: "High", color: "#f59e0b" },
  urgent: { label: "Urgent", color: "#ef4444" },
};

const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "deadline_asc", label: "Deadline (Earliest)" },
  { value: "deadline_desc", label: "Deadline (Latest)" },
  { value: "priority_desc", label: "Priority (Highest)" },
];

const PRIORITY_ORDER = { urgent: 4, high: 3, medium: 2, low: 1 };

function StatCard({ title, value, icon: Icon, color }) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold" data-testid={`stat-value-${title.toLowerCase().replace(/\s+/g, "-")}`}>{value}</p>
          </div>
          <div className="p-3 rounded-full" style={{ backgroundColor: `${color}20` }}>
            <Icon className="w-6 h-6" style={{ color }} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BriefManagementPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { isAccessReady, memberInfo, isFeatureExcluded } = useMemberAccess();

  const canManage = !isFeatureExcluded("content.briefs.manage");
  const canAssign = !isFeatureExcluded("content.briefs.assign");
  const canDelete = !isFeatureExcluded("content.briefs.delete");

  const initialView = searchParams.get("view") || "all";

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [writerFilter, setWriterFilter] = useState("all");
  const [reviewerFilter, setReviewerFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [activeView, setActiveView] = useState(initialView);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [briefToDelete, setBriefToDelete] = useState(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const attachmentInputRef = useRef(null);

  const emptyBrief = {
    title: "", summary: "", instructions: "", target_audience: "",
    tone_guidance: "", word_count_target: "", deadline: "", priority: "medium",
    category: "", notes: "", assigned_writer_id: "", review_owner_id: "",
    assignment_note: "", attachments: [],
  };
  const [newBrief, setNewBrief] = useState(emptyBrief);

  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ["article-briefs"],
    queryFn: async () => {
      return await base44.entities.ArticleBrief.list();
    },
    enabled: isAccessReady,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["members-list-brief"],
    queryFn: async () => {
      return await base44.entities.Member.list();
    },
    enabled: isAccessReady,
  });

  const { data: allVersions = [] } = useQuery({
    queryKey: ["article-brief-versions-all"],
    queryFn: async () => {
      return await base44.entities.ArticleBriefVersion.list();
    },
    enabled: isAccessReady,
  });

  const latestVersionByBrief = useMemo(() => {
    const map = {};
    allVersions.forEach((v) => {
      const existing = map[v.article_brief_id];
      if (!existing || v.version_number > existing.version_number) {
        map[v.article_brief_id] = v;
      }
    });
    return map;
  }, [allVersions]);

  const membersById = useMemo(() => {
    const map = {};
    members.forEach((m) => { map[m.id] = m; });
    return map;
  }, [members]);

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ArticleBrief.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setCreateDialogOpen(false);
      setNewBrief(emptyBrief);
      toast.success("Brief created successfully");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create brief");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.ArticleBrief.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setBriefToDelete(null);
      toast.success("Brief deleted");
    },
    onError: () => {
      toast.error("Failed to delete brief");
    },
  });

  const stats = useMemo(() => {
    const total = briefs.length;
    const byStatus = {};
    briefs.forEach((b) => {
      byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    });
    return {
      total,
      inProgress: (byStatus["in_progress"] || 0) + (byStatus["assigned"] || 0),
      underReview: byStatus["under_review"] || 0,
      approved: byStatus["approved"] || 0,
    };
  }, [briefs]);

  const uniqueWriters = useMemo(() => {
    const ids = new Set();
    briefs.forEach((b) => { if (b.assigned_writer_id) ids.add(b.assigned_writer_id); });
    return Array.from(ids).map((id) => ({ id, name: getMemberName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [briefs, membersById]);

  const uniqueReviewers = useMemo(() => {
    const ids = new Set();
    briefs.forEach((b) => { if (b.review_owner_id) ids.add(b.review_owner_id); });
    return Array.from(ids).map((id) => ({ id, name: getMemberName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [briefs, membersById]);

  const filteredAndSorted = useMemo(() => {
    let filtered = briefs;

    if (activeView === "my_briefs" && memberInfo?.id) {
      filtered = filtered.filter((b) => b.assigned_writer_id === memberInfo.id);
    } else if (activeView === "review_queue" && memberInfo?.id) {
      filtered = filtered.filter(
        (b) => b.review_owner_id === memberInfo.id && (b.status === "under_review" || b.status === "changes_requested")
      );
    }

    if (statusFilter !== "all") {
      filtered = filtered.filter((b) => b.status === statusFilter);
    }
    if (priorityFilter !== "all") {
      filtered = filtered.filter((b) => b.priority === priorityFilter);
    }
    if (writerFilter !== "all") {
      if (writerFilter === "__unassigned__") {
        filtered = filtered.filter((b) => !b.assigned_writer_id);
      } else {
        filtered = filtered.filter((b) => b.assigned_writer_id === writerFilter);
      }
    }
    if (reviewerFilter !== "all") {
      if (reviewerFilter === "__unassigned__") {
        filtered = filtered.filter((b) => !b.review_owner_id);
      } else {
        filtered = filtered.filter((b) => b.review_owner_id === reviewerFilter);
      }
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (b) =>
          b.title?.toLowerCase().includes(query) ||
          b.summary?.toLowerCase().includes(query) ||
          b.category?.toLowerCase().includes(query)
      );
    }

    const sorted = [...filtered];
    switch (sortBy) {
      case "newest":
        sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
        break;
      case "deadline_asc":
        sorted.sort((a, b) => {
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(a.deadline) - new Date(b.deadline);
        });
        break;
      case "deadline_desc":
        sorted.sort((a, b) => {
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(b.deadline) - new Date(a.deadline);
        });
        break;
      case "priority_desc":
        sorted.sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0));
        break;
      default:
        break;
    }
    return sorted;
  }, [briefs, activeView, memberInfo, statusFilter, priorityFilter, writerFilter, reviewerFilter, searchQuery, sortBy]);

  const handleAttachmentUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentUploading(true);
    try {
      const result = await uploadFileWithProgress(file, {
        type: UPLOAD_TYPES.ATTACHMENT,
        isPrivate: true,
      });
      setNewBrief((p) => ({
        ...p,
        attachments: [...(p.attachments || []), { file_url: result.file_url, file_name: file.name, size: file.size }],
      }));
      toast.success("File attached");
    } catch (err) {
      toast.error(err.message || "Failed to upload attachment");
    } finally {
      setAttachmentUploading(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  };

  const removeAttachment = (index) => {
    setNewBrief((p) => ({
      ...p,
      attachments: p.attachments.filter((_, i) => i !== index),
    }));
  };

  const handleCreate = () => {
    if (!newBrief.title.trim()) {
      toast.error("Title is required");
      return;
    }
    const writerId = newBrief.assigned_writer_id && newBrief.assigned_writer_id !== "unassigned" ? newBrief.assigned_writer_id : null;
    const reviewerId = newBrief.review_owner_id && newBrief.review_owner_id !== "unassigned" ? newBrief.review_owner_id : null;
    const payload = {
      title: newBrief.title.trim(),
      summary: newBrief.summary.trim() || null,
      instructions: newBrief.instructions.trim() || null,
      target_audience: newBrief.target_audience.trim() || null,
      tone_guidance: newBrief.tone_guidance.trim() || null,
      word_count_target: newBrief.word_count_target ? parseInt(newBrief.word_count_target) : null,
      deadline: newBrief.deadline || null,
      priority: newBrief.priority,
      category: newBrief.category.trim() || null,
      notes: newBrief.notes.trim() || null,
      assigned_writer_id: writerId,
      review_owner_id: reviewerId,
      assignment_note: newBrief.assignment_note.trim() || null,
      attachments: newBrief.attachments.length > 0 ? newBrief.attachments : [],
      status: writerId ? "assigned" : "new",
      assigned_date: writerId ? new Date().toISOString() : null,
      created_by: memberInfo?.id || null,
    };
    createMutation.mutate(payload);
  };

  const handleRowClick = (briefId) => {
    navigate(createPageUrl("BriefDetail") + "?id=" + briefId);
  };

  function getMemberName(memberId) {
    if (!memberId) return "--";
    const member = membersById[memberId];
    if (!member) return "Unknown";
    return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown";
  }

  if (isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <div className="flex items-center gap-3">
              <FileText className="w-8 h-8 text-muted-foreground" />
              <h1 className="text-3xl md:text-4xl font-bold" data-testid="text-page-title">
                Article Briefs
              </h1>
            </div>
            {canManage && (
              <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-brief">
                <Plus className="w-4 h-4 mr-2" />
                New Brief
              </Button>
            )}
          </div>
          <p className="text-muted-foreground" data-testid="text-brief-count">
            {filteredAndSorted.length} {filteredAndSorted.length === 1 ? "brief" : "briefs"}
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total" value={stats.total} icon={FileText} color="#6b7280" />
          <StatCard title="In Progress" value={stats.inProgress} icon={Pencil} color="#f59e0b" />
          <StatCard title="Under Review" value={stats.underReview} icon={Eye} color="#a855f7" />
          <StatCard title="Approved" value={stats.approved} icon={CheckCircle} color="#22c55e" />
        </div>

        <Tabs value={activeView} onValueChange={setActiveView} className="mb-6">
          <TabsList data-testid="tabs-view-selector">
            <TabsTrigger value="all" data-testid="tab-all-briefs">All Briefs</TabsTrigger>
            <TabsTrigger value="my_briefs" data-testid="tab-my-briefs">My Briefs</TabsTrigger>
            <TabsTrigger value="review_queue" data-testid="tab-review-queue">Review Queue</TabsTrigger>
          </TabsList>
        </Tabs>

        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search briefs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-briefs"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger className="w-[140px]" data-testid="select-priority-filter">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Priorities</SelectItem>
                  {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={writerFilter} onValueChange={setWriterFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-writer-filter">
                  <SelectValue placeholder="Writer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Writers</SelectItem>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {uniqueWriters.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={reviewerFilter} onValueChange={setReviewerFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-reviewer-filter">
                  <SelectValue placeholder="Reviewer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Reviewers</SelectItem>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {uniqueReviewers.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[170px]" data-testid="select-sort-by">
                  <ArrowUpDown className="w-3 h-3 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Title</TableHead>
                  <TableHead className="min-w-[120px]">Status</TableHead>
                  <TableHead className="min-w-[90px]">Priority</TableHead>
                  <TableHead className="min-w-[120px]">Writer</TableHead>
                  <TableHead className="min-w-[120px]">Reviewer</TableHead>
                  <TableHead className="min-w-[100px]">Deadline</TableHead>
                  <TableHead className="min-w-[110px]">Latest Draft</TableHead>
                  {canDelete && <TableHead className="min-w-[60px]">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSorted.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canDelete ? 8 : 7} className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
                      {briefs.length === 0
                        ? "No briefs yet. Create your first article brief to get started."
                        : activeView === "my_briefs"
                        ? "No briefs assigned to you."
                        : activeView === "review_queue"
                        ? "No briefs awaiting your review."
                        : "No briefs match your filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAndSorted.map((brief) => {
                    const statusCfg = STATUS_CONFIG[brief.status] || STATUS_CONFIG.new;
                    const priorityCfg = PRIORITY_CONFIG[brief.priority] || PRIORITY_CONFIG.medium;
                    const latestVersion = latestVersionByBrief[brief.id];
                    return (
                      <TableRow
                        key={brief.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => handleRowClick(brief.id)}
                        data-testid={`brief-row-${brief.id}`}
                      >
                        <TableCell className="font-medium">
                          <div className="max-w-[280px]">
                            <p className="truncate" data-testid={`text-brief-title-${brief.id}`}>{brief.title}</p>
                            {brief.category && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">{brief.category}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            className="text-xs no-default-hover-elevate no-default-active-elevate"
                            style={{ backgroundColor: statusCfg.color, color: "#fff" }}
                          >
                            {statusCfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="text-xs"
                            style={{ borderColor: priorityCfg.color, color: priorityCfg.color }}
                          >
                            {priorityCfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {getMemberName(brief.assigned_writer_id)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {getMemberName(brief.review_owner_id)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {brief.deadline ? format(new Date(brief.deadline), "MMM d, yyyy") : "--"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {latestVersion
                            ? latestVersion.created_at
                              ? format(new Date(latestVersion.created_at), "MMM d")
                              : `v${latestVersion.version_number}`
                            : "--"}
                        </TableCell>
                        {canDelete && (
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                setBriefToDelete(brief);
                              }}
                              data-testid={`button-delete-brief-${brief.id}`}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden" data-testid="dialog-create-brief">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Create Article Brief</DialogTitle>
            <DialogDescription>Define the writing assignment details.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-4 py-2 pr-4">
              <div className="space-y-1">
                <Label htmlFor="brief-title">Title *</Label>
                <Input
                  id="brief-title"
                  value={newBrief.title}
                  onChange={(e) => setNewBrief((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Article title or topic"
                  data-testid="input-brief-title"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="brief-summary">Summary</Label>
                <Textarea
                  id="brief-summary"
                  value={newBrief.summary}
                  onChange={(e) => setNewBrief((p) => ({ ...p, summary: e.target.value }))}
                  placeholder="Brief summary of the article"
                  className="resize-none"
                  data-testid="input-brief-summary"
                />
              </div>
              <div className="space-y-1">
                <Label>Full Instructions</Label>
                <SimpleRichTextEditor
                  content={newBrief.instructions}
                  onChange={(html) => setNewBrief((p) => ({ ...p, instructions: html }))}
                  placeholder="Detailed writing instructions, key points to cover..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="brief-audience">Target Audience</Label>
                  <Input
                    id="brief-audience"
                    value={newBrief.target_audience}
                    onChange={(e) => setNewBrief((p) => ({ ...p, target_audience: e.target.value }))}
                    placeholder="e.g. Industry professionals"
                    data-testid="input-brief-audience"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="brief-tone">Tone Guidance</Label>
                  <Input
                    id="brief-tone"
                    value={newBrief.tone_guidance}
                    onChange={(e) => setNewBrief((p) => ({ ...p, tone_guidance: e.target.value }))}
                    placeholder="e.g. Professional, conversational"
                    data-testid="input-brief-tone"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label>Priority</Label>
                  <Select
                    value={newBrief.priority}
                    onValueChange={(v) => setNewBrief((p) => ({ ...p, priority: v }))}
                  >
                    <SelectTrigger data-testid="select-brief-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                        <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="brief-words">Word Count Target</Label>
                  <Input
                    id="brief-words"
                    type="number"
                    value={newBrief.word_count_target}
                    onChange={(e) => setNewBrief((p) => ({ ...p, word_count_target: e.target.value }))}
                    placeholder="e.g. 1500"
                    data-testid="input-brief-word-count"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="brief-category">Category</Label>
                  <Input
                    id="brief-category"
                    value={newBrief.category}
                    onChange={(e) => setNewBrief((p) => ({ ...p, category: e.target.value }))}
                    placeholder="e.g. Thought leadership"
                    data-testid="input-brief-category"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="brief-deadline">Deadline</Label>
                <Input
                  id="brief-deadline"
                  type="date"
                  value={newBrief.deadline}
                  onChange={(e) => setNewBrief((p) => ({ ...p, deadline: e.target.value }))}
                  data-testid="input-brief-deadline"
                />
              </div>
              {canAssign && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Assign Writer</Label>
                      <MemberCombobox
                        members={members}
                        value={newBrief.assigned_writer_id || "unassigned"}
                        onValueChange={(v) => setNewBrief((p) => ({ ...p, assigned_writer_id: v }))}
                        placeholder="Search writer..."
                        testId="combobox-brief-writer"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Assign Reviewer</Label>
                      <MemberCombobox
                        members={members}
                        value={newBrief.review_owner_id || "unassigned"}
                        onValueChange={(v) => setNewBrief((p) => ({ ...p, review_owner_id: v }))}
                        placeholder="Search reviewer..."
                        testId="combobox-brief-reviewer"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="brief-assign-note">Assignment Note</Label>
                    <Input
                      id="brief-assign-note"
                      value={newBrief.assignment_note}
                      onChange={(e) => setNewBrief((p) => ({ ...p, assignment_note: e.target.value }))}
                      placeholder="Any notes for the writer"
                      data-testid="input-brief-assignment-note"
                    />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <Label htmlFor="brief-notes">Additional Notes</Label>
                <Textarea
                  id="brief-notes"
                  value={newBrief.notes}
                  onChange={(e) => setNewBrief((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Any other relevant information..."
                  className="resize-none"
                  rows={2}
                  data-testid="input-brief-notes"
                />
              </div>
              <div className="space-y-2">
                <Label>Attachments</Label>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleAttachmentUpload}
                  data-testid="input-attachment-file"
                />
                <div className="flex flex-wrap gap-2">
                  {(newBrief.attachments || []).map((att, i) => (
                    <Badge key={i} variant="secondary" className="flex items-center gap-1" data-testid={`badge-attachment-${i}`}>
                      <Paperclip className="w-3 h-3" />
                      <span className="text-xs max-w-[150px] truncate">{att.file_name}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(i)}
                        className="ml-1"
                        data-testid={`button-remove-attachment-${i}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={attachmentUploading}
                  data-testid="button-add-attachment"
                >
                  {attachmentUploading ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Paperclip className="w-4 h-4 mr-1" />
                  )}
                  {attachmentUploading ? "Uploading..." : "Add Attachment"}
                </Button>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter className="flex-shrink-0">
            <Button variant="outline" onClick={() => { setCreateDialogOpen(false); setNewBrief(emptyBrief); }} data-testid="button-cancel-create">
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending || attachmentUploading}
              data-testid="button-submit-create"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Brief
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!briefToDelete} onOpenChange={(open) => !open && setBriefToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-brief">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Brief</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{briefToDelete?.title}"? This will also remove all versions, comments, and activity. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(briefToDelete.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
