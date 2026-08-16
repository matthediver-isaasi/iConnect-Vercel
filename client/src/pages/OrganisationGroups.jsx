import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Building2, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import OrganisationGroupDetailView from "@/components/OrganisationGroupDetailView";

const EMPTY_ARR = [];

export default function OrganisationGroups() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState({ name: "", description: "" });

  // Dedicated RBAC gate for Organisation Groups.
  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("crm.organisation-groups")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: groups = EMPTY_ARR, isLoading: groupsLoading } = useQuery({
    queryKey: ["/api/entities/OrganizationGroup"],
    enabled: accessChecked,
    queryFn: () => base44.entities.OrganizationGroup.list({ sort: { name: "asc" } }),
  });

  // Organisations, used for per-group counts and the detail listing.
  const { data: orgs = EMPTY_ARR } = useQuery({
    queryKey: ["organisation-groups-orgs"],
    enabled: accessChecked,
    queryFn: () => base44.entities.Organization.list({ sort: { name: "asc" } }),
  });

  const orgsByGroup = orgs.reduce((acc, o) => {
    if (o.organization_group_id) {
      (acc[o.organization_group_id] ||= []).push(o);
    }
    return acc;
  }, {});

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/entities/OrganizationGroup"] });
    queryClient.invalidateQueries({ queryKey: ["organisation-groups-orgs"] });
    queryClient.invalidateQueries({ queryKey: ["organizations-crm-paginated"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
      };
      if (editingGroup) {
        return base44.entities.OrganizationGroup.update(editingGroup.id, payload);
      }
      return base44.entities.OrganizationGroup.create(payload);
    },
    onSuccess: () => {
      toast.success(editingGroup ? "Group updated" : "Group created");
      setDialogOpen(false);
      setEditingGroup(null);
      invalidate();
    },
    onError: (e) => toast.error("Failed to save group: " + e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (group) => base44.entities.OrganizationGroup.delete(group.id),
    onSuccess: () => {
      toast.success("Group deleted — its organisations were detached, not deleted");
      setDeleteTarget(null);
      if (selectedGroup && deleteTarget && selectedGroup.id === deleteTarget.id) {
        setSelectedGroup(null);
      }
      invalidate();
    },
    onError: (e) => toast.error("Failed to delete group: " + e.message),
  });

  const openCreate = () => {
    setEditingGroup(null);
    setForm({ name: "", description: "" });
    setDialogOpen(true);
  };
  const openEdit = (group) => {
    setEditingGroup(group);
    setForm({ name: group.name || "", description: group.description || "" });
    setDialogOpen(true);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // ---- Detail view: full CRM-style group record (Task #3601) ----
  if (selectedGroup) {
    const group = groups.find((g) => g.id === selectedGroup.id) || selectedGroup;
    return (
      <>
        <OrganisationGroupDetailView
          group={group}
          orgs={orgs}
          onBack={() => setSelectedGroup(null)}
          onDelete={(g) => setDeleteTarget(g)}
        />
        {renderDialogs()}
      </>
    );
  }

  // ---- List view ----
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-blue-600" /> Organisation Groups
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Group organisations under a shared parent (e.g. an NHS Trust and its hospitals).
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-create-group">
          <Plus className="w-4 h-4 mr-1" /> New Group
        </Button>
      </div>

      {groupsLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-500">
            No organisation groups yet. Create one to start grouping organisations.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <Card key={g.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="flex items-center justify-between py-4">
                <button
                  className="text-left flex-1"
                  onClick={() => setSelectedGroup(g)}
                  data-testid={`button-view-group-${g.id}`}
                >
                  <div className="font-medium text-slate-800">{g.name}</div>
                  {g.description && <div className="text-sm text-slate-500 truncate">{g.description}</div>}
                </button>
                <div className="flex items-center gap-3">
                  <Badge variant="secondary" data-testid={`badge-group-count-${g.id}`}>
                    {(orgsByGroup[g.id] || []).length} organisation{(orgsByGroup[g.id] || []).length === 1 ? "" : "s"}
                  </Badge>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(g)} data-testid={`button-edit-group-${g.id}`}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-red-600" onClick={() => setDeleteTarget(g)} data-testid={`button-delete-group-${g.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {renderDialogs()}
    </div>
  );

  function renderDialogs() {
    return (
      <>
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { setDialogOpen(false); setEditingGroup(null); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingGroup ? "Edit Organisation Group" : "New Organisation Group"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Example NHS Trust"
                  data-testid="input-group-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  rows={3}
                  data-testid="textarea-group-description"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!form.name.trim()) { toast.error("Group name is required"); return; }
                  saveMutation.mutate();
                }}
                disabled={saveMutation.isPending}
                data-testid="button-save-group"
              >
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
              <DialogDescription>
                The {(orgsByGroup[deleteTarget?.id] || []).length} organisation(s) in this group will be
                detached from it — the organisations themselves are <strong>not</strong> deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(deleteTarget)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete-group"
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete group"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
}
