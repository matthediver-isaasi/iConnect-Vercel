import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  RefreshCw,
  Send,
  XCircle,
  Filter,
} from "lucide-react";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";

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

function StatCard({ title, value, icon: Icon, color }) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold">{value}</p>
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
  const queryClient = useQueryClient();
  const { isAccessReady, memberInfo } = useMemberAccess();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [briefToDelete, setBriefToDelete] = useState(null);

  const [newBrief, setNewBrief] = useState({
    title: "",
    description: "",
    priority: "medium",
    target_word_count: "",
    deadline: "",
    assigned_to: "",
    guidelines: "",
  });

  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ["article-briefs"],
    queryFn: async () => {
      const data = await base44.entities.ArticleBrief.list();
      return data.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
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

  const membersById = useMemo(() => {
    const map = {};
    members.forEach((m) => {
      map[m.id] = m;
    });
    return map;
  }, [members]);

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ArticleBrief.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setCreateDialogOpen(false);
      setNewBrief({
        title: "",
        description: "",
        priority: "medium",
        target_word_count: "",
        deadline: "",
        assigned_to: "",
        guidelines: "",
      });
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

  const filteredBriefs = useMemo(() => {
    let filtered = briefs;
    if (statusFilter !== "all") {
      filtered = filtered.filter((b) => b.status === statusFilter);
    }
    if (priorityFilter !== "all") {
      filtered = filtered.filter((b) => b.priority === priorityFilter);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (b) =>
          b.title?.toLowerCase().includes(query) ||
          b.description?.toLowerCase().includes(query)
      );
    }
    return filtered;
  }, [briefs, statusFilter, priorityFilter, searchQuery]);

  const handleCreate = () => {
    if (!newBrief.title.trim()) {
      toast.error("Title is required");
      return;
    }
    const assignee = newBrief.assigned_to && newBrief.assigned_to !== "unassigned" ? newBrief.assigned_to : null;
    const payload = {
      title: newBrief.title.trim(),
      description: newBrief.description.trim() || null,
      priority: newBrief.priority,
      target_word_count: newBrief.target_word_count ? parseInt(newBrief.target_word_count) : null,
      deadline: newBrief.deadline || null,
      assigned_to: assignee,
      guidelines: newBrief.guidelines.trim() || null,
      status: assignee ? "assigned" : "new",
      created_by: memberInfo?.id || null,
    };
    createMutation.mutate(payload);
  };

  const handleRowClick = (briefId) => {
    navigate(createPageUrl("BriefDetail") + "?id=" + briefId);
  };

  const getMemberName = (memberId) => {
    if (!memberId) return "--";
    const member = membersById[memberId];
    if (!member) return "Unknown";
    return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown";
  };

  if (isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
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
            <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-brief">
              <Plus className="w-4 h-4 mr-2" />
              New Brief
            </Button>
          </div>
          <p className="text-muted-foreground">
            {filteredBriefs.length} {filteredBriefs.length === 1 ? "brief" : "briefs"}
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total" value={stats.total} icon={FileText} color="#6b7280" />
          <StatCard title="In Progress" value={stats.inProgress} icon={Pencil} color="#f59e0b" />
          <StatCard title="Under Review" value={stats.underReview} icon={Eye} color="#a855f7" />
          <StatCard title="Approved" value={stats.approved} icon={CheckCircle} color="#22c55e" />
        </div>

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
                    <SelectItem key={key} value={key}>
                      {cfg.label}
                    </SelectItem>
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
                    <SelectItem key={key} value={key}>
                      {cfg.label}
                    </SelectItem>
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
                  <TableHead className="min-w-[250px]">Title</TableHead>
                  <TableHead className="min-w-[120px]">Status</TableHead>
                  <TableHead className="min-w-[100px]">Priority</TableHead>
                  <TableHead className="min-w-[140px]">Assigned To</TableHead>
                  <TableHead className="min-w-[110px]">Deadline</TableHead>
                  <TableHead className="min-w-[110px]">Created</TableHead>
                  <TableHead className="min-w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBriefs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                      {briefs.length === 0
                        ? "No briefs yet. Create your first article brief to get started."
                        : "No briefs match your filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredBriefs.map((brief) => {
                    const statusCfg = STATUS_CONFIG[brief.status] || STATUS_CONFIG.new;
                    const priorityCfg = PRIORITY_CONFIG[brief.priority] || PRIORITY_CONFIG.medium;
                    return (
                      <TableRow
                        key={brief.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => handleRowClick(brief.id)}
                        data-testid={`brief-row-${brief.id}`}
                      >
                        <TableCell className="font-medium">
                          <div className="max-w-[300px]">
                            <p className="truncate">{brief.title}</p>
                            {brief.description && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {brief.description}
                              </p>
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
                          {getMemberName(brief.assigned_to)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {brief.deadline
                            ? format(new Date(brief.deadline), "MMM d, yyyy")
                            : "--"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {brief.created_date
                            ? format(new Date(brief.created_date), "MMM d, yyyy")
                            : "--"}
                        </TableCell>
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
        <DialogContent className="max-w-lg" data-testid="dialog-create-brief">
          <DialogHeader>
            <DialogTitle>Create Article Brief</DialogTitle>
            <DialogDescription>
              Define the writing assignment details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
              <Label htmlFor="brief-desc">Description</Label>
              <Textarea
                id="brief-desc"
                value={newBrief.description}
                onChange={(e) => setNewBrief((p) => ({ ...p, description: e.target.value }))}
                placeholder="Brief description of the article"
                className="resize-none"
                data-testid="input-brief-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
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
                      <SelectItem key={key} value={key}>
                        {cfg.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="brief-words">Target Word Count</Label>
                <Input
                  id="brief-words"
                  type="number"
                  value={newBrief.target_word_count}
                  onChange={(e) =>
                    setNewBrief((p) => ({ ...p, target_word_count: e.target.value }))
                  }
                  placeholder="e.g. 1500"
                  data-testid="input-brief-word-count"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div className="space-y-1">
                <Label>Assign To</Label>
                <Select
                  value={newBrief.assigned_to}
                  onValueChange={(v) => setNewBrief((p) => ({ ...p, assigned_to: v }))}
                >
                  <SelectTrigger data-testid="select-brief-assignee">
                    <SelectValue placeholder="Select member" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {[m.first_name, m.last_name].filter(Boolean).join(" ") || m.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="brief-guidelines">Guidelines</Label>
              <Textarea
                id="brief-guidelines"
                value={newBrief.guidelines}
                onChange={(e) => setNewBrief((p) => ({ ...p, guidelines: e.target.value }))}
                placeholder="Style guidelines, tone, key points to cover..."
                className="resize-none"
                rows={3}
                data-testid="input-brief-guidelines"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)} data-testid="button-cancel-create">
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending}
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
              Are you sure you want to delete "{briefToDelete?.title}"? This action cannot be undone.
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
