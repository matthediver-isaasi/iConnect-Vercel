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
import { Checkbox } from "@/components/ui/checkbox";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  ArrowUp,
  ArrowDown,
  Paperclip,
  X,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Archive,
  ArchiveRestore,
  Inbox,
  ShieldCheck,
  FileCheck2,
  Image as ImageIcon,
  Mail,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import MemberCombobox from "@/components/MemberCombobox";
import ExternalWriterCombobox from "@/components/ExternalWriterCombobox";
import MultiSelectFilter from "@/components/MultiSelectFilter";

const ARCHIVED_STATUS = "archived";
const ARCHIVED_STATUS_CONFIG = { label: "Archived", color: "#64748b", icon: Archive };

const DEFAULT_STATUS_CONFIG = {
  new: { label: "New", color: "#6b7280", icon: Clock },
  assigned: { label: "Assigned", color: "#3b82f6", icon: FileText },
  in_progress: { label: "In Progress", color: "#f59e0b", icon: Pencil },
  changes_requested: { label: "Changes Requested", color: "#f97316", icon: AlertCircle },
  rejected: { label: "Rejected", color: "#ef4444", icon: XCircle },
  [ARCHIVED_STATUS]: ARCHIVED_STATUS_CONFIG,
};

function buildStatusConfig(stages) {
  if (!stages || stages.length === 0) return DEFAULT_STATUS_CONFIG;
  const config = {};
  for (const stage of stages) {
    config[stage.key] = { label: stage.label, color: stage.color, icon: Clock };
  }
  config[ARCHIVED_STATUS] = ARCHIVED_STATUS_CONFIG;
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

const COPYRIGHT_STATUS_ORDER = {
  not_required: 0,
  not_sent: 1,
  sent: 2,
  received: 3,
};

const COPYRIGHT_STATUS_LABEL = {
  not_required: "Not required",
  not_sent: "Not sent",
  sent: "Sent",
  received: "Received",
};

function getCopyrightStatus(brief) {
  if (!brief?.copyright_required) return "not_required";
  if (brief.copyright_submission_id) return "received";
  if (brief.copyright_form_sent_at) return "sent";
  return "not_sent";
}

const PERMISSION_STATUS_ORDER = COPYRIGHT_STATUS_ORDER;
const PERMISSION_STATUS_LABEL = COPYRIGHT_STATUS_LABEL;

function getPermissionStatus(brief) {
  if (!brief?.case_study_required) return "not_required";
  if (brief.case_study_submission_id) return "received";
  if (brief.case_study_form_sent_at) return "sent";
  return "not_sent";
}

const FORM_STATUS_FILTER_OPTIONS = [
  { value: "required", label: "Required" },
  { value: "not_required", label: "Not required" },
  { value: "not_sent", label: "Not sent" },
  { value: "sent", label: "Sent" },
  { value: "received", label: "Received" },
];

function SortableHeader({ field, label, sortField, sortDir, onSort }) {
  const active = sortField === field;
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="inline-flex items-center gap-1 -ml-2 px-2 py-1 rounded-md hover-elevate active-elevate-2 font-medium text-left"
      data-testid={`button-sort-${field}`}
      aria-label={`Sort by ${label}`}
    >
      <span>{label}</span>
      <Icon className={`w-3 h-3 ${active ? "" : "text-muted-foreground/60"}`} />
    </button>
  );
}

const INBOX_EVENT_CONFIG = {
  permission_submitted: {
    label: "Permission form submitted",
    icon: ShieldCheck,
  },
  copyright_submitted: {
    label: "Copyright form submitted",
    icon: FileCheck2,
  },
  files_uploaded: {
    label: "Documents/images uploaded",
    icon: ImageIcon,
  },
};

function formatRelative(dateString) {
  if (!dateString) return "";
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return "";
  }
}

function InboxItemList({ items, isLoading, emptyMessage, onItemClick, onArchive, onUnarchive, pendingItemId }) {
  if (isLoading) {
    return (
      <div className="px-4 py-3 space-y-3" data-testid="loading-inbox">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-3 p-3 rounded-md border">
            <Skeleton className="w-9 h-9 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="w-8 h-8 rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-muted-foreground" data-testid="text-inbox-empty">
        {emptyMessage}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full px-3 pb-3">
      <div className="flex flex-col gap-2 pr-3">
        {items.map((item) => {
          const cfg = INBOX_EVENT_CONFIG[item.event_type] || { label: item.event_type, icon: FileText };
          const Icon = cfg.icon;
          const meta = item.metadata || {};
          const fileCount = meta.file_count || 0;
          const submitter = meta.submitter_name || meta.submitter_email || null;
          const isUnread = !item.read_at;
          const isPending = pendingItemId === item.id;

          return (
            <div
              key={item.id}
              className={`flex items-start gap-3 p-3 rounded-md border hover-elevate ${
                isUnread ? "bg-primary/5 border-primary/30" : "bg-background"
              }`}
              data-testid={`inbox-item-${item.id}`}
              data-unread={isUnread ? "true" : "false"}
            >
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="flex-1 min-w-0 text-left flex items-start gap-3 -m-3 p-3 rounded-md"
                data-testid={`button-inbox-item-${item.id}`}
              >
                <div className="mt-0.5">
                  <Icon className={`w-4 h-4 ${isUnread ? "text-primary" : "text-muted-foreground"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className={`text-sm truncate ${isUnread ? "font-semibold" : "font-medium"}`}
                      data-testid={`text-inbox-item-title-${item.id}`}
                    >
                      {item.brief_title || "Untitled brief"}
                    </span>
                    {isUnread && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"
                        aria-label="Unread"
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {cfg.label}
                    {fileCount > 0 && (
                      <span> · {fileCount} {fileCount === 1 ? "file" : "files"}</span>
                    )}
                  </div>
                  {submitter && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
                      <Mail className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{submitter}</span>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground/70 mt-1">
                    {formatRelative(item.created_at)}
                  </div>
                </div>
              </button>
              <div className="flex-shrink-0">
                {onArchive && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onArchive(item); }}
                    disabled={isPending}
                    aria-label="Archive"
                    data-testid={`button-archive-${item.id}`}
                  >
                    {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                  </Button>
                )}
                {onUnarchive && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onUnarchive(item); }}
                    disabled={isPending}
                    aria-label="Restore from archive"
                    data-testid={`button-unarchive-${item.id}`}
                  >
                    {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArchiveRestore className="w-4 h-4" />}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

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
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("page_BriefManagement")) {
        navigate(createPageUrl("Dashboard"));
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded, navigate]);

  const canManage = !isFeatureExcluded("content.briefs.manage");
  const canAssign = !isFeatureExcluded("content.briefs.assign");
  const canDelete = !isFeatureExcluded("content.briefs.delete");
  const canChangeStatus = !isFeatureExcluded("content.briefs.change-status");

  const initialView = searchParams.get("view") || "all";

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState([]);
  const [dateField, setDateField] = useState("deadline");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [writerFilter, setWriterFilter] = useState([]);
  const [reviewerFilter, setReviewerFilter] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState([]);
  const [caseStudyFilter, setCaseStudyFilter] = useState("all");
  const [copyrightFilter, setCopyrightFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [activeView, setActiveView] = useState(initialView);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [briefToDelete, setBriefToDelete] = useState(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const attachmentInputRef = useRef(null);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState("");
  const [bulkProgress, setBulkProgress] = useState(null);

  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxFolder, setInboxFolder] = useState("inbox");
  // Track the timestamp of the newest unread item at the moment the banner was
  // dismissed. The banner re-shows when an item arrives that's newer than that
  // timestamp, so genuinely new submissions resurface the banner even if the
  // overall unread count has dropped (e.g. the user marked some as read or
  // archived) and risen again. ISO string for stable session storage.
  const [bannerDismissedNewestAt, setBannerDismissedNewestAt] = useState(() => {
    if (typeof window === "undefined") return null;
    return window.sessionStorage?.getItem("brief-inbox-banner-dismissed-newest-at") || null;
  });

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

  const firstStageKey = useMemo(() => {
    return briefSettings?.stages?.[0]?.key || "new";
  }, [briefSettings?.stages]);

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

  const archiveMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      return await base44.entities.ArticleBrief.update(id, { status });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      toast.success(vars.status === ARCHIVED_STATUS ? "Brief archived" : "Brief restored");
    },
    onError: () => {
      toast.error("Failed to update brief");
    },
  });

  const inboxQuery = useQuery({
    queryKey: ["article-brief-inbox", "inbox"],
    queryFn: async () => {
      const res = await fetch("/api/article-briefs/inbox?folder=inbox", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load inbox");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const archiveQuery = useQuery({
    queryKey: ["article-brief-inbox", "archive"],
    queryFn: async () => {
      const res = await fetch("/api/article-briefs/inbox?folder=archive", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load archive");
      return res.json();
    },
    enabled: inboxOpen && inboxFolder === "archive",
    staleTime: 30_000,
  });

  const inboxItems = inboxQuery.data?.items || [];
  const archiveItems = archiveQuery.data?.items || [];
  const unreadCount = inboxQuery.data?.unread_count || 0;

  // Newest unread item timestamp from the current poll. Items are returned
  // sorted by created_at DESC, so the first unread row is the newest.
  const newestUnreadAt = useMemo(() => {
    for (const item of inboxItems) {
      if (!item.read_at) return item.created_at || null;
    }
    return null;
  }, [inboxItems]);

  // Re-show the unread banner whenever the newest unread item is more recent
  // than the timestamp captured at dismissal. Robust to the unread count
  // dropping (after mark-read/archive) and later rising again with brand-new
  // items.
  useEffect(() => {
    if (
      bannerDismissedNewestAt != null &&
      newestUnreadAt != null &&
      newestUnreadAt > bannerDismissedNewestAt
    ) {
      setBannerDismissedNewestAt(null);
      try {
        window.sessionStorage?.removeItem("brief-inbox-banner-dismissed-newest-at");
      } catch (_) { /* ignore storage failures */ }
    }
  }, [newestUnreadAt, bannerDismissedNewestAt]);

  const inboxActionMutation = useMutation({
    mutationFn: async ({ itemId, action }) => {
      const res = await fetch(`/api/article-briefs/inbox/${itemId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update inbox item");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["article-brief-inbox"] });
      if (vars?.action === "archive") {
        toast.success("Inbox item archived");
      } else if (vars?.action === "unarchive") {
        toast.success("Inbox item restored");
      }
      // mark_read / mark_unread fire silently as part of normal navigation
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update inbox item");
    },
  });

  const handleInboxItemClick = (item) => {
    if (!item.read_at) {
      inboxActionMutation.mutate({ itemId: item.id, action: "mark_read" });
    }
    setInboxOpen(false);
    navigate(createPageUrl("BriefDetail") + "?id=" + item.article_brief_id);
  };

  const handleDismissBanner = () => {
    const stamp = newestUnreadAt || new Date().toISOString();
    setBannerDismissedNewestAt(stamp);
    try {
      window.sessionStorage?.setItem("brief-inbox-banner-dismissed-newest-at", stamp);
    } catch {
      // sessionStorage unavailable; ignore
    }
  };

  const stats = useMemo(() => {
    const active = briefs.filter((b) => b.status !== ARCHIVED_STATUS);
    const total = active.length;
    const byStatus = {};
    active.forEach((b) => {
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

    if (activeView === "archived") {
      filtered = filtered.filter((b) => b.status === ARCHIVED_STATUS);
    } else {
      filtered = filtered.filter((b) => b.status !== ARCHIVED_STATUS);
      if (activeView === "my_briefs" && memberInfo?.id) {
        filtered = filtered.filter((b) => b.review_owner_id === memberInfo.id);
      } else if (activeView === "review_queue" && memberInfo?.id) {
        filtered = filtered.filter(
          (b) => b.review_owner_id === memberInfo.id && b.status === "changes_requested"
        );
      }
    }

    if (statusFilter.length > 0 && activeView !== "archived") {
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
    if (caseStudyFilter === "required") {
      filtered = filtered.filter((b) => !!b.case_study_required);
    } else if (caseStudyFilter === "not_required") {
      filtered = filtered.filter((b) => !b.case_study_required);
    } else if (caseStudyFilter === "not_sent" || caseStudyFilter === "sent" || caseStudyFilter === "received") {
      filtered = filtered.filter((b) => getPermissionStatus(b) === caseStudyFilter);
    }
    if (copyrightFilter === "required") {
      filtered = filtered.filter((b) => !!b.copyright_required);
    } else if (copyrightFilter === "not_required") {
      filtered = filtered.filter((b) => !b.copyright_required);
    } else if (copyrightFilter === "not_sent" || copyrightFilter === "sent" || copyrightFilter === "received") {
      filtered = filtered.filter((b) => getCopyrightStatus(b) === copyrightFilter);
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
    if (sortField) {
      const getKey = (b) => {
        switch (sortField) {
          case "title":
            return (b.title || "").trim().toLowerCase() || null;
          case "status": {
            const cfg = STATUS_CONFIG[b.status];
            return (cfg?.label || b.status || "").toLowerCase() || null;
          }
          case "writer": {
            const v = getWriterDisplay(b);
            return v && v !== "--" ? v.toLowerCase() : null;
          }
          case "editor": {
            const v = getMemberName(b.review_owner_id);
            return v && v !== "--" ? v.toLowerCase() : null;
          }
          case "deadline":
            return b.deadline ? new Date(b.deadline).getTime() : null;
          case "latest_draft": {
            const v = latestVersionByBrief[b.id];
            if (!v) return null;
            if (v.created_at) return new Date(v.created_at).getTime();
            return v.version_number ?? null;
          }
          case "copyright":
            return COPYRIGHT_STATUS_ORDER[getCopyrightStatus(b)];
          case "permission":
            return PERMISSION_STATUS_ORDER[getPermissionStatus(b)];
          default:
            return null;
        }
      };
      const dir = sortDir === "desc" ? -1 : 1;
      sorted.sort((a, b) => {
        const av = getKey(a);
        const bv = getKey(b);
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    } else {
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
    }
    return sorted;
  }, [briefs, activeView, memberInfo, statusFilter, writerFilter, reviewerFilter, categoryFilter, caseStudyFilter, copyrightFilter, dateField, dateFrom, dateTo, searchQuery, sortBy, sortField, sortDir, STATUS_CONFIG, latestVersionByBrief, membersById, externalWritersById]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSorted.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedBriefs = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredAndSorted.slice(start, start + pageSize);
  }, [filteredAndSorted, safePage, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeView, statusFilter, writerFilter, reviewerFilter, categoryFilter, caseStudyFilter, copyrightFilter, dateField, dateFrom, dateTo, searchQuery, pageSize, sortField, sortDir, sortBy]);

  const handleHeaderSort = (field) => {
    if (sortField !== field) {
      setSortField(field);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortField(null);
      setSortDir("asc");
    }
  };

  const briefsById = useMemo(() => {
    const map = {};
    briefs.forEach((b) => { map[b.id] = b; });
    return map;
  }, [briefs]);

  const pageIds = paginatedBriefs.map((b) => b.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const someOnPageSelected = pageIds.some((id) => selectedIds.has(id));

  const togglePageSelection = (checked) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        pageIds.forEach((id) => next.add(id));
      } else {
        pageIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  };

  const toggleRowSelection = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const runBulkStatusUpdate = async () => {
    if (!bulkStatusValue) {
      toast.error("Please select a status");
      return;
    }
    const ids = Array.from(selectedIds);
    const targets = ids
      .map((id) => briefsById[id])
      .filter((b) => b && b.status !== bulkStatusValue);
    const skipped = ids.length - targets.length;

    if (targets.length === 0) {
      toast.info(`No briefs to update — all ${ids.length} already have that status.`);
      setBulkDialogOpen(false);
      setBulkStatusValue("");
      clearSelection();
      return;
    }

    setBulkProgress({ total: targets.length, done: 0, success: 0, failed: 0 });

    const concurrency = 4;
    let index = 0;
    let success = 0;
    let failed = 0;

    const worker = async () => {
      while (index < targets.length) {
        const i = index++;
        const brief = targets[i];
        try {
          await base44.entities.ArticleBrief.update(brief.id, { status: bulkStatusValue });
          success++;
        } catch (err) {
          failed++;
          console.error("Bulk status update failed for brief", brief.id, err);
        }
        setBulkProgress({ total: targets.length, done: success + failed, success, failed });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

    queryClient.invalidateQueries({ queryKey: ["article-briefs"] });

    const skippedMsg = skipped > 0 ? ` ${skipped} skipped (already set).` : "";
    if (failed === 0) {
      toast.success(`Updated ${success} ${success === 1 ? "brief" : "briefs"}.${skippedMsg}`);
    } else if (success === 0) {
      toast.error(`Failed to update ${failed} ${failed === 1 ? "brief" : "briefs"}.${skippedMsg}`);
    } else {
      toast.warning(`Updated ${success}, failed ${failed}.${skippedMsg}`);
    }

    setBulkProgress(null);
    setBulkDialogOpen(false);
    setBulkStatusValue("");
    clearSelection();
  };

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

  if (!accessChecked || isLoading) {
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
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => { setInboxFolder("inbox"); setInboxOpen(true); }}
                data-testid="button-open-inbox"
                aria-label={unreadCount > 0 ? `Inbox (${unreadCount} unread)` : "Inbox"}
              >
                <Inbox className="w-4 h-4 mr-2" />
                Inbox
                {unreadCount > 0 && (
                  <Badge
                    variant="default"
                    className="ml-2 h-5 min-w-5 px-1.5"
                    data-testid="badge-inbox-unread"
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Badge>
                )}
              </Button>
              {canManage && (
                <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-brief">
                  <Plus className="w-4 h-4 mr-2" />
                  New Brief
                </Button>
              )}
            </div>
          </div>
          <p className="text-muted-foreground" data-testid="text-brief-count">
            {filteredAndSorted.length} {filteredAndSorted.length === 1 ? "brief" : "briefs"}
          </p>
        </div>

        {unreadCount > 0 && (bannerDismissedNewestAt == null || (newestUnreadAt != null && newestUnreadAt > bannerDismissedNewestAt)) && (
          <Card
            className="mb-4 border-primary/40 bg-primary/5"
            data-testid="banner-inbox-summary"
          >
            <CardContent className="py-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  <Inbox className="w-4 h-4 text-primary" />
                  <span data-testid="text-banner-summary">
                    You have <span className="font-semibold">{unreadCount}</span>{" "}
                    new {unreadCount === 1 ? "submission" : "submissions"} on your briefs.
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setInboxFolder("inbox"); setInboxOpen(true); }}
                    data-testid="button-banner-review"
                  >
                    Review
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleDismissBanner}
                    aria-label="Dismiss banner"
                    data-testid="button-banner-dismiss"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-4 mb-6">
          <StatCard title="Total" value={stats.total} icon={FileText} color="#6b7280" />
          <StatCard title="In Progress" value={stats.inProgress} icon={Pencil} color="#f59e0b" />
        </div>

        <Tabs value={activeView} onValueChange={setActiveView} className="mb-6">
          <TabsList data-testid="tabs-view-selector">
            <TabsTrigger value="all" data-testid="tab-all-briefs">All Briefs</TabsTrigger>
            <TabsTrigger value="my_briefs" data-testid="tab-my-briefs">My Briefs</TabsTrigger>
            <TabsTrigger value="review_queue" data-testid="tab-review-queue">Review Queue</TabsTrigger>
            <TabsTrigger value="archived" data-testid="tab-archived">Archived</TabsTrigger>
          </TabsList>
        </Tabs>

        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-3">
              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search briefs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-briefs"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <MultiSelectFilter
                  options={Object.entries(STATUS_CONFIG)
                    .filter(([key]) => key !== ARCHIVED_STATUS)
                    .map(([key, cfg]) => ({ value: key, label: cfg.label }))}
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
                <Select value={caseStudyFilter} onValueChange={setCaseStudyFilter}>
                  <SelectTrigger className="w-[170px]" data-testid="select-case-study-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Case Studies</SelectItem>
                    {FORM_STATUS_FILTER_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={copyrightFilter} onValueChange={setCopyrightFilter}>
                  <SelectTrigger className="w-[170px]" data-testid="select-copyright-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Copyright</SelectItem>
                    {FORM_STATUS_FILTER_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
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
              <div className="flex flex-nowrap items-center gap-3 w-full sm:w-auto">
                <Select value={dateField} onValueChange={setDateField}>
                  <SelectTrigger className="w-[180px] shrink-0" data-testid="select-date-field">
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
                  className="w-full min-w-0 flex-1 sm:w-[150px] sm:flex-none"
                  placeholder="From"
                  data-testid="input-date-from"
                />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full min-w-0 flex-1 sm:w-[150px] sm:flex-none"
                  placeholder="To"
                  data-testid="input-date-to"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  {canChangeStatus && (
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={allOnPageSelected ? true : (someOnPageSelected ? "indeterminate" : false)}
                        onCheckedChange={(v) => togglePageSelection(!!v)}
                        aria-label="Select all on page"
                        data-testid="checkbox-select-page"
                      />
                    </TableHead>
                  )}
                  <TableHead className="min-w-[220px]">
                    <SortableHeader field="title" label="Title" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[120px]">
                    <SortableHeader field="status" label="Status" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[120px]">
                    <SortableHeader field="writer" label="Writer" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[120px]">
                    <SortableHeader field="editor" label="Editor" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[110px]">
                    <SortableHeader field="deadline" label="Deadline" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[110px]">
                    <SortableHeader field="latest_draft" label="Latest Draft" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[120px]">
                    <SortableHeader field="copyright" label="Copyright" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  <TableHead className="min-w-[120px]">
                    <SortableHeader field="permission" label="Permission" sortField={sortField} sortDir={sortDir} onSort={handleHeaderSort} />
                  </TableHead>
                  {(canDelete || canChangeStatus) && <TableHead className="min-w-[100px]">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedBriefs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8 + (canChangeStatus ? 1 : 0) + ((canDelete || canChangeStatus) ? 1 : 0)} className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
                      {briefs.length === 0
                        ? "No briefs yet. Create your first article brief to get started."
                        : activeView === "my_briefs"
                        ? "No briefs assigned to you."
                        : activeView === "review_queue"
                        ? "No briefs awaiting your review."
                        : activeView === "archived"
                        ? "No archived briefs."
                        : "No briefs match your filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedBriefs.map((brief) => {
                    const statusCfg = STATUS_CONFIG[brief.status] || STATUS_CONFIG.new;
                    const latestVersion = latestVersionByBrief[brief.id];
                    const isSelected = selectedIds.has(brief.id);
                    return (
                      <TableRow
                        key={brief.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => handleRowClick(brief.id)}
                        data-state={isSelected ? "selected" : undefined}
                        data-testid={`brief-row-${brief.id}`}
                      >
                        {canChangeStatus && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleRowSelection(brief.id)}
                              aria-label={`Select brief ${brief.title}`}
                              data-testid={`checkbox-brief-${brief.id}`}
                            />
                          </TableCell>
                        )}
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
                        <TableCell className="text-sm text-muted-foreground" data-testid={`text-brief-copyright-${brief.id}`}>
                          {COPYRIGHT_STATUS_LABEL[getCopyrightStatus(brief)]}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground" data-testid={`text-brief-permission-${brief.id}`}>
                          {PERMISSION_STATUS_LABEL[getPermissionStatus(brief)]}
                        </TableCell>
                        {(canDelete || canChangeStatus) && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              {canChangeStatus && (
                                brief.status === ARCHIVED_STATUS ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      archiveMutation.mutate({ id: brief.id, status: firstStageKey });
                                    }}
                                    disabled={archiveMutation.isPending}
                                    aria-label={`Restore brief ${brief.title}`}
                                    title="Restore"
                                    data-testid={`button-unarchive-brief-${brief.id}`}
                                  >
                                    <ArchiveRestore className="w-4 h-4" />
                                  </Button>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      archiveMutation.mutate({ id: brief.id, status: ARCHIVED_STATUS });
                                    }}
                                    disabled={archiveMutation.isPending}
                                    aria-label={`Archive brief ${brief.title}`}
                                    title="Archive"
                                    data-testid={`button-archive-brief-${brief.id}`}
                                  >
                                    <Archive className="w-4 h-4" />
                                  </Button>
                                )
                              )}
                              {canDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setBriefToDelete(brief);
                                  }}
                                  aria-label={`Delete brief ${brief.title}`}
                                  title="Delete"
                                  data-testid={`button-delete-brief-${brief.id}`}
                                >
                                  <Trash2 className="w-4 h-4 text-destructive" />
                                </Button>
                              )}
                            </div>
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

        <div className="flex flex-wrap items-center justify-between gap-3 mt-4" data-testid="pagination-controls">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span data-testid="text-pagination-summary">
              {filteredAndSorted.length === 0
                ? "0 results"
                : `Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filteredAndSorted.length)} of ${filteredAndSorted.length}`}
            </span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="w-[110px] h-9" data-testid="select-page-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              data-testid="button-page-prev"
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Previous
            </Button>
            <span className="text-sm text-muted-foreground" data-testid="text-page-info">
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              data-testid="button-page-next"
            >
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {canChangeStatus && selectedIds.size > 0 && (
        <div
          className="sticky bottom-0 left-0 right-0 z-50 mt-4"
          data-testid="bulk-action-bar"
        >
          <div className="max-w-7xl mx-auto px-4 pb-4">
            <Card className="shadow-lg">
              <CardContent className="py-3 px-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CheckSquare className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium" data-testid="text-selected-count">
                    {selectedIds.size} {selectedIds.size === 1 ? "brief" : "briefs"} selected
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearSelection}
                    data-testid="button-clear-selection"
                  >
                    Clear selection
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => { setBulkStatusValue(""); setBulkDialogOpen(true); }}
                    data-testid="button-bulk-change-status"
                  >
                    Change status
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Dialog
        open={bulkDialogOpen}
        onOpenChange={(open) => {
          if (bulkProgress) return;
          setBulkDialogOpen(open);
          if (!open) setBulkStatusValue("");
        }}
      >
        <DialogContent data-testid="dialog-bulk-status">
          <DialogHeader>
            <DialogTitle>Change status for {selectedIds.size} {selectedIds.size === 1 ? "brief" : "briefs"}</DialogTitle>
            <DialogDescription>
              Pick a new status. Briefs already at that status will be skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div className="space-y-1">
              <Label>New status</Label>
              <Select value={bulkStatusValue} onValueChange={setBulkStatusValue} disabled={!!bulkProgress}>
                <SelectTrigger data-testid="select-bulk-status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key} data-testid={`option-bulk-status-${key}`}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {bulkProgress && (
              <div className="text-sm text-muted-foreground" data-testid="text-bulk-progress">
                Updating {bulkProgress.done} of {bulkProgress.total}…
                {bulkProgress.failed > 0 && ` (${bulkProgress.failed} failed)`}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setBulkDialogOpen(false); setBulkStatusValue(""); }}
              disabled={!!bulkProgress}
              data-testid="button-cancel-bulk-status"
            >
              Cancel
            </Button>
            <Button
              onClick={runBulkStatusUpdate}
              disabled={!bulkStatusValue || !!bulkProgress}
              data-testid="button-confirm-bulk-status"
            >
              {bulkProgress && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {bulkProgress ? "Updating…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Sheet open={inboxOpen} onOpenChange={setInboxOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col"
          data-testid="sheet-inbox"
        >
          <SheetHeader className="px-6 pt-6 pb-3 border-b">
            <SheetTitle className="flex items-center gap-2">
              <Inbox className="w-5 h-5 text-muted-foreground" />
              Brief Inbox
            </SheetTitle>
            <SheetDescription>
              Case study submissions and uploads on your briefs.
            </SheetDescription>
          </SheetHeader>

          <Tabs
            value={inboxFolder}
            onValueChange={setInboxFolder}
            className="flex-1 flex flex-col min-h-0"
          >
            <div className="px-6 pt-3">
              <TabsList data-testid="tabs-inbox-folder">
                <TabsTrigger value="inbox" data-testid="tab-inbox">
                  Inbox
                  {unreadCount > 0 && (
                    <Badge variant="default" className="ml-2 h-5 min-w-5 px-1.5">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="archive" data-testid="tab-archive">Archive</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="inbox" className="flex-1 min-h-0 mt-3">
              <InboxItemList
                items={inboxItems}
                isLoading={inboxQuery.isLoading}
                emptyMessage="No new submissions. You'll see new case study permissions, copyrights, and uploads here."
                onItemClick={handleInboxItemClick}
                onArchive={(item) => inboxActionMutation.mutate({ itemId: item.id, action: "archive" })}
                onUnarchive={null}
                pendingItemId={inboxActionMutation.isPending ? inboxActionMutation.variables?.itemId : null}
              />
            </TabsContent>

            <TabsContent value="archive" className="flex-1 min-h-0 mt-3">
              <InboxItemList
                items={archiveItems}
                isLoading={archiveQuery.isLoading}
                emptyMessage="Nothing archived yet."
                onItemClick={handleInboxItemClick}
                onArchive={null}
                onUnarchive={(item) => inboxActionMutation.mutate({ itemId: item.id, action: "unarchive" })}
                pendingItemId={inboxActionMutation.isPending ? inboxActionMutation.variables?.itemId : null}
              />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

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
