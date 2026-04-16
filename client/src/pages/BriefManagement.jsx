import { useState, useMemo, useRef, useEffect } from "react";
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
  AlertCircle,
  Loader2,
  Pencil,
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
import MemberCombobox from "@/components/MemberCombobox";
import ExternalWriterCombobox from "@/components/ExternalWriterCombobox";
import MultiSelectFilter from "@/components/MultiSelectFilter";

const DEFAULT_STATUS_CONFIG = {
  new: { label: "New", color: "#6b7280", icon: Clock },
  assigned: { label: "Assigned", color: "#3b82f6", icon: FileText },
  in_progress: { label: "In Progress", color: "#f59e0b", icon: Pencil },
  changes_requested: { label: "Changes Requested", color: "#f97316", icon: AlertCircle },
  rejected: { label: "Rejected", color: "#ef4444", icon: XCircle },
};

function buildStatusConfig(stages) {
  if (!stages || stages.length === 0) return DEFAULT_STATUS_CONFIG;
  const config = {};
  for (const stage of stages) {
    config[stage.key] = { label: stage.label, color: stage.color, icon: Clock };
  }
  return new Proxy(config, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string') return { label: prop.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), color: '#6b7280', icon: Clock };
      return undefined;
    }
  });
}

const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "deadline_asc", label: "Deadline (Earliest)" },
  { value: "deadline_desc", label: "Deadline (Latest)" },
];

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
  const [statusFilter, setStatusFilter] = useState([]);
  const [dateField, setDateField] = useState("deadline");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [writerFilter, setWriterFilter] = useState([]);
  const [reviewerFilter, setReviewerFilter] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState([]);
  const [sortBy, setSortBy] = useState("newest");
  const [activeView, setActiveView] = useState(initialView);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [briefToDelete, setBriefToDelete] = useState(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const attachmentInputRef = useRef(null);

  const emptyBrief = {
    title: "", deadline: "",
    writer_deadline: "", editor_deadline: "", sla: "2026-2028", contract: "Prospects",
    category: "", notes: "", assigned_writer_id: "", review_owner_id: "",
    external_writer_id: "",
    attachments: [],
  };
  const [newBrief, setNewBrief] = useState(emptyBrief);
  const [writerType, setWriterType] = useState("member");

  const { data: briefSettings } = useQuery({
    queryKey: ["brief-settings"],
    queryFn: async () => {
      const res = await fetch("/api/article-briefs/settings", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isAccessReady,
    staleTime: 60000,
  });

  const STATUS_CONFIG = useMemo(() => buildStatusConfig(briefSettings?.stages), [briefSettings?.stages]);

  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ["article-briefs"],
    queryFn: async () => {
      return await base44.entities.ArticleBrief.list();
    },
    enabled: isAccessReady,
  });

  const referencedMemberIds = useMemo(() => {
    const ids = new Set();
    briefs.forEach((b) => {
      if (b.assigned_writer_id) ids.add(b.assigned_writer_id);
      if (b.review_owner_id) ids.add(b.review_owner_id);
      if (b.created_by) ids.add(b.created_by);
    });
    return Array.from(ids);
  }, [briefs]);

  const referencedExternalWriterIds = useMemo(() => {
    const ids = new Set();
    briefs.forEach((b) => {
      if (b.external_writer_id) ids.add(b.external_writer_id);
    });
    return Array.from(ids);
  }, [briefs]);

  const { data: referencedExternalWriters = [] } = useQuery({
    queryKey: ["external-writers-by-ids", referencedExternalWriterIds],
    queryFn: async () => {
      if (referencedExternalWriterIds.length === 0) return [];
      const all = await base44.entities.ExternalWriter.list();
      return all.filter((w) => referencedExternalWriterIds.includes(w.id));
    },
    enabled: isAccessReady && referencedExternalWriterIds.length > 0,
  });

  const externalWritersById = useMemo(() => {
    const map = {};
    referencedExternalWriters.forEach((w) => { map[w.id] = w; });
    return map;
  }, [referencedExternalWriters]);

  const { data: referencedMembers = [] } = useQuery({
    queryKey: ["members-by-ids", referencedMemberIds],
    queryFn: async () => {
      if (referencedMemberIds.length === 0) return [];
      const resp = await fetch(`/api/members/by-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids: referencedMemberIds }),
      });
      if (!resp.ok) return [];
      return await resp.json();
    },
    enabled: isAccessReady && referencedMemberIds.length > 0,
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
    referencedMembers.forEach((m) => { map[m.id] = m; });
    return map;
  }, [referencedMembers]);

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ArticleBrief.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setCreateDialogOpen(false);
      setNewBrief(emptyBrief);
      setWriterType("member");
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
    };
  }, [briefs]);

  const uniqueWriters = useMemo(() => {
    const memberIds = new Set();
    const externalIds = new Set();
    briefs.forEach((b) => {
      if (b.assigned_writer_id) memberIds.add(b.assigned_writer_id);
      if (b.external_writer_id) externalIds.add(b.external_writer_id);
    });
    const memberWriters = Array.from(memberIds).map((id) => ({ id, name: getMemberName(id) }));
    const extWriters = Array.from(externalIds).map((id) => {
      const ew = externalWritersById[id];
      const name = ew ? [ew.first_name, ew.last_name].filter(Boolean).join(" ") || ew.email : "External (Unknown)";
      return { id, name: `${name} (Ext)` };
    });
    return [...memberWriters, ...extWriters].sort((a, b) => a.name.localeCompare(b.name));
  }, [briefs, membersById, externalWritersById]);

  const uniqueReviewers = useMemo(() => {
    const ids = new Set();
    briefs.forEach((b) => { if (b.review_owner_id) ids.add(b.review_owner_id); });
    return Array.from(ids).map((id) => ({ id, name: getMemberName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [briefs, membersById]);

  const uniqueCategories = useMemo(() => {
    if (briefSettings?.categories && briefSettings.categories.length > 0) {
      return briefSettings.categories.map((cat) => cat);
    }
    const cats = new Set();
    briefs.forEach((b) => { if (b.category) cats.add(b.category); });
    return Array.from(cats).sort();
  }, [briefs, briefSettings?.categories]);

  const filteredAndSorted = useMemo(() => {
    let filtered = briefs;

    if (activeView === "my_briefs" && memberInfo?.id) {
      filtered = filtered.filter((b) => b.review_owner_id === memberInfo.id);
    } else if (activeView === "review_queue" && memberInfo?.id) {
      filtered = filtered.filter(
        (b) => b.review_owner_id === memberInfo.id && b.status === "changes_requested"
      );
    }

    if (statusFilter.length > 0) {
      filtered = filtered.filter((b) => statusFilter.includes(b.status));
    }
    if (writerFilter.length > 0) {
      filtered = filtered.filter((b) => {
        if (writerFilter.includes("__unassigned__") && !b.assigned_writer_id && !b.external_writer_id) return true;
        return writerFilter.includes(b.assigned_writer_id) || writerFilter.includes(b.external_writer_id);
      });
    }
    if (reviewerFilter.length > 0) {
      filtered = filtered.filter((b) => {
        if (reviewerFilter.includes("__unassigned__") && !b.review_owner_id) return true;
        return reviewerFilter.includes(b.review_owner_id);
      });
    }
    if (categoryFilter.length > 0) {
      filtered = filtered.filter((b) => categoryFilter.includes(b.category));
    }
    if (dateFrom || dateTo) {
      filtered = filtered.filter((b) => {
        const val = b[dateField];
        if (!val) return false;
        const d = val.split("T")[0];
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      });
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (b) =>
          b.title?.toLowerCase().includes(query) ||
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
      default:
        break;
    }
    return sorted;
  }, [briefs, activeView, memberInfo, statusFilter, writerFilter, reviewerFilter, categoryFilter, dateField, dateFrom, dateTo, searchQuery, sortBy]);

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
    const isExternal = writerType === "external";
    const writerId = !isExternal && newBrief.assigned_writer_id && newBrief.assigned_writer_id !== "unassigned" ? newBrief.assigned_writer_id : null;
    const externalWriterId = isExternal && newBrief.external_writer_id && newBrief.external_writer_id !== "unassigned" ? newBrief.external_writer_id : null;
    const reviewerId = newBrief.review_owner_id && newBrief.review_owner_id !== "unassigned" ? newBrief.review_owner_id : null;
    const hasWriter = writerId || externalWriterId;
    const payload = {
      title: newBrief.title.trim(),
      deadline: newBrief.deadline || null,
      writer_deadline: newBrief.writer_deadline || null,
      editor_deadline: newBrief.editor_deadline || null,
      sla: newBrief.sla || null,
      contract: newBrief.contract || null,
      category: newBrief.category.trim() || null,
      notes: newBrief.notes.trim() || null,
      assigned_writer_id: writerId,
      external_writer_id: externalWriterId,
      review_owner_id: reviewerId,
      assignment_note: null,
      attachments: newBrief.attachments.length > 0 ? newBrief.attachments : [],
      status: hasWriter ? "assigned" : "new",
      assigned_date: hasWriter ? new Date().toISOString() : null,
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

  function getWriterDisplay(brief) {
    if (brief.external_writer_id) {
      const ew = externalWritersById[brief.external_writer_id];
      if (!ew) return "External (Unknown)";
      return [ew.first_name, ew.last_name].filter(Boolean).join(" ") || ew.email || "External";
    }
    return getMemberName(brief.assigned_writer_id);
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

        <div className="grid grid-cols-2 gap-4 mb-6">
          <StatCard title="Total" value={stats.total} icon={FileText} color="#6b7280" />
          <StatCard title="In Progress" value={stats.inProgress} icon={Pencil} color="#f59e0b" />
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
              <MultiSelectFilter
                options={Object.entries(STATUS_CONFIG).map(([key, cfg]) => ({ value: key, label: cfg.label }))}
                selected={statusFilter}
                onChange={setStatusFilter}
                placeholder="All Statuses"
                className="w-[160px]"
                data-testid="select-status-filter"
              />
              <MultiSelectFilter
                options={[
                  { value: "__unassigned__", label: "Unassigned" },
                  ...uniqueWriters.map((w) => ({ value: w.id, label: w.name })),
                ]}
                selected={writerFilter}
                onChange={setWriterFilter}
                placeholder="All Writers"
                className="w-[160px]"
                data-testid="select-writer-filter"
              />
              <MultiSelectFilter
                options={[
                  { value: "__unassigned__", label: "Unassigned" },
                  ...uniqueReviewers.map((r) => ({ value: r.id, label: r.name })),
                ]}
                selected={reviewerFilter}
                onChange={setReviewerFilter}
                placeholder="All Editors"
                className="w-[160px]"
                data-testid="select-reviewer-filter"
              />
              <MultiSelectFilter
                options={uniqueCategories.map((cat) => ({ value: cat, label: cat }))}
                selected={categoryFilter}
                onChange={setCategoryFilter}
                placeholder="All Categories"
                className="w-[160px]"
                data-testid="select-category-filter"
              />
              <Select value={dateField} onValueChange={setDateField}>
                <SelectTrigger className="w-[180px]" data-testid="select-date-field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deadline">Submission Deadline</SelectItem>
                  <SelectItem value="writer_deadline">Writer Deadline</SelectItem>
                  <SelectItem value="editor_deadline">Editor Deadline</SelectItem>
                  <SelectItem value="created_at">Created Date</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-[150px]"
                placeholder="From"
                data-testid="input-date-from"
              />
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-[150px]"
                placeholder="To"
                data-testid="input-date-to"
              />
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
                  <TableHead className="min-w-[120px]">Writer</TableHead>
                  <TableHead className="min-w-[120px]">Editor</TableHead>
                  <TableHead className="min-w-[130px]">Submission Deadline</TableHead>
                  <TableHead className="min-w-[110px]">Latest Draft</TableHead>
                  {canDelete && <TableHead className="min-w-[60px]">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSorted.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canDelete ? 7 : 6} className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
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
                        <TableCell className="text-sm text-muted-foreground">
                          {getWriterDisplay(brief)}
                          {brief.external_writer_id && (
                            <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 no-default-hover-elevate no-default-active-elevate">Ext</Badge>
                          )}
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="brief-category">Category</Label>
                  {briefSettings?.categories && briefSettings.categories.length > 0 ? (
                    <Select value={newBrief.category || ""} onValueChange={(val) => setNewBrief((p) => ({ ...p, category: val }))}>
                      <SelectTrigger data-testid="select-brief-category">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {briefSettings.categories.map((cat) => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="brief-category"
                      value={newBrief.category}
                      onChange={(e) => setNewBrief((p) => ({ ...p, category: e.target.value }))}
                      placeholder="e.g. Thought leadership"
                      data-testid="input-brief-category"
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <Label>SLA</Label>
                  <Select
                    value={newBrief.sla}
                    onValueChange={(v) => setNewBrief((p) => ({ ...p, sla: v }))}
                  >
                    <SelectTrigger data-testid="select-brief-sla">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2026-2028">2026-2028</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Contract</Label>
                  <Select
                    value={newBrief.contract}
                    onValueChange={(v) => setNewBrief((p) => ({ ...p, contract: v }))}
                  >
                    <SelectTrigger data-testid="select-brief-contract">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Prospects">Prospects</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="brief-deadline">Submission Deadline</Label>
                  <Input
                    id="brief-deadline"
                    type="date"
                    value={newBrief.deadline}
                    onChange={(e) => setNewBrief((p) => ({ ...p, deadline: e.target.value }))}
                    data-testid="input-brief-deadline"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="brief-writer-deadline">Writer Deadline</Label>
                  <Input
                    id="brief-writer-deadline"
                    type="date"
                    value={newBrief.writer_deadline}
                    onChange={(e) => setNewBrief((p) => ({ ...p, writer_deadline: e.target.value }))}
                    data-testid="input-brief-writer-deadline"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="brief-editor-deadline">Editor Deadline</Label>
                  <Input
                    id="brief-editor-deadline"
                    type="date"
                    value={newBrief.editor_deadline}
                    onChange={(e) => setNewBrief((p) => ({ ...p, editor_deadline: e.target.value }))}
                    data-testid="input-brief-editor-deadline"
                  />
                </div>
              </div>
              {canAssign && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Writer</Label>
                      <div className="flex gap-1 mb-1">
                        <Button
                          type="button"
                          variant={writerType === "member" ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            setWriterType("member");
                            setNewBrief((p) => ({ ...p, assigned_writer_id: "", external_writer_id: "" }));
                          }}
                          data-testid="button-writer-type-member"
                        >
                          Member
                        </Button>
                        <Button
                          type="button"
                          variant={writerType === "external" ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            setWriterType("external");
                            setNewBrief((p) => ({ ...p, assigned_writer_id: "", external_writer_id: "" }));
                          }}
                          data-testid="button-writer-type-external"
                        >
                          External
                        </Button>
                      </div>
                      {writerType === "member" ? (
                        <MemberCombobox
                          value={newBrief.assigned_writer_id || "unassigned"}
                          onValueChange={(v) => setNewBrief((p) => ({ ...p, assigned_writer_id: v }))}
                          placeholder="Search writer..."
                          testId="combobox-brief-writer"
                        />
                      ) : (
                        <ExternalWriterCombobox
                          value={newBrief.external_writer_id || "unassigned"}
                          onValueChange={(v) => setNewBrief((p) => ({ ...p, external_writer_id: v }))}
                          placeholder="Search external writer..."
                          testId="combobox-brief-external-writer"
                        />
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label>Editor</Label>
                      <MemberCombobox
                        value={newBrief.review_owner_id || "unassigned"}
                        onValueChange={(v) => setNewBrief((p) => ({ ...p, review_owner_id: v }))}
                        placeholder="Search editor..."
                        testId="combobox-brief-reviewer"
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="space-y-1">
                <Label htmlFor="brief-notes">Notes</Label>
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
            <Button variant="outline" onClick={() => { setCreateDialogOpen(false); setNewBrief(emptyBrief); setWriterType("member"); }} data-testid="button-cancel-create">
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
