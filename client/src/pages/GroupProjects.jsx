import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Kanban, Plus, Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function GroupProjectsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [accessChecked, setAccessChecked] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createGroupId, setCreateGroupId] = useState(null);
  const [newBoardName, setNewBoardName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-projects")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const {
    data: qualifying = [],
    isLoading: loadingGroups,
    isError: groupsError,
    refetch,
  } = useQuery({
    queryKey: ["member-group-projects", "qualifying-groups"],
    queryFn: async () => {
      const res = await fetch("/api/member-group-projects/qualifying-groups", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 403) return [];
        throw new Error("Failed to load groups");
      }
      const data = await res.json();
      return data.groups || [];
    },
    enabled: accessChecked,
  });

  // Redirect non-qualifying members away from the page.
  useEffect(() => {
    if (accessChecked && !loadingGroups && !groupsError && qualifying.length === 0) {
      toast.error("You don't have permission to access group projects.");
      const t = setTimeout(() => {
        window.location.href = createPageUrl("MemberGroups");
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [accessChecked, loadingGroups, groupsError, qualifying.length]);

  const openCreate = (groupId) => {
    setCreateGroupId(groupId);
    setNewBoardName("");
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!newBoardName.trim()) {
      toast.error("Board name is required");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/member-group-projects/boards", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberGroupId: createGroupId, name: newBoardName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create board");
      toast.success("Board created");
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["member-group-projects", "qualifying-groups"] });
      if (data.board?.id) {
        navigate(`/ProjectBoard/${data.board.id}`);
      } else {
        refetch();
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCreating(false);
    }
  };

  const activeCreateGroup = useMemo(
    () => qualifying.find((g) => g.id === createGroupId) || null,
    [qualifying, createGroupId]
  );

  if (!accessChecked || loadingGroups) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (qualifying.length === 0) {
    return (
      <div className="p-8 flex items-center justify-center" data-testid="redirect-no-access">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" data-testid="page-group-projects">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Kanban className="w-5 h-5" /> Group Projects
          </h1>
          <p className="text-sm text-muted-foreground">
            Open or create project boards for the groups you belong to.
          </p>
        </div>
      </div>

      {qualifying.map((group) => (
        <Card key={group.id} data-testid={`card-group-${group.id}`}>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{group.name}</CardTitle>
              <Badge variant="outline" data-testid={`badge-role-${group.id}`}>{group.callerRole}</Badge>
            </div>
            <Button
              size="sm"
              onClick={() => openCreate(group.id)}
              data-testid={`button-new-board-${group.id}`}
            >
              <Plus className="w-4 h-4 mr-2" /> New board
            </Button>
          </CardHeader>
          <CardContent>
            {(group.boards || []).length === 0 ? (
              <div
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid={`empty-boards-${group.id}`}
              >
                No boards yet. Click "New board" to create one.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {group.boards.map((board) => (
                  <button
                    key={board.id}
                    onClick={() => navigate(`/ProjectBoard/${board.id}`)}
                    className="text-left rounded-md border border-border p-3 hover-elevate active-elevate-2 flex items-center justify-between gap-2"
                    data-testid={`button-open-board-${board.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-3 h-3 rounded-md flex-shrink-0"
                        style={{ backgroundColor: board.color || "#6366f1" }}
                      />
                      <span className="font-medium truncate">{board.name}</span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New board</DialogTitle>
            <DialogDescription>
              Create a new project board for <strong>{activeCreateGroup?.name}</strong>. All qualifying
              members of this group will be added automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-board-name">Board name *</Label>
              <Input
                id="new-board-name"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                placeholder="e.g. Q3 Planning"
                data-testid="input-new-board-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating} data-testid="button-create-board">
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
              Create board
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
